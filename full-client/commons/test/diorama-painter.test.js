import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blockColour, blockKind, buildGrid, covered, decodeSection, defaultCut, faces, figureBox, hashColour, HIDDEN_SHARE, layout, levelRange, opening, paint, pick, sliceWindow, STEP_SHARE, unpack } from "../public/diorama.js";

describe("decoding what Synapse packs", () => {
  test("indices are least significant bit first (the same vector as Synapse's SectionCodecTest)", () => {
    expect([...unpack(new Uint8Array([0xd1, 0x58, 0x1f]), 3, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });

  test("every width up to 12 bits decodes what was packed", () => {
    for (let bits = 1; bits <= 12; bits++) {
      const values = Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 2 ** bits);
      const bytes = new Uint8Array(4096 * bits / 8);
      values.forEach((value, i) => { for (let b = 0; b < bits; b++) if (value >> b & 1) bytes[(i * bits + b) >> 3] |= 1 << ((i * bits + b) & 7); });
      expect([...unpack(bytes, bits)]).toEqual(values);
    }
  });

  test("a section's zlib data decodes in the page; a uniform section needs none", async () => {
    const packed = new Uint8Array(512); packed[0] = 0b10;
    const indices = await decodeSection({ bits: 1, data: deflateSync(packed).toString("base64") });
    expect([indices[0], indices[1], indices[2]]).toEqual([0, 1, 0]);
    expect((await decodeSection({ bits: 0 })).every(v => v === 0)).toBe(true);
  });
});

describe("colours and kinds", () => {
  test("the host's table wins, then the built-in vanilla list, then a stable hash", () => {
    expect(blockColour("minecraft:stone", { "minecraft:stone": "#102030" })).toEqual([16, 32, 48]);
    expect(blockColour("minecraft:stone")).toEqual([125, 125, 125]);
    expect(blockColour("mekanism:osmium_ore")).toEqual(hashColour("mekanism:osmium_ore"));
    expect(hashColour("mekanism:osmium_ore")).not.toEqual(hashColour("mekanism:tin_ore"));
    expect(hashColour("x:y").every(v => v >= 0 && v <= 255)).toBe(true);
  });

  test("air, liquids, glass and thin decorations are told apart from solid blocks", () => {
    expect(["minecraft:cave_air", "minecraft:water", "minecraft:glass", "minecraft:torch", "minecraft:tall_grass", "minecraft:grass_block", "minecraft:lava", "minecraft:diamond_ore"]
      .map(blockKind)).toEqual(["air", "liquid", "glass", "thin", "thin", "solid", "solid", "solid"]);
  });
});

/** A view around (8, 70, 8) with radius 0: one column, sections 4 (stone with an ore) and 5 (air). */
function view(extra = {}) {
  return { dimension: "overworld", origin: [8, 70, 8], radius: 0, minY: 64, maxY: 95, levelMinY: -64, levelMaxY: 319,
    hasSkyLight: true, hasCeiling: false, skyLight: 15, chunks: [{ x: 0, z: 0 }], missing: [], players: [],
    sections: [{ x: 0, y: 4, z: 0, rev: "a".repeat(16) }, { x: 0, y: 5, z: 0, rev: "b".repeat(16) }], ...extra };
}
function decoded() {
  const ore = new Uint16Array(4096);
  ore[(5 * 16 + 3) * 16 + 2] = 1; // x 2, y 69, z 3
  return new Map([["0,4,0", { palette: ["minecraft:stone", "minecraft:diamond_ore"], indices: ore }],
    ["0,5,0", { palette: ["minecraft:air"], indices: new Uint16Array(4096) }]]);
}

describe("the slab", () => {
  test("blocks land at their world positions, relative to the slab's corner", () => {
    const grid = buildGrid(view(), decoded());
    expect(grid).toMatchObject({ side: 16, height: 32, minX: 0, minZ: 0, minY: 64 });
    const at = (x, y, z) => grid.kinds[grid.cells[((y - 64) * 16 + z) * 16 + x]].id;
    expect(at(2, 69, 3)).toBe("minecraft:diamond_ore");
    expect(at(2, 69, 4)).toBe("minecraft:stone");
    expect(at(2, 80, 3)).toBe("minecraft:air");
  });

  test("negative chunks and a missing column keep their places", () => {
    const grid = buildGrid(view({ origin: [-20, 70, 5], radius: 1, chunks: [{ x: -2, z: 0 }], missing: [[-1, 0]],
      sections: [{ x: -2, y: 4, z: 0, rev: "c".repeat(16) }] }), new Map([["-2,4,0", { palette: ["minecraft:stone"], indices: new Uint16Array(4096) }]]));
    expect(grid).toMatchObject({ side: 48, minX: -48, minZ: -16 });
    expect(grid.missing).toEqual([[32, 16]]);
    // Chunk -2 starts 16 blocks east of the slab's west edge (chunk -3, not held here: air).
    expect(grid.cells[((70 - 64) * 48 + 16) * 48 + 16]).toBe(1);
    expect(grid.cells[((70 - 64) * 48 + 16) * 48 + 0]).toBe(0);
  });

  test("only exposed faces are drawn; a cut opens the rock and marks the cut surface", () => {
    const grid = buildGrid(view(), decoded());
    const whole = faces(grid);
    // Solid stone from y 64 to 79 under air: its 256 tops, plus the east and south sides of the slab.
    expect(whole.filter(f => f[3] === 0)).toHaveLength(256);
    expect(whole.filter(f => f[3] === 1 || f[3] === 2)).toHaveLength(2 * 16 * 16);
    expect(whole.every(f => !f[5])).toBe(true);
    const cut = faces(grid, { top: 69 - 64 });
    const ore = cut.find(f => f[0] === 2 && f[1] === 5 && f[2] === 3 && f[3] === 0);
    expect(grid.kinds[ore[4]].id).toBe("minecraft:diamond_ore");
    expect(ore[5]).toBe(true);
    // Back to front: x + y + z never decreases.
    expect(cut.every((f, i) => i === 0 || f[0] + f[1] + f[2] >= cut[i - 1][0] + cut[i - 1][1] + cut[i - 1][2])).toBe(true);
  });

  test("the default cut: always in the Nether, at head height underground (no sky at the feet), never on the surface", () => {
    expect(defaultCut(view())).toBeNull();
    expect(defaultCut(view({ skyLight: 0 }))).toBe(71);
    expect(defaultCut(view({ hasCeiling: true, hasSkyLight: false, skyLight: 0 }))).toBe(73);
    expect(defaultCut(view({ hasSkyLight: false, skyLight: 0, dimension: "the_end" }))).toBeNull();
  });

  test("a point on the picture names the top block under it", () => {
    const grid = buildGrid(view(), decoded()), win = { top: 69 - 64 }, geometry = layout(grid, 600, 500, win);
    const [sx, sy] = geometry.project(2.5, win.top + 1, 3.5);
    expect(pick(grid, win, geometry, sx, sy)).toEqual({ x: 2, y: win.top, z: 3, id: "minecraft:diamond_ore" });
    expect(pick(grid, win, geometry, -500, -500)).toBeNull();
  });
});

/** A grid straight from a function of grid coordinates (world y = grid y + minY). */
function gridOf(side, height, blockAt, minY = 64) {
  const ids = ["minecraft:air"], kinds = [{ id: "minecraft:air", kind: "air", rgb: [0, 0, 0] }], cells = new Uint16Array(side * side * height);
  for (let y = 0; y < height; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const id = blockAt(x, y, z);
    if (id === "minecraft:air") continue;
    let k = ids.indexOf(id);
    if (k < 0) { k = ids.push(id) - 1; kinds.push({ id, kind: blockKind(id), rgb: [120, 120, 120] }); }
    cells[(y * side + z) * side + x] = k;
  }
  return { side, height, minX: 0, minZ: 0, minY, kinds, cells, missing: [] };
}
/** A seeded generator, so a failure names the same case every run. */
function random(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}
/** A view for a grid from gridOf with the resident's feet at (x, y, z) in world coordinates. */
const viewFor = (grid, [x, y, z]) => ({ origin: [Math.floor(x), Math.floor(y), Math.floor(z)], minY: grid.minY, maxY: grid.minY + grid.height - 1,
  players: [{ name: "Gary", x, y, z, self: true }] });
/** A 2D context that draws nothing (paint's geometry is what the tests read). */
const blankContext = () => new Proxy({}, { get: (target, key) => key in target ? target[key] : () => {}, set: (target, key, value) => { target[key] = value; return true; } });
const STONE = () => "minecraft:stone";
/** Solid stone with a 1 x 2 tunnel running east-west at z 24, feet at grid y 16. */
const tunnel = (x, y, z) => z === 24 && (y === 16 || y === 17) ? "minecraft:air" : "minecraft:stone";

describe("levels and the cut", () => {
  test("levels count from the feet and stay inside what was read; the cut stays inside the levels", () => {
    const grid = gridOf(16, 40, STONE), v = viewFor(grid, [8.5, 80, 8.5]); // read y 64..103, feet 80
    expect(levelRange(v, 4)).toEqual([76, 84]);
    expect(levelRange(v, 32)).toEqual([64, 103]);
    expect(sliceWindow(grid, v, { levels: 8, cut: null, cutaway: "off" })).toMatchObject({ bottom: 72 - 64, top: 88 - 64 });
    // A cut above the levels changes nothing; one below them stops at the lowest level shown.
    expect(sliceWindow(grid, v, { levels: 8, cut: 200, cutaway: "off" }).top).toBe(88 - 64);
    expect(sliceWindow(grid, v, { levels: 8, cut: 70, cutaway: "off" }).top).toBe(72 - 64);
    expect(sliceWindow(grid, v, { levels: 8, cut: 81, cutaway: "off" }).top).toBe(81 - 64);
    const win = sliceWindow(grid, v, { levels: 4, cut: 82, cutaway: "off" }), list = faces(grid, win);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(([, y]) => y >= 76 - 64 && y <= 82 - 64)).toBe(true);
  });
});

describe("the cutaway", () => {
  test("wherever the resident stands in its block, no drawn block covers its figure once opened", () => {
    const grid = gridOf(48, 40, STONE);
    // Every twentieth of a block across x and z, standing and on a slab-high step, under a low and a high window top.
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) for (const [lift, top] of [[0, 39], [.94, 20], [.5, 17]]) {
      const p = { x: 22 + i / 20, y: 64 + 16 + lift, z: 22 + j / 20 }, open = opening(grid, p);
      expect(covered(grid, { top, bottom: 0, open }, p, 13, 33)).toBe(0);
      // Without it the rock hides the figure, so the test would notice a cutaway that opens nothing.
      if (top >= 20) expect(covered(grid, { top, bottom: 0 }, p)).toBeGreaterThan(HIDDEN_SHARE);
    }
  });

  test("Auto opens only when the resident would be hidden; On and Off are obeyed; the opening follows the resident", () => {
    const ground = gridOf(48, 40, (x, y) => y < 16 ? "minecraft:stone" : "minecraft:air"), onGround = viewFor(ground, [24.5, 80, 24.5]);
    expect(sliceWindow(ground, onGround, { cutaway: "auto" })).toMatchObject({ open: null, hidden: 0 });
    expect(sliceWindow(ground, onGround, { cutaway: "on" }).open).toEqual({ x: 22, y: 16, z: 22 });
    const mine = gridOf(48, 40, tunnel), inTunnel = viewFor(mine, [24.5, 80, 24.5]);
    const auto = sliceWindow(mine, inTunnel, { cutaway: "auto" });
    expect(auto.hidden).toBeGreaterThanOrEqual(HIDDEN_SHARE);
    expect(auto.open).toEqual({ x: 22, y: 16, z: 22 });
    expect(sliceWindow(mine, inTunnel, { cutaway: "off" }).open).toBeNull();
    // Head-height cut (the underground default): the walls beside the body cover 45 %; the opening is only a step, so Auto opens.
    const headCut = sliceWindow(mine, inTunnel, { cut: 81, cutaway: "auto" });
    expect(headCut.hidden).toBeLessThan(HIDDEN_SHARE);
    expect(headCut.hidden).toBeGreaterThanOrEqual(STEP_SHARE);
    expect(headCut.open).not.toBeNull();
    // The same 45 % from a two-block rise beside someone on open ground leaves it shut: it would carve a quarter of the hill.
    const hillside = gridOf(48, 40, (x, y) => y < 16 || (y <= 17 && x >= 25) ? "minecraft:stone" : "minecraft:air");
    const onHill = sliceWindow(hillside, viewFor(hillside, [24.5, 80, 24.5]), { cutaway: "auto" });
    expect(onHill.hidden).toBeGreaterThanOrEqual(STEP_SHARE);
    expect(onHill.open).toBeNull();
    // Ten blocks east along the tunnel: the corner moves with the body and it is clear again.
    const moved = viewFor(mine, [34.5, 80, 24.5]), win = sliceWindow(mine, moved, { cutaway: "auto" });
    expect(win.open).toEqual({ x: 32, y: 16, z: 22 });
    expect(covered(mine, win, moved.players[0], 21, 41)).toBe(0);
  });

  test("the opening removes what is in front of the feet's layer and up, keeps the floor and marks cut walls", () => {
    const mine = gridOf(48, 40, tunnel), v = viewFor(mine, [24.5, 80, 24.5]);
    const win = sliceWindow(mine, v, { cutaway: "on" }), list = faces(mine, win);
    expect(list.some(([x, y, z]) => x >= 22 && z >= 22 && y >= 16)).toBe(false);
    // The floor under the opening: the tunnel's own floor is real, the rest was cut.
    const floor = (x, z) => list.find(f => f[0] === x && f[1] === 15 && f[2] === z && f[3] === 0);
    expect(floor(30, 24)[5]).toBe(false);
    expect(floor(30, 30)[5]).toBe(true);
    // The west wall of the opening faces east; where the tunnel goes on west it is a hole, not a wall.
    expect(list.find(f => f[0] === 21 && f[1] === 18 && f[2] === 30 && f[3] === 1)[5]).toBe(true);
    expect(list.some(f => f[0] === 21 && f[1] === 16 && f[2] === 24 && f[3] === 1)).toBe(false);
  });
});

describe("the readout names what is drawn", () => {
  /** The polygon a face is painted as, in screen coordinates (as `paint` draws it). */
  function polygon(project, [x, y, z, face]) {
    const points = face === 0 ? [[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]]
      : face === 1 ? [[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]]
      : face === 2 ? [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]]
      : [[x + .25, y + .12, z + .25], [x + .75, y + .12, z + .25], [x + .75, y + .12, z + .75], [x + .25, y + .12, z + .75]];
    return points.map(point => project(...point));
  }
  /** Signed distance from a point to a convex polygon's edges: positive inside, whichever way it winds. */
  function inside(points, [px, py]) {
    let sign = 0, least = Infinity;
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length], length = Math.hypot(bx - ax, by - ay);
      const d = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / length;
      if (Math.abs(d) < 1e-3) return 0;
      if (sign === 0) sign = Math.sign(d);
      if (Math.sign(d) !== sign) return -1;
      least = Math.min(least, Math.abs(d));
    }
    return least;
  }

  test("on a random slab with glass, water, torches, levels and an opening, the readout is the face painted last there", () => {
    const next = random(11), choices = ["minecraft:air", "minecraft:air", "minecraft:air", "minecraft:stone", "minecraft:stone", "minecraft:glass", "minecraft:water", "minecraft:torch"];
    const grid = gridOf(16, 14, () => choices[Math.floor(next() * choices.length)]);
    for (const win of [{ top: 13, bottom: 0 }, { top: 9, bottom: 3, open: opening(grid, { x: 8.5, y: 64 + 5, z: 8.5 }) }]) {
      const geometry = layout(grid, 640, 520, win), list = faces(grid, win), shapes = list.map(face => polygon(geometry.project, face));
      let checked = 0;
      for (let i = 0; i < 4000; i++) {
        const point = [next() * 640, next() * 520], depth = shapes.map(shape => inside(shape, point));
        if (depth.some(d => d === 0)) continue; // on an edge: either answer is fair
        const last = depth.findLastIndex(d => d > 0), hit = pick(grid, win, geometry, ...point);
        expect(hit && [hit.x, hit.y, hit.z]).toEqual(last < 0 ? null : list[last].slice(0, 3));
        checked++;
      }
      expect(checked).toBeGreaterThan(3500);
    }
  });

  test("the resident's figure is named where it is painted, and the rock where rock is painted over it", () => {
    const mine = gridOf(48, 40, tunnel), v = viewFor(mine, [24.5, 80, 24.5]);
    for (const cutaway of ["on", "off"]) {
      const win = sliceWindow(mine, v, { cutaway }), list = faces(mine, win);
      const geometry = paint(blankContext(), mine, list, { width: 800, height: 700, win, players: v.players });
      const [left, top, right, bottom] = figureBox(geometry, 24.5, 16, 24.5), centre = [(left + right) / 2, (top + bottom) / 2];
      const hit = pick(mine, win, geometry, ...centre);
      if (cutaway === "on") expect(hit).toEqual({ player: { name: "Gary", x: 24.5, y: 80, z: 24.5, self: true } });
      else expect(hit.x + hit.y + hit.z).toBeGreaterThan(24 + 16 + 24);
    }
  });
});
