import { deflateSync, inflateSync } from "node:zlib";
import { fromSynapse, packedLength } from "../../commons/src/diorama.ts";
import type { Body } from "./body.ts";

export type Point = readonly [number, number, number];
export type DraftSite = {
  origin: Point; dimension: string; observedAt: string; min: Point; max: Point;
  /** Registry block ids, with all three vanilla air variants normalized to minecraft:air. */
  palette: string[];
  /** Inclusive LOCAL bounds; x fastest, then z, then y. -1 means not observed, never air. */
  cells: number[];
};
type Facing = "north" | "east" | "south" | "west";
const BLOCK_ID = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}$/;
const AIR: Record<string, true | undefined> = { "minecraft:air": true, "minecraft:cave_air": true, "minecraft:void_air": true };
const MAX_AXIS = 65;

function bounds(origin: Point, min: Point, max: Point) {
  for (const point of [origin, min, max]) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isSafeInteger)) {
      throw new Error("Draft coordinates must be three whole block coordinates.");
    }
  }
  if (Math.abs(origin[0]) > 30_000_000 || Math.abs(origin[2]) > 30_000_000 || Math.abs(origin[1]) > 4096
    || [...min, ...max].some(n => Math.abs(n) > 4096)) throw new Error("Draft coordinates are outside supported world bounds.");
  const size = min.map((n, axis) => max[axis] - n + 1);
  if (size.some(n => n < 1 || n > MAX_AXIS)) throw new Error(`Draft bounds must span 1..${MAX_AXIS} blocks per axis.`);
  return { nx: size[0], ny: size[1], nz: size[2], count: size[0] * size[1] * size[2] };
}

/**
 * One read of the running body's own client, never Commons dashboard credentials, player
 * names, server queries, chunk loads or world actions. This is a snapshot, not a reservation:
 * Synapse may copy different sections on adjacent ticks. Only explicit section cells establish
 * air. Missing columns, omitted sections, outside the returned window and outside the
 * dimension's build height remain unknown. Block states, entities and inventories are absent.
 * The returned dimension is a canonical registry id, for the caller to compare with its draft.
 */
export async function surveyDraftSite(body: Body, origin: Point, min: Point, max: Point): Promise<DraftSite> {
  const { nx, nz, count } = bounds(origin, min, max);
  const observedAt = new Date().toISOString();
  // No `have`: this survey has no revision cache from which to reconstruct `same` sections.
  const raw = await body.api.request<unknown>("/chunks?radius=2&below=32&above=32");
  const dimension = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).dimension : undefined;
  const view = fromSynapse(raw);
  if (!view || typeof dimension !== "string" || !BLOCK_ID.test(dimension)) throw new Error("Synapse /chunks returned an invalid draft survey or dimension.");
  // fromSynapse is the shared wire validator (including bounded zlib validation). These checks
  // additionally reject ambiguous spatial data and uncached revisions before assigning cells.
  if (!view.origin.every(Number.isSafeInteger) || Math.abs(view.origin[0]) > 30_000_000 || Math.abs(view.origin[2]) > 30_000_000
    || view.levelMinY > view.levelMaxY || (view.minY <= view.maxY
      && (view.minY % 16 !== 0 || (view.maxY + 1) % 16 !== 0 || view.minY < view.levelMinY || view.maxY > view.levelMaxY))) {
    throw new Error("Synapse /chunks returned invalid spatial bounds.");
  }
  const cx = Math.floor(view.origin[0] / 16), cz = Math.floor(view.origin[2] / 16);
  const columns = new Set<string>();
  for (const [x, z] of [...view.chunks.map(c => [c.x, c.z]), ...view.missing]) {
    const key = `${x},${z}`;
    if (Math.abs(x - cx) > view.radius || Math.abs(z - cz) > view.radius || columns.has(key)) {
      throw new Error("Synapse /chunks returned duplicate or out-of-window columns.");
    }
    columns.add(key);
  }
  const palette = ["minecraft:air"], byId = new Map([[palette[0], 0]]);
  const cells = new Array<number>(count).fill(-1), sections = new Set<string>();
  const low = min.map((n, axis) => origin[axis] + n), high = max.map((n, axis) => origin[axis] + n);
  for (const section of view.sections) {
    const key = `${section.x},${section.y},${section.z}`;
    if (sections.has(key) || section.y * 16 < view.minY || section.y * 16 + 15 > view.maxY || "same" in section) {
      throw new Error("Synapse /chunks returned duplicate, out-of-window or uncached sections.");
    }
    sections.add(key);
    const base = [section.x * 16, section.y * 16, section.z * 16];
    const lo = low.map((n, axis) => Math.max(n, base[axis])), hi = high.map((n, axis) => Math.min(n, base[axis] + 15));
    if (lo.some((n, axis) => n > hi[axis])) continue;
    const packed = section.bits ? inflateSync(Buffer.from(section.data!, "base64"), { maxOutputLength: packedLength(section.bits) }) : undefined;
    const indices = new Uint16Array(4096), mask = (1 << section.bits) - 1;
    // Validate every decoded index, including those outside the crop; a palette's unused bit
    // patterns are not air. At most 6144 packed bytes and 4096 indices for a section.
    if (packed) for (let i = 0, bit = 0; i < 4096; i++, bit += section.bits) {
      const at = bit >> 3, shift = bit & 7;
      const index = ((packed[at] | (packed[at + 1] ?? 0) << 8 | (packed[at + 2] ?? 0) << 16) >> shift) & mask;
      if (index >= section.palette.length) throw new Error("Synapse /chunks contains an invalid palette index.");
      indices[i] = index;
    }
    const remap = new Map<number, number>();
    for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) {
      const source = indices[((y - base[1]) * 16 + z - base[2]) * 16 + x - base[0]];
      let target = remap.get(source);
      if (target === undefined) {
        const id = AIR[section.palette[source]] ? "minecraft:air" : section.palette[source];
        target = byId.get(id);
        if (target === undefined) { target = palette.length; palette.push(id); byId.set(id, target); }
        remap.set(source, target);
      }
      cells[((y - low[1]) * nz + z - low[2]) * nx + x - low[0]] = target;
    }
  }
  return { origin: [...origin], dimension, observedAt, min: [...min], max: [...max], palette, cells };
}

// A deliberately small software painter: cardinal orthographic view from above, not a
// Minecraft screenshot. Every non-air registry id is a full cube (including water, stairs,
// doors and plants); no textures, lighting, block states or hidden terrain are invented.
const WIDTH = 960, HEIGHT = 720;
type RGB = readonly [number, number, number];
const BACKGROUND: RGB = [20, 27, 35], PROPOSAL: RGB = [246, 181, 67], UNKNOWN: RGB = [159, 112, 196], REMOVED: RGB = [247, 102, 119];
const MATERIALS: [RegExp, RGB][] = [
  [/grass_block|moss|leaves|nylium/, [79, 117, 77]], [/dirt|mud|farmland|soul_sand/, [123, 92, 69]],
  [/sand|end_stone|birch/, [174, 162, 117]], [/snow|quartz|calcite|diorite/, [180, 190, 190]],
  [/water|ice|glass/, [72, 123, 155]], [/lava|magma/, [190, 94, 48]],
  [/log|wood|planks|chest/, [135, 104, 69]], [/brick|terracotta|granite/, [146, 96, 86]],
  [/deepslate|blackstone|obsidian|coal/, [65, 70, 80]],
];
const shade = (rgb: RGB, scale: number): RGB => [Math.round(rgb[0] * scale), Math.round(rgb[1] * scale), Math.round(rgb[2] * scale)];

// Only the uppercase glyphs used by the fixed image legend; no font or image dependencies.
const FONT: Record<string, string> = {
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110", C: "01111100001000010000100001000001111",
  D: "11110100011000110001100011000111110", E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01111100001000010111100011000101111", H: "10001100011000111111100011000110001", I: "11111001000010000100001000010011111",
  K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111", M: "10001110111010110101100011000110001",
  N: "10001110011010110011100011000110001", O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
  R: "11110100011000111110101001001010001", S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100", W: "10001100011000110101101011101110001",
  Y: "10001100010101000100001000010000100", "/": "00001000100001000100010000100010000", "-": "00000000000000011111000000000000000",
};

/**
 * Deterministic PNG of the saved terrain plus proposed cells. Facing is the compass direction
 * the viewer looks (north = -Z, east = +X). Gold marks additions/replacements, red dotted
 * frames mark proposed air removals. Purple checkerboard is opaque unknown space, NOT empty
 * space; it can occlude known blocks behind it. Crop edges are cuts, not surveyed walls.
 */
export function renderDraftPreview(site: DraftSite, overlay: ReadonlyMap<number, string>, facing: Facing): { type: "image"; mimeType: "image/png"; data: string } {
  const { nx, ny, nz, count } = bounds(site.origin, site.min, site.max);
  if (!["north", "east", "south", "west"].includes(facing)) throw new Error("Unknown draft preview facing.");
  if (site.cells.length !== count || site.palette.length > count + 1 || !site.palette.every(id => BLOCK_ID.test(id))
    || !site.cells.every(n => Number.isInteger(n) && n >= -1 && n < site.palette.length)) throw new Error("Invalid draft site cells or palette.");
  if (overlay.size > count) throw new Error("Too many draft overlay cells.");
  for (const [index, id] of overlay) if (!Number.isInteger(index) || index < 0 || index >= count || !BLOCK_ID.test(id)) throw new Error("Invalid draft overlay cell.");
  const nu = facing === "north" || facing === "south" ? nx : nz;
  const nv = facing === "north" || facing === "south" ? nz : nx;
  const scale = Math.min(28, (WIDTH - 80) / nu, (HEIGHT - 150) / (ny + nv * .5));
  const left = (WIDTH - nu * scale) / 2, bottom = HEIGHT - 80;
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = BACKGROUND[0]; pixels[i + 1] = BACKGROUND[1]; pixels[i + 2] = BACKGROUND[2]; }
  const pixel = (x: number, y: number, rgb: RGB) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const i = (y * WIDTH + x) * 3;
    pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2];
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, colour: RGB, checker = false) => {
    for (let y = Math.max(0, Math.ceil(y0)); y < Math.min(HEIGHT, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.ceil(x0)); x < Math.min(WIDTH, Math.ceil(x1)); x++) {
      pixel(x, y, checker && ((x >> 2) + (y >> 2)) % 2 === 0 ? shade(colour, .65) : colour);
    }
  };
  const text = (label: string, x: number, y: number, colour: RGB) => {
    for (const char of label) {
      const glyph = FONT[char];
      if (glyph) for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (glyph[row * 5 + col] === "1") rect(x + col * 2, y + row * 2, x + col * 2 + 2, y + row * 2 + 2, colour);
      x += 12;
    }
  };
  const indexAt = (u: number, h: number, v: number) => {
    if (u < 0 || u >= nu || h < 0 || h >= ny || v < 0 || v >= nv) return -1;
    const [x, z] = facing === "north" ? [u, nz - 1 - v] : facing === "east" ? [v, u] : facing === "south" ? [nx - 1 - u, v] : [nx - 1 - v, nz - 1 - u];
    return (h * nz + z) * nx + x;
  };
  const idAt = (u: number, h: number, v: number): string | undefined => {
    const index = indexAt(u, h, v);
    if (index < 0) return "minecraft:air";
    const id = overlay.get(index) ?? (site.cells[index] === -1 ? undefined : site.palette[site.cells[index]]);
    return id !== undefined && AIR[id] ? "minecraft:air" : id;
  };
  // Far rows before near rows, bottom before top. Only top and front faces are visible in a
  // cardinal orthographic view; no sorting approximation or guessed hidden geometry is needed.
  for (let v = nv - 1; v >= 0; v--) for (let h = 0; h < ny; h++) for (let u = 0; u < nu; u++) {
    const id = idAt(u, h, v), index = indexAt(u, h, v);
    const changed = overlay.has(index), x0 = left + u * scale, x1 = x0 + scale;
    const y0 = bottom - (h + 1 + v * .5) * scale, y1 = bottom - (h + v * .5) * scale;
    if (id !== undefined && AIR[id]) continue;
    const colour: RGB = id === undefined ? UNKNOWN : changed ? PROPOSAL : MATERIALS.find(([test]) => test.test(id))?.[1] ?? [112, 123, 130];
    if (idAt(u, h, v - 1) === "minecraft:air") rect(x0, y0, x1, y1, shade(colour, .65), id === undefined);
    if (idAt(u, h + 1, v) === "minecraft:air") rect(x0, y0 - scale * .5, x1, y0, colour, id === undefined);
    // A thin seam on exposed tops keeps adjacent roof blocks and terrain steps legible.
    if (idAt(u, h + 1, v) === "minecraft:air") rect(x0, y0 - scale * .5, Math.min(x1, x0 + 1), y0, shade(colour, .75));
  }
  // Air edits have no solid faces: overlay a dotted wire frame rather than painting them as
  // solid red cubes. This also makes an excavation distinguishable from pre-existing air.
  for (const [index, id] of overlay) {
    if (!AIR[id]) continue;
    const h = Math.floor(index / (nx * nz)), z = Math.floor(index / nx) % nz, x = index % nx;
    const [u, v] = facing === "north" ? [x, nz - 1 - z] : facing === "east" ? [z, x] : facing === "south" ? [nx - 1 - x, z] : [nz - 1 - z, nx - 1 - x];
    const x0 = Math.round(left + u * scale), x1 = Math.round(left + (u + 1) * scale) - 1;
    const y0 = Math.round(bottom - (h + 1 + v * .5) * scale), y1 = Math.round(bottom - (h + v * .5) * scale) - 1;
    for (let px = x0; px <= x1; px += 3) { pixel(px, y0, REMOVED); pixel(px, y1, REMOVED); }
    for (let py = y0; py <= y1; py += 3) { pixel(x0, py, REMOVED); pixel(x1, py, REMOVED); }
  }
  text(`DRAFT / LOOKING ${facing.toUpperCase()}`, 30, 22, [220, 229, 235]);
  text("TERRAIN", 30, HEIGHT - 50, [137, 158, 142]);
  text("PROPOSED", 160, HEIGHT - 50, PROPOSAL);
  text("UNKNOWN", 302, HEIGHT - 50, UNKNOWN);
  text("REMOVED", 432, HEIGHT - 50, REMOVED);
  text("SNAPSHOT / CUBES NOT BLOCK STATES", 30, HEIGHT - 26, [146, 161, 177]);
  return { type: "image", mimeType: "image/png", data: png(pixels).toString("base64") };
}

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function png(pixels: Uint8Array): Buffer {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); out.write(type, 4, 4, "ascii"); out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < out.length - 4; i++) crc = CRC[(crc ^ out[i]) & 255] ^ (crc >>> 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH); header.writeUInt32BE(HEIGHT, 4); header[8] = 8; header[9] = 2; // RGB8, no interlace.
  const rows = new Uint8Array((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) rows.set(pixels.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), y * (WIDTH * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}
