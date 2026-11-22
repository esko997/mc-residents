#!/usr/bin/env python3
"""Bounded client capacity measurement: samples, disposable experiments, summaries.

`sample` only reads: per unit cgroup memory/CPU/pressure, per process RSS/PSS/
swap/CPU, host memory/pressure/swap activity, NVIDIA memory/utilisation (per
process when the driver reports it) and per-client server-connection bytes.
Synapse probes are opt-in. Usable during a resident run (Stage 0).

    client-capacity.py sample --target Gary=gary-client@Gary.service --target mind=gary-run.service \
        --duration 3600 --interval 60 --out ~/capacity/stage0.jsonl

`run` starts 1-3 DISPOSABLE clients (gary-client@<name>, so launch.sh, the unit's
CPUQuota and residents.slice are exactly what residents use), one at a time,
samples a warmup and a measurement window, stops every client it started and
writes plan.json, samples.jsonl and summary.json. It refuses resident
identities, resident game directories/ports, game directories not derived by
client-profile.py, and any host where resident clients/minds are running. It
never sends a world action; probes are GET /state and, optionally, GET
/screenshot (the read-only `picture` load residents generate). Idle clients
standing still undercount walking/chunk-loading peaks.

    client-capacity.py run --clients slim_a,slim_b,slim_c --out ~/capacity/3x-visual \
        --warmup 300 --measure 1800 --interval 15 --picture-every 4

    client-capacity.py summarize --samples DIR/samples.jsonl
    client-capacity.py compare DIR1/summary.json DIR2/summary.json

Abort guards (start headroom, sustained low MemAvailable or memory "full"
pressure, an exited client) end a run early and are recorded as its outcome.
They protect the host; they are not cgroup caps and none are set.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

LOOPBACK = {"127.0.0.1", "localhost", "::1"}
PERMANENT_NAMES = {"gary", "margo"}
RESERVED_PORTS = {25599, 25610}
RESIDENT_UNITS = ["gary-run.service", "margo-run.service", "overseer-run.service"]
USERNAME = re.compile(r"^[A-Za-z0-9_]{3,16}$")
PROFILE_MARKER = ".client-profile.json"
DEFAULT_SERVER = "192.168.1.233:25570"
MAX_SAMPLES = 20000


class PlanError(Exception):
    pass


class Abort(Exception):
    pass


# ---------------------------------------------------------------- parsers

def parse_kb_table(text):
    """/proc/meminfo style: `Key:   123 kB`."""
    out = {}
    for line in text.splitlines():
        match = re.match(r"^([\w()]+):\s+(\d+)", line)
        if match:
            out[match.group(1)] = int(match.group(2))
    return out


def parse_flat_ints(text):
    """memory.stat, cpu.stat, /proc/vmstat: `key value`."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("-").isdigit():
            out[parts[0]] = int(parts[1])
    return out


def parse_psi(text):
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] not in ("some", "full"):
            continue
        fields = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
        try:
            out[parts[0]] = {"avg10": float(fields["avg10"]), "avg60": float(fields["avg60"]),
                             "avg300": float(fields["avg300"]), "total": int(fields["total"])}
        except (KeyError, ValueError):
            continue
    return out


SMAPS_KEYS = {"Rss": "rss_kb", "Pss": "pss_kb", "Pss_Anon": "pss_anon_kb", "Pss_File": "pss_file_kb",
              "Pss_Shmem": "pss_shmem_kb", "Swap": "swap_kb", "SwapPss": "swap_pss_kb"}


def parse_smaps_rollup(text):
    table = parse_kb_table(text)
    return {v: table[k] for k, v in SMAPS_KEYS.items() if k in table}


def parse_proc_stat(text):
    """comm and utime+stime ticks from /proc/<pid>/stat (comm may contain spaces)."""
    start, end = text.index("("), text.rindex(")")
    rest = text[end + 2:].split()
    # rest[0] is state (field 3); utime/stime are fields 14/15.
    return text[start + 1:end], int(rest[11]) + int(rest[12])


def _number(text):
    if text is None:
        return None
    match = re.match(r"^\s*(-?\d+(?:\.\d+)?)", text)
    return float(match.group(1)) if match else None


def parse_nvidia_xml(text):
    root = ET.fromstring(text)
    gpus, processes = [], {}
    for index, gpu in enumerate(root.findall("gpu")):
        power = gpu.findtext("gpu_power_readings/power_draw") or gpu.findtext("power_readings/power_draw")
        gpus.append({
            "index": index,
            "name": gpu.findtext("product_name"),
            "memory_used_mib": _number(gpu.findtext("fb_memory_usage/used")),
            "memory_total_mib": _number(gpu.findtext("fb_memory_usage/total")),
            "util_gpu_pct": _number(gpu.findtext("utilization/gpu_util")),
            "util_mem_pct": _number(gpu.findtext("utilization/memory_util")),
            "temp_c": _number(gpu.findtext("temperature/gpu_temp")),
            "power_w": _number(power),
        })
        for info in gpu.findall("processes/process_info"):
            pid = _number(info.findtext("pid"))
            if pid is not None:
                used = _number(info.findtext("used_memory"))
                processes[int(pid)] = None if used is None else (processes.get(int(pid)) or 0) + used
    return {"gpus": gpus, "processes": processes}


def parse_ss(text):
    """`ss -tinpH`: connection lines carry users:(("java",pid=N,..)); the
    indented next line carries bytes_sent/bytes_received."""
    out, pids = {}, []
    for line in text.splitlines():
        if not line.strip():
            continue
        if not line[0].isspace():
            pids = [int(p) for p in re.findall(r"pid=(\d+)", line)]
            if "bytes_" not in line:
                continue  # the indented next line carries the counters
        sent = re.search(r"bytes_sent:(\d+)", line)
        received = re.search(r"bytes_received:(\d+)", line)
        for pid in pids:
            entry = out.setdefault(pid, {"bytes_sent": 0, "bytes_received": 0})
            entry["bytes_sent"] += int(sent.group(1)) if sent else 0
            entry["bytes_received"] += int(received.group(1)) if received else 0
        pids = []
    return out


def png_size(data):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def read_env_file(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip().removeprefix("export ").strip()] = value
    return out


def loopback_port(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK or parsed.username or parsed.password \
            or parsed.query or parsed.fragment or parsed.port is None:
        raise PlanError(f"{url}: Synapse URL must be http://127.0.0.1:<port> (token never leaves loopback)")
    return parsed.port


# ---------------------------------------------------------------- probes

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def synapse_get(url, path, token, timeout, limit):
    loopback_port(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url.rstrip("/") + path, headers={"X-Synapse-Token": token})
    started = time.monotonic()
    try:
        with opener.open(request, timeout=timeout) as reply:
            body = reply.read(limit + 1)
            status = reply.status
    except urllib.error.HTTPError as error:
        return {"status": error.code, "ms": round((time.monotonic() - started) * 1000), "body": b""}
    except (TimeoutError, urllib.error.URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        kind = "timeout" if isinstance(reason, TimeoutError) or isinstance(error, TimeoutError) else "unavailable"
        return {"status": kind, "ms": round((time.monotonic() - started) * 1000), "body": b""}
    if len(body) > limit:
        return {"status": "too_large", "ms": round((time.monotonic() - started) * 1000), "body": b""}
    return {"status": status, "ms": round((time.monotonic() - started) * 1000), "body": body}


def classify_state(body):
    try:
        envelope = json.loads(body)
    except ValueError:
        return "invalid_state"
    data = envelope.get("data") if isinstance(envelope, dict) and envelope.get("ok") is True else None
    if not isinstance(data, dict) or not isinstance(data.get("pos"), dict):
        return "non_world"
    health = data.get("health")
    if not isinstance(health, (int, float)) or not math.isfinite(health):
        return "invalid_state"
    return "in_game_dead" if health <= 0 else "healthy"


# ---------------------------------------------------------------- collector

class Collector:
    def __init__(self, targets, token_file="~/.synapse/token", server=DEFAULT_SERVER,
                 proc=Path("/proc"), cgroup_root=Path("/sys/fs/cgroup"), run=subprocess.run):
        self.targets = targets  # [{"name", "unit", "url" or None}]
        self.token_file = Path(token_file).expanduser()
        self.server = server
        self.proc, self.cgroup_root, self.run = Path(proc), Path(cgroup_root), run
        self.ticks = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
        self.gpu_failures = 0
        self.gpu_disabled = None

    def _read(self, path):
        try:
            return Path(path).read_text()
        except OSError:
            return None

    def _cmd(self, argv, timeout):
        try:
            done = self.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        except FileNotFoundError:
            return None, f"{argv[0]} not found"
        except subprocess.TimeoutExpired:
            return None, f"{argv[0]} timed out"
        if done.returncode != 0:
            return None, f"{argv[0]} exit {done.returncode}: {(done.stderr or '').strip()[:200]}"
        return done.stdout, None

    def unit_state(self, unit):
        out, error = self._cmd(["systemctl", "--user", "show", "-p", "ActiveState", "-p", "ControlGroup", unit], 5)
        if out is None:
            return False, None, error
        props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        cgroup = props.get("ControlGroup", "").strip()
        return props.get("ActiveState") == "active", (self.cgroup_root / cgroup.lstrip("/")) if cgroup else None, None

    def cgroup_pids(self, path):
        pids = []
        for root, _dirs, _files in os.walk(path):
            text = self._read(Path(root) / "cgroup.procs")
            if text:
                pids += [int(p) for p in text.split()]
        return sorted(set(pids))

    def cgroup_metrics(self, path):
        stat = parse_flat_ints(self._read(path / "memory.stat") or "")
        cpu = parse_flat_ints(self._read(path / "cpu.stat") or "")
        current, peak = self._read(path / "memory.current"), self._read(path / "memory.peak")
        return {
            "path": str(path),
            "memory_current": int(current) if current and current.strip().isdigit() else None,
            "memory_peak": int(peak) if peak and peak.strip().isdigit() else None,
            "memory_stat": {k: stat[k] for k in ("anon", "file", "shmem", "kernel", "kernel_stack",
                                                 "pagetables", "sock", "file_mapped") if k in stat},
            "cpu_usage_usec": cpu.get("usage_usec"),
            "memory_pressure": parse_psi(self._read(path / "memory.pressure") or ""),
            "cpu_pressure": parse_psi(self._read(path / "cpu.pressure") or ""),
        }

    def process(self, pid, gpu):
        base = self.proc / str(pid)
        stat = self._read(base / "stat")
        if stat is None:
            return None
        comm, ticks = parse_proc_stat(stat)
        record = {"pid": pid, "comm": comm, "cpu_seconds": round(ticks / self.ticks, 2)}
        record.update(parse_smaps_rollup(self._read(base / "smaps_rollup") or ""))
        if pid in gpu:
            record["gpu_mib"] = gpu[pid]
        return record

    def host(self):
        mem = parse_kb_table(self._read(self.proc / "meminfo") or "")
        vm = parse_flat_ints(self._read(self.proc / "vmstat") or "")
        load = (self._read(self.proc / "loadavg") or "").split()
        return {
            "meminfo_kb": {k: mem[k] for k in ("MemTotal", "MemAvailable", "MemFree", "Cached", "Shmem",
                                               "SwapTotal", "SwapFree", "Zswap", "Zswapped") if k in mem},
            "vmstat": {k: vm[k] for k in ("pswpin", "pswpout", "pgmajfault", "oom_kill") if k in vm},
            "loadavg": [float(x) for x in load[:3]] if len(load) >= 3 else None,
            "pressure": {k: parse_psi(self._read(self.proc / "pressure" / k) or "") for k in ("memory", "cpu", "io")},
        }

    def gpu(self):
        if self.gpu_disabled:
            return {"unavailable": self.gpu_disabled}
        out, error = self._cmd(["nvidia-smi", "-q", "-x"], 8)
        if out is None:
            self.gpu_failures += 1
            if self.gpu_failures >= 3 or "not found" in error:
                self.gpu_disabled = error
            return {"unavailable": error}
        try:
            self.gpu_failures = 0
            return parse_nvidia_xml(out)
        except ET.ParseError as parse_error:
            return {"unavailable": f"nvidia-smi xml: {parse_error}"}

    def net(self):
        out, error = self._cmd(["ss", "-tinpH", "dst", self.server], 5)
        return ({"unavailable": error}, {}) if out is None else (None, parse_ss(out))

    def token(self):
        try:
            return self.token_file.read_text().strip() or None
        except OSError:
            return None

    def probe(self, url, picture):
        token = self.token()
        if not token:
            return {"state": "token_unavailable"}
        result = {}
        reply = synapse_get(url, "/state?mode=summary", token, 6, 262144)
        result["state_ms"] = reply["ms"]
        result["state"] = classify_state(reply["body"]) if reply["status"] == 200 else f"http_{reply['status']}"
        if picture and result["state"] in ("healthy", "in_game_dead"):
            shot = synapse_get(url, "/screenshot?format=raw", token, 15, 16 * 1024 * 1024)
            size = png_size(shot["body"]) if shot["status"] == 200 else None
            result.update({"picture_ms": shot["ms"], "picture_status": shot["status"],
                           "picture_bytes": len(shot["body"]),
                           "picture_size": list(size) if size else None})
        return result

    def sample(self, phase, picture=False, probe_names=None):
        started = time.time()
        gpu = self.gpu()
        gpu_pids = gpu.get("processes", {}) if "unavailable" not in gpu else {}
        net_error, net = self.net()
        clients = {}
        for target in self.targets:
            active, cgroup, error = self.unit_state(target["unit"])
            entry = {"unit": target["unit"], "active": active}
            if error:
                entry["error"] = error
            if active and cgroup is not None and cgroup.is_dir():
                pids = self.cgroup_pids(cgroup)
                entry["cgroup"] = self.cgroup_metrics(cgroup)
                entry["processes"] = [p for p in (self.process(pid, gpu_pids) for pid in pids) if p]
                if net_error is None:
                    entry["net"] = {
                        "bytes_sent": sum(net.get(pid, {}).get("bytes_sent", 0) for pid in pids),
                        "bytes_received": sum(net.get(pid, {}).get("bytes_received", 0) for pid in pids),
                        "connections_seen": sum(1 for pid in pids if pid in net)}
                if target.get("url") and (probe_names is None or target["name"] in probe_names):
                    entry["probe"] = self.probe(target["url"], picture)
            clients[target["name"]] = entry
        record = {"t": round(started, 3), "phase": phase, "host": self.host(),
                  "gpu": {k: v for k, v in gpu.items() if k != "processes"}, "clients": clients}
        if net_error:
            record["net_unavailable"] = net_error["unavailable"]
        record["sample_ms"] = round((time.time() - started) * 1000)
        return record


# ---------------------------------------------------------------- summary

def percentile(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return values[max(0, math.ceil(q / 100 * len(values)) - 1)]


def stats(values, scale=1.0, digits=1):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "max": round(max(values) * scale, digits), "p95": round(percentile(values, 95) * scale, digits),
            "mean": round(sum(values) / len(values) * scale, digits), "min": round(min(values) * scale, digits)}


def _sum(processes, key):
    values = [p.get(key) for p in processes]
    return sum(v for v in values if v is not None) if any(v is not None for v in values) else None


def _rate(pairs, key_fn):
    """Per-second deltas of a cumulative counter across consecutive samples."""
    out = []
    for a, b in zip(pairs, pairs[1:]):
        x, y = key_fn(a), key_fn(b)
        dt = b["t"] - a["t"]
        if x is not None and y is not None and dt > 0 and y >= x:
            out.append((y - x) / dt)
    return out


def summarize(samples, phases=("measure",)):
    chosen = [s for s in samples if s.get("phase") in phases]
    out = {"phases": list(phases), "samples": len(chosen)}
    if not chosen:
        out["note"] = "no samples in these phases"
        return out
    out["window_s"] = round(chosen[-1]["t"] - chosen[0]["t"], 1)
    hosts = [s["host"] for s in chosen]
    mib = 1 / 1024
    out["host"] = {
        "mem_available_mib": stats([h["meminfo_kb"].get("MemAvailable") for h in hosts], mib, 0),
        "swap_used_mib": stats([h["meminfo_kb"]["SwapTotal"] - h["meminfo_kb"]["SwapFree"]
                                for h in hosts if "SwapTotal" in h["meminfo_kb"]], mib, 0),
        "load1": stats([(h.get("loadavg") or [None])[0] for h in hosts], 1, 2),
    }
    for kind in ("memory", "cpu", "io"):
        for level in ("some", "full"):
            avg10 = [h["pressure"].get(kind, {}).get(level, {}).get("avg10") for h in hosts]
            stall = _rate(chosen, lambda s: s["host"]["pressure"].get(kind, {}).get(level, {}).get("total"))
            if any(v is not None for v in avg10):
                out["host"][f"psi_{kind}_{level}"] = {
                    "avg10_max": max(v for v in avg10 if v is not None),
                    # total is cumulative stall microseconds: share of the window spent stalled.
                    "stalled_pct": round(sum(stall) / len(stall) / 1e4, 2) if stall else None}
    for counter in ("pswpin", "pswpout", "pgmajfault", "oom_kill"):
        first, last = chosen[0]["host"]["vmstat"].get(counter), chosen[-1]["host"]["vmstat"].get(counter)
        if first is not None and last is not None:
            out["host"][f"{counter}_delta"] = last - first
    gpus = [s["gpu"].get("gpus") for s in chosen if s["gpu"].get("gpus")]
    if gpus:
        out["gpu"] = {"memory_used_mib": stats([g[0]["memory_used_mib"] for g in gpus], 1, 0),
                      "util_gpu_pct": stats([g[0]["util_gpu_pct"] for g in gpus], 1, 0),
                      "name": gpus[0][0].get("name")}
    else:
        out["gpu"] = {"unavailable": next((s["gpu"].get("unavailable") for s in chosen if s["gpu"].get("unavailable")), "no data")}
    names = sorted({n for s in chosen for n in s["clients"]})
    out["clients"] = {}
    for name in names:
        rows = [s for s in chosen if s["clients"].get(name, {}).get("cgroup")]
        entry = {"samples_active": len(rows), "samples_total": len(chosen)}
        if rows:
            procs = [s["clients"][name].get("processes", []) for s in rows]
            cg = [s["clients"][name]["cgroup"] for s in rows]
            entry["pss_mib"] = stats([_sum(p, "pss_kb") for p in procs], mib, 0)
            entry["rss_sum_mib"] = stats([_sum(p, "rss_kb") for p in procs], mib, 0)
            entry["swap_mib"] = stats([_sum(p, "swap_kb") for p in procs], mib, 0)
            entry["cgroup_current_mib"] = stats([c.get("memory_current") for c in cg], mib / 1024, 0)
            entry["cgroup_peak_mib_last"] = (round(cg[-1]["memory_peak"] / 1048576)
                                             if cg[-1].get("memory_peak") is not None else None)
            entry["cgroup_anon_mib"] = stats([c["memory_stat"].get("anon") for c in cg], mib / 1024, 0)
            same_cgroup = [s for s in rows if s["clients"][name]["cgroup"]["path"] == cg[-1]["path"]]
            cpu = _rate(same_cgroup, lambda s: s["clients"][name]["cgroup"].get("cpu_usage_usec"))
            entry["cpu_pct_of_one_core"] = stats([r / 1e4 for r in cpu], 1, 1)
            gpu_values = [_sum(p, "gpu_mib") for p in procs]
            entry["gpu_mib"] = stats(gpu_values, 1, 0) if any(v is not None for v in gpu_values) \
                else "not reported per process"
            nets = [s["clients"][name].get("net") for s in same_cgroup]
            if all(nets) and nets:
                entry["net_kib_per_s"] = {
                    "received": stats(_rate(same_cgroup, lambda s: s["clients"][name]["net"]["bytes_received"]), 1 / 1024, 1),
                    "sent": stats(_rate(same_cgroup, lambda s: s["clients"][name]["net"]["bytes_sent"]), 1 / 1024, 1)}
            largest = max(procs[-1], key=lambda p: p.get("pss_kb") or 0, default=None)
            if largest:
                entry["largest_process_last"] = {"comm": largest["comm"], "pss_mib": round((largest.get("pss_kb") or 0) / 1024)}
        probes = [s["clients"][name].get("probe") for s in chosen if s["clients"].get(name, {}).get("probe")]
        if probes:
            states = {}
            for p in probes:
                states[p["state"]] = states.get(p["state"], 0) + 1
            entry["probe"] = {"states": states, "state_ms": stats([p.get("state_ms") for p in probes], 1, 0)}
            shots = [p for p in probes if "picture_status" in p]
            if shots:
                entry["probe"]["pictures"] = {
                    "ok": sum(1 for p in shots if p.get("picture_size")),
                    "failed": sum(1 for p in shots if not p.get("picture_size")),
                    "sizes": sorted({"x".join(map(str, p["picture_size"])) for p in shots if p.get("picture_size")}),
                    "ms": stats([p.get("picture_ms") for p in shots], 1, 0)}
        out["clients"][name] = entry
    return out


def load_samples(path):
    samples = []
    with open(path) as handle:
        for line in handle:
            if line.strip():
                samples.append(json.loads(line))
    return samples


def compare(summaries):
    """Markdown table of the same metrics across runs; numbers only, no verdict."""
    rows = []

    def cell(value):
        if isinstance(value, dict):
            return f"{value.get('max')} / {value.get('mean')}"
        return "-" if value is None else str(value)

    labels = [s.get("label") or s.get("_path") for s in summaries]
    rows.append("| metric | " + " | ".join(labels) + " |")
    rows.append("|---|" + "---|" * len(labels))
    m = [s.get("measure", {}) for s in summaries]
    host_keys = ["mem_available_mib", "swap_used_mib", "load1", "psi_memory_some", "psi_memory_full", "psi_cpu_some",
                 "pswpout_delta", "pgmajfault_delta", "oom_kill_delta"]
    rows.append("| outcome | " + " | ".join(str(s.get("outcome")) for s in summaries) + " |")
    rows.append("| measured clients | " + " | ".join(str(len(x.get("clients", {}))) for x in m) + " |")
    for key in host_keys:
        values = []
        for x in m:
            v = x.get("host", {}).get(key)
            if isinstance(v, dict) and "avg10_max" in v:
                v = f"avg10max {v['avg10_max']}, stalled {v['stalled_pct']}%"
            values.append(cell(v))
        rows.append(f"| host {key} (max / mean) | " + " | ".join(values) + " |")
    rows.append("| gpu memory_used_mib | " + " | ".join(cell(x.get("gpu", {}).get("memory_used_mib")) for x in m) + " |")
    for key in ("pss_mib", "cgroup_current_mib", "cgroup_peak_mib_last", "swap_mib", "cpu_pct_of_one_core", "gpu_mib"):
        values = []
        for x in m:
            clients = x.get("clients", {})
            values.append("; ".join(f"{n}: {cell(c.get(key))}" for n, c in sorted(clients.items())) or "-")
        rows.append(f"| client {key} (max / mean) | " + " | ".join(values) + " |")
    return "\n".join(rows) + "\n\nMeasured windows only; startup peaks are under `all_phases` in each summary.\n"


# ---------------------------------------------------------------- experiment plan

def permanent_identities(base):
    names = set(PERMANENT_NAMES)
    resident = Path(base) / "resident"
    if resident.is_dir():
        for entry in resident.iterdir():
            if entry.is_dir() and ((entry / "AGENTS.md").exists() or (entry / "CLAUDE.md").exists()):
                names.add(entry.name.lower())
    names |= {n.strip().lower() for n in os.environ.get("RESIDENT_IDENTITIES", "").split(",") if n.strip()}
    return names


def reserved_paths_and_ports(base, permanent):
    base = Path(base)
    dirs = {(base / "game").resolve(), (base / "game-Margo").resolve()}
    ports = set(RESERVED_PORTS)
    instances = base / "instances"
    if instances.is_dir():
        for env_path in instances.glob("*.env"):
            if env_path.stem.lower() not in permanent:
                continue
            env = read_env_file(env_path)
            if env.get("GAME_DIR"):
                dirs.add(Path(env["GAME_DIR"]).expanduser().resolve())
            if env.get("SYNAPSE_URL"):
                port = urllib.parse.urlsplit(env["SYNAPSE_URL"]).port
                if port:
                    ports.add(port)
    return dirs, ports


def build_plan(names, base):
    base = Path(base).expanduser()
    problems = []
    if not 1 <= len(names) <= 3:
        raise PlanError("an experiment runs 1 to 3 disposable clients")
    if len({n.lower() for n in names}) != len(names):
        raise PlanError("client names must be distinct")
    permanent = permanent_identities(base)
    reserved_dirs, reserved_ports = reserved_paths_and_ports(base, permanent)
    clients, seen_dirs, seen_ports = [], set(), set()
    for name in names:
        if not USERNAME.match(name):
            problems.append(f"{name}: not a valid Minecraft username")
            continue
        if name.lower() in permanent:
            problems.append(f"{name}: a resident identity; experiments use disposable identities only")
            continue
        env_path = base / "instances" / f"{name}.env"
        if not env_path.is_file():
            problems.append(f"{name}: {env_path} missing (needs GAME_DIR and SYNAPSE_URL)")
            continue
        env = read_env_file(env_path)
        game_value, url = env.get("GAME_DIR"), env.get("SYNAPSE_URL")
        if not game_value or not url:
            problems.append(f"{name}: {env_path} must set GAME_DIR and SYNAPSE_URL")
            continue
        game = Path(game_value).expanduser().resolve()
        try:
            port = loopback_port(url)
        except PlanError as error:
            problems.append(f"{name}: {error}")
            continue
        if game in reserved_dirs:
            problems.append(f"{name}: {game} is a resident game directory")
        if port in reserved_ports:
            problems.append(f"{name}: port {port} belongs to a resident")
        if game in seen_dirs:
            problems.append(f"{name}: {game} is shared with another client in this run")
        if port in seen_ports:
            problems.append(f"{name}: port {port} is shared with another client in this run")
        seen_dirs.add(game)
        seen_ports.add(port)
        marker_path = game / PROFILE_MARKER
        marker = None
        if not marker_path.is_file():
            problems.append(f"{name}: {game} was not made by client-profile.py derive (use profile baseline for a control arm)")
        else:
            try:
                marker = json.loads(marker_path.read_text())
            except ValueError:
                problems.append(f"{name}: {marker_path} unreadable")
        if marker and marker.get("synapse_port") != port:
            problems.append(f"{name}: SYNAPSE_URL port {port} differs from the profile's pinned port {marker.get('synapse_port')}")
        if env.get("GARY_CLIENT_PROFILE") and marker and env["GARY_CLIENT_PROFILE"] != marker.get("profile"):
            problems.append(f"{name}: GARY_CLIENT_PROFILE={env['GARY_CLIENT_PROFILE']} but {game} holds {marker.get('profile')}")
        clients.append({
            "name": name, "unit": f"gary-client@{name}.service", "url": url, "game_dir": str(game),
            "profile": marker.get("profile") if marker else None,
            "excluded_jars": [e["jar"] for e in marker.get("excluded", [])] if marker else None,
            "options": marker.get("options") if marker else None,
            "render_distance": marker.get("render_distance") if marker else None,
            "heap": env.get("GARY_CLIENT_HEAP", "4G (launch.sh default)"),
            "resolution": env.get("GARY_CLIENT_RESOLUTION", "854x480 (launch.sh default)"),
        })
    if problems:
        raise PlanError("; ".join(problems))
    return clients


def active_units(run=subprocess.run):
    """Resident run units and any client unit that is up."""
    found = []
    for unit in RESIDENT_UNITS:
        done = run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True, timeout=5, check=False)
        if done.stdout.strip() in ("active", "activating", "deactivating", "reloading"):
            found.append(unit)
    done = run(["systemctl", "--user", "list-units", "gary-client@*", "--state=active,activating",
                "--plain", "--no-legend"], capture_output=True, text=True, timeout=5, check=False)
    found += [line.split()[0] for line in done.stdout.splitlines() if line.strip()]
    return found


# ---------------------------------------------------------------- experiment run

def bounded(value, low, high, name):
    if not low <= value <= high:
        raise PlanError(f"--{name} must be {low}-{high}")
    return value


class Experiment:
    def __init__(self, args, clients, collector, out, run=subprocess.run, clock=time.monotonic, sleep=time.sleep):
        self.args, self.clients, self.collector, self.out = args, clients, collector, Path(out)
        self.run, self.clock, self.sleep = run, clock, sleep
        self.started, self.count, self.strikes = [], 0, {}
        self.samples_path = self.out / "samples.jsonl"

    def systemctl(self, verb, unit, timeout):
        return self.run(["systemctl", "--user", verb, unit], capture_output=True, text=True, timeout=timeout, check=False)

    def guard(self, record):
        args = self.args
        for name in self.started:
            if not record["clients"].get(name, {}).get("active"):
                raise Abort(f"client_exited:{name}")
        mem = record["host"]["meminfo_kb"].get("MemAvailable")
        full = record["host"]["pressure"].get("memory", {}).get("full", {}).get("avg10")
        for key, bad in (("low_available", mem is not None and mem < args.abort_available_mib * 1024),
                         ("memory_full_pressure", full is not None and full >= args.abort_psi_full)):
            self.strikes[key] = self.strikes.get(key, 0) + 1 if bad else 0
            if self.strikes[key] >= 2:
                raise Abort(f"{key}: MemAvailable {mem} kB, memory full avg10 {full}")

    def tick(self, phase, handle, probe_names=None):
        if self.count >= MAX_SAMPLES:
            raise Abort("sample limit reached")
        picture = bool(self.args.picture_every) and phase != "startup" and self.count % self.args.picture_every == 0
        record = self.collector.sample(phase, picture=picture, probe_names=probe_names)
        record["n"] = self.count
        self.count += 1
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        handle.flush()
        self.guard(record)
        return record

    def phase(self, name, seconds, handle, until=None, probe_names=None):
        end = self.clock() + seconds
        next_at = self.clock()
        while self.clock() < end:
            record = self.tick(name, handle, probe_names)
            if until and until(record):
                return record
            next_at += self.args.interval
            self.sleep(max(0.0, min(next_at, end) - self.clock()))
        return None

    def start_all(self, handle):
        for client in self.clients:
            available = self.collector.host()["meminfo_kb"].get("MemAvailable", 0)
            if available < self.args.min_start_available_mib * 1024:
                raise Abort(f"no_start_headroom:{client['name']}: MemAvailable {available // 1024} MiB "
                            f"< {self.args.min_start_available_mib} MiB")
            self.started.append(client["name"])  # stopped in finally whatever start reports
            done = self.systemctl("start", client["unit"], 60)
            if done.returncode != 0:
                raise Abort(f"start_failed:{client['name']}: {done.stderr.strip()[:200]}")
            name = client["name"]
            ready = self.phase("startup", self.args.ready_timeout, handle,
                               until=lambda r: r["clients"][name].get("probe", {}).get("state") == "healthy")
            if ready is None:
                raise Abort(f"not_ready:{name} within {self.args.ready_timeout}s")
            if self.args.stagger and client is not self.clients[-1]:
                self.phase("startup", self.args.stagger, handle)

    def stop_all(self):
        # A second signal must not abandon started clients halfway through cleanup.
        previous = {}
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            try:
                previous[sig] = signal.signal(sig, signal.SIG_IGN)
            except ValueError:  # not the main thread
                pass
        results, failures = {}, []
        try:
            for name in reversed(self.started):  # every owned unit, whatever happened to the previous one
                unit = f"gary-client@{name}.service"
                stop_error = None
                try:
                    stopped = self.systemctl("stop", unit, 180)
                    if stopped.returncode != 0:
                        stop_error = f"stop exit {stopped.returncode}: {(stopped.stderr or '').strip()[:200]}"
                except (OSError, subprocess.TimeoutExpired) as error:
                    stop_error = f"stop {error}"
                try:
                    state = self.run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True,
                                     timeout=5, check=False).stdout.strip()
                except (OSError, subprocess.TimeoutExpired) as error:
                    state = f"unknown ({error})"
                results[name] = state
                # Only a confirmed stopped unit counts; a failed unit is not running either.
                if stop_error or state not in ("inactive", "failed"):
                    failures.append({"client": name, "unit": unit, "state": state, "error": stop_error})
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        return results, failures

    def execute(self):
        outcome = "completed"
        stopped, failures = {}, []
        with open(self.samples_path, "a") as handle:
            try:
                self.start_all(handle)
                self.phase("warmup", self.args.warmup, handle)
                self.phase("measure", self.args.measure, handle)
            except Abort as reason:
                outcome = f"aborted: {reason}"
            except KeyboardInterrupt:
                outcome = "interrupted"
            except Exception as error:  # still stop every started client and keep the samples
                outcome = f"error: {error!r}"
            finally:
                stopped, failures = self.stop_all()
        if failures:
            outcome += f"; cleanup_failed: {', '.join(f['unit'] for f in failures)} may still be running"
        samples = load_samples(self.samples_path)
        summary = {"label": self.args.label or self.out.name, "outcome": outcome, "cleanup_ok": not failures,
                   "cleanup_failures": failures, "stopped_units": stopped,
                   "clients": self.clients, "measure": summarize(samples, ("measure",)),
                   "all_phases": summarize(samples, ("startup", "warmup", "measure"))}
        (self.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        return summary


def host_facts(run=subprocess.run):
    facts = {"nproc": os.cpu_count(), "kernel": os.uname().release, "hostname": os.uname().nodename}
    try:
        facts["mem_total_kb"] = parse_kb_table(Path("/proc/meminfo").read_text()).get("MemTotal")
    except OSError:
        pass
    try:
        done = run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
                   capture_output=True, text=True, timeout=8, check=False)
        facts["gpu"] = done.stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        facts["gpu"] = None
    return facts


def _interrupt(_signum, _frame):
    raise KeyboardInterrupt


def cmd_run(args):
    bounded(args.warmup, 0, 1800, "warmup")
    bounded(args.measure, 60, 7200, "measure")
    bounded(args.interval, 5, 120, "interval")
    bounded(args.stagger, 0, 900, "stagger")
    bounded(args.ready_timeout, 60, 900, "ready-timeout")
    bounded(args.picture_every, 0, 100, "picture-every")
    names = [n.strip() for n in args.clients.split(",") if n.strip()]
    clients = build_plan(names, args.base)
    busy = active_units()
    if busy:
        raise PlanError(f"refusing while these units are up: {busy} (no test client beside residents)")
    out = Path(args.out).expanduser()
    if out.exists() and any(out.iterdir()):
        raise PlanError(f"{out} is not empty")
    out.mkdir(parents=True, exist_ok=True)
    plan = {"created_at": int(time.time()), "clients": clients, "host": host_facts(),
            "settings": {k: getattr(args, k) for k in ("warmup", "measure", "interval", "stagger", "ready_timeout",
                                                         "picture_every", "min_start_available_mib",
                                                         "abort_available_mib", "abort_psi_full", "server")},
            "note": "Disposable identities, idle in world; read-only probes. No world actions were sent."}
    (out / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    targets = [{"name": c["name"], "unit": c["unit"], "url": c["url"]} for c in clients]
    collector = Collector(targets, token_file=args.token_file, server=args.server)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, _interrupt)
    summary = Experiment(args, clients, collector, out).execute()
    print(json.dumps({"outcome": summary["outcome"], "cleanup_ok": summary["cleanup_ok"],
                      "cleanup_failures": summary["cleanup_failures"], "stopped_units": summary["stopped_units"],
                      "summary": str(out / "summary.json")}, indent=2))
    if not summary["cleanup_ok"]:
        return 4  # a disposable client may still be running: check and stop it before anything else
    return 0 if summary["outcome"] == "completed" else 3


def cmd_sample(args):
    bounded(args.duration, 10, 86400, "duration")
    bounded(args.interval, 5, 3600, "interval")
    targets = []
    probes = dict(p.split("=", 1) for p in args.probe)
    for spec in args.target:
        if "=" not in spec:
            raise PlanError(f"--target {spec}: use NAME=UNIT")
        name, unit = spec.split("=", 1)
        url = probes.get(name)
        if url:
            loopback_port(url)
        targets.append({"name": name, "unit": unit, "url": url})
    if set(probes) - {t["name"] for t in targets}:
        raise PlanError("--probe names must match --target names")
    collector = Collector(targets, token_file=args.token_file, server=args.server)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, _interrupt)
    end = time.monotonic() + args.duration
    next_at = time.monotonic()
    count = 0
    try:
        with open(out, "a") as handle:
            while time.monotonic() < end and count < MAX_SAMPLES:
                record = collector.sample("measure", picture=False)
                record["n"] = count
                count += 1
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
                handle.flush()
                next_at += args.interval
                time.sleep(max(0.0, min(next_at, end) - time.monotonic()))
    except KeyboardInterrupt:
        pass
    print(json.dumps(summarize(load_samples(out)), indent=2))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--token-file", default="~/.synapse/token")
    common.add_argument("--server", default=DEFAULT_SERVER, help="server address for per-client connection bytes")

    p = sub.add_parser("sample", parents=[common], help="read-only sampling of existing units")
    p.add_argument("--target", action="append", required=True, help="NAME=UNIT, e.g. Gary=gary-client@Gary.service")
    p.add_argument("--probe", action="append", default=[], help="NAME=http://127.0.0.1:PORT (opt-in GET /state)")
    p.add_argument("--duration", type=int, required=True)
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--out", required=True)

    p = sub.add_parser("run", parents=[common], help="bounded disposable-client experiment")
    p.add_argument("--clients", required=True, help="comma-separated disposable usernames with instances/<name>.env")
    p.add_argument("--out", required=True)
    p.add_argument("--label")
    p.add_argument("--base", default=os.environ.get("GARY_CLIENT_HOME", "~/gary-client"))
    p.add_argument("--warmup", type=int, default=300)
    p.add_argument("--measure", type=int, default=1800)
    p.add_argument("--interval", type=int, default=15)
    p.add_argument("--stagger", type=int, default=60)
    p.add_argument("--ready-timeout", type=int, default=420)
    p.add_argument("--picture-every", type=int, default=4, help="screenshot probe every N samples; 0 = never")
    p.add_argument("--min-start-available-mib", type=int, default=4096)
    p.add_argument("--abort-available-mib", type=int, default=1024)
    p.add_argument("--abort-psi-full", type=float, default=10.0)

    p = sub.add_parser("summarize", help="summary of a samples.jsonl")
    p.add_argument("--samples", required=True)
    p.add_argument("--phases", default="measure")

    p = sub.add_parser("compare", help="side-by-side table of summary.json files")
    p.add_argument("summaries", nargs="+")

    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            return cmd_run(args)
        if args.command == "sample":
            return cmd_sample(args)
        if args.command == "summarize":
            print(json.dumps(summarize(load_samples(Path(args.samples).expanduser()),
                                       tuple(args.phases.split(","))), indent=2))
            return 0
        summaries = []
        for path in args.summaries:
            data = json.loads(Path(path).expanduser().read_text())
            data["_path"] = path
            summaries.append(data)
        print(compare(summaries))
        return 0
    except (PlanError, OSError, ValueError) as error:
        print(f"client-capacity: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
