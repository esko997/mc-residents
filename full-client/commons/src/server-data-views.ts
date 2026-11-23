// Aggregations behind the dashboard's Server record panel and the Map's building layer, over what
// the hub ingested from the server bridge (observer-store.ts). Read-only and bounded: every list has
// a limit, and nothing here asks the bridge for anything. Times are the server's clock (epoch ms).
import type { Database } from "bun:sqlite";
import type { IngestHealth } from "./observer-ingest.ts";
import { advancementsOf, containerFlows, ingestGaps } from "./observer-store.ts";
import { dimensionKey } from "./positions.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const TICK_MS = 50;

// ===== statistics: what each resident has done, and how much of it inside a window =====

export const STAT_WINDOWS = ["session", "24h", "7d"] as const;
export type StatWindow = typeof STAT_WINDOWS[number];

export interface StatWindowInfo {
  kind: StatWindow;
  /** The time the changes are counted from (a stored save, or the window's start); null when nothing is stored. */
  from: number | null;
  /** The newest stored save of the statistics file. */
  to: number | null;
  /** Last session only: about when it began, from the play time gained since the save before it. */
  startedAbout: number | null;
  /** The record does not reach back to the start (of the window or of the session): changes count from the first stored save. */
  partial: boolean;
  /** Stored saves after `from` (0: nothing changed in the window as far as the hub knows). */
  saves: number;
}
export interface StatChange { key: string; now: number; change: number }
export interface StatList { kinds: number; total: number; change: number; byChange: StatChange[]; byTotal: StatChange[] }

/** Vanilla counters behind each headline figure (all in `minecraft:custom`). */
export const HEADLINE_KEYS = {
  playTime: ["play_time"],
  onFoot: ["walk_one_cm", "sprint_one_cm", "crouch_one_cm", "walk_on_water_one_cm", "walk_under_water_one_cm", "climb_one_cm"],
  swum: ["swim_one_cm"],
  boat: ["boat_one_cm"],
  ridden: ["horse_one_cm", "pig_one_cm", "strider_one_cm", "minecart_one_cm"],
  glided: ["aviate_one_cm"],
  mobKills: ["mob_kills"],
  deaths: ["deaths"],
  damageTaken: ["damage_taken"],
  damageDealt: ["damage_dealt"],
} as const;
/** Headline figures that are the sum of a whole statistic type. */
export const HEADLINE_TYPES = { mined: "minecraft:mined", crafted: "minecraft:crafted" } as const;
export type HeadlineKey = keyof typeof HEADLINE_KEYS | keyof typeof HEADLINE_TYPES;
/** Item and entity lists shown with names, largest first. */
export const LIST_TYPES = ["mined", "crafted", "used", "picked_up", "killed", "killed_by", "broken", "dropped"] as const;

export interface ResidentStats {
  savedAt: number | null;
  /** The first stored save: the hub knows nothing older. */
  historyFrom: number | null;
  window: StatWindowInfo;
  headline: Record<HeadlineKey, { now: number; change: number }>;
  lists: Record<typeof LIST_TYPES[number], StatList>;
  /** Every `minecraft:custom` counter (distances in cm, times in ticks, damage in tenths of a health point). */
  custom: StatChange[];
}

interface Save { savedAt: number; play: number | null }

/**
 * The last session from stored saves alone: the server writes a resident's statistics file only while
 * it is online (autosave) and at logout, and play time grows only while online. Between two stored
 * saves, play time that grew by less than half the time between them means the resident was away:
 * the session began after the older one. Returns the save to count from and about when play resumed.
 */
export function lastSession(saves: Save[]): { from: number; startedAbout: number | null; partial: boolean } | null {
  if (!saves.length) return null;
  for (let i = saves.length - 1; i > 0; i--) {
    const cur = saves[i], prev = saves[i - 1], gap = cur.savedAt - prev.savedAt;
    if (cur.play === null || prev.play === null) {
      if (gap <= 20 * MINUTE) continue;
      return { from: prev.savedAt, startedAbout: null, partial: false };
    }
    const played = Math.max(0, (cur.play - prev.play) * TICK_MS);
    if (gap <= 6 * MINUTE || played >= gap / 2) continue;
    return { from: prev.savedAt, startedAbout: cur.savedAt - played, partial: false };
  }
  return { from: saves[0].savedAt, startedAbout: null, partial: true };
}

const statKey = (type: string, key: string) => `${type}\n${key}`;

export function residentStats(db: Database, resident: string, window: StatWindow, now: number): ResidentStats {
  const newest = db.query<{ savedAt: number }, [string]>(
    "SELECT saved_at AS savedAt FROM server_stat_snapshots WHERE resident = ? ORDER BY saved_at DESC LIMIT 2000").all(resident).reverse();
  const historyFrom = db.query<{ at: number | null }, [string]>("SELECT MIN(saved_at) AS at FROM server_stat_snapshots WHERE resident = ?").get(resident)?.at ?? null;
  const savedAt = newest.at(-1)?.savedAt ?? null;
  let from: number | null = null, startedAbout: number | null = null, partial = false;
  if (savedAt !== null && historyFrom !== null) {
    if (window === "session") {
      const plays = db.query<{ savedAt: number; value: number; key: string }, [string, number]>(`SELECT saved_at AS savedAt, value, key FROM server_stat_values
        WHERE resident = ? AND type = 'minecraft:custom' AND key IN ('minecraft:play_time', 'minecraft:play_one_minute') AND saved_at >= ? ORDER BY saved_at`)
        .all(resident, newest[0].savedAt - 30 * DAY);
      const key = plays.some(row => row.key === "minecraft:play_time") ? "minecraft:play_time" : "minecraft:play_one_minute";
      const series = plays.filter(row => row.key === key);
      let index = 0, play: number | null = null;
      const saves = newest.map(save => {
        while (index < series.length && series[index].savedAt <= save.savedAt) play = series[index++].value;
        return { savedAt: save.savedAt, play };
      });
      const session = lastSession(saves)!;
      from = session.from; startedAbout = session.startedAbout;
      // The oldest stored save of a session that began before the record did.
      partial = session.partial;
    } else {
      const since = now - (window === "24h" ? DAY : 7 * DAY);
      partial = since < historyFrom;
      from = partial ? historyFrom : since;
    }
  }
  const latest = db.query<{ type: string; key: string; value: number }, [string]>(
    "SELECT type, key, value FROM server_stat_latest WHERE resident = ?").all(resident);
  // SQLite takes the bare columns of a MAX() aggregate from the row holding the maximum.
  const base = new Map(from === null ? [] : db.query<{ type: string; key: string; value: number; at: number }, [string, number]>(
    `SELECT type, key, value, MAX(saved_at) AS at FROM server_stat_values WHERE resident = ? AND saved_at <= ? GROUP BY type, key`)
    .all(resident, from).map(row => [statKey(row.type, row.key), row.value]));
  const changeOf = (type: string, key: string, value: number) => from === null ? 0 : value - (base.get(statKey(type, key)) ?? 0);
  const byType = new Map<string, StatChange[]>();
  for (const row of latest) {
    const list = byType.get(row.type) ?? [];
    list.push({ key: row.key, now: row.value, change: changeOf(row.type, row.key, row.value) });
    byType.set(row.type, list);
  }
  const custom = (byType.get("minecraft:custom") ?? []).sort((a, b) => a.key.localeCompare(b.key));
  const customValue = new Map(custom.map(entry => [entry.key, entry]));
  const headline = {} as ResidentStats["headline"];
  for (const [name, keys] of Object.entries(HEADLINE_KEYS) as [keyof typeof HEADLINE_KEYS, readonly string[]][]) {
    // Before 1.17 play time was called play_one_minute (still in ticks).
    const wanted = name === "playTime" && !customValue.has("minecraft:play_time") ? ["play_one_minute"] : keys;
    const parts = wanted.map(key => customValue.get(`minecraft:${key}`)).filter((entry): entry is StatChange => entry !== undefined);
    headline[name] = { now: parts.reduce((sum, part) => sum + part.now, 0), change: parts.reduce((sum, part) => sum + part.change, 0) };
  }
  for (const [name, type] of Object.entries(HEADLINE_TYPES) as [keyof typeof HEADLINE_TYPES, string][]) {
    const list = byType.get(type) ?? [];
    headline[name] = { now: list.reduce((sum, entry) => sum + entry.now, 0), change: list.reduce((sum, entry) => sum + entry.change, 0) };
  }
  const lists = {} as ResidentStats["lists"];
  for (const name of LIST_TYPES) {
    const list = byType.get(`minecraft:${name}`) ?? [];
    lists[name] = {
      kinds: list.length, total: list.reduce((sum, entry) => sum + entry.now, 0), change: list.reduce((sum, entry) => sum + entry.change, 0),
      byChange: list.filter(entry => entry.change > 0).sort((a, b) => b.change - a.change || a.key.localeCompare(b.key)).slice(0, 8),
      byTotal: [...list].sort((a, b) => b.now - a.now || a.key.localeCompare(b.key)).slice(0, 8),
    };
  }
  const saves = from === null ? 0 : newest.filter(save => save.savedAt > from!).length;
  return { savedAt, historyFrom, window: { kind: window, from, to: savedAt, startedAbout, partial, saves }, headline, lists, custom };
}

// ===== advancements: per tab, recently earned, and what is close =====

interface CatalogEntry { id: string; title: string | null; frame: string | null; hidden: number; criteria: number; requirements: number; parent: string | null }
export interface AdvancementTab { id: string; title: string | null; vanilla: boolean; total: number; hidden: number }
export interface Catalog { builtAt: number | null; total: number; tabs: AdvancementTab[]; entries: Map<string, CatalogEntry & { tab: string }> }

const VANILLA_TABS = ["minecraft:story/root", "minecraft:nether/root", "minecraft:end/root", "minecraft:adventure/root", "minecraft:husbandry/root"];

/** The loaded advancements with a display, each assigned to its in-game tab (the root its parents lead to). */
export function advancementCatalog(db: Database): Catalog {
  const rows = db.query<CatalogEntry & { builtAt: number }, []>(`SELECT id, title, frame, hidden, criteria, requirements, parent, built_at AS builtAt
    FROM server_advancement_catalog LIMIT 20000`).all();
  const byId = new Map(rows.map(row => [row.id, row]));
  const roots = new Map<string, string>();
  const rootOf = (id: string): string => {
    const known = roots.get(id);
    if (known) return known;
    let at = id;
    // Mods hang advancements under other namespaces' tabs. One whose parent is not loaded has no tab
    // in the game; those are grouped per namespace (`occultism:*`) rather than shown as tabs of one.
    for (let depth = 0; depth < 64; depth++) {
      const parent = byId.get(at)?.parent;
      if (!parent) break;
      if (!byId.has(parent)) { at = `${at.split(":")[0]}:*`; break; }
      at = parent;
    }
    roots.set(id, at);
    return at;
  };
  const entries = new Map<string, CatalogEntry & { tab: string }>();
  const tabs = new Map<string, AdvancementTab>();
  for (const row of rows) {
    const tab = rootOf(row.id);
    entries.set(row.id, { ...row, tab });
    const entry = tabs.get(tab) ?? { id: tab, title: byId.get(tab)?.title ?? null, vanilla: tab.startsWith("minecraft:"), total: 0, hidden: 0 };
    entry.total++;
    if (row.hidden) entry.hidden++;
    tabs.set(tab, entry);
  }
  // The five vanilla tabs in the game's order, then other tabs, then advancements outside any tab.
  const order = (tab: AdvancementTab) => {
    const i = VANILLA_TABS.indexOf(tab.id);
    return i >= 0 ? i : VANILLA_TABS.length + (tab.id.endsWith(":*") ? 2 : tab.vanilla ? 0 : 1);
  };
  return {
    builtAt: rows.reduce<number | null>((max, row) => max === null || row.builtAt > max ? row.builtAt : max, null),
    total: rows.length, entries,
    tabs: [...tabs.values()].sort((a, b) => order(a) - order(b) || b.total - a.total || a.id.localeCompare(b.id)),
  };
}

export interface AdvancementItem { id: string; title: string | null; frame: string | null; tab: string | null }
export interface ResidentAdvancements {
  /** When the server last wrote the resident's advancement file (as stored). */
  savedAt: number | null;
  /** The earliest criterion time in the file: about when the resident first played here. */
  firstAt: number | null;
  done: number;
  tabs: { id: string; done: number; started: number }[];
  recent: (AdvancementItem & { doneAt: number | null })[];
  /** Started, not done; `remaining` is null when its criteria are alternatives (any one of several). */
  nearly: (AdvancementItem & { criteriaDone: number; criteriaTotal: number | null; remaining: number | null })[];
  /** Not started, visible, and its parent is done: what the game shows next in each tab. */
  next: AdvancementItem[];
  nextCount: number;
  /** Progress on advancements the catalog does not list (no display, or not loaded any more). */
  outsideCatalog: number;
}

export function residentAdvancements(db: Database, resident: string, catalog: Catalog): ResidentAdvancements {
  const rows = advancementsOf(db, resident);
  const mine = new Map(rows.map(row => [row.id, row]));
  const item = (id: string, title: string | null, frame: string | null): AdvancementItem =>
    ({ id, title: title ?? catalog.entries.get(id)?.title ?? null, frame: frame ?? catalog.entries.get(id)?.frame ?? null, tab: catalog.entries.get(id)?.tab ?? null });
  const tabs = new Map<string, { id: string; done: number; started: number }>(catalog.tabs.map(tab => [tab.id, { id: tab.id, done: 0, started: 0 }]));
  let outsideCatalog = 0;
  for (const row of rows) {
    const tab = catalog.entries.get(row.id)?.tab;
    if (!tab) { outsideCatalog++; continue; }
    const counts = tabs.get(tab)!;
    if (row.done) counts.done++; else if (row.criteriaDone > 0) counts.started++;
  }
  // Only advancements with a display (in the catalog) are counted and listed, as the game's own screen does.
  const shown = rows.filter(row => catalog.entries.has(row.id));
  const done = shown.filter(row => row.done === 1);
  const nearly = shown.filter(row => row.done === 0 && row.criteriaDone > 0).map(row => {
    const entry = catalog.entries.get(row.id), total = row.criteriaTotal;
    const remaining = entry && total !== null && entry.requirements === entry.criteria ? Math.max(1, total - row.criteriaDone) : null;
    return { ...item(row.id, row.title, row.frame), criteriaDone: row.criteriaDone, criteriaTotal: total, remaining };
  }).sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity) || a.id.localeCompare(b.id));
  const next = [...catalog.entries.values()].filter(entry => !entry.hidden && !mine.has(entry.id) && entry.parent !== null && mine.get(entry.parent)?.done === 1);
  const tabOrder = new Map(catalog.tabs.map((tab, index) => [tab.id, index]));
  next.sort((a, b) => (tabOrder.get(a.tab) ?? 0) - (tabOrder.get(b.tab) ?? 0) || a.id.localeCompare(b.id));
  return {
    savedAt: rows.reduce<number | null>((max, row) => max === null || row.savedAt > max ? row.savedAt : max, null),
    firstAt: db.query<{ at: number | null }, [string]>("SELECT MIN(achieved_at) AS at FROM server_advancement_criteria WHERE resident = ?").get(resident)?.at ?? null,
    done: done.length,
    tabs: [...tabs.values()].filter(tab => tab.done || tab.started),
    recent: done.slice(0, 12).map(row => ({ ...item(row.id, row.title, row.frame), doneAt: row.doneAt })),
    nearly: nearly.slice(0, 8),
    next: next.slice(0, 8).map(entry => item(entry.id, entry.title, entry.frame)),
    nextCount: next.length,
    outsideCatalog,
  };
}

// ===== blocks: per-chunk activity for the Map, areas, and one chunk's detail =====

/** Stored dimension ids for a map key (`overworld` was stored as `minecraft:overworld`). */
const dimensionIds = (key: string) => [key, `minecraft:${key}`];
/** 64-block areas (4 x 4 chunks), for "who built where". */
const AREA_CHUNKS = 4;
const floorDiv = (value: number, by: number) => Math.floor(value / by);

export interface BlockMapQuery { since: number; until: number; dimension?: string; resident?: string; limit: number }

export function blockMap(db: Database, q: BlockMapQuery) {
  const where = `hour >= ?1 AND hour < ?2 AND (?3 IS NULL OR dimension IN (?3, ?4)) AND (?5 IS NULL OR resident = ?5)`;
  const ids = q.dimension ? dimensionIds(q.dimension) : [null, null];
  const args = [q.since, q.until, ids[0], ids[1], q.resident ?? null] as const;
  type Args = [number, number, string | null, string | null, string | null];
  const dimensions = db.query<{ dimension: string; placed: number; broken: number }, Args>(`SELECT dimension, SUM(placed) AS placed, SUM(broken) AS broken
    FROM server_block_hours WHERE hour >= ?1 AND hour < ?2 AND (?5 IS NULL OR resident = ?5)
    GROUP BY dimension ORDER BY dimension`).all(...args);
  const cells = db.query<{ dimension: string; chunkX: number; chunkZ: number; resident: string; placed: number; broken: number; firstAt: number; lastAt: number; hours: number }, [...Args, number]>(
    `SELECT dimension, chunk_x AS chunkX, chunk_z AS chunkZ, resident, SUM(placed) AS placed, SUM(broken) AS broken,
       MIN(first_at) AS firstAt, MAX(last_at) AS lastAt, COUNT(DISTINCT hour) AS hours
     FROM server_block_hours WHERE ${where} GROUP BY dimension, chunk_x, chunk_z, resident
     ORDER BY SUM(placed) + SUM(broken) DESC, dimension, chunk_x, chunk_z, resident LIMIT ?6`).all(...args, q.limit + 1);
  const hours = db.query<{ hour: number; dimension: string; resident: string; placed: number; broken: number }, Args>(
    `SELECT hour, dimension, resident, SUM(placed) AS placed, SUM(broken) AS broken FROM server_block_hours WHERE ${where}
     GROUP BY hour, dimension, resident ORDER BY hour LIMIT 20000`).all(...args);
  // Areas: summed from the chunk rows (bounded above), with their most changed blocks.
  const areas = new Map<string, { dimension: string; areaX: number; areaZ: number; resident: string; placed: number; broken: number; chunks: number; lastAt: number;
    kinds: Map<string, { block: string; placed: number; broken: number }> }>();
  const areaKey = (dimension: string, chunkX: number, chunkZ: number, resident: string) =>
    `${dimension}|${floorDiv(chunkX, AREA_CHUNKS)}|${floorDiv(chunkZ, AREA_CHUNKS)}|${resident}`;
  for (const cell of cells.slice(0, q.limit)) {
    const key = areaKey(cell.dimension, cell.chunkX, cell.chunkZ, cell.resident);
    const area = areas.get(key) ?? { dimension: dimensionKey(cell.dimension), areaX: floorDiv(cell.chunkX, AREA_CHUNKS), areaZ: floorDiv(cell.chunkZ, AREA_CHUNKS),
      resident: cell.resident, placed: 0, broken: 0, chunks: 0, lastAt: 0, kinds: new Map() };
    area.placed += cell.placed; area.broken += cell.broken; area.chunks++; area.lastAt = Math.max(area.lastAt, cell.lastAt);
    areas.set(key, area);
  }
  const kinds = db.query<{ dimension: string; chunkX: number; chunkZ: number; resident: string; block: string; placed: number; broken: number }, Args>(
    `SELECT dimension, chunk_x AS chunkX, chunk_z AS chunkZ, resident, json_extract(k.value, '$.block') AS block,
       SUM(json_extract(k.value, '$.placed')) AS placed, SUM(json_extract(k.value, '$.broken')) AS broken
     FROM server_block_hours, json_each(server_block_hours.kinds_json) AS k WHERE ${where}
     GROUP BY dimension, chunk_x, chunk_z, resident, block LIMIT 40000`).all(...args);
  for (const kind of kinds) {
    const area = areas.get(areaKey(kind.dimension, kind.chunkX, kind.chunkZ, kind.resident));
    if (!area) continue;
    const entry = area.kinds.get(kind.block) ?? { block: kind.block, placed: 0, broken: 0 };
    entry.placed += kind.placed; entry.broken += kind.broken;
    area.kinds.set(kind.block, entry);
  }
  const overflow = db.query<{ resident: string; placed: number; broken: number }, [number, number, string | null]>(`SELECT resident, SUM(placed) AS placed, SUM(broken) AS broken
    FROM server_block_overflow WHERE hour >= ? AND hour < ? AND (?3 IS NULL OR resident = ?3) GROUP BY resident ORDER BY resident`).all(q.since, q.until, q.resident ?? null);
  return {
    since: q.since, until: q.until,
    dimensions: [...new Map(dimensions.map(row => [dimensionKey(row.dimension), row])).entries()].map(([dimension, row]) => ({ dimension, placed: row.placed, broken: row.broken })),
    cells: cells.slice(0, q.limit).map(cell => ({ ...cell, dimension: dimensionKey(cell.dimension) })),
    truncated: cells.length > q.limit,
    hours: hours.map(row => ({ ...row, dimension: dimensionKey(row.dimension) })),
    areas: [...areas.values()].sort((a, b) => b.placed + b.broken - (a.placed + a.broken)).slice(0, 60).map(({ kinds: found, ...area }) => ({
      ...area, kinds: [...found.values()].sort((a, b) => b.placed + b.broken - (a.placed + a.broken) || a.block.localeCompare(b.block)).slice(0, 4),
    })),
    overflow,
  };
}

export function blockCell(db: Database, q: { dimension: string; chunkX: number; chunkZ: number; since: number; until: number; limit: number }) {
  const [a, b] = dimensionIds(q.dimension);
  type Args = [number, number, string, string, number, number];
  const args: Args = [q.since, q.until, a, b, q.chunkX, q.chunkZ];
  const where = "hour >= ?1 AND hour < ?2 AND dimension IN (?3, ?4) AND chunk_x = ?5 AND chunk_z = ?6";
  const hours = db.query<{ hour: number; resident: string; placed: number; broken: number }, Args>(
    `SELECT hour, resident, SUM(placed) AS placed, SUM(broken) AS broken FROM server_block_hours WHERE ${where} GROUP BY hour, resident ORDER BY hour`).all(...args);
  const kinds = db.query<{ resident: string; block: string; placed: number; broken: number }, Args>(
    `SELECT resident, json_extract(k.value, '$.block') AS block, SUM(json_extract(k.value, '$.placed')) AS placed, SUM(json_extract(k.value, '$.broken')) AS broken
     FROM server_block_hours, json_each(server_block_hours.kinds_json) AS k WHERE ${where}
     GROUP BY resident, block ORDER BY SUM(json_extract(k.value, '$.placed')) + SUM(json_extract(k.value, '$.broken')) DESC, block LIMIT 200`).all(...args);
  const other = db.query<{ resident: string; placed: number; broken: number }, Args>(
    `SELECT resident, SUM(other_placed) AS placed, SUM(other_broken) AS broken FROM server_block_hours WHERE ${where} GROUP BY resident HAVING SUM(other_placed) + SUM(other_broken) > 0`).all(...args);
  const x0 = q.chunkX * 16, z0 = q.chunkZ * 16;
  type DetailArgs = [number, number, string, string, number, number, number, number];
  const detailArgs: DetailArgs = [q.since, q.until, a, b, x0, x0 + 15, z0, z0 + 15];
  const detailWhere = "at >= ?1 AND at < ?2 AND dimension IN (?3, ?4) AND x BETWEEN ?5 AND ?6 AND z BETWEEN ?7 AND ?8";
  const changes = db.query<{ resident: string; action: string; x: number; y: number; z: number; block: string; at: number }, [...DetailArgs, number]>(
    `SELECT resident, action, x, y, z, block, at FROM server_block_changes WHERE ${detailWhere} ORDER BY at DESC, run DESC, seq DESC LIMIT ?9`).all(...detailArgs, q.limit);
  const detailed = db.query<{ n: number }, DetailArgs>(`SELECT COUNT(*) AS n FROM server_block_changes WHERE ${detailWhere}`).get(...detailArgs)?.n ?? 0;
  const counted = hours.reduce((sum, row) => sum + row.placed + row.broken, 0);
  return {
    dimension: q.dimension, chunkX: q.chunkX, chunkZ: q.chunkZ, since: q.since, until: q.until,
    hours, kinds, other, changes, counted, detailed,
    /** The oldest individual change the hub still keeps (any place): detail before it is gone. */
    detailFrom: db.query<{ at: number | null }, []>("SELECT MIN(at) AS at FROM server_block_changes").get()?.at ?? null,
  };
}

// ===== container flows: a ledger per registered facility =====

export interface FacilityInfo { label: string; dimension: string; pos: number[] }

export function facilityLedger(db: Database, since: number, facilities: Map<string, FacilityInfo>, limit = 2000) {
  const flows = containerFlows(db, { since, limit: limit + 1 });
  const truncated = flows.length > limit;
  interface Ledger {
    facility: string; label: string | null; dimension: string | null; pos: number[] | null; flows: number; firstAt: number; lastAt: number;
    items: Map<string, { item: string; in: number; out: number }>; nearest: Map<string, number>; nearby: Map<string, number>; unattributed: number;
    uncertain: Map<string, number>; recent: typeof flows;
  }
  const byFacility = new Map<string, Ledger>();
  for (const flow of flows.slice(0, limit)) {
    const info = facilities.get(flow.facility);
    const entry: Ledger = byFacility.get(flow.facility) ?? {
      facility: flow.facility, label: info?.label ?? null, dimension: info ? dimensionKey(info.dimension) : null, pos: info?.pos ?? null,
      flows: 0, firstAt: flow.at, lastAt: flow.at, items: new Map(), nearest: new Map(), nearby: new Map(), unattributed: 0, uncertain: new Map(), recent: [],
    };
    entry.flows++;
    entry.firstAt = Math.min(entry.firstAt, flow.sinceAt);
    entry.lastAt = Math.max(entry.lastAt, flow.at);
    for (const delta of flow.deltas) {
      const item = entry.items.get(delta.item) ?? { item: delta.item, in: 0, out: 0 };
      const change = delta.after - delta.before;
      if (change > 0) item.in += change; else item.out -= change;
      entry.items.set(delta.item, item);
    }
    if (flow.resident) entry.nearest.set(flow.resident, (entry.nearest.get(flow.resident) ?? 0) + 1); else entry.unattributed++;
    for (const near of new Set(flow.nearby.map(n => n.resident))) entry.nearby.set(near, (entry.nearby.get(near) ?? 0) + 1);
    for (const reason of flow.uncertain) entry.uncertain.set(reason, (entry.uncertain.get(reason) ?? 0) + 1);
    if (entry.recent.length < 12) entry.recent.push(flow);
    byFacility.set(flow.facility, entry);
  }
  const counts = (map: Map<string, number>) => [...map].map(([name, n]) => ({ name, flows: n })).sort((a, b) => b.flows - a.flows || a.name.localeCompare(b.name));
  return {
    since, truncated,
    facilities: [...byFacility.values()].sort((a, b) => b.lastAt - a.lastAt).map(entry => ({
      ...entry,
      items: [...entry.items.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || a.item.localeCompare(b.item)).slice(0, 40),
      nearest: counts(entry.nearest), nearby: counts(entry.nearby), uncertain: counts(entry.uncertain),
    })),
  };
}

// ===== data health: per data set, near the data it affects =====

const SETS = {
  stats: ["stats"], advancements: ["advancements", "advancement_catalog"], blocks: ["block_hours", "blocks"], flows: ["flows"],
} as const;
export type DataSet = keyof typeof SETS;
/** Gap kinds (as recorded by the ingest) under the data set they affect. */
const GAP_SET: Record<string, DataSet> = { blocks: "blocks", block_hours: "blocks", flows: "flows", stats: "stats", advancements: "advancements" };

export interface DataSetHealth {
  /** true: the bridge offers every query this set needs; false: it does not (`missing` says which); null: not known yet. */
  supported: boolean | null;
  missing: string[];
  /** The newest ingestion pass that touched this set (since the hub started). */
  lastPass: { at: number; ok: boolean; detail: string | null } | null;
  /** The newest time in the stored data itself (server clock), and when the hub last received it where it records that. */
  newest: number | null;
  received: number | null;
  gaps: { count: number; recent: { kind: string; detail: string; at: number }[] };
}
export interface ServerDataHealth {
  status: IngestHealth["status"];
  detail: string | null;
  checkedAt: number | null;
  okAt: number | null;
  sets: Record<DataSet, DataSetHealth>;
}

export function dataHealth(db: Database, ingest: IngestHealth | null, now: number): ServerDataHealth {
  const status = ingest?.status ?? "unconfigured";
  const max = (sql: string) => db.query<{ at: number | null }, []>(sql).get()?.at ?? null;
  const newest: Record<DataSet, [number | null, number | null]> = {
    stats: [max("SELECT MAX(saved_at) AS at FROM server_stat_snapshots"), max("SELECT MAX(received_at) AS at FROM server_stat_snapshots")],
    advancements: [max("SELECT MAX(saved_at) AS at FROM server_advancements"), null],
    blocks: [max("SELECT MAX(last_at) AS at FROM server_block_hours"), null],
    flows: [max("SELECT MAX(at) AS at FROM server_container_flows"), null],
  };
  const gaps = ingestGaps(db, now - 7 * DAY);
  const sets = {} as Record<DataSet, DataSetHealth>;
  for (const [set, kinds] of Object.entries(SETS) as [DataSet, readonly string[]][]) {
    const known = status !== "unconfigured" && status !== "unchecked" && (status === "unsupported" || (ingest?.kinds.length ?? 0) > 0);
    const missing = !known ? [] : status === "unsupported" ? [...kinds] : kinds.filter(kind => !ingest!.kinds.includes(kind));
    const steps = kinds.map(kind => ingest?.steps[kind === "advancement_catalog" ? "catalog" : kind]).filter(step => step !== undefined);
    const last = steps.sort((a, b) => b.at - a.at)[0];
    const mine = gaps.filter(gap => GAP_SET[gap.kind] === set);
    sets[set] = {
      supported: known ? missing.length === 0 : null, missing,
      lastPass: last ? { at: last.at, ok: steps.every(step => step.ok), detail: steps.find(step => !step.ok)?.detail ?? null } : null,
      newest: newest[set][0], received: newest[set][1],
      gaps: { count: mine.length, recent: mine.slice(0, 5) },
    };
  }
  return { status, detail: ingest?.detail ?? null, checkedAt: ingest?.checkedAt || null, okAt: ingest?.okAt ?? null, sets };
}
