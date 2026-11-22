"""Isolated HTTP/process tests; no real systemd, Minecraft or model access.

Run: python3 -m unittest discover -s full-client -p 'test_health_watch.py' -v
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("health_watch", ROOT / "health-watch.py")
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


def world(health=20):
    return {"ok": True, "data": {"pos": {"x": 1, "y": 64, "z": 2},
                                 "dimension": "minecraft:overworld", "health": health}}


class HealthDecisions(unittest.TestCase):
    def test_startup_and_isolated_timeout_do_not_pause(self):
        health = watch.Health(0)
        self.assertEqual(health.observe("client_stopped", 280), "starting")
        self.assertEqual(health.observe("healthy", 290), "healthy")
        self.assertEqual(health.observe("probe_timeout", 305), "degraded")
        self.assertEqual(health.observe("healthy", 320), "healthy")
        self.assertEqual(health.failures, 0)
        self.assertEqual(health.observe("non_world", 350), "degraded")
        self.assertEqual(health.observe("client_stopped", 380), "degraded")
        self.assertEqual(health.observe("probe_timeout", 410), "paused")

    def test_death_is_not_body_loss_and_startup_is_bounded(self):
        self.assertEqual(watch.classify(world(0)), "in_game_dead")
        self.assertEqual(watch.Health(0).observe("in_game_dead", 10), "healthy")
        self.assertEqual(watch.classify({"ok": True, "data": {"screen": "TitleScreen"}}), "non_world")
        health = watch.Health(0)
        self.assertEqual(health.observe("unavailable", 299), "starting")
        self.assertEqual(health.observe("unavailable", 300), "paused")


class IsolatedSession(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        (self.base / "resident/gary").mkdir(parents=True)
        (self.base / "resident/gary/AGENTS.md").write_text("Test resident")
        (self.base / "resident/.git").mkdir()
        (self.base / "sessions").mkdir()
        self.token = "test-secret-never-in-log"
        (self.base / "token").write_text(self.token)
        self.requests = []
        self.reply = world()
        self.http_status = 200
        fixture = self
        self.reply_delay = 0

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fixture.requests.append((self.command, self.path, self.headers.get("X-Synapse-Token")))
                self.send_response(fixture.http_status)
                time.sleep(fixture.reply_delay)
                self.end_headers()
                try:
                    self.wfile.write(json.dumps(fixture.reply).encode())
                except BrokenPipeError:
                    pass  # The bounded probe deliberately abandons a stalled read.

            def do_POST(self):
                fixture.requests.append((self.command, self.path, None))
                self.send_error(405)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=2)))
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        GARY_CLIENT_HOME=str(self.base), SYNAPSE_TOKEN_FILE=str(self.base / "token"),
                        SYNAPSE_URL=f"http://127.0.0.1:{server.server_port}",
                        SESSION_CLIENT_UNIT="fake-client", SESSION_RESIDENT="Gary",
                        SESSION_LOG=str(self.base / "session.log"),
                        SESSION_HEALTH_FILE=str(self.base / "sessions/Gary-health.json"),
                        SESSION_HEALTH_LOG=str(self.base / "sessions/Gary-health.jsonl"),
                        SESSION_END_AT=str(int(time.time()) + 1200))
        for key in ("SESSION_HEALTH_CHILD", "RESUME_THREAD"):
            self.env.pop(key, None)
        (self.base / "instances").mkdir()
        (self.base / "instances/Gary.env").write_text("SYNAPSE_URL=" + self.env["SYNAPSE_URL"] + "\n")
        # Only these harmless executables can be reached by the tested launcher.
        self.program("systemctl", '''#!/usr/bin/env python3
import os, pathlib, sys
p = pathlib.Path(os.environ["GARY_CLIENT_HOME"]) / "active"
cmd = sys.argv[2]
if cmd == "start": p.touch()
elif cmd in ("stop", "kill"): p.unlink(missing_ok=True)
elif cmd == "is-active":
    print("active" if p.exists() else "inactive")
    sys.exit(0 if p.exists() else 3)
''')
        self.program("git", "#!/bin/sh\nexit 0\n")
        # The production resume delay is tested structurally by recording it;
        # skip only that delay to keep the fake-harness loop test bounded.
        self.program("sleep", '#!/bin/sh\nif [ "$1" = 15 ]; then echo 15 >> "$GARY_CLIENT_HOME/delays"; exit 0; fi\nexec /bin/sleep "$@"\n')
        self.addCleanup(self.assert_no_world_writes_or_secret_logs)

    def program(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o700)

    def state(self):
        return json.loads(Path(self.env["SESSION_HEALTH_FILE"]).read_text())

    def assert_no_world_writes_or_secret_logs(self):
        self.assertTrue(all(method == "GET" and path == "/state?mode=summary"
                            for method, path, token in self.requests))
        for path in (self.base / "sessions").glob("*"):
            self.assertNotIn(self.token, path.read_text())
        if (self.base / "session.log").exists():
            self.assertNotIn(self.token, (self.base / "session.log").read_text())

    def run_shell(self):
        args = ["bash", str(ROOT / "run-session.sh"), "Gary", "gary", "20"]
        process = subprocess.Popen(args, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = process.communicate(timeout=12)
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        finally:
            self.stop_process(process)

    @staticmethod
    def stop_process(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=24)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def test_probe_authentication_death_and_stopped_client(self):
        (self.base / "active").touch()
        self.reply = world(0)
        args = [sys.executable, str(ROOT / "health-watch.py"), "--probe"]
        reply = subprocess.run(args, env=self.env, capture_output=True, timeout=6)
        self.assertEqual(reply.stdout.strip(), b"in_game_dead")
        self.assertEqual(self.requests[0][2], self.token)
        self.http_status = 401
        reply = subprocess.run(args, env=self.env, capture_output=True, timeout=6)
        self.assertEqual(reply.stdout.strip(), b"unauthorized")
        (self.base / "active").unlink()
        reply = subprocess.run(args, env=self.env, capture_output=True, timeout=6)
        self.assertEqual(reply.stdout.strip(), b"client_stopped")

    def test_stalled_http_is_bounded_and_not_a_stopped_client(self):
        (self.base / "active").touch()
        self.reply_delay = 4
        started = time.monotonic()
        result = subprocess.run([sys.executable, str(ROOT / "health-watch.py"), "--probe"],
                                env=self.env, capture_output=True, timeout=6)
        self.assertEqual(result.stdout.strip(), b"probe_timeout")
        self.assertLess(time.monotonic() - started, 5)

    def test_clean_no_body_return_fails_without_restart_and_retains_thread(self):
        self.program("codex", '#!/bin/sh\necho invocation >> "$GARY_CLIENT_HOME/invocations"\necho "session id: thread-one"\n')
        result = self.run_shell()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.state()["reason"], "no_body_calls")
        self.assertEqual(self.state()["thread_id"], "thread-one")
        self.assertEqual((self.base / "invocations").read_text().splitlines(), ["invocation"])
        self.assertFalse((self.base / "active").exists())

    def test_voluntary_returns_resume_same_thread_but_tight_loop_stops(self):
        self.program("codex", '''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ["GARY_CLIENT_HOME"]) / "invocations"
with p.open("a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
print("session id: thread-one")
print("mcp: body/status")
''')
        result = self.run_shell()
        self.assertEqual(result.returncode, 5, result.stderr)
        calls = [json.loads(line) for line in (self.base / "invocations").read_text().splitlines()]
        self.assertEqual(len(calls), 3)
        self.assertNotIn("resume", calls[0])
        for args in calls[1:]:
            self.assertEqual(args[:2], ["exec", "resume"])
            self.assertEqual(args[-2], "thread-one")
        self.assertEqual(self.state()["reason"], "rapid_returns")
        self.assertEqual((self.base / "delays").read_text().splitlines(), ["15", "15"])

    def supervisor(self, code, seconds=1200):
        self.env["SESSION_END_AT"] = str(int(time.time()) + seconds)
        process = subprocess.Popen([sys.executable, str(ROOT / "health-watch.py"), sys.executable, "-c", code],
                                   env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_process, process)
        return process

    def test_startup_health_pause_retains_resumable_mind_without_restart(self):
        runner = (
            "import functools,importlib.util,sys;"
            "s=importlib.util.spec_from_file_location('watch',sys.argv[1]);"
            "w=importlib.util.module_from_spec(s);s.loader.exec_module(w);"
            "w.Health=functools.partial(w.Health,startup_grace=0.5);"
            "sys.exit(w.supervise([sys.executable,'-c',sys.argv[2]]))"
        )
        child = 'import os,time; open(os.environ["SESSION_LOG"],"a").write("session id: thread-paused\\n"); time.sleep(60)'
        process = subprocess.Popen([sys.executable, "-c", runner, str(ROOT / "health-watch.py"), child],
                                   env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_process, process)
        self.assertEqual(process.wait(timeout=8), 20)
        state = self.state()
        self.assertEqual((state["status"], state["reason"]), ("paused", "startup_unavailable"))
        self.assertEqual(state["thread_id"], "thread-paused")
        self.assertTrue(state["paused"])
        self.assertTrue(state["terminal"])
        self.assertFalse(state["auto_restart"])

    def test_absolute_deadline_covers_startup_and_preserves_thread(self):
        process = self.supervisor('import os,time; open(os.environ["SESSION_LOG"], "a").write("session id: thread-deadline\\n"); time.sleep(60)', seconds=2)
        self.assertEqual(process.wait(timeout=8), 0)
        state = self.state()
        self.assertEqual((state["status"], state["reason"], state["thread_id"]), ("stopped", "deadline", "thread-deadline"))
        self.assertTrue(state["cleanup_complete"])
        self.assertFalse(state["auto_restart"])
        self.assertLessEqual(state["updated_at"], state["end_at"] + 4)

    def test_admin_stop_and_mind_failure_are_distinct(self):
        process = self.supervisor("import time; time.sleep(60)")
        for _ in range(100):
            if Path(self.env["SESSION_HEALTH_FILE"]).exists():
                break
            time.sleep(0.02)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=8), 143)
        self.assertEqual(self.state()["reason"], "admin_stop")
        process = self.supervisor("raise SystemExit(11)")
        self.assertEqual(process.wait(timeout=8), 11)
        self.assertEqual((self.state()["status"], self.state()["reason"]), ("failed", "mind_failure"))

    def test_expired_deadline_never_launches(self):
        process = self.supervisor('import os,pathlib; pathlib.Path(os.environ["GARY_CLIENT_HOME"], "unexpected").touch()', seconds=-1)
        self.assertEqual(process.wait(timeout=8), 0)
        self.assertFalse((self.base / "unexpected").exists())
        self.assertEqual(self.state()["reason"], "deadline")


if __name__ == "__main__":
    unittest.main()
