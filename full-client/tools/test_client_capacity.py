"""Capacity sampler, summaries, experiment guards; fake /proc, cgroup and
systemctl only. No clients, devices or network.

Run: python3 -m unittest discover -s full-client/tools -p 'test_client_*.py' -v
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("client_capacity", TOOLS / "client-capacity.py")
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

PSI = "some avg10=1.50 avg60=0.80 avg300=0.20 total=1000000\nfull avg10=0.40 avg60=0.10 avg300=0.00 total=200000\n"
NVIDIA = """<?xml version="1.0" ?>
<nvidia_smi_log><gpu id="00000000:01:00.0"><product_name>NVIDIA GeForce GTX 1060 with Max-Q Design</product_name>
<fb_memory_usage><total>6144 MiB</total><used>1500 MiB</used></fb_memory_usage>
<utilization><gpu_util>37 %</gpu_util><memory_util>12 %</memory_util></utilization>
<temperature><gpu_temp>61 C</gpu_temp></temperature>
<gpu_power_readings><power_draw>N/A</power_draw></gpu_power_readings>
<processes>
<process_info><pid>101</pid><type>G</type><process_name>java</process_name><used_memory>420 MiB</used_memory></process_info>
<process_info><pid>999</pid><type>G</type><process_name>Xorg</process_name><used_memory>N/A</used_memory></process_info>
</processes></gpu></nvidia_smi_log>"""
SS = ("ESTAB 0 0 192.168.1.69:40000 192.168.1.233:25570 users:((\"java\",pid=101,fd=88))\n"
      "\t cubic wscale:7,7 rto:204 bytes_sent:5000 bytes_acked:5001 bytes_received:900000 segs_out:10\n")


def done(stdout="", code=0, stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class Parsers(unittest.TestCase):
    def test_psi_smaps_and_stat(self):
        self.assertEqual(cc.parse_psi(PSI)["full"], {"avg10": 0.4, "avg60": 0.1, "avg300": 0.0, "total": 200000})
        smaps = cc.parse_smaps_rollup("Rss:  2048 kB\nPss:  1500 kB\nPss_Anon:  1400 kB\nSwap:  10 kB\n")
        self.assertEqual(smaps, {"rss_kb": 2048, "pss_kb": 1500, "pss_anon_kb": 1400, "swap_kb": 10})
        stat = "101 (Render thread) S 1 1 1 0 -1 4194304 1 0 0 0 250 50 0 0 20 0 70 0 1 1 1"
        self.assertEqual(cc.parse_proc_stat(stat), ("Render thread", 300))

    def test_nvidia_processes_and_unreported_values(self):
        parsed = cc.parse_nvidia_xml(NVIDIA)
        self.assertEqual(parsed["gpus"][0]["memory_used_mib"], 1500)
        self.assertIsNone(parsed["gpus"][0]["power_w"])
        self.assertEqual(parsed["processes"], {101: 420.0, 999: None})

    def test_ss_two_line_counters(self):
        self.assertEqual(cc.parse_ss(SS), {101: {"bytes_sent": 5000, "bytes_received": 900000}})

    def test_png_size_and_loopback_only(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + (854).to_bytes(4, "big") + (480).to_bytes(4, "big")
        self.assertEqual(cc.png_size(png), (854, 480))
        self.assertIsNone(cc.png_size(b"GIF89a" + b"\0" * 30))
        self.assertEqual(cc.loopback_port("http://127.0.0.1:25631"), 25631)
        for url in ("http://192.168.1.69:25631", "https://127.0.0.1:25631", "http://127.0.0.1"):
            with self.assertRaises(cc.PlanError):
                cc.loopback_port(url)


class CollectorSample(unittest.TestCase):
    def test_per_unit_cgroup_processes_gpu_and_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc, cg = root / "proc", root / "cg"
            unit_cg = cg / "user.slice" / "residents.slice" / "gary-client@slim_a.service"
            (unit_cg / "child").mkdir(parents=True)
            (unit_cg / "cgroup.procs").write_text("100\n")
            (unit_cg / "child" / "cgroup.procs").write_text("101\n")
            (unit_cg / "memory.current").write_text(str(5 * 1024 ** 3))
            (unit_cg / "memory.peak").write_text(str(6 * 1024 ** 3))
            (unit_cg / "memory.stat").write_text("anon 4000000000\nfile 500000000\n")
            (unit_cg / "cpu.stat").write_text("usage_usec 123456789\n")
            (unit_cg / "memory.pressure").write_text(PSI)
            for pid, comm, pss in ((100, "portablemc", 30000), (101, "java", 4_000_000)):
                (proc / str(pid)).mkdir(parents=True)
                (proc / str(pid) / "stat").write_text(f"{pid} ({comm}) S 1 1 1 0 -1 0 0 0 0 0 100 100 0 0")
                (proc / str(pid) / "smaps_rollup").write_text(f"Rss: {pss + 1000} kB\nPss: {pss} kB\n")
            (proc / "meminfo").write_text("MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
            (proc / "vmstat").write_text("pswpout 5\npgmajfault 77\n")
            (proc / "loadavg").write_text("1.00 0.50 0.25 2/300 1234\n")
            (proc / "pressure").mkdir()
            (proc / "pressure" / "memory").write_text(PSI)

            def run(argv, **_kw):
                if argv[:3] == ["systemctl", "--user", "show"]:
                    return done(f"ControlGroup=/user.slice/residents.slice/{argv[-1]}\nActiveState=active\n")
                if argv[0] == "nvidia-smi":
                    return done(NVIDIA)
                if argv[0] == "ss":
                    return done(SS)
                raise AssertionError(argv)

            collector = cc.Collector([{"name": "slim_a", "unit": "gary-client@slim_a.service", "url": None}],
                                     proc=proc, cgroup_root=cg, run=run)
            record = collector.sample("measure")
        client = record["clients"]["slim_a"]
        self.assertTrue(client["active"])
        self.assertEqual(sorted(p["pid"] for p in client["processes"]), [100, 101])
        java = next(p for p in client["processes"] if p["pid"] == 101)
        self.assertEqual((java["pss_kb"], java["gpu_mib"]), (4_000_000, 420.0))
        self.assertEqual(client["cgroup"]["memory_peak"], 6 * 1024 ** 3)
        self.assertEqual(client["net"]["bytes_received"], 900000)
        self.assertNotIn("probe", client)  # no URL, no probe
        self.assertEqual(record["host"]["meminfo_kb"]["MemAvailable"], 9000000)


def rec(t, phase, avail_kb=8_000_000, usage=0, pss_kb=4_000_000, psi_total=0, active=True, probe=None):
    client = {"unit": "gary-client@a.service", "active": active}
    if active:
        client.update({"cgroup": {"path": "/cg/a", "memory_current": 5 * 1024 ** 3, "memory_peak": 6 * 1024 ** 3,
                                  "memory_stat": {"anon": 4 * 1024 ** 3}, "cpu_usage_usec": usage},
                       "processes": [{"pid": 1, "comm": "java", "pss_kb": pss_kb, "rss_kb": pss_kb + 100}]})
        if probe:
            client["probe"] = probe
    return {"t": t, "phase": phase, "gpu": {"unavailable": "nvidia-smi not found"},
            "host": {"meminfo_kb": {"MemAvailable": avail_kb, "SwapTotal": 0, "SwapFree": 0}, "vmstat": {"pswpout": t},
                     "loadavg": [1.0, 1.0, 1.0],
                     "pressure": {"memory": {"some": {"avg10": 2.0, "total": psi_total},
                                             "full": {"avg10": 0.5, "total": 0}}}},
            "clients": {"a": client}}


class Summaries(unittest.TestCase):
    def test_cpu_pressure_and_memory_from_cumulative_counters(self):
        samples = [rec(0, "startup", usage=0), rec(10, "measure", usage=1_000_000, psi_total=0),
                   rec(20, "measure", usage=6_000_000, pss_kb=5_000_000, psi_total=1_000_000,
                       probe={"state": "healthy", "state_ms": 40, "picture_status": 200, "picture_ms": 300,
                              "picture_size": [854, 480]})]
        summary = cc.summarize(samples)
        client = summary["clients"]["a"]
        self.assertEqual(summary["samples"], 2)
        self.assertEqual(client["cpu_pct_of_one_core"]["mean"], 50.0)  # 5 s CPU in 10 s
        self.assertEqual(client["pss_mib"]["max"], round(5_000_000 / 1024))
        self.assertEqual(client["cgroup_peak_mib_last"], 6144)
        self.assertEqual(client["gpu_mib"], "not reported per process")
        self.assertEqual(client["probe"]["pictures"]["sizes"], ["854x480"])
        self.assertEqual(summary["host"]["psi_memory_some"]["stalled_pct"], 10.0)  # 1 s stalled in 10 s
        self.assertEqual(summary["host"]["pswpout_delta"], 10)
        self.assertIn("| client pss_mib", cc.compare([{"label": "x", "outcome": "completed", "measure": summary}]))


class Plans(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        (self.base / "instances").mkdir()
        (self.base / "resident" / "gary").mkdir(parents=True)
        (self.base / "resident" / "gary" / "AGENTS.md").write_text("x")
        (self.base / "resident" / "wren").mkdir()
        (self.base / "resident" / "wren" / "AGENTS.md").write_text("x")
        (self.base / "instances" / "Margo.env").write_text(f"GAME_DIR={self.base}/game-Margo\nSYNAPSE_URL=http://127.0.0.1:25610\n")

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, name, game, port, marker_port=None, profile="visual"):
        game_dir = self.base / game
        game_dir.mkdir(exist_ok=True)
        if marker_port is not False:
            (game_dir / ".client-profile.json").write_text(json.dumps(
                {"profile": profile, "synapse_port": marker_port or port, "excluded": [{"jar": "oculus.jar"}],
                 "options": {}, "render_distance": None}))
        (self.base / "instances" / f"{name}.env").write_text(
            f"GAME_DIR={game_dir}\nSYNAPSE_URL=http://127.0.0.1:{port}\nGARY_CLIENT_HEAP=3G\n")

    def test_accepts_disposable_derived_clients(self):
        self.client("slim_a", "game-slim-a", 25631)
        self.client("slim_b", "game-slim-b", 25632, profile="baseline")
        plan = cc.build_plan(["slim_a", "slim_b"], self.base)
        self.assertEqual([c["unit"] for c in plan], ["gary-client@slim_a.service", "gary-client@slim_b.service"])
        self.assertEqual(plan[0]["heap"], "3G")
        self.assertEqual(plan[1]["profile"], "baseline")

    def test_refuses_resident_identities_directories_and_ports(self):
        self.client("slim_a", "game", 25631)            # Gary's game directory
        self.client("slim_b", "game-slim-b", 25610)     # Margo's port
        self.client("slim_c", "game-plain", 25633, marker_port=False)
        with self.assertRaises(cc.PlanError) as caught:
            cc.build_plan(["slim_a", "slim_b", "slim_c"], self.base)
        message = str(caught.exception)
        self.assertIn("slim_a: ", message)
        self.assertIn("resident game directory", message)
        self.assertIn("port 25610 belongs to a resident", message)
        self.assertIn("not made by client-profile.py derive", message)
        for name in ("Gary", "margo", "Wren"):
            with self.assertRaisesRegex(cc.PlanError, "resident identity"):
                cc.build_plan([name], self.base)
        with self.assertRaisesRegex(cc.PlanError, "1 to 3"):
            cc.build_plan(["a1a", "b1b", "c1c", "d1d"], self.base)

    def test_refuses_shared_ports_and_marker_mismatch(self):
        self.client("slim_a", "game-slim-a", 25631)
        self.client("slim_b", "game-slim-b", 25631)
        self.client("slim_c", "game-slim-c", 25633, marker_port=25640)
        with self.assertRaises(cc.PlanError) as caught:
            cc.build_plan(["slim_a", "slim_b", "slim_c"], self.base)
        self.assertIn("port 25631 is shared", str(caught.exception))
        self.assertIn("differs from the profile's pinned port 25640", str(caught.exception))


class FakeCollector:
    def __init__(self, script):
        self.script = script  # callable(n, started) -> (avail_kb, active_names, healthy_names)
        self.n = 0
        self.started = []

    def host(self):
        avail, _active, _healthy = self.script(self.n, self.started)
        return {"meminfo_kb": {"MemAvailable": avail}}

    def sample(self, phase, picture=False, probe_names=None):
        avail, active, healthy = self.script(self.n, self.started)
        clients = {}
        for name in ("a", "b", "c"):
            on = name in active
            clients[name] = {"active": on}
            if on:
                clients[name]["cgroup"] = {"path": f"/cg/{name}", "memory_current": 1, "memory_stat": {}, "cpu_usage_usec": self.n}
                clients[name]["processes"] = []
                clients[name]["probe"] = {"state": "healthy" if name in healthy else "non_world"}
        self.n += 1
        return {"t": float(self.n), "phase": phase, "gpu": {}, "clients": clients,
                "host": {"meminfo_kb": {"MemAvailable": avail}, "vmstat": {}, "pressure": {}}}


class Experiments(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.now = 0.0
        self.calls = []
        self.running = set()
        self.stuck = set()  # units whose stop fails and which keep running

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, argv, **_kw):
        self.calls.append(argv[2:])
        unit = argv[-1]
        if argv[2] == "start":
            self.running.add(unit)
        elif argv[2] == "stop":
            if unit in self.stuck:
                return done(code=1, stderr="Job for unit canceled.")
            self.running.discard(unit)
        elif argv[2] == "is-active":
            return done("active\n" if unit in self.running else "inactive\n")
        return done()

    def sleep(self, seconds):
        self.now += max(seconds, 0.001)

    def experiment(self, script, names=("a", "b", "c"), **overrides):
        settings = dict(interval=5, warmup=10, measure=60, stagger=5, ready_timeout=60, picture_every=0,
                        min_start_available_mib=4096, abort_available_mib=1024, abort_psi_full=10.0, label="t")
        settings.update(overrides)
        clients = [{"name": n, "unit": f"gary-client@{n}.service", "url": "http://127.0.0.1:1"} for n in names]
        collector = FakeCollector(script)
        self.last_out = self.out / f"run{len(list(self.out.iterdir()))}"
        self.last_out.mkdir()
        exp = cc.Experiment(types.SimpleNamespace(**settings), clients, collector, self.last_out,
                            run=self.run_cmd, clock=lambda: self.now, sleep=self.sleep)
        collector.started = exp.started
        return exp.execute()

    def test_completed_run_stops_every_client_and_summarizes_measure_only(self):
        summary = self.experiment(lambda n, started: (8_000_000, set(started), set(started)))
        self.assertEqual(summary["outcome"], "completed")
        self.assertEqual(summary["stopped_units"], {"c": "inactive", "b": "inactive", "a": "inactive"})
        self.assertTrue(summary["cleanup_ok"])
        self.assertEqual(self.running, set())
        self.assertEqual(sorted(summary["measure"]["clients"]), ["a", "b", "c"])
        self.assertGreater(summary["measure"]["samples"], 5)
        self.assertTrue((self.last_out / "summary.json").exists())

    def test_failed_stop_is_not_success_and_the_other_clients_are_still_stopped(self):
        self.stuck.add("gary-client@b.service")
        summary = self.experiment(lambda n, started: (8_000_000, set(started), set(started)))
        self.assertFalse(summary["cleanup_ok"])
        self.assertEqual(summary["outcome"], "completed; cleanup_failed: gary-client@b.service may still be running")
        self.assertEqual(summary["cleanup_failures"], [{"client": "b", "unit": "gary-client@b.service", "state": "active",
                                                        "error": "stop exit 1: Job for unit canceled."}])
        self.assertEqual([c[1] for c in self.calls if c[0] == "stop"],
                         ["gary-client@c.service", "gary-client@b.service", "gary-client@a.service"])
        self.assertEqual(self.running, {"gary-client@b.service"})
        saved = json.loads((self.last_out / "summary.json").read_text())
        self.assertFalse(saved["cleanup_ok"])

    def test_no_headroom_for_third_client_starts_only_two(self):
        summary = self.experiment(lambda n, started: (3_000_000 if len(started) >= 2 else 8_000_000,
                                                      set(started), set(started)))
        self.assertTrue(summary["outcome"].startswith("aborted: no_start_headroom:c"))
        starts = [c[1] for c in self.calls if c[0] == "start"]
        self.assertEqual(starts, ["gary-client@a.service", "gary-client@b.service"])
        self.assertEqual(self.running, set())

    def test_sustained_low_memory_aborts_but_one_dip_does_not(self):
        dips = {3}
        summary = self.experiment(lambda n, started: (500_000 if n in dips else 8_000_000, set(started), set(started)),
                                  names=("a",))
        self.assertEqual(summary["outcome"], "completed")
        summary = self.experiment(lambda n, started: (500_000 if n >= 3 else 8_000_000, set(started), set(started)),
                                  names=("a",))
        self.assertTrue(summary["outcome"].startswith("aborted: low_available"))
        self.assertEqual(self.running, set())

    def test_exited_client_and_unready_client_abort(self):
        summary = self.experiment(lambda n, started: (8_000_000, set(started) - ({"a"} if n > 4 else set()), set(started)),
                                  names=("a",))
        self.assertEqual(summary["outcome"], "aborted: client_exited:a")
        summary = self.experiment(lambda n, started: (8_000_000, set(started), set()), names=("a",))
        self.assertTrue(summary["outcome"].startswith("aborted: not_ready:a"))
        self.assertEqual(self.running, set())


if __name__ == "__main__":
    unittest.main()
