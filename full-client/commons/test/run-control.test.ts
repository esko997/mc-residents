// Run control: controller auth, the launcher's exact argument vector, hub-to-station
// forwarding, refusals and per-host partial failure. Launchers are stub scripts that
// log their argv/environment; one test drives the real tools/ launcher against a
// stubbed systemctl/systemd-run. No real unit is touched.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { RunControl, type HostResult, type RunsReply } from "../src/run-control.ts";
import { RolloutTail } from "../src/rollouts.ts";
import { tempHome, type Home } from "./helpers.ts";

const HUB = "hub-dashboard-token", STATION = "station-secret-token";
const SWITCHYARD = "switchyard-controller-token-0123456789", HUB_AT_STATION = "hub-at-station-token-0123456789abcdef";
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function home(): Home { const value = tempHome(); cleanups.push(() => value.remove()); return value; }

const LAUNCHER = `#!/usr/bin/env bash
dir=$(dirname "$0"); name=$(basename "$0" .sh)
mkdir -p "$dir/calls"
printf '%s\\n' "$name" "$@" > "$dir/calls/$(date +%s%N)-$$"
env > "$dir/env-$name"
[ -f "$dir/sleep-$name" ] && sleep "$(cat "$dir/sleep-$name")"
cat "$dir/reply-$name.json" 2>/dev/null
exit "$(cat "$dir/exit-$name" 2>/dev/null || echo 0)"
`;

/** A tools directory whose launchers log their argv and answer what the test says. */
function fakeTools(at: Home) {
  const dir = join(at.dir, "tools");
  mkdirSync(join(dir, "calls"), { recursive: true });
  for (const script of ["start-run", "stop-run", "run-status"]) {
    writeFileSync(join(dir, `${script}.sh`), LAUNCHER);
    chmodSync(join(dir, `${script}.sh`), 0o755);
  }
  const answer = (script: "start-run" | "stop-run" | "run-status", reply: object, exit = 0, sleep = 0) => {
    writeFileSync(join(dir, `reply-${script}.json`), JSON.stringify(reply));
    writeFileSync(join(dir, `exit-${script}`), String(exit));
    if (sleep) writeFileSync(join(dir, `sleep-${script}`), String(sleep)); else rmSync(join(dir, `sleep-${script}`), { force: true });
  };
  const calls = () => existsSync(join(dir, "calls"))
    ? readdirSync(join(dir, "calls")).sort().map(file => readFileSync(join(dir, "calls", file), "utf8").trimEnd().split("\n")) : [];
  const env = (script: string) => readFileSync(join(dir, `env-${script}`), "utf8");
  return { dir, answer, calls, env, starts: () => calls().filter(c => c[0] === "start-run").map(c => c.slice(1)) };
}

const hostStatus = (host: string, residents: object[], extra: object = {}) =>
  ({ ok: true, code: "ok", host, now: 1, end_at: null, residents, caretaker: { unit: "overseer-run.service", state: "inactive", running: false, end_at: null, roster: [] }, ...extra });
const idle = (name: string) => ({ name, running: false, run_unit: `${name.toLowerCase()}-run.service`, run_state: "inactive", client_unit: `gary-client@${name}.service`, client_state: "inactive" });

function credentials(at: Home, entries: { name: string; token: string }[]) {
  chmodSync(at.put("commons-data/controller-credentials.json", JSON.stringify(entries.map(e => ({ name: e.name, role: "controller", sha256: sha(e.token) })))), 0o600);
}

function setup(options: { station?: boolean } = {}) {
  const hubHome = home();
  hubHome.put("resident/margo/memory.md", "");
  hubHome.put("instances/Margo.env", "GAME_DIR=/x/game-Margo\n");
  const hubTools = fakeTools(hubHome);
  hubTools.answer("run-status", hostStatus("inspiron", [idle("Gary"), idle("Margo")]));
  credentials(hubHome, [{ name: "switchyard", token: SWITCHYARD }]);
  let station: { app: App; tools: ReturnType<typeof fakeTools>; server: ReturnType<typeof Bun.serve> } | undefined;
  if (options.station !== false) {
    const stationHome = home();
    rmSync(join(stationHome.dir, "resident", "gary"), { recursive: true });
    for (const name of ["Wren", "Tobin"]) {
      stationHome.put(`resident/${name.toLowerCase()}/memory.md`, "");
      stationHome.put(`instances/${name}.env`, `GAME_DIR=/x/game-${name}\n`);
    }
    const tools = fakeTools(stationHome);
    tools.answer("run-status", hostStatus("chungus1", [idle("Wren"), idle("Tobin")]));
    credentials(stationHome, [{ name: "hub_inspiron", token: HUB_AT_STATION }]);
    const app = createApp(stationHome.config({ COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1", COMMONS_RUN_TOOLS: tools.dir,
      RESIDENTS_STATE_DIR: join(stationHome.dir, "state") }), STATION, Date.now, () => {});
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request) });
    cleanups.push(() => app.stop(), () => server.stop(true));
    station = { app, tools, server };
    chmodSync(hubHome.put("commons-data/stations.json", JSON.stringify([{ host: "chungus1", url: `http://127.0.0.1:${server.port}/${STATION}/` }])), 0o600);
    chmodSync(hubHome.put("commons-data/controller-station-tokens/chungus1.token", `${HUB_AT_STATION}\n`), 0o600);
  }
  const hubConfig = hubHome.config({ COMMONS_HOST_NAME: "inspiron", COMMONS_RUN_TOOLS: hubTools.dir, RESIDENTS_STATE_DIR: join(hubHome.dir, "state") });
  const hub = createApp(hubConfig, HUB, Date.now, () => {});
  cleanups.push(() => hub.stop());
  const control = (route: string, body?: unknown, headers: Record<string, string> = {}) => hub.fetch(new Request(`http://hub.test/controller/v1/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${SWITCHYARD}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { hub, hubHome, hubConfig, hubTools, station, control };
}

const soon = (minutes = 60) => Math.floor(Date.now() / 1000) + minutes * 60;

test("writes need a controller credential; the dashboard URL can only read run state", async () => {
  const s = setup({ station: false });
  const unauthorised = await s.control("runs", undefined, { Authorization: "Bearer wrong-token-0123456789abcdef" });
  expect(unauthorised.status).toBe(401);
  expect((await s.control("start", { residents: ["Gary"], end_at: soon() }, { Authorization: "" })).status).toBe(401);
  const crossSite = await s.control("start", { residents: ["Gary"], end_at: soon() }, { Origin: "http://evil.test", "Sec-Fetch-Site": "cross-site" });
  expect(crossSite.status).toBe(403);
  // The page's own origin may call it (with the bearer it was given).
  expect((await s.control("runs", undefined, { Origin: "http://hub.test", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  expect(s.hubTools.starts()).toEqual([]);

  const dashboard = await s.hub.fetch(new Request(`http://hub.test/${HUB}/api/runs`));
  expect(dashboard.status).toBe(200);
  expect(((await dashboard.json()) as RunsReply).hosts.map(h => [h.host, h.residents.map(r => r.name)])).toEqual([["inspiron", ["Gary", "Margo"]]]);
  for (const route of ["api/runs/start", "api/runs"]) {
    const post = await s.hub.fetch(new Request(`http://hub.test/${HUB}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"residents":"all"}' }));
    expect(post.status).toBe(404);
  }
  expect((await s.hub.fetch(new Request("http://hub.test/wrong/api/runs"))).status).toBe(404);

  // A readable credentials file is refused as a whole; a missing one means not configured.
  chmodSync(s.hubConfig.runControl.credentialsFile, 0o644);
  const loose = await s.control("runs");
  expect([loose.status, (await loose.json()).code]).toEqual([503, "not_configured"]);
  rmSync(s.hubConfig.runControl.credentialsFile);
  const missing = await s.control("runs");
  expect(missing.status).toBe(401);
  expect((await missing.json()).error).toContain("not configured");
});

test("a local start runs this host's launcher with a fixed argument vector and a scrubbed environment", async () => {
  const s = setup({ station: false });
  const end = soon();
  s.hubTools.answer("start-run", { ok: true, code: "ok", host: "inspiron", id: "20261123T170000Z-start-abc123", end_at: end, changed: true,
    residents: [{ name: "Gary", result: "started", model: "gpt-x", mode: "fresh", unit: "gary-run.service", client_unit: "gary-client@Gary.service", invocation_id: "ff" }],
    caretaker: { result: "off" } });
  process.env.COMMONS_TEST_SECRET = "must-not-reach-the-launcher";
  cleanups.push(() => { delete process.env.COMMONS_TEST_SECRET; });
  const response = await s.control("start", { residents: ["gary"], end_at: end, model: "gpt-x", fresh: ["Gary"],
    caretaker: { enabled: false, interval: 30, speak: "on" }, note: "The bridge is fixed." });
  const reply = await response.json() as RunsReply;
  expect(response.status).toBe(200);
  expect(s.hubTools.starts()).toEqual([["Gary", `--end-at=${end}`, "--model=gpt-x", "--fresh=Gary", "--caretaker=off",
    "--caretaker-interval=30", "--caretaker-speak=on", "--note=The bridge is fixed.", "--by=switchyard", "--json"]]);
  const env = s.hubTools.env("start-run");
  expect(env).toContain(`GARY_CLIENT_HOME=${s.hubHome.dir}`);
  expect(env).not.toContain("COMMONS_TEST_SECRET");
  expect(reply).toMatchObject({ ok: true, code: "ok", end_at: end, hosts: [{ host: "inspiron", ok: true, code: "ok", activation: "20261123T170000Z-start-abc123",
    residents: [{ name: "Gary", result: "started", model: "gpt-x", mode: "fresh" }], caretaker: { result: "off" } }] });
});

test("invalid requests are refused before any launcher runs", async () => {
  const s = setup({ station: false });
  const now = Math.floor(Date.now() / 1000);
  const cases: [unknown, number, string][] = [
    [{ residents: ["Gary"], end_at: now - 10 }, 422, "in the past"],
    [{ residents: ["Gary"], end_at: now + 25 * 3600 }, 422, "more than 24 hours"],
    [{ residents: ["Gary"] }, 400, "exactly one of end_at"],
    [{ residents: ["Gary"], end_at: now + 60, end: "2026-11-24T01:00:00-05:00" }, 400, "exactly one of end_at"],
    [{ residents: ["Gary"], end: "2026-11-24 01:00" }, 400, "UTC offset"],
    [{ residents: ["Gary"], end_at: now + 60, shell: "rm -rf /" }, 400, "Invalid request"],
    [{ residents: ["Gary; reboot"], end_at: now + 60 }, 400, "Invalid request"],
    [{ residents: ["Gary"], end_at: now + 60, model: "--all" }, 400, "Invalid request"],
    [{ residents: ["Gary"], end_at: now + 60, models: { Gary: "-x" } }, 400, "Invalid request"],
    [{ residents: ["Gary"], end_at: now + 60, note: "two\nlines" }, 400, "Invalid request"],
    [{ residents: ["Wren"], end_at: now + 60 }, 404, "No resident named Wren"],
    [{ residents: ["Gary"], end_at: now + 60, models: { Margo: "gpt-x" } }, 400, "not being started"],
    [{ residents: [], end_at: now + 60 }, 400, "Invalid request"],
  ];
  for (const [body, status, words] of cases) {
    const response = await s.control("start", body);
    const reply = await response.json();
    expect([response.status, reply.error.includes(words)]).toEqual([status, true]);
  }
  const plain = await s.hub.fetch(new Request("http://hub.test/controller/v1/stop", { method: "POST", headers: { Authorization: `Bearer ${SWITCHYARD}`, "Content-Type": "text/plain" }, body: "{}" }));
  expect(plain.status).toBe(400);
  const large = await s.control("stop", { residents: ["Gary"], padding: "x".repeat(20_000) });
  expect(large.status).toBe(413);
  expect(s.hubTools.calls()).toEqual([]);
});

test("the launcher's own refusals keep their meaning: conflict, deadline, busy, gate", async () => {
  const s = setup({ station: false });
  const cases: [number, string, number][] = [[4, "conflict", 409], [3, "deadline", 422], [75, "busy", 429], [77, "gate", 403], [6, "systemd", 502], [5, "config", 422]];
  for (const [exit, code, status] of cases) {
    s.hubTools.answer("start-run", { ok: false, code, error: `refused: ${code}` }, exit);
    const response = await s.control("start", { residents: ["Gary"], end_at: soon() });
    const reply = await response.json() as RunsReply;
    expect([response.status, reply.code, reply.hosts[0].error]).toEqual([status, code, `refused: ${code}`]);
  }
  // A launcher that prints nothing readable is an error, never an ok.
  s.hubTools.answer("start-run", {}, 0);
  writeFileSync(join(s.hubTools.dir, "reply-start-run.json"), "not json");
  const garbled = await s.control("start", { residents: ["Gary"], end_at: soon() });
  expect([garbled.status, (await garbled.json()).ok]).toEqual([502, false]);
});

test("one mutating call at a time; a launcher that hangs is reported as unknown, not ok", async () => {
  const s = setup({ station: false });
  s.hubTools.answer("stop-run", { ok: true, code: "ok", residents: [{ name: "Gary", result: "stopped" }], caretaker: { result: "stopped" } }, 0, 1);
  // The first stop holds the host while its launcher runs (a real one-second process).
  const launched = new Promise<void>(resolve => { const watcher = watch(join(s.hubTools.dir, "calls"), () => { watcher.close(); resolve(); }); });
  const first = s.control("stop", { residents: "all" });
  await launched;
  const second = await s.control("start", { residents: ["Gary"], end_at: soon() });
  expect([second.status, (await second.json()).code]).toEqual([429, "busy"]);
  expect((await first).status).toBe(200);
  expect(s.hubTools.calls().map(c => c.slice(1))).toEqual([["--all", "--by=switchyard", "--json"]]);

  const tail = new RolloutTail(join(s.hubHome.dir, "none"), s.hubConfig.residents, {});
  const control = new RunControl(s.hubConfig, tail, undefined, { timeouts: { stop: 300 }, log: () => {} });
  cleanups.push(() => control.stop());
  // A real process that outlives a short deadline: the kill path is what is tested.
  s.hubTools.answer("stop-run", { ok: true, code: "ok" }, 0, 5);
  const slow = await control.handleController(new Request("http://hub.test/controller/v1/stop", {
    method: "POST", headers: { Authorization: `Bearer ${SWITCHYARD}`, "Content-Type": "application/json" }, body: '{"residents":["Gary"]}' }), "stop");
  const reply = await slow.json() as RunsReply;
  expect([slow.status, reply.ok, reply.code]).toEqual([504, false, "timeout"]);
  expect(reply.hosts[0].error).toContain("what it did is unknown");
});

test("the hub federates one start to every host with the same end time and each host's share of the options", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  const end = soon(120);
  s.hubTools.answer("start-run", { ok: true, code: "ok", host: "inspiron", id: "a1", residents: [{ name: "Gary", result: "started", mode: "resume", thread_id: "01a20685-ec8a-79f2-9bdc-22d2396153ae" }, { name: "Margo", result: "already_running" }], caretaker: { result: "started" } });
  s.station!.tools.answer("start-run", { ok: true, code: "ok", host: "chungus1", id: "b2", residents: [{ name: "Wren", result: "started", model: "gpt-w", mode: "resume" }, { name: "Tobin", result: "started", mode: "fresh" }], caretaker: { result: "started" } });
  const response = await s.control("start", { residents: "all", end_at: end, models: { Wren: "gpt-w", Gary: "gpt-g" }, fresh: ["tobin"], caretaker: { interval: 25 }, on_behalf_of: "daily_window" });
  const reply = await response.json() as RunsReply;
  expect(response.status).toBe(200);
  expect(s.hubTools.starts()).toEqual([["--all", `--end-at=${end}`, "--model=Gary=gpt-g", "--caretaker-interval=25", "--by=daily_window via switchyard", "--json"]]);
  expect(s.station!.tools.starts()).toEqual([["--all", `--end-at=${end}`, "--model=Wren=gpt-w", "--fresh=tobin", "--caretaker-interval=25",
    "--by=daily_window via switchyard via hub_inspiron", "--json"]]);
  expect(reply.hosts.map(h => [h.host, h.ok, h.residents.map(r => `${r.name}:${r.result}`)])).toEqual([
    ["inspiron", true, ["Gary:started", "Margo:already_running"]], ["chungus1", true, ["Wren:started", "Tobin:started"]]]);
  expect(JSON.stringify(reply)).not.toContain(STATION);

  // Named residents go only to their own host.
  s.station!.tools.answer("stop-run", { ok: true, code: "ok", residents: [{ name: "Wren", result: "stopped" }], caretaker: { result: "restarted", roster: ["Tobin:tobin"] } });
  const one = await s.control("stop", { residents: ["Wren"] });
  expect(one.status).toBe(200);
  expect(s.station!.tools.calls().filter(c => c[0] === "stop-run").map(c => c.slice(1))).toEqual([["Wren", "--by=switchyard via hub_inspiron", "--json"]]);
  expect(s.hubTools.calls().filter(c => c[0] === "stop-run")).toEqual([]);

  // The hub's read view lists both hosts.
  const runs = await (await s.hub.fetch(new Request(`http://hub.test/${HUB}/api/runs`))).json() as RunsReply;
  expect(runs.hosts.map(h => [h.host, h.ok, h.residents.map(r => r.name)])).toEqual([["inspiron", true, ["Gary", "Margo"]], ["chungus1", true, ["Wren", "Tobin"]]]);
});

test("a different end time anywhere refuses the whole start before anything starts", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  const other = soon(30);
  s.station!.tools.answer("run-status", hostStatus("chungus1", [{ ...idle("Wren") }, { ...idle("Tobin"), running: true, run_state: "active", end_at: other }]));
  const response = await s.control("start", { residents: ["Gary"], end_at: soon(90) });
  const reply = await response.json() as RunsReply;
  expect([response.status, reply.code]).toEqual([409, "conflict"]);
  expect(reply.error).toMatch(/^Tobin is already running until \d\d:\d\d on chungus1/);
  expect(reply.error).toContain("Nothing was started");
  expect(s.hubTools.starts()).toEqual([]);
  expect(s.station!.tools.starts()).toEqual([]);
  // The same end time joins the running hosts.
  s.hubTools.answer("start-run", { ok: true, code: "ok", residents: [{ name: "Gary", result: "started" }], caretaker: null });
  expect((await s.control("start", { residents: ["Gary"], end_at: other })).status).toBe(200);
});

test("partial failure is reported per host, never as one ok, and station secrets are scrubbed", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  s.hubTools.answer("start-run", { ok: true, code: "ok", residents: [{ name: "Gary", result: "started" }, { name: "Margo", result: "started" }], caretaker: { result: "started" } });
  s.station!.tools.answer("start-run", { ok: false, code: "systemd", error: `systemd-run failed near /${STATION}/ on 127.0.0.1:${s.station!.server.port}`,
    residents: [{ name: "Wren", result: "started" }, { name: "Tobin", result: "failed", error: "boom" }], caretaker: { result: "started" } }, 6);
  const response = await s.control("start", { residents: "all", end_at: soon() });
  const text = await response.text(), reply = JSON.parse(text) as RunsReply;
  expect([response.status, reply.ok, reply.code]).toEqual([207, false, "partial"]);
  expect(reply.hosts.map(h => [h.host, h.ok, h.code])).toEqual([["inspiron", true, "ok"], ["chungus1", false, "systemd"]]);
  expect(reply.hosts[1].residents.map(r => [r.name, r.result, r.error ?? null])).toEqual([["Wren", "started", null], ["Tobin", "failed", "boom"]]);
  expect(text).not.toContain(STATION);
  expect(text).not.toContain(String(s.station!.server.port));

  // An unreachable station: nothing started there, the hub's own host still answers.
  s.station!.server.stop(true);
  await s.hub.federation!.refresh();
  s.hubTools.answer("stop-run", { ok: true, code: "ok", residents: [{ name: "Gary", result: "stopped" }, { name: "Margo", result: "stopped" }], caretaker: { result: "stopped" } });
  const stop = await s.control("stop", { residents: "all" });
  const stopped = await stop.json() as RunsReply;
  expect([stop.status, stopped.code]).toEqual([207, "partial"]);
  expect(stopped.hosts[1]).toMatchObject({ host: "chungus1", ok: false, code: "unreachable", error: "station chungus1 unreachable: nothing was stopped there" } satisfies Partial<HostResult>);
  const onlyThere = await s.control("start", { residents: ["Wren"], end_at: soon() });
  expect([onlyThere.status, (await onlyThere.json()).error]).toEqual([502, "chungus1: station chungus1 unreachable: nothing was started there"]);
});

test("a station the hub holds no token for, or that refuses it, gets nothing and says so", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  s.hubTools.answer("stop-run", { ok: true, code: "ok", residents: [], caretaker: { result: "not_running" } });
  rmSync(join(s.hubHome.dir, "commons-data/controller-station-tokens/chungus1.token"));
  let reply = await (await s.control("stop", { residents: "all" })).json() as RunsReply;
  expect(reply.hosts[1]).toMatchObject({ host: "chungus1", ok: false, code: "not_configured" });
  expect(reply.hosts[1].error).toContain("nothing was stopped there");
  chmodSync(s.hubHome.put("commons-data/controller-station-tokens/chungus1.token", "some-other-token-0123456789abcdef"), 0o600);
  reply = await (await s.control("stop", { residents: "all" })).json() as RunsReply;
  expect(reply.hosts[1]).toMatchObject({ host: "chungus1", ok: false, code: "unauthorized", error: "station chungus1 refused the hub's controller token: nothing was stopped there." });
  expect(s.station!.tools.calls().filter(c => c[0] === "stop-run")).toEqual([]);
});

test("starts and stops recorded on this host appear in Activity with who asked", async () => {
  const s = setup({ station: false });
  const dir = join(s.hubHome.dir, "state", "activations");
  mkdirSync(dir, { recursive: true });
  const at = Math.floor(Date.now() / 1000) - 60, end = at + 3600;
  writeFileSync(join(dir, "20261123T120000Z-start-aaaaaa.json"), JSON.stringify({ schema: "residents-activation/1", id: "x", kind: "start", host: "inspiron", created_at: at,
    requested_by: "daily_window via switchyard", end_at: end, residents: [
      { name: "Gary", result: "started", model: "gpt-6.2-sol", mode: "resume", thread_id: "01a20685-ec8a-79f2-9bdc-22d2396153ae" },
      { name: "Margo", result: "failed", error: "boom" }, { name: "Wren", result: "started" }] }));
  writeFileSync(join(dir, "20261123T120100Z-stop-bbbbbb.json"), JSON.stringify({ schema: "residents-activation/1", id: "y", kind: "stop", host: "inspiron", created_at: at + 30,
    requested_by: "owner_dashboard", residents: [{ name: "Gary", result: "stopped" }, { name: "Margo", result: "not_running" }] }));
  const activity = await (await s.hub.fetch(new Request(`http://hub.test/${HUB}/api/activity`))).json() as { entries: { resident: string; type?: string; text?: string }[] };
  const runs = activity.entries.filter(e => e.type?.startsWith("run_")).map(e => [e.resident, e.type, e.text]);
  expect(runs).toContainEqual(["Gary", "run_started", expect.stringMatching(/^by daily_window via switchyard until \d\d:\d\d, gpt-6\.2-sol, resumed thread 01a20685/)]);
  expect(runs).toContainEqual(["Margo", "run_failed", "start by daily_window via switchyard failed: boom"]);
  expect(runs).toContainEqual(["Gary", "run_stopped", "by owner_dashboard"]);
  expect(runs.length).toBe(3); // Wren is not this host's resident; Margo's not_running stop is not news.
});

// ---------- the real launcher, with systemd stubbed ----------

const SYSTEMCTL = `#!/usr/bin/env python3
import json, os, shlex, sys
from pathlib import Path
p = Path(__file__).resolve().parent.parent / "units.json"; s = json.loads(p.read_text()) if p.exists() else {"units": {}}
a = sys.argv[2:]; blank = {"state": "inactive", "invocation": "", "env": {}, "argv": []}
if a[0] == "show":
    out = []
    for name in [x for x in a[1:] if not x.startswith("--")]:
        u = s["units"].get(name, blank)
        lines = [f"Id={name}", f"ActiveState={u['state']}", f"InvocationID={u['invocation']}", "Environment=" + " ".join(shlex.quote(f"{k}={v}") for k, v in u["env"].items())]
        if u["argv"]: lines.append(f"ExecStart={{ path={u['argv'][0]} ; argv[]={' '.join(u['argv'])} ; ignore_errors=no }}")
        out.append("\\n".join(lines))
    print("\\n\\n".join(out))
elif a[0] == "stop":
    for name in a[1:]: s["units"][name] = blank
p.write_text(json.dumps(s))
`;
const SYSTEMD_RUN = `#!/usr/bin/env python3
import json, os, sys, uuid
from pathlib import Path
p = Path(__file__).resolve().parent.parent / "units.json"; s = json.loads(p.read_text()) if p.exists() else {"units": {}}
a = sys.argv[1:]; env = {}; unit = None; i = 0
while i < len(a) and a[i].startswith("-"):
    if a[i] == "-p": i += 2; continue
    if a[i].startswith("--setenv="): k, _, v = a[i][9:].partition("="); env[k] = v
    if a[i].startswith("--unit="): unit = a[i][7:]
    i += 1
s["units"][unit] = {"state": "active", "invocation": uuid.uuid4().hex, "env": env, "argv": a[i:]}
s.setdefault("runs", []).append(a)
p.write_text(json.dumps(s))
`;

test("end to end with the real launcher: start, status, stop and Activity, systemd stubbed", async () => {
  const at = home();
  const bin = join(at.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), SYSTEMCTL); chmodSync(join(bin, "systemctl"), 0o755);
  writeFileSync(join(bin, "systemd-run"), SYSTEMD_RUN); chmodSync(join(bin, "systemd-run"), 0o755);
  at.put("resident/gary/AGENTS.md", "gary");
  at.put("sessions/Gary-health.json", JSON.stringify({ status: "stopped", thread_id: "01a20685-ec8a-79f2-9bdc-22d2396153ae" }));
  at.put("run.conf", 'HOST=inspiron\nRESIDENTS="Gary"\nDEFAULT_MODEL=gpt-6.2-sol\nCARETAKER=on\nCARETAKER_INTERVAL=25\n');
  credentials(at, [{ name: "switchyard", token: SWITCHYARD }]);
  // The launcher's environment is scrubbed to a fixed list; PATH is on it.
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  cleanups.push(() => { process.env.PATH = saved; });
  const config = at.config({ COMMONS_HOST_NAME: "inspiron", COMMONS_RUN_TOOLS: resolve(import.meta.dir, "../../tools"), RESIDENTS_STATE_DIR: join(at.dir, "state") });
  const app = createApp(config, HUB, Date.now, () => {});
  cleanups.push(() => app.stop());
  const call = (route: string, body?: unknown) => app.fetch(new Request(`http://hub.test/controller/v1/${route}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${SWITCHYARD}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

  const end = soon(30);
  const started = await call("start", { residents: ["Gary"], end_at: end });
  const reply = await started.json() as RunsReply;
  expect([started.status, reply.ok]).toEqual([200, true]);
  expect(reply.hosts[0].residents).toMatchObject([{ name: "Gary", result: "started", mode: "resume", model: "gpt-6.2-sol", thread_id: "01a20685-ec8a-79f2-9bdc-22d2396153ae" }]);
  const units = JSON.parse(readFileSync(join(at.dir, "units.json"), "utf8"));
  expect(units.runs[0]).toContain(`--setenv=SESSION_END_AT=${end}`);
  expect(units.runs[0].slice(-5)).toEqual([join(at.dir, "run-session.sh"), "Gary", "gary", "0", "gpt-6.2-sol"]);
  expect(units.runs[1].slice(-2)).toEqual(["25", "Gary:gary"]);

  // Same request again: idempotent.
  const again = await (await call("start", { residents: ["Gary"], end_at: end })).json() as RunsReply;
  expect(again.hosts[0].residents[0].result).toBe("already_running");
  const later = await call("start", { residents: ["Gary"], end_at: end + 600 });
  expect([later.status, (await later.json()).hosts[0].error]).toEqual([409, expect.stringMatching(/^Gary is already running until \d\d:\d\d/)]);

  const status = await (await call("runs")).json() as RunsReply;
  expect(status.hosts[0].residents[0]).toMatchObject({ name: "Gary", running: true, end_at: end, model: "gpt-6.2-sol", mode: "resume", started_by: "switchyard" });
  const stopped = await (await call("stop", { residents: "all" })).json() as RunsReply;
  expect(stopped.hosts[0]).toMatchObject({ ok: true, residents: [{ name: "Gary", result: "stopped" }], caretaker: { result: "stopped" } });

  const activity = await (await app.fetch(new Request(`http://hub.test/${HUB}/api/activity`))).json() as { entries: { resident: string; type?: string; text?: string }[] };
  expect(activity.entries.filter(e => e.type?.startsWith("run_")).map(e => [e.type, e.text?.split(" until")[0]]).sort()).toEqual([
    ["run_started", "by switchyard"], ["run_stopped", "by switchyard"]]);
});
