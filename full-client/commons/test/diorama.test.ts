import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { DioramaCache, fromSynapse, MIN_REFRESH_MS, validReply, type DioramaReply } from "../src/diorama.ts";
import { Federation } from "../src/federation.ts";
import type { Routes } from "../src/routes/context.ts";
import type { ResidentConfig } from "../src/config.ts";
import { fakeSynapse, tempHome, type Home } from "./helpers.ts";

const TOKEN = "diorama-test-token";
let clock = 1_790_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Packs palette indices LSB first, as Synapse's SectionCodec.pack does. */
function pack(indices: number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(indices.length * bits / 8));
  indices.forEach((value, i) => { for (let b = 0; b < bits; b++) if (value >> b & 1) out[(i * bits + b) >> 3] |= 1 << ((i * bits + b) & 7); });
  return out;
}
const rev = (...parts: unknown[]) => Bun.hash(JSON.stringify(parts)).toString(16).padStart(16, "0").slice(-16);
/** A Synapse section: stone with `ores` diamond ore at the given block indices; `air` makes it all air. */
function section(x: number, y: number, z: number, ores: number[] = [], air = false) {
  if (air) return { y, rev: rev(x, y, z, "air"), palette: ["minecraft:air"], bits: 0 };
  if (!ores.length) return { y, rev: rev(x, y, z, "stone"), palette: ["minecraft:stone"], bits: 0 };
  const indices = Array.from({ length: 4096 }, (_, i) => ores.includes(i) ? 1 : 0);
  return { y, rev: rev(x, y, z, ores), palette: ["minecraft:stone", "minecraft:diamond_ore"], bits: 1, data: deflateSync(pack(indices, 1)).toString("base64") };
}
/** GET /chunks data around (8, 70, 8): 3x3 columns, sections 3..5; one column missing, one ore. */
function chunks(options: { ores?: number[]; missing?: boolean } = {}) {
  const columns = [], missing: number[][] = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    if (options.missing && x === 1 && z === 1) { missing.push([x, z]); continue; }
    columns.push({ x, z, sections: [3, 4, 5].map(y => section(x, y, z, x === 0 && z === 0 && y === 4 ? options.ores ?? [] : [], y === 5)) });
  }
  return {
    dimension: "minecraft:overworld", origin: [8, 70, 8], radius: 1, minY: 48, maxY: 95, levelMinY: -64, levelMaxY: 319,
    hasSkyLight: true, hasCeiling: false, skyLight: 0, chunks: columns, missing,
    players: [{ name: "Wren", x: 8.5, y: 70, z: 8.5, self: true }, { name: "spesk01", x: 12, y: 71, z: 3 }],
    counts: { sectionsSent: 27, sectionsSame: 0, dataChars: 100 }, timing: { clientThreadMicros: 300, encodeMicros: 9000, totalMicros: 9600 },
  };
}
/** Answers `same` for revisions the request lists in `have`, as Synapse does. */
const honouringHave = (data: ReturnType<typeof chunks>) => (url: URL) => {
  const have = new Set((url.searchParams.get("have") ?? "").split(","));
  return { ...data, chunks: data.chunks.map(c => ({ ...c, sections: c.sections.map(s => have.has(s.rev) ? { y: s.y, rev: s.rev, same: true } : s) })) };
};

describe("Synapse /chunks replies are validated before anything keeps them", () => {
  test("a well-formed reply is flattened to sections with their columns", () => {
    const view = fromSynapse(chunks({ ores: [5], missing: true }))!;
    expect(view).toMatchObject({ dimension: "overworld", origin: [8, 70, 8], minY: 48, maxY: 95, skyLight: 0, missing: [[1, 1]] });
    expect(view.chunks).toHaveLength(8);
    expect(view.sections).toHaveLength(24);
    expect(view.sections.find(s => s.x === 0 && s.z === 0 && s.y === 4)).toMatchObject({ bits: 1, palette: ["minecraft:stone", "minecraft:diamond_ore"] });
    expect(view.players.map(p => p.name)).toEqual(["Wren", "spesk01"]);
  });

  test("bits that do not fit the palette, data of the wrong length, odd ids and oversized windows are refused", () => {
    const tamper = (change: (data: ReturnType<typeof chunks>) => void) => { const data = chunks({ ores: [5] }); change(data); return fromSynapse(data); };
    const centre = (data: ReturnType<typeof chunks>) => data.chunks[4].sections[1] as Record<string, unknown>;
    expect(tamper(d => { centre(d).bits = 2; })).toBeUndefined();
    expect(tamper(d => { centre(d).data = deflateSync(new Uint8Array(100)).toString("base64"); })).toBeUndefined();
    expect(tamper(d => { centre(d).data = "not base64!"; })).toBeUndefined();
    expect(tamper(d => { centre(d).palette = ["minecraft:stone", "<script>"]; })).toBeUndefined();
    expect(tamper(d => { centre(d).rev = "xyz"; })).toBeUndefined();
    expect(tamper(d => { (d.chunks[0].sections as unknown[]).push(...Array(5).fill(section(0, 6, 0))); })).toBeUndefined();
    expect(tamper(d => { d.radius = 5; })).toBeUndefined();
    expect(tamper(d => { d.players.push({ name: "a b", x: 0, y: 0, z: 0 }); })).toBeUndefined();
    // A uniform section must not carry data.
    expect(tamper(d => { (d.chunks[0].sections[0] as Record<string, unknown>).data = "AAAA"; })).toBeUndefined();
  });
});

describe("the per-resident cache reads the client only when asked, at most every ten seconds", () => {
  const resident = { name: "Wren" } as ResidentConfig;
  function cache(answer: () => unknown) {
    const asked: string[] = [];
    let now = clock;
    const reader = new DioramaCache(() => now, async (_, path) => {
      asked.push(path);
      const value = answer();
      return value === "offline" ? { ok: false, status: "offline", detail: "The client is not running." } : { ok: true, data: value };
    });
    return { reader, asked, advance: (ms: number) => { now += ms; } };
  }

  test("nothing is read until a dashboard asks; viewers within ten seconds share one read", async () => {
    const data = chunks({ ores: [5] });
    const { reader, asked, advance } = cache(() => honouringHave(data)(new URL(`http://x${asked.at(-1)}`)));
    expect(asked).toEqual([]);
    const [a, b] = await Promise.all([reader.read(resident, new Set()), reader.read(resident, new Set())]);
    expect(asked).toEqual(["/chunks?radius=1&below=16&above=16"]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: "ok", asOf: clock, checkedAt: clock, timing: { clientThreadMicros: 300 } });
    advance(MIN_REFRESH_MS - 1);
    await reader.read(resident, new Set());
    expect(asked).toHaveLength(1);
    // The next read lists what this host holds; the client answers `same`, and the host fills them in.
    advance(1);
    const again = await reader.read(resident, new Set());
    expect(new URLSearchParams(asked[1].split("?")[1]).get("have")!.split(",")).toHaveLength(27);
    expect(again.view!.sections.every(s => "palette" in s)).toBe(true);
    expect(again.view!.sections).toEqual(a.view!.sections);
  });

  test("a browser's own `have` turns those sections into `same`; the rest come whole", async () => {
    const { reader } = cache(() => chunks({ ores: [5] }));
    const first = await reader.read(resident, new Set());
    const held = new Set(first.view!.sections.slice(0, 20).map(s => s.rev));
    const second = await reader.read(resident, held);
    expect(second.view!.sections.filter(s => "same" in s)).toHaveLength(20);
    expect(second.view!.sections.slice(20).every(s => "palette" in s)).toBe(true);
  });

  test("an offline client keeps the last view with its own time; garbage is an error, not data", async () => {
    let answer: unknown = chunks();
    const { reader, advance } = cache(() => answer);
    await reader.read(resident, new Set());
    answer = "offline"; advance(MIN_REFRESH_MS);
    const offline = await reader.read(resident, new Set());
    expect(offline).toMatchObject({ status: "offline", asOf: clock, checkedAt: clock + MIN_REFRESH_MS });
    expect(offline.view?.sections).toHaveLength(27);
    answer = { nonsense: true }; advance(MIN_REFRESH_MS);
    const broken = await reader.read(resident, new Set());
    expect(broken.status).toBe("error");
    expect(broken.view?.origin).toEqual([8, 70, 8]);
  });
});

// ---------- through the app and the hub ----------
function home(): Home { const value = tempHome(); cleanups.push(() => value.remove()); return value; }
function appAt(root: Home, env: Record<string, string> = {}): App {
  const app = createApp(root.config(env), TOKEN, () => clock, () => {});
  cleanups.push(() => app.stop()); return app;
}
const request = (app: App, path: string) => app.fetch(new Request(`http://fixture/${TOKEN}/api/${path}`));

function station(mode: { value: "new" | "old" | "garbage" }) {
  const fake = fakeSynapse({ token: "s3cret" });
  cleanups.push(() => fake.stop());
  fake.chunks = honouringHave(chunks({ ores: [5, 4095] }));
  const root = home();
  root.put("synapse-token", "s3cret\n");
  root.put("instances/Wren.env", `SYNAPSE_URL=${fake.url}\n`);
  root.put("resident/wren/memory.md", "# Wren\n");
  const app = appAt(root, { COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    // An older station has no diorama route at all; a confused one answers some other shape.
    if (url.pathname.endsWith("/diorama") && mode.value === "old") return Response.json({ error: "Not found." }, { status: 404 });
    if (url.pathname.endsWith("/diorama") && mode.value === "garbage") return Response.json({ resident: "Wren", status: "ok", asOf: 1, checkedAt: 1, view: { sections: "lots" } });
    return app.fetch(req);
  } });
  cleanups.push(() => server.stop(true));
  return { fake, app, url: `http://127.0.0.1:${server.port}/${TOKEN}/` };
}

test("a station serves its own resident's diorama, and the hub shows it with the station named", async () => {
  const mode = { value: "new" as "new" | "old" | "garbage" };
  const remote = station(mode);
  const direct = await (await request(remote.app, "diorama?resident=Wren")).json() as DioramaReply;
  expect(direct).toMatchObject({ resident: "Wren", host: "chungus1", status: "ok" });
  expect(direct.view!.players.find(p => p.self)?.name).toBe("Wren");
  expect((await request(remote.app, "diorama?resident=Nobody")).status).toBe(404);

  const localHome = home();
  const stations = localHome.put("commons-data/stations.json", JSON.stringify([{ host: "chungus1", url: remote.url }]));
  chmodSync(stations, 0o600);
  const local = appAt(localHome, { COMMONS_HOST_NAME: "inspiron", COMMONS_STATIONS_FILE: join(localHome.dir, "none.json") });
  const federation = new Federation(localHome.config({ COMMONS_HOST_NAME: "inspiron" }), () => clock, { ttlMs: 0 });
  cleanups.push(() => federation.stop());
  const localRoutes: Routes = {};
  for (const route of ["residents", "diorama"]) localRoutes[`GET ${route}`] = async ask => {
    const response = await request(local, `${route}?${ask.query}`);
    return response.ok ? response.json() : response;
  };
  const routes = federation.wrap(localRoutes);
  const get = async (query: string) => {
    const answer = await routes["GET diorama"]({ query: new URLSearchParams(query), body: async () => ({}) });
    return answer instanceof Response ? answer : answer as DioramaReply;
  };
  await federation.refresh();
  const reply = await get("resident=Wren") as DioramaReply;
  expect(reply).toMatchObject({ resident: "Wren", host: "chungus1", status: "ok" });
  expect(reply.view!.sections.find(s => s.x === 0 && s.z === 0 && s.y === 4)).toMatchObject({ bits: 1 });
  // The browser's `have` is carried to the station.
  const held = reply.view!.sections.map(s => s.rev).join(",");
  const second = await get(`resident=Wren&have=${held}`) as DioramaReply;
  expect(second.view!.sections.every(s => "same" in s)).toBe(true);

  mode.value = "old";
  clock += 6000;
  expect(await get("resident=Wren")).toMatchObject({ status: "unavailable", host: "chungus1", view: null, detail: expect.stringContaining("older Commons") });
  mode.value = "garbage";
  clock += 6000;
  expect(await get("resident=Wren")).toMatchObject({ status: "unavailable", view: null, detail: expect.stringContaining("cannot read") });
});

test("a station's own reply passes the hub's shape check; a mangled one does not", async () => {
  const remote = station({ value: "new" });
  const reply = await (await request(remote.app, "diorama?resident=Wren")).json();
  const { host: _host, ...rest } = reply;
  expect(validReply(reply)).toEqual(rest);
  expect(validReply({ ...reply, status: "great" })).toBeUndefined();
  expect(validReply({ ...reply, view: { ...reply.view, sections: reply.view.sections.map((s: Record<string, unknown>) => ({ ...s, x: 40 })) } })).toBeUndefined();
});
