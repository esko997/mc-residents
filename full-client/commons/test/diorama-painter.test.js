import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blockColour, blockKind, buildGrid, decodeSection, defaultCut, faces, hashColour, layout, pick, unpack } from "../public/diorama.js";

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
    const cut = faces(grid, 69 - 64);
    const ore = cut.find(f => f[0] === 2 && f[1] === 5 && f[2] === 3 && f[3] === 0);
    expect(grid.kinds[ore[4]].id).toBe("minecraft:diamond_ore");
    expect(ore[5]).toBe(true);
    // Back to front: x + y + z never decreases.
    expect(cut.every((f, i) => i === 0 || f[0] + f[1] + f[2] >= cut[i - 1][0] + cut[i - 1][1] + cut[i - 1][2])).toBe(true);
  });

  test("the default cut: always in the Nether, underground when no sky reaches the feet, never on the surface", () => {
    expect(defaultCut(view())).toBeNull();
    expect(defaultCut(view({ skyLight: 0 }))).toBe(72);
    expect(defaultCut(view({ hasCeiling: true, hasSkyLight: false, skyLight: 0 }))).toBe(73);
    expect(defaultCut(view({ hasSkyLight: false, skyLight: 0, dimension: "the_end" }))).toBeNull();
  });

  test("a point on the picture names the top block under it", () => {
    const grid = buildGrid(view(), decoded()), cut = 69 - 64, geometry = layout(grid, 600, 500, cut);
    const [sx, sy] = geometry.project(2.5, cut + 1, 3.5);
    expect(pick(grid, geometry, cut, sx, sy)).toEqual({ x: 2, y: cut, z: 3, id: "minecraft:diamond_ore" });
    expect(pick(grid, geometry, cut, -500, -500)).toBeNull();
  });
});
