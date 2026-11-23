"""start-run.sh / stop-run.sh / run-status.sh against stubbed systemctl and systemd-run.

No real unit is touched: the stubs keep unit state in a JSON file and record every call.
"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

TOOLS = Path(__file__).resolve().parent
THREAD = "01a20685-ec8a-79f2-9bdc-22d2396153ae"

SYSTEMCTL = r'''#!/usr/bin/env python3
import json, os, shlex, sys
from pathlib import Path
p = Path(os.environ["RUNCTL_TEST_STATE"])
s = json.loads(p.read_text())
a = sys.argv[1:]
s["calls"].append(["systemctl"] + a)
assert a[0] == "--user", a
verb, rest = a[1], a[2:]
units = s["units"]
blank = {"state": "inactive", "invocation": "", "env": {}, "argv": []}
if verb == "show":
    out = []
    for name in [r for r in rest if not r.startswith("--")]:
        u = units.get(name, blank)
        lines = [f"Id={name}", f"ActiveState={u['state']}", "SubState=x", f"InvocationID={u['invocation']}",
                 "Environment=" + " ".join(shlex.quote(f"{k}={v}") for k, v in u["env"].items())]
        if u["argv"]:
            lines.append(f"ExecStart={{ path={u['argv'][0]} ; argv[]={' '.join(u['argv'])} ; ignore_errors=no ; pid=1 }}")
        out.append("\n".join(lines))
    print("\n\n".join(out))
elif verb == "reset-failed":
    pass
elif verb == "stop":
    for name in rest:
        if name in s["stop_leaves"]:
            continue
        units[name] = dict(blank)
        # run-session.sh takes its body offline when its run unit stops.
        client = s["cascade"].get(name)
        if client and client not in s["stop_leaves"]:
            units[client] = dict(blank)
else:
    sys.exit(3)
p.write_text(json.dumps(s))
'''

SYSTEMD_RUN = r'''#!/usr/bin/env python3
import json, os, sys, uuid
from pathlib import Path
p = Path(os.environ["RUNCTL_TEST_STATE"])
s = json.loads(p.read_text())
a = sys.argv[1:]
s["calls"].append(["systemd-run"] + a)
env, unit, i = {}, None, 0
while i < len(a) and a[i].startswith("-"):
    if a[i] == "-p":
        i += 2
        continue
    if a[i].startswith("--setenv="):
        k, _, v = a[i][9:].partition("=")
        env[k] = v
    if a[i].startswith("--unit="):
        unit = a[i][7:]
    i += 1
if unit in s["fail_run"]:
    p.write_text(json.dumps(s))
    print("Failed to start transient service unit: boom", file=sys.stderr)
    sys.exit(1)
s["units"][unit] = {"state": "active", "invocation": uuid.uuid4().hex, "env": env, "argv": a[i:]}
p.write_text(json.dumps(s))
'''


class RunctlTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="runctl-test-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.root, self.base, self.state_dir, self.proc = root, root / "gary-client", root / "state", root / "proc"
        self.bin = root / "bin"
        for directory in [self.bin, self.base / "resident/gary", self.base / "resident/margo", self.base / "instances",
                          self.base / "sessions", self.base / "overseer", self.proc]:
            directory.mkdir(parents=True)
        for path, text in [(self.bin / "systemctl", SYSTEMCTL), (self.bin / "systemd-run", SYSTEMD_RUN)]:
            path.write_text(text)
            path.chmod(0o755)
        (self.base / "resident/gary/AGENTS.md").write_text("gary")
        (self.base / "resident/margo/AGENTS.md").write_text("margo")
        (self.base / "instances/Margo.env").write_text(f"GAME_DIR={self.base}/game-Margo\nSYNAPSE_URL=http://127.0.0.1:25610\n")
        (self.base / "sessions/Gary-health.json").write_text(json.dumps({"status": "stopped", "thread_id": THREAD}))
        (self.base / "run.conf").write_text('HOST=inspiron\nRESIDENTS="Gary Margo"\nDEFAULT_MODEL=gpt-6.2-sol\nCARETAKER=on\nCARETAKER_INTERVAL=25\n')
        self.stub = root / "units.json"
        self.put_state({})
        self.tools = TOOLS
        self.env = {**os.environ, "HOME": str(root), "GARY_CLIENT_HOME": str(self.base), "RESIDENTS_STATE_DIR": str(self.state_dir),
                    "RESIDENTS_PROC_DIR": str(self.proc), "RUNCTL_TEST_STATE": str(self.stub), "USER": "tester",
                    "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}
        for key in ["RESIDENTS_RUN_CONF", "XDG_STATE_HOME"]:
            self.env.pop(key, None)

    def put_state(self, units, **extra):
        cascade = {"gary-run.service": "gary-client@Gary.service", "margo-run.service": "gary-client@Margo.service"}
        self.stub.write_text(json.dumps({"units": units, "calls": [], "stop_leaves": [], "fail_run": [], "cascade": cascade, **extra}))

    def state(self):
        return json.loads(self.stub.read_text())

    def edit_state(self, **changes):
        data = self.state()
        data.update(changes)
        self.stub.write_text(json.dumps(data))

    def runs(self):
        return [call for call in self.state()["calls"] if call[0] == "systemd-run"]

    def clear_calls(self):
        self.edit_state(calls=[])

    def call(self, script, *args):
        result = subprocess.run([str(self.tools / script), *args, "--json"], env=self.env, capture_output=True, text=True, timeout=30)
        lines = result.stdout.strip().splitlines()
        return result.returncode, json.loads(lines[-1]) if lines else None, result.stderr

    def start(self, *args):
        return self.call("start-run.sh", *args)

    def stop(self, *args):
        return self.call("stop-run.sh", *args)

    def records(self):
        return sorted((self.state_dir / "activations").glob("*.json"))

    # ---------- start ----------

    def test_start_reproduces_the_old_launcher_for_this_host(self):
        end = int(time.time()) + 3600
        code, reply, err = self.start("Gary", "Margo", "--end-at", str(end), "--by", "switchyard")
        self.assertEqual(code, 0, err)
        gary, margo, caretaker = self.runs()

        def expect(call, unit, cpu, env, command):
            self.assertEqual(call[:7], ["systemd-run", "--user", "--collect", f"--unit={unit}", "--slice=residents.slice", "-p", f"CPUQuota={cpu}"])
            self.assertEqual(call[7], "-p")
            self.assertAlmostEqual(int(call[8].split("=")[1]), end - time.time() + 600, delta=5)
            self.assertEqual(call[9:9 + 2 + len(env)], ["--setenv=TZ=America/New_York", f"--setenv=SESSION_END_AT={end}", *env])
            self.assertEqual(call[11 + len(env):], command)

        expect(gary, "gary-run.service", "200%", [f"--setenv=RESUME_THREAD={THREAD}"],
               [f"{self.base}/run-session.sh", "Gary", "gary", "0", "gpt-6.2-sol"])
        expect(margo, "margo-run.service", "200%", [], [f"{self.base}/run-session.sh", "Margo", "margo", "0", "gpt-6.2-sol"])
        hhmm = datetime.fromtimestamp(end, ZoneInfo("America/New_York")).strftime("%H:%M")
        expect(caretaker, "overseer-run.service", "100%", [],
               [f"{self.base}/overseer/overseer-loop.sh", hhmm, "25", "Gary:gary", "Margo:margo"])
        self.assertEqual([(r["name"], r["result"], r["mode"], r.get("thread_id")) for r in reply["residents"]],
                         [("Gary", "started", "resume", THREAD), ("Margo", "started", "fresh", None)])
        self.assertEqual(reply["caretaker"]["result"], "started")
        [record] = self.records()
        self.assertEqual(stat.S_IMODE(record.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(record.parent.stat().st_mode), 0o700)
        saved = json.loads(record.read_text())
        self.assertEqual((saved["kind"], saved["end_at"], saved["requested_by"], saved["host"]), ("start", end, "switchyard", "inspiron"))
        self.assertTrue(all(r["invocation_id"] for r in saved["residents"]))
        self.assertNotIn("token", record.read_text().lower())

    def test_fresh_model_and_persona_come_from_arguments_and_instance_file(self):
        (self.base / "instances/Margo.env").write_text("PERSONA=margo2\n")
        (self.base / "resident/margo2").mkdir()
        (self.base / "resident/margo2/AGENTS.md").write_text("m2")
        code, reply, err = self.start("Gary", "Margo", "--end-at", str(int(time.time()) + 600), "--fresh", "gary",
                                      "--model", "Margo=gpt-6.1-sol", "--caretaker", "off")
        self.assertEqual(code, 0, err)
        gary, margo = self.runs()
        self.assertFalse(any(arg.startswith("--setenv=RESUME_THREAD") for arg in gary))
        self.assertEqual(gary[-5:], [f"{self.base}/run-session.sh", "Gary", "gary", "0", "gpt-6.2-sol"])
        self.assertEqual(margo[-4:], ["Margo", "margo2", "0", "gpt-6.1-sol"])
        self.assertEqual(reply["caretaker"]["result"], "off")

    def test_end_time_refusals_start_nothing(self):
        now = int(time.time())
        cases = [
            (["--end-at", str(now - 5)], 3, "in the past"),
            (["--end-at", str(now + 25 * 3600)], 3, "more than 24 h away"),
            (["--end", "2026-11-01 01:30"], 3, "happens twice"),
            (["--end", "2027-03-14 02:30"], 3, "does not exist"),
            (["--end", "tomorrow 1am"], 2, "YYYY-MM-DD HH:MM"),
            (["--end", "2026-11-24 01:00", "--end-at", str(now + 60)], 2, "exactly one"),
            ([], 2, "exactly one"),
        ]
        for extra, status, words in cases:
            with self.subTest(extra=extra):
                code, reply, err = self.start("Gary", *extra)
                self.assertEqual(code, status, err)
                self.assertIn(words, reply["error"])
        self.assertEqual(self.runs(), [])
        self.assertEqual(self.records(), [])

    def test_wall_clock_end_is_new_york_time(self):
        target = time.time() + 3 * 3600
        wall = subprocess.run(["date", "-d", f"@{int(target)}", "+%Y-%m-%d %H:%M"], env={**self.env, "TZ": "America/New_York"},
                              capture_output=True, text=True).stdout.strip()
        code, reply, err = self.start("Gary", "--end", wall, "--caretaker", "off")
        self.assertEqual(code, 0, err)
        self.assertAlmostEqual(reply["end_at"], target, delta=60)
        self.assertEqual(reply["end_local"][:16], wall)

    def test_argument_and_configuration_refusals(self):
        end = str(int(time.time()) + 600)
        cases = [
            ([], 2, "name the residents"),
            (["Gary", "--all"], 2, "not both"),
            (["Gary", "--bogus"], 2, "unrecognized"),
            (["Gary", "--model", "gpt 6; rm -rf"], 2, "invalid model"),
            (["Gary", "--model", "Margo=gpt-x"], 2, "not being started"),
            (["Gary", "--fresh", "Wren"], 2, "not being started"),
            (["Gary", "--caretaker-interval", "0"], 2, "interval"),
            (["Gary", "--note", "two\nlines"], 2, "one line"),
            (["Gary", "--by", "x" * 200], 2, "short label"),
            (["Wren"], 5, "not a resident of host inspiron"),
            (["../etc"], 2, "invalid resident name"),
        ]
        for extra, status, words in cases:
            with self.subTest(extra=extra):
                code, reply, err = self.start(*extra, "--end-at", end)
                self.assertEqual(code, status, err)
                self.assertIn(words, reply["error"])
        (self.base / "resident/margo/AGENTS.md").unlink()
        code, reply, _ = self.start("Margo", "--end-at", end)
        self.assertEqual((code, reply["code"]), (5, "config"))
        self.assertIn("has no AGENTS.md", reply["error"])
        (self.base / "run.conf").unlink()
        code, reply, _ = self.start("Gary", "--end-at", end)
        self.assertEqual(code, 5)
        self.assertIn("no run configuration", reply["error"])
        self.assertEqual(self.runs(), [])

    def test_same_deadline_is_a_no_op_and_another_deadline_is_refused(self):
        end = int(time.time()) + 3600
        self.assertEqual(self.start("--all", "--end-at", str(end))[0], 0)
        self.clear_calls()
        code, reply, err = self.start("--all", "--end-at", str(end))
        self.assertEqual(code, 0, err)
        self.assertEqual([r["result"] for r in reply["residents"]], ["already_running", "already_running"])
        self.assertEqual(reply["residents"][0]["thread_id"], THREAD)
        self.assertEqual((reply["caretaker"]["result"], reply["changed"], reply["id"]), ("already_running", False, None))
        self.assertEqual(self.runs(), [])
        self.assertEqual(len(self.records()), 1)
        code, reply, _ = self.start("Gary", "--end-at", str(end + 600))
        self.assertEqual((code, reply["code"]), (4, "conflict"))
        self.assertIn("Gary is already running until", reply["error"])
        self.assertEqual(self.runs(), [])

    def test_one_end_time_per_host_and_for_the_caretaker(self):
        end = int(time.time()) + 3600
        self.assertEqual(self.start("Gary", "--end-at", str(end))[0], 0)
        code, reply, _ = self.start("Margo", "--end-at", str(end + 60))
        self.assertEqual(code, 4)
        self.assertIn("every run on inspiron shares one end time", reply["error"])
        self.assertIn("caretaker overseer-run.service is running until", reply["error"])
        self.assertFalse(any("--unit=margo-run.service" in call for call in self.runs()))

    def test_a_body_without_its_run_or_a_stray_client_is_refused(self):
        end = str(int(time.time()) + 600)
        self.put_state({"gary-client@Gary.service": {"state": "active", "invocation": "1", "env": {}, "argv": []}})
        code, reply, _ = self.start("Gary", "--end-at", end)
        self.assertEqual(code, 4)
        self.assertIn("body (gary-client@Gary.service) is active without a run", reply["error"])
        self.put_state({})
        (self.proc / "4242").mkdir()
        (self.proc / "4242/cmdline").write_bytes(b"java\0--mc-dir\0" + f"{self.base}/game-Margo".encode() + b"\0")
        (self.proc / "4243").mkdir()  # a longer dir that merely starts with game-Margo is someone else's
        (self.proc / "4243/cmdline").write_bytes(b"java\0--mc-dir\0" + f"{self.base}/game-Margo2".encode() + b"\0")
        code, reply, _ = self.start("Margo", "--end-at", end)
        self.assertEqual(code, 4)
        self.assertIn("running outside its unit (pid 4242)", reply["error"])
        self.assertEqual(self.runs(), [])

    def java_body(self, pid, game_dir, inline=False):
        """The Java game process alone (its portablemc wrapper gone): only --gameDir names the dir."""
        directory = self.proc / str(pid)
        directory.mkdir()
        dir_args = [f"--gameDir={game_dir}".encode()] if inline else [b"--gameDir", game_dir.encode()]
        directory.joinpath("cmdline").write_bytes(b"\0".join([b"/home/x/gary-client/jdk17/bin/java", b"-Xmx4G", b"-cp", b"libs.jar",
            b"cpw.mods.bootstraplauncher.BootstrapLauncher", b"--username", b"Gary", b"--version", b"forge-47.4.10", *dir_args,
            b"--assetsDir", b"/home/x/gary-client/main/assets", b""]))

    def test_an_orphaned_java_body_blocks_a_start_and_fails_a_stop(self):
        end = str(int(time.time()) + 600)
        self.java_body(5150, f"{self.base}/game")
        self.java_body(5151, f"{self.base}/game-Margo2")   # another directory that merely shares a prefix
        code, reply, _ = self.start("Gary", "Margo", "--end-at", end)
        self.assertEqual(code, 4)
        self.assertEqual(reply["conflicts"], ["a client for Gary is running outside its unit (pid 5150); stop it first"])
        self.assertEqual(self.runs(), [])
        code, reply, _ = self.stop("--all")
        self.assertEqual((code, reply["code"]), (7, "still_active"))
        self.assertEqual([(r["name"], r["result"], r.get("client_pids")) for r in reply["residents"]],
                         [("Gary", "still_active", [5150]), ("Margo", "not_running", None)])
        # The --gameDir=<dir> spelling and a trailing slash name the same directory.
        shutil.rmtree(self.proc / "5150")
        self.java_body(5152, f"{self.base}/game-Margo/", inline=True)
        code, reply, _ = self.start("Margo", "--end-at", end)
        self.assertEqual(code, 4)
        self.assertIn("pid 5152", reply["error"])

    def test_a_running_resident_is_not_restarted_with_another_model_or_thread_mode(self):
        end = str(int(time.time()) + 600)
        self.assertEqual(self.start("Gary", "--end-at", end, "--caretaker", "off")[0], 0)
        code, reply, _ = self.start("Gary", "--end-at", end, "--model", "gpt-6.1-sol")
        self.assertEqual(code, 4)
        self.assertIn("already running with model gpt-6.2-sol", reply["error"])
        code, reply, _ = self.start("Gary", "--end-at", end, "--fresh", "Gary")
        self.assertEqual(code, 4)
        self.assertIn("resumed thread", reply["error"])

    def test_resuming_after_a_persona_change_is_refused(self):
        end = str(int(time.time()) + 600)
        self.assertEqual(self.start("Gary", "--end-at", end, "--caretaker", "off")[0], 0)
        self.assertEqual(self.stop("Gary")[0], 0)
        (self.base / "instances/Gary.env").write_text("PERSONA=gary2\n")
        (self.base / "resident/gary2").mkdir()
        (self.base / "resident/gary2/AGENTS.md").write_text("g2")
        code, reply, _ = self.start("Gary", "--end-at", end, "--caretaker", "off")
        self.assertEqual(code, 4)
        self.assertIn("persona changed from gary to gary2", reply["error"])
        self.assertEqual(self.start("Gary", "--end-at", end, "--caretaker", "off", "--fresh", "Gary")[0], 0)

    def test_a_later_subset_joins_the_caretaker_roster(self):
        end = str(int(time.time()) + 600)
        self.assertEqual(self.start("Gary", "--end-at", end)[0], 0)
        self.assertEqual(self.state()["units"]["overseer-run.service"]["argv"][-1:], ["Gary:gary"])
        self.clear_calls()
        code, reply, err = self.start("Margo", "--end-at", end)
        self.assertEqual(code, 0, err)
        self.assertEqual(reply["caretaker"]["result"], "restarted")
        self.assertIn(["systemctl", "--user", "stop", "overseer-run.service"], self.state()["calls"])
        self.assertEqual(self.state()["units"]["overseer-run.service"]["argv"][-2:], ["Gary:gary", "Margo:margo"])

    def test_speak_mode_sets_the_overseer_flag(self):
        end = str(int(time.time()) + 600)
        flag = self.base / "overseer/speak"
        self.assertEqual(self.start("Gary", "--end-at", end, "--caretaker-speak", "on")[0], 0)
        self.assertTrue(flag.exists())
        self.assertEqual(self.stop("--all")[0], 0)
        self.assertEqual(self.start("Gary", "--end-at", end, "--caretaker-speak", "off")[0], 0)
        self.assertFalse(flag.exists())

    def test_busy_lock_is_exit_75(self):
        self.state_dir.mkdir()
        with open(self.state_dir / "control.lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            code, reply, _ = self.start("Gary", "--end-at", str(int(time.time()) + 600))
            self.assertEqual(code, 75)
            self.assertIn("another start or stop is in progress", reply["error"])
            self.assertEqual(self.stop("Gary")[0], 75)
        self.assertEqual(self.runs(), [])

    def test_start_gate_refusal_is_exit_77_and_starts_nothing(self):
        copy = self.root / "tools"
        shutil.copytree(TOOLS, copy, ignore=shutil.ignore_patterns("__pycache__", "test_*"))
        script = copy / "start-run.sh"
        text = script.read_text()
        self.assertEqual(text.count("start_gate() { # <component>...\n  return 0\n}"), 1)
        script.write_text(text.replace("start_gate() { # <component>...\n  return 0\n}",
                                       'start_gate() {\n  echo "$*" > "$GATE_SEEN"; echo "token revoked" >&2; return 77\n}'))
        self.tools, self.env["GATE_SEEN"] = copy, str(self.root / "gate-seen")
        code, reply, _ = self.start("--all", "--end-at", str(int(time.time()) + 600))
        self.assertEqual((code, reply["code"]), (77, "gate"))
        self.assertIn("token revoked", reply["error"])
        self.assertEqual((self.root / "gate-seen").read_text().split(), ["resident-gary", "resident-margo", "caretaker-inspiron"])
        self.assertEqual(self.runs(), [])
        self.assertEqual(self.records(), [])

    def test_systemd_failure_is_reported_per_resident(self):
        self.edit_state(fail_run=["margo-run.service"])
        code, reply, _ = self.start("--all", "--end-at", str(int(time.time()) + 600))
        self.assertEqual((code, reply["code"], reply["ok"]), (6, "systemd", False))
        self.assertEqual([(r["name"], r["result"]) for r in reply["residents"]], [("Gary", "started"), ("Margo", "failed")])
        self.assertIn("boom", reply["residents"][1]["error"])
        self.assertEqual(self.state()["units"]["overseer-run.service"]["argv"][-1:], ["Gary:gary"])

    def test_dry_run_uses_the_stand_in_and_is_recorded(self):
        end = str(int(time.time()) + 180)
        code, reply, err = self.start("Gary", "--end-at", end, "--dry-run-body")
        self.assertEqual(code, 0, err)
        gary, caretaker = self.runs()
        self.assertEqual(gary[-5], str(TOOLS / "dry-run-session.sh"))
        self.assertIn("--setenv=RESIDENTS_DRY_RUN_BODY=gary-client@Gary.service", gary)
        self.assertEqual(caretaker[-4], str(TOOLS / "dry-run-session.sh"))
        self.assertTrue(reply["dry_run"])
        status = self.call("run-status.sh")[1]
        self.assertTrue(status["residents"][0]["dry_run"])

    # ---------- stop ----------

    def test_stopping_one_resident_keeps_the_caretaker_for_the_others(self):
        end = int(time.time()) + 600
        self.assertEqual(self.start("--all", "--end-at", str(end))[0], 0)
        self.clear_calls()
        code, reply, err = self.stop("Margo", "--by", "owner_dashboard")
        self.assertEqual(code, 0, err)
        self.assertEqual(reply["residents"], [{"name": "Margo", "unit": "margo-run.service", "client_unit": "gary-client@Margo.service", "result": "stopped"}])
        self.assertEqual(reply["caretaker"]["result"], "restarted")
        units = self.state()["units"]
        self.assertEqual(units["overseer-run.service"]["argv"][-1:], ["Gary:gary"])
        self.assertEqual(units["overseer-run.service"]["env"]["SESSION_END_AT"], str(end))
        self.assertEqual(units["gary-run.service"]["state"], "active")
        self.assertEqual(json.loads(self.records()[-1].read_text())["requested_by"], "owner_dashboard")

    def test_stop_all_stops_runs_first_then_the_caretaker_and_verifies(self):
        self.assertEqual(self.start("--all", "--end-at", str(int(time.time()) + 600))[0], 0)
        self.clear_calls()
        code, reply, err = self.stop("--all")
        self.assertEqual(code, 0, err)
        stops = [call[3:] for call in self.state()["calls"] if call[2] == "stop"]
        self.assertEqual(stops, [["gary-run.service", "margo-run.service"], ["overseer-run.service"]])
        self.assertEqual([r["result"] for r in reply["residents"]], ["stopped", "stopped"])
        self.assertEqual(reply["caretaker"]["result"], "stopped")
        self.assertTrue(all(u["state"] == "inactive" for u in self.state()["units"].values()))

    def test_a_body_or_client_left_behind_fails_the_stop(self):
        self.assertEqual(self.start("Gary", "--end-at", str(int(time.time()) + 600))[0], 0)
        self.edit_state(stop_leaves=["gary-client@Gary.service"])
        units = self.state()["units"]
        units["gary-client@Gary.service"] = {"state": "active", "invocation": "9", "env": {}, "argv": []}
        self.edit_state(units=units)
        code, reply, _ = self.stop("Gary")
        self.assertEqual((code, reply["code"]), (7, "still_active"))
        self.assertIn("gary-client@Gary.service", reply["error"])
        self.edit_state(stop_leaves=[])
        (self.proc / "77").mkdir()
        (self.proc / "77/cmdline").write_bytes(b"java\0--mc-dir\0" + f"{self.base}/game".encode() + b"\0")
        code, reply, _ = self.stop("Gary")
        self.assertEqual(code, 7)
        self.assertEqual(reply["residents"][0]["client_pids"], [77])

    def test_stopping_what_is_not_running_is_a_quiet_success(self):
        code, reply, err = self.stop("--all")
        self.assertEqual(code, 0, err)
        self.assertEqual([r["result"] for r in reply["residents"]], ["not_running", "not_running"])
        self.assertIsNone(reply["id"])
        self.assertEqual(self.records(), [])
        self.assertEqual(self.stop("Wren")[0], 5)

    # ---------- status ----------

    def test_status_reports_the_run_and_who_started_it(self):
        end = int(time.time()) + 600
        self.assertEqual(self.start("Gary", "--end-at", str(end), "--by", "switchyard")[0], 0)
        code, status, err = self.call("run-status.sh")
        self.assertEqual(code, 0, err)
        gary, margo = status["residents"]
        self.assertEqual({k: gary[k] for k in ("running", "end_at", "model", "mode", "thread_id", "started_by")},
                         {"running": True, "end_at": end, "model": "gpt-6.2-sol", "mode": "resume", "thread_id": THREAD, "started_by": "switchyard"})
        self.assertFalse(margo["running"])
        self.assertEqual((status["end_at"], status["caretaker"]["roster"], status["caretaker"]["interval"]), (end, ["Gary:gary"], 25))
        self.assertEqual(status["recent"][-1]["requested_by"], "switchyard")
        # A run started by hand (no record) is still reported, as such.
        units = self.state()["units"]
        units["margo-run.service"] = {"state": "active", "invocation": "abc", "env": {"SESSION_END_AT": str(end)},
                                      "argv": [f"{self.base}/run-session.sh", "Margo", "margo", "0", "gpt-6.2-sol"]}
        self.edit_state(units=units)
        margo = self.call("run-status.sh")[1]["residents"][1]
        self.assertEqual((margo["running"], margo["started_by"], margo["mode"]), (True, "outside the launcher", "fresh"))


if __name__ == "__main__":
    unittest.main()
