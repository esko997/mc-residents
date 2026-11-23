// Made-up server record for the demo (bun scripts/demo.ts): a week of statistics saves, advancement
// progress against a small catalog, building and digging around the demo trails, container flows and
// two known gaps, stored through the same functions the hub's ingest uses. Plus a stand-in server
// bridge that answers its snapshot (two registered facilities) and the query vocabulary with nothing
// new, so the panel shows a healthy connection; DEMO_OLD_BRIDGE=1 makes it an older bridge without queries.
import type { Database } from "bun:sqlite";
import type { BlockCell, CatalogEntry, Flow, StatsResult } from "../src/observer-query.ts";
import {
  recordGap, storeAdvancements, storeBlockChanges, storeBlockHours, storeCatalog, storeFlows, storeStats,
} from "../src/observer-store.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const OVERWORLD = "minecraft:overworld", NETHER = "minecraft:the_nether";

/** A small deterministic random source, so every demo run looks the same. */
function random(seed: number) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
}

interface Profile {
  /** [start, minutes] of each session, most recent last; a session that has not ended has no logout save. */
  sessions: [number, number][];
  ongoing: boolean;
  perMinute: Record<string, Record<string, number>>;
}

function statistics(db: Database, resident: string, profile: Profile, seed: number) {
  const roll = random(seed);
  const values: Record<string, Record<string, number>> = {};
  const add = (type: string, key: string, amount: number) => { (values[type] ??= {})[key] = (values[type][key] ?? 0) + Math.round(amount); };
  const write = (savedAtMs: number) => {
    const stats: StatsResult = { resident, status: "observed", reason: null, savedAtMs, dataVersion: 3465, skipped: 0,
      types: Object.entries(values).map(([type, entries]) => ({ type, total: Object.keys(entries).length, truncated: false, values: { ...entries } })) };
    storeStats(db, stats, savedAtMs + 40_000);
  };
  profile.sessions.forEach(([start, minutes], index) => {
    const last = index === profile.sessions.length - 1;
    // The hub reads a resident's file every 15 minutes: one stored save per read while playing.
    for (let played = 15; played <= minutes; played += 15) {
      add("minecraft:custom", "minecraft:play_time", 15 * 1200);
      add("minecraft:custom", "minecraft:total_world_time", 15 * 1200);
      for (const [type, keys] of Object.entries(profile.perMinute)) {
        for (const [key, rate] of Object.entries(keys)) if (roll() < 0.8) add(type, key, rate * 15 * (0.4 + roll() * 1.2));
      }
      if (roll() < 0.08) add("minecraft:custom", "minecraft:deaths", 1);
      write(start + played * MINUTE);
    }
    if (!(last && profile.ongoing)) {
      add("minecraft:custom", "minecraft:leave_game", 1);
      write(start + minutes * MINUTE + 20_000); // the logout save
    }
  });
}

const CATALOG: CatalogEntry[] = [
  ["minecraft:story/root", "Minecraft", null, 1], ["minecraft:story/mine_stone", "Stone Age", "minecraft:story/root", 1],
  ["minecraft:story/upgrade_tools", "Getting an Upgrade", "minecraft:story/mine_stone", 1], ["minecraft:story/smelt_iron", "Acquire Hardware", "minecraft:story/upgrade_tools", 1],
  ["minecraft:story/iron_tools", "Isn't It Iron Pick", "minecraft:story/smelt_iron", 1], ["minecraft:story/mine_diamond", "Diamonds!", "minecraft:story/iron_tools", 1],
  ["minecraft:story/lava_bucket", "Hot Stuff", "minecraft:story/smelt_iron", 1], ["minecraft:story/enter_the_nether", "We Need to Go Deeper", "minecraft:story/lava_bucket", 1],
  ["minecraft:nether/root", "Nether", null, 1], ["minecraft:nether/find_fortress", "A Terrible Fortress", "minecraft:nether/root", 1],
  ["minecraft:nether/obtain_blaze_rod", "Into Fire", "minecraft:nether/find_fortress", 1], ["minecraft:nether/explore_nether", "Hot Tourist Destinations", "minecraft:nether/root", 5],
  ["minecraft:adventure/root", "Adventure", null, 1], ["minecraft:adventure/kill_a_mob", "Monster Hunter", "minecraft:adventure/root", 1],
  ["minecraft:adventure/sleep_in_bed", "Sweet Dreams", "minecraft:adventure/root", 1], ["minecraft:adventure/adventuring_time", "Adventuring Time", "minecraft:adventure/sleep_in_bed", 54],
  ["minecraft:adventure/trade", "What a Deal!", "minecraft:adventure/root", 1],
  ["minecraft:husbandry/root", "Husbandry", null, 1], ["minecraft:husbandry/plant_seed", "A Seedy Place", "minecraft:husbandry/root", 1],
  ["minecraft:husbandry/balanced_diet", "A Balanced Diet", "minecraft:husbandry/root", 43], ["minecraft:husbandry/breed_an_animal", "The Parrots and the Bats", "minecraft:husbandry/root", 1],
  ["mekanism:root", "Mekanism", null, 1], ["mekanism:metallurgic_infuser", "Infusing", "mekanism:root", 1], ["mekanism:enrichment_chamber", "Enriched", "mekanism:root", 1],
  ["occultism:occultism/familiar/root", "Occultism: Friends", null, 1],
  ["occultism:occultism/craft_dimensional_matrix", "advancements.occultism.craft_dimensional_matrix.title", "occultism:occultism/root", 1],
  ["occultism:occultism/craft_satchel", "advancements.occultism.craft_satchel.title", "occultism:occultism/root", 1],
].map(([id, title, parent, criteria]) => ({
  id: id as string, title: title as string, frame: (criteria as number) > 5 ? "challenge" : "task", hidden: (id as string).startsWith("occultism:occultism/craft"),
  criteria: criteria as number, requirements: (id as string).endsWith("explore_nether") ? 1 : criteria as number, parent: parent as string | null,
}));

function advancements(db: Database, resident: string, done: [string, number][], started: [string, number][], savedAt: number) {
  storeAdvancements(db, { resident, status: "observed", reason: null, savedAtMs: savedAt, total: done.length + started.length, done: done.length,
    matched: done.length + started.length, offset: 0, more: false, advancements: [
      ...done.map(([id, at]) => ({ id, done: true, criteriaDone: 1, criteriaTotal: 1, title: null, frame: null, criteriaTruncated: false, criteria: [{ name: "done", atMs: at }] })),
      ...started.map(([id, n]) => {
        const total = CATALOG.find(entry => entry.id === id)?.criteria ?? n + 1;
        return { id, done: false, criteriaDone: n, criteriaTotal: total, title: null, frame: null, criteriaTruncated: false,
          criteria: Array.from({ length: n }, (_, i) => ({ name: `part_${i}`, atMs: savedAt - (i + 1) * 3 * HOUR })) };
      }),
    ] }, savedAt);
}

function blocks(db: Database, now: number) {
  const hourOf = (t: number) => t - (t % HOUR);
  const cell = (resident: string, dimension: string, chunkX: number, chunkZ: number, hoursAgo: number, kinds: [string, number, number][]): BlockCell => {
    const hourMs = hourOf(now - hoursAgo * HOUR);
    const named = kinds.slice(0, 8);
    return { resident, dimension, chunkX, chunkZ, hourMs, placed: kinds.reduce((s, k) => s + k[1], 0), broken: kinds.reduce((s, k) => s + k[2], 0),
      kinds: named.map(([block, placed, broken]) => ({ block, placed, broken })), otherPlaced: 0, otherBroken: 0, firstAtMs: hourMs + 5 * MINUTE, lastAtMs: hourMs + 50 * MINUTE };
  };
  const run1 = now - 3 * DAY, run2 = now - 20 * HOUR;
  // Gary: the cabin extension at chunk (6, -13) and the staircase mine under the copper vein, chunks (9, -11) and (9, -12).
  const older = [
    cell("Gary", OVERWORLD, 6, -13, 40, [["minecraft:oak_planks", 64, 0], ["minecraft:oak_log", 12, 30], ["minecraft:glass", 8, 0], ["minecraft:torch", 6, 0]]),
    cell("Gary", OVERWORLD, 6, -13, 39, [["minecraft:oak_planks", 40, 0], ["minecraft:oak_stairs", 18, 0], ["minecraft:dirt", 0, 22]]),
    cell("Margo", OVERWORLD, 3, -6, 30, [["minecraft:cobblestone", 30, 0], ["minecraft:stone_bricks", 22, 0], ["minecraft:grass_block", 0, 14]]),
  ];
  storeBlockHours(db, run1, { cells: older, overflow: [], offset: 0, total: older.length, more: false, sinceHourMs: 0, retainedFromHourMs: 0, evictedThroughHourMs: 0 });
  const recent = [
    cell("Gary", OVERWORLD, 9, -11, 6, [["minecraft:stone", 0, 140], ["minecraft:deepslate", 0, 60], ["minecraft:copper_ore", 0, 18], ["minecraft:torch", 9, 0], ["minecraft:cobblestone", 12, 0]]),
    cell("Gary", OVERWORLD, 9, -11, 5, [["minecraft:deepslate", 0, 120], ["minecraft:iron_ore", 0, 7], ["minecraft:torch", 6, 0]]),
    cell("Gary", OVERWORLD, 9, -12, 5, [["minecraft:stone", 0, 48], ["minecraft:coal_ore", 0, 9]]),
    cell("Gary", OVERWORLD, 6, -13, 2, [["minecraft:chest", 2, 0], ["minecraft:furnace", 1, 0], ["minecraft:oak_planks", 20, 0]]),
    cell("Gary", OVERWORLD, 6, -13, 1, [["minecraft:wheat", 0, 18], ["minecraft:wheat_seeds", 18, 0]]),
    cell("Margo", OVERWORLD, 3, -6, 4, [["minecraft:stone_bricks", 36, 0], ["minecraft:iron_bars", 6, 0], ["minecraft:cobblestone", 0, 4]]),
    cell("Margo", OVERWORLD, 6, -13, 2, [["minecraft:oak_planks", 6, 0], ["minecraft:crafting_table", 1, 0]]),
    cell("Margo", NETHER, 5, -3, 3, [["minecraft:netherrack", 0, 90], ["minecraft:cobblestone", 24, 0], ["minecraft:nether_quartz_ore", 0, 11]]),
  ];
  storeBlockHours(db, run2, { cells: recent, overflow: [{ resident: "Gary", hourMs: hourOf(now - 6 * HOUR), placed: 0, broken: 14 }],
    offset: 0, total: recent.length, more: false, sinceHourMs: 0, retainedFromHourMs: 0, evictedThroughHourMs: 0 });
  // A sample of the individual changes (the bridge skips some in bursts), in the cabin chunk only.
  const roll = random(7);
  const changes = Array.from({ length: 40 }, (_, i) => {
    const at = now - 2 * HOUR + i * 90_000, place = i % 5 !== 0;
    return { seq: i + 1, resident: i % 9 === 4 ? "Margo" : "Gary", action: place ? "place" as const : "break" as const, dimension: OVERWORLD,
      x: 96 + Math.floor(roll() * 16), y: 120 + Math.floor(roll() * 4), z: -208 + Math.floor(roll() * 16),
      block: place ? ["minecraft:oak_planks", "minecraft:chest", "minecraft:oak_planks", "minecraft:wheat_seeds"][i % 4] : "minecraft:wheat", atMs: at, gameTime: i };
  });
  storeBlockChanges(db, run2, changes);
  recordGap(db, "block_hours", run1, `bridge restarted; counts of run ${run1} after the last read are lost`, run2 + 2 * MINUTE);
}

function flows(db: Database, now: number) {
  const flow = (seq: number, facility: string, minutesAgo: number, deltas: [string, number, number][], resident: string | null, uncertain: string[] = []): Flow => ({
    seq, facility, dimension: OVERWORLD, atMs: now - minutesAgo * MINUTE, gameTime: seq, sinceMs: now - minutesAgo * MINUTE - 30_000, continuous: true,
    deltas: deltas.map(([item, before, after]) => ({ item, before, after, nbtBefore: 0, nbtAfter: 0 })), deltasTruncated: false, uncertain,
    attribution: resident ? "nearest_resident_within_reach" : "no_resident_within_reach", resident,
    nearby: resident ? [{ resident, distance: 2.4, when: "now" }, ...(resident === "Gary" && seq % 3 === 0 ? [{ resident: "Margo", distance: 6.1, when: "previous" }] : [])] : [],
  });
  const run = now - 20 * HOUR;
  storeFlows(db, run, [
    flow(1, "pantry", 600, [["minecraft:bread", 4, 12], ["minecraft:wheat", 30, 3]], "Gary"),
    flow(2, "pantry", 420, [["minecraft:bread", 12, 9]], "Margo"),
    flow(3, "pantry", 300, [["minecraft:bread", 9, 6], ["minecraft:apple", 2, 0]], "Gary"),
    flow(4, "pantry", 200, [["minecraft:wheat", 3, 21]], null, ["observation_gap"]),
    flow(5, "smelter", 330, [["minecraft:raw_iron", 0, 7], ["minecraft:coal", 0, 8]], "Gary"),
    flow(6, "smelter", 250, [["minecraft:raw_iron", 7, 0], ["minecraft:coal", 8, 1], ["minecraft:iron_ingot", 0, 7]], null),
    flow(7, "smelter", 240, [["minecraft:iron_ingot", 7, 0]], "Gary"),
    flow(8, "farm-hopper", 90, [["minecraft:wheat", 40, 44], ["minecraft:wheat_seeds", 60, 61]], null),
    flow(9, "farm-hopper", 60, [["minecraft:wheat", 44, 48]], null),
  ]);
  recordGap(db, "flows", run - 2 * DAY, "ring overwritten before it was read: seq 120..131 lost", now - 3 * DAY);
}

export function seedServerData(db: Database, now: number) {
  const day = (daysAgo: number, hour: number) => {
    const d = new Date(now - daysAgo * DAY); d.setHours(hour, 0, 0, 0); return d.getTime();
  };
  statistics(db, "Gary", { ongoing: true, sessions: [[day(6, 9), 120], [day(3, 14), 180], [day(1, 19), 150], [now - 70 * MINUTE, 66]],
    perMinute: {
      "minecraft:custom": { "minecraft:walk_one_cm": 6000, "minecraft:sprint_one_cm": 2500, "minecraft:jump": 6, "minecraft:mob_kills": 0.1, "minecraft:damage_taken": 8, "minecraft:open_chest": 0.4 },
      "minecraft:mined": { "minecraft:stone": 6, "minecraft:deepslate": 3, "minecraft:dirt": 1.5, "minecraft:copper_ore": 0.4, "minecraft:oak_log": 1 },
      "minecraft:crafted": { "minecraft:oak_planks": 2, "minecraft:torch": 1, "minecraft:bread": 0.3, "minecraft:stick": 0.8 },
      "minecraft:used": { "minecraft:oak_planks": 1.5, "minecraft:torch": 0.8, "minecraft:stone_pickaxe": 6, "minecraft:bread": 0.2 },
      "minecraft:picked_up": { "minecraft:cobblestone": 6, "minecraft:raw_copper": 0.5, "minecraft:wheat": 0.6 },
      "minecraft:killed": { "minecraft:zombie": 0.05, "minecraft:skeleton": 0.03 },
    } }, 11);
  statistics(db, "Margo", { ongoing: false, sessions: [[day(5, 10), 120], [now - 270 * MINUTE, 245]],
    perMinute: {
      "minecraft:custom": { "minecraft:walk_one_cm": 4500, "minecraft:boat_one_cm": 1800, "minecraft:swim_one_cm": 300, "minecraft:damage_taken": 14, "minecraft:interact_with_crafting_table": 0.3 },
      "minecraft:mined": { "minecraft:netherrack": 4, "minecraft:stone": 2, "minecraft:nether_quartz_ore": 0.3 },
      "minecraft:crafted": { "minecraft:stone_bricks": 3, "minecraft:iron_bars": 0.6, "mekanism:metallurgic_infuser": 0.07 },
      "minecraft:used": { "minecraft:stone_bricks": 2.5, "minecraft:water_bucket": 0.2 },
      "minecraft:picked_up": { "minecraft:netherrack": 3, "minecraft:quartz": 0.4 },
      "minecraft:killed_by": { "minecraft:blaze": 0.01 },
    } }, 23);
  storeCatalog(db, CATALOG, now - 3 * DAY);
  advancements(db, "Gary", [["minecraft:story/root", now - 6 * DAY], ["minecraft:story/mine_stone", now - 6 * DAY + HOUR], ["minecraft:story/upgrade_tools", now - 6 * DAY + 2 * HOUR],
    ["minecraft:husbandry/root", now - 6 * DAY], ["minecraft:husbandry/plant_seed", now - 3 * DAY], ["minecraft:story/smelt_iron", now - 4 * HOUR],
    ["minecraft:adventure/root", now - 3 * DAY], ["minecraft:adventure/kill_a_mob", now - 3 * DAY + HOUR], ["minecraft:adventure/sleep_in_bed", now - 30 * HOUR]],
  [["minecraft:adventure/adventuring_time", 9], ["minecraft:husbandry/balanced_diet", 11]], now - 4 * MINUTE);
  advancements(db, "Margo", [["minecraft:story/root", now - 5 * DAY], ["minecraft:story/mine_stone", now - 5 * DAY + HOUR], ["minecraft:story/upgrade_tools", now - 5 * DAY + HOUR],
    ["minecraft:story/smelt_iron", now - 5 * DAY + 2 * HOUR], ["minecraft:story/lava_bucket", now - 6 * HOUR], ["minecraft:story/enter_the_nether", now - 260 * MINUTE],
    ["minecraft:nether/root", now - 260 * MINUTE], ["minecraft:nether/find_fortress", now - 200 * MINUTE], ["mekanism:root", now - 5 * DAY + 3 * HOUR],
    ["mekanism:metallurgic_infuser", now - 2 * HOUR], ["occultism:occultism/craft_satchel", now - 90 * MINUTE]],
  [["minecraft:nether/explore_nether", 3]], now - 25 * MINUTE);
  blocks(db, now);
  flows(db, now);
}

/** Registered facilities as the stand-in bridge's snapshot reports them (two of three: the hopper is not registered any more). */
const FACILITIES = [
  { id: "pantry", label: "Cabin pantry", dimension: OVERWORLD, pos: [112, 120, -204], side: null, status: "observed", lastKnown: null,
    contents: { block: "minecraft:chest", slots: 27, usedSlots: 3, slotsTruncated: false, items: [{ item: "minecraft:bread", count: 6, nbtStacks: 0 },
      { item: "minecraft:wheat", count: 21, nbtStacks: 0 }], itemsTruncated: false, energy: null, fluids: [], readMicros: 40 } },
  { id: "smelter", label: "Mine furnace", dimension: OVERWORLD, pos: [146, 13, -168], side: null, status: "unloaded", contents: null,
    lastKnown: { block: "minecraft:furnace", slots: 3, usedSlots: 1, slotsTruncated: false, items: [{ item: "minecraft:coal", count: 1, nbtStacks: 0 }],
      itemsTruncated: false, energy: null, fluids: [], readMicros: 20 } },
];

/** A stand-in server bridge on loopback: snapshot, events, and the query vocabulary with nothing new. */
export function fakeServerBridge(token: string, old = process.env.DEMO_OLD_BRIDGE === "1") {
  const started = Date.now();
  const envelope = (body: Record<string, unknown>) => Response.json({ schema: 1, source: "server-observer", consumer: "management", scopes: ["residents", "facilities"],
    state: "ok", stateDetail: null, servedAtMs: Date.now(), heartbeatAtMs: Date.now(), ...body });
  const empty: Record<string, (params: URLSearchParams) => Record<string, unknown>> = {
    stats: params => ({ resident: params.get("resident"), status: "missing", reason: "demo bridge", savedAtMs: null, dataVersion: null, skipped: 0, types: [] }),
    advancements: params => ({ resident: params.get("resident"), status: "missing", reason: "demo bridge", savedAtMs: null, total: 0, done: 0, matched: 0, offset: 0, more: false, advancements: [] }),
    advancement_catalog: () => ({ builtAtMs: started, total: 0, offset: 0, more: false, problem: null, entries: [] }),
    blocks: () => ({ oldestSeq: 0, latestSeq: 0, gap: false, nextAfter: 0, changes: [] }),
    block_hours: () => ({ cells: [], overflow: [], offset: 0, total: 0, more: false, sinceHourMs: 0, retainedFromHourMs: 0, evictedThroughHourMs: 0 }),
    flows: () => ({ oldestSeq: 0, latestSeq: 0, gap: false, nextAfter: 0, dropped: 0, flows: [] }),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/v1/queries") {
      if (old) return Response.json({ error: { code: "not_found", message: "Unknown observer endpoint." } }, { status: 404 });
      return envelope({ queries: { vocabularyVersion: 1, kinds: Object.keys(empty).map(kind => ({ kind })),
        subjects: { residents: ["Gary", "Margo"], facilities: FACILITIES.map(f => f.id) }, limits: {} } });
    }
    if (url.pathname === "/v1/query" && !old) {
      const kind = url.searchParams.get("kind") ?? "";
      const answer = empty[kind];
      if (!answer) return Response.json({ error: { code: "unknown_kind", message: "Unknown kind." } }, { status: 400 });
      return envelope({ query: { kind, vocabularyVersion: 1, runStartedAtMs: started, params: {}, clamped: [], result: answer(url.searchParams) } });
    }
    if (url.pathname === "/v1/events") return envelope({ events: [], oldestSeq: 0, latestSeq: 0, gap: false });
    if (url.pathname === "/v1/snapshot") {
      const at = Date.now();
      return envelope({ snapshot: { seq: Math.floor((at - started) / 1000) + 1, builtAtMs: at, gameTime: 1200, residents: [],
        facilities: FACILITIES.map(f => ({ ...f, detail: null, checkedAtMs: at, gameTime: 1200, lastKnown: f.lastKnown ?? f.contents, lastObservedAtMs: at - (f.status === "observed" ? 0 : 40 * MINUTE) })) } });
    }
    return Response.json({ error: { code: "not_found", message: "Unknown observer endpoint." } }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
