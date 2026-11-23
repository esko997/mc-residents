import { describe, expect, test } from "bun:test";
import { coverOf, equivalent, heightColour, mapDimensions, mergeMapTrail, nearestIndex, passedPlaces, profileSeries, splitByHeight } from "../public/map-trails.js";

// Points are [unix ms, x, y, z, sky light].
const p = (at, x, z, y = 64, sky = 15) => [at, x, y, z, sky];

describe("approximate map trails", () => {
  test("reversed and nearby parallel routes at one height merge rather than doubling the linework", () => {
    const edges = mergeMapTrail([[p(0, -16, 0), p(10_000, 16, 0), p(20_000, -16, 1)]]);
    expect(edges).toHaveLength(8);
    expect(edges.every(edge => edge.weight === 2 && edge.width > 1.5 && edge.y === 64)).toBe(true);
    expect(edges.find(edge => edge.x1 === -16)).toMatchObject({ x1: -16, z1: 0, x2: -12, z2: 0 });
    expect(edges.find(edge => edge.x2 === 16)).toMatchObject({ x1: 12, z1: 0, x2: 16, z2: 0 });
  });

  test("a tunnel under a road stays its own line, drawn first (lower heights before higher)", () => {
    const edges = mergeMapTrail([[p(0, 0, 0, 70), p(10_000, 16, 0, 70)], [p(20_000, 0, 0, 12), p(30_000, 16, 0, 12)]]);
    expect(edges.map(edge => edge.y)).toEqual([12, 12, 12, 12, 70, 70, 70, 70]);
    expect(edges.every(edge => edge.weight === 1)).toBe(true);
  });

  test("diagonal rasterization agrees in both travel directions, heights included", () => {
    const forward = mergeMapTrail([[p(0, -12, 8, 10), p(10_000, 16, -8, 40)]]);
    const reverse = mergeMapTrail([[p(0, 16, -8, 40), p(10_000, -12, 8, 10)]]);
    expect(reverse).toEqual(forward);
    expect(forward[0]).toMatchObject({ x1: -12, z1: 8 });
    expect(forward.at(-1)).toMatchObject({ x2: 16, z2: -8 });
  });

  test("separate runs are never joined; standing and sub-grid jitter do not build a route", () => {
    expect(mergeMapTrail([[p(0, 0, 0)], [p(10_000, 64, 0)]])).toEqual([]);
    expect(mergeMapTrail([[p(0, 0, 0), p(10_000, 1, 1), p(20_000, 0, 0)]])).toEqual([]);
  });

  test("many repeated samples keep width bounded and input points untouched", () => {
    const points = Array.from({ length: 3000 }, (_, i) => p(i * 1000, i % 2 ? 16 : 0, 0));
    const original = points.map(point => [...point]);
    const edges = mergeMapTrail([points]);
    expect(edges).toHaveLength(4);
    expect(edges.every(edge => edge.width === 5 && edge.weight === 16)).toBe(true);
    expect(points).toEqual(original);
  });

  test("the height filter splits a leg where it leaves the range, so nothing is joined across", () => {
    const leg = [p(0, 0, 0, 70), p(1, 4, 0, 40), p(2, 8, 0, 20), p(3, 12, 0, 70), p(4, 16, 0, 30)];
    expect(splitByHeight(leg, -64, 62).map(run => run.map(point => point[1]))).toEqual([[4, 8], [16]]);
    expect(splitByHeight(leg)).toEqual([leg]);
  });
});

describe("dimensions, heights and cover", () => {
  test("only dimensions with something in them are offered, Overworld always first", () => {
    expect(mapDimensions({ residents: [], places: [], deaths: [], alarms: [] })).toEqual(["overworld"]);
    expect(mapDimensions({
      residents: [{ legs: [{ dimension: "the_end", points: [p(0, 0, 0)] }, { dimension: "the_nether", points: [] }], position: { x: 0, y: 0, z: 0 }, dimension: "the_nether" }],
      places: [{ dimension: "aether:the_aether" }], deaths: [], alarms: [],
    })).toEqual(["overworld", "the_nether", "the_end", "aether:the_aether"]);
  });

  test("Nether and Overworld coordinates convert at eight to one, other dimensions have none", () => {
    expect(equivalent("the_nether", 25, -22)).toEqual({ dimension: "overworld", x: 200, z: -176 });
    expect(equivalent("overworld", 201, -95)).toEqual({ dimension: "the_nether", x: 25, z: -12 });
    expect(equivalent("the_end", 1, 1)).toBeNull();
  });

  test("height colours follow the stops, clamp at the ends, and are grey when unknown", () => {
    expect(heightColour(63)).toBe("rgb(108,197,106)");
    expect(heightColour(-200)).toBe(heightColour(-64));
    expect(heightColour(999)).toBe(heightColour(256));
    expect(heightColour(-32)).toBe("rgb(126,126,232)");
    expect(heightColour(null)).toBe("rgb(163,171,155)");
  });

  test("underground means no sky light below sea level; without a reading only 'below sea level' is said", () => {
    expect(coverOf("overworld", 12, 0)).toMatchObject({ kind: "underground", underground: true });
    expect(coverOf("overworld", 90, 0)).toMatchObject({ kind: "enclosed", underground: false });
    expect(coverOf("overworld", 40, 15)).toMatchObject({ kind: "open", underground: false });
    expect(coverOf("overworld", 64, 9).label).toBe("partly covered (sky light 9)");
    expect(coverOf("overworld", 40, null)).toMatchObject({ kind: "below-sea", underground: true });
    expect(coverOf("overworld", 70, undefined)).toMatchObject({ kind: "unknown", underground: false });
    expect(coverOf("the_nether", 40, 0)).toMatchObject({ kind: "no-sky", underground: false });
  });
});

describe("elevation profile", () => {
  const legs = [
    { dimension: "the_nether", points: [p(30_000, 25, -22, 59, 0), p(40_000, 25, -2, 59, 0)] },
    { dimension: "overworld", points: [p(0, 200, -96, 53), p(10_000, 203, -92, 50)] },
  ];

  test("series are in time order across dimensions, with distance only along joined stretches", () => {
    const series = profileSeries(legs);
    expect(series.map(point => [point.at, point.dimension, point.joined, point.distance])).toEqual([
      [0, "overworld", false, 0], [10_000, "overworld", true, 5], [30_000, "the_nether", false, 5], [40_000, "the_nether", true, 25],
    ]);
    expect(nearestIndex(series, "at", 26_000)).toBe(2);
    expect(nearestIndex(series, "distance", 16)).toBe(3);
    expect(nearestIndex([], "at", 1)).toBe(-1);
  });

  test("places passed are found along segments, in their own dimension and height only", () => {
    const series = profileSeries(legs);
    const passed = passedPlaces(series, [
      { name: "Hub", dimension: "the_nether", x: 30, y: 60, z: -12 },
      { name: "Elsewhere", dimension: "overworld", x: 30, y: 60, z: -12 },
      { name: "Far below", dimension: "the_nether", x: 25, y: 10, z: -12 },
    ]);
    expect(passed.map(entry => [entry.place.name, entry.at, entry.distance])).toEqual([["Hub", 35_000, 15]]);
  });
});
