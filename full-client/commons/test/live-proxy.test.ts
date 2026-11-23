import { afterEach, expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Federation } from "../src/federation.ts";
import { LiveRouter } from "../src/live-proxy.ts";
import { LiveStream, type EncoderProcess } from "../src/live-stream.ts";
import type { OverlaySnapshot } from "../src/overlay.ts";
import type { ResidentsReply } from "../src/routes/residents.ts";
import { tempHome, type Home } from "./helpers.ts";

// A fake station: its residents reply and overlay sources are fixtures, but its Live
// API is a real LiveStream (fixture Synapse/MediaMTX fetch and encoder spawn), so
// leases, generations and last-viewer teardown are the station's own.
const HUB = "hub-dashboard-token", STATION = "station-secret-token";
const ANSWER = "v=0\r\no=- 1 1 IN IP4 192.168.1.120\r\ns=-\r\na=candidate:1 1 UDP 2122260223 192.168.1.120 8189 typ host\r\n";
const OFFER = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\n";
let clock = 1_790_000_000_000;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function home(): Home { const value = tempHome(); cleanups.push(() => value.remove()); return value; }

function fakeLive(config: Config): LiveStream {
  return new LiveStream(config, {
    now: () => clock,
    async fetch(url, init) {
      const method = init?.method ?? "GET";
      if (url.endsWith("/video/info")) return Response.json({ ok: true, data: { protocol: 1, width: 4, height: 2, fps: 15, pixelFormat: "bgra", origin: "bottom-left", available: true } });
      if (url.includes("/video/raw?")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32)); } }), { headers: {
        "Content-Type": "application/octet-stream", "X-Video-Protocol": "1", "X-Video-Width": "4", "X-Video-Height": "2",
        "X-Video-Fps": "15", "X-Video-Pixel-Format": "bgra", "X-Video-Origin": "bottom-left",
      } });
      if (method === "POST") return new Response(ANSWER, { status: 201, headers: { "Content-Type": "application/sdp", Location: "/resident/whep/fixture-session" } });
      if (method === "DELETE") return new Response(null, { status: 200 });
      throw new Error("Unexpected fixture request");
    },
    spawn() {
      let finish!: (code: number) => void;
      const exited = new Promise<number | null>(resolve => { finish = resolve; });
      const progress = new PassThrough(), errors = new PassThrough();
      const input = new Writable({ write(_bytes, _encoding, callback) { progress.write("frame=1\nprogress=continue\n"); callback(); } });
      const encoder: EncoderProcess = { input, progress, errors, exited, kill: () => finish(0) };
      return encoder;
    },
  });
}

interface Options { live?: boolean; sources?: Record<string, unknown> }
function setup({ live = true, sources = {} }: Options = {}) {
  const stationHome = home();
  rmSync(join(stationHome.dir, "resident/gary"), { recursive: true });
  for (const name of ["Wren", "Tobin"]) {
    stationHome.put(`instances/${name}.env`, "SYNAPSE_URL=http://127.0.0.1:9\n");
    stationHome.put(`resident/${name.toLowerCase()}/memory.md`, `# ${name}\n`);
  }
  const stationConfig = stationHome.config({ COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1", COMMONS_LIVE_ENABLED: "true", COMMONS_LIVE_ENCODER: "libx264", SYNAPSE_TOKEN_FILE: stationHome.put("synapse-token", "station-synapse-secret\n") });
  const stationLive = fakeLive(stationConfig);
  cleanups.push(() => stationLive.shutdown());
  const seen: { path: string; origin: string | null; site: string | null }[] = [];
  // Resolves once `count` requests whose path ends with `suffix` have reached the station.
  const waiters: { suffix: string; count: number; resolve(): void }[] = [];
  const arrived = (suffix: string, count: number) => new Promise<void>(resolve => { waiters.push({ suffix, count, resolve }); notify(); });
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (seen.filter(entry => entry.path.endsWith(waiter.suffix)).length < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  let mode: "ok" | "hang" = "ok";
  const resident = (name: string, x: number, z: number) => ({
    name, host: "chungus1", liveAvailable: live, audioAvailable: false, hostUnreachable: false, hostLastSeen: clock,
    status: "online", checkedAt: clock, lastOnlineAt: clock, state: { pos: { x, y: 64, z }, dimension: "overworld", nearby: { players: [], hostiles: 0, others: 0 } },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname + url.search, origin: request.headers.get("origin"), site: request.headers.get("sec-fetch-site") });
    notify();
    if (mode === "hang") return new Promise<Response>(() => {});
    const prefix = `/${STATION}/api/`;
    if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
    const route = url.pathname.slice(prefix.length);
    if (route === "residents") return Response.json({ role: "station", residents: [resident("Wren", 10, 10), resident("Tobin", 13, 14)] });
    if (route.startsWith("live/")) return stationLive.handle(request, route.slice(5));
    if (route === "overlay/source") {
      const source = sources[url.searchParams.get("resident") ?? ""];
      return source ? Response.json(source) : Response.json({ error: "No resident by that name." }, { status: 404 });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  const hubHome = home();
  chmodSync(hubHome.put("commons-data/stations.json", JSON.stringify([{ host: "chungus1", url: `http://127.0.0.1:${server.port}/${STATION}/` }])), 0o600);
  const hubConfig = hubHome.config({ COMMONS_HOST_NAME: "inspiron", COMMONS_LIVE_ENABLED: "true", COMMONS_LIVE_ENCODER: "h264_nvenc" });
  const hub: App = createApp(hubConfig, HUB, () => clock, () => {});
  cleanups.push(() => hub.stop());
  const get = (path: string) => hub.fetch(new Request(`http://hub.test/${HUB}/api/${path}`));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => hub.fetch(new Request(`http://hub.test/${HUB}/api/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  const liveSeen = () => seen.filter(entry => entry.path.includes("/api/live/"));
  return { hub, hubConfig, get, post, server, seen, arrived, liveSeen, stationLive, port: String(server.port), hang: () => { mode = "hang"; } };
}

/** Every reply the browser sees must be free of the station's secret URL. */
function expectPrivate(text: string, port: string) {
  for (const secret of [STATION, `127.0.0.1:${port}`, `:${port}/`]) expect(text).not.toContain(secret);
}

test("hub proxies status, watch, offer, heartbeat and stop to the owning station; local Live stays separate", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  const residents = await (await s.get("residents")).json() as ResidentsReply;
  expect(residents.residents.map(r => [r.name, r.host, r.liveAvailable, r.audioAvailable])).toEqual([
    ["Gary", "inspiron", true, false], ["Wren", "chungus1", true, false], ["Tobin", "chungus1", true, false],
  ]);
  const idle = await (await s.get("live/status?resident=Wren")).json();
  expect(idle).toMatchObject({ enabled: true, state: "idle", host: "chungus1", viewers: 0 });

  const watchReply = await s.post("live/watch", { resident: "Wren" });
  const watchText = await watchReply.text();
  expect(watchReply.status).toBe(200);
  expectPrivate(watchText, s.port);
  const watched = JSON.parse(watchText);
  expect(watched).toMatchObject({ enabled: true, state: "live", resident: "Wren", viewers: 1, host: "chungus1", heartbeatMs: 10_000, expiresInMs: 30_000 });
  expect(Object.keys(watched).sort()).toEqual(["audio", "detail", "enabled", "expiresInMs", "generation", "heartbeatMs", "host", "lease", "resident", "resuming", "state", "videoOnly", "viewers"]);
  expect(s.stationLive.status()).toMatchObject({ state: "live", viewers: 1, generation: watched.generation });

  // Hub-local Live is a different channel on a different host.
  expect(await (await s.get("live/status?resident=Gary")).json()).toMatchObject({ state: "idle", host: "inspiron", viewers: 0 });
  expect(await (await s.get("live/status")).json()).toMatchObject({ state: "idle", host: "inspiron" });

  const lease = { lease: watched.lease, generation: watched.generation, resident: "Wren" };
  const offer = await s.post("live/offer", { ...lease, sdp: OFFER });
  expect(offer.status).toBe(200);
  // The station's media candidates are the one station detail the browser needs.
  expect(await offer.json()).toEqual({ sdp: ANSWER });
  expect(await (await s.post("live/heartbeat", lease)).json()).toMatchObject({ state: "live", resident: "Wren", generation: watched.generation, host: "chungus1" });
  expect(await (await s.get("live/status?resident=Wren")).json()).toMatchObject({ state: "live", viewers: 1, resident: "Wren" });

  const stopped = await (await s.post("live/stop", lease)).json();
  expect(stopped).toMatchObject({ state: "idle", viewers: 0, host: "chungus1" });
  expect(s.stationLive.status()).toMatchObject({ state: "idle", viewers: 0 });

  // Server-side calls use only the station's secret URL and carry no browser origin.
  expect(s.liveSeen().length).toBeGreaterThanOrEqual(6);
  expect(s.liveSeen().every(entry => entry.path.startsWith(`/${STATION}/api/live/`) && entry.origin === null && entry.site === null)).toBe(true);
});

test("generation and lease fencing hold through the proxy; a lease never reaches another host's channel", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  const wren = await (await s.post("live/watch", { resident: "Wren" })).json();
  const wrong = await s.post("live/heartbeat", { lease: wren.lease, generation: wren.generation + 5, resident: "Wren" });
  expect(wrong.status).toBe(409);
  expect((await wrong.json()).error).toStartWith("chungus1: ");
  // Same lease without a resident is routed to this hub's own channel, which never issued it.
  expect((await s.post("live/heartbeat", { lease: wren.lease, generation: wren.generation })).status).toBe(409);
  // Switching the station's channel to Tobin fences Wren's lease.
  const tobin = await (await s.post("live/watch", { resident: "Tobin" })).json();
  expect(tobin.generation).toBeGreaterThan(wren.generation);
  expect((await s.post("live/heartbeat", { lease: wren.lease, generation: wren.generation, resident: "Wren" })).status).toBe(409);
  expect((await s.post("live/offer", { lease: wren.lease, generation: wren.generation, resident: "Wren", sdp: OFFER })).status).toBe(409);
  expect(await (await s.get("live/status?resident=Wren")).json()).toMatchObject({ resident: "Tobin", generation: tobin.generation, viewers: 1 });
  expect(await (await s.post("live/stop", { lease: tobin.lease, generation: tobin.generation, resident: "Tobin" })).json()).toMatchObject({ state: "idle", viewers: 0 });
});

test("the hub enforces origin, JSON and body limits before contacting a station", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  expect((await s.post("live/watch", { resident: "Wren" }, { Origin: "http://elsewhere.test" })).status).toBe(403);
  expect((await s.post("live/watch", { resident: "Wren" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  const plain = await s.hub.fetch(new Request(`http://hub.test/${HUB}/api/live/watch`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"resident":"Wren"}' }));
  expect(plain.status).toBe(415);
  const huge = await s.post("live/offer", { lease: "x", generation: 1, resident: "Wren", sdp: `v=0${"a".repeat(65_536 * 7)}` });
  expect(huge.status).toBe(413);
  expect((await s.post("live/offer", { lease: "x", generation: 1, resident: "Wren", sdp: `v=0${"a".repeat(65_540)}` })).status).toBe(400);
  expect((await s.post("live/heartbeat", { lease: 7, generation: 1, resident: "Wren" })).status).toBe(400);
  expect(s.liveSeen()).toEqual([]);
});

test("Live disabled on a station is a clear per-resident reason and never contacts its Live API", async () => {
  const s = setup({ live: false });
  await s.hub.federation!.refresh();
  const residents = await (await s.get("residents")).json() as ResidentsReply;
  expect(residents.residents.find(r => r.name === "Wren")).toMatchObject({ liveAvailable: false, audioAvailable: false, hostUnreachable: false });
  expect(residents.residents.find(r => r.name === "Gary")).toMatchObject({ liveAvailable: true });
  expect(await (await s.get("live/status?resident=Wren")).json()).toMatchObject({ enabled: false, state: "disabled", host: "chungus1", detail: "Live video is disabled on host chungus1." });
  const watch = await s.post("live/watch", { resident: "Wren" });
  expect(watch.status).toBe(503);
  expect((await watch.json()).error).toBe("Live video is disabled on host chungus1; Wren cannot be watched.");
  expect(s.liveSeen()).toEqual([]);
  expect((await s.get("live/status?resident=Gary")).status).toBe(200);
});

test("an unreachable station fails its residents' Live quickly and leaves hub-local Live working", async () => {
  const s = setup();
  await s.hub.federation!.refresh();
  const wren = await (await s.post("live/watch", { resident: "Wren" })).json();
  s.server.stop(true);
  clock += 6000;
  await s.hub.federation!.refresh();
  const residents = await (await s.get("residents")).json() as ResidentsReply;
  expect(residents.residents.find(r => r.name === "Wren")).toMatchObject({ hostUnreachable: true, liveAvailable: false });
  const status = await s.get("live/status?resident=Wren");
  expect(status.status).toBe(502);
  expect((await status.json()).error).toBe("chungus1: host unreachable; Live status is unavailable.");
  const watch = await s.post("live/watch", { resident: "Tobin" });
  expect(watch.status).toBe(502);
  expect((await watch.json()).error).toContain("chungus1: host unreachable");
  // Lease requests are still attempted (the flag may be stale) and fail as transport errors.
  const heartbeat = await s.post("live/heartbeat", { lease: wren.lease, generation: wren.generation, resident: "Wren" });
  expect(heartbeat.status).toBe(502);
  expectPrivate(await heartbeat.text(), s.port);
  expect(await (await s.get("live/status?resident=Gary")).json()).toMatchObject({ enabled: true, state: "idle", host: "inspiron" });
});

test("a stalled station times out boundedly, caps pending calls, and never delays local status", async () => {
  const s = setup();
  const federation = new Federation(s.hubConfig, () => clock);
  cleanups.push(() => federation.stop());
  await federation.refresh();
  s.hang();
  // Real (short) proxy deadlines: the abort travels through an actual HTTP fetch to a stalled server.
  const router = new LiveRouter(new LiveStream(s.hubConfig), "inspiron", federation, { timeouts: { status: 200, heartbeat: 2000 } });
  cleanups.push(() => router.stop());
  const ask = (path: string, body?: unknown) => router.handle(new Request(`http://hub.test/${HUB}/api/live/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), path.split("?")[0]);
  let settled = false;
  const remote = ask("status?resident=Wren").then(response => { settled = true; return response; });
  const local = await ask("status?resident=Gary");
  expect(local.status).toBe(200);
  expect(settled).toBe(false);
  // Concurrent status reads share one station request.
  const joined = ask("status?resident=Wren");
  const [first, second] = await Promise.all([remote, joined]);
  expect([first.status, second.status]).toEqual([504, 504]);
  expect((await first.json()).error).toBe("chungus1: Live signaling timed out.");
  expect(s.seen.filter(entry => entry.path.endsWith("/api/live/status"))).toHaveLength(1);
  const beats = Array.from({ length: 12 }, () => ask("heartbeat", { lease: "l", generation: 1, resident: "Wren" }));
  // All twelve are in flight at the station before the thirteenth is asked.
  await s.arrived("/api/live/heartbeat", 12);
  const extra = await ask("heartbeat", { lease: "l", generation: 1, resident: "Wren" });
  expect(extra.status).toBe(429);
  expect((await Promise.all(beats)).map(response => response.status)).toEqual(Array(12).fill(504));
});

test("station status details and errors carrying addresses, ports or tokens are replaced, never relayed", async () => {
  const s = setup();
  const federation = new Federation(s.hubConfig, () => clock);
  cleanups.push(() => federation.stop());
  await federation.refresh();
  let next = "";
  // A station (old, buggy or compromised) that puts private values into its free text.
  const router = new LiveRouter(new LiveStream(s.hubConfig), "inspiron", federation, { fetch: async url => url.endsWith("/status")
    ? Response.json({ enabled: true, state: "idle", resident: null, generation: 0, viewers: 0, detail: next, videoOnly: true, audio: false })
    : Response.json({ error: next }, { status: 409 }) });
  cleanups.push(() => router.stop());
  const status = () => router.handle(new Request(`http://hub.test/${HUB}/api/live/status?resident=Wren`), "status");
  const heartbeat = () => router.handle(new Request(`http://hub.test/${HUB}/api/live/heartbeat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lease: "l", generation: 1, resident: "Wren" }),
  }), "heartbeat");
  for (const leak of [
    "Publishing to 192.168.1.120 now.", "Relay at chungus-box:8554 refused.", "Ask fe80::1234 for help.", "See http://example.invalid/x",
    `Token ${STATION} rejected.`, `Port ${s.port} closed.`, "Bearer abcdefghijklmnopqrstuvwxyz012345 refused.", "Line\nbreak",
  ]) {
    next = leak;
    expect(await (await status()).json()).toMatchObject({ detail: "", host: "chungus1" });
    const refused = await heartbeat();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "chungus1: Live request failed." });
  }
  // The station's ordinary fixed sentences still reach the viewer.
  next = "The lease expired or the shared channel changed. Press Watch again.";
  expect(await (await status()).json()).toMatchObject({ detail: next });
  expect(await (await heartbeat()).json()).toEqual({ error: `chungus1: ${next}` });
});

test("the overlay can put a station resident on air with the hub's privacy projection and honest staleness", async () => {
  const source = (resident: string, extra: Record<string, unknown> = {}) => ({
    resident, online: true, sampledAt: clock - 1000,
    vitals: { health: 18, maxHealth: 20, food: 17, air: 300 },
    position: { x: 10, y: 64, z: 10, dimension: "minecraft:overworld" },
    plan: { focus: "Visit Levi", next: "Carry bread" },
    nearby: [{ name: "spesk01", distance: 4 }, { name: "Tobin", distance: null }],
    places: [{ name: "Bakery", x: 12, z: 9, dimension: "overworld" }, { name: "Nether hub", x: 1, z: 1, dimension: "the_nether" }],
    trail: [{ x: 9, z: 9, dimension: "overworld" }, { x: 2, z: 2, dimension: "the_nether" }],
    caretaker: "Ask chungus1 for bread", ...extra,
  });
  const s = setup({ sources: { Wren: source("Wren"), Tobin: source("Tobin", { synapseUrl: "http://127.0.0.1:25599" }) } });
  await s.hub.federation!.refresh();
  const choose = async (resident: string) => {
    const current = await (await s.get("overlay")).json() as OverlaySnapshot;
    const reply = await s.post("overlay", { revision: current.state.revision, state: { ...current.state, resident } });
    expect(reply.status).toBe(200);
    await s.get("overlay");
    await s.hub.federation!.refresh();
    return await (await s.get("overlay")).json() as OverlaySnapshot;
  };
  const initial = await (await s.get("overlay")).json() as OverlaySnapshot;
  expect(initial.residents).toEqual([{ name: "Gary", liveAvailable: true }, { name: "Wren", liveAvailable: true }, { name: "Tobin", liveAvailable: true }]);
  expect((await s.post("overlay", { revision: initial.state.revision, state: { ...initial.state, resident: "Nobody" } })).status).toBe(400);

  const wren = await choose("wren");
  expect(wren.state.resident).toBe("Wren");
  expect(wren.data).toMatchObject({
    resident: "Wren", online: true, sampledAt: clock - 1000, vitals: { health: 18, maxHealth: 20, food: 17, air: 300 },
    position: { x: 10, y: 64, z: 10, dimension: "minecraft:overworld" }, plan: { focus: "Visit [hidden]", next: "Carry bread" },
    // Hidden names are dropped; the hub fills Tobin's distance from the station roster (3-4-5).
    nearby: [{ name: "Tobin", distance: 5 }], map: { points: [{ name: "Bakery", x: 12, z: 9 }], trail: [{ x: 9, z: 9 }] },
    caretaker: "[private]",
  });
  const text = JSON.stringify(wren);
  expectPrivate(text, s.port);
  expect(text).not.toContain("chungus1");
  expect(text).not.toContain("station-synapse-secret");
  // The hide list itself is part of the saved state; the on-air data never contains hidden names.
  for (const denied of ["spesk01", "Levi", "Nether"]) expect(JSON.stringify(wren.data)).not.toContain(denied);

  // A source with any field outside the projection is refused, never partially used.
  const tobin = await choose("Tobin");
  expect(tobin.data).toMatchObject({ resident: "Tobin", online: false, vitals: null, position: null, nearby: [] });
  expect(JSON.stringify(tobin)).not.toContain("25599");

  // Unreachable: the last good sample stays with its own time but is never "online".
  await choose("Wren");
  s.server.stop(true);
  clock += 6000;
  await s.hub.federation!.refresh();
  const stale = await (await s.get("overlay")).json() as OverlaySnapshot;
  expect(stale.data).toMatchObject({ resident: "Wren", online: false, sampledAt: clock - 7000, vitals: { health: 18 } });
  expect(stale.residents.find(r => r.name === "Wren")).toEqual({ name: "Wren", liveAvailable: false, detail: "Its host is unreachable." });
});

test("a station serves its residents' overlay source filtered with its own secrets", async () => {
  const root = home();
  rmSync(join(root.dir, "resident/gary"), { recursive: true });
  root.put("instances/Wren.env", "SYNAPSE_URL=http://127.0.0.1:9\n");
  root.put("resident/wren/plan.json", JSON.stringify({ focus: "Bread for chungus1", plans: [{ name: "Bread for chungus1", steps: [{ text: "Ask Levi", state: "doing" }] }] }));
  root.put("resident/wren/places.json", JSON.stringify({ places: [{ name: "Oven", x: 3, y: 64, z: 4, dimension: "overworld", note: "PRIVATE" }] }));
  root.put("overseer/Wren.md", "## now\nNOTE: Keep baking\nMAINTAINERS: PRIVATE\n");
  const station = createApp(root.config({ COMMONS_ROLE: "station", COMMONS_HOST_NAME: "chungus1" }), STATION, () => clock, () => {});
  cleanups.push(() => station.stop());
  const reply = await station.fetch(new Request(`http://station.test/${STATION}/api/overlay/source?resident=wren`));
  expect(reply.status).toBe(200);
  const body = await reply.json();
  // Station secrets are applied here; the hide list is the hub's job.
  expect(body).toEqual({ resident: "Wren", online: false, sampledAt: null, vitals: null, position: null,
    plan: { focus: "[private]", next: "Ask Levi" }, nearby: [], places: [{ name: "Oven", x: 3, z: 4, dimension: "overworld" }], trail: [], caretaker: "Keep baking" });
  expect((await station.fetch(new Request(`http://station.test/${STATION}/api/overlay/source?resident=Gary`))).status).toBe(404);
  expect((await station.fetch(new Request(`http://station.test/wrong-token/api/overlay/source?resident=Wren`))).status).toBe(404);
});
