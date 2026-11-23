// Durable copies of what the server bridge's queries report (tables `server_*` in schema.sql).
// Only the hub writes them (observer-ingest.ts); routes/server-data.ts reads them. Every time is on the
// SERVER's clock (epoch ms), as the bridge reported it; `received_at` columns are this hub's clock.
// A bridge "run" is its start time: ring sequence numbers and in-memory counts restart with it.
import type { Database } from "bun:sqlite";
import type {
  AdvancementsResult, BlockChange, BlockHoursResult, CatalogEntry, Flow, StatsResult,
} from "./observer-query.ts";

/** Defaults; override per ingest. Detail is a recent window; aggregates are the long record. */
export interface Retention {
  blockChangesDays: number;
  blockChangesMaxRows: number;
  blockHoursDays: number;
  flowsDays: number;
  /** Stat changes older than this are folded into one baseline value per statistic. */
  statValuesDays: number;
  gapsDays: number;
}
export const RETENTION: Retention = {
  blockChangesDays: 14, blockChangesMaxRows: 200_000, blockHoursDays: 365, flowsDays: 180, statValuesDays: 180, gapsDays: 180,
};
const DAY = 86_400_000;

export function ingestState(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM server_ingest_state WHERE key = ?").get(key)?.value ?? null;
}
export function setIngestState(db: Database, key: string, value: string) {
  db.query("INSERT OR REPLACE INTO server_ingest_state (key, value) VALUES (?, ?)").run(key, value);
}

/** Something the hub knows it did not receive (ring overwritten, cells evicted, bridge restarted). */
export function recordGap(db: Database, kind: string, run: number, detail: string, at: number) {
  db.query("INSERT INTO server_ingest_gaps (kind, run, detail, at) VALUES (?, ?, ?, ?)").run(kind, run, detail, at);
}

export function storeBlockChanges(db: Database, run: number, changes: BlockChange[]) {
  const insert = db.query(`INSERT OR IGNORE INTO server_block_changes (run, seq, resident, action, dimension, x, y, z, block, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const c of changes) insert.run(run, c.seq, c.resident, c.action, c.dimension, c.x, c.y, c.z, c.block, c.atMs);
  })();
}

export function storeFlows(db: Database, run: number, flows: Flow[]) {
  const insert = db.query(`INSERT OR IGNORE INTO server_container_flows (run, seq, facility, at, since_at, continuous, deltas_json,
    deltas_truncated, uncertain_json, attribution, resident, nearby_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const f of flows) {
      insert.run(run, f.seq, f.facility, f.atMs, f.sinceMs, f.continuous ? 1 : 0, JSON.stringify(f.deltas), f.deltasTruncated ? 1 : 0,
        JSON.stringify(f.uncertain), f.attribution, f.resident, JSON.stringify(f.nearby));
    }
  })();
}

/** Counts are the bridge's running totals for that run and hour: replacing is idempotent. */
export function storeBlockHours(db: Database, run: number, page: BlockHoursResult) {
  const cell = db.query(`INSERT OR REPLACE INTO server_block_hours (run, resident, dimension, chunk_x, chunk_z, hour, placed, broken,
    kinds_json, other_placed, other_broken, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const overflow = db.query("INSERT OR REPLACE INTO server_block_overflow (run, resident, hour, placed, broken) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const c of page.cells) {
      cell.run(run, c.resident, c.dimension, c.chunkX, c.chunkZ, c.hourMs, c.placed, c.broken, JSON.stringify(c.kinds),
        c.otherPlaced, c.otherBroken, c.firstAtMs, c.lastAtMs);
    }
    for (const o of page.overflow) overflow.run(run, o.resident, o.hourMs, o.placed, o.broken);
  })();
}

/**
 * One snapshot of a resident's statistics, stored as changes: a value is written only when it
 * differs from the last one stored for that statistic. Returns null when this save was already stored
 * (or the file had no values to offer).
 */
export function storeStats(db: Database, stats: StatsResult, receivedAt: number): { changed: number } | null {
  if (stats.savedAtMs === null || (stats.status !== "observed" && stats.status !== "stale")) return null;
  const savedAt = stats.savedAtMs;
  const known = db.query<{ n: number }, [string, number]>(
    "SELECT COUNT(*) AS n FROM server_stat_snapshots WHERE resident = ? AND saved_at = ?").get(stats.resident, savedAt);
  if (known && known.n > 0) return null;
  const latest = new Map(db.query<{ type: string; key: string; value: number }, [string]>(
    "SELECT type, key, value FROM server_stat_latest WHERE resident = ?").all(stats.resident).map(row => [`${row.type}\n${row.key}`, row.value]));
  const insert = db.query("INSERT OR IGNORE INTO server_stat_values (resident, type, key, saved_at, value) VALUES (?, ?, ?, ?, ?)");
  const upsert = db.query("INSERT OR REPLACE INTO server_stat_latest (resident, type, key, value, saved_at) VALUES (?, ?, ?, ?, ?)");
  let changed = 0, entries = 0;
  const complete = stats.types.every(type => !type.truncated);
  db.transaction(() => {
    for (const type of stats.types) {
      for (const [key, value] of Object.entries(type.values)) {
        entries++;
        if (latest.get(`${type.type}\n${key}`) === value) continue;
        insert.run(stats.resident, type.type, key, savedAt, value);
        upsert.run(stats.resident, type.type, key, value, savedAt);
        changed++;
      }
    }
    db.query(`INSERT INTO server_stat_snapshots (resident, saved_at, received_at, status, entries, changed, complete)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(stats.resident, savedAt, receivedAt, stats.status, entries, changed, complete ? 1 : 0);
  })();
  return { changed };
}

/** Current progress per advancement, plus each achieved criterion's time (append-only facts). */
export function storeAdvancements(db: Database, page: AdvancementsResult, receivedAt: number) {
  if (page.savedAtMs === null) return;
  const savedAt = page.savedAtMs;
  const upsert = db.query(`INSERT INTO server_advancements (resident, id, done, criteria_done, criteria_total, first_seen_at, done_at, saved_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(resident, id) DO UPDATE SET done = ?3, criteria_done = ?4, criteria_total = COALESCE(?5, criteria_total),
      done_at = COALESCE(done_at, ?7), saved_at = ?8`);
  const criterion = db.query("INSERT OR IGNORE INTO server_advancement_criteria (resident, id, criterion, achieved_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const a of page.advancements) {
      const times = a.criteria.flatMap(c => c.atMs === null ? [] : [c.atMs]);
      // Done at the latest criterion time when the file has it; otherwise the save that first showed it done.
      const doneAt = a.done ? (times.length ? Math.max(...times) : savedAt) : null;
      upsert.run(page.resident, a.id, a.done ? 1 : 0, a.criteriaDone, a.criteriaTotal, times.length ? Math.min(...times) : receivedAt, doneAt, savedAt);
      for (const c of a.criteria) criterion.run(page.resident, a.id, c.name, c.atMs);
    }
  })();
}

export function storeCatalog(db: Database, entries: CatalogEntry[], builtAt: number) {
  const upsert = db.query(`INSERT OR REPLACE INTO server_advancement_catalog (id, title, frame, hidden, criteria, requirements, parent, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const e of entries) upsert.run(e.id, e.title, e.frame, e.hidden ? 1 : 0, e.criteria, e.requirements, e.parent, builtAt);
  })();
}

/** Deletes what is past retention. Stat history keeps, per statistic, the newest change before the cutoff as its baseline. */
export function applyRetention(db: Database, now: number, r: Retention = RETENTION) {
  db.transaction(() => {
    db.query("DELETE FROM server_block_changes WHERE at < ?").run(now - r.blockChangesDays * DAY);
    db.query(`DELETE FROM server_block_changes WHERE (run, seq) IN (SELECT run, seq FROM server_block_changes ORDER BY at DESC LIMIT -1 OFFSET ?)`)
      .run(r.blockChangesMaxRows);
    db.query("DELETE FROM server_block_hours WHERE hour < ?").run(now - r.blockHoursDays * DAY);
    db.query("DELETE FROM server_block_overflow WHERE hour < ?").run(now - r.blockHoursDays * DAY);
    db.query("DELETE FROM server_container_flows WHERE at < ?").run(now - r.flowsDays * DAY);
    db.query("DELETE FROM server_ingest_gaps WHERE at < ?").run(now - r.gapsDays * DAY);
    const cutoff = now - r.statValuesDays * DAY;
    db.query(`DELETE FROM server_stat_values AS v WHERE saved_at < ?1 AND EXISTS (
      SELECT 1 FROM server_stat_values AS w WHERE w.resident = v.resident AND w.type = v.type AND w.key = v.key
        AND w.saved_at > v.saved_at AND w.saved_at < ?1)`).run(cutoff);
    db.query("DELETE FROM server_stat_snapshots WHERE saved_at < ?").run(cutoff);
  })();
}

// === reads for the dashboard API ===

export interface StatValue { type: string; key: string; value: number; savedAt: number }
export function latestStats(db: Database, resident: string, type?: string): StatValue[] {
  return db.query<StatValue, [string, string | null]>(`SELECT type, key, value, saved_at AS savedAt FROM server_stat_latest
    WHERE resident = ?1 AND (?2 IS NULL OR type = ?2) ORDER BY type, value DESC, key`).all(resident, type ?? null);
}
/** The statistic's value at each stored save since `since`, plus the value in force at `since` (the baseline). */
export function statSeries(db: Database, resident: string, type: string, key: string, since: number): { savedAt: number; value: number }[] {
  return db.query<{ savedAt: number; value: number }, [string, string, string, number]>(`
    SELECT saved_at AS savedAt, value FROM server_stat_values WHERE resident = ?1 AND type = ?2 AND key = ?3 AND saved_at >= ?4
    UNION ALL SELECT * FROM (SELECT saved_at, value FROM server_stat_values WHERE resident = ?1 AND type = ?2 AND key = ?3 AND saved_at < ?4
      ORDER BY saved_at DESC LIMIT 1)
    ORDER BY savedAt`).all(resident, type, key, since);
}
export function statSnapshots(db: Database, resident: string, since: number) {
  return db.query<{ savedAt: number; receivedAt: number; status: string; entries: number; changed: number; complete: number }, [string, number]>(
    `SELECT saved_at AS savedAt, received_at AS receivedAt, status, entries, changed, complete FROM server_stat_snapshots
     WHERE resident = ? AND saved_at >= ? ORDER BY saved_at`).all(resident, since);
}

export function advancementsOf(db: Database, resident: string) {
  return db.query<{
    id: string; done: number; criteriaDone: number; criteriaTotal: number | null; firstSeenAt: number; doneAt: number | null;
    savedAt: number; title: string | null; frame: string | null; hidden: number | null;
  }, [string]>(`SELECT a.id, a.done, a.criteria_done AS criteriaDone, COALESCE(a.criteria_total, c.criteria) AS criteriaTotal,
      a.first_seen_at AS firstSeenAt, a.done_at AS doneAt, a.saved_at AS savedAt, c.title, c.frame, c.hidden
    FROM server_advancements a LEFT JOIN server_advancement_catalog c ON c.id = a.id
    WHERE a.resident = ? ORDER BY a.done_at IS NULL, a.done_at DESC, a.id`).all(resident);
}

/** Hour cells summed over bridge runs (a restart splits one hour into two runs' counts). */
export function blockHours(db: Database, q: { since: number; until: number; resident?: string; dimension?: string; limit: number }) {
  return db.query<{
    resident: string; dimension: string; chunkX: number; chunkZ: number; hour: number; placed: number; broken: number;
  }, [number, number, string | null, string | null, number]>(`SELECT resident, dimension, chunk_x AS chunkX, chunk_z AS chunkZ, hour,
      SUM(placed) AS placed, SUM(broken) AS broken FROM server_block_hours
    WHERE hour >= ?1 AND hour < ?2 AND (?3 IS NULL OR resident = ?3) AND (?4 IS NULL OR dimension = ?4)
    GROUP BY resident, dimension, chunk_x, chunk_z, hour ORDER BY hour, resident, dimension, chunk_x, chunk_z LIMIT ?5`)
    .all(q.since, q.until, q.resident ?? null, q.dimension ?? null, q.limit);
}
export function blockOverflow(db: Database, since: number, until: number) {
  return db.query<{ resident: string; hour: number; placed: number; broken: number }, [number, number]>(`SELECT resident, hour,
      SUM(placed) AS placed, SUM(broken) AS broken FROM server_block_overflow WHERE hour >= ? AND hour < ? GROUP BY resident, hour ORDER BY hour`)
    .all(since, until);
}
export function blockChanges(db: Database, q: { since: number; resident?: string; limit: number }) {
  return db.query<{ resident: string; action: string; dimension: string; x: number; y: number; z: number; block: string; at: number }, [number, string | null, number]>(
    `SELECT resident, action, dimension, x, y, z, block, at FROM server_block_changes
     WHERE at >= ?1 AND (?2 IS NULL OR resident = ?2) ORDER BY at DESC, run DESC, seq DESC LIMIT ?3`).all(q.since, q.resident ?? null, q.limit);
}
export function containerFlows(db: Database, q: { since: number; facility?: string; limit: number }) {
  return db.query<{
    facility: string; at: number; sinceAt: number; continuous: number; deltas: string; deltasTruncated: number; uncertain: string;
    attribution: string; resident: string | null; nearby: string;
  }, [number, string | null, number]>(`SELECT facility, at, since_at AS sinceAt, continuous, deltas_json AS deltas, deltas_truncated AS deltasTruncated,
      uncertain_json AS uncertain, attribution, resident, nearby_json AS nearby FROM server_container_flows
    WHERE at >= ?1 AND (?2 IS NULL OR facility = ?2) ORDER BY at DESC, run DESC, seq DESC LIMIT ?3`).all(q.since, q.facility ?? null, q.limit)
    .map(row => ({
      ...row, continuous: row.continuous === 1, deltasTruncated: row.deltasTruncated === 1,
      deltas: JSON.parse(row.deltas) as Flow["deltas"], uncertain: JSON.parse(row.uncertain) as string[], nearby: JSON.parse(row.nearby) as Flow["nearby"],
    }));
}
export function ingestGaps(db: Database, since: number) {
  return db.query<{ kind: string; run: number; detail: string; at: number }, [number]>(
    "SELECT kind, run, detail, at FROM server_ingest_gaps WHERE at >= ? ORDER BY at DESC LIMIT 500").all(since);
}
