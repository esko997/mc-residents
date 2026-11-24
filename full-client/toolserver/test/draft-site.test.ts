import { afterEach, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import type { Body } from "../src/body.ts";
import { renderDraftPreview, surveyDraftSite, type DraftSite, type Point } from "../src/draft-site.ts";
import { Synapse } from "../src/synapse.ts";

type Section = { y: number; rev: string; bits?: number; palette?: string[]; data?: string; same?: true };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** Real Synapse HTTP envelope and authentication, with the same api the running Body owns. */
function client(answer: () => unknown, status = 200) {
  const requests: { method: string; path: string; token: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, token: request.headers.get("X-Synapse-Token") });
    return Response.json(status === 200 ? { ok: true, data: answer() } : { ok: false, error: { message: "Client unavailable" } }, { status });
  } });
  cleanups.push(() => { server.stop(true); });
  const body = { api: new Synapse(server.url.toString().replace(/\/$/, ""), "draft-client-token") } as Body;
  return { body, requests };
}

function section(y: number, palette = ["minecraft:air"], index: (x: number, y: number, z: number) => number = () => 0): Section {
  const bits = Math.ceil(Math.log2(palette.length));
  const out: Section = { y, rev: "0123456789abcdef", palette, bits };
  if (bits) {
    const packed = new Uint8Array(4096 * bits / 8);
    for (let i = 0; i < 4096; i++) {
      const value = index(i & 15, i >> 8, (i >> 4) & 15);
      for (let bit = 0; bit < bits; bit++) if ((value >> bit) & 1) packed[(i * bits + bit) >> 3] |= 1 << ((i * bits + bit) & 7);
    }
    out.data = deflateSync(packed).toString("base64");
  }
  return out;
}
function snapshot() {
  return {
    dimension: "minecraft:overworld", origin: [-1, 0, -1], radius: 2, minY: -16, maxY: 31, levelMinY: -64, levelMaxY: 319,
    hasSkyLight: true, hasCeiling: false, skyLight: 15,
    chunks: [{ x: -1, z: -1, sections: [section(0)] }], missing: [] as number[][],
    players: [{ name: "HiddenNeighbor", x: 0, y: 0, z: 0 }],
  };
}

const ZERO: Point = [0, 0, 0];

test("one authenticated read crops negative chunks and sections into x/z/y indexed local offsets", async () => {
  const palette = ["minecraft:stone", "minecraft:oak_planks", "minecraft:cave_air", "minecraft:void_air", "minecraft:air", "minecraft:moss_block", "minecraft:water"];
  const data = snapshot();
  data.chunks = [];
  const sourceIndex = (x: number, y: number, z: number) => (x + 3 * y + 2 * z) % palette.length;
  for (const z of [-1, 0]) for (const x of [-1, 0]) data.chunks.push({ x, z, sections: [-1, 0].map(y => section(y, palette, sourceIndex)) });
  const f = client(() => data), origin: Point = [-1, -1, -1], min: Point = [-1, -1, -1], max: Point = [1, 1, 1];
  const site = await surveyDraftSite(f.body, origin, min, max);
  expect(site).toMatchObject({ origin, min, max, dimension: "minecraft:overworld" });
  expect(site.cells).toHaveLength(27);
  expect(Number.isFinite(Date.parse(site.observedAt))).toBe(true);
  const wrapped = (n: number) => ((n % 16) + 16) % 16;
  for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const id = palette[sourceIndex(wrapped(origin[0] + x), wrapped(origin[1] + y), wrapped(origin[2] + z))];
    const expected = ["minecraft:air", "minecraft:cave_air", "minecraft:void_air"].includes(id) ? "minecraft:air" : id;
    expect(site.palette[site.cells[((y + 1) * 3 + z + 1) * 3 + x + 1]]).toBe(expected);
  }
  expect(site.palette).not.toContain("minecraft:cave_air");
  expect(site.palette).not.toContain("minecraft:void_air");
  expect(JSON.stringify(site)).not.toContain("HiddenNeighbor");
  expect(f.requests).toEqual([{ method: "GET", path: "/chunks?radius=2&below=32&above=32", token: "draft-client-token" }]);
  // The site's coordinate tuples are owned snapshots, not aliases to caller-owned arrays.
  expect(site.origin).not.toBe(origin);
  expect(site.min).not.toBe(min);
  expect(site.max).not.toBe(max);
});

test("only explicit air sections become air: absent sections, missing columns and uncaptured height stay unknown", async () => {
  const data = snapshot();
  data.missing = [[0, -1], [-1, 0], [0, 0]];
  const f = client(() => data);
  const site = await surveyDraftSite(f.body, [-1, 0, -1], [0, -1, 0], [1, 32, 1]);
  expect(site.palette).toEqual(["minecraft:air"]);
  for (let y = -1; y <= 32; y++) for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) {
    expect(site.cells[((y + 1) * 2 + z) * 2 + x]).toBe(x === 0 && z === 0 && y >= 0 && y < 16 ? 0 : -1);
  }
});

test("a survey reports its own dimension, including mod dimensions, without reading state or choosing a resident", async () => {
  const data = snapshot();
  data.dimension = "otherworld:moon/base";
  const f = client(() => data);
  expect((await surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).dimension).toBe("otherworld:moon/base");
  expect(f.requests.map(r => r.method)).toEqual(["GET"]);
  expect(f.requests.map(r => r.path.split("?")[0])).toEqual(["/chunks"]);
});

test("invalid or missing dimensions never silently become overworld", async () => {
  const data = snapshot();
  const f = client(() => data);
  for (const dimension of ["", " ", "overworld", "minecraft:bad dimension", "minecraft:", "x".repeat(200)]) {
    data.dimension = dimension;
    await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("invalid draft survey or dimension");
  }
});

test("the shared wire validator bounds decompression and refuses malformed sections", async () => {
  const data = snapshot(), f = client(() => data);
  const badSections: Section[] = [
    { ...section(0), bits: 1 },
    { ...section(0), palette: ["minecraft:stone[state=bad]"] },
    { ...section(0, ["minecraft:stone", "minecraft:air"]), data: "not base64" },
    { ...section(0, ["minecraft:stone", "minecraft:air"]), data: deflateSync(new Uint8Array(8192)).toString("base64") },
    { ...section(0), data: "AAAA" },
  ];
  for (const bad of badSections) {
    data.chunks[0].sections = [bad];
    await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("invalid draft survey");
  }
});

test("palette spare bit patterns, duplicate positions, out-of-window sections and uncached revisions are refused", async () => {
  let data = snapshot();
  const f = client(() => data);
  data.chunks[0].sections = [section(0, ["minecraft:air", "minecraft:stone", "minecraft:glass"], () => 3)];
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("invalid palette index");
  data = snapshot(); data.chunks[0].sections.push(section(0));
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("duplicate");
  data = snapshot(); data.chunks[0].sections = [section(2)];
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("out-of-window");
  data = snapshot(); data.chunks[0].sections = [{ y: 0, rev: "0123456789abcdef", same: true }];
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("uncached");
  data = snapshot(); data.missing = [[-1, -1]];
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("duplicate");
  data = snapshot(); data.chunks[0].x = 10;
  await expect(surveyDraftSite(f.body, [-1, 0, -1], ZERO, ZERO)).rejects.toThrow("out-of-window");
});

test("crop size and coordinate errors are refused before network access; client failures never invent a site", async () => {
  const f = client(snapshot);
  await expect(surveyDraftSite(f.body, ZERO, ZERO, [65, 0, 0])).rejects.toThrow("1..65");
  await expect(surveyDraftSite(f.body, ZERO, [1, 0, 0], ZERO)).rejects.toThrow("1..65");
  await expect(surveyDraftSite(f.body, [0.5, 0, 0], ZERO, ZERO)).rejects.toThrow("whole block");
  await expect(surveyDraftSite(f.body, [Number.MAX_SAFE_INTEGER, 0, 0], ZERO, ZERO)).rejects.toThrow("world bounds");
  expect(f.requests).toEqual([]);
  const unavailable = client(snapshot, 503);
  await expect(surveyDraftSite(unavailable.body, ZERO, ZERO, ZERO)).rejects.toThrow("Client unavailable");
  expect(unavailable.requests).toHaveLength(1);
});

/** Independent PNG chunk/CRC decoder: confirms a real portable RGB8 image, not a magic prefix. */
function decode(data: string) {
  const bytes = Buffer.from(data, "base64"), compressed: Buffer[] = [];
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let width = 0, height = 0;
  const types: string[] = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString("ascii", at + 4, at + 8), payload = bytes.subarray(at + 8, at + 8 + size);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(at + 4, at + 8 + size)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    expect(bytes.readUInt32BE(at + 8 + size)).toBe((crc ^ 0xffffffff) >>> 0);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      expect([...payload.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === "IDAT") compressed.push(payload);
    types.push(type); at += size + 12;
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  expect([width, height]).toEqual([960, 720]);
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (width * 3 + 1) * height });
  expect(raw.length).toBe((width * 3 + 1) * height);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 3 + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  }
  return { pixels, scene: pixels.subarray(width * 3 * 70, width * 3 * 650) };
}
function scene(): DraftSite {
  const cells = new Array<number>(4 * 3 * 4).fill(0);
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) cells[z * 4 + x] = 1;
  cells[(1 * 4 + 0) * 4 + 0] = 2;
  cells[(2 * 4 + 0) * 4 + 0] = 2;
  return { origin: [-10, 64, 30], min: [-2, -1, -2], max: [1, 1, 1], dimension: "minecraft:overworld", observedAt: "2026-11-24T12:00:00.000Z", palette: ["minecraft:air", "minecraft:stone", "minecraft:grass_block"], cells };
}
function rotated(site: DraftSite, overlay: ReadonlyMap<number, string>) {
  const out = { ...site, cells: new Array<number>(site.cells.length) }, edits = new Map<number, string>();
  for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
    const before = (y * 4 + z) * 4 + x, after = (y * 4 + 3 - x) * 4 + z;
    out.cells[after] = site.cells[before];
    if (overlay.has(before)) edits.set(after, overlay.get(before)!);
  }
  return { site: out, edits };
}

test("preview is a deterministic bounded valid PNG, combining shaded terrain, proposal, removals and honest unknown", () => {
  const site = scene();
  site.cells[(1 * 4 + 3) * 4 + 1] = -1;
  const overlay = new Map([[27, "minecraft:oak_planks"], [3, "minecraft:air"]]);
  const saved = JSON.stringify(site), savedOverlay = [...overlay];
  const first = renderDraftPreview(site, overlay, "north");
  expect(first.type).toBe("image"); expect(first.mimeType).toBe("image/png");
  expect(first.data).toBe(renderDraftPreview(site, overlay, "north").data);
  expect(Buffer.from(first.data, "base64").length).toBeLessThan(100_000);
  const { scene: pixels } = decode(first.data);
  const colours = new Set<string>();
  for (let at = 0; at < pixels.length; at += 3) colours.add(`${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`);
  expect(colours.has("112,123,130")).toBe(true); // terrain top
  expect(colours.has("73,80,85")).toBe(true); // terrain front shading
  expect(colours.has("246,181,67")).toBe(true); // proposal
  expect(colours.has("159,112,196")).toBe(true); // unknown checker light
  expect(colours.has("103,73,127")).toBe(true); // unknown checker dark
  expect(colours.has("247,102,119")).toBe(true); // removal wireframe
  expect(JSON.stringify(site)).toBe(saved);
  expect([...overlay]).toEqual(savedOverlay);
});

test("north/east/south/west really rotate terrain and proposals together with the requested compass direction", () => {
  const site = scene(), overlay = new Map([[27, "minecraft:oak_planks"], [7, "minecraft:air"]]);
  let turned = { site, edits: overlay };
  const views = ["north", "east", "south", "west"] as const;
  const rendered = views.map(facing => decode(renderDraftPreview(site, overlay, facing).data).scene);
  for (let turn = 1; turn < 4; turn++) {
    turned = rotated(turned.site, turned.edits);
    expect(decode(renderDraftPreview(turned.site, turned.edits, "north").data).scene).toEqual(rendered[turn]);
  }
  expect(rendered[0].equals(rendered[1])).toBe(false);
  expect(rendered[0].equals(rendered[2])).toBe(false);
  expect(rendered[1].equals(rendered[3])).toBe(false);
});

test("unknown cells are not indistinguishable from air, and all air variants remove rather than add cubes", () => {
  const site = scene();
  const empty = decode(renderDraftPreview(site, new Map(), "north").data).scene;
  const unknown = { ...site, cells: [...site.cells] };
  unknown.cells[(1 * 4 + 3) * 4 + 1] = -1;
  expect(decode(renderDraftPreview(unknown, new Map(), "north").data).scene.equals(empty)).toBe(false);
  const air = renderDraftPreview(site, new Map([[3, "minecraft:air"]]), "north");
  expect(renderDraftPreview(site, new Map([[3, "minecraft:cave_air"]]), "north").data).toBe(air.data);
  expect(renderDraftPreview(site, new Map([[3, "minecraft:void_air"]]), "north").data).toBe(air.data);
});

test("preview rejects oversized, malformed or out-of-bounds data rather than allocate or silently clip edits", () => {
  const site = scene();
  expect(() => renderDraftPreview({ ...site, max: [65, 0, 0] }, new Map(), "north")).toThrow("1..65");
  expect(() => renderDraftPreview({ ...site, cells: [] }, new Map(), "north")).toThrow("cells or palette");
  expect(() => renderDraftPreview({ ...site, cells: site.cells.map(() => 100) }, new Map(), "north")).toThrow("cells or palette");
  expect(() => renderDraftPreview(site, new Map([[-1, "minecraft:stone"]]), "north")).toThrow("overlay");
  expect(() => renderDraftPreview(site, new Map([[site.cells.length, "minecraft:stone"]]), "north")).toThrow("overlay");
  expect(() => renderDraftPreview(site, new Map([[0, "stone"]]), "north")).toThrow("overlay");
  expect(() => renderDraftPreview(site, new Map(), "up" as "north")).toThrow("facing");
});
