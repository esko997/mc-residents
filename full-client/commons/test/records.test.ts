import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleLine } from "../src/console.ts";
import type { ObserverReach } from "../src/observer.ts";
import { createRecords } from "../src/records.ts";
import { RecordsIngest } from "../src/records-ingest.ts";
import { createSocietyStore } from "../src/resident-society.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const T = Date.UTC(2026, 10, 23, 12), minute = 60_000, hour = 60 * minute;
function database() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(join(import.meta.dir, "../schema.sql"), "utf8"));
  return db;
}
const event = (db: Database, at: number, type: string, resident: string, detail: string | null = null, seq = at) =>
  db.query("INSERT INTO history_server_events (at, seq, type, resident, detail) VALUES (?,?,?,?,?)").run(at, seq, type, resident, detail);
let id = 0;
const chat = (t: number, text: string, extra: Partial<ConsoleLine> = {}): ConsoleLine => ({ id: ++id, rev: id, t, source: "server", kind: /^<|^\[Server\]/.test(text) ? "chat" : "players", text, ...extra });

test("sessions, crossings and deaths come from the server's own events, with chat causes and statistics for older deaths", () => {
  const db = database();
  event(db, T - 2 * hour, "resident_online", "Gary", "minecraft:overworld");
  event(db, T - hour, "resident_dimension", "Gary", "minecraft:overworld -> minecraft:the_nether");
  event(db, T - 50 * minute, "resident_died", "Gary", "minecraft:the_nether");
  event(db, T - 30 * minute, "resident_offline", "Gary");
  event(db, T - 20 * minute, "resident_online", "Margo", "minecraft:overworld");
  // Before the events were kept, Margo's death count rose between two saves of her stats file.
  for (const [at, value] of [[T - 5 * hour, 1], [T - 4 * hour, 2]] as const) {
    db.query("INSERT INTO server_stat_values (resident, type, key, saved_at, value) VALUES ('Margo','minecraft:custom','minecraft:deaths',?,?)").run(at, value);
  }
  const lines = [chat(T - 50 * minute + 2000, "Gary was slain by Blaze")];
  const records = createRecords(db, "Tobin", { now: () => T, chat: () => lines, residents: () => ["Gary", "Margo", "Tobin"] });
  const sessions = records({ kind: "sessions" });
  expect(sessions).toContain("Gary online 2026-11-23 10:00 UTC -> 2026-11-23 11:30 UTC (1 h 30 min) [server]");
  expect(sessions).toContain("Margo online 2026-11-23 11:40 UTC -> still online [server]");
  expect(sessions).toContain("Sessions are recorded since 2026-11-23 10:00 UTC.");
  expect(records({ kind: "crossings", resident: "gary" })).toContain("Gary went minecraft:overworld -> minecraft:the_nether [server; how (portal, death, other) is not recorded]");
  const deaths = records({ kind: "deaths" });
  expect(deaths).toContain('11:10 UTC Gary died in minecraft:the_nether [server]; chat said: "Gary was slain by Blaze" [chat]');
  expect(deaths).toContain("between 2026-11-23 07:00 UTC and 08:00 Margo's death count rose 1 -> 2 [server statistics; exact time not recorded]");
  expect(deaths.match(/Blaze/g)).toHaveLength(1);
});

test("said: only public chat some resident could have seen, never whispers, the caretaker, logins or the unseen spectator", () => {
  const db = database();
  event(db, T - hour, "resident_online", "Gary");
  event(db, T - 30 * minute, "resident_offline", "Gary");
  const lines = [
    chat(T - 2 * hour, "<spesk01> before anyone was on"),
    chat(T - 50 * minute, "<spesk01> hello Gary"),
    chat(T - 49 * minute, "<Gary> hi"),
    chat(T - 48 * minute, "<Caretaker> Gary, your food is low", { kind: "chat" }),
    chat(T - 47 * minute, "Lantern_ joined the game"),
    chat(T - 46 * minute, "spesk01[/192.168.1.50:51234] logged in with entity id 7 at (1, 2, 3)"),
    chat(T - 45 * minute, "spesk01 lost connection: Disconnected"),
    chat(T - 44 * minute, "say hi", { kind: "command", mark: "command" }),
    chat(T - 43 * minute, "Gary has made the advancement [Stone Age]"),
    chat(T - 10 * minute, "<spesk01> after Gary left"),
  ];
  const said = createRecords(db, "Tobin", { now: () => T, chat: () => lines, residents: () => ["Gary"], unseen: ["Lantern_"] })({ kind: "said" });
  expect(said).toContain("<spesk01> hello Gary [chat]");
  expect(said).toContain("<Gary> hi [chat]");
  expect(said).toContain("Gary has made the advancement [Stone Age] [chat]");
  for (const hidden of ["before anyone", "Caretaker", "Lantern_", "192.168", "lost connection", "say hi", "after Gary left"]) expect(said).not.toContain(hidden);
  expect(said).toContain("2 chat lines from times no resident is known to have been online are left out.");
});

test("agreements show only the caller's own and public ones; alarms, facilities and places carry who said them", () => {
  const db = database();
  let clock = T - hour;
  const store = (name: string) => createSocietyStore({ db, resident: name, now: () => clock });
  store("Gary").collaborate({ kind: "request", recipient: "Margo", terms: "Twelve wheat to the pantry." });
  store("Wren").collaborate({ kind: "offer", terms: "Free torches at the crossroads." });
  store("Tobin").collaborate({ kind: "request", recipient: "Wren", terms: "Copy my map." });
  clock += minute;
  store("Margo").update({ id: 1, revision: 1, action: "accept" });
  store("Gary").register({ name: "Pantry", purpose: "Shared bread", capabilities: ["food"], x: 10, y: 70, z: -20, dimension: "minecraft:overworld", access_terms: "Take bread." });
  db.query("INSERT INTO resident_alarms (sender, bucket, at, event_json) VALUES ('Gary','manual',?,?)")
    .run(T - 5 * minute, JSON.stringify({ kind: "manual", reason: "creeper at the farm", x: 12.5, y: 70, z: -18, dimension: "minecraft:overworld", sender: "Gary", at: T - 5 * minute }));
  const records = createRecords(db, "Tobin", { now: () => T });
  const agreements = records({ kind: "agreements" });
  expect(agreements).toContain("#2 offer Wren -> anyone: Wren propose \"Free torches at the crossroads.\" [hub]");
  expect(agreements).toContain("#3 request Tobin -> Wren");
  expect(agreements).not.toContain("Twelve wheat");
  expect(records({ kind: "facilities" })).toContain('Gary registered facility #1 "Pantry" (Shared bread) at 10,70,-20 minecraft:overworld [hub; the steward\'s claim]');
  expect(records({ kind: "alarms", area: { x: 0, z: 0, radius: 30 } })).toContain("Gary shouted: creeper at the farm at 12,70,-18 minecraft:overworld [hub]");
  expect(records({ kind: "alarms", area: { x: 500, z: 0, radius: 30 } })).toContain("Nothing recorded in this window.");
});

test("building by area, flows named by facility, advancements with criterion times, and pages that keep one window", () => {
  const db = database();
  db.query("INSERT INTO facilities (id,name,purpose,capabilities_json,x,y,z,dimension,steward,access_terms,created_at,updated_at) VALUES (4,'Mill chest','Grain','[\"grain\"]',40,64,40,'minecraft:overworld','Margo','Ask',0,0)").run();
  db.query(`INSERT INTO server_container_flows (run,seq,facility,at,since_at,continuous,deltas_json,deltas_truncated,uncertain_json,attribution,resident,nearby_json)
    VALUES (1,1,'facility-4',?,?,1,'[{"item":"minecraft:wheat","before":10,"after":22}]',0,'[]','nearest_resident_within_reach','Margo','[]')`).run(T - 10 * minute, T - 11 * minute);
  const cell = (cx: number, cz: number, placed: number) => db.query(`INSERT INTO server_block_hours (run,resident,dimension,chunk_x,chunk_z,hour,placed,broken,kinds_json,other_placed,other_broken,first_at,last_at)
    VALUES (1,'Gary','minecraft:overworld',?,?,?,?,1,?,0,0,?,?)`).run(cx, cz, T - hour, placed, JSON.stringify([{ block: "minecraft:oak_planks", placed, broken: 0 }, { block: "minecraft:stone", placed: 0, broken: 1 }]), T - hour, T - 30 * minute);
  cell(0, 0, 40); cell(20, 20, 90);
  db.query("INSERT INTO server_advancement_catalog (id,title,frame,hidden,criteria,requirements,parent,built_at) VALUES ('minecraft:story/smelt_iron','Acquire Hardware','task',0,1,1,NULL,0)").run();
  db.query("INSERT INTO server_advancements (resident,id,done,criteria_done,criteria_total,first_seen_at,done_at,saved_at) VALUES ('Gary','minecraft:story/smelt_iron',1,1,1,?,?,?)").run(T - hour, T - 40 * minute, T - 35 * minute);
  db.query("INSERT INTO server_advancement_criteria (resident,id,criterion,achieved_at) VALUES ('Gary','minecraft:story/smelt_iron','iron',?)").run(T - 40 * minute);
  const records = createRecords(db, "Tobin", { now: () => T });
  const building = records({ kind: "building", area: { x: 8, z: 8, radius: 50, dimension: "minecraft:overworld" } });
  expect(building).toContain("Gary placed 40, broke 1 in the chunk 0..15, 0..15 (x, z) minecraft:overworld; placed most: oak_planks 40; broke most: stone 1 [server]");
  expect(building).not.toContain("placed 90");
  expect(records({ kind: "flows" })).toContain('facility "Mill chest": +12 wheat [server counted it; Margo stood nearest (evidence, not proof)]');
  expect(records({ kind: "advancements" })).toContain('Gary earned "Acquire Hardware" (story/smelt_iron); criteria met: iron 11:20 [server]');
  for (let i = 0; i < 40; i++) db.query("INSERT INTO resident_alarms (sender,bucket,at,event_json) VALUES ('Gary','manual',?,?)")
    .run(T - hour + i * minute, JSON.stringify({ kind: "manual", reason: `call number ${i} for help`, x: 0, y: 64, z: 0, dimension: "minecraft:overworld", sender: "Gary", at: T - hour + i * minute }));
  const first = records({ kind: "alarms" });
  const continuation = /Continue: records kind=alarms since=(\S+) until=(\S+) page=2/.exec(first);
  expect(continuation).not.toBeNull();
  const later = createRecords(db, "Tobin", { now: () => T + hour })({ kind: "alarms", since: Date.parse(continuation![1]!), until: Date.parse(continuation![2]!), page: 2 });
  expect(later).not.toContain("call number 0 ");
  expect(later).toContain("Page 2 of");
});

test("ingest keeps resident events from the bridge and records a restart as a gap", async () => {
  const db = database();
  let pages: { events: unknown[]; oldestSeq: number; latestSeq: number; gap: boolean }[] = [
    { events: [{ seq: 1, type: "resident_online", atMs: T, gameTime: 1, resident: "Gary", facility: null, detail: "minecraft:overworld" },
      { seq: 2, type: "facility_status", atMs: T, gameTime: 1, resident: null, facility: "f", detail: "unloaded" },
      { seq: 3, type: "resident_died", atMs: T + minute, gameTime: 2, resident: "Gary", facility: null, detail: "minecraft:overworld" }], oldestSeq: 1, latestSeq: 3, gap: false },
  ];
  const paths: string[] = [];
  const get = async (_source: unknown, path: string): Promise<ObserverReach> => {
    paths.push(path);
    const page = pages.shift() ?? { events: [], oldestSeq: 0, latestSeq: 0, gap: false };
    return { ok: true, receivedAt: T, data: { schema: 1, source: "server-observer", state: "ok", servedAtMs: T, ...page } };
  };
  const ingest = new RecordsIngest(db, { url: "http://bridge.test", tokenFile: "/dev/null" }, { get, now: () => T });
  await ingest.pass();
  expect(db.query("SELECT type, resident FROM history_server_events ORDER BY seq").all()).toEqual([{ type: "resident_online", resident: "Gary" }, { type: "resident_died", resident: "Gary" }]);
  // The server restarted: its sequence begins again below the saved cursor.
  pages = [{ events: [], oldestSeq: 1, latestSeq: 1, gap: false },
    { events: [{ seq: 1, type: "resident_offline", atMs: T + 2 * minute, gameTime: 1, resident: "Gary", facility: null, detail: null }], oldestSeq: 1, latestSeq: 1, gap: false }];
  await ingest.pass();
  expect(paths.at(-1)).toContain("after=0");
  expect(db.query("SELECT COUNT(*) AS n FROM history_server_events").get()).toEqual({ n: 3 });
  expect(db.query("SELECT kind FROM server_ingest_gaps").all()).toEqual([{ kind: "server_events" }]);
});
