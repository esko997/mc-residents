// Periodic ingestion of the server bridge's declarative queries into the hub database (observer-store.ts).
// One pass per interval, never overlapping: feature-detect the vocabulary (an older bridge answers 404 and
// is re-checked every few minutes, so this keeps working across the jar swap), then page the block and
// flow rings from saved cursors, re-read recent block hour cells, and on slower cadences statistics,
// advancements and the advancement catalog. Anything known to be lost is recorded as a gap, never hidden.
import type { Database } from "bun:sqlite";
import { observerGet, type ObserverSource } from "./observer.ts";
import {
  observerQuery, observerVocabulary, type QueryKind, type QueryResult, type QueryVocabulary,
} from "./observer-query.ts";
import {
  applyRetention, ingestState, recordGap, RETENTION, setIngestState, storeAdvancements, storeBlockChanges,
  storeBlockHours, storeCatalog, storeFlows, storeStats, type Retention,
} from "./observer-store.ts";

const HOUR = 3_600_000;

export interface IngestOptions {
  /** Ring and hour-cell cadence. Default 60 s. */
  intervalMs?: number;
  statsEveryMs?: number;
  advancementsEveryMs?: number;
  catalogEveryMs?: number;
  /** How often to look again for queries on a bridge without them. */
  redetectMs?: number;
  retentionEveryMs?: number;
  retention?: Retention;
  /** Pages per kind per pass, so one pass stays bounded after a long outage. */
  maxPages?: number;
  now?: () => number;
  get?: typeof observerGet;
  log?: (line: string) => void;
}

export interface IngestStep { at: number; ok: boolean; detail: string | null; stored: number }
export interface IngestHealth {
  /** unsupported: the bridge has no query vocabulary (older jar); partial: some kinds failed this pass. */
  status: "unconfigured" | "unchecked" | "unsupported" | "ok" | "partial" | "error";
  detail: string | null;
  checkedAt: number;
  okAt: number | null;
  /** The bridge run (its start time) the cursors belong to. */
  run: number | null;
  kinds: string[];
  steps: Record<string, IngestStep>;
}

class RateLimited extends Error {}
class QueryFailed extends Error {}

interface Cursor { run: number; after: number }

export class ObserverIngest {
  private readonly o: Required<Omit<IngestOptions, "retention">> & { retention: Retention };
  private vocabulary: QueryVocabulary | null = null;
  private unsupportedAt: number | null = null;
  private due: Record<string, number> = {};
  private running?: Promise<void>;
  private timers: Timer[] = [];
  private state: IngestHealth;

  constructor(private readonly db: Database, private readonly source: ObserverSource | undefined, options: IngestOptions = {}) {
    this.o = {
      intervalMs: options.intervalMs ?? 60_000, statsEveryMs: options.statsEveryMs ?? 15 * 60_000,
      advancementsEveryMs: options.advancementsEveryMs ?? 30 * 60_000, catalogEveryMs: options.catalogEveryMs ?? 6 * HOUR,
      redetectMs: options.redetectMs ?? 10 * 60_000, retentionEveryMs: options.retentionEveryMs ?? HOUR,
      retention: options.retention ?? RETENTION, maxPages: options.maxPages ?? 10,
      now: options.now ?? Date.now, get: options.get ?? observerGet, log: options.log ?? (line => console.error(line)),
    };
    this.state = {
      status: source ? "unchecked" : "unconfigured", detail: source ? null : "No server observer configured.",
      checkedAt: 0, okAt: null, run: null, kinds: [], steps: {},
    };
    // Statistics and advancements both cost several rate-limit tokens per resident: do not start them together.
    this.due.advancements = this.o.now() + 2 * 60_000;
  }

  start() {
    if (!this.source) return;
    this.timers.push(setTimeout(() => void this.pass(), 5000), setInterval(() => void this.pass(), this.o.intervalMs));
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
  health(): IngestHealth { return this.state; }

  /** One ingestion pass; a pass still running is not doubled. */
  pass(): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.running ??= this.passOnce(this.source).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async passOnce(source: ObserverSource) {
    const now = this.o.now();
    if (!this.vocabulary && (this.unsupportedAt === null || now - this.unsupportedAt >= this.o.redetectMs)) {
      const found = await observerVocabulary(source, this.o.get);
      if (!found.ok) {
        if (found.unsupported) this.unsupportedAt = now;
        this.state = {
          ...this.state, checkedAt: now, status: found.unsupported ? "unsupported" : "error",
          detail: found.unsupported ? "The server bridge has no query vocabulary (an older jar); checking again later." : found.detail,
        };
        return;
      }
      this.vocabulary = found.vocabulary;
      this.unsupportedAt = null;
    }
    const vocabulary = this.vocabulary;
    if (!vocabulary) return;
    const steps: [string, QueryKind, () => Promise<number>][] = [
      ["blocks", "blocks", () => this.ring("blocks", source)],
      ["flows", "flows", () => this.ring("flows", source)],
      ["block_hours", "block_hours", () => this.hours(source)],
      ["catalog", "advancement_catalog", () => this.catalog(source)],
      ["stats", "stats", () => this.stats(source, vocabulary.residents)],
      ["advancements", "advancements", () => this.advancements(source, vocabulary.residents)],
    ];
    let failed = 0, limited = false;
    for (const [name, kind, run] of steps) {
      if (!vocabulary.kinds.includes(kind) || limited) continue;
      const cadence = name === "stats" ? this.o.statsEveryMs : name === "advancements" ? this.o.advancementsEveryMs
        : name === "catalog" ? this.o.catalogEveryMs : 0;
      if (cadence && now < (this.due[name] ?? 0)) continue;
      try {
        const stored = await run();
        this.state.steps[name] = { at: this.o.now(), ok: true, detail: null, stored };
        if (cadence) this.due[name] = now + cadence;
      } catch (error) {
        failed++;
        limited = error instanceof RateLimited;
        const detail = error instanceof Error ? error.message : String(error);
        this.state.steps[name] = { at: this.o.now(), ok: false, detail, stored: 0 };
        if (!(error instanceof RateLimited) && !(error instanceof QueryFailed)) this.o.log(`server bridge ingest ${name} failed: ${detail}`);
        if (error instanceof QueryFailed && /incompatible|404/.test(detail)) this.vocabulary = null; // bridge replaced: detect again
      }
    }
    if (now >= (this.due.retention ?? 0)) {
      try { applyRetention(this.db, now, this.o.retention); this.due.retention = now + this.o.retentionEveryMs; }
      catch (error) { this.o.log(`server bridge retention skipped: ${error instanceof Error ? error.message : error}`); }
    }
    this.state = {
      ...this.state, checkedAt: now, kinds: vocabulary.kinds,
      status: failed ? "partial" : "ok", detail: failed ? `${failed} kind(s) failed this pass; see steps.` : null,
      okAt: failed ? this.state.okAt : now,
    };
  }

  private async query<K extends QueryKind>(source: ObserverSource, kind: K, params: Record<string, string | number | undefined>) {
    const reply = await observerQuery(source, kind, params, this.o.get);
    if (!reply.ok) {
      if (reply.httpStatus === 429) throw new RateLimited(`rate limited by the bridge: ${reply.detail}`);
      throw new QueryFailed(`${reply.status}${reply.httpStatus ? ` ${reply.httpStatus}` : ""}: ${reply.detail}`);
    }
    this.state.run = reply.data.query.runStartedAtMs;
    return { query: reply.data.query, servedAtMs: reply.data.servedAtMs, receivedAt: reply.receivedAt };
  }

  private cursor(key: string): Cursor | null {
    try {
      const raw = JSON.parse(ingestState(this.db, key) ?? "null") as Partial<Cursor> | null;
      return raw && Number.isSafeInteger(raw.run) && Number.isSafeInteger(raw.after) ? { run: raw.run!, after: raw.after! } : null;
    } catch { return null; }
  }

  /** Pages a sequence ring (block detail or flows) from the saved cursor of the same bridge run. */
  private async ring(kind: "blocks" | "flows", source: ObserverSource): Promise<number> {
    const key = `cursor.${kind}`, limit = kind === "blocks" ? 1000 : 500;
    let cursor = this.cursor(key), stored = 0;
    for (let page = 0; page < this.o.maxPages; page++) {
      const { query, receivedAt } = await this.query(source, kind, { after: cursor?.after ?? 0, limit });
      const run = query.runStartedAtMs, result = query.result as QueryResult<"blocks"> | QueryResult<"flows">;
      if (cursor && cursor.run !== run) {
        // Sequence numbers restarted: whatever the old run recorded after our last read is gone.
        recordGap(this.db, kind, cursor.run, `bridge restarted; ${kind} after seq ${cursor.after} of run ${cursor.run} were not read`, receivedAt);
        cursor = { run, after: 0 };
        setIngestState(this.db, key, JSON.stringify(cursor));
        continue; // re-read the new run from its start
      }
      if (result.gap) {
        recordGap(this.db, kind, run, `ring overwritten before it was read: seq ${(cursor?.after ?? 0) + 1}..${result.oldestSeq - 1} lost`, receivedAt);
      }
      const entries = "changes" in result ? result.changes : result.flows;
      if ("changes" in result) storeBlockChanges(this.db, run, result.changes);
      else storeFlows(this.db, run, result.flows);
      stored += entries.length;
      cursor = { run, after: result.nextAfter };
      setIngestState(this.db, key, JSON.stringify(cursor));
      if (entries.length < limit) break;
    }
    return stored;
  }

  /** Re-reads hour cells from the hour before the last complete read (counts of open hours keep growing). */
  private async hours(source: ObserverSource): Promise<number> {
    const key = "cursor.block_hours", limit = 1000;
    const saved = this.cursor(key);
    let since = saved?.after ?? 0, run = saved?.run ?? null, offset = 0, stored = 0, servedAt = 0;
    for (let page = 0; page < this.o.maxPages; page++) {
      const { query, servedAtMs, receivedAt } = await this.query(source, "block_hours", { sinceHour: since, offset, limit });
      if (run !== null && run !== query.runStartedAtMs) {
        recordGap(this.db, "block_hours", run, `bridge restarted; counts of run ${run} after the last read are lost`, receivedAt);
        run = query.runStartedAtMs;
        since = 0;
        offset = 0;
        continue;
      }
      run = query.runStartedAtMs;
      const result = query.result;
      if (page === 0 && since > 0 && result.evictedThroughHourMs >= since) {
        recordGap(this.db, "block_hours", run, `cell table full: cells up to hour ${result.evictedThroughHourMs} may have been evicted before they were read`, receivedAt);
      }
      if (page === 0 && since > 0 && since < result.retainedFromHourMs) {
        recordGap(this.db, "block_hours", run, `hours before ${result.retainedFromHourMs} aged out of the bridge before they were read`, receivedAt);
      }
      storeBlockHours(this.db, run, result);
      stored += result.cells.length;
      servedAt = servedAtMs;
      if (!result.more) {
        setIngestState(this.db, key, JSON.stringify({ run, after: Math.floor(servedAt / HOUR) * HOUR - HOUR }));
        return stored;
      }
      offset += result.cells.length;
    }
    // Not finished within the page budget: keep the old start so the next pass completes it.
    if (run !== null) setIngestState(this.db, key, JSON.stringify({ run, after: since }));
    return stored;
  }

  private async stats(source: ObserverSource, residents: string[]): Promise<number> {
    let stored = 0;
    for (const resident of residents) {
      const { query, receivedAt } = await this.query(source, "stats", { resident, limit: 2000 });
      if (storeStats(this.db, query.result, receivedAt)) stored++;
    }
    return stored;
  }

  private async advancements(source: ObserverSource, residents: string[]): Promise<number> {
    let stored = 0;
    for (const resident of residents) {
      for (let offset = 0, page = 0; page < this.o.maxPages; page++) {
        const { query, receivedAt } = await this.query(source, "advancements", { resident, offset, limit: 2000 });
        storeAdvancements(this.db, query.result, receivedAt);
        stored += query.result.advancements.length;
        if (!query.result.more) break;
        offset += query.result.advancements.length;
      }
    }
    return stored;
  }

  private async catalog(source: ObserverSource): Promise<number> {
    let stored = 0;
    for (let offset = 0, page = 0; page < this.o.maxPages; page++) {
      const { query } = await this.query(source, "advancement_catalog", { offset, limit: 2000 });
      storeCatalog(this.db, query.result.entries, query.result.builtAtMs);
      stored += query.result.entries.length;
      if (!query.result.more) break;
      offset += query.result.entries.length;
    }
    return stored;
  }
}

/** `COMMONS_OBSERVER_INGEST=off` disables ingestion; `COMMONS_OBSERVER_INGEST_SECONDS` sets the ring cadence (15..3600). */
export function ingestOptionsFromEnv(env: Record<string, string | undefined>): IngestOptions | null {
  if (/^(0|off|false|no)$/i.test(env.COMMONS_OBSERVER_INGEST ?? "")) return null;
  const seconds = Number(env.COMMONS_OBSERVER_INGEST_SECONDS ?? 60);
  return { intervalMs: Math.min(3600, Math.max(15, Number.isFinite(seconds) ? seconds : 60)) * 1000 };
}
