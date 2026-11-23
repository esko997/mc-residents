// Position samples (one row per online resident per sampling tick) and the map trails built
// from them. Hub and stations share this table shape; neither shares the rows.
import type { Database } from "bun:sqlite";

export interface PositionSample {
  x: number; y: number; z: number; dimension: string; health?: number; food?: number;
  /** Sky light (0-15) at the body's feet; absent when the client did not report it. */
  sky?: number;
}

export function recordPosition(db: Database, resident: string, at: number, sample: PositionSample) {
  db.query("INSERT OR REPLACE INTO positions (resident, at, x, y, z, dimension, health, food, sky) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(resident, at, sample.x, sample.y, sample.z, sample.dimension, sample.health ?? null,
      sample.food === undefined ? null : Math.round(sample.food), sample.sky === undefined ? null : Math.round(sample.sky));
}

/**
 * Columns added after the table first shipped. Existing rows are kept; their new columns are
 * NULL (unknown), never invented. Safe to run at every start, on hub and station databases.
 */
export function migratePositions(db: Database) {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('positions')").all().map(c => c.name));
  if (!columns.has("sky")) db.exec("ALTER TABLE positions ADD COLUMN sky INTEGER");
}

/** `minecraft:the_nether` and `the_nether` are one key; a missing dimension is the overworld (the old default). */
export function dimensionKey(id: unknown): string {
  return typeof id === "string" && id.trim() ? id.trim().replace(/^minecraft:/, "") : "overworld";
}

/** [unix ms, x, y, z, sky light or null], whole blocks. */
export type TrailPoint = [number, number, number, number, number | null];
/** Consecutive samples in one dimension with no offline gap or jump between them: draw them joined. */
export interface TrailLeg { dimension: string; points: TrailPoint[] }
export interface CrossingEnd { dimension: string; x: number; y: number; z: number }
/**
 * Consecutive samples in different dimensions. "portal" is inferred, not observed: a death
 * just before turns it into "respawn" (see `classifyCrossings`).
 */
export interface DimensionCrossing { at: number; from: CrossingEnd; to: CrossingEnd; kind: "portal" | "respawn" }
export interface MapTrail { legs: TrailLeg[]; crossings: DimensionCrossing[]; samples: number }

/** Samples further apart than this were not taken continuously (client down, loading, Commons restart). */
export const SAMPLE_GAP_MS = 60_000;
/** A dimension change across at most this gap counts as a crossing; a loading screen can cost a sample. */
export const CROSSING_GAP_MS = 120_000;
/** Points per resident per reply. A night at 10 s sampling is ~4 000 samples; a week ~60 000. */
export const TRAIL_BUDGET = 3000;
/** Vertical detail matters for the elevation profile: one block of height counts as two across. */
const Y_WEIGHT = 2;

const end = (dimension: string, row: { x: number; y: number; z: number }): CrossingEnd =>
  ({ dimension, x: Math.round(row.x), y: Math.round(row.y), z: Math.round(row.z) });

/**
 * A resident's trail since a time, in every dimension, split into legs and decimated to `budget`
 * points (each leg keeps its two ends). Crossings come from the raw samples, so decimation cannot
 * lose them. Standing still adds no point: the one point keeps the latest time it was seen there.
 */
export function mapTrail(db: Database, resident: string, since: number, budget = TRAIL_BUDGET): MapTrail {
  const rows = db.query<{ at: number; x: number; y: number; z: number; dimension: string; sky: number | null }, [string, number]>(
    "SELECT at, x, y, z, dimension, sky FROM positions WHERE resident = ? AND at >= ? ORDER BY at").all(resident, since);
  const legs: TrailLeg[] = [], crossings: DimensionCrossing[] = [];
  let leg: TrailLeg | undefined, previous: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (![row.x, row.y, row.z].every(Number.isFinite)) continue;
    const dimension = dimensionKey(row.dimension);
    const point: TrailPoint = [row.at, Math.round(row.x), Math.round(row.y), Math.round(row.z), row.sky ?? null];
    let split = !leg || !previous;
    if (leg && previous) {
      const gap = row.at - previous.at, distance = Math.hypot(row.x - previous.x, row.z - previous.z);
      if (dimension !== leg.dimension) {
        split = true;
        if (gap <= CROSSING_GAP_MS) crossings.push({ at: row.at, from: end(leg.dimension, previous), to: end(dimension, row), kind: "portal" });
      } else if (gap > SAMPLE_GAP_MS || distance > 256 || (distance > 64 && distance / Math.max(1, gap / 1000) > 12)) split = true;
    }
    if (split || !leg) { leg = { dimension, points: [point] }; legs.push(leg); }
    else {
      const last = leg.points[leg.points.length - 1];
      if (last[1] === point[1] && last[2] === point[2] && last[3] === point[3]) { last[0] = point[0]; last[4] = point[4]; }
      else leg.points.push(point);
    }
    previous = row;
  }
  return { legs: decimateLegs(legs, budget), crossings, samples: rows.length };
}

/** Distance from p to the segment a-b, with height weighted (see Y_WEIGHT). */
function deviation(p: TrailPoint, a: TrailPoint, b: TrailPoint): number {
  const ax = a[1], ay = a[2] * Y_WEIGHT, az = a[3];
  const dx = b[1] - ax, dy = b[2] * Y_WEIGHT - ay, dz = b[3] - az;
  const px = p[1] - ax, py = p[2] * Y_WEIGHT - ay, pz = p[3] - az;
  const length = dx * dx + dy * dy + dz * dz;
  const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / length)) : 0;
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
}

/**
 * Ramer-Douglas-Peucker as a ranking: each point's value is the tolerance below which RDP would
 * keep it (clamped by its parent's, so keeping every value above a threshold is exactly RDP at
 * that threshold). Ends are Infinity. Iterative: legs can hold tens of thousands of points.
 * Deviations count in half blocks (points are whole blocks; less is rounding noise). Equal ones
 * split nearest the middle and a span lying on its chord stops (its points stay 0), so straight,
 * staircase and zigzag legs cost about O(n log n), not O(n²).
 */
export function significance(points: TrailPoint[]): Float64Array {
  const n = points.length, value = new Float64Array(n);
  if (!n) return value;
  value[0] = value[n - 1] = Infinity;
  const stack: [number, number, number][] = [[0, n - 1, Infinity]];
  while (stack.length) {
    const [a, b, cap] = stack.pop()!;
    if (b - a < 2) continue;
    const middle = (a + b) / 2;
    let best = -1, index = a + 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.round(deviation(points[i], points[a], points[b]) * 2) / 2;
      if (d > best || (d === best && Math.abs(i - middle) < Math.abs(index - middle))) { best = d; index = i; }
    }
    if (best <= 0) continue;
    const kept = Math.min(best, cap);
    value[index] = kept;
    stack.push([a, index, kept], [index, b, kept]);
  }
  return value;
}

/**
 * At most `budget` points over all legs, chosen by shape (turns, climbs and dives survive; long
 * straight runs collapse), except that every leg keeps both ends even when that exceeds it.
 */
export function decimateLegs(legs: TrailLeg[], budget: number): TrailLeg[] {
  const total = legs.reduce((sum, leg) => sum + leg.points.length, 0);
  if (total <= budget) return legs;
  const values = legs.map(leg => significance(leg.points));
  const ends = legs.reduce((sum, leg) => sum + Math.min(2, leg.points.length), 0);
  const ranked = values.flatMap(list => [...list].filter(Number.isFinite)).sort((a, b) => b - a);
  const room = Math.max(0, budget - ends);
  const threshold = room ? ranked[room - 1] : Infinity;
  // Points equal to the threshold are kept in time order until the budget is spent.
  let ties = room - ranked.filter(value => value > threshold).length;
  return legs.map((leg, l) => ({
    dimension: leg.dimension,
    points: leg.points.filter((_, i) => {
      const value = values[l][i];
      if (value === Infinity || value > threshold) return true;
      if (value === threshold && ties > 0) { ties--; return true; }
      return false;
    }),
  }));
}

/** A dimension change within five minutes after the resident died there is a respawn, not a portal. */
export function classifyCrossings(crossings: DimensionCrossing[], deaths: { at: number; dimension: string }[]): DimensionCrossing[] {
  return crossings.map(crossing => deaths.some(death => death.dimension === crossing.from.dimension &&
    death.at <= crossing.at + 60_000 && crossing.at - death.at <= 300_000) ? { ...crossing, kind: "respawn" } : crossing);
}
