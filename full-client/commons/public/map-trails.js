// Pure map helpers (no DOM): trail geometry, height colours, dimensions, cover and the
// elevation profile series. Points are [unix ms, x, y, z, sky light | null] in one leg: the
// server has already split legs at offline gaps, jumps and dimension changes.

export const SEA_LEVEL = 63;
const NAMES = { overworld: "Overworld", the_nether: "Nether", the_end: "End" };
export const dimensionName = key => NAMES[key] ?? key;

/** The heights a dimension's blocks can occupy (Nether/End: 0-255; the Nether's roof is at 127). */
export function heightDomain(dimension) {
  return dimension === "the_nether" || dimension === "the_end" ? [0, 256] : [-64, 320];
}

// One ramp for every dimension, by absolute Y, so a colour always means the same height.
export const HEIGHT_STOPS = [
  [-64, [160, 112, 224]], [0, [91, 140, 240]], [40, [57, 192, 200]], [SEA_LEVEL, [108, 197, 106]],
  [100, [216, 207, 78]], [160, [236, 143, 62]], [256, [246, 241, 231]],
];
export function heightColour(y) {
  if (!Number.isFinite(y)) return "rgb(163,171,155)";
  const stops = HEIGHT_STOPS;
  if (y <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    const [top, high] = stops[i], [bottom, low] = stops[i - 1];
    if (y > top) continue;
    const t = (y - bottom) / (top - bottom);
    return `rgb(${low.map((value, c) => Math.round(value + (high[c] - value) * t))})`;
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}

/**
 * Where the body is, honestly: sky light at the feet (from the client) is the only evidence.
 * 15 is open sky; 0 means no sky light reaches, which below sea level we call underground and
 * above it "enclosed" (a sealed room or a tunnel inside a hill look the same). The Nether and End
 * have no sky light at all. Without a reading, only "below sea level" can be said.
 */
export function coverOf(dimension, y, sky) {
  if (dimension !== "overworld") return { kind: "no-sky", label: `${dimensionName(dimension)}: no sky here`, underground: false };
  if (!Number.isFinite(sky)) {
    return Number.isFinite(y) && y < SEA_LEVEL
      ? { kind: "below-sea", label: "below sea level (no sky reading)", underground: true }
      : { kind: "unknown", label: "no sky reading", underground: false };
  }
  if (sky >= 15) return { kind: "open", label: "under open sky", underground: false };
  if (sky > 0) return { kind: "partly", label: `partly covered (sky light ${sky})`, underground: false };
  return y < SEA_LEVEL
    ? { kind: "underground", label: "underground (no sky light, below sea level)", underground: true }
    : { kind: "enclosed", label: "enclosed (no sky light: indoors or inside a hill)", underground: false };
}

/** The same place in the linked dimension: Nether blocks are eight Overworld blocks. */
export function equivalent(dimension, x, z) {
  if (dimension === "the_nether") return { dimension: "overworld", x: Math.round(x * 8), z: Math.round(z * 8) };
  if (dimension === "overworld") return { dimension: "the_nether", x: Math.round(x / 8), z: Math.round(z / 8) };
  return null;
}

/** Dimensions with something to draw, Overworld first (always: it is the home map), then Nether, End, others. */
export function mapDimensions(data) {
  const found = new Set(["overworld"]);
  for (const resident of data?.residents ?? []) {
    for (const leg of resident.legs ?? []) if (leg.points.length) found.add(leg.dimension);
    if (resident.position && resident.dimension) found.add(resident.dimension);
  }
  for (const list of [data?.places, data?.deaths, data?.alarms]) for (const item of list ?? []) found.add(item.dimension);
  const order = ["overworld", "the_nether", "the_end"];
  return [...found].sort((a, b) => ((order.indexOf(a) + 1) || 9) - ((order.indexOf(b) + 1) || 9) || a.localeCompare(b));
}

/** The parts of a leg inside [lo, hi]: points outside split it, so nothing is joined across them. */
export function splitByHeight(points, lo = -Infinity, hi = Infinity) {
  const runs = [];
  let run = [];
  for (const point of points) {
    if (point[2] === null || (point[2] >= lo && point[2] <= hi)) run.push(point);
    else { if (run.length) runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Display geometry only: four-block grid edges merge nearby routes within each resident's runs,
 * in eight-block height bands so a tunnel under a road stays its own line. Weight is sampling
 * overlap, never an exact traversal count; y is the mean height of the merged pieces.
 */
export function mergeMapTrail(runs) {
  const grid = 4, band = 8, edges = new Map();
  for (const points of runs) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (![a[1], a[3], b[1], b[3]].every(Number.isFinite)) continue;
      let x = Math.round(a[1] / grid), z = Math.round(a[3] / grid), y = a[2] ?? NaN;
      let endX = Math.round(b[1] / grid), endZ = Math.round(b[3] / grid), endY = b[2] ?? NaN;
      // Canonical direction makes the same line rasterize identically both ways.
      if (x > endX || (x === endX && z > endZ)) {
        [x, endX] = [endX, x]; [z, endZ] = [endZ, z]; [y, endY] = [endY, y];
      }
      const dx = Math.abs(endX - x), dz = Math.abs(endZ - z), steps = Math.max(dx, dz);
      const sx = x < endX ? 1 : -1, sz = z < endZ ? 1 : -1;
      let error = dx - dz, step = 0;
      while (x !== endX || z !== endZ) {
        const fromX = x, fromZ = z, twice = error * 2;
        if (twice > -dz) { error -= dz; x += sx; }
        if (twice < dx) { error += dx; z += sz; }
        step++;
        const height = Number.isFinite(y) && Number.isFinite(endY) ? y + (endY - y) * (step - .5) / steps : NaN;
        const key = `${fromX},${fromZ}:${x},${z}:${Number.isFinite(height) ? Math.floor(height / band) : "?"}`;
        const edge = edges.get(key);
        if (edge) {
          edge.weight = Math.min(16, edge.weight + 1);
          if (Number.isFinite(height)) { edge.sum += height; edge.count++; }
        } else {
          edges.set(key, { x1: fromX * grid, z1: fromZ * grid, x2: x * grid, z2: z * grid, weight: 1,
            sum: Number.isFinite(height) ? height : 0, count: Number.isFinite(height) ? 1 : 0 });
        }
      }
    }
  }
  return [...edges.values()].map(({ sum, count, ...edge }) => ({ ...edge, y: count ? sum / count : null,
    width: Math.min(5, 1.5 + Math.log2(edge.weight)) })).sort((a, b) => (a.y ?? -Infinity) - (b.y ?? -Infinity));
}

/**
 * One resident's samples in time order across every dimension, for the elevation profile:
 * `distance` is horizontal blocks travelled within legs (nothing is added across a gap, jump or
 * portal; Nether blocks count as walked, not ×8); `joined` is false where a leg starts.
 */
export function profileSeries(legs) {
  const series = [];
  for (const leg of [...legs].filter(leg => leg.points.length).sort((a, b) => a.points[0][0] - b.points[0][0])) {
    leg.points.forEach((point, i) => series.push({ at: point[0], x: point[1], y: point[2], z: point[3], sky: point[4],
      dimension: leg.dimension, joined: i > 0, distance: 0 }));
  }
  let travelled = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].joined) travelled += Math.hypot(series[i].x - series[i - 1].x, series[i].z - series[i - 1].z);
    series[i].distance = travelled;
  }
  return series;
}

/**
 * Saved places the series passes: the first time each comes within `radius` blocks across and 16
 * blocks of height, in its own dimension, interpolated along joined segments.
 */
export function passedPlaces(series, places, radius = 8) {
  const found = [];
  for (const place of places) {
    for (let i = 0; i < series.length; i++) {
      const b = series[i], a = series[i - 1];
      if (b.dimension !== place.dimension) continue;
      let t = 0;
      if (a && b.joined) {
        const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
        t = length ? Math.max(0, Math.min(1, ((place.x - a.x) * dx + (place.z - a.z) * dz) / length)) : 1;
      } else t = 1;
      const from = a && b.joined ? a : b, at = (key) => from[key] + (b[key] - from[key]) * t;
      if (Math.hypot(at("x") - place.x, at("z") - place.z) <= radius && Math.abs(at("y") - place.y) <= 16) {
        found.push({ place, at: at("at"), distance: at("distance"), y: at("y") });
        break;
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Index of the series entry whose `key` is nearest `value`; the series is sorted by it. */
export function nearestIndex(series, key, value) {
  let low = 0, high = series.length - 1;
  if (high < 0) return -1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (series[middle][key] < value) low = middle + 1; else high = middle;
  }
  return low > 0 && value - series[low - 1][key] < series[low][key] - value ? low - 1 : low;
}
