"""Launcher audio ownership/lifecycle checks; all Pulse/client commands are stubs."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

LAUNCH = Path(__file__).resolve().parents[1] / "launch.sh"
PULSE = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ["AUDIO_TEST_STATE"])
s=json.loads(p.read_text())
a=sys.argv[1:]
s["calls"].append(a)
if a == ["get-default-sink"]: print(s["default"])
elif a == ["list","short","sinks"]:
    print("1\tspeakers\tmodule-hardware\tfloat32le 2ch 48000Hz\tIDLE")
    if s["loaded"] or s["collision"]: print("2\tresident_Gary\tmodule-null-sink\tfloat32le 2ch 48000Hz\tIDLE")
elif a[:2] == ["load-module","module-null-sink"]:
    s["loaded"]=True
    s["argument"]=" ".join(a[2:])
    if s["switch_default"]: s["default"]="resident_Gary"
    print(7)
elif a == ["list","short","modules"]:
    if s["loaded"]: print("7\tmodule-null-sink\t"+s.get("argument","")+"\t")
elif a == ["--format=json","list","sinks"]:
    print(json.dumps([{"name":"resident_Gary","index":2,"owner_module":8 if s["wrong_owner"] else 7,
        "monitor_source":"resident_Gary.monitor","properties":{"device.class":"abstract"}}]))
elif a[:1] == ["set-default-sink"]: s["default"]=a[1]
elif a == ["--format=json","list","sink-inputs"]:
    # The game's own stream starts on the speakers (sink 1); another process's stream must stay there.
    client=Path(os.environ["AUDIO_TEST_CLIENT"])
    game=json.loads(client.read_text())["pid"] if client.exists() else None
    streams=[{"index":42,"sink":1,"properties":{"application.process.id":"1"}}]
    if game: streams.append({"index":41,"sink":2 if 41 in s.get("moved",[]) else 1,"properties":{"application.process.id":str(game)}})
    print(json.dumps(streams))
elif a[:1] == ["move-sink-input"]:
    s.setdefault("moved",[]).append(int(a[1]))
    s.setdefault("moved_to",[]).append(a[2])
elif a == ["unload-module","7"]: s["loaded"]=False
else: sys.exit(2)
p.write_text(json.dumps(s))
'''
CLIENT = r'''#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
Path(os.environ["AUDIO_TEST_CLIENT"]).write_text(json.dumps({"sink":os.environ.get("PULSE_SINK"),"driver":os.environ.get("ALSOFT_DRIVERS"),"args":sys.argv[1:],"pid":os.getpid()}))
if os.environ.get("AUDIO_TEST_WAIT"): time.sleep(60)
sys.exit(int(os.environ.get("AUDIO_TEST_EXIT","0")))
'''


class ClientAudioTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="resident-audio-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.state = self.home / "pulse.json"
        self.client = self.home / "client.json"
        (self.home / "venv/bin").mkdir(parents=True)
        (self.home / "bin").mkdir()
        for path, content in [(self.home / "bin/pactl", PULSE), (self.home / "venv/bin/portablemc", CLIENT)]:
            path.write_text(content)
            path.chmod(0o755)
        self.data = {"loaded": False, "collision": False, "wrong_owner": False, "switch_default": False, "default": "speakers", "calls": []}
        self.state.write_text(json.dumps(self.data))
        self.env = {**os.environ, "GARY_CLIENT_HOME": str(self.home), "GAME_DIR": str(self.home / "game"),
                    "GARY_CLIENT_AUDIO_SINK": "resident_Gary", "GARY_CLIENT_DISPLAY_BACKEND": "x11",
                    "AUDIO_TEST_STATE": str(self.state), "AUDIO_TEST_CLIENT": str(self.client),
                    "PATH": str(self.home / "bin") + os.pathsep + os.environ["PATH"]}
        for key in ["GARY_CLIENT_PROFILE", "PULSE_SINK", "ALSOFT_DRIVERS", "AUDIO_TEST_WAIT", "AUDIO_TEST_EXIT"]:
            self.env.pop(key, None)

    def run_launch(self):
        return subprocess.run(["bash", str(LAUNCH), "Gary"], env=self.env, capture_output=True, text=True, timeout=10)

    def test_owned_sink_routes_only_child_and_is_removed(self):
        result = self.run_launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.client.read_text())["sink"], "resident_Gary")
        self.assertEqual(json.loads(self.client.read_text())["driver"], "pulse")
        state = json.loads(self.state.read_text())
        self.assertFalse(state["loaded"])
        self.assertEqual(state["default"], "speakers")
        self.assertFalse(any(call[0] == "set-default-sink" for call in state["calls"]))
        self.assertEqual(state["calls"][-1], ["unload-module", "7"])

    def test_client_failure_still_unloads_and_preserves_exit_status(self):
        self.env["AUDIO_TEST_EXIT"] = "23"
        self.assertEqual(self.run_launch().returncode, 23)
        self.assertFalse(json.loads(self.state.read_text())["loaded"])

    def test_collision_is_not_reused_or_unloaded(self):
        self.data["collision"] = True
        self.state.write_text(json.dumps(self.data))
        result = self.run_launch()
        self.assertEqual(result.returncode, 2)
        self.assertIn("reuse is refused", result.stderr)
        self.assertFalse(self.client.exists())
        self.assertFalse(any(call[0] in ["load-module", "unload-module"] for call in json.loads(self.state.read_text())["calls"]))

    def test_wrong_sink_and_policy_default_switch_fail_closed(self):
        for key in ["wrong_owner", "switch_default"]:
            with self.subTest(key=key):
                self.state.write_text(json.dumps({**self.data, key: True}))
                result = self.run_launch()
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.client.exists())
                state = json.loads(self.state.read_text())
                self.assertFalse(state["loaded"])
                self.assertEqual(state["default"], "speakers")

    def test_audio_off_keeps_original_exec_arguments_without_pulse_calls(self):
        self.env.pop("GARY_CLIENT_AUDIO_SINK")
        result = self.run_launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(self.state.read_text())
        self.assertEqual(state["calls"], [])
        client = json.loads(self.client.read_text())
        self.assertIsNone(client["sink"])
        self.assertIsNone(client["driver"])
        self.assertIn("forge::1.20.1-47.4.10", client["args"])
        self.assertIn("--jvm-arg=-Xmx4G", client["args"])

    def test_term_stops_owned_child_and_unloads_sink(self):
        self.env["AUDIO_TEST_WAIT"] = "1"
        process = subprocess.Popen(["bash", str(LAUNCH), "Gary"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not self.client.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(self.client.exists(), "stub client did not start")
            process.send_signal(signal.SIGTERM)
            _, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, error)
            self.assertFalse(json.loads(self.state.read_text())["loaded"])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)

    def test_game_stream_is_moved_to_its_sink_and_other_streams_are_left_alone(self):
        self.env["AUDIO_TEST_WAIT"] = "1"
        process = subprocess.Popen(["bash", str(LAUNCH), "Gary"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 8
            moved = []
            while process.poll() is None and time.monotonic() < deadline and not moved:
                time.sleep(0.1)
                try:
                    moved = json.loads(self.state.read_text()).get("moved", [])
                except ValueError:
                    pass  # the stub was mid-write
            self.assertEqual(moved, [41], "the game's stream was not moved off the speakers")
            time.sleep(1.2)  # two more router passes: no repeat move, and stream 42 stays put
            process.send_signal(signal.SIGTERM)
            _, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, error)
            state = json.loads(self.state.read_text())
            self.assertEqual(state["moved"], [41])
            self.assertEqual(state["moved_to"], ["resident_Gary"])
            self.assertFalse(state["loaded"])
            self.assertEqual(state["calls"][-1], ["unload-module", "7"])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)


if __name__ == "__main__":
    unittest.main()
