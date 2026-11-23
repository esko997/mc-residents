"""Host-local caretaking and hub-only jobs, using only temporary files/HTTP."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
TOKEN = "fixture-caretaker-token"
SNAPSHOT = {
    "skills": [{"name": "shared_sticks", "author": "Gary", "description": "Hub skill", "status": "verified"}],
    "collaborations": [{"id": 1, "sender": "Wren", "recipient": "Gary", "terms": "Pantry delivery", "status": "accepted"}],
    "facilities": [{"id": 2, "name": "Hub pantry", "observed_at": 123, "metadata_status": "matching metadata"}],
    "knowledge_requests": [{"id": 3, "question": "Infuser question", "title": "Untested infuser reference"}],
    "places": [{"name": "Shared hearth", "x": 10, "y": 64, "z": 20}],
}


def clean_env(home, **values):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("COMMONS_") and key not in ("SESSION_END_AT", "GARY_CLIENT_HOME")}
    return {**env, "HOME": str(home), "GARY_CLIENT_HOME": str(home), **values}


def executable(path, body):
    path.write_text(body)
    path.chmod(0o700)


@contextlib.contextmanager
def fake_hub(status=200, payload=SNAPSHOT, redirect=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if redirect:
                self.send_header("Location", redirect)
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class HostCaretaker(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.resident = self.home / "resident" / "wren"
        self.resident.mkdir(parents=True)
        (self.resident / "memory.md").write_text("Own host memory")
        (self.resident / "AGENTS.md").write_text("## What you are working towards\nKeep a pantry.\n")
        self.token = self.home / "caretaker.token"
        self.token.write_text(TOKEN + "\n")
        self.token.chmod(0o600)
        # Neither stale shared storage source may be used, even during an outage.
        (self.home / "commons-data").mkdir()
        (self.home / "commons-data" / "commons.sqlite").write_text("NOT A DATABASE")
        shared = self.home / "resident" / "shared"
        shared.mkdir()
        (shared / "places.json").write_text('[{"name":"STALE LOCAL SHARED PLACE"}]')

    def digest(self, url=None, **env):
        config = {"COMMONS_TOKEN_FILE": str(self.token), **env}
        if url is not None:
            config["COMMONS_URL"] = url
        return subprocess.run(
            [sys.executable, str(HERE / "digest.py"), "Wren", str(self.resident), "25", "--base", str(self.home)],
            env=clean_env(self.home, **config), text=True, capture_output=True, timeout=10)

    def test_digest_fetches_hub_with_caretaker_token_on_each_host_role(self):
        for role in ("hub", "station"):
            with self.subTest(role=role), fake_hub() as (url, requests):
                result = self.digest(url, COMMONS_ROLE=role)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(requests), 1)
                path, authorization = requests[0]
                self.assertEqual(urlsplit(path).path, "/resident-api/v1/caretaker/digest")
                self.assertEqual(parse_qs(urlsplit(path).query), {"resident": ["Wren"]})
                self.assertEqual(authorization, "Bearer " + TOKEN)
                for text in ("Own host memory", "shared_sticks", "Pantry delivery", "Hub pantry", "Untested infuser reference", "Shared hearth"):
                    self.assertIn(text, result.stdout)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)
                self.assertNotIn("STALE LOCAL", result.stdout)
                self.assertNotIn("unavailable", result.stdout)

    def test_library_errors_do_not_erase_local_digest_or_fall_back(self):
        for status, payload in ((403, {"error": {"message": TOKEN}}), (200, {"skills": []})):
            with self.subTest(status=status), fake_hub(status, payload) as (url, _):
                result = self.digest(url, COMMONS_ROLE="station")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Hub library unavailable", result.stdout)
                self.assertIn("do not infer none exist", result.stdout)
                self.assertIn("Own host memory", result.stdout)
                self.assertNotIn("STALE LOCAL", result.stdout)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)
        missing = self.digest()
        self.assertEqual(missing.returncode, 0, missing.stderr)
        self.assertIn("Hub library unavailable", missing.stdout)

    def test_hub_connection_failure_leaves_local_context_usable(self):
        with fake_hub() as (url, _):
            pass
        result = self.digest(url, COMMONS_ROLE="station")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Hub library unavailable", result.stdout)
        self.assertIn("Own host memory", result.stdout)
        self.assertNotIn("STALE LOCAL", result.stdout)

    def test_token_is_not_forwarded_to_a_redirect(self):
        with fake_hub() as (destination, forwarded):
            with fake_hub(302, {}, redirect=destination) as (url, _):
                result = self.digest(url)
        self.assertIn("HTTP 302", result.stdout)
        self.assertEqual(forwarded, [])

    def test_empty_hub_library_is_distinct_from_unavailable(self):
        with fake_hub(payload={key: [] for key in SNAPSHOT}) as (url, _):
            result = self.digest(url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Available reusable skills", result.stdout)
        self.assertNotIn("unavailable", result.stdout)

    def test_direct_central_jobs_skip_stations_and_fail_closed_for_unknown_role(self):
        db = str(self.home / "commons-data" / "commons.sqlite")
        for script in ("commons-review.py", "knowledge-research.py"):
            for role in ("station", "invalid", "hub", None):
                with self.subTest(script=script, role=role):
                    env = clean_env(self.home)
                    if role is not None:
                        env["COMMONS_ROLE"] = role
                    result = subprocess.run([sys.executable, str(HERE / script), "--db", db],
                                            env=env, text=True, capture_output=True, timeout=10)
                    if role == "station":
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("skipped on station", result.stdout)
                    elif role == "invalid":
                        self.assertEqual(result.returncode, 2)
                        self.assertIn("COMMONS_ROLE must be hub or station", result.stderr)
                    else:
                        # Explicit hub and the default both attempt the supplied DB.
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("not a database", result.stderr)

    def test_overseer_keeps_local_caretaking_but_runs_review_only_on_hub(self):
        work = self.home / "overseer"
        work.mkdir()
        shutil.copy(HERE / "digest.py", work / "digest.py")
        (work / "commons-review.py").write_text("from pathlib import Path\nPath(__file__).with_name('review-called').touch()\n")
        binary = self.home / "bin"
        binary.mkdir()
        executable(binary / "codex", f"""#!{sys.executable}
import pathlib, sys
pathlib.Path({str(work / 'prompt')!r}).write_text(sys.argv[-1])
pathlib.Path(sys.argv[sys.argv.index('-o') + 1]).write_text('NOTE: none\\nMAINTAINERS: none\\n')
""")
        config = self.home / ".config" / "commons"
        config.mkdir(parents=True)
        # Base server settings can be overridden by the caretaker-specific file.
        (config / "env").write_text("COMMONS_ROLE=hub\n")
        with fake_hub() as (url, requests):
            for role in ("station", "hub"):
                with self.subTest(role=role):
                    (config / "caretaker.env").write_text(
                        f"COMMONS_ROLE={role}\nCOMMONS_URL={url}\nCOMMONS_TOKEN_FILE={self.token}\n")
                    marker = work / "review-called"
                    marker.unlink(missing_ok=True)
                    result = subprocess.run(["bash", str(HERE / "overseer.sh"), "Wren", "wren", "25"],
                                            env=clean_env(self.home), text=True, capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(marker.exists(), role == "hub")
                    prompt = (work / "prompt").read_text()
                    self.assertIn("Own host memory", prompt)
                    self.assertIn("shared_sticks", prompt)
                    self.assertIn("Keep a pantry.", prompt)
                    self.assertIn("NOTE: none", (work / "Wren.md").read_text())
            self.assertEqual(len(requests), 2)
            self.assertTrue(all(parse_qs(urlsplit(path).query) == {"resident": ["Wren"]} for path, _ in requests))

    def test_loop_caretakes_own_roster_on_both_roles_but_researches_only_on_hub(self):
        work = self.home / "overseer"
        work.mkdir()
        shutil.copy(HERE / "overseer-loop.sh", work / "overseer-loop.sh")
        calls = self.home / "loop-calls"
        executable(work / "overseer.sh", f'#!/bin/sh\nprintf "resident %s %s\\n" "$1" "$2" >> "{calls}"\n')
        binary = self.home / "test-bin"
        binary.mkdir()
        executable(binary / "sleep", "#!/bin/sh\nexit 0\n")
        executable(binary / "timeout", '#!/bin/sh\nshift 2\nexec "$@"\n')
        executable(binary / "python3", f'#!/bin/sh\nprintf "research\\n" >> "{calls}"\n')
        count = self.home / "date-count"
        executable(binary / "date", f"""#!{sys.executable}
from pathlib import Path
import sys
if sys.argv[1] != '+%s':
    print('fixture-time')
else:
    path = Path({str(count)!r})
    n = int(path.read_text()) if path.exists() else 0
    path.write_text(str(n + 1))
    print([0, 1, 2, 3, 101][min(n, 4)])
""")
        config = self.home / ".config" / "commons"
        config.mkdir(parents=True)
        for role in ("station", "hub", None):
            with self.subTest(role=role):
                calls.unlink(missing_ok=True)
                count.unlink(missing_ok=True)
                (config / "env").write_text(f"COMMONS_ROLE={role}\n" if role else "")
                result = subprocess.run(["bash", str(work / "overseer-loop.sh"), "08:00", "1", "Wren:wren", "Tobin:tobin"],
                                        env=clean_env(self.home, SESSION_END_AT="100", PATH=str(binary) + os.pathsep + os.environ["PATH"]),
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = ["resident Wren wren", "resident Tobin tobin"]
                if role != "station":
                    expected.append("research")
                self.assertEqual(calls.read_text().splitlines(), expected)


if __name__ == "__main__":
    unittest.main()
