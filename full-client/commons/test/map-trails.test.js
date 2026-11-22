import { describe, expect, test } from "bun:test";
import { mergeMapTrail } from "../public/map-trails.js";

describe("approximate map trails", () => {
  test("reversed and nearby parallel routes merge rather than doubling the linework", () => {
    const edges = mergeMapTrail([[0, -16, 0], [10_000, 16, 0], [20_000, -16, 1]]);
    expect(edges).toHaveLength(8);
    expect(edges.every(edge => edge.weight === 2 && edge.width > 1.5)).toBe(true);
    expect(edges[0]).toMatchObject({ x1: -16, z1: 0, x2: -12, z2: 0 });
    expect(edges[7]).toMatchObject({ x1: 12, z1: 0, x2: 16, z2: 0 });
  });

  test("diagonal rasterization agrees in both travel directions", () => {
    const forward = mergeMapTrail([[0, -12, 8], [10_000, 16, -8]]);
    const reverse = mergeMapTrail([[0, 16, -8], [10_000, -12, 8]]);
    expect(reverse).toEqual(forward);
    expect(forward[0]).toMatchObject({ x1: -12, z1: 8 });
    expect(forward.at(-1)).toMatchObject({ x2: 16, z2: -8 });
  });

  test("does not join offline gaps, teleports, out-of-order time or overlong thinned spans", () => {
    expect(mergeMapTrail([[0, 0, 0], [60_001, 16, 0]])).toEqual([]);
    expect(mergeMapTrail([[0, 0, 0], [1000, 100, 0]])).toEqual([]);
    expect(mergeMapTrail([[1000, 0, 0], [0, 16, 0]])).toEqual([]);
    expect(mergeMapTrail([[0, 0, 0], [60_000, 300, 0]])).toEqual([]);
    const afterGap = mergeMapTrail([[0, 0, 0], [120_000, 80, 0], [130_000, 88, 0]]);
    expect(afterGap.map(edge => [edge.x1, edge.x2])).toEqual([[80, 84], [84, 88]]);
  });

  test("standing and sub-grid jitter do not build a heavy route", () => {
    expect(mergeMapTrail([[0, 0, 0], [10_000, 1, 1], [20_000, 0, 0]])).toEqual([]);
  });

  test("many repeated samples keep width bounded and input points untouched", () => {
    const points = Array.from({ length: 3000 }, (_, i) => [i * 1000, i % 2 ? 16 : 0, 0]);
    const original = points.map(point => [...point]);
    const edges = mergeMapTrail(points);
    expect(edges).toHaveLength(4);
    expect(edges.every(edge => edge.width === 5 && edge.weight === 16)).toBe(true);
    expect(points).toEqual(original);
  });
});
