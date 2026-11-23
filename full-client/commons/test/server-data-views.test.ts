import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { openCommons } from "../src/db.ts";
import type { IngestHealth } from "../src/observer-ingest.ts";
import type { BlockCell, Flow, StatsResult } from "../src/observer-query.ts";
import { recordGap, storeAdvancements, storeBlockChanges, storeBlockHours, storeCatalog, storeFlows, storeStats } from "../src/observer-store.ts";
import type { Context } from "../src/routes/context.ts";
import { serverDataRoutes } from "../src/routes/server-data.ts";
import {
  advancementCatalog, blockCell, blockMap, dataHealth, facilityLedger, lastSession, residentAdvancements, residentStats,
} from "../src/server-data-views.ts";

const NOW = Date.parse("2026-11-23T15:30:00Z");
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const TICKS_PER_MINUTE = 1200;
const db = (): Database => openCommons(":memory:", resolve(import.meta.dir, "..", "schema.sql"));

/** One save of a statistics file, as the bridge reports it. */
function save(d: Database, resident: string, savedAtMs: number, custom: Record<string, number>, mined: Record<string, number> = {}) {
  const stats: StatsResult = { resident, status: "observed", reason: null, savedAtMs, dataVersion: 3465, skipped: 0, types: [
    { type: "minecraft:custom", total: Object.keys(custom).length, truncated: false, values: custom },
    { type: "minecraft:mined", total: Object.keys(mined).length, truncated: false, values: mined },
  ] };
  storeStats(d, stats, savedAtMs + 1000);
}

test("the last session is found from play time, not from how often the hub happened to read", () => {
  const at = (minutesAgo: number) => NOW - minutesAgo * MINUTE;
  // Played 60 minutes until 5 h ago (logout save), away, then back 40 minutes ago; saves read every 15 minutes.
  const saves = [
    { savedAt: at(360), play: 0 }, { savedAt: at(300), play: 60 * TICKS_PER_MINUTE },
    { savedAt: at(28), play: 72 * TICKS_PER_MINUTE }, { savedAt: at(13), play: 87 * TICKS_PER_MINUTE },
  ];
  // About 12 minutes played before the first save after the break: it began about 40 minutes ago.
  expect(lastSession(saves)).toEqual({ from: at(300), startedAbout: at(40), partial: false });
  // Without a break the record starts inside the session.
  expect(lastSession(saves.slice(2))).toEqual({ from: at(28), startedAbout: null, partial: true });
  expect(lastSession([saves[0]])).toEqual({ from: at(360), startedAbout: null, partial: true });
  expect(lastSession([])).toBeNull();
});

test("statistics: headline sums, changes over a window from the value in force at its start, and named lists", () => {
  const d = db();
  save(d, "Wren", NOW - 3 * DAY, { "minecraft:play_time": 72_000, "minecraft:walk_one_cm": 10_000, "minecraft:sprint_one_cm": 5_000, "minecraft:deaths": 1 },
    { "minecraft:stone": 40, "minecraft:dirt": 5 });
  save(d, "Wren", NOW - 2 * HOUR, { "minecraft:play_time": 144_000, "minecraft:walk_one_cm": 30_000, "minecraft:sprint_one_cm": 5_000, "minecraft:deaths": 1,
    "minecraft:boat_one_cm": 800 }, { "minecraft:stone": 100, "minecraft:dirt": 5, "minecraft:iron_ore": 3 });
  const day = residentStats(d, "Wren", "24h", NOW);
  expect(day.window).toMatchObject({ kind: "24h", from: NOW - DAY, to: NOW - 2 * HOUR, partial: false, saves: 1 });
  expect(day.headline.onFoot).toEqual({ now: 35_000, change: 20_000 });
  expect(day.headline.boat).toEqual({ now: 800, change: 800 }); // a statistic that did not exist yet was 0
  expect(day.headline.mined).toEqual({ now: 108, change: 63 });
  expect(day.headline.deaths).toEqual({ now: 1, change: 0 });
  expect(day.lists.mined.byChange.map(entry => [entry.key, entry.change])).toEqual([["minecraft:stone", 60], ["minecraft:iron_ore", 3]]);
  expect(day.lists.mined.byTotal[0]).toEqual({ key: "minecraft:stone", now: 100, change: 60 });
  // A week reaches back before the first stored save: counted from it, and said so.
  const week = residentStats(d, "Wren", "7d", NOW);
  expect(week.window).toMatchObject({ from: NOW - 3 * DAY, partial: true });
  expect(week.headline.mined.change).toBe(63);
  // A resident with nothing stored has no window at all rather than invented zeros from somewhere.
  expect(residentStats(d, "Tobin", "session", NOW)).toMatchObject({ savedAt: null, window: { from: null, saves: 0 } });
});

test("advancements: tabs follow the in-game parents (mods under vanilla tabs), readable progress, what is next", () => {
  const d = db();
  storeCatalog(d, [
    { id: "minecraft:story/root", title: "Minecraft", frame: "task", hidden: false, criteria: 1, requirements: 1, parent: null },
    { id: "minecraft:story/mine_stone", title: "Stone Age", frame: "task", hidden: false, criteria: 1, requirements: 1, parent: "minecraft:story/root" },
    { id: "minecraft:story/smelt_iron", title: "Acquire Hardware", frame: "task", hidden: false, criteria: 1, requirements: 1, parent: "minecraft:story/mine_stone" },
    { id: "quark:story/crate", title: null, frame: "task", hidden: false, criteria: 1, requirements: 1, parent: "minecraft:story/mine_stone" },
    { id: "minecraft:story/secret", title: "Secret", frame: "task", hidden: true, criteria: 1, requirements: 1, parent: "minecraft:story/mine_stone" },
    { id: "occultism:occultism/root", title: "Occultism", frame: "task", hidden: false, criteria: 1, requirements: 1, parent: null },
    { id: "occultism:occultism/craft_dimensional_matrix", title: "advancements.occultism.craft_dimensional_matrix.title", frame: "task", hidden: false,
      criteria: 3, requirements: 1, parent: "occultism:occultism/root" },
    { id: "minecraft:adventure/adventuring_time", title: "Adventuring Time", frame: "challenge", hidden: false, criteria: 4, requirements: 4, parent: "minecraft:story/root" },
    // Its parent is not loaded: no tab in the game.
    { id: "occultism:occultism/possess_ghast", title: "advancements.occultism.possess_ghast.title", frame: "task", hidden: true, criteria: 1, requirements: 1,
      parent: "occultism:occultism/root_gone" },
  ], NOW - DAY);
  storeAdvancements(d, { resident: "Gary", status: "observed", reason: null, savedAtMs: NOW - HOUR, total: 4, done: 2, matched: 4, offset: 0, more: false, advancements: [
    { id: "minecraft:story/root", done: true, criteriaDone: 1, criteriaTotal: 1, title: "Minecraft", frame: "task", criteriaTruncated: false, criteria: [{ name: "crafting_table", atMs: NOW - 2 * DAY }] },
    { id: "minecraft:story/mine_stone", done: true, criteriaDone: 1, criteriaTotal: 1, title: "Stone Age", frame: "task", criteriaTruncated: false, criteria: [{ name: "get_stone", atMs: NOW - 3 * HOUR }] },
    { id: "minecraft:adventure/adventuring_time", done: false, criteriaDone: 3, criteriaTotal: 4, title: null, frame: null, criteriaTruncated: false,
      criteria: [{ name: "plains", atMs: NOW - DAY }, { name: "forest", atMs: NOW - DAY }, { name: "desert", atMs: null }] },
    { id: "minecraft:recipes/misc/stick", done: true, criteriaDone: 1, criteriaTotal: 1, title: null, frame: null, criteriaTruncated: false, criteria: [] },
  ] }, NOW - HOUR);
  const catalog = advancementCatalog(d);
  expect(catalog.tabs.map(tab => [tab.id, tab.total, tab.hidden])).toEqual([["minecraft:story/root", 6, 1], ["occultism:occultism/root", 2, 0], ["occultism:*", 1, 1]]);
  const gary = residentAdvancements(d, "Gary", catalog);
  expect(gary.done).toBe(2);
  expect(gary.tabs).toEqual([{ id: "minecraft:story/root", done: 2, started: 1 }]);
  expect(gary.outsideCatalog).toBe(1);
  expect(gary.recent.slice(0, 2).map(item => [item.id, item.doneAt])).toEqual([["minecraft:story/mine_stone", NOW - 3 * HOUR], ["minecraft:story/root", NOW - 2 * DAY]]);
  expect(gary.nearly).toEqual([{ id: "minecraft:adventure/adventuring_time", title: "Adventuring Time", frame: "challenge", tab: "minecraft:story/root",
    criteriaDone: 3, criteriaTotal: 4, remaining: 1 }]);
  // Next: children of done advancements, visible and not started (the hidden one stays hidden).
  expect(gary.next.map(item => item.id)).toEqual(["minecraft:story/smelt_iron", "quark:story/crate"]);
  expect(gary.firstAt).toBe(NOW - 2 * DAY);
});

const cell = (resident: string, chunkX: number, chunkZ: number, hourMs: number, placed: number, broken: number, kinds: BlockCell["kinds"] = []): BlockCell => ({
  resident, dimension: "minecraft:overworld", chunkX, chunkZ, hourMs, placed, broken, kinds, otherPlaced: 0, otherBroken: 0, firstAtMs: hourMs + 60_000, lastAtMs: hourMs + 120_000,
});
const hours = (cells: BlockCell[], overflow: { resident: string; hourMs: number; placed: number; broken: number }[] = []) =>
  ({ cells, overflow, offset: 0, total: cells.length, more: false, sinceHourMs: 0, retainedFromHourMs: 0, evictedThroughHourMs: 0 });

test("block map: chunks summed over hours and bridge runs, 64-block areas with negative coordinates, one dimension at a time", () => {
  const d = db(), h0 = NOW - (NOW % HOUR) - 2 * HOUR, h1 = h0 + HOUR;
  storeBlockHours(d, 1, hours([cell("Gary", -1, -1, h0, 10, 2, [{ block: "minecraft:oak_planks", placed: 10, broken: 0 }]), cell("Gary", -4, -1, h0, 5, 0)]));
  // A bridge restart in the next hour: a second run's counts for the same chunk and hour add up.
  storeBlockHours(d, 2, hours([cell("Gary", -1, -1, h1, 3, 1, [{ block: "minecraft:oak_planks", placed: 3, broken: 0 }, { block: "minecraft:dirt", placed: 0, broken: 1 }]),
    cell("Margo", 0, 0, h1, 0, 7), { ...cell("Margo", 0, 0, h1, 4, 0), dimension: "minecraft:the_nether" }], [{ resident: "Margo", hourMs: h1, placed: 2, broken: 0 }]));
  storeBlockHours(d, 3, hours([cell("Gary", -1, -1, h1, 1, 0)]));
  const map = blockMap(d, { since: h0, until: NOW, dimension: "overworld", limit: 100 });
  expect(map.dimensions).toEqual([{ dimension: "overworld", placed: 19, broken: 10 }, { dimension: "the_nether", placed: 4, broken: 0 }]);
  expect(map.cells.map(c => [c.resident, c.chunkX, c.chunkZ, c.placed, c.broken, c.hours, c.dimension])).toEqual([
    ["Gary", -1, -1, 14, 3, 2, "overworld"], ["Margo", 0, 0, 0, 7, 1, "overworld"], ["Gary", -4, -1, 5, 0, 1, "overworld"],
  ]);
  // Chunks -1 and -4 are both in the area just west and north of the origin (x -64..-1, z -64..-1).
  expect(map.areas[0]).toMatchObject({ resident: "Gary", areaX: -1, areaZ: -1, placed: 19, broken: 3, chunks: 2,
    kinds: [{ block: "minecraft:oak_planks", placed: 13, broken: 0 }, { block: "minecraft:dirt", placed: 0, broken: 1 }] });
  expect(map.areas[1]).toMatchObject({ resident: "Margo", areaX: 0, areaZ: 0, placed: 0, broken: 7 });
  expect(map.overflow).toEqual([{ resident: "Margo", placed: 2, broken: 0 }]);
  expect(map.hours.filter(row => row.resident === "Gary").map(row => [row.hour, row.placed])).toEqual([[h0, 15], [h1, 4]]);
  const capped = blockMap(d, { since: h0, until: NOW, limit: 1 });
  expect(capped).toMatchObject({ truncated: true, cells: [{ resident: "Gary", chunkX: -1 }] });
});

test("one chunk: its hours and kinds, and only the individual changes inside it", () => {
  const d = db(), h0 = NOW - (NOW % HOUR) - HOUR;
  storeBlockHours(d, 1, hours([{ ...cell("Gary", 2, -1, h0, 3, 1, [{ block: "minecraft:torch", placed: 3, broken: 0 }]), otherBroken: 1 }]));
  storeBlockChanges(d, 1, [
    { seq: 1, resident: "Gary", action: "place", dimension: "minecraft:overworld", x: 32, y: 64, z: -16, block: "minecraft:torch", atMs: h0 + 1000, gameTime: 1 },
    { seq: 2, resident: "Gary", action: "break", dimension: "minecraft:overworld", x: 47, y: 63, z: -1, block: "minecraft:dirt", atMs: h0 + 2000, gameTime: 2 },
    { seq: 3, resident: "Gary", action: "place", dimension: "minecraft:overworld", x: 48, y: 64, z: -1, block: "minecraft:torch", atMs: h0 + 3000, gameTime: 3 },
    { seq: 4, resident: "Gary", action: "place", dimension: "minecraft:the_nether", x: 33, y: 64, z: -2, block: "minecraft:torch", atMs: h0 + 4000, gameTime: 4 },
  ]);
  const one = blockCell(d, { dimension: "overworld", chunkX: 2, chunkZ: -1, since: h0, until: NOW, limit: 50 });
  expect(one.changes.map(change => change.x)).toEqual([47, 32]);
  expect(one).toMatchObject({ counted: 4, detailed: 2, detailFrom: h0 + 1000, hours: [{ hour: h0, resident: "Gary", placed: 3, broken: 1 }],
    kinds: [{ resident: "Gary", block: "minecraft:torch", placed: 3, broken: 0 }], other: [{ resident: "Gary", placed: 0, broken: 1 }] });
});

test("facility ledger: in and out per item, nearest resident counted as evidence, labels from the observer snapshot", () => {
  const d = db();
  const flow = (seq: number, deltas: Flow["deltas"], resident: string | null, uncertain: string[] = []): Flow => ({
    seq, facility: "pantry", dimension: "minecraft:overworld", atMs: NOW - seq * MINUTE, gameTime: seq, sinceMs: NOW - seq * MINUTE - 1000, continuous: true,
    deltas, deltasTruncated: false, uncertain, attribution: resident ? "nearest_resident_within_reach" : "no_resident_within_reach", resident,
    nearby: resident ? [{ resident, distance: 2, when: "now" }, { resident: "Wren", distance: 6, when: "previous" }] : [],
  });
  storeFlows(d, 1, [
    flow(1, [{ item: "minecraft:bread", before: 20, after: 12, nbtBefore: 0, nbtAfter: 0 }], "Margo"),
    flow(2, [{ item: "minecraft:bread", before: 12, after: 20, nbtBefore: 0, nbtAfter: 0 }, { item: "minecraft:wheat", before: 0, after: 3, nbtBefore: 0, nbtAfter: 0 }], null, ["observation_gap"]),
    { ...flow(3, [{ item: "minecraft:coal", before: 5, after: 0, nbtBefore: 0, nbtAfter: 0 }], "Gary"), facility: "smelter" },
  ]);
  const ledger = facilityLedger(d, NOW - DAY, new Map([["pantry", { label: "Village pantry", dimension: "minecraft:overworld", pos: [10, 64, 21] }]]));
  expect(ledger.truncated).toBe(false);
  const pantry = ledger.facilities.find(entry => entry.facility === "pantry")!;
  expect(pantry).toMatchObject({ label: "Village pantry", dimension: "overworld", pos: [10, 64, 21], flows: 2, unattributed: 1,
    nearest: [{ name: "Margo", flows: 1 }], nearby: [{ name: "Margo", flows: 1 }, { name: "Wren", flows: 1 }], uncertain: [{ name: "observation_gap", flows: 1 }] });
  expect(pantry.items).toEqual([{ item: "minecraft:bread", in: 8, out: 8 }, { item: "minecraft:wheat", in: 3, out: 0 }]);
  expect(ledger.facilities.find(entry => entry.facility === "smelter")).toMatchObject({ label: null, items: [{ item: "minecraft:coal", in: 0, out: 5 }] });
  expect(facilityLedger(d, NOW - DAY, new Map(), 2).truncated).toBe(true);
});

test("data health: an older bridge, a bridge missing one kind, and gaps under the set they affect", () => {
  const d = db();
  recordGap(d, "block_hours", 1, "bridge restarted", NOW - HOUR);
  recordGap(d, "flows", 1, "ring overwritten", NOW - 2 * HOUR);
  const base: IngestHealth = { status: "ok", detail: null, checkedAt: NOW, okAt: NOW, run: 1, steps: {
    stats: { at: NOW - MINUTE, ok: true, detail: null, stored: 4 }, flows: { at: NOW - 2 * MINUTE, ok: false, detail: "rate limited", stored: 0 },
  }, kinds: ["stats", "advancements", "advancement_catalog", "block_hours", "flows"] };
  const health = dataHealth(d, base, NOW);
  expect(health.sets.blocks).toMatchObject({ supported: false, missing: ["blocks"], gaps: { count: 1 } });
  expect(health.sets.stats).toMatchObject({ supported: true, lastPass: { at: NOW - MINUTE, ok: true } });
  expect(health.sets.flows).toMatchObject({ supported: true, lastPass: { ok: false, detail: "rate limited" }, gaps: { count: 1, recent: [{ detail: "ring overwritten" }] } });
  const old = dataHealth(d, { ...base, status: "unsupported", kinds: [], steps: {} }, NOW);
  expect(Object.values(old.sets).every(set => set.supported === false)).toBe(true);
  expect(dataHealth(d, null, NOW).sets.stats.supported).toBeNull();
});

test("the panel's routes validate their parameters and answer for every resident the hub recorded", async () => {
  const d = db();
  save(d, "Gary", NOW - HOUR, { "minecraft:play_time": 1000 });
  save(d, "Wren", NOW - HOUR, { "minecraft:play_time": 2000 });
  const routes = serverDataRoutes({ db: d, now: () => NOW, watcher: { observer: { world: () => null } } } as unknown as Context, undefined);
  const ask = (query: string) => ({ query: new URLSearchParams(query), body: async () => ({}) });
  const record = await routes["GET server-data/record"](ask("window=session")) as { residents: { resident: string }[]; health: { status: string } };
  expect(record.residents.map(entry => entry.resident)).toEqual(["Gary", "Wren"]);
  expect(record.health.status).toBe("unconfigured");
  expect((await routes["GET server-data/record"](ask("window=year")) as Response).status).toBe(400);
  expect((await routes["GET server-data/block-cell"](ask("dimension=overworld&chunkX=1")) as Response).status).toBe(400);
  expect((await routes["GET server-data/block-map"](ask("limit=0")) as Response).status).toBe(400);
  expect(await routes["GET server-data/ledger"](ask(""))).toMatchObject({ facilities: [], truncated: false, health: { supported: null } });
});
