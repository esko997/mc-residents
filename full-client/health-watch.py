#!/usr/bin/env python3
"""Bound one resident session; only GET /state probes, never world commands.

run-session.sh supplies SESSION_END_AT, SESSION_LOG, SESSION_CLIENT_UNIT,
SESSION_HEALTH_FILE and SESSION_HEALTH_LOG. SYNAPSE_URL and SYNAPSE_TOKEN_FILE
are environment/file inputs, never command-line secrets. Defaults: probe every
15s, hard 5s probe budget, 300s startup grace, then 3 failures spanning 60s.
The atomic health JSON is the dashboard contract; transition JSONL is append-only.
A terminal pause requires an explicit operator resume with its thread_id.
"""
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


THREAD = re.compile(r"^session id: ([A-Za-z0-9_-]+)$")
TERMINAL = {"paused", "failed", "stopped"}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def classify(envelope):
    if not isinstance(envelope, dict) or envelope.get("ok") is not True:
        # Synapse returns an error envelope when no player/world exists.
        return "non_world"
    data = envelope.get("data")
    if not isinstance(data, dict):
        return "invalid_state"
    pos = data.get("pos")
    if not isinstance(pos, dict) or not all(finite(pos.get(k)) for k in ("x", "y", "z")):
        return "non_world"
    if not isinstance(data.get("dimension"), str) or not data["dimension"] or not finite(data.get("health")):
        return "invalid_state"
    # DeathScreen still has a player/world. It is not a disconnected client:
    # the existing mind/reflexes must remain able to respawn.
    return "in_game_dead" if data["health"] <= 0 else "healthy"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the token to a redirect destination.


def probe():
    """A disposable child gives the complete HTTP read a hard wall-time bound."""
    try:
        active = subprocess.run(["systemctl", "--user", "is-active", os.environ["SESSION_CLIENT_UNIT"]],
                                capture_output=True, timeout=2, check=False)
        if active.stdout.strip() != b"active":
            return "client_stopped"
    except (OSError, subprocess.TimeoutExpired):
        return "client_status_unavailable"
    try:
        token = Path(os.environ.get("SYNAPSE_TOKEN_FILE", "~/.synapse/token")).expanduser().read_text().strip()
        if not token:
            return "token_unavailable"
    except OSError:
        return "token_unavailable"
    url = os.environ["SYNAPSE_URL"].rstrip("/")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return "invalid_url"
    request = urllib.request.Request(url + "/state?mode=summary", headers={"X-Synapse-Token": token})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=3) as reply:
            raw = reply.read(262145)
            if len(raw) > 262144:
                return "invalid_state"
            return classify(json.loads(raw))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return "unauthorized"
        if error.code == 504:
            return "probe_timeout"
        return "non_world" if error.code == 409 else "http_error"
    except (ValueError, UnicodeError):
        return "invalid_state"
    except TimeoutError:
        return "probe_timeout"
    except urllib.error.URLError as error:
        return "probe_timeout" if isinstance(error.reason, TimeoutError) else "unavailable"
    except OSError:
        return "unavailable"


class Health:
    def __init__(self, started, startup_grace=300, failure_seconds=60, failure_count=3):
        self.started = started
        self.startup_grace = startup_grace
        self.failure_seconds = failure_seconds
        self.failure_count = failure_count
        self.ever_healthy = False
        self.bad_since = None
        self.failures = 0

    def observe(self, reason, now):
        if reason in ("healthy", "in_game_dead"):
            self.ever_healthy = True
            self.bad_since = None
            self.failures = 0
            return "healthy"
        if self.bad_since is None:
            self.bad_since = now
        self.failures += 1
        if not self.ever_healthy:
            return "paused" if now - self.started >= self.startup_grace else "starting"
        if self.failures >= self.failure_count and now - self.bad_since >= self.failure_seconds:
            return "paused"
        return "degraded"


class StateFile:
    def __init__(self, path, journal, fields):
        self.path = Path(path)
        self.journal = Path(journal)
        self.fields = fields
        self.last_transition = None

    def put(self, status, reason, **extra):
        self.fields.update(extra, status=status, reason=reason, updated_at=int(time.time()),
                           paused=status == "paused", terminal=status in TERMINAL, auto_restart=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".health-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(self.fields, handle, separators=(",", ":"))
                handle.write("\n")
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        transition = (status, reason)
        if transition != self.last_transition:
            self.journal.parent.mkdir(parents=True, exist_ok=True)
            with self.journal.open("a") as handle:
                handle.write(json.dumps(self.fields, separators=(",", ":")) + "\n")
            # Reasons are fixed strings, never HTTP payloads or token-bearing URLs.
            with open(os.environ["SESSION_LOG"], "a") as handle:
                handle.write(f"health: {status}: {reason}\n")
            self.last_transition = transition


class ThreadReader:
    def __init__(self, log, initial=None):
        self.log = log
        self.offset = 0
        self.pending = b""
        self.thread = initial or None

    def read(self):
        try:
            with open(self.log, "rb") as handle:
                handle.seek(self.offset)
                while chunk := handle.read(65536):
                    lines = (self.pending + chunk).split(b"\n")
                    self.pending = lines.pop()[-1024:]
                    for line in lines:
                        match = THREAD.fullmatch(line.decode("utf-8", "replace").strip())
                        if match:
                            self.thread = match.group(1)
                self.offset = handle.tell()
        except FileNotFoundError:
            pass
        return self.thread


def group_signal(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def systemctl(*args, timeout=2):
    try:
        return subprocess.run(["systemctl", "--user", *args], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False).returncode
    except (OSError, subprocess.TimeoutExpired):
        return -1

def supervise(command):
    end_at = int(os.environ["SESSION_END_AT"])
    started = time.monotonic()
    health = Health(started)
    reader = ThreadReader(os.environ["SESSION_LOG"], os.environ.get("RESUME_THREAD"))
    state = StateFile(os.environ["SESSION_HEALTH_FILE"], os.environ["SESSION_HEALTH_LOG"], {
        "version": 1, "resident": os.environ["SESSION_RESIDENT"], "end_at": end_at,
        "started_at": int(time.time()), "thread_id": reader.thread,
        "session_log": os.environ["SESSION_LOG"], "supervisor_pid": os.getpid(),
        "last_healthy_at": None, "consecutive_failures": 0,
    })
    interrupted = []
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda signum, frame: interrupted.append(signum))
    child = None
    pending = None
    status, reason, code = "failed", "supervisor_failure", 1
    state.put("starting", "startup_grace")
    with tempfile.TemporaryDirectory(prefix="resident-health-") as runtime:
        ready = Path(runtime) / "ready"
        child_env = dict(os.environ, SESSION_HEALTH_CHILD="1", SESSION_READY_FILE=str(ready),
                         SESSION_BODY_STARTED_FILE=str(Path(runtime) / "body-started"))
        try:
            if time.time() >= end_at:
                status, reason, code = "stopped", "deadline", 0
            else:
                child = subprocess.Popen(command, env=child_env, start_new_session=True)
                next_probe = started
                probe_started = started
                while True:
                    now = time.monotonic()
                    if time.time() >= end_at:
                        status, reason, code = "stopped", "deadline", 0
                        break
                    if interrupted:
                        status, reason, code = "stopped", "admin_stop", 128 + interrupted[0]
                        break
                    if not health.ever_healthy and now - started >= health.startup_grace:
                        status, reason, code = "paused", "startup_unavailable", 20
                        break
                    rc = child.poll()
                    if rc is not None:
                        status, reason, code = "failed", {
                            3: "no_body_calls", 4: "thread_missing", 5: "rapid_returns",
                            10: "startup_failure",
                        }.get(rc, "mind_failure"), rc if rc > 0 else 1
                        # The shell waits out the final short window without launching
                        # another mind, and exits only at the absolute deadline.
                        break
                    result = None
                    if pending is not None:
                        if pending.poll() is not None:
                            output = pending.communicate()[0].decode("ascii", "replace").strip()
                            result = output if pending.returncode == 0 and output in {
                                "healthy", "in_game_dead", "client_stopped", "client_status_unavailable",
                                "token_unavailable", "invalid_url", "non_world", "invalid_state",
                                "unauthorized", "http_error", "unavailable", "probe_timeout",
                            } else "probe_failure"
                        elif now - probe_started >= 5:
                            group_signal(pending.pid, signal.SIGKILL)
                            pending.communicate(timeout=1)
                            result = "probe_timeout"
                        if result is not None:
                            pending = None
                            observed = health.observe(result, now)
                            last_healthy = int(time.time()) if observed == "healthy" else state.fields["last_healthy_at"]
                            state.put(observed, result, thread_id=reader.read(), last_healthy_at=last_healthy,
                                      consecutive_failures=health.failures)
                            if observed == "healthy":
                                ready.touch(exist_ok=True)
                            elif observed == "paused":
                                status, reason, code = "paused", result, 20
                                break
                    if pending is None and now >= next_probe and Path(child_env["SESSION_BODY_STARTED_FILE"]).exists():
                        pending = subprocess.Popen([sys.executable, __file__, "--probe"],
                                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                                   stdin=subprocess.DEVNULL, start_new_session=True)
                        probe_started = now
                        next_probe = now + 15
                    time.sleep(max(0, min(0.25, end_at - time.time())))
        except Exception:
            # Do not emit exception text: HTTP errors can include sensitive URLs.
            status, reason, code = "failed", "supervisor_failure", 1
        finally:
            # Publish the reason before shutdown; an operator need not infer it
            # from a dead process. No restart/replay or world mutation is attempted.
            try:
                state.put(status, reason, thread_id=reader.read(), exit_code=code, cleanup_complete=False)
            except OSError:
                print("health state could not be saved; stopping play", file=sys.stderr)
            if pending is not None:
                group_signal(pending.pid, signal.SIGKILL)
                pending.communicate(timeout=1)
            if child is not None:
                group_signal(child.pid, signal.SIGTERM)
                # Stop the body immediately, independently of note-saving cleanup.
                systemctl("stop", "--no-block", os.environ["SESSION_CLIENT_UNIT"])
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    pass
                group_signal(child.pid, signal.SIGKILL)
                child.wait(timeout=1)
                if systemctl("stop", os.environ["SESSION_CLIENT_UNIT"], timeout=8) != 0:
                    systemctl("kill", "--signal=SIGKILL", os.environ["SESSION_CLIENT_UNIT"])
            stopped = systemctl("is-active", "--quiet", os.environ["SESSION_CLIENT_UNIT"]) == 3
            state.put(status, reason, thread_id=reader.read(), exit_code=code,
                      cleanup_complete=True, client_stopped=stopped)
    return code


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        print(probe())
    else:
        sys.exit(supervise(sys.argv[1:]))
