import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { createApp, type App } from "../src/app.ts";
import { overlaySecrets, overlayText } from "../src/overlay-data.ts";
import type { OverlaySnapshot } from "../src/overlay.ts";
import { fakeSynapse, serverLogLine, tempHome, type FakeSynapse, type Home } from "./helpers.ts";

const TOKEN = "onair-dashboard-generated-value";
let home: Home, app: App | undefined, fake: FakeSynapse | undefined;
const clock = Date.parse("2026-11-23T12:00:00Z");
beforeEach(() => { home = tempHome(); });
afterEach(() => { app?.stop(); app = undefined; fake?.stop(); fake = undefined; home.remove(); });
function start(env: Record<string, string> = {}) { app = createApp(home.config(env), TOKEN, () => clock, () => {}); return app; }
const get = (path = "api/overlay", signal?: AbortSignal) => app!.fetch(new Request(`http://commons.test/${TOKEN}/${path}`, { signal }));
async function snapshot() { return (await get()).json() as Promise<OverlaySnapshot>; }
const post = (body: unknown, headers: Record<string, string> = {}) => app!.fetch(new Request(`http://commons.test/${TOKEN}/api/overlay`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
function decode(chunk: Uint8Array | undefined): OverlaySnapshot {
  const event = new TextDecoder().decode(chunk);
  expect(event).toStartWith("event: snapshot\ndata: ");
  return JSON.parse(event.slice("event: snapshot\ndata: ".length).trim());
}

test("overlay pages, assets, presets and API require the existing exact URL token", async () => {
  start();
  for (const path of ["overlay", "overlay/control", "overlay/preview", "overlay.js", "overlay.css", "api/overlay", "api/overlay/events", "api/overlay/presets"]) {
    expect((await app!.fetch(new Request(`http://commons.test/wrong/${path}`))).status).toBe(404);
  }
  for (const path of ["overlay", "overlay/control", "overlay/preview", "overlay-core.js", "overlay-media.js"]) expect((await get(path)).status).toBe(200);
  for (const path of ["overlay/", "overlay/control/", "overlay/preview/"]) {
    const reply = await get(path); expect(reply.status).toBe(308); expect(reply.headers.get("Location")).toBe(`/${TOKEN}/${path.slice(0, -1)}`);
  }
  const presets = await (await get("api/overlay/presets?layout=1280x720")).json();
  expect(Object.keys(presets).sort()).toEqual(["building", "chat-heavy", "exploring"]);
  expect(presets.exploring.vitals.scale).toBeCloseTo(2 / 3);
  expect((await get("api/overlay/presets?layout=bad")).status).toBe(400);
  const initial = await snapshot();
  expect(initial.data.online).toBe(false); expect(initial.data.sampledAt).toBeNull();
  expect(initial.data.vitals).toBeNull(); expect(initial.data.position).toBeNull();
  expect(initial.residents).toEqual([{ name: "Gary", liveAvailable: false }]);
});

test("HTTP mutation has bounded streamed JSON, same-origin gating, strict fields and optimistic conflict", async () => {
  start(); const initial = await snapshot();
  expect((await post({ revision: 0, state: initial.state }, { Origin: "https://attacker.test" })).status).toBe(403);
  expect((await post({ revision: 0, state: initial.state }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post({ revision: 0, state: initial.state }, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await post({ revision: 0, state: initial.state, host: "bad" })).status).toBe(400);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(32_769))); controller.close(); } });
  const tooLarge = await app!.fetch(new Request(`http://commons.test/${TOKEN}/api/overlay`, { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit));
  expect(tooLarge.status).toBe(413);
  const changed = { ...initial.state, title: "Coastal walk", preset: "custom" };
  expect((await post({ revision: 0, state: changed }, { Origin: "http://commons.test", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  expect((await post({ revision: 0, state: changed })).status).toBe(409);
  expect((await snapshot()).state.title).toBe("Coastal walk");
  expect((await snapshot()).state.revision).toBe(1);
});

test("actual watcher, local plan, console, alarm, map and caretaker sources project safe on-air fields only", async () => {
  fake = fakeSynapse({ token: "s3cret" });
  fake.state.nearbyEntities = [{ player: true, name: "SPESK01" }, { player: true, name: "Margo" }];
  home.put("synapse-token", "s3cret");
  home.put("resident/gary/plan.json", JSON.stringify({ focus: "Coastal lights", plans: [{ name: "Coastal lights", goal: "PRIVATE GOAL", steps: [{ text: "Pack torches", state: "done", note: "PRIVATE NOTE" }, { text: "Ask Levi about lights", state: "doing" }] }], history: [{ name: "PRIVATE HISTORY" }] }));
  home.put("resident/gary/places.json", JSON.stringify({ places: [{ name: "Coast shelter", x: 100, y: 70, z: 20, dimension: "minecraft:overworld", note: "PRIVATE MAP NOTE" }] }));
  home.put("overseer/Gary.md", "## now\nNOTE: Place lights near Levi\nMAINTAINERS: PRIVATE MAINTAINERS\n");
  const config = home.config({ GARY_SYNAPSE_URL: fake.url });
  app = createApp(config, TOKEN, () => clock, () => {});
  await app.watcher.sample();
  for (const message of ["<Gary> Hello Levi", "<spesk01> Hidden speech", "<Margo> s3cret", `<Gary> ${TOKEN}`, "<Caretaker> INTERNAL CARETAKER", "[Server] INTERNAL SYSTEM", "<Gary> Walk to https://private.example/path"]) app.stream.addServer(serverLogLine(clock, message));
  app.stream.addServer("INTERNAL COMMAND", { mark: "command", t: clock });
  app.db.query("INSERT INTO resident_alarms(sender,bucket,at,event_json) VALUES(?,?,?,?)").run("Gary", "manual", clock, JSON.stringify({ sender: "Gary", reason: "Levi nearby", kind: "manual", at: clock, x: 1, y: 2, z: 3, dimension: "overworld", debug: "PRIVATE DEBUG" }));
  const data = (await snapshot()).data;
  expect(data.online).toBe(true); expect(data.sampledAt).toBe(clock); expect(data.vitals?.health).toBe(2.7);
  expect(data.vitals?.air).toBe(300);
  expect(data.position?.dimension).toBe("overworld");
  expect(data.plan).toEqual({ focus: "Coastal lights", next: "Ask [hidden] about lights" });
  expect(data.chat.some(line => line.text === "Hello [hidden]")).toBe(true);
  expect(data.chat.some(line => line.text === "[private]")).toBe(true);
  expect(data.nearby).toEqual([{ name: "Margo", distance: null }]);
  expect(data.map.points).toContainEqual({ name: "Coast shelter", x: 100, z: 20 });
  expect(data.map.trail.length).toBeGreaterThan(0);
  expect(data.alarms).toEqual([{ at: clock, text: "Gary: [hidden] nearby" }]);
  expect(data.caretaker).toBe("Place lights near [hidden]");
  const serialized = JSON.stringify(data);
  for (const denied of ["spesk01", "Levi", "s3cret", TOKEN, config.home, fake.url, "PRIVATE", "INTERNAL", "synapseUrl", "clientUnit", "seenBy", "debug", "maxAir", "hotbar"]) expect(serialized).not.toContain(denied);
  expect(Object.keys(data).sort()).toEqual(["alarms", "at", "caretaker", "chat", "map", "nearby", "nowPlaying", "online", "plan", "position", "resident", "sampledAt", "title", "vitals"].sort());
});

test("saved and SSE title/now-playing strings redact actual generated dashboard and configured token values", async () => {
  home.put("synapse-token", "s3cret"); start();
  const initial = await snapshot(); initial.state.title = `We use ${TOKEN}`; initial.state.nowPlaying = "s3cret";
  const response = await post({ revision: 0, state: initial.state });
  const saved = await response.json() as OverlaySnapshot;
  expect(saved.state.title).toBe("[private]"); expect(saved.state.nowPlaying).toBe("[private]");
  expect(saved.data.title).toBe("[private]"); expect(saved.data.nowPlaying).toBe("[private]");
  const stream = await get("api/overlay/events"), reader = stream.body!.getReader();
  const event = decode((await reader.read()).value);
  expect(event.state.title).toBe("[private]"); expect(JSON.stringify(event)).not.toContain(TOKEN); expect(JSON.stringify(event)).not.toContain("s3cret");
  await reader.cancel();
});

test("SSE sends initial, immediate mutation, periodic live changes and closes cleanly on stop", async () => {
  start();
  const response = await get("api/overlay/events"), reader = response.body!.getReader();
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const initial = decode((await reader.read()).value);
  const pending = reader.read();
  initial.state.title = "Night walk";
  expect((await post({ revision: 0, state: initial.state })).status).toBe(200);
  expect(decode((await pending).value).state.title).toBe("Night walk");
  app!.stream.addServer(serverLogLine(clock, "<Gary> New live speech"));
  expect(decode((await reader.read()).value).data.chat.at(-1)?.text).toBe("New live speech");
  const ended = reader.read(); app!.stop(); app = undefined;
  expect((await ended).done).toBe(true);
}, 5000);

test("SSE caps connections, releases cancellation and abort slots, and drops slow viewers", async () => {
  start(); const streams: Response[] = [];
  for (let i = 0; i < 8; i++) streams.push(await get("api/overlay/events"));
  expect((await get("api/overlay/events")).status).toBe(429);
  await streams.pop()!.body!.cancel();
  const abort = new AbortController(), aborted = await get("api/overlay/events", abort.signal); streams.push(aborted);
  expect(aborted.status).toBe(200); abort.abort();
  const extra = await get("api/overlay/events"); expect(extra.status).toBe(200); streams.push(extra);
  // All remaining streams still have the initial event queued: one more update closes them.
  const initial = await snapshot(); initial.state.title = "Update";
  await post({ revision: 0, state: initial.state });
  const reopened = await get("api/overlay/events"); expect(reopened.status).toBe(200);
  await reopened.body!.cancel();
  for (const stream of streams) await stream.body!.cancel();
});

test("corrupt persisted overlay is a safe explicit failure without taking Commons down", async () => {
  const config = home.config(); home.put("commons/commons.sqlite.overlay.json", "{broken");
  app = createApp(config, TOKEN, () => clock, () => {});
  const reply = await get(); expect(reply.status).toBe(503);
  expect(await reply.text()).not.toContain(config.dbPath);
  expect((await get("api/residents")).status).toBe(200);
  expect(readFileSync(`${config.dbPath}.overlay.json`, "utf8")).toBe("{broken");
});

test("station snapshots use real local sources and never claim remote video support", async () => {
  start({ COMMONS_ROLE: "station" });
  const answer = await snapshot();
  expect(answer.residents).toEqual([{ name: "Gary", liveAvailable: false }]);
  expect(answer.data.alarms).toEqual([]);
  expect((await get("api/live/status")).status).toBe(404);
});

test("privacy fails closed for URLs, addresses, hostnames, paths, credentials and secret encodings", () => {
  for (const text of ["https://example.invalid/a", "192.168.1.1", "fe80::1234", "new-machine.local", "otherbox:8770", "/home/user/private", "notes/credentials.json", "Bearer abc", "token=abc", "password: abc", "a".repeat(64), "superSensitiveValue"]) expect(overlayText(text, [], ["superSensitiveValue"])).toBe("[private]");
  expect(overlayText("Hello LEVI and spesk01", ["Levi", "spesk01"], [])).toBe("Hello [hidden] and [hidden]");
});

test("known configured host, station URL tokens and symlinked short bearer values are redacted", () => {
  const target = home.put("short-token", "xy\n");
  const link = `${home.dir}/symlink-token`; symlinkSync(target, link);
  home.put("commons-data/stations.json", JSON.stringify([{ url: "http://remote-machine:8770/abcdefgh/" }]));
  const secrets = overlaySecrets(home.config({ SYNAPSE_TOKEN_FILE: link, COMMONS_HOST_NAME: "onair-machine" }), TOKEN);
  for (const value of ["xy", "onair-machine", "remote-machine", "abcdefgh", TOKEN]) expect(overlayText(`Here is ${value}`, [], secrets)).toBe("[private]");
});

test("compressed IPv6 addresses never escape the on-air redactor", () => {
  for (const value of ["::1", "[::1]", "::", "2001:db8::1234"]) expect(overlayText(value, [], [])).toBe("[private]");
});
