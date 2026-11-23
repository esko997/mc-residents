import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createApp } from "../src/app.ts";
import { LiveStream, type EncoderProcess } from "../src/live-stream.ts";
import { tempHome } from "./helpers.ts";

// These fixtures do not start FFmpeg, MediaMTX, a server or a resident.
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(ignoreTerm = false) {
  const home = tempHome();
  const config = home.config({ COMMONS_LIVE_ENABLED: "true", SYNAPSE_TOKEN_FILE: home.put("video-token", "fixture-private-token\n") });
  config.residents.push({ ...config.residents[0], name: "Margo", synapseUrl: "http://127.0.0.1:10" });
  let now = 1000, cancelled = 0, active = 0, peak = 0;
  const requests: { url: string; method: string }[] = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const children: { encoder: EncoderProcess; exit: (code: number) => void; kills: string[]; writes: number[] }[] = [];
  const commands: string[][] = [];
  let intercept: ((url: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  const stream = new LiveStream(config, {
    now: () => now,
    async fetch(url, init) {
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      const intercepted = intercept?.(url, init);
      if (intercepted) return intercepted;
      if (url.includes("/video/")) expect(new Headers(init?.headers).get("X-Synapse-Token")).toBe("fixture-private-token");
      if (url.endsWith("/video/info")) return Response.json({ ok: true, data: {
        protocol: 1, width: 4, height: 2, fps: 15, pixelFormat: "bgra", origin: "bottom-left", available: true,
      } });
      if (url.includes("/video/raw?")) return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controllers.push(controller); controller.enqueue(new Uint8Array(32)); },
        cancel() { cancelled++; },
      }), { headers: {
        "Content-Type": "application/octet-stream", "X-Video-Protocol": "1", "X-Video-Width": "4", "X-Video-Height": "2",
        "X-Video-Fps": "15", "X-Video-Pixel-Format": "bgra", "X-Video-Origin": "bottom-left",
      } });
      if (method === "POST") return new Response("v=0\r\ns=fixture\r\n", { status: 201, headers: {
        "Content-Type": "application/sdp", Location: "/resident/whep/fixture-session",
      } });
      if (method === "DELETE") return new Response(null, { status: 200 });
      throw new Error("Unexpected fixture request");
    },
    spawn(_executable, args) {
      commands.push(args);
      active++; peak = Math.max(peak, active);
      const done = gate<number | null>(), progress = new PassThrough(), errors = new PassThrough();
      const kills: string[] = [], writes: number[] = [];
      let ended = false;
      const exit = (code: number) => { if (!ended) { ended = true; active--; done.resolve(code); } };
      const input = new Writable({ write(bytes, _encoding, callback) {
        writes.push(bytes.byteLength);
        progress.write("frame=1\nout_time_us=66667\nprogress=continue\n");
        callback();
      } });
      const encoder: EncoderProcess = { input, progress, errors, exited: done.promise,
        kill(signal) { kills.push(signal); if (signal === "SIGKILL" || !ignoreTerm) exit(0); },
      };
      children.push({ encoder, exit, kills, writes });
      return encoder;
    },
  });
  return {
    home, config, stream, requests, controllers, children, commands,
    intercept(value: typeof intercept) { intercept = value; },
    advance(ms: number) { now += ms; },
    counts() { return { cancelled, active, peak }; },
    async close() { await stream.shutdown(); home.remove(); },
  };
}

test("idle is capture-free; simultaneous viewers share startup and only the last stop tears down", async () => {
  const f = fixture();
  try {
    expect(f.stream.status().state).toBe("idle");
    expect(f.requests).toEqual([]);
    const [a, b] = await Promise.all([f.stream.watch("Gary"), f.stream.watch("gary")]);
    expect(a.generation).toBe(b.generation);
    expect(a.lease).not.toBe(b.lease);
    expect(f.children).toHaveLength(1);
    expect(f.requests.filter(item => item.url.includes("/video/raw?"))).toHaveLength(1);
    expect((await f.stream.stop(a.lease, a.generation)).viewers).toBe(1);
    expect(f.counts().cancelled).toBe(0);
    expect((await f.stream.stop(b.lease, b.generation)).state).toBe("idle");
    expect(f.counts()).toEqual({ active: 0, peak: 1, cancelled: 1 });
    expect(f.commands[0].join(" ")).not.toContain("fixture-private-token");
  } finally { await f.close(); }
});

test("a new channel fully stops the old publisher and old leases cannot stop or heartbeat it", async () => {
  const f = fixture();
  try {
    const a = await f.stream.watch("Gary"), b = await f.stream.watch("Margo");
    expect(b.generation).toBeGreaterThan(a.generation);
    expect(f.children[0].kills).toEqual(["SIGTERM"]);
    expect(f.counts().peak).toBe(1);
    expect((await f.stream.stop(a.lease, a.generation)).resident).toBe("Margo");
    expect(f.stream.status().viewers).toBe(1);
    expect(() => f.stream.heartbeat(a.lease, a.generation)).toThrow("lease expired");
    expect(f.stream.heartbeat(b.lease, b.generation).state).toBe("live");
  } finally { await f.close(); }
});

test("switching during a pending source request fences its late result without spawning the old encoder", async () => {
  const f = fixture(), entered = gate<void>(), metadata = gate<Response>();
  f.intercept(url => {
    if (url === "http://127.0.0.1:9/video/info") { entered.resolve(); return metadata.promise; }
  });
  try {
    const old = f.stream.watch("Gary");
    const rejected = old.then(() => null, error => error);
    await entered.promise;
    const next = f.stream.watch("Margo");
    metadata.resolve(Response.json({ ok: true, data: {} }));
    expect((await rejected)?.message).toContain("channel changed");
    expect((await next).resident).toBe("Margo");
    expect(f.children).toHaveLength(1);
    expect(f.requests.some(item => item.url.startsWith("http://127.0.0.1:9/video/raw"))).toBe(false);
  } finally { await f.close(); }
});

test("lease expiry stops capture without heartbeat traffic; expired leases cannot revive it", async () => {
  const f = fixture();
  try {
    const a = await f.stream.watch("Gary");
    f.advance(29_000);
    expect(f.stream.heartbeat(a.lease, a.generation).state).toBe("live");
    f.advance(30_001);
    expect(f.stream.status()).toMatchObject({ state: "idle", viewers: 0, resident: null });
    expect(() => f.stream.heartbeat(a.lease, a.generation)).toThrow("lease expired");
    await f.stream.shutdown();
    expect(f.counts().active).toBe(0);
    expect(f.counts().cancelled).toBe(1);
  } finally { await f.close(); }
});

test("a cancelled watch does not wait for or stop another viewer's shared startup", async () => {
  const f = fixture(), entered = gate<void>(), metadata = gate<Response>(), abort = new AbortController();
  f.intercept(url => {
    if (url.endsWith("/video/info")) { entered.resolve(); return metadata.promise; }
  });
  try {
    const abandoned = f.stream.watch("Gary", abort.signal);
    const rejected = abandoned.then(() => null, error => error);
    await entered.promise;
    const retained = f.stream.watch("Gary");
    abort.abort();
    expect((await rejected)?.message).toContain("channel changed"); // Before the retained metadata resolves.
    metadata.resolve(Response.json({ ok: true, data: {
      protocol: 1, width: 4, height: 2, fps: 15, pixelFormat: "bgra", origin: "bottom-left", available: true,
    } }));
    expect((await retained).viewers).toBe(1);
    expect(f.children).toHaveLength(1);
  } finally { await f.close(); }
});

test("a late WHEP answer is deleted, not attached to the replacement generation", async () => {
  const f = fixture(), entered = gate<void>(), answer = gate<Response>();
  f.intercept((_url, init) => { if (init?.method === "POST") { entered.resolve(); return answer.promise; } });
  try {
    const a = await f.stream.watch("Gary");
    const offer = f.stream.offer(a.lease, a.generation, "v=0\r\ns=offer\r\n");
    const rejected = offer.then(() => null, error => error);
    await entered.promise;
    const next = f.stream.watch("Margo");
    answer.resolve(new Response("v=0\r\ns=answer\r\n", { status: 201, headers: {
      "Content-Type": "application/sdp", Location: "/resident/whep/late-session",
    } }));
    expect((await rejected)?.message).toContain("channel changed");
    expect((await next).resident).toBe("Margo");
    expect(f.requests.filter(item => item.method === "DELETE")).toEqual([
      { method: "DELETE", url: "http://127.0.0.1:8889/resident/whep/late-session" },
    ]);
    expect(f.counts().peak).toBe(1);
  } finally { await f.close(); }
});

test("WHEP Location never escapes the configured origin/path or leaks in errors", async () => {
  const f = fixture();
  f.intercept((_url, init) => init?.method === "POST" ? Promise.resolve(new Response("v=0\r\n", {
    status: 201, headers: { "Content-Type": "application/sdp", Location: "http://attacker.test/private-secret" },
  })) : undefined);
  try {
    const a = await f.stream.watch("Gary");
    await expect(f.stream.offer(a.lease, a.generation, "v=0\r\n")).rejects.toThrow("unexpected playback session location");
    expect(f.requests.some(item => item.url.includes("attacker.test"))).toBe(false);
    expect(JSON.stringify(f.stream.status())).not.toContain("private-secret");
  } finally { await f.close(); }
});

test("offer replacement deletes the previous session first; release deletes the retained session", async () => {
  const f = fixture();
  try {
    const a = await f.stream.watch("Gary");
    expect(await f.stream.offer(a.lease, a.generation, "v=0\r\n")).toEqual({ sdp: "v=0\r\ns=fixture\r\n" });
    await f.stream.offer(a.lease, a.generation, "v=0\r\n");
    await f.stream.stop(a.lease, a.generation);
    expect(f.requests.filter(item => item.method !== "GET").map(item => item.method)).toEqual(["POST", "DELETE", "POST", "DELETE"]);
  } finally { await f.close(); }
});

test("a failed session deletion refuses replacement instead of opening a second session", async () => {
  const f = fixture();
  try {
    const a = await f.stream.watch("Gary");
    await f.stream.offer(a.lease, a.generation, "v=0\r\n");
    f.intercept((_url, init) => init?.method === "DELETE" ? Promise.resolve(new Response(null, { status: 500 })) : undefined);
    await expect(f.stream.offer(a.lease, a.generation, "v=0\r\n")).rejects.toThrow("previous playback session could not be closed");
    expect(f.requests.filter(item => item.method === "POST")).toHaveLength(1);
  } finally { await f.close(); }
});

test("invalid metadata never opens capture or spawns an encoder", async () => {
  const f = fixture();
  f.intercept(url => url.endsWith("/video/info") ? Promise.resolve(Response.json({ ok: true, data: {
    available: true, protocol: 1, width: 1921, height: 1080, fps: 15, pixelFormat: "bgra", origin: "bottom-left",
  } })) : undefined);
  try {
    await expect(f.stream.watch("Gary")).rejects.toThrow("Unsupported framebuffer metadata");
    expect(f.stream.status()).toMatchObject({ state: "error", viewers: 0 });
    expect(f.children).toHaveLength(0);
    expect(f.requests.some(item => item.url.includes("/video/raw"))).toBe(false);
  } finally { await f.close(); }
});

test("child failure aborts capture with a sanitized error and never starts a fallback", async () => {
  const f = fixture();
  try {
    await f.stream.watch("Gary");
    f.children[0].encoder.errors.emit("data", Buffer.from("NVENC failed rtsp://secret.test/private-secret fixture-private-token"));
    f.children[0].exit(1);
    await f.children[0].encoder.exited;
    expect(f.stream.status()).toMatchObject({ state: "error", viewers: 0 });
    expect(f.stream.status().detail).toContain("no software fallback");
    expect(JSON.stringify(f.stream.status())).not.toContain("private-secret");
    expect(f.children).toHaveLength(1);
    await f.stream.shutdown();
    expect(f.counts().cancelled).toBe(1);
  } finally { await f.close(); }
});

test("live HTTP mutations reject cross-origin and oversized streamed bodies without capture", async () => {
  const f = fixture();
  try {
    const cross = await f.stream.handle(new Request("http://commons.test/token/api/live/watch", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://elsewhere.test" }, body: '{"resident":"Gary"}',
    }), "watch");
    expect(cross.status).toBe(403);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_536 * 6 + 8193)); },
      cancel() { cancelled = true; },
    });
    const oversized = await f.stream.handle(new Request("http://commons.test/token/api/live/offer", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://commons.test" }, body,
    }), "offer");
    expect(oversized.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(oversized.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});

test("the app exposes live status only behind its existing token gate", async () => {
  const home = tempHome(), app = createApp(home.config(), "fixture-management-token", Date.now, () => {});
  try {
    for (const path of ["/api/live/status", "/wrong/api/live/status"]) {
      expect((await app.fetch(new Request(`http://commons.test${path}`))).status).toBe(404);
    }
    const response = await app.fetch(new Request("http://commons.test/fixture-management-token/api/live/status"));
    expect(await response.json()).toMatchObject({ enabled: false, state: "disabled", videoOnly: true });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  } finally { app.stop(); home.remove(); }
});

test("configuration refuses external endpoints, credentials, query, fragment and unknown encoders without echoing secrets", () => {
  const home = tempHome();
  try {
    for (const [key, value] of [
      ["COMMONS_LIVE_RTSP_URL", "rtsp://192.168.1.69:8554/resident"],
      ["COMMONS_LIVE_WHEP_URL", "http://user:private-secret@127.0.0.1:8889/resident/whep"],
      ["COMMONS_LIVE_WHEP_URL", "http://127.0.0.1:8889/resident/whep?private-secret"],
      ["COMMONS_LIVE_WHEP_URL", "http://127.0.0.1:8889/resident/whep#private-secret"],
      ["COMMONS_LIVE_ENCODER", "private-secret"],
    ]) {
      let error: unknown;
      try { home.config({ [key]: value }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private-secret");
    }
  } finally { home.remove(); }
});

test("a child ignoring TERM is killed and reaped before the next publisher starts", async () => {
  const f = fixture(true);
  try {
    await f.stream.watch("Gary");
    const next = await f.stream.watch("Margo");
    expect(next.resident).toBe("Margo");
    expect(f.children[0].kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.counts().peak).toBe(1);
  } finally { await f.close(); }
});

test("a raw response with incompatible headers is cancelled before spawning", async () => {
  const f = fixture();
  let cancelled = false;
  f.intercept(url => url.includes("/video/raw?") ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/octet-stream", "X-Video-Protocol": "2" } })) : undefined);
  try {
    await expect(f.stream.watch("Gary")).rejects.toThrow("incompatible frame headers");
    expect(cancelled).toBe(true);
    expect(f.children).toHaveLength(0);
    expect(f.stream.status().viewers).toBe(0);
  } finally { await f.close(); }
});

test("an oversized source chunk fails closed instead of queuing it to the encoder", async () => {
  const f = fixture();
  try {
    await f.stream.watch("Gary");
    f.controllers[0].enqueue(new Uint8Array(65_537));
    await f.children[0].encoder.exited;
    expect(f.stream.status()).toMatchObject({ state: "error", viewers: 0 });
    expect(f.stream.status().detail).toContain("buffer limit");
    expect(f.children[0].writes).toEqual([32]);
  } finally { await f.close(); }
});

test("four shared viewers fit the MediaMTX reader cap; a fifth is refused without disturbing them", async () => {
  const f = fixture();
  try {
    const viewers = await Promise.all(Array.from({ length: 4 }, () => f.stream.watch("Gary")));
    const refused = await f.stream.handle(new Request("http://commons.test/token/api/live/watch", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://commons.test" },
      body: JSON.stringify({ resident: "Gary" }),
    }), "watch");
    expect(refused.status).toBe(429);
    expect(f.stream.status()).toMatchObject({ state: "live", viewers: 4, generation: viewers[0].generation });
    expect(f.children).toHaveLength(1);
    await f.stream.stop(viewers[0].lease, viewers[0].generation);
    const replacement = await f.stream.watch("Gary");
    expect(replacement.generation).toBe(viewers[1].generation);
    expect(replacement.viewers).toBe(4);
    expect(f.counts().cancelled).toBe(0);
  } finally { await f.close(); }
});

test("dedicated audio is explicit and uses the same channel lease and cleanup", async () => {
  const f = fixture();
  f.config.live!.audio = true;
  f.config.residents[0].audioSink = "resident_Gary";
  try {
    const a = await f.stream.watch("Gary");
    expect(a).toMatchObject({ audio: true, videoOnly: false });
    expect(f.commands[0]).toContain("resident_Gary.monitor");
    expect(f.commands[0]).toContain("libopus");
    expect((await f.stream.stop(a.lease, a.generation))).toMatchObject({ audio: false, videoOnly: true, state: "idle" });
    expect(f.counts()).toEqual({ active: 0, peak: 1, cancelled: 1 });
  } finally { await f.close(); }
});

test("audio off never opens Pulse even when a resident sink is configured", async () => {
  const f = fixture();
  f.config.residents[0].audioSink = "resident_Gary";
  try {
    expect(await f.stream.watch("Gary")).toMatchObject({ audio: false, videoOnly: true });
    expect(f.commands[0]).not.toContain("pulse");
    expect(f.commands[0]).toContain("-an");
  } finally { await f.close(); }
});

test("missing dedicated audio sink fails before capture without silently dropping audio", async () => {
  const f = fixture();
  f.config.live!.audio = true;
  try {
    await expect(f.stream.watch("Gary")).rejects.toThrow("dedicated launcher-owned Pulse sink");
    expect(f.requests).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(f.stream.status()).toMatchObject({ state: "error", viewers: 0 });
  } finally { await f.close(); }
});

test("VAAPI refuses a non-render path before requesting source frames", async () => {
  const f = fixture();
  f.config.live!.encoder = "h264_vaapi";
  f.config.live!.vaapiDevice = "/tmp/private-secret";
  try {
    await expect(f.stream.watch("Gary")).rejects.toThrow("DRM render character device");
    expect(f.requests).toEqual([]);
    expect(f.children).toEqual([]);
    expect(JSON.stringify(f.stream.status())).not.toContain("private-secret");
  } finally { await f.close(); }
});

test("audio failure stays sanitized and does not fall back to video-only or another encoder", async () => {
  const f = fixture();
  f.config.live!.audio = true;
  f.config.residents[0].audioSink = "resident_Gary";
  try {
    await f.stream.watch("Gary");
    f.children[0].encoder.errors.emit("data", Buffer.from("pulse input failed /private-secret rtsp://private-secret"));
    f.children[0].exit(1);
    await f.children[0].encoder.exited;
    expect(f.stream.status().detail).toContain("Resident audio setup failed with h264_nvenc");
    expect(JSON.stringify(f.stream.status())).not.toContain("private-secret");
    expect(f.children).toHaveLength(1);
    await f.stream.shutdown();
    expect(f.counts().active).toBe(0);
  } finally { await f.close(); }
});
