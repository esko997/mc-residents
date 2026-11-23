// SYNTHETIC terrain for the demo's Diorama: what Synapse `GET /chunks` would answer around a
// position in a made-up world (hills, a stream, a few trees, one cave chamber with a tunnel,
// scattered ores, a torch). No world data is read. Used by scripts/demo.ts only.
import { deflateSync } from "node:zlib";

/** Ground height: Gary's cabin area (around 110, -207) sits at 119. */
export const demoTop = (x: number, z: number) => Math.round(119 + 3 * Math.sin((x - 110) / 9) * Math.cos((z + 207) / 11) + 2 * Math.sin((z + 207) / 17));
const noise = (x: number, y: number, z: number) => {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 2 ** 32;
};
/** The cave: a chamber around (110, 96, -207) and a tunnel running west to east at y 95..97. */
export const DEMO_CAVE: [number, number, number] = [110, 96, -207];
function cave(x: number, y: number, z: number) {
  const [cx, cy, cz] = DEMO_CAVE;
  if ((x - cx) ** 2 / 20 + (y - cy) ** 2 / 6 + (z - cz) ** 2 / 14 <= 1) return true;
  return y >= 95 && y <= 97 && Math.abs(z - cz - Math.round(2 * Math.sin(x / 7))) <= 1 && x > cx - 30 && x < cx + 26;
}
function tree(x: number, y: number, z: number) {
  for (const [tx, tz] of [[98, -196], [121, -214], [104, -222]]) {
    const ground = demoTop(tx, tz);
    if (x === tx && z === tz && y > ground && y <= ground + 4) return "minecraft:oak_log";
    if (y >= ground + 3 && y <= ground + 6 && (x - tx) ** 2 + (z - tz) ** 2 + (y - ground - 5) ** 2 * 2 <= 7) return "minecraft:oak_leaves";
  }
  return undefined;
}
export function demoBlock(x: number, y: number, z: number): string {
  const top = demoTop(x, z), r = noise(x, y, z);
  if (cave(x, y, z)) return x === DEMO_CAVE[0] + 2 && z === DEMO_CAVE[2] && y === 94 ? "minecraft:torch" : "minecraft:cave_air";
  if (y > top) return tree(x, y, z) ?? (y <= 116 ? "minecraft:water" : y === top + 1 && r < .08 ? "minecraft:short_grass" : "minecraft:air");
  if (y === top) return top <= 116 ? "minecraft:sand" : "minecraft:grass_block";
  if (y > top - 4) return top <= 116 ? "minecraft:sand" : "minecraft:dirt";
  if (r < .004 && y < 100) return "minecraft:diamond_ore";
  if (r < .012) return "minecraft:iron_ore";
  if (r < .03) return "minecraft:coal_ore";
  if (r < .05) return "minecraft:andesite";
  return y < 92 && r > .97 ? "minecraft:gravel" : "minecraft:stone";
}

const cache = new Map<string, { y: number; rev: string; palette: string[]; bits: number; data?: string }>();
/** One section in Synapse's wire form (LSB-first indices, zlib, base64), cached by position. */
function section(cx: number, sy: number, cz: number) {
  const key = `${cx},${sy},${cz}`, known = cache.get(key);
  if (known) return known;
  const palette: string[] = [], index = new Map<string, number>(), indices = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++) {
    const id = demoBlock(cx * 16 + (i & 15), sy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15));
    if (!index.has(id)) { index.set(id, palette.length); palette.push(id); }
    indices[i] = index.get(id)!;
  }
  const bits = palette.length === 1 ? 0 : Math.ceil(Math.log2(palette.length));
  const packed = new Uint8Array(Math.ceil(4096 * bits / 8));
  indices.forEach((value, i) => { for (let b = 0; b < bits; b++) if (value >> b & 1) packed[(i * bits + b) >> 3] |= 1 << ((i * bits + b) & 7); });
  const rev = Bun.hash(`${key}|${palette.join(",")}|${Buffer.from(packed).toString("base64")}`).toString(16).padStart(16, "0").slice(-16);
  const value = { y: sy, rev, palette, bits, ...(bits ? { data: deflateSync(packed).toString("base64") } : {}) };
  cache.set(key, value);
  return value;
}

/** The `data` of GET /chunks for a body at `pos` (3 x 3 chunks, y +-16), honouring `have`. */
export function demoChunks(pos: { x: number; y: number; z: number }, have: Set<string>, players: { name: string; x: number; y: number; z: number }[], missingCorner = false) {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z), low = (y - 16) >> 4, high = (y + 16) >> 4;
  const chunks = [], missing: number[][] = [];
  for (let cz = (z >> 4) - 1; cz <= (z >> 4) + 1; cz++) for (let cx = (x >> 4) - 1; cx <= (x >> 4) + 1; cx++) {
    // A column the client has not loaded, to show how that looks.
    if (missingCorner && cx === (x >> 4) + 1 && cz === (z >> 4) - 1) { missing.push([cx, cz]); continue; }
    const sections = [];
    for (let sy = low; sy <= high; sy++) {
      const s = section(cx, sy, cz);
      sections.push(have.has(s.rev) ? { y: s.y, rev: s.rev, same: true } : s);
    }
    chunks.push({ x: cx, z: cz, sections });
  }
  const underground = cave(x, y, z);
  return {
    dimension: "minecraft:overworld", origin: [x, y, z], radius: 1, minY: low * 16, maxY: high * 16 + 15, levelMinY: -64, levelMaxY: 319,
    hasSkyLight: true, hasCeiling: false, skyLight: underground ? 0 : 15, chunks, missing,
    players: [{ name: "Gary", x: pos.x, y: pos.y, z: pos.z, self: true }, ...players],
    counts: { sectionsSent: 0, sectionsSame: 0, dataChars: 0 }, timing: { clientThreadMicros: 0, encodeMicros: 0, totalMicros: 0 },
  };
}
