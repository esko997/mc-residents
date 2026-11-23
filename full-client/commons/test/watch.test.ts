import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { buildWatchList, offlineUuid, WatchPush } from "../src/watch.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** A stand-in server bridge holding a watch list in memory, as 0.3 does: empty after each (re)start. */
function bridge() {
  const state = { bootId: "boot-1", watch: null as null | { revision: string; residents: { name: string; uuid: string }[]; facilities: { id: string; label: string; dimension: string; pos: number[]; side: string | null }[] }, puts: 0, gets: 0, refuse: false, defer: false };
  const reply = (body: object, status = 200) => Response.json({ schema: 1, source: "server-observer", consumer: "commons", scopes: ["watch", "status"], state: "ok", stateDetail: null, servedAtMs: Date.now(), heartbeatAtMs: null, ...body }, { status });
  const current = () => ({ watch: { revision: state.watch?.revision ?? null, residents: state.watch?.residents ?? [], facilities: state.watch?.facilities ?? [], appliedAtMs: null, bootId: state.bootId } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/watch") return reply({ error: { code: "not_found", message: "no" } }, 404);
    if (request.headers.get("authorization") !== "Bearer bridge-token") return reply({ error: { code: "unauthorized", message: "token" } }, 401);
    if (request.method === "PUT") {
      if (state.refuse) return reply({ error: { code: "forbidden", message: "scope watch required" } }, 403);
      state.puts++;
      if (state.defer) return reply(current(), 202);
      state.watch = await request.json() as typeof state.watch;
      return reply(current());
    }
    state.gets++;
    return reply(current());
  } });
  cleanups.push(() => server.stop(true));
  return { state, url: server.url.toString().replace(/\/$/, ""), restart() { state.bootId = `boot-${Number(state.bootId.slice(5)) + 1}`; state.watch = null; } };
}

function database() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  db.exec(readFileSync(join(import.meta.dir, "../schema.sql"), "utf8"));
  return db;
}
const facility = (db: Database, name: string, x: number, dimension = "minecraft:overworld") =>
  db.query("INSERT INTO facilities (name, purpose, capabilities_json, x, y, z, dimension, steward, access_terms, created_at, updated_at) VALUES (?, 'p', '[]', ?, 64.7, -3.2, ?, 'Gary', 'open', 1, 1)").run(name, x, dimension);

test("offline UUIDs are the server's (name-based MD5, version 3), and the list is what the bridge accepts", () => {
  expect(offlineUuid("Notch")).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
  const db = database();
  facility(db, "Mill", 10.6);
  facility(db, "Mill chest", 10.2); // the same block as the mill
  facility(db, "Old", 5, "Overworld?");
  facility(db, "Forge", -20, "the_nether");
  const list = buildWatchList(db, ["Margo", "Gary", "gary", "a-bad-name", "Wren"]);
  expect(list.residents.map(r => r.name)).toEqual(["Gary", "Margo", "Wren"]);
  expect(list.facilities).toEqual([
    { id: "facility-1", label: "Mill", dimension: "minecraft:overworld", pos: [10, 64, -4], side: null },
    { id: "facility-4", label: "Forge", dimension: "minecraft:the_nether", pos: [-20, 64, -4], side: null },
  ]);
  expect(list.left).toEqual(["facility #2: same block as an earlier facility", "facility #3: not a valid place"]);
  expect(buildWatchList(db, ["Wren", "Gary", "Margo"]).revision).toBe(list.revision);
});

test("the watch list is pushed at start, on a change, and again when the bridge restarted; never when identities are unreadable", async () => {
  const b = bridge(), db = database(), dir = tempHome(); cleanups.push(dir.remove);
  const tokenFile = dir.put("bridge.token", "bridge-token");
  let names: string[] | null = ["Gary", "Margo"];
  const logged: string[] = [];
  const watch = new WatchPush(db, { url: b.url, tokenFile }, { residents: () => names, log: line => logged.push(line) });
  await watch.pass();
  expect(b.state).toMatchObject({ puts: 1, watch: { residents: [{ name: "Gary", uuid: offlineUuid("Gary") }, { name: "Margo", uuid: offlineUuid("Margo") }], facilities: [] } });
  await watch.pass();
  expect(b.state.puts).toBe(1);
  facility(db, "Mill", 10);
  watch.nudge();
  await watch.pass();
  expect(b.state.puts).toBe(2);
  expect(b.state.watch?.facilities.map(f => f.id)).toEqual(["facility-1"]);
  b.restart();
  await watch.pass();
  expect(b.state.puts).toBe(3);
  expect(b.state.watch?.residents).toHaveLength(2);
  expect(watch.health()).toMatchObject({ status: "ok", bootId: "boot-2" });
  names = null;
  b.restart();
  await watch.pass();
  expect(b.state.puts).toBe(3);
  expect(watch.health()).toMatchObject({ status: "error", detail: "the resident identities could not be read; the bridge keeps its current list" });
  names = ["Gary"]; b.state.refuse = true;
  await watch.pass();
  expect(watch.health().detail).toContain("the hub's token needs the watch scope");
  expect(logged.filter(line => line.includes("watch scope"))).toHaveLength(1);
});

test("an accepted but unapplied watch revision is not reported as installed", async () => {
  const b = bridge(), db = database(), dir = tempHome(); cleanups.push(dir.remove);
  const tokenFile = dir.put("bridge.token", "bridge-token");
  const watch = new WatchPush(db, { url: b.url, tokenFile }, { residents: () => ["Gary"], log: () => {} });
  b.state.defer = true;
  await watch.pass();
  expect(watch.health()).toMatchObject({ status: "error", revision: null, pushedAt: null });
  expect(watch.health().detail).toContain("has not applied");
  b.state.defer = false;
  await watch.pass();
  expect(watch.health()).toMatchObject({ status: "ok", revision: b.state.watch?.revision });
});

/** A hub on Inspiron with two local bodies (Gary, Margo), two station bodies (Wren, Tobin) on a station that does not answer. */
function hubApp(b: ReturnType<typeof bridge>): { app: App; config: Config; tokens: Record<string, string> } {
  const home = tempHome(); cleanups.push(home.remove);
  home.put("instances/Margo.env", "GAME_DIR=/nonexistent\n");
  home.put("resident/margo/memory.md", "");
  home.put("bridge.token", "bridge-token");
  const stations = home.put("commons-data/stations.json", JSON.stringify([{ host: "chungus1", url: "http://127.0.0.1:9/station-token/" }]));
  const tokens: Record<string, string> = {};
  const entries = ["Gary", "Margo", "Wren", "Tobin", "caretaker"].map(name => {
    tokens[name] = `token-${name}-0123456789`;
    return { name, role: name === "caretaker" ? "caretaker" : "resident", sha256: createHash("sha256").update(tokens[name]!).digest("hex") };
  });
  const credentials = home.put("commons-data/credentials.json", JSON.stringify(entries));
  for (const file of [stations, credentials]) chmodSync(file, 0o600);
  const config = home.config({ COMMONS_HOST_NAME: "inspiron", COMMONS_OBSERVER_URL: b.url, COMMONS_OBSERVER_TOKEN_FILE: join(home.dir, "bridge.token"), COMMONS_OBSERVER_INGEST: "off" });
  const app = createApp(config, "dashboard-token-123", Date.now, () => {});
  cleanups.push(() => app.stop());
  return { app, config, tokens };
}

test("the hub pushes every resident identity, local and station alike, while the station is unreachable; a new facility is pushed at once", async () => {
  const b = bridge(), { app, config, tokens } = hubApp(b);
  // Only Gary and Margo run on this host; Wren and Tobin's station is listed but does not answer.
  expect(config.residents.map(r => r.name)).toEqual(["Gary", "Margo"]);
  await app.federation!.refresh();
  expect(app.federation!.controlStations()).toMatchObject([{ host: "chungus1", unreachable: true, names: [] }]);
  await app.watch!.pass();
  expect(b.state.watch?.residents.map(r => r.name)).toEqual(["Gary", "Margo", "Tobin", "Wren"]);
  expect(b.state.watch?.residents.find(r => r.name === "Wren")?.uuid).toBe(offlineUuid("Wren"));
  const response = await app.fetch(new Request("http://hub/resident-api/v1/society/register", {
    method: "POST", headers: { Authorization: `Bearer ${tokens.Tobin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ args: { name: "Mill library", purpose: "books", capabilities: ["reading"], x: 100.5, y: 64, z: -200.5, dimension: "minecraft:overworld", access_terms: "open" } }),
  }));
  expect(response.status).toBe(200);
  await app.watch!.pass();
  expect(b.state.watch?.facilities).toEqual([{ id: "facility-1", label: "Mill library", dimension: "minecraft:overworld", pos: [100, 64, -201], side: null }]);
  expect(b.state.puts).toBe(2);
});
