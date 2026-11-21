"""Tests for the console and command parts of phone_chat.py.

    cd phone-chat && python3 -m unittest

No dependencies. A stand-in `podman` on PATH plays the server console, and the
log is a temporary file, so nothing here touches a real server.
"""
import atexit
import json
import os
import shutil
import stat
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

WORK = tempfile.mkdtemp(prefix="phone-chat-test-")
LOG = os.path.join(WORK, "latest.log")
CALLS = os.path.join(WORK, "podman-calls")
atexit.register(shutil.rmtree, WORK, ignore_errors=True)
os.environ.update(PHONE_CHAT_TOKEN="test-token", PHONE_CHAT_LOG=LOG, PHONE_CHAT_CONTAINER="test-server", PHONE_CHAT_NAME="spesk01")

# podman exec <container> rcon-cli <command>: record the call, then answer by the command's first word,
# the way rcon-cli does: coloured, and ending with a colour reset after the last newline.
FAKE_PODMAN = f"""#!/bin/sh
printf '%s\\n' "$*" >> {CALLS}
[ "$1" = exec ] && [ "$3" = rcon-cli ] || {{ echo "unexpected call: $*" >&2; exit 64; }}
case "$4" in
  list) printf 'There are 2 of a max of 20 players online: Gary, Margo\\n\\033[0m' ;;
  two-lines) printf 'first\\n\\n  \\nsecond\\n\\033[0m\\n' ;;
  colour) printf '\\033[32mgreen\\033[0m plain\\n' ;;
  broken*) echo "Unknown or incomplete command" >&2; exit 1 ;;
  slow) exec sleep 5 ;;
  "tellraw @a "*) printf '\\033[0m' ;;
  *) ;;
esac
"""
os.makedirs(os.path.join(WORK, "bin"))
with open(os.path.join(WORK, "bin", "podman"), "w") as script:
    script.write(FAKE_PODMAN)
os.chmod(os.path.join(WORK, "bin", "podman"), stat.S_IRWXU)
os.environ["PATH"] = os.path.join(WORK, "bin") + os.pathsep + os.environ["PATH"]

import phone_chat  # noqa: E402  (reads its settings from the environment set above)


def stamp(n):
    return f"[21Nov2026 16:{n // 60 % 60:02d}:{n % 60:02d}.{n % 1000:03d}] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]:"


def wait_for(condition, seconds=6.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


class ConsoleRing(unittest.TestCase):
    def test_lines_are_numbered_in_order_and_a_reader_gets_only_what_is_new(self):
        ring = phone_chat.Console()
        for word in ("one", "two", "three"):
            ring.add(word)
        self.assertEqual(ring.since(0)["lines"], [{"id": 1, "text": "one"}, {"id": 2, "text": "two"}, {"id": 3, "text": "three"}])
        self.assertEqual(ring.since(2)["lines"], [{"id": 3, "text": "three"}])
        self.assertEqual(ring.since(3)["lines"], [])

    def test_only_the_newest_5000_are_kept_and_ids_keep_growing(self):
        ring = phone_chat.Console()
        for n in range(5003):
            ring.add(f"line {n}")
        lines = ring.since(0)["lines"]
        self.assertEqual(len(lines), 5000)
        self.assertEqual(lines[0], {"id": 4, "text": "line 3"})
        self.assertEqual(lines[-1], {"id": 5003, "text": "line 5002"})

    def test_colour_codes_and_carriage_returns_are_stripped(self):
        ring = phone_chat.Console()
        ring.add("\x1b[33m[WARN]\x1b[m Can't keep up!\x1b[0m\r")
        self.assertEqual(ring.since(0)["lines"][0]["text"], "[WARN] Can't keep up!")

    def test_starting_over_changes_boot_and_restarts_the_numbering(self):
        ring = phone_chat.Console()
        ring.add("old")
        before = ring.since(0)["boot"]
        ring.start_over()
        ring.add("new")
        after = ring.since(0)
        self.assertNotEqual(after["boot"], before)
        self.assertEqual(after["lines"], [{"id": 1, "text": "new"}])

    def test_a_made_up_line_carries_its_mark_and_the_time_it_happened(self):
        ring = phone_chat.Console()
        ring.add("> list", mark="command")
        line = ring.since(0)["lines"][0]
        self.assertEqual((line["text"], line["mark"]), ("> list", "command"))
        self.assertAlmostEqual(line["t"], time.time(), delta=5)


class Service(unittest.TestCase):
    """The HTTP routes, with the log follower running against a temporary log."""

    @classmethod
    def setUpClass(cls):
        with open(LOG, "w") as log:
            for n in range(2500):
                log.write(f"{stamp(n)} old line {n}\n")
            log.write(f"{stamp(2500)} [Not Secure] <Gary> hello from before\n")
        threading.Thread(target=phone_chat.follow_log, daemon=True).start()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), phone_chat.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        assert wait_for(lambda: len(phone_chat.console.since(0)["lines"]) == 2000), "the log was not read"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return json.loads(response.read())

    def post(self, path, body, timeout=10):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as problem:
            return problem.code, json.loads(problem.read())

    def console(self, after=0):
        return self.get(f"/test-token/console?after={after}")

    def podman_calls(self):
        with open(CALLS) as calls:
            return calls.read().splitlines()

    def test_1_a_log_that_was_already_written_is_shown_from_its_last_2000_lines(self):
        reply = self.console()
        texts = [line["text"] for line in reply["lines"]]
        self.assertEqual(len(texts), 2000)
        self.assertEqual(texts[0], f"{stamp(501)} old line 501")
        self.assertEqual(texts[-1], f"{stamp(2500)} [Not Secure] <Gary> hello from before")
        ids = [line["id"] for line in reply["lines"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(set(ids)), 2000)
        # The chat page's own route is as before: chat only, from the whole file.
        entries = self.get("/test-token/log?after=0")["entries"]
        self.assertEqual([(entry["name"], entry["text"]) for entry in entries], [("Gary", "hello from before")])

    def test_2_new_log_lines_arrive_raw_with_the_next_ids(self):
        last = self.console()["lines"][-1]["id"]
        with open(LOG, "a") as log:
            log.write("[21Nov2026 17:00:00.001] [Server thread/WARN] [net.minecraft.server.MinecraftServer/]: Can't keep up! Is the server overloaded?\n")
            log.write("java.lang.IllegalStateException: a line without a stamp\n")
            log.write("half a line, not ended yet")
        self.assertTrue(wait_for(lambda: len(self.console(last)["lines"]) == 2))
        self.assertEqual(self.console(last)["lines"], [
            {"id": last + 1, "text": "[21Nov2026 17:00:00.001] [Server thread/WARN] [net.minecraft.server.MinecraftServer/]: Can't keep up! Is the server overloaded?"},
            {"id": last + 2, "text": "java.lang.IllegalStateException: a line without a stamp"},
        ])
        with open(LOG, "a") as log:
            log.write(" ... now it is\n")
        self.assertTrue(wait_for(lambda: len(self.console(last + 2)["lines"]) == 1))
        self.assertEqual(self.console(last + 2)["lines"][0]["text"], "half a line, not ended yet ... now it is")

    def test_3_a_wrong_token_gets_404_and_other_routes_are_unchanged(self):
        for path in ("/wrong/console", "/console", "/test-token/nothing"):
            with self.assertRaises(urllib.error.HTTPError) as refused:
                urllib.request.urlopen(self.base + path, timeout=5)
            self.assertEqual(refused.exception.code, 404)
        self.assertEqual(self.post("/wrong/command", {"command": "list"})[0], 404)
        with urllib.request.urlopen(self.base + "/test-token/", timeout=5) as page:
            self.assertIn(b"Server chat", page.read())

    def test_4_a_command_runs_through_rcon_and_both_it_and_the_answer_join_the_console(self):
        last = self.console()["lines"][-1]["id"]
        status, reply = self.post("/test-token/command", {"command": "/list"})
        self.assertEqual((status, reply), (200, {"output": "There are 2 of a max of 20 players online: Gary, Margo"}))
        self.assertEqual(self.podman_calls()[-1], "exec test-server rcon-cli list")
        echoed = self.console(last)["lines"]
        self.assertEqual([(line["text"], line["mark"]) for line in echoed], [
            ("> list", "command"), ("There are 2 of a max of 20 players online: Gary, Margo", "output")])
        self.assertEqual([line["id"] for line in echoed], [last + 1, last + 2])
        self.assertAlmostEqual(echoed[0]["t"], time.time(), delta=10)

    def test_5_the_whole_command_is_one_argument_and_quiet_or_long_answers_are_echoed_line_by_line(self):
        last = self.console()["lines"][-1]["id"]
        tellraw = 'tellraw @a {"text":"<Caretaker> Gary: the stream is north; mind the \\"deep\\" water"}'
        self.assertEqual(self.post("/test-token/command", {"command": tellraw}), (200, {"output": ""}))
        self.assertEqual(self.podman_calls()[-1], f"exec test-server rcon-cli {tellraw}")
        self.assertEqual(self.post("/test-token/command", {"command": "two-lines"}), (200, {"output": "first\nsecond"}))
        self.assertEqual(self.post("/test-token/command", {"command": "colour"})[1], {"output": "green plain"})
        self.assertEqual([(line["text"], line["mark"]) for line in self.console(last)["lines"]], [
            (f"> {tellraw}", "command"), ("(no output)", "output"),
            ("> two-lines", "command"), ("first", "output"), ("second", "output"),
            ("> colour", "command"), ("green plain", "output"),
        ])

    def test_6_a_command_the_server_refuses_or_never_answers_is_an_error_the_console_shows_too(self):
        last = self.console()["lines"][-1]["id"]
        self.assertEqual(self.post("/test-token/command", {"command": "broken now"}),
                         (502, {"error": "The server console refused the command: Unknown or incomplete command"}))
        phone_chat.RCON_TIMEOUT = 0.3
        try:
            started = time.monotonic()
            status, reply = self.post("/test-token/command", {"command": "slow"})
        finally:
            phone_chat.RCON_TIMEOUT = 10
        self.assertEqual(status, 502)
        self.assertRegex(reply["error"], r"^The server console did not answer: .*timed out after 0\.3 seconds")
        self.assertLess(time.monotonic() - started, 4)
        shown = [(line["text"], line["mark"]) for line in self.console(last)["lines"]]
        self.assertEqual(shown[:2], [("> broken now", "command"), ("The server console refused the command: Unknown or incomplete command", "output")])
        self.assertEqual(shown[2], ("> slow", "command"))
        self.assertTrue(shown[3][0].startswith("The server console did not answer: "))

    def test_7_what_is_not_a_command_is_refused_and_nothing_runs(self):
        calls, last = len(self.podman_calls()), self.console()["lines"][-1]["id"]
        self.assertEqual(self.post("/test-token/command", {"command": "   "}), (400, {"error": "Type a command first."}))
        self.assertEqual(self.post("/test-token/command", {"command": "/"}), (400, {"error": "Type a command first."}))
        self.assertEqual(self.post("/test-token/command", {"command": "say a\nstop"}), (400, {"error": "A command is one line of plain text."}))
        self.assertEqual(self.post("/test-token/command", {"command": 7}), (400, {"error": "A command is one line of plain text."}))
        self.assertEqual(self.post("/test-token/command", {"text": "list"}), (400, {"error": "Send JSON with a command field."}))
        self.assertEqual(self.post("/test-token/command", b"list"), (400, {"error": "Send JSON with a command field."}))
        self.assertEqual(self.post("/test-token/command", {"command": "x" * 1001}), (400, {"error": "Commands stop at 1000 characters."}))
        self.assertEqual(len(self.podman_calls()), calls)
        self.assertEqual(self.console(last)["lines"], [])

    def test_8_a_message_said_from_the_chat_page_still_works_and_shows_in_the_console(self):
        last = self.console()["lines"][-1]["id"]
        self.assertEqual(self.post("/test-token/say", {"text": "hello  Gary"}), (200, {"ok": True}))
        self.assertEqual(self.podman_calls()[-1], 'exec test-server rcon-cli tellraw @a {"text": "<spesk01> hello Gary"}')
        entries = self.get("/test-token/log?after=0")["entries"]
        self.assertEqual((entries[-1]["name"], entries[-1]["text"]), ("spesk01", "hello Gary"))
        said = self.console(last)["lines"]
        self.assertEqual([(line["text"], line["mark"]) for line in said], [("<spesk01> hello Gary", "chat")])

    def test_9_when_the_server_replaces_its_log_boot_changes_and_the_new_log_is_read_from_its_start(self):
        before = self.console()
        fresh = LOG + ".new"
        with open(fresh, "w") as log:
            log.write("[22Nov2026 00:00:01.000] [main/INFO] [net.minecraft.server.Main/]: Starting server\n")
        os.replace(fresh, LOG)
        self.assertTrue(wait_for(lambda: self.console()["boot"] != before["boot"]))
        self.assertTrue(wait_for(lambda: len(self.console()["lines"]) == 1))
        after = self.console()
        self.assertEqual(after["lines"], [{"id": 1, "text": "[22Nov2026 00:00:01.000] [main/INFO] [net.minecraft.server.Main/]: Starting server"}])
        # A reader still asking with an id from the old log gets nothing, but can tell by `boot` to start over.
        self.assertEqual(self.console(before["lines"][-1]["id"])["lines"], [])
        with open(LOG, "a") as log:
            log.write("[22Nov2026 00:00:02.000] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Margo joined the game\n")
        self.assertTrue(wait_for(lambda: len(self.console(1)["lines"]) == 1))
        self.assertEqual(self.console(1)["lines"][0]["id"], 2)


if __name__ == "__main__":
    unittest.main()
