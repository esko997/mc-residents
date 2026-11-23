import { afterEach, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { Federation } from "../src/federation.ts";
import { recordPosition } from "../src/positions.ts";
import type { Routes } from "../src/routes/context.ts";
import type { ResidentsReply } from "../src/routes/residents.ts";
import type { MapReply } from "../src/routes/map.ts";
import type { ActivityReply, ThoughtsReply } from "../src/routes/activity.ts";
import { callLine, fakeSynapse, png, rollout, tempHome, type Home } from "./helpers.ts";

const TOKEN = "station-test-token";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function home(): Home {
  const value = tempHome(); cleanups.push(() => value.remove()); return value;
}
function appAt(root: Home, env: Record<string, string> = {}): App {
  const app = createApp(root.config(env), TOKEN, () => clock, () => {});
  cleanups.push(() => app.stop()); return app;
}
let clock = 1_790_000_000_000;
const request = (app: App, path: string, method = "GET") => app.fetch(new Request(`http://fixture/${TOKEN}/api/${path}`, { method }));

function stationHome(name = "Wren") {
  const root = home();
  rmSync(join(root.dir, "resident/gary"), { recursive: true });
  root.put(`instances/${name}.env`, "SYNAPSE_URL=http://127.0.0.1:9\n");
  root.put(`resident/${name.toLowerCase()}/memory.md`, `# ${name}\nRemote memory.\n`);
  root.put(`resident/${name.toLowerCase()}/notes/food.md`, "Pantry is full.\n");
  root.put(`overseer/${name}.md`, "## 2026-11-22\nNOTE: Check the pantry.\nMAINTAINERS: none\n");
  return root;
}

function setup(name = "Wren", options: { timeoutMs?: number; rewriteMap?: (data: MapReply) => unknown } = {}) {
  const remoteHome = stationHome(name);
  const remote = appAt(remoteHome, { COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1" });
  const counts = new Map<string, number>();
  let down = false, slow = false;
  const image = png();
  const pictureId = "a".repeat(64);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    counts.set(url.pathname + url.search, (counts.get(url.pathname + url.search) ?? 0) + 1);
    if (slow) return new Promise<Response>(() => {});
    if (down) return new Response("station unavailable", { status: 503 });
    if (url.pathname.endsWith("/picture") || url.pathname.endsWith("/map-picture")) return new Response(image, { headers: { "Content-Type": "image/png" } });
    if (url.pathname.endsWith("/map")) {
      const data = await (await remote.fetch(req)).json() as MapReply;
      for (const place of data.places) place.picture = { id: pictureId, resident: name, at: clock };
      return Response.json(options.rewriteMap ? options.rewriteMap(data) : data);
    }
    return remote.fetch(req);
  } });
  cleanups.push(() => server.stop(true));
  const localHome = home();
  // Exercise one federation wrapper, not the embedded app's wrapper a second time.
  const local = appAt(localHome, { COMMONS_HOST_NAME: "inspiron", COMMONS_STATIONS_FILE: join(localHome.dir, "no-stations.json") });
  const stationsFile = localHome.put("commons-data/stations.json", JSON.stringify([{ host: "chungus1", url: `http://127.0.0.1:${server.port}/${TOKEN}/` }]));
  chmodSync(stationsFile, 0o600);
  const federation = new Federation(localHome.config({ COMMONS_HOST_NAME: "inspiron" }), () => clock, options);
  cleanups.push(() => federation.stop());
  const localRoutes: Routes = {};
  for (const route of ["residents", "map", "activity", "notes", "file", "picture", "map-picture", "commons", "thoughts"]) {
    localRoutes[`GET ${route}`] = async ask => {
      const response = await request(local, `${route}?${ask.query}`);
      return response.ok && response.headers.get("Content-Type")?.includes("application/json") ? response.json() : response;
    };
  }
  const routes = federation.wrap(localRoutes);
  async function get<T>(route: string, query = ""): Promise<T> {
    const answer = await routes[`GET ${route}`]({ query: new URLSearchParams(query), body: async () => ({}) });
    return answer as T;
  }
  return { local, remote, localHome, remoteHome, federation, get, counts, stationsFile, pictureId, image,
    setDown: (value: boolean) => { down = value; }, setSlow: () => { slow = true; } };
}

test("station serves only local reads and samples positions without shared tables", async () => {
  const root = stationHome();
  const fake = fakeSynapse({ token: "fixture-secret" });
  cleanups.push(() => fake.stop());
  root.put("synapse-token", "fixture-secret");
  root.put("instances/Wren.env", `SYNAPSE_URL=${fake.url}\n`);
  root.put("resident/shared/places.json", JSON.stringify({ places: [{ name: "must not read", x: 1, y: 2, z: 3, dimension: "overworld" }] }));
  const station = appAt(root, { COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1", COMMONS_AUTO_ACCEPT: "1", CONSOLE_URL: "http://127.0.0.1:9/unused/", COMMONS_LIVE: "1" });
  await station.watcher.sample();
  const residents = await (await request(station, "residents")).json() as ResidentsReply;
  expect(residents.residents.map(r => r.name)).toEqual(["Wren"]);
  expect(residents.residents[0]).toMatchObject({ host: "chungus1", liveAvailable: false, status: "online" });
  expect(station.db.query("SELECT * FROM positions").all()).toHaveLength(1);
  expect(station.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)).toEqual(["positions"]);
  for (const [route, method] of [["commons", "GET"], ["review", "POST"], ["console", "GET"], ["command", "POST"], ["notes?resident=Wren", "POST"]]) {
    expect((await request(station, route, method)).status).toBe(404);
  }
  // A station serves its own Live API (for the hub's proxy); without its own opt-in it is disabled.
  expect(await (await request(station, "live/status")).json()).toMatchObject({ enabled: false, state: "disabled", host: "chungus1" });
  const watch = await station.fetch(new Request(`http://fixture/${TOKEN}/api/live/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"resident":"Wren"}' }));
  expect(watch.status).toBe(503);
  const api = await station.fetch(new Request("http://fixture/resident-api/v1/caretaker/digest?resident=Wren"));
  expect(api.status).toBe(404);
  const notes = await (await request(station, "notes?resident=Wren")).json();
  expect(notes.memory.text).toContain("Remote memory");
  expect(notes.shared.places).toEqual([]);
  expect(notes.caretaker[0].note).toContain("pantry");
  expect((await (await request(station, "map")).json()).places).toEqual([]);
  expect((await request(station, "picture?resident=Wren")).headers.get("Content-Type")).toBe("image/png");
});

test("hub merges residents, activity cursors, trails, private places and caretaker notes; scoped reads forward", async () => {
  const s = setup();
  s.remoteHome.put("resident/wren/places.json", JSON.stringify({ places: [{ name: "Pantry", x: 4, y: 65, z: 8, dimension: "overworld" }] }));
  s.remoteHome.put("calls/Wren.jsonl", callLine(clock - 1000, "say", { text: "Remote hello" }, "Said Remote hello.") + "\n");
  s.localHome.put("calls/Gary.jsonl", callLine(clock - 2000, "say", { text: "Local hello" }, "Said Local hello.") + "\n");
  recordPosition(s.remote.db, "Wren", clock - 1000, { x: 4, y: 65, z: 8, dimension: "overworld" });
  await s.federation.refresh();
  const residents = await s.get<ResidentsReply>("residents");
  expect(residents.residents.map(r => [r.name, r.host])).toEqual([["Gary", "inspiron"], ["Wren", "chungus1"]]);
  expect(residents.residents[1].liveAvailable).toBe(false);
  await s.get("activity"); await s.get("map", "hours=24"); await s.get("commons");
  await s.federation.refresh();
  const activity = await s.get<ActivityReply>("activity");
  expect(new Set(activity.entries.map(e => e.resident))).toEqual(new Set(["Gary", "Wren"]));
  expect(new Set(activity.entries.map(e => e.id)).size).toBe(activity.entries.length);
  const next = await s.get<ActivityReply>("activity", new URLSearchParams({ boot: activity.boot, after: String(Math.max(...activity.entries.map(e => e.id))) }).toString());
  expect(next.entries).toEqual([]);
  const map = await s.get<MapReply>("map", "hours=24");
  expect(map.residents.find(r => r.name === "Wren")?.legs).toEqual([{ dimension: "overworld", points: [[clock - 1000, 4, 65, 8, null]] }]);
  expect(map.places[0].owner).toBe("Wren");
  expect(map.places[0].picture?.id).toBe(`station:chungus1:${s.pictureId}`);
  const commons = await s.get<{ caretaker: { resident: string; entries: unknown[] }[] }>("commons");
  expect(commons.caretaker.find(c => c.resident === "Wren")?.entries).toHaveLength(1);
  const notes = await s.get<{ memory: { text: string } }>("notes", "resident=Wren");
  expect(notes.memory.text).toContain("Remote memory");
  const file = await s.get<Response>("file", "resident=Wren&path=notes%2Ffood.md");
  expect((await file.json()).text).toContain("Pantry is full");
  for (const [route, query] of [["picture", "resident=Wren"], ["map-picture", `id=station:chungus1:${s.pictureId}`]]) {
    const response = await s.get<Response>(route, query);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(s.image);
  }
  await s.get("residents"); await s.federation.refresh();
  expect(s.counts.get(`/${TOKEN}/api/residents`)).toBe(1);
  expect(s.counts.get(`/${TOKEN}/api/notes?resident=Wren`)).toBe(1);
});

test("a station's dimensions, heights, sky light and crossings reach the hub map unchanged", async () => {
  const s = setup();
  s.remoteHome.put("resident/wren/places.json", JSON.stringify({ places: [{ name: "Nether hub", x: 25, y: 59, z: -22, dimension: "minecraft:the_nether" }],
    deaths: [{ x: 30, y: 40, z: -20, dimension: "minecraft:the_nether", at: clock - 2000 }] }));
  recordPosition(s.remote.db, "Wren", clock - 20_000, { x: 201.5, y: 53, z: -96.5, dimension: "minecraft:overworld", sky: 15 });
  recordPosition(s.remote.db, "Wren", clock - 10_000, { x: 24.5, y: 59, z: -21.5, dimension: "minecraft:the_nether", sky: 0 });
  await s.get("map", "hours=1"); await s.federation.refresh();
  const map = await s.get<MapReply>("map", "hours=1");
  const wren = map.residents.find(r => r.name === "Wren")!;
  expect(wren).toMatchObject({ host: "chungus1", samples: 2,
    legs: [{ dimension: "overworld", points: [[clock - 20_000, 202, 53, -96, 15]] }, { dimension: "the_nether", points: [[clock - 10_000, 25, 59, -21, 0]] }],
    crossings: [{ at: clock - 10_000, from: { dimension: "overworld", x: 202, y: 53, z: -96 }, to: { dimension: "the_nether", x: 25, y: 59, z: -21 }, kind: "portal" }] });
  expect(map.places.find(p => p.owner === "Wren")).toMatchObject({ name: "Nether hub", dimension: "the_nether" });
  expect(map.deaths).toEqual([{ resident: "Wren", x: 30, y: 40, z: -20, dimension: "the_nether", at: clock - 2000 }]);
  expect(map.alarms).toEqual([]);
});

test("an older station's flat overworld trail is not drawn as if it had heights", async () => {
  const s = setup("Wren", { rewriteMap: data => ({ ...data, alarms: undefined, deaths: [{ resident: "Wren", x: 1, y: 2, z: 3, at: clock }],
    residents: data.residents.map(({ legs: _legs, crossings: _crossings, samples: _samples, ...r }) => ({ ...r, trail: [[clock - 1000, 4, 8]], dimension: "overworld" })) }) });
  recordPosition(s.remote.db, "Wren", clock - 1000, { x: 4, y: 65, z: 8, dimension: "overworld" });
  await s.get("map", "hours=1"); await s.federation.refresh();
  const map = await s.get<MapReply>("map", "hours=1");
  expect(map.residents.find(r => r.name === "Wren")).toMatchObject({ legs: [], crossings: [], samples: 0, dimension: "overworld" });
  expect(map.deaths).toEqual([{ resident: "Wren", x: 1, y: 2, z: 3, at: clock, dimension: "overworld" }]);
});

test("a station resident's thoughts reach the hub: newest on its card, the latest 200 through the hub's cached read", async () => {
  const s = setup();
  const day = new Date(clock).toISOString().slice(0, 10).replaceAll("-", "/");
  s.remoteHome.put(`codex-home/sessions/${day}/rollout-wren.jsonl`, [
    rollout.meta(clock - 60_000, join(s.remoteHome.dir, "resident", "wren")),
    ...rollout.reasoning(clock - 50_000, ["**Stocking the pantry**", "Bread first, then the carrots."]),
    ...rollout.call(clock - 45_000, "craft", { item: "bread" }, "Crafted 1 bread."),
    rollout.remark(clock - 40_000, "Pantry has bread now."),
  ].join("\n") + "\n");
  await s.federation.refresh();
  const residents = await s.get<ResidentsReply>("residents");
  const wren = residents.residents.find(r => r.name === "Wren")!;
  expect(wren.host).toBe("chungus1");
  expect(wren.thoughts).toEqual({ summaries: "on", latest: { t: clock - 40_000, kind: "remark", text: "Pantry has bread now." } });
  expect(residents.residents.find(r => r.name === "Gary")!.thoughts).toEqual({ summaries: "unknown", latest: null });

  const thoughts = await s.get<Response>("thoughts", "resident=Wren");
  const body = await thoughts.json() as ThoughtsReply;
  expect(body).toMatchObject({ resident: "Wren", summaries: "on" });
  expect(body.thoughts.map(t => `${t.kind}: ${t.text}`)).toEqual(["remark: Pantry has bread now.", "thought: **Stocking the pantry**\n\nBread first, then the carrots."]);
  // Cached like the other scoped station reads: a second read within five seconds does not ask the station again.
  await s.get("thoughts", "resident=Wren");
  expect(s.counts.get(`/${TOKEN}/api/thoughts?resident=Wren`)).toBe(1);
  // Activity interleaves them with what Wren did, on the hub's cursor.
  await s.get("activity"); await s.federation.refresh();
  const activity = await s.get<ActivityReply>("activity");
  expect(activity.entries.filter(e => e.resident === "Wren").map(e => e.kind)).toEqual(["remark", "call", "thought"]);
  expect(activity.residents.find(r => r.name === "Wren")!.sessions[0].summaries).toBe("on");
  // A local resident is answered locally; an unknown one is not found.
  expect((await s.get<ThoughtsReply>("thoughts", "resident=Gary")).thoughts).toEqual([]);
  expect((await s.get<Response>("thoughts", "resident=Nobody")).status).toBe(404);
});

test("unreachable station retains its residents and last success while local requests never await its timeout", async () => {
  const s = setup("Wren", { timeoutMs: 1000 });
  await s.federation.refresh();
  const lastSeen = clock;
  clock += 6000; s.setDown(true);
  await s.federation.refresh();
  let residents = await s.get<ResidentsReply>("residents");
  expect(residents.residents.find(r => r.name === "Wren")).toMatchObject({ hostUnreachable: true, hostLastSeen: lastSeen, detail: "host unreachable" });
  expect(residents.federationErrors.join(" ")).toContain("chungus1: host unreachable");
  clock += 6000; s.setSlow();
  let finished = false;
  const refresh = s.federation.refresh().then(() => { finished = true; });
  residents = await s.get<ResidentsReply>("residents");
  expect(residents.residents[0].name).toBe("Gary");
  const local = await s.get<object>("notes", "resident=Gary");
  expect(local).not.toBeInstanceOf(Response);
  expect(finished).toBe(false);
  await refresh;
  expect((await s.get<ResidentsReply>("residents")).residents).toHaveLength(2);
});

test("last discovered names survive a hub restart while a station is unreachable", async () => {
  const s = setup();
  await s.federation.refresh();
  const seen = clock;
  s.federation.stop();
  s.setDown(true);
  const restarted = new Federation(s.localHome.config({ COMMONS_HOST_NAME: "inspiron" }), () => clock);
  cleanups.push(() => restarted.stop());
  await restarted.refresh();
  const routes = restarted.wrap({ "GET residents": async () => (await request(s.local, "residents")).json() });
  const reply = await routes["GET residents"]({ query: new URLSearchParams(), body: async () => ({}) }) as ResidentsReply;
  expect(reply.residents.find(r => r.name === "Wren")).toMatchObject({ hostUnreachable: true, hostLastSeen: seen });
  const roster = await Bun.file(`${s.localHome.config().dbPath}.station-roster.json`).text();
  expect(roster).toContain("Wren");
  expect(roster).not.toContain(TOKEN);
});

test("case-insensitive duplicate names are visible and ambiguous reads are rejected", async () => {
  const s = setup("gArY");
  await s.federation.refresh();
  const residents = await s.get<ResidentsReply>("residents");
  expect(residents.federationErrors.join(" ")).toContain('Duplicate resident name "gary"');
  expect(residents.residents).toHaveLength(2);
  expect(residents.residents.every(r => !r.liveAvailable)).toBe(true);
  const response = await s.get<Response>("notes", "resident=GARY");
  expect(response.status).toBe(409);
});

test("stations config reloads without restart and rejects unsafe permissions without leaking secrets", async () => {
  const s = setup();
  const content = await Bun.file(s.stationsFile).text();
  writeFileSync(s.stationsFile, "[]", { mode: 0o600 });
  await s.federation.refresh();
  expect((await s.get<ResidentsReply>("residents")).residents).toHaveLength(1);
  writeFileSync(s.stationsFile, content);
  await s.federation.refresh();
  expect((await s.get<ResidentsReply>("residents")).residents).toHaveLength(2);
  chmodSync(s.stationsFile, 0o644);
  await s.federation.refresh();
  const errors = (await s.get<ResidentsReply>("residents")).federationErrors.join(" ");
  expect(errors).toContain("mode-600");
  expect(errors).not.toContain(TOKEN);
  rmSync(s.stationsFile);
  await s.federation.refresh();
  expect((await s.get<ResidentsReply>("residents")).residents).toHaveLength(1);
});
