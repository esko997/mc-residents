// Read API over what the server bridge's queries stored (observer-store.ts), and the aggregations
// the Server record panel and the Map's building layer use (server-data-views.ts).
// Hub only. Times are the server's clock; windows default to recent periods and every list is bounded.
import {
  advancementsOf, blockChanges, blockHours, blockOverflow, containerFlows, ingestGaps, latestStats, statSeries, statSnapshots,
} from "../observer-store.ts";
import type { IngestHealth, ObserverIngest } from "../observer-ingest.ts";
import {
  advancementCatalog, blockCell, blockMap, dataHealth, facilityLedger, residentAdvancements, residentStats, STAT_WINDOWS,
  type FacilityInfo, type StatWindow,
} from "../server-data-views.ts";
import { refuse, type Context, type Routes } from "./context.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;

export interface ServerDataSummary {
  now: number;
  ingest: IngestHealth | null;
  residents: { resident: string; statsSavedAt: number | null; advancementsDone: number; advancementsStarted: number;
    placed24h: number; broken24h: number }[];
  flows24h: number;
  gaps7d: number;
}

/** A bounded integer query parameter; undefined when absent, null when invalid. */
function integer(query: URLSearchParams, name: string, min: number, max: number): number | undefined | null {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
const text = (query: URLSearchParams, name: string) => query.get(name)?.trim() || undefined;

export function serverDataRoutes({ db, now, watcher }: Context, ingest: ObserverIngest | undefined): Routes {
  const recorded = () => db.query<{ resident: string }, []>(`SELECT resident FROM server_stat_latest UNION SELECT resident FROM server_advancements
    UNION SELECT resident FROM server_block_hours`).all().map(row => row.resident).sort();
  const health = () => dataHealth(db, ingest?.health() ?? null, now());
  return {
    async "GET server-data"(): Promise<ServerDataSummary> {
      const at = now();
      const residents = recorded();
      return {
        now: at, ingest: ingest?.health() ?? null,
        residents: residents.map(resident => {
          const stats = db.query<{ savedAt: number | null }, [string]>("SELECT MAX(saved_at) AS savedAt FROM server_stat_snapshots WHERE resident = ?").get(resident);
          const adv = db.query<{ done: number | null; started: number }, [string]>(
            "SELECT SUM(done) AS done, COUNT(*) AS started FROM server_advancements WHERE resident = ?").get(resident);
          const blocks = db.query<{ placed: number | null; broken: number | null }, [string, number]>(
            "SELECT SUM(placed) AS placed, SUM(broken) AS broken FROM server_block_hours WHERE resident = ? AND hour >= ?").get(resident, at - DAY);
          return {
            resident, statsSavedAt: stats?.savedAt ?? null, advancementsDone: adv?.done ?? 0, advancementsStarted: adv?.started ?? 0,
            placed24h: blocks?.placed ?? 0, broken24h: blocks?.broken ?? 0,
          };
        }),
        flows24h: db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM server_container_flows WHERE at >= ?").get(at - DAY)?.n ?? 0,
        gaps7d: db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM server_ingest_gaps WHERE at >= ?").get(at - 7 * DAY)?.n ?? 0,
      };
    },
    /** resident; optional type. With type and key: that statistic's stored history since `since`. */
    async "GET server-data/stats"({ query }) {
      const resident = text(query, "resident"), type = text(query, "type"), key = text(query, "key");
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER);
      if (!resident || since === null || (key && !type)) return refuse(400, "Give resident (and type with key); since is epoch ms.");
      if (type && key) return { resident, type, key, series: statSeries(db, resident, type, key, since ?? now() - 30 * DAY) };
      return { resident, values: latestStats(db, resident, type), snapshots: statSnapshots(db, resident, since ?? now() - 7 * DAY) };
    },
    async "GET server-data/advancements"({ query }) {
      const resident = text(query, "resident");
      if (!resident) return refuse(400, "Give resident.");
      return {
        resident,
        advancements: advancementsOf(db, resident).map(row => ({ ...row, done: row.done === 1, hidden: row.hidden === null ? null : row.hidden === 1 })),
      };
    },
    /** Hour cells per resident/dimension/chunk, summed over bridge runs; `overflow` counts changes without a position. */
    async "GET server-data/blocks"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER), until = integer(query, "until", 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(query, "limit", 1, 20_000);
      if (since === null || until === null || limit === null) return refuse(400, "since/until are epoch ms; limit 1..20000.");
      const from = since ?? now() - DAY, to = until ?? now() + HOUR;
      return {
        since: from, until: to,
        cells: blockHours(db, { since: from, until: to, resident: text(query, "resident"), dimension: text(query, "dimension"), limit: limit ?? 5000 }),
        overflow: blockOverflow(db, from, to),
      };
    },
    /** The recent detail window (may have skipped changes under bursts; see gaps and the hour cells). */
    async "GET server-data/block-changes"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER), limit = integer(query, "limit", 1, 5000);
      if (since === null || limit === null) return refuse(400, "since is epoch ms; limit 1..5000.");
      return { changes: blockChanges(db, { since: since ?? now() - HOUR, resident: text(query, "resident"), limit: limit ?? 1000 }) };
    },
    /** Container flows; `resident` is evidence (nearest configured resident within reach), not proof. */
    async "GET server-data/flows"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER), limit = integer(query, "limit", 1, 2000);
      if (since === null || limit === null) return refuse(400, "since is epoch ms; limit 1..2000.");
      return { flows: containerFlows(db, { since: since ?? now() - 7 * DAY, facility: text(query, "facility"), limit: limit ?? 500 }) };
    },
    async "GET server-data/gaps"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER);
      if (since === null) return refuse(400, "since is epoch ms.");
      return { gaps: ingestGaps(db, since ?? now() - 7 * DAY) };
    },
    /** The Server record panel: per resident, statistics with their change over `window`, and advancement progress; plus data health. */
    async "GET server-data/record"({ query }) {
      const window = (text(query, "window") ?? "24h") as StatWindow;
      if (!STAT_WINDOWS.includes(window)) return refuse(400, `window is one of ${STAT_WINDOWS.join(", ")}.`);
      const at = now(), catalog = advancementCatalog(db);
      return {
        now: at, window,
        residents: recorded().map(resident => ({
          resident, stats: residentStats(db, resident, window, at), advancements: residentAdvancements(db, resident, catalog),
        })),
        catalog: { builtAt: catalog.builtAt, total: catalog.total, tabs: catalog.tabs },
        health: health(),
      };
    },
    /** Per-chunk building and digging in a window, for the Map (one dimension, or all), plus 64-block areas and hourly totals. */
    async "GET server-data/block-map"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER), until = integer(query, "until", 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(query, "limit", 1, 20_000);
      if (since === null || until === null || limit === null) return refuse(400, "since/until are epoch ms; limit 1..20000.");
      const from = since ?? now() - DAY, to = until ?? now() + HOUR;
      return {
        ...blockMap(db, { since: from, until: to, dimension: text(query, "dimension"), resident: text(query, "resident"), limit: limit ?? 5000 }),
        health: health().sets.blocks,
      };
    },
    /** One chunk: its hours, block kinds, and the individual changes the hub still keeps there. */
    async "GET server-data/block-cell"({ query }) {
      const dimension = text(query, "dimension");
      const chunkX = integer(query, "chunkX", -2_000_000, 2_000_000), chunkZ = integer(query, "chunkZ", -2_000_000, 2_000_000);
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER), until = integer(query, "until", 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(query, "limit", 1, 1000);
      if (!dimension || chunkX === undefined || chunkZ === undefined || chunkX === null || chunkZ === null || since === null || until === null || limit === null) {
        return refuse(400, "Give dimension, chunkX and chunkZ; since/until are epoch ms; limit 1..1000.");
      }
      return blockCell(db, { dimension, chunkX, chunkZ, since: since ?? now() - DAY, until: until ?? now() + HOUR, limit: limit ?? 200 });
    },
    /** Per registered facility: what went in and out, and which residents were near (evidence, not proof). */
    async "GET server-data/ledger"({ query }) {
      const since = integer(query, "since", 0, Number.MAX_SAFE_INTEGER);
      if (since === null) return refuse(400, "since is epoch ms.");
      const facilities = new Map<string, FacilityInfo>((watcher.observer.world()?.facilities ?? [])
        .map(facility => [facility.id, { label: facility.label, dimension: facility.dimension, pos: facility.pos }]));
      return { ...facilityLedger(db, since ?? now() - 7 * DAY, facilities), health: health().sets.flows };
    },
  };
}
