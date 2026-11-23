// The diorama's block colour table, built at deploy time from the modpack's own jars
// (scripts/build-block-colours.ts): for each block, the average colour of the texture its
// model shows on top (or on all sides). The table is derived from mod textures, so it lives
// in the host's data directory and is never committed. The page falls back to a small
// hand-written vanilla-ish table and then to a colour hashed from the id.
import { open, readFile } from "node:fs/promises";
import { inflateRawSync, inflateSync } from "node:zlib";
import { record } from "./json.ts";

export interface BlockColours {
  /** Block id -> "#rrggbb". Empty when no table has been built on this host. */
  colours: Record<string, string>;
  builtAt: number | null;
  /** Why the table is empty, for the page's footnote. */
  problem?: string;
}

const MAX_TABLE = 4 * 1024 * 1024;
const COLOUR = /^#[0-9a-f]{6}$/;
const BLOCK_ID = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}$/;

/** The table on disk, validated; a missing or broken file gives an empty table, never an error. */
export async function readBlockColours(path: string): Promise<BlockColours> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      if ((await handle.stat()).size > MAX_TABLE) return { colours: {}, builtAt: null, problem: "the block colour table is too large; rebuild it" };
      text = await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch { return { colours: {}, builtAt: null, problem: "no block colour table was built on this host" }; }
  try {
    const raw = record(JSON.parse(text)), table = record(raw.colours), colours: Record<string, string> = {};
    for (const [id, colour] of Object.entries(table)) if (BLOCK_ID.test(id) && typeof colour === "string" && COLOUR.test(colour)) colours[id] = colour;
    return { colours, builtAt: typeof raw.builtAt === "number" ? raw.builtAt : null };
  } catch { return { colours: {}, builtAt: null, problem: "the block colour table is not valid JSON; rebuild it" }; }
}

// ---------- jars ----------

/**
 * The entries of a zip (a jar) whose names pass `wanted`, decompressed. Reads the central
 * directory, so a jar's 10 000 class files cost nothing. Zip64 archives are refused.
 */
export function readZip(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 is not supported");
  const out = new Map<string, Uint8Array>(), decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("broken zip directory");
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith("/") || !wanted(name)) continue;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`broken zip entry ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
    else throw new Error(`zip method ${method} for ${name}`);
  }
  return out;
}

// ---------- textures ----------

/**
 * The average colour of a PNG's visible pixels (alpha-weighted), or null when it is fully
 * transparent or not a PNG this reads (8/16-bit, every colour type, not interlaced). An
 * animated texture (a tall strip of square frames) counts its first frame. `accent` averages
 * only the fifth of the visible pixels farthest from that average instead: an ore's specks
 * rather than the stone around them, so ores stay visible in the diorama.
 */
export function averagePng(bytes: Uint8Array, accent = false): [number, number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette: Uint8Array | undefined, alphas: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at), kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8)), body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") { width = view.getUint32(at + 8); height = view.getUint32(at + 12); depth = bytes[at + 16]; type = bytes[at + 17]; interlace = bytes[at + 20]; }
    else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") alphas = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!width || !height || !channels || interlace || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && !palette)) return null;
  if (width > 4096 || height > 65_536) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth, stride = Math.ceil(width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  const rows = Math.min(height, width < height ? width : height);
  if (raw.length < (stride + 1) * rows) return null;
  let previous = new Uint8Array(stride), current = new Uint8Array(stride);
  const seen: number[] = [];
  for (let y = 0; y < rows; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? current[i - bpp] : 0, up = previous[i], corner = i >= bpp ? previous[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      // Samples as 8-bit: the high byte of 16-bit ones, scaled-up low-depth grey/palette indices.
      const sample = (c: number) => {
        if (depth === 16) return current[(x * channels + c) * 2];
        if (depth === 8) return current[x * channels + c];
        const bit = (x * channels + c) * depth, value = (current[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        return type === 3 ? value : Math.round(value * 255 / ((1 << depth) - 1));
      };
      let pr: number, pg: number, pb: number, pa = 255;
      if (type === 3) {
        const index = sample(0);
        pr = palette![index * 3] ?? 0; pg = palette![index * 3 + 1] ?? 0; pb = palette![index * 3 + 2] ?? 0; pa = alphas?.[index] ?? 255;
      } else if (type === 0 || type === 4) { pr = pg = pb = sample(0); if (type === 4) pa = sample(1); }
      else { pr = sample(0); pg = sample(1); pb = sample(2); if (type === 6) pa = sample(3); }
      if (pa) seen.push(pr, pg, pb, pa);
    }
    [previous, current] = [current, previous];
  }
  const mean = (from: number[]) => {
    let r = 0, g = 0, b = 0, weight = 0;
    for (let i = 0; i < from.length; i += 4) { r += from[i] * from[i + 3]; g += from[i + 1] * from[i + 3]; b += from[i + 2] * from[i + 3]; weight += from[i + 3]; }
    return weight ? [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)] as [number, number, number] : null;
  };
  const average = mean(seen);
  if (!accent || !average) return average;
  const ranked = Array.from({ length: seen.length / 4 }, (_, i) => i)
    .sort((a, b) => distance(seen, b * 4, average) - distance(seen, a * 4, average));
  return mean(ranked.slice(0, Math.max(1, Math.round(ranked.length / 5))).flatMap(i => seen.slice(i * 4, i * 4 + 4)));
}
const distance = (pixels: number[], at: number, to: number[]) => (pixels[at] - to[0]) ** 2 + (pixels[at + 1] - to[1]) ** 2 + (pixels[at + 2] - to[2]) ** 2;

// ---------- models ----------

type Json = Record<string, unknown>;
/** Which texture of a model shows the block best from above: the top, else what covers all sides. */
const TEXTURE_KEYS = ["top", "up", "end", "all", "texture", "cross", "plant", "crop", "side", "front", "particle"];
const resourcePath = (id: string, folder: string, extension: string) => {
  const [namespace, path] = id.includes(":") ? id.split(":", 2) : ["minecraft", id];
  return `assets/${namespace}/${folder}/${path}${extension}`;
};

/** The first model a blockstate file names (its first variant, or the first multipart piece). */
export function firstModel(blockstate: Json): string | undefined {
  const pick = (value: unknown) => { const entry = Array.isArray(value) ? value[0] : value; return typeof record(entry).model === "string" ? record(entry).model as string : undefined; };
  const variants = record(blockstate.variants);
  const keys = Object.keys(variants);
  // Prefer the plain variant ("" or the first listed); for slabs and the like that is a whole-ish shape.
  if (keys.length) return pick(variants[""] ?? variants[keys.find(key => /(^|,)type=double/.test(key)) ?? keys[0]]);
  if (Array.isArray(blockstate.multipart)) for (const part of blockstate.multipart) { const model = pick(record(part).apply); if (model) return model; }
  return undefined;
}

/**
 * The texture id a model shows on top, and whether that face is biome-tinted (grass, leaves,
 * water), following `parent` models and `#name` references.
 */
export function modelTexture(model: string, models: (path: string) => Json | undefined): { texture: string; tinted: boolean } | undefined {
  const textures: Record<string, string> = {};
  let elements: unknown[] | undefined;
  const seen = new Set<string>();
  for (let id: string | undefined = model; id && !seen.has(id) && seen.size < 16;) {
    seen.add(id);
    const json = models(resourcePath(id, "models", ".json"));
    if (!json) break;
    for (const [key, value] of Object.entries(record(json.textures))) if (typeof value === "string" && !(key in textures)) textures[key] = value;
    if (!elements && Array.isArray(json.elements)) elements = json.elements;
    id = typeof json.parent === "string" ? json.parent : undefined;
  }
  const resolve = (value: string | undefined) => {
    for (let depth = 0; value?.startsWith("#") && depth < 8; depth++) value = textures[value.slice(1)];
    // "block/stone" and "minecraft:block/stone" are one texture.
    return !value || value.startsWith("#") ? undefined : value.includes(":") ? value : `minecraft:${value}`;
  };
  const key = TEXTURE_KEYS.find(name => resolve(textures[name])) ?? Object.keys(textures).find(name => resolve(textures[name]));
  const texture = key && resolve(textures[key]);
  if (!texture) return undefined;
  // Tinted when a face drawing this texture carries a tintindex.
  let tinted = false;
  for (const element of elements ?? []) for (const face of Object.values(record(record(element).faces))) {
    const raw = record(face);
    if (typeof raw.tintindex === "number" && typeof raw.texture === "string" && resolve(raw.texture) === texture) tinted = true;
  }
  return { texture, tinted };
}

/** Plains biome colours, for textures the game tints by biome. */
const TINTS: [RegExp, [number, number, number]][] = [
  [/water/, [63, 118, 228]], [/spruce_leaves/, [97, 153, 97]], [/birch_leaves/, [128, 167, 85]],
  [/leaves|vine|lily_pad/, [119, 171, 47]], [/.*/, [145, 189, 89]],
];
const hex = (rgb: number[]) => `#${rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

/** Builds the table from jars (vanilla client first, then mods; nested jarjar jars included). */
export async function buildBlockColours(jarPaths: string[], log: (line: string) => void = () => {}): Promise<{ colours: Record<string, string>; sources: string[]; missing: string[] }> {
  const json = new Map<string, Json>(), sources: string[] = [];
  const jsonWanted = (name: string) => /^assets\/[^/]+\/(blockstates\/[^/]+|models\/.+)\.json$/.test(name);
  const each = async function* () {
    for (const path of jarPaths) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await readFile(path)); } catch { log(`skipped ${path}: unreadable`); continue; }
      yield { name: path.split("/").pop()!, bytes };
      let nested: Map<string, Uint8Array>;
      try { nested = readZip(bytes, name => /^META-INF\/jarjar\/[^/]+\.jar$/.test(name)); } catch { continue; }
      for (const [name, inner] of nested) yield { name: `${path.split("/").pop()}!${name.split("/").pop()}`, bytes: inner };
    }
  };
  // Pass 1: blockstates and models (small JSON). Later jars win, as resource packs stack.
  for await (const jar of each()) {
    let files: Map<string, Uint8Array>;
    try { files = readZip(jar.bytes, jsonWanted); } catch (error) { log(`skipped ${jar.name}: ${(error as Error).message}`); continue; }
    if (files.size) sources.push(jar.name);
    for (const [name, data] of files) {
      try { json.set(name, record(JSON.parse(new TextDecoder().decode(data)))); } catch { /* a broken JSON file names no colour */ }
    }
  }
  const wantedTextures = new Map<string, { block: string; tinted: boolean }[]>(), missing: string[] = [];
  for (const [name, blockstate] of json) {
    const found = /^assets\/([^/]+)\/blockstates\/([^/]+)\.json$/.exec(name);
    if (!found) continue;
    const block = `${found[1]}:${found[2]}`;
    const model = firstModel(blockstate), texture = model ? modelTexture(model, path => json.get(path)) : undefined;
    if (!texture) { missing.push(block); continue; }
    const path = resourcePath(texture.texture, "textures", ".png");
    if (!wantedTextures.has(path)) wantedTextures.set(path, []);
    wantedTextures.get(path)!.push({ block, tinted: texture.tinted || block === "minecraft:water" });
  }
  // Pass 2: only the textures some block needs.
  const colours: Record<string, string> = {};
  for await (const jar of each()) {
    let files: Map<string, Uint8Array>;
    try { files = readZip(jar.bytes, name => wantedTextures.has(name)); } catch { continue; }
    for (const [path, data] of files) {
      for (const { block, tinted } of wantedTextures.get(path)!) {
        // Ores are shown as they are: their specks' colour, not the stone around them.
        let colour: [number, number, number] | null = null;
        try { colour = averagePng(data, /_ore$/.test(block)); } catch { /* not a PNG this reads */ }
        if (!colour) continue;
        const tint = tinted ? TINTS.find(([pattern]) => pattern.test(block))![1] : [255, 255, 255];
        colours[block] = hex(colour.map((value, i) => value * tint[i] / 255));
      }
    }
  }
  for (const list of wantedTextures.values()) for (const { block } of list) if (!colours[block]) missing.push(block);
  return { colours, sources, missing: missing.sort() };
}
