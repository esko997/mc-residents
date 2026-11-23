#!/usr/bin/env python3
"""Start, stop and report resident runs on THIS host.

Entry points (run on the resident host, never over a pipe from another machine):
  start-run.sh  -> runctl.py start ...
  stop-run.sh   -> runctl.py stop ...
  run-status.sh -> runctl.py status ...

A run is what the old hand-written launcher made, unchanged: per resident a
transient unit `<name>-run` (run-session.sh under health-watch.py), plus one
caretaker unit per host (`overseer-run`, overseer-loop.sh with only this host's
residents), all sharing one absolute deadline in America/New_York. Nothing here
is enabled at boot; every start is an explicit call.

Fixed per-host placement comes from `$GARY_CLIENT_HOME/run.conf` (see
run.conf.example) and `instances/<Name>.env` (GAME_DIR, PERSONA). Per-run inputs
are the arguments. Every start/stop that passes validation writes one JSON
record under ~/.local/state/residents/activations/ (inputs, unit names,
invocation ids, thread ids; never a token).

Exit codes (also the `code` field of --json output):
   0 ok             everything asked for is running (or stopped) as asked
   2 usage          bad or missing arguments
   3 deadline       end time in the past or more than 24 h away (or ambiguous)
   4 conflict       a run/body is active with another end time, model or thread
                    mode, a body runs without its run, or a persona changed
   5 config         unknown resident for this host, missing persona or run.conf
   6 systemd        systemd-run/systemctl failed; JSON lists what did start
   7 still_active   stop could not confirm every unit and client gone
  75 busy           another start/stop holds this host's control lock
  77 gate           start gate refused (reserved; see start_gate in start-run.sh)
Full contract: full-client/commons/docs/run-controller.md.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("America/New_York")
SLICE = "residents.slice"
RUN_CPU = "200%"
CARETAKER_CPU = "100%"
BACKSTOP = 600  # RuntimeMaxSec = deadline + 10 min; health-watch.py enforces the exact end.
MAX_AHEAD = 24 * 3600
NAME = re.compile(r"^\w{1,16}$", re.ASCII)
PERSONA = re.compile(r"^[a-z0-9_-]{1,40}$")
MODEL = re.compile(r"^(claude:)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
THREAD = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
LABEL = re.compile(r"^[\w .:@()/-]{1,120}$", re.ASCII)
NOTE_MAX = 300
RUNNING = {"active", "activating", "deactivating", "reloading", "refreshing"}
CODES = {0: "ok", 2: "usage", 3: "deadline", 4: "conflict", 5: "config", 6: "systemd",
         7: "still_active", 75: "busy", 77: "gate"}
HERE = Path(__file__).resolve().parent


class Refusal(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


class Usage(argparse.ArgumentParser):
    def error(self, message):
        raise Refusal(2, message)


def parse_env(path):
    """KEY=value lines as systemd's EnvironmentFile and bash read them; never sourced."""
    values = {}
    try:
        text = Path(path).read_text()
    except OSError:
        return values
    for raw in text.splitlines():
        line = re.sub(r"^export\s+", "", raw.strip())
        found = re.match(r"^([A-Za-z_]\w*)=(.*)$", line)
        if found:
            values[found[1]] = re.sub(r"^([\"'])(.*)\1$", r"\2", found[2].strip())
    return values


def local_time(epoch):
    return dt.datetime.fromtimestamp(epoch, ZONE)


def end_words(epoch):
    return local_time(epoch).strftime("%Y-%m-%d %H:%M %Z")


class Host:
    """Fixed per-host placement: run.conf, instance files, state directory."""

    def __init__(self, env=os.environ):
        self.env = env
        self.home = Path(env.get("HOME") or Path.home())
        self.base = Path(env.get("GARY_CLIENT_HOME") or self.home / "gary-client")
        self.conf_path = Path(env.get("RESIDENTS_RUN_CONF") or self.base / "run.conf")
        state_home = Path(env.get("XDG_STATE_HOME") or self.home / ".local" / "state")
        self.state = Path(env.get("RESIDENTS_STATE_DIR") or state_home / "residents")
        self.proc = Path(env.get("RESIDENTS_PROC_DIR") or "/proc")
        if not self.conf_path.is_file():
            raise Refusal(5, f"no run configuration at {self.conf_path}: copy tools/run.conf.example there and list this host's residents")
        conf = parse_env(self.conf_path)
        self.conf = conf
        self.name = conf.get("HOST") or socket.gethostname().split(".")[0]
        self.residents = conf.get("RESIDENTS", "").split()
        if not self.residents or not all(NAME.match(name) for name in self.residents):
            raise Refusal(5, f"{self.conf_path}: RESIDENTS must list this host's residents (Minecraft names)")
        self.default_model = conf.get("DEFAULT_MODEL", "gpt-6.2-sol")
        self.client_template = conf.get("CLIENT_UNIT", "gary-client@%s")
        self.caretaker_unit = unit(conf.get("CARETAKER_UNIT", "overseer-run"))
        self.caretaker_default = switch(conf.get("CARETAKER", "on"), "CARETAKER")
        self.interval_default = interval(conf.get("CARETAKER_INTERVAL", "25"))
        self.speak_default = speak(conf.get("CARETAKER_SPEAK", "keep"))
        for model in [self.default_model] + [conf[f"MODEL_{name}"] for name in self.residents if f"MODEL_{name}" in conf]:
            if not MODEL.match(model):
                raise Refusal(5, f"{self.conf_path}: invalid model {model!r}")
        if not re.match(r"^[\w.@-]{1,60}$", self.name, re.ASCII) or "%s" not in self.client_template:
            raise Refusal(5, f"{self.conf_path}: invalid HOST or CLIENT_UNIT")

    def resident(self, name):
        found = [entry for entry in self.residents if entry.lower() == name.lower()]
        if not found:
            raise Refusal(5, f"{name} is not a resident of host {self.name} (run.conf lists {', '.join(self.residents)})")
        name = found[0]
        instance = parse_env(self.base / "instances" / f"{name}.env")
        persona = instance.get("PERSONA") or name.lower()
        if not PERSONA.match(persona):
            raise Refusal(5, f"instances/{name}.env: PERSONA must be a lowercase directory name")
        return {
            "name": name, "persona": persona,
            "model": self.conf.get(f"MODEL_{name}", self.default_model),
            "game_dir": instance.get("GAME_DIR") or str(self.base / "game"),
            "unit": unit(f"{name.lower()}-run"), "client_unit": unit(self.client_template.replace("%s", name)),
        }


def unit(name):
    return name if "." in name else f"{name}.service"


def switch(value, what):
    if value not in ("on", "off"):
        raise Refusal(2, f"{what} must be on or off")
    return value == "on"


def interval(value):
    if not re.fullmatch(r"[1-9][0-9]{0,2}", str(value)) or int(value) > 240:
        raise Refusal(2, "caretaker interval must be 1 to 240 minutes")
    return int(value)


def speak(value):
    if value not in ("keep", "on", "off"):
        raise Refusal(2, "caretaker speak must be keep, on or off")
    return value


# ---------- systemd ----------

def run(argv, timeout=30):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise Refusal(6, f"{argv[0]} is not available on this host")
    except subprocess.TimeoutExpired:
        raise Refusal(6, f"{' '.join(argv[:4])} timed out after {timeout} s")


def show(units):
    """Current state of each unit, read with one `systemctl --user show`."""
    if not units:
        return {}
    props = "Id,LoadState,ActiveState,SubState,InvocationID,Environment,ExecStart"
    result = run(["systemctl", "--user", "show", f"--property={props}", *units])
    if result.returncode != 0:
        raise Refusal(6, f"systemctl --user show failed: {result.stderr.strip()[:300]}")
    blocks = [block for block in result.stdout.split("\n\n") if block.strip()]
    if len(blocks) != len(units):
        raise Refusal(6, "systemctl --user show returned an unexpected answer")
    states = {}
    for name, block in zip(units, blocks):
        fields = {}
        for line in block.splitlines():
            key, _, value = line.partition("=")
            fields[key] = value
        env = {}
        try:
            for item in shlex.split(fields.get("Environment", "")):
                key, _, value = item.partition("=")
                env[key] = value
        except ValueError:
            pass
        argv = re.search(r"argv\[\]=(.*?) ;", fields.get("ExecStart", ""))
        states[name] = {
            "state": fields.get("ActiveState") or "unknown", "sub": fields.get("SubState", ""),
            "invocation": fields.get("InvocationID", ""), "env": env,
            "argv": argv[1].split() if argv else [],
        }
    return states


def running(state):
    return state["state"] in RUNNING


def end_of(state):
    value = state["env"].get("SESSION_END_AT", "")
    return int(value) if value.isdigit() else None


# The launcher (portablemc) names the game directory `--mc-dir`; the Java game process it starts
# names it `--gameDir`. Matching both catches a Java body left running after its wrapper exited.
GAME_DIR_FLAGS = (b"--mc-dir", b"--gameDir")


def clients(host, game_dir):
    """Pids of Minecraft clients (launcher or Java) on exactly this game directory, unit or not."""
    wanted = {os.path.normpath(game_dir), os.path.realpath(game_dir)}
    found = []
    try:
        entries = list(host.proc.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        for index, arg in enumerate(argv):
            flag, sep, inline = arg.partition(b"=")
            if flag not in GAME_DIR_FLAGS:
                continue
            value = inline if sep else (argv[index + 1] if index + 1 < len(argv) else b"")
            if value and os.path.normpath(value.decode(errors="replace")) in wanted:
                found.append(int(entry.name))
                break
    return sorted(found)


def systemd_run(name, cpu, end_at, now, env_pairs, command):
    argv = ["systemd-run", "--user", "--collect", f"--unit={name}", f"--slice={SLICE}",
            "-p", f"CPUQuota={cpu}", "-p", f"RuntimeMaxSec={end_at - now + BACKSTOP}",
            "--setenv=TZ=America/New_York", f"--setenv=SESSION_END_AT={end_at}"]
    argv += [f"--setenv={key}={value}" for key, value in env_pairs]
    run(["systemctl", "--user", "reset-failed", name])  # a failed unit of the same name blocks a new one
    result = run(argv + command)
    if result.returncode != 0:
        return None, (result.stderr.strip() or result.stdout.strip())[:300] or f"systemd-run exited {result.returncode}"
    invocation = show([name])[name]["invocation"]
    return invocation, None


def stop_units(units, timeout=150):
    if units:
        result = run(["systemctl", "--user", "stop", *units], timeout=timeout)
        if result.returncode != 0:
            return (result.stderr.strip() or f"systemctl stop exited {result.returncode}")[:300]
    return None


# ---------- records ----------

class Records:
    def __init__(self, host):
        self.dir = host.state / "activations"

    def all(self):
        try:
            paths = sorted(self.dir.glob("*.json"))
        except OSError:
            return []
        out = []
        for path in paths[-500:]:
            try:
                record = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("schema") == "residents-activation/1":
                out.append(record)
        return out

    def write(self, record):
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.dir, 0o700)
        path = self.dir / f"{record['id']}.json"
        temporary = self.dir / f".{record['id']}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as target:
            json.dump(record, target, indent=1, sort_keys=True)
            target.write("\n")
        os.replace(temporary, path)
        for old in sorted(self.dir.glob("*.json"))[:-500]:  # bounded history
            old.unlink(missing_ok=True)
        return path


def new_record(host, kind, by, dry_run=False):
    now = time.time()
    stamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    return {"schema": "residents-activation/1", "id": f"{stamp}Z-{kind}-{secrets.token_hex(3)}", "kind": kind,
            "host": host.name, "created_at": int(now), "requested_by": by, "dry_run": dry_run}


def thread_of(host, name):
    try:
        value = json.loads((host.base / "sessions" / f"{name}-health.json").read_text()).get("thread_id")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and THREAD.match(value) else None


def last_entry(records, name, kinds=("start",)):
    for record in reversed(records):
        if record.get("kind") not in kinds:
            continue
        for entry in record.get("residents", []):
            if entry.get("name") == name and entry.get("result") == "started":
                return record, entry
    return None, None


# ---------- lock ----------

def lock(host):
    host.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = open(host.state / "control.lock", "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise Refusal(75, f"another start or stop is in progress on {host.name}; try again shortly")
    return handle


def start_gate(components):
    """G1 start gate: runs `start-run.sh __start-gate <component>...` (the hook lives there)."""
    try:
        result = subprocess.run([str(HERE / "start-run.sh"), "__start-gate", *components],
                                capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal(77, f"start gate could not be checked: {error}")
    if result.returncode != 0:
        detail = (result.stderr.strip() or result.stdout.strip())[:300]
        raise Refusal(77, f"start gate refused (exit {result.returncode}){': ' + detail if detail else ''}", components=components)


# ---------- start ----------

def parse_end(args, now):
    if (args.end_at is None) == (args.end is None):
        raise Refusal(2, "give exactly one of --end-at <unix seconds> or --end 'YYYY-MM-DD HH:MM' (America/New_York)")
    if args.end_at is not None:
        if not re.fullmatch(r"[0-9]{9,11}", args.end_at):
            raise Refusal(2, "--end-at must be Unix seconds")
        end_at = int(args.end_at)
    else:
        try:
            wall = dt.datetime.strptime(args.end, "%Y-%m-%d %H:%M")
        except ValueError:
            raise Refusal(2, "--end must be 'YYYY-MM-DD HH:MM' in America/New_York")
        first, second = wall.replace(tzinfo=ZONE, fold=0), wall.replace(tzinfo=ZONE, fold=1)
        if first.astimezone(dt.timezone.utc).astimezone(ZONE).replace(tzinfo=None) != wall:
            raise Refusal(3, f"{args.end} does not exist in America/New_York (clocks go forward)")
        if first.utcoffset() != second.utcoffset():
            raise Refusal(3, f"{args.end} happens twice in America/New_York (clocks go back); give --end-at instead")
        end_at = int(first.timestamp())
    if end_at <= now:
        raise Refusal(3, f"the end time {end_words(end_at)} is in the past")
    if end_at - now > MAX_AHEAD:
        raise Refusal(3, f"the end time {end_words(end_at)} is more than 24 h away")
    return end_at


def assignments(values, names, what):
    """`--model gpt-x` (everyone) or `--model Name=gpt-x`; later wins."""
    out = {}
    for value in values or []:
        who, sep, model = value.partition("=")
        if not sep:
            who, model = "*", value
        if not MODEL.match(model):
            raise Refusal(2, f"invalid {what} {model!r}")
        if who == "*":
            out.update({name: model for name in names})
        else:
            match = [name for name in names if name.lower() == who.lower()]
            if not match:
                raise Refusal(2, f"--model names {who}, who is not being started")
            out[match[0]] = model
    return out


def start(host, args):
    now = int(time.time())
    args.dry_run = args.dry_run or args.dry_run_body
    end_at = parse_end(args, now)
    if args.all and args.residents:
        raise Refusal(2, "give resident names or --all, not both")
    if not args.all and not args.residents:
        raise Refusal(2, "name the residents to start, or --all")
    for name in args.residents:
        if not NAME.match(name):
            raise Refusal(2, f"invalid resident name {name!r}")
    wanted = [host.resident(name) for name in (host.residents if args.all else dict.fromkeys(args.residents))]
    names = [entry["name"] for entry in wanted]
    models = assignments(args.model, names, "model")
    fresh = set()
    for name in args.fresh or []:
        match = [entry for entry in names if entry.lower() == name.lower()] if name != "all" else names
        if not match:
            raise Refusal(2, f"--fresh names {name}, who is not being started")
        fresh.update(match)
    caretaker_on = host.caretaker_default if args.caretaker is None else switch(args.caretaker, "--caretaker")
    every = host.interval_default if args.caretaker_interval is None else interval(args.caretaker_interval)
    speak_mode = host.speak_default if args.caretaker_speak is None else speak(args.caretaker_speak)
    note = args.note or ""
    if len(note) > NOTE_MAX or re.search(r"[\x00-\x1f\x7f]", note):
        raise Refusal(2, f"--note must be one line of at most {NOTE_MAX} characters")
    by = args.by or f"cli:{host.env.get('USER', 'unknown')}"
    if not LABEL.match(by):
        raise Refusal(2, "--by must be a short label")

    held = lock(host)
    try:
        everyone = [host.resident(name) for name in host.residents]
        states = show([unit_ for entry in everyone for unit_ in (entry["unit"], entry["client_unit"])] + [host.caretaker_unit])
        records = Records(host).all()
        plan, conflicts = [], []
        wanted_names = set(names)
        for entry in everyone:
            name, run_state, body = entry["name"], states[entry["unit"]], states[entry["client_unit"]]
            if running(run_state):
                running_end = end_of(run_state)
                if run_state["state"] == "deactivating":
                    conflicts.append(f"{name}'s run is stopping; try again when it has stopped")
                elif running_end != end_at:
                    until = local_time(running_end).strftime("%H:%M") if running_end else "an unknown time"
                    conflicts.append(f"{name} is already running until {until}" + (
                        "" if name in wanted_names else f"; every run on {host.name} shares one end time"))
                elif name in wanted_names:
                    argv = run_state["argv"]
                    running_model = argv[4] if len(argv) > 4 else None
                    running_mode = "resume" if run_state["env"].get("RESUME_THREAD") else "fresh"
                    if name in models and running_model and models[name] != running_model:
                        conflicts.append(f"{name} is already running with model {running_model}; stop it first to change the model")
                    elif name in fresh and running_mode != "fresh":
                        conflicts.append(f"{name} is already running on its resumed thread; stop it first to start a fresh one")
                    else:
                        plan.append({**entry, "model": running_model or entry["model"], "mode": running_mode,
                                     "thread_id": run_state["env"].get("RESUME_THREAD") or thread_of(host, name),
                                     "result": "already_running", "invocation_id": run_state["invocation"]})
                continue
            if name not in wanted_names:
                continue
            if running(body):
                conflicts.append(f"{name}'s body ({entry['client_unit']}) is active without a run; stop it first")
                continue
            strays = clients(host, entry["game_dir"])
            if strays:
                conflicts.append(f"a client for {name} is running outside its unit (pid {', '.join(map(str, strays))}); stop it first")
                continue
            model = models.get(name, entry["model"])
            harness = "CLAUDE.md" if model.startswith("claude:") else "AGENTS.md"
            if not (host.base / "resident" / entry["persona"] / harness).is_file():
                raise Refusal(5, f"{name} is not set up for model {model}: resident/{entry['persona']} has no {harness}")
            thread = None if (name in fresh or model.startswith("claude:")) else thread_of(host, name)
            if thread:
                _, previous = last_entry(records, name)
                if previous and previous.get("persona") not in (None, entry["persona"]):
                    conflicts.append(f"{name}'s persona changed from {previous['persona']} to {entry['persona']}: start fresh")
                    continue
            plan.append({**entry, "model": model, "mode": "resume" if thread else "fresh", "thread_id": thread, "result": "planned"})
        caretaker_state = states[host.caretaker_unit]
        if running(caretaker_state) and end_of(caretaker_state) not in (None, end_at):
            conflicts.append(f"the caretaker {host.caretaker_unit} is running until {local_time(end_of(caretaker_state)).strftime('%H:%M')}")
        if conflicts:
            raise Refusal(4, "; ".join(conflicts), conflicts=conflicts)

        starting = [entry for entry in plan if entry["result"] == "planned"]
        roster_names = {entry["name"] for entry in plan} | {
            entry["name"] for entry in everyone if running(states[entry["unit"]])}
        roster = [f"{entry['name']}:{entry['persona']}" for entry in everyone if entry["name"] in roster_names]
        caretaker_argv = running_roster = None
        if running(caretaker_state):
            running_roster = caretaker_state["argv"][3:]
        if caretaker_on and (not running(caretaker_state) or not set(roster) <= set(running_roster or [])):
            caretaker_argv = roster
        components = [f"resident-{entry['name'].lower()}" for entry in starting] + (["caretaker-" + host.name] if caretaker_argv else [])
        if components:
            start_gate(components)

        record = new_record(host, "start", by, args.dry_run)
        record.update({"end_at": end_at, "end_local": end_words(end_at), "note": note or None})
        failed = False
        session = str(HERE / "dry-run-session.sh") if args.dry_run else str(host.base / "run-session.sh")
        for entry in starting:
            env = [("RESUME_THREAD", entry["thread_id"])] if entry["thread_id"] else []
            env += [("SESSION_NOTE", note)] if note else []
            env += [("RESIDENTS_DRY_RUN_BODY", entry["client_unit"])] if args.dry_run_body else []
            invocation, error = systemd_run(entry["unit"], RUN_CPU, end_at, now, env,
                                            [session, entry["name"], entry["persona"], "0", entry["model"]])
            entry.update(result="started" if invocation is not None else "failed", invocation_id=invocation)
            if error:
                entry["error"], failed = error, True
        caretaker = {"enabled": caretaker_on, "unit": host.caretaker_unit, "interval": every, "speak": speak_mode}
        if caretaker_on and speak_mode != "keep":
            flag = host.base / "overseer" / "speak"
            if speak_mode == "on":
                flag.parent.mkdir(parents=True, exist_ok=True)
                flag.touch()
            else:
                flag.unlink(missing_ok=True)
        if not caretaker_on:
            caretaker["result"] = "left_running" if running(caretaker_state) else "off"
        elif caretaker_argv is None:
            caretaker.update(result="already_running", roster=running_roster, invocation_id=caretaker_state["invocation"])
        else:
            failed_names = {entry["name"] for entry in plan if entry["result"] == "failed"}
            live = [entry for entry in caretaker_argv if entry.split(":")[0] not in failed_names]
            error = None
            if running(caretaker_state):
                error = stop_units([host.caretaker_unit])
            if error is None and live:
                command = [str(HERE / "dry-run-session.sh")] if args.dry_run else [
                    str(host.base / "overseer" / "overseer-loop.sh")]
                invocation, error = systemd_run(host.caretaker_unit, CARETAKER_CPU, end_at, now, [],
                                                command + [local_time(end_at).strftime("%H:%M"), str(every), *live])
                caretaker.update(result="restarted" if running(caretaker_state) else "started", roster=live, invocation_id=invocation)
            elif error is None:
                caretaker["result"] = "not_needed"
            if error:
                caretaker.update(result="failed", error=error)
                failed = True
        record["residents"] = [{key: entry.get(key) for key in (
            "name", "persona", "model", "mode", "thread_id", "unit", "client_unit", "result", "invocation_id", "error")
            if entry.get(key) is not None} for entry in plan if entry["name"] in wanted_names]
        record["caretaker"] = caretaker
        status = 6 if failed else 0
        record.update(ok=status == 0, code=CODES[status])
        # A start that changed nothing (everyone already running as asked) leaves no record.
        record["changed"] = bool(starting) or caretaker_argv is not None
        if record["changed"]:
            Records(host).write(record)
        else:
            record["id"] = None
        return status, record
    finally:
        held.close()


# ---------- stop ----------

def stop(host, args):
    if args.all and args.residents:
        raise Refusal(2, "give resident names or --all, not both")
    if not args.all and not args.residents:
        raise Refusal(2, "name the residents to stop, or --all")
    by = args.by or f"cli:{host.env.get('USER', 'unknown')}"
    if not LABEL.match(by):
        raise Refusal(2, "--by must be a short label")
    targets = [host.resident(name) for name in (host.residents if args.all else dict.fromkeys(args.residents))]
    held = lock(host)
    try:
        everyone = [host.resident(name) for name in host.residents]
        units = [unit_ for entry in everyone for unit_ in (entry["unit"], entry["client_unit"])] + [host.caretaker_unit]
        before = show(units)
        target_names = {entry["name"] for entry in targets}
        # The run unit first: run-session.sh then takes the body offline and commits the notes.
        errors = [error for error in [stop_units([e["unit"] for e in targets if before[e["unit"]]["state"] != "inactive"])] if error]
        middle = show([entry["client_unit"] for entry in targets])
        errors += [error for error in [stop_units([e["client_unit"] for e in targets if running(middle[e["client_unit"]])])] if error]
        remaining = [entry for entry in everyone if entry["name"] not in target_names and running(before[entry["unit"]])]
        caretaker_state = before[host.caretaker_unit]
        caretaker = {"unit": host.caretaker_unit}
        if not running(caretaker_state):
            caretaker["result"] = "not_running"
        elif not remaining or args.all:
            error = stop_units([host.caretaker_unit])
            caretaker["result"] = "failed" if error else "stopped"
            errors += [error] if error else []
        else:
            roster = caretaker_state["argv"][3:]
            keep = [entry for entry in roster if entry.split(":")[0] not in target_names]
            if keep == roster:
                caretaker.update(result="left_running", roster=roster)
            else:
                # Same deadline and interval, without the residents that stopped.
                end_at, argv = end_of(caretaker_state), caretaker_state["argv"]
                error = stop_units([host.caretaker_unit])
                if error is None and end_at and end_at > time.time():
                    try:
                        start_gate([f"caretaker-{host.name}"])
                        invocation, error = systemd_run(host.caretaker_unit, CARETAKER_CPU, end_at, int(time.time()), [], argv[:3] + keep)
                        caretaker.update(result="restarted", roster=keep, invocation_id=invocation)
                    except Refusal as refusal:
                        caretaker.update(result="stopped", detail=refusal.message)
                else:
                    caretaker["result"] = "stopped"
                if error:
                    caretaker.update(result="failed", error=error)
                    errors.append(error)
        after = show(units)
        results, leftover = [], []
        for entry in targets:
            was = running(before[entry["unit"]]) or running(before[entry["client_unit"]])
            still = [u for u in (entry["unit"], entry["client_unit"]) if after[u]["state"] != "inactive" and after[u]["state"] != "failed"]
            strays = clients(host, entry["game_dir"])
            result = {"name": entry["name"], "unit": entry["unit"], "client_unit": entry["client_unit"],
                      "result": "still_active" if still or strays else "stopped" if was else "not_running"}
            if still:
                result["active_units"] = still
            if strays:
                result["client_pids"] = strays
            leftover += [f"{entry['name']}: {', '.join(still + [f'client pid {pid}' for pid in strays])}"] if still or strays else []
            results.append(result)
        if caretaker["result"] in ("stopped",) and running(after[host.caretaker_unit]):
            caretaker["result"] = "still_active"
            leftover.append(f"caretaker {host.caretaker_unit}")
        record = new_record(host, "stop", by)
        record.update(residents=results, caretaker=caretaker)
        status = 7 if leftover else 6 if errors else 0
        record.update(ok=status == 0, code=CODES[status])
        if leftover:
            record["error"] = "still active after stop: " + "; ".join(leftover)
        elif errors:
            record["error"] = "; ".join(errors)
        # A stop that found nothing running leaves no record.
        if any(r["result"] != "not_running" for r in results) or caretaker["result"] not in ("not_running", "left_running"):
            Records(host).write(record)
        else:
            record["id"] = None
        return status, record
    finally:
        held.close()


# ---------- status ----------

def status(host, _args):
    everyone = [host.resident(name) for name in host.residents]
    states = show([unit_ for entry in everyone for unit_ in (entry["unit"], entry["client_unit"])] + [host.caretaker_unit])
    records = Records(host).all()
    by_invocation = {}
    for record in records:
        for entry in record.get("residents", []) + [record.get("caretaker") or {}]:
            if entry.get("invocation_id"):
                by_invocation[entry["invocation_id"]] = (record, entry)
    residents = []
    for entry in everyone:
        run_state, body = states[entry["unit"]], states[entry["client_unit"]]
        live = running(run_state)
        record, launched = by_invocation.get(run_state["invocation"], (None, None)) if live else last_entry(records, entry["name"])
        argv = run_state["argv"]
        item = {
            "name": entry["name"], "persona": entry["persona"], "running": live,
            "run_unit": entry["unit"], "run_state": run_state["state"],
            "client_unit": entry["client_unit"], "client_state": body["state"],
            "end_at": end_of(run_state) if live else (record or {}).get("end_at"),
            "model": (argv[4] if live and len(argv) > 4 else (launched or {}).get("model")),
            "mode": ("resume" if run_state["env"].get("RESUME_THREAD") else "fresh") if live else (launched or {}).get("mode"),
            "thread_id": thread_of(host, entry["name"]),
            "dry_run": live and bool(argv) and argv[0].endswith("dry-run-session.sh"),
            "activation": (record or {}).get("id"), "started_by": (record or {}).get("requested_by"),
            "started_at": (record or {}).get("created_at"),
        }
        if live and record is None:
            item["started_by"] = "outside the launcher"
        residents.append(item)
    caretaker_state = states[host.caretaker_unit]
    caretaker = {"unit": host.caretaker_unit, "state": caretaker_state["state"], "running": running(caretaker_state),
                 "end_at": end_of(caretaker_state), "roster": caretaker_state["argv"][3:] if running(caretaker_state) else [],
                 "interval": int(caretaker_state["argv"][2]) if running(caretaker_state) and len(caretaker_state["argv"]) > 2
                 and caretaker_state["argv"][2].isdigit() else None}
    events = [{key: record.get(key) for key in ("id", "kind", "created_at", "requested_by", "end_at", "ok", "code", "dry_run")}
              | {"residents": [{"name": r.get("name"), "result": r.get("result"), "model": r.get("model"), "mode": r.get("mode")}
                               for r in record.get("residents", [])]}
              for record in records[-20:]]
    ends = {item["end_at"] for item in residents if item["running"]} | ({caretaker["end_at"]} if caretaker["running"] else set())
    return 0, {"ok": True, "code": "ok", "host": host.name, "now": int(time.time()),
               "end_at": next(iter(ends)) if len(ends) == 1 else None, "mixed_end_times": len(ends) > 1,
               "residents": residents, "caretaker": caretaker, "recent": events}


# ---------- command line ----------

def parser():
    root = Usage(prog="runctl.py", description=__doc__.split("\n\n")[0])
    sub = root.add_subparsers(dest="command", required=True, parser_class=Usage)
    begin = sub.add_parser("start", description="Start residents of this host until one absolute end time.")
    begin.add_argument("residents", nargs="*", help="resident names (this host's), or --all")
    begin.add_argument("--all", action="store_true", help="every resident in run.conf")
    begin.add_argument("--end-at", help="deadline, Unix seconds")
    begin.add_argument("--end", help="deadline 'YYYY-MM-DD HH:MM' in America/New_York")
    begin.add_argument("--model", action="append", help="MODEL for everyone started, or Name=MODEL; default from run.conf")
    begin.add_argument("--fresh", action="append", help="start Name on a new thread (repeatable; 'all' for everyone); default resumes its thread")
    begin.add_argument("--caretaker", choices=["on", "off"])
    begin.add_argument("--caretaker-interval")
    begin.add_argument("--caretaker-speak", choices=["keep", "on", "off"])
    begin.add_argument("--note", help="one-line SESSION_NOTE for the opening prompt")
    begin.add_argument("--by", help="who or what asked (recorded)")
    begin.add_argument("--dry-run", action="store_true", help="same units, but a stand-in session: no mind, no model call")
    begin.add_argument("--dry-run-body", action="store_true", help="--dry-run that also starts and stops the real body")
    begin.add_argument("--json", action="store_true")
    end = sub.add_parser("stop", description="Stop residents of this host cleanly; the caretaker stops with the last one.")
    end.add_argument("residents", nargs="*")
    end.add_argument("--all", action="store_true")
    end.add_argument("--by")
    end.add_argument("--json", action="store_true")
    state = sub.add_parser("status", description="Current and last run per resident of this host.")
    state.add_argument("--json", action="store_true")
    return root


def human(command, result):
    if command == "status":
        lines = [f"host {result['host']}"]
        for r in result["residents"]:
            lines.append(f"  {r['name']}: {'running until ' + end_words(r['end_at']) if r['running'] and r['end_at'] else r['run_state']}"
                         f"{' (' + str(r['model']) + ', ' + str(r['mode']) + ')' if r['running'] else ''}; client {r['client_state']}"
                         f"{'; started by ' + r['started_by'] if r['running'] and r['started_by'] else ''}")
        c = result["caretaker"]
        lines.append(f"  caretaker {c['unit']}: {c['state']}{' for ' + ' '.join(c['roster']) if c['roster'] else ''}")
        return "\n".join(lines)
    lines = [f"{result.get('kind', command)} on {result.get('host')}: {result['code']}"
             + (f" (until {result['end_local']})" if result.get("end_local") else "")]
    for r in result.get("residents", []):
        lines.append(f"  {r['name']}: {r['result']}" + (f" {r.get('model')} {r.get('mode')}" if r.get("model") else "")
                     + (f" thread {r['thread_id']}" if r.get("thread_id") else "") + (f": {r['error']}" if r.get("error") else ""))
    if result.get("caretaker"):
        lines.append(f"  caretaker: {result['caretaker'].get('result')}")
    if result.get("error"):
        lines.append(f"  error: {result['error']}")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    want_json = "--json" in argv
    command = argv[0] if argv else ""
    try:
        args = parser().parse_args(argv)
        host = Host()
        code, result = {"start": start, "stop": stop, "status": status}[args.command](host, args)
    except Refusal as refusal:
        code, result = refusal.status, {"ok": False, "code": CODES.get(refusal.status, "error"), "error": refusal.message, **refusal.extra}
        print(f"{command or 'runctl'}: {refusal.message}", file=sys.stderr)
    if want_json:
        print(json.dumps(result, sort_keys=True))
    elif result.get("ok") or "residents" in result:
        print(human(command, result))
    return code


if __name__ == "__main__":
    sys.exit(main())
