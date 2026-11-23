import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { averagePng, buildBlockColours, firstModel, modelTexture, readBlockColours, readZip } from "../src/block-colours.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "block-colours-")); dirs.push(dir); return dir; };

/** A zip with stored and deflated entries, as jars are. */
function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0, index = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const deflate = index++ % 2 === 0, body = deflate ? deflateRawSync(raw) : raw, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(index, 8); end.writeUInt16LE(index, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** An RGBA (type 6) or palette (type 3) PNG; `filter` 2 ("up") exercises unfiltering. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[], options: { palette?: number[][]; filter?: 0 | 2 } = {}): Uint8Array {
  const channels = options.palette ? 1 : 4, stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), x * channels);
    raw[y * (stride + 1)] = options.filter ?? 0;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = options.filter === 2 ? (row[i] - previous[i]) & 255 : row[i];
    previous = row;
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(Number(Bun.hash.crc32(body)), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, options.palette ? 3 : 6, 0, 0, 0], 8);
  const extra = options.palette ? [chunk("PLTE", Buffer.from(options.palette.flatMap(c => c.slice(0, 3)))), chunk("tRNS", Buffer.from(options.palette.map(c => c[3] ?? 255)))] : [];
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

test("a jar is read through its directory, stored and deflated entries alike, only what is wanted", () => {
  const jar = zip({ "a/one.json": "{\"x\":1}", "a/two.json": "{\"y\":2}", "Main.class": "binary" });
  const files = readZip(jar, name => name.endsWith(".json"));
  expect([...files.keys()]).toEqual(["a/one.json", "a/two.json"]);
  expect(new TextDecoder().decode(files.get("a/two.json"))).toBe("{\"y\":2}");
  expect(() => readZip(new Uint8Array(40), () => true)).toThrow("not a zip");
});

test("a texture's average counts visible pixels only, by alpha, and an animation's first frame", () => {
  // Left half red, right half fully transparent green: the green must not count.
  expect(averagePng(png(4, 4, x => x < 2 ? [200, 0, 0, 255] : [0, 255, 0, 0]))).toEqual([200, 0, 0]);
  expect(averagePng(png(4, 4, (x, y) => [x * 60, y * 60, 100, 255], { filter: 2 }))).toEqual([90, 90, 100]);
  // A 2x6 strip of frames: the first 2x2 frame is blue, the rest yellow.
  expect(averagePng(png(2, 6, (_, y) => y < 2 ? [0, 0, 250, 255] : [250, 250, 0, 255]))).toEqual([0, 0, 250]);
  expect(averagePng(png(2, 2, x => [x], { palette: [[10, 20, 30], [30, 40, 50, 0]] }))).toEqual([10, 20, 30]);
  expect(averagePng(png(2, 2, () => [0, 0, 0, 0]))).toBeNull();
  expect(averagePng(new Uint8Array(10))).toBeNull();
  // An ore: three cyan specks in grey stone. Its plain average is nearly stone; its accent is the specks.
  const ore = png(4, 4, (x, y) => (x === 1 && y < 3) ? [0, 220, 220, 255] : [128, 128, 128, 255]);
  expect(averagePng(ore)).toEqual([104, 145, 145]);
  expect(averagePng(ore, true)).toEqual([0, 220, 220]);
});

test("a block's texture is found through its blockstate, parent models and #references", () => {
  const models: Record<string, Record<string, unknown>> = {
    "assets/minecraft/models/block/cube_bottom_top.json": { parent: "block/cube", textures: { particle: "#side" } },
    "assets/minecraft/models/block/cube.json": { elements: [{ faces: { up: { texture: "#up", tintindex: 0 }, north: { texture: "#north" } } }], textures: { up: "#top", north: "#side" } },
    "assets/minecraft/models/block/grass_block.json": { parent: "minecraft:block/cube_bottom_top", textures: { top: "minecraft:block/grass_block_top", side: "block/grass_block_side" } },
    "assets/minecraft/models/block/cube_all.json": { parent: "block/cube", textures: { up: "#all", north: "#all" } },
    "assets/mymod/models/block/crate.json": { parent: "minecraft:block/cube_all", textures: { all: "mymod:block/crate" } },
  };
  const lookup = (path: string) => models[path];
  expect(firstModel({ variants: { "snowy=false": { model: "minecraft:block/grass_block" }, "snowy=true": { model: "x" } } })).toBe("minecraft:block/grass_block");
  expect(firstModel({ variants: { "type=bottom": { model: "a" }, "type=double": [{ model: "b" }] } })).toBe("b");
  expect(firstModel({ multipart: [{ when: {}, apply: [{ model: "mymod:block/crate" }] }] })).toBe("mymod:block/crate");
  expect(modelTexture("minecraft:block/grass_block", lookup)).toEqual({ texture: "minecraft:block/grass_block_top", tinted: true });
  // The crate's up face is tinted in the shared parent too: it uses the same texture.
  expect(modelTexture("mymod:block/crate", lookup)).toEqual({ texture: "mymod:block/crate", tinted: true });
  expect(modelTexture("mymod:block/none", lookup)).toBeUndefined();
});

test("the table is built from a client jar and a mods directory; unreadable textures are listed, not guessed", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "client.jar"), zip({
    "assets/minecraft/blockstates/stone.json": JSON.stringify({ variants: { "": { model: "minecraft:block/stone" } } }),
    "assets/minecraft/models/block/stone.json": JSON.stringify({ textures: { all: "minecraft:block/stone" } }),
    "assets/minecraft/textures/block/stone.png": png(2, 2, () => [128, 128, 128, 255]),
    "assets/minecraft/blockstates/oak_leaves.json": JSON.stringify({ variants: { "": { model: "minecraft:block/oak_leaves" } } }),
    "assets/minecraft/models/block/oak_leaves.json": JSON.stringify({ textures: { all: "minecraft:block/oak_leaves" }, elements: [{ faces: { up: { texture: "#all", tintindex: 0 } } }] }),
    "assets/minecraft/textures/block/oak_leaves.png": png(2, 2, () => [255, 255, 255, 255]),
  }));
  const inner = zip({
    "assets/mymod/blockstates/crate.json": JSON.stringify({ variants: { "": { model: "mymod:block/crate" } } }),
    "assets/mymod/models/block/crate.json": JSON.stringify({ textures: { all: "mymod:block/crate" } }),
    "assets/mymod/textures/block/crate.png": png(2, 2, () => [160, 100, 40, 255]),
    "assets/mymod/blockstates/ghost.json": JSON.stringify({ variants: { "": { model: "mymod:block/ghost" } } }),
  });
  writeFileSync(join(dir, "mymod.jar"), zip({ "META-INF/jarjar/inner.jar": inner, "META-INF/mods.toml": "" }));
  const table = await buildBlockColours([join(dir, "client.jar"), join(dir, "mymod.jar")]);
  expect(table.colours).toEqual({ "minecraft:stone": "#808080", "minecraft:oak_leaves": "#77ab2f", "mymod:crate": "#a06428" });
  expect(table.missing).toEqual(["mymod:ghost"]);
  expect(table.sources).toEqual(["client.jar", "mymod.jar!inner.jar"]);

  writeFileSync(join(dir, "table.json"), JSON.stringify({ version: 1, builtAt: 5, colours: { ...table.colours, "bad id": "#000000", "x:y": "red" } }));
  expect(await readBlockColours(join(dir, "table.json"))).toEqual({ colours: table.colours, builtAt: 5 });
  expect((await readBlockColours(join(dir, "none.json"))).problem).toContain("no block colour table");
});
