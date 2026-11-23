// A resident's own advancement frontier, as the advancements screen shows what is one step away: advancements not
// done whose parent is done (or the root of a tab the resident has started), from the catalog and progress the hub
// ingests from the server bridge (observer-ingest.ts, observer-store.ts). Information to consult, never a list of
// tasks: nothing here ranks a resident or prefers one mod over another. Unknown stays unknown: without a working
// bridge, a catalog or the resident's progress the answer is `unavailable` with the reason, never a guess.
import type { Database } from "bun:sqlite";
import type { IngestHealth } from "./observer-ingest.ts";

export interface CatalogRow {
  id: string; title: string | null; frame: string | null; hidden: boolean; criteria: number; requirements: number; parent: string | null;
}
export interface ProgressRow { id: string; done: boolean; criteriaDone: number }

export interface FrontierTab {
  /** The tab's root advancement. */
  id: string;
  title: string;
  /** The server had no readable title; `title` is a readable form of the id. */
  titleIsId: boolean;
  /** Namespace of the root: the base game ("minecraft") or the mod the tab belongs to. */
  mod: string;
  /** Advancements of this tab the resident has done, and how many it shows at all (hidden ones only once done). */
  done: number;
  total: number;
  /** Frontier entries in this tab, whatever scope was asked. */
  withinReach: number;
}
export interface FrontierEntry {
  id: string;
  /** Namespace of the advancement itself: a mod may add advancements to another tab (Quark in Husbandry). */
  mod: string;
  title: string;
  titleIsId: boolean;
  /** task, goal or challenge, as the game frames it. */
  frame: string | null;
  tab: string;
  parent: string | null;
  criteria: {
    met: number;
    total: number;
    /** all: every criterion; any: one of them; groups: one of each of `groups` groups. */
    needs: "all" | "any" | "groups";
    groups: number;
    /** Names of criteria already met (at most 8). The server's files do not name the ones still missing. */
    metNames: string[];
  };
}
export type FrontierReply =
  | { status: "unavailable"; reason: string }
  | {
    status: "ok";
    /** Server clock: the server's last save of this resident's advancements file the hub read. */
    savedAt: number;
    /** Hub clock minus `savedAt`. The server saves about every 5 minutes; the hub reads every 30. */
    ageMs: number;
    /** Hub clock: the hub's last successful read of advancement progress since it started, when known. */
    readAt: number | null;
    catalogBuiltAt: number;
    /** The tab or mod asked for, or null for every tab. */
    scope: string | null;
    scopeMatched: boolean;
    /** Size of the frontier within the scope. */
    total: number;
    /** Which rotation this page is; each call advances it, so repeated calls show different entries. */
    turn: number;
    /** Tabs with something within reach (all tabs, whatever the scope), at most `MAX_TABS`. */
    tabs: FrontierTab[];
    tabsTotal: number;
    entries: FrontierEntry[];
  };

export const MAX_LIMIT = 10, MAX_TABS = 40;
const MAX_DEPTH = 64;

/** A title that is still a translation key ("advancements.occultism.familiar_bat.title"), or none at all. */
export function isRawTitle(title: string | null): boolean {
  return !title?.trim() || /^[\w.:-]+$/.test(title) && title.includes(".") && !/\s/.test(title);
}
/** "minecraft:nether/explore_nether" -> "explore nether"; a root reads as its folder or namespace. */
export function readableId(id: string): string {
  const colon = id.indexOf(":"), segments = id.slice(colon + 1).split("/").filter(Boolean);
  let last = segments.pop() ?? id;
  if (/(^|_)root$/.test(last)) last = segments.pop() ?? id.slice(0, Math.max(0, colon));
  return last.replace(/[_-]+/g, " ").trim() || id;
}
const namespaceOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(":")));
/** Recipe unlocks (`ns:recipes/...`) are bookkeeping, not achievements. */
export const isRecipeUnlock = (id: string) => id.startsWith("recipes/", id.indexOf(":") + 1);
const titled = (title: string | null, id: string) => isRawTitle(title) ? { title: readableId(id), titleIsId: true } : { title: title!.trim(), titleIsId: false };

/** Every entry of the frontier, grouped and ordered (tabs by id; within a tab, ones with progress first, then by id). */
export function computeFrontier(catalogRows: CatalogRow[], progressRows: ProgressRow[], metNames: Map<string, string[]> = new Map()) {
  const catalog = new Map(catalogRows.filter(row => !isRecipeUnlock(row.id)).map(row => [row.id, row]));
  const progress = new Map(progressRows.map(row => [row.id, row]));
  const done = (id: string) => progress.get(id)?.done === true;
  const tabOf = new Map<string, string>();
  const rootOf = (id: string): string => {
    const known = tabOf.get(id);
    if (known) return known;
    let at = catalog.get(id)!;
    for (let depth = 0; depth < MAX_DEPTH && at.parent && catalog.has(at.parent); depth++) at = catalog.get(at.parent)!;
    tabOf.set(id, at.id);
    return at.id;
  };
  const tabs = new Map<string, FrontierTab>();
  const started = new Set<string>();
  for (const row of catalog.values()) {
    const tab = rootOf(row.id), root = catalog.get(tab)!;
    const entry = tabs.get(tab) ?? { id: tab, ...titled(root.title, tab), mod: namespaceOf(tab), done: 0, total: 0, withinReach: 0 };
    tabs.set(tab, entry);
    if (done(row.id)) entry.done++;
    // The game shows a hidden advancement only once it is done.
    if (!row.hidden || done(row.id)) entry.total++;
    if (progress.has(row.id)) started.add(tab);
  }
  const entries: FrontierEntry[] = [];
  for (const row of catalog.values()) {
    if (done(row.id) || row.hidden) continue;
    const tab = rootOf(row.id);
    // A parent without a display is not in the catalog, and the game shows nothing below it.
    const reachable = row.parent ? catalog.has(row.parent) && done(row.parent) : started.has(tab);
    if (!reachable) continue;
    const met = progress.get(row.id)?.criteriaDone ?? 0;
    const needs = row.requirements >= row.criteria ? "all" : row.requirements <= 1 ? "any" : "groups";
    entries.push({
      id: row.id, mod: namespaceOf(row.id), ...titled(row.title, row.id), frame: row.frame, tab, parent: row.parent,
      criteria: { met, total: row.criteria, needs, groups: row.requirements, metNames: (metNames.get(row.id) ?? []).slice(0, 8) },
    });
    tabs.get(tab)!.withinReach++;
  }
  entries.sort((a, b) => a.tab.localeCompare(b.tab) || Number(b.criteria.met > 0) - Number(a.criteria.met > 0) || a.id.localeCompare(b.id));
  return { entries, tabs: [...tabs.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * Page `turn` of size `limit`: counter c runs from seed + turn*limit; entry c comes from tab c mod T, at position
 * floor(c / T) in that tab, wrapping. Neighbouring entries of a page come from different tabs whenever there are
 * enough, and over successive turns every entry of every tab comes round. The seed (one per resident) only keeps
 * every resident's first page from opening on the same tab.
 */
export function rotate(entries: FrontierEntry[], limit: number, turn: number, seed = 0): FrontierEntry[] {
  const byTab = new Map<string, FrontierEntry[]>();
  for (const entry of entries) byTab.set(entry.tab, [...(byTab.get(entry.tab) ?? []), entry]);
  const groups = [...byTab.values()];
  if (!groups.length || limit <= 0) return [];
  const want = Math.min(limit, entries.length), largest = Math.max(...groups.map(group => group.length));
  const picked = new Set<FrontierEntry>();
  const start = seed + turn * limit;
  for (let c = start; picked.size < want && c < start + groups.length * largest + want; c++) {
    const group = groups[c % groups.length]!;
    picked.add(group[Math.floor(c / groups.length) % group.length]!);
  }
  return [...picked];
}

/** Why there is nothing to say, or null when the bridge's advancement data may be used. */
export function unavailableReason(health: IngestHealth | null): string | null {
  if (!health || health.status === "unconfigured") return "This hub does not read advancement progress from the server.";
  if (health.status === "unsupported") return "The server bridge is an older version without advancement queries.";
  if (health.status === "unchecked") return "The hub has not reached the server bridge since it started.";
  if (health.status === "error") return "The server bridge is unreachable from the hub.";
  if (!health.kinds.includes("advancements") || !health.kinds.includes("advancement_catalog")) return "The server bridge does not offer advancement progress to the hub.";
  const step = health.steps.advancements;
  if (step && !step.ok) return "The hub's last read of advancement progress from the server failed.";
  return null;
}

export interface FrontierOptions {
  /** The ingest's health; null when the hub does not ingest the bridge. */
  health?: () => IngestHealth | null;
  now?: () => number;
}
export interface FrontierQuery { scope?: string; limit?: number }

/** The caller's own frontier. Advances the caller's rotation for this scope by one. */
export function residentFrontier(db: Database, resident: string, query: FrontierQuery, options: FrontierOptions): FrontierReply {
  const health = options.health?.() ?? null, now = (options.now ?? Date.now)();
  const reason = unavailableReason(health);
  if (reason) return { status: "unavailable", reason };
  const catalogRows = db.query<{ id: string; title: string | null; frame: string | null; hidden: number; criteria: number; requirements: number; parent: string | null; built_at: number }, []>(
    "SELECT id, title, frame, hidden, criteria, requirements, parent, built_at FROM server_advancement_catalog").all();
  if (!catalogRows.length) return { status: "unavailable", reason: "The hub has not stored the server's advancement list yet." };
  const progressRows = db.query<{ id: string; done: number; criteria_done: number; saved_at: number }, [string]>(
    "SELECT id, done, criteria_done, saved_at FROM server_advancements WHERE resident = ? COLLATE NOCASE").all(resident);
  if (!progressRows.length) return { status: "unavailable", reason: "The hub has no advancement progress of yours yet (the server writes it at autosave and logout)." };
  const metNames = new Map<string, string[]>();
  for (const row of db.query<{ id: string; criterion: string }, [string]>(`SELECT c.id, c.criterion FROM server_advancement_criteria c
    JOIN server_advancements a ON a.resident = c.resident AND a.id = c.id WHERE c.resident = ? COLLATE NOCASE AND a.done = 0 ORDER BY c.id, c.criterion`).all(resident)) {
    metNames.set(row.id, [...(metNames.get(row.id) ?? []), row.criterion]);
  }
  const { entries, tabs } = computeFrontier(
    catalogRows.map(row => ({ ...row, hidden: row.hidden === 1 })),
    progressRows.map(row => ({ id: row.id, done: row.done === 1, criteriaDone: row.criteria_done })), metNames);
  const scope = query.scope?.trim().toLowerCase() || null;
  const tabById = new Map(tabs.map(tab => [tab.id, tab]));
  const inScope = scope === null ? entries : entries.filter(entry => {
    const tab = tabById.get(entry.tab)!;
    return [entry.mod, tab.mod, tab.id, tab.title].some(name => name.toLowerCase() === scope);
  });
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(query.limit ?? 3) || 3));
  // One rotation per resident and scope; only scopes that matched are stored, so keys stay bounded by the tabs.
  const key = `advancement_turn:${resident.toLowerCase()}:${inScope.length ? scope ?? "" : ""}`;
  let turn = 0;
  if (inScope.length) {
    turn = db.query<{ value: number }, [string]>("SELECT value FROM resident_api_state WHERE key = ?").get(key)?.value ?? 0;
    db.query("INSERT INTO resident_api_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, turn + 1);
  }
  const savedAt = Math.max(...progressRows.map(row => row.saved_at));
  const step = health?.steps.advancements;
  const reachable = tabs.filter(tab => tab.withinReach > 0);
  return {
    status: "ok", savedAt, ageMs: Math.max(0, now - savedAt), readAt: step?.ok ? step.at : null,
    catalogBuiltAt: Math.max(...catalogRows.map(row => row.built_at)),
    scope, scopeMatched: scope === null || inScope.length > 0, total: inScope.length, turn,
    tabs: reachable.slice(0, MAX_TABS), tabsTotal: reachable.length,
    entries: rotate(inScope, limit, turn, [...resident.toLowerCase()].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 9973, 7)),
  };
}
