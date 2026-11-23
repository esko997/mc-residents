import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCommons } from "../src/db.ts";
import { openStation } from "../src/station-db.ts";
import { classifyCrossings, decimateLegs, dimensionKey, mapTrail, recordPosition, type TrailLeg, type TrailPoint } from "../src/positions.ts";

const SCHEMA = new URL("../schema.sql", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A database as Commons left it before sky light was recorded. */
function oldDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "positions-")); dirs.push(dir);
  const path = join(dir, "old.sqlite"), db = new Database(path, { create: true });
  db.exec(`CREATE TABLE positions (resident TEXT NOT NULL, at INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    dimension TEXT NOT NULL, health REAL, food INTEGER, PRIMARY KEY (resident, at)) WITHOUT ROWID;
    INSERT INTO positions VALUES ('Gary', 1000, 10, 64, 5, 'minecraft:overworld', 20, 18), ('Gary', 2000, 1, 70, 2, 'minecraft:the_nether', 20, 18);`);
  db.close();
  return path;
}

for (const [role, open] of [["hub", (path: string) => openCommons(path, SCHEMA)], ["station", openStation]] as const) {
  test(`${role}: an existing positions table gains sky light, keeps its rows as unknown, and reopens cleanly`, () => {
    const path = oldDatabase();
    for (let opening = 0; opening < 2; opening++) {
      const db = open(path);
      expect(db.query("SELECT resident, at, x, y, z, dimension, health, food, sky FROM positions WHERE at < 3000 ORDER BY at").all()).toEqual([
        { resident: "Gary", at: 1000, x: 10, y: 64, z: 5, dimension: "minecraft:overworld", health: 20, food: 18, sky: null },
        { resident: "Gary", at: 2000, x: 1, y: 70, z: 2, dimension: "minecraft:the_nether", health: 20, food: 18, sky: null },
      ]);
      if (opening === 0) recordPosition(db, "Gary", 3000, { x: 3, y: 12, z: 4, dimension: "minecraft:overworld", sky: 0 });
      else expect(db.query("SELECT sky FROM positions WHERE at = 3000").get()).toEqual({ sky: 0 });
      db.close();
    }
  });
}

test("dimension keys: the namespace is dropped for vanilla, kept for mods, and a missing one is the overworld", () => {
  expect(["minecraft:the_nether", "the_nether", "twilightforest:twilight_forest", undefined, ""].map(dimensionKey))
    .toEqual(["the_nether", "the_nether", "twilightforest:twilight_forest", "overworld", "overworld"]);
});

function samples(rows: [number, number, number, number, string, number | null][]) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE positions (resident TEXT, at INTEGER, x REAL, y REAL, z REAL, dimension TEXT, health REAL, food INTEGER, sky INTEGER, PRIMARY KEY (resident, at)) WITHOUT ROWID");
  for (const [at, x, y, z, dimension, sky] of rows) recordPosition(db, "Margo", at, { x, y, z, dimension, ...(sky === null ? {} : { sky }) });
  return db;
}

test("legs split at dimension changes, offline gaps and jumps; only consecutive dimension changes are crossings", () => {
  const db = samples([
    [0, 200.6, 52.8, -95.5, "minecraft:overworld", 15],
    [10_000, 200.7, 52.9, -95.4, "minecraft:overworld", 15],   // standing still: same block, later time
    [20_000, 13.5, 67, -12.5, "minecraft:the_nether", 0],       // through the portal
    [30_000, 20, 64, -14, "minecraft:the_nether", 0],
    [400_000, 24, 59, -22, "minecraft:the_nether", 0],          // after an offline gap: a new leg, not a crossing
    [410_000, 330, 59, -22, "minecraft:the_nether", 0],         // a jump far too fast to walk
    [900_000, 119.5, 79, -79.5, "minecraft:overworld", null],   // back home only after a long gap: no crossing
  ]);
  const trail = mapTrail(db, "Margo", 0);
  expect(trail.samples).toBe(7);
  expect(trail.legs).toEqual([
    { dimension: "overworld", points: [[10_000, 201, 53, -95, 15]] },
    { dimension: "the_nether", points: [[20_000, 14, 67, -12, 0], [30_000, 20, 64, -14, 0]] },
    { dimension: "the_nether", points: [[400_000, 24, 59, -22, 0]] },
    { dimension: "the_nether", points: [[410_000, 330, 59, -22, 0]] },
    { dimension: "overworld", points: [[900_000, 120, 79, -79, null]] },
  ]);
  expect(trail.crossings).toEqual([{ at: 20_000, from: { dimension: "overworld", x: 201, y: 53, z: -95 }, to: { dimension: "the_nether", x: 14, y: 67, z: -12 }, kind: "portal" }]);
  expect(mapTrail(db, "Margo", 25_000).legs[0]).toEqual({ dimension: "the_nether", points: [[30_000, 20, 64, -14, 0]] });
});

test("a dimension change just after a death there is a respawn, not a portal", () => {
  const crossing = { at: 100_000, from: { dimension: "the_nether", x: 1, y: 2, z: 3 }, to: { dimension: "overworld", x: 4, y: 5, z: 6 }, kind: "portal" as const };
  expect(classifyCrossings([crossing], [{ at: 90_000, dimension: "the_nether" }])[0].kind).toBe("respawn");
  expect(classifyCrossings([crossing], [{ at: 90_000, dimension: "overworld" }])[0].kind).toBe("portal");
  expect(classifyCrossings([crossing], [{ at: 100_000 - 301_000, dimension: "the_nether" }])[0].kind).toBe("portal");
});

/** A night of mining: a walk out, a staircase down to y -50 and back, wandering in between. */
function night(points: number): TrailPoint[] {
  return Array.from({ length: points }, (_, i): TrailPoint => {
    const phase = i / points, depth = phase < .4 || phase > .6 ? 70 : 70 - Math.sin((phase - .4) / .2 * Math.PI) * 120;
    return [i * 10_000, Math.round(i * .7 + Math.sin(i / 9) * 6), Math.round(depth), Math.round(Math.cos(i / 13) * 40), i % 7 ? 15 : 0];
  });
}

test("decimation keeps the budget, every leg's ends, the deepest point, and time order", () => {
  const legs: TrailLeg[] = [{ dimension: "overworld", points: night(20_000) }, { dimension: "the_nether", points: night(8_000) }, { dimension: "overworld", points: [[1, 0, 64, 0, null]] }];
  const out = decimateLegs(legs, 3000);
  expect(out.reduce((sum, leg) => sum + leg.points.length, 0)).toBe(3000);
  expect(out.map(leg => leg.dimension)).toEqual(["overworld", "the_nether", "overworld"]);
  for (const [i, leg] of out.entries()) {
    expect(leg.points[0]).toBe(legs[i].points[0]);
    expect(leg.points.at(-1)).toBe(legs[i].points.at(-1));
    expect(leg.points.every((point, j) => j === 0 || point[0] > leg.points[j - 1][0])).toBe(true);
  }
  const deepest = Math.min(...legs[0].points.map(point => point[2]));
  expect(Math.min(...out[0].points.map(point => point[2]))).toBe(deepest);
  // Under the budget nothing changes; with more legs than the budget allows, each keeps its ends only.
  expect(decimateLegs(legs.slice(2), 10)).toEqual(legs.slice(2));
  const many = Array.from({ length: 5 }, (_, i): TrailLeg => ({ dimension: "overworld", points: night(10).map(p => [p[0] + i, p[1], p[2], p[3], p[4]]) }));
  expect(decimateLegs(many, 4).map(leg => leg.points.length)).toEqual([2, 2, 2, 2, 2]);
});

test("a week of samples for one resident is read and decimated quickly", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE positions (resident TEXT, at INTEGER, x REAL, y REAL, z REAL, dimension TEXT, health REAL, food INTEGER, sky INTEGER, PRIMARY KEY (resident, at)) WITHOUT ROWID");
  const insert = db.query("INSERT INTO positions VALUES ('Tobin', ?, ?, ?, ?, 'minecraft:overworld', 20, 20, 15)");
  let x = 0, y = 64, z = 0;
  db.transaction(() => {
    for (let i = 0; i < 60_480; i++) {
      x += Math.sin(i / 50) * 3 + (i % 3) - 1; z += Math.cos(i / 70) * 3; y = Math.max(-60, Math.min(200, y + ((i * 7919) % 5) - 2));
      insert.run(i * 10_000, x, y, z);
    }
  })();
  const started = performance.now();
  const trail = mapTrail(db, "Tobin", 0);
  const elapsed = performance.now() - started;
  expect(trail.samples).toBe(60_480);
  expect(trail.legs.reduce((sum, leg) => sum + leg.points.length, 0)).toBeLessThanOrEqual(3000);
  expect(elapsed).toBeLessThan(2000);
});
