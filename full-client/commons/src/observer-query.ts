// Client for the server bridge's declarative queries (`/v1/queries`, `/v1/query`; server-observer/README.md).
// The bridge interprets a fixed vocabulary and enforces every limit itself; this side only names a kind and
// its parameters and checks the reply's shape. A bridge built before the vocabulary answers 404 to
// `/v1/queries`: callers treat that as "unsupported", not as an outage.
import { record } from "./json.ts";
import { observerGet, observerRead, type ObserverResult, type ObserverSource } from "./observer.ts";

export const QUERY_KINDS = ["stats", "advancements", "advancement_catalog", "blocks", "block_hours", "flows"] as const;
export type QueryKind = typeof QUERY_KINDS[number];

export interface QueryVocabulary {
  version: number;
  /** Kinds this token may use. */
  kinds: string[];
  /** Subjects this token may name: configured residents and registered facilities only. */
  residents: string[];
  facilities: string[];
  limits: Record<string, unknown>;
}
export type VocabularyResult =
  | { ok: true; vocabulary: QueryVocabulary; receivedAt: number }
  | { ok: false; status: string; detail: string; httpStatus?: number; code?: string; /** An older bridge without queries. */ unsupported: boolean };

export interface QueryEnvelope<R> {
  kind: QueryKind;
  /** The bridge's start time: sequence numbers and in-memory counts restart with it. */
  runStartedAtMs: number;
  clamped: string[];
  params: Record<string, unknown>;
  result: R;
}

// === result shapes (server clock milliseconds throughout) ===

export interface StatsResult {
  resident: string;
  status: "observed" | "stale" | "missing" | "too_large" | "unreadable" | "unavailable";
  reason: string | null;
  /** When the server last wrote the file these values come from. */
  savedAtMs: number | null;
  dataVersion: number | null;
  skipped: number;
  types: { type: string; total: number; truncated: boolean; values: Record<string, number> }[];
}
export interface AdvancementProgress {
  id: string; done: boolean; criteriaDone: number; criteriaTotal: number | null; title: string | null; frame: string | null;
  criteriaTruncated: boolean; criteria: { name: string; atMs: number | null }[];
}
export interface AdvancementsResult {
  resident: string; status: StatsResult["status"]; reason: string | null; savedAtMs: number | null;
  total: number; done: number; matched: number; offset: number; more: boolean; advancements: AdvancementProgress[];
}
export interface CatalogEntry { id: string; title: string | null; frame: string | null; hidden: boolean; criteria: number; requirements: number; parent: string | null }
export interface CatalogResult { builtAtMs: number; total: number; offset: number; more: boolean; problem: string | null; entries: CatalogEntry[] }
export interface RingPage { oldestSeq: number; latestSeq: number; gap: boolean; nextAfter: number }
export interface BlockChange {
  seq: number; resident: string; action: "place" | "break"; dimension: string; x: number; y: number; z: number; block: string; atMs: number; gameTime: number;
}
export interface BlocksResult extends RingPage { changes: BlockChange[] }
export interface BlockCell {
  resident: string; dimension: string; chunkX: number; chunkZ: number; hourMs: number; placed: number; broken: number;
  kinds: { block: string; placed: number; broken: number }[]; otherPlaced: number; otherBroken: number; firstAtMs: number; lastAtMs: number;
}
export interface BlockHoursResult {
  cells: BlockCell[]; overflow: { resident: string; hourMs: number; placed: number; broken: number }[];
  offset: number; total: number; more: boolean; sinceHourMs: number; retainedFromHourMs: number; evictedThroughHourMs: number;
}
export interface Flow {
  seq: number; facility: string; dimension: string; atMs: number; gameTime: number; sinceMs: number; continuous: boolean;
  deltas: { item: string; before: number; after: number; nbtBefore: number; nbtAfter: number }[]; deltasTruncated: boolean;
  uncertain: string[];
  /** Evidence, not proof: the nearest configured resident within reach, never a human. */
  attribution: "nearest_resident_within_reach" | "no_resident_within_reach";
  resident: string | null;
  nearby: { resident: string; distance: number; when: string }[];
}
export interface FlowsResult extends RingPage { dropped: number; flows: Flow[] }

// === shape checks: a reply that does not match is refused whole, never half-ingested ===

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const nstr = (v: unknown): v is string | null => v === null || typeof v === "string";
const nint = (v: unknown): v is number | null => v === null || int(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const array = (v: unknown): unknown[] | null => Array.isArray(v) ? v : null;
function all<T>(v: unknown, parse: (item: Record<string, unknown>) => T | null): T[] | null {
  const items = array(v);
  if (!items) return null;
  const out: T[] = [];
  for (const item of items) {
    const parsed = parse(record(item));
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}
const FILE_STATUSES: Record<string, true> = { observed: true, stale: true, missing: true, too_large: true, unreadable: true, unavailable: true };

function ring(r: Record<string, unknown>): RingPage | null {
  return int(r.oldestSeq) && int(r.latestSeq) && bool(r.gap) && int(r.nextAfter)
    ? { oldestSeq: r.oldestSeq, latestSeq: r.latestSeq, gap: r.gap, nextAfter: r.nextAfter } : null;
}

export function parseStats(r: Record<string, unknown>): StatsResult | null {
  if (!str(r.resident) || !str(r.status) || !Object.hasOwn(FILE_STATUSES, r.status) || !nstr(r.reason) || !nint(r.savedAtMs) || !nint(r.dataVersion) || !int(r.skipped)) return null;
  const types = all(r.types, t => {
    const values = record(t.values);
    if (!str(t.type) || !int(t.total) || !bool(t.truncated) || !Object.values(values).every(int)) return null;
    return { type: t.type, total: t.total, truncated: t.truncated, values: values as Record<string, number> };
  });
  if (!types) return null;
  return { resident: r.resident, status: r.status as StatsResult["status"], reason: r.reason, savedAtMs: r.savedAtMs, dataVersion: r.dataVersion, skipped: r.skipped, types };
}

export function parseAdvancements(r: Record<string, unknown>): AdvancementsResult | null {
  if (!str(r.resident) || !str(r.status) || !Object.hasOwn(FILE_STATUSES, r.status) || !nstr(r.reason) || !nint(r.savedAtMs)
    || !int(r.total) || !int(r.done) || !int(r.matched) || !int(r.offset) || !bool(r.more)) return null;
  const advancements = all(r.advancements, a => {
    const criteria = all(a.criteria, c => str(c.name) && nint(c.atMs) ? { name: c.name, atMs: c.atMs } : null);
    if (!criteria || !str(a.id) || !bool(a.done) || !int(a.criteriaDone) || !nint(a.criteriaTotal) || !nstr(a.title) || !nstr(a.frame) || !bool(a.criteriaTruncated)) return null;
    return { id: a.id, done: a.done, criteriaDone: a.criteriaDone, criteriaTotal: a.criteriaTotal, title: a.title, frame: a.frame, criteriaTruncated: a.criteriaTruncated, criteria };
  });
  if (!advancements) return null;
  return { resident: r.resident, status: r.status as StatsResult["status"], reason: r.reason, savedAtMs: r.savedAtMs, total: r.total, done: r.done, matched: r.matched, offset: r.offset, more: r.more, advancements };
}

export function parseCatalog(r: Record<string, unknown>): CatalogResult | null {
  if (!int(r.builtAtMs) || !int(r.total) || !int(r.offset) || !bool(r.more) || !nstr(r.problem)) return null;
  const entries = all(r.entries, e => str(e.id) && nstr(e.title) && nstr(e.frame) && bool(e.hidden) && int(e.criteria) && int(e.requirements) && nstr(e.parent)
    ? { id: e.id, title: e.title, frame: e.frame, hidden: e.hidden, criteria: e.criteria, requirements: e.requirements, parent: e.parent } : null);
  return entries ? { builtAtMs: r.builtAtMs, total: r.total, offset: r.offset, more: r.more, problem: r.problem, entries } : null;
}

export function parseBlocks(r: Record<string, unknown>): BlocksResult | null {
  const page = ring(r);
  const changes = all(r.changes, c => int(c.seq) && str(c.resident) && (c.action === "place" || c.action === "break") && str(c.dimension)
    && int(c.x) && int(c.y) && int(c.z) && str(c.block) && int(c.atMs) && int(c.gameTime)
    ? { seq: c.seq, resident: c.resident, action: c.action as BlockChange["action"], dimension: c.dimension, x: c.x, y: c.y, z: c.z, block: c.block, atMs: c.atMs, gameTime: c.gameTime } : null);
  return page && changes ? { ...page, changes } : null;
}

export function parseBlockHours(r: Record<string, unknown>): BlockHoursResult | null {
  if (!int(r.offset) || !int(r.total) || !bool(r.more) || !int(r.sinceHourMs) || !int(r.retainedFromHourMs) || !int(r.evictedThroughHourMs)) return null;
  const cells = all(r.cells, c => {
    const kinds = all(c.kinds, k => str(k.block) && int(k.placed) && int(k.broken) ? { block: k.block, placed: k.placed, broken: k.broken } : null);
    return kinds && str(c.resident) && str(c.dimension) && int(c.chunkX) && int(c.chunkZ) && int(c.hourMs) && int(c.placed) && int(c.broken)
      && int(c.otherPlaced) && int(c.otherBroken) && int(c.firstAtMs) && int(c.lastAtMs)
      ? { resident: c.resident, dimension: c.dimension, chunkX: c.chunkX, chunkZ: c.chunkZ, hourMs: c.hourMs, placed: c.placed, broken: c.broken,
        kinds, otherPlaced: c.otherPlaced, otherBroken: c.otherBroken, firstAtMs: c.firstAtMs, lastAtMs: c.lastAtMs } : null;
  });
  const overflow = all(r.overflow, o => str(o.resident) && int(o.hourMs) && int(o.placed) && int(o.broken)
    ? { resident: o.resident, hourMs: o.hourMs, placed: o.placed, broken: o.broken } : null);
  return cells && overflow ? {
    cells, overflow, offset: r.offset, total: r.total, more: r.more,
    sinceHourMs: r.sinceHourMs, retainedFromHourMs: r.retainedFromHourMs, evictedThroughHourMs: r.evictedThroughHourMs,
  } : null;
}

export function parseFlows(r: Record<string, unknown>): FlowsResult | null {
  const page = ring(r);
  if (!page || !int(r.dropped)) return null;
  const flows = all(r.flows, f => {
    const deltas = all(f.deltas, d => str(d.item) && int(d.before) && int(d.after) && int(d.nbtBefore) && int(d.nbtAfter)
      ? { item: d.item, before: d.before, after: d.after, nbtBefore: d.nbtBefore, nbtAfter: d.nbtAfter } : null);
    const nearby = all(f.nearby, n => str(n.resident) && num(n.distance) && str(n.when) ? { resident: n.resident, distance: n.distance, when: n.when } : null);
    const uncertain = array(f.uncertain);
    if (!deltas || !nearby || !uncertain || !uncertain.every(str) || !int(f.seq) || !str(f.facility) || !str(f.dimension) || !int(f.atMs)
      || !int(f.gameTime) || !int(f.sinceMs) || !bool(f.continuous) || !bool(f.deltasTruncated) || !nstr(f.resident)
      || (f.attribution !== "nearest_resident_within_reach" && f.attribution !== "no_resident_within_reach")) return null;
    return {
      seq: f.seq, facility: f.facility, dimension: f.dimension, atMs: f.atMs, gameTime: f.gameTime, sinceMs: f.sinceMs, continuous: f.continuous,
      deltas, deltasTruncated: f.deltasTruncated, uncertain: uncertain as string[], attribution: f.attribution as Flow["attribution"], resident: f.resident, nearby,
    };
  });
  return flows ? { ...page, dropped: r.dropped, flows } : null;
}

/** The result type of each query kind. */
export interface QueryResults {
  stats: StatsResult; advancements: AdvancementsResult; advancement_catalog: CatalogResult;
  blocks: BlocksResult; block_hours: BlockHoursResult; flows: FlowsResult;
}
export type QueryResult<K extends QueryKind> = QueryResults[K];
const RESULT_PARSERS: { [K in QueryKind]: (r: Record<string, unknown>) => QueryResults[K] | null } = {
  stats: parseStats, advancements: parseAdvancements, advancement_catalog: parseCatalog,
  blocks: parseBlocks, block_hours: parseBlockHours, flows: parseFlows,
};

/** Which kinds and subjects this token may use, or `unsupported` when the bridge predates queries. */
export async function observerVocabulary(source: ObserverSource, get: typeof observerGet = observerGet): Promise<VocabularyResult> {
  const reply = await observerRead(source, "/v1/queries", get, raw => {
    const q = record(raw.queries), subjects = record(q.subjects);
    const kinds = all(q.kinds, k => str(k.kind) ? k.kind : null);
    const residents = array(subjects.residents), facilities = array(subjects.facilities);
    if (!int(q.vocabularyVersion) || !kinds || !residents?.every(str) || !facilities?.every(str)) return null;
    return { vocabulary: { version: q.vocabularyVersion, kinds, residents: residents as string[], facilities: facilities as string[], limits: record(q.limits) } };
  });
  if (!reply.ok) return { ...reply, unsupported: reply.httpStatus === 404 };
  return { ok: true, vocabulary: reply.data.vocabulary, receivedAt: reply.receivedAt };
}

/** One query. Parameters outside the bridge's bounds are clamped there and listed in `clamped`. */
export async function observerQuery<K extends QueryKind>(
  source: ObserverSource, kind: K, params: Record<string, string | number | undefined> = {},
  get: typeof observerGet = observerGet, timeoutMs = 8000,
): Promise<ObserverResult<{ query: QueryEnvelope<QueryResult<K>> }>> {
  const search = new URLSearchParams({ kind });
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return observerRead(source, `/v1/query?${search}`, get, raw => {
    const q = record(raw.query);
    if (q.kind !== kind || !int(q.runStartedAtMs) || !array(q.clamped)?.every(str)) return null;
    const result = RESULT_PARSERS[kind](record(q.result)) as QueryResult<K> | null;
    if (result === null) return null;
    return { query: { kind, runStartedAtMs: q.runStartedAtMs, clamped: q.clamped as string[], params: record(q.params), result } };
  }, timeoutMs);
}
