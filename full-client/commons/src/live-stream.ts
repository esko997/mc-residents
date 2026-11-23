// One shared, on-demand channel. Generation identity fences every asynchronous result.
// No source request or encoder exists until watch(); errors never restart automatically.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { Config, LiveConfig, ResidentConfig } from "./config.ts";
import { buildEncoderArgs } from "./live-encoder.ts";

const TTL = 30_000, HEARTBEAT = 10_000, START_TIMEOUT = 15_000, IO_TIMEOUT = 5_000;
// JSON may encode each SDP character as six-byte \\uXXXX; the decoded SDP still
// has its own 64 KiB limit. Leave bounded space for lease/generation and field names.
const SDP_LIMIT = 65_536, BODY_LIMIT = SDP_LIMIT * 6 + 8192, MAX_VIEWERS = 4;

export interface LiveStatus {
  enabled: boolean;
  state: "disabled" | "idle" | "starting" | "live" | "error";
  resident: string | null;
  generation: number;
  viewers: number;
  detail: string;
  videoOnly: boolean;
  audio: boolean;
}
export interface EncoderProcess {
  input: Writable;
  progress: Readable;
  errors: Readable;
  exited: Promise<number | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}
export interface LiveDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: (executable: string, args: string[]) => EncoderProcess;
  now?: () => number;
}

class LiveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const changed = () => new LiveError(409, "The lease expired or the shared channel changed. Press Watch again.");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
// Commons targets ES2022, before Promise.withResolvers().
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A selection may be cancelled before any caller awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Deadline also covers injected I/O; remove abort listeners on every settlement. */
function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(signal?.reason?.name === "TimeoutError"
      ? new LiveError(504, "Live video timed out. Check the client, encoder and MediaMTX service.")
      : changed()));
    const timer = setTimeout(() => finish(() => reject(new LiveError(504, "Live video timed out. Check the client, encoder and MediaMTX service."))), ms);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}

async function textLimited(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<string> {
  if (!body) throw new LiveError(502, "The video service returned an empty response.");
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(IO_TIMEOUT)]);
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await bounded(reader.read(), IO_TIMEOUT, signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new LiveError(413, "The live video message is too large.");
      if (next.value.byteLength) chunks.push(next.value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function nativeSpawn(executable: string, args: string[]): EncoderProcess {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  const exited = new Promise<number | null>(resolve => {
    // A failed kill must not masquerade as process exit and unlock a second publisher.
    child.on("error", () => { if (child.pid === undefined) resolve(-1); });
    child.once("exit", code => resolve(code));
  });
  return {
    input: child.stdin, progress: child.stdout, errors: child.stderr, exited,
    kill(signal) {
      try { child.kill(signal); } catch { /* cleanup's reap deadline fails closed */ }
    },
  };
}

interface Lease { id: string; expires: number; session?: string; offering: boolean }
interface Channel {
  generation: number;
  resident: ResidentConfig;
  abort: AbortController;
  ready: Deferred<void>;
  done: Promise<void>;
  leases: Map<string, Lease>;
  tasks: Set<Promise<unknown>>;
  process?: EncoderProcess;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

export class LiveStream {
  private readonly source: LiveConfig | undefined;
  private readonly fetcher: NonNullable<LiveDependencies["fetch"]>;
  private readonly spawnEncoder: NonNullable<LiveDependencies["spawn"]>;
  private readonly now: () => number;
  private channel?: Channel;
  private generation = 0;
  private state: LiveStatus["state"];
  private detail: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private blocked?: LiveError;

  constructor(private readonly config: Pick<Config, "residents" | "live">, dependencies: LiveDependencies = {}) {
    this.source = config.live;
    this.fetcher = dependencies.fetch ?? fetch;
    this.spawnEncoder = dependencies.spawn ?? nativeSpawn;
    this.now = dependencies.now ?? Date.now;
    this.state = this.source?.enabled ? "idle" : "disabled";
    this.detail = this.source?.enabled ? "Press Watch to start the shared channel. Audio requires a dedicated resident sink and operator opt-in." : "Live video is disabled by the operator.";
  }

  status(): LiveStatus {
    this.expire();
    const audio = this.source?.audio === true && !!this.channel?.resident.audioSink
      && (this.state === "starting" || this.state === "live");
    return {
      enabled: this.source?.enabled === true, state: this.state,
      resident: this.state === "idle" || this.state === "disabled" ? null : this.channel?.resident.name ?? null,
      generation: this.generation, viewers: this.channel?.leases.size ?? 0, detail: this.detail, videoOnly: !audio, audio,
    };
  }

  async watch(name: string, signal?: AbortSignal): Promise<LiveStatus & { lease: string; heartbeatMs: number; expiresInMs: number }> {
    if (!this.source?.enabled || this.closed) throw new LiveError(503, "Live video is disabled or shutting down.");
    if (this.blocked) throw this.blocked;
    const resident = this.config.residents.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (!resident) throw new LiveError(400, "Choose a configured resident.");
    this.expire();
    if (signal?.aborted) throw changed();
    let channel = this.channel;
    if (!channel || channel.resident !== resident || channel.abort.signal.aborted) {
      const previous = channel;
      if (previous) this.cancel(previous);
      channel = {
        generation: ++this.generation, resident, abort: new AbortController(), ready: deferred<void>(),
        done: Promise.resolve(), leases: new Map(), tasks: new Set(),
      };
      this.channel = channel;
      this.state = "starting";
      this.detail = "Starting the framebuffer stream and video encoder.";
      channel.done = this.run(channel, previous?.done);
      void channel.done.catch(() => {});
    }
    if (channel.leases.size >= MAX_VIEWERS || channel.tasks.size >= MAX_VIEWERS) throw new LiveError(429, "Too many live viewers or pending playback operations. Stop an unused viewer first.");
    const lease: Lease = { id: randomUUID(), expires: this.now() + TTL, offering: false };
    channel.leases.set(lease.id, lease);
    if (!this.timer) {
      this.timer = setInterval(() => this.expire(), 1000);
      this.timer.unref();
    }
    const captured = channel;
    const abandon = () => this.release(captured, lease);
    signal?.addEventListener("abort", abandon, { once: true });
    try {
      // Includes waiting for the previous channel's bounded cleanup, not just encoder startup.
      await bounded(channel.ready.promise, 30_000, signal);
      this.requireLease(lease.id, channel.generation);
      lease.expires = this.now() + TTL;
      return { ...this.status(), lease: lease.id, heartbeatMs: HEARTBEAT, expiresInMs: TTL };
    } catch (error) {
      this.release(channel, lease);
      if (channel.abort.signal.aborted) await channel.done.catch(() => {});
      throw error instanceof LiveError ? error : new LiveError(502, "Unable to start live video. Check the client and encoder installation.");
    } finally { signal?.removeEventListener("abort", abandon); }
  }

  heartbeat(id: string, generation: number): LiveStatus {
    const { lease } = this.requireLease(id, generation);
    lease.expires = this.now() + TTL;
    return this.status();
  }

  async stop(id: string, generation: number): Promise<LiveStatus> {
    this.expire();
    const channel = this.channel;
    if (channel?.generation === generation) {
      const lease = channel.leases.get(id);
      if (lease) this.release(channel, lease);
      if (channel.abort.signal.aborted) await channel.done.catch(() => {});
    }
    return this.status();
  }

  async offer(id: string, generation: number, sdp: string): Promise<{ sdp: string }> {
    if (!sdp.startsWith("v=0") || Buffer.byteLength(sdp) > SDP_LIMIT) throw new LiveError(400, "A valid SDP offer of at most 64 KiB is required.");
    const { channel, lease } = this.requireLease(id, generation);
    if (this.state !== "live") throw new LiveError(409, "Wait for live video before negotiating playback.");
    if (lease.offering) throw new LiveError(409, "A playback offer is already in progress for this lease.");
    if (channel.tasks.size >= MAX_VIEWERS) throw new LiveError(429, "Too many pending playback operations. Try again after they finish.");
    lease.offering = true;
    const operation = this.negotiate(channel, lease, sdp);
    channel.tasks.add(operation);
    try { return await operation; }
    finally { channel.tasks.delete(operation); lease.offering = false; }
  }

  /** Synchronously abort capture and signal FFmpeg; callers can await final cleanup. */
  shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.channel) return Promise.resolve();
    this.cancel(this.channel);
    this.state = this.source?.enabled ? "idle" : "disabled";
    this.detail = "Live video stopped.";
    return this.channel.done;
  }

  private requireLease(id: string, generation: number): { channel: Channel; lease: Lease } {
    this.expire();
    const channel = this.channel, lease = channel?.leases.get(id);
    if (!channel || channel.generation !== generation || channel.abort.signal.aborted || !lease) throw changed();
    return { channel, lease };
  }

  private expire(): void {
    const channel = this.channel;
    if (channel) for (const lease of channel.leases.values()) if (lease.expires <= this.now()) this.release(channel, lease);
  }

  private release(channel: Channel, lease: Lease): void {
    if (!channel.leases.delete(lease.id)) return;
    if (lease.session) {
      const task = this.deleteSession(lease.session);
      channel.tasks.add(task);
      void task.finally(() => channel.tasks.delete(task));
      lease.session = undefined;
    }
    if (!channel.leases.size) {
      this.cancel(channel);
      if (this.channel === channel && this.state !== "error") {
        this.state = "idle";
        this.detail = "No viewers. Capture stopped; encoder cleanup scheduled.";
      }
    }
  }

  private cancel(channel: Channel): void {
    if (channel.abort.signal.aborted) return;
    channel.ready.reject(changed());
    channel.abort.abort();
    channel.process?.input.destroy();
    channel.process?.kill("SIGTERM");
    if (channel.reader) void channel.reader.cancel().catch(() => {});
    for (const lease of [...channel.leases.values()]) this.release(channel, lease);
    if (this.channel === channel && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private assertCurrent(channel: Channel): void {
    if (this.closed || this.channel !== channel || channel.abort.signal.aborted) throw changed();
  }

  private fail(channel: Channel, error: LiveError): void {
    if (channel.abort.signal.aborted) return;
    if (this.channel === channel) { this.state = "error"; this.detail = error.message; }
    channel.ready.reject(error);
    this.cancel(channel);
  }

  private async request(url: string, init: RequestInit, ms = IO_TIMEOUT): Promise<Response> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new DOMException("Video request timed out", "TimeoutError")), ms);
    try {
      const result = this.fetcher(url, { ...init, signal, redirect: "error" }).then(response => {
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw changed();
        }
        return response;
      });
      return await bounded(result, ms, signal);
    } finally {
      // Only the headers have a connection deadline. Raw video stays open until
      // its channel aborts; pump reads/writes enforce their own stall deadlines.
      clearTimeout(timer);
    }
  }

  private async run(channel: Channel, previous?: Promise<void>): Promise<void> {
    let startup: ReturnType<typeof setTimeout> | undefined;
    try {
      // Never overlap publishers, including when a previous SIGKILL failed to reap.
      await previous;
      this.assertCurrent(channel);
      const source = this.source!;
      const setup = `${source.encoder}${source.audio ? " with dedicated Pulse monitor audio and Opus" : " (video only)"}`;
      startup = setTimeout(() => this.fail(channel, new LiveError(504, `The publisher did not become ready. Check ${setup} and MediaMTX; no software fallback is used.`)), START_TIMEOUT);
      if (source.audio && !channel.resident.audioSink) throw new LiveError(503, "Resident audio is enabled but this resident has no dedicated launcher-owned Pulse sink. Configure it or explicitly disable audio.");
      if (source.encoder === "h264_vaapi") {
        try {
          if (!/^\/dev\/dri\/renderD[0-9]{3,4}$/.test(source.vaapiDevice ?? "")) throw new Error();
          const device = source.vaapiDevice!;
          const metadata = await bounded(stat(device), IO_TIMEOUT, channel.abort.signal);
          if (!metadata.isCharacterDevice()) throw new Error();
          await bounded(access(device, constants.R_OK | constants.W_OK), IO_TIMEOUT, channel.abort.signal);
        } catch {
          this.assertCurrent(channel);
          throw new LiveError(503, "h264_vaapi setup requires an accessible read/write DRM render character device; no software fallback is used.");
        }
        this.assertCurrent(channel);
      }
      let secret: string | undefined;
      for (const file of channel.resident.tokenFiles) {
        try { secret = (await bounded(readFile(file, "utf8"), IO_TIMEOUT, channel.abort.signal)).trim(); } catch { /* next configured file */ }
        this.assertCurrent(channel);
        if (secret) break;
      }
      if (!secret) throw new LiveError(503, "No readable Synapse token is configured for this resident.");
      const headers = { "X-Synapse-Token": secret };
      const base = channel.resident.synapseUrl.replace(/\/$/, "");
      const info = await this.request(`${base}/video/info`, { headers, signal: channel.abort.signal });
      if (!info.ok) { void info.body?.cancel().catch(() => {}); throw new LiveError(502, "Synapse refused video metadata. Check authentication and enable screenshotEnabled and videoEnabled."); }
      const envelope = object(JSON.parse(await textLimited(info.body, 16_384, channel.abort.signal)));
      const data = object(envelope.data), width = data.width, height = data.height;
      if (envelope.ok !== true || data.available !== true) throw new LiveError(503, "Resident framebuffer unavailable. Enable video and wait until the resident is in a world.");
      if (data.protocol !== 1 || data.fps !== 15 || data.pixelFormat !== "bgra" || data.origin !== "bottom-left"
        || typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height)
        || width <= 0 || height <= 0 || width > 1920 || height > 1080) {
        throw new LiveError(502, "Unsupported framebuffer metadata (expected protocol 1, BGRA, 15 fps, at most 1920×1080).");
      }
      this.assertCurrent(channel);
      const raw = await this.request(`${base}/video/raw?width=${width}&height=${height}`, { headers, signal: channel.abort.signal });
      const expected: Record<string, string> = {
        "X-Video-Protocol": "1", "X-Video-Width": String(width), "X-Video-Height": String(height),
        "X-Video-Fps": "15", "X-Video-Pixel-Format": "bgra", "X-Video-Origin": "bottom-left",
      };
      if (!raw.ok || raw.headers.get("content-type")?.split(";")[0].trim() !== "application/octet-stream"
        || Object.entries(expected).some(([key, value]) => raw.headers.get(key) !== value) || !raw.body) {
        void raw.body?.cancel().catch(() => {});
        throw new LiveError(502, "Synapse refused raw video or returned incompatible frame headers.");
      }
      channel.reader = raw.body.getReader();
      this.assertCurrent(channel);
      // Preserve the actual arrival cadence; never manufacture missing frames.
      // Both audio/video use one epoch, rather than independently zeroing PTS.
      const args = buildEncoderArgs(source, { width, height }, { audioSink: channel.resident.audioSink, epochMs: Date.now() });
      const encoder = channel.process = this.spawnEncoder(source.ffmpeg, args);
      let progress = "", errorTail = "";
      encoder.progress.on("data", (chunk: Buffer) => {
        progress += chunk.toString().slice(-4096);
        const lines = progress.split("\n");
        progress = (lines.pop() ?? "").slice(-1024);
        if (lines.some(line => /^frame=\s*[1-9]\d*\s*$/.test(line)) && !channel.abort.signal.aborted) {
          clearTimeout(startup);
          this.state = "live";
          this.detail = `Live framebuffer via ${setup}. One shared channel; no recording.`;
          channel.ready.resolve();
        }
      });
      encoder.errors.on("data", (chunk: Buffer) => {
        // Never expose stderr, URLs, paths or arbitrary encoder output to the browser/journal.
        errorTail = (errorTail + chunk.toString().slice(-4096).replace(/\S+:\/\/\S+/g, "[endpoint]")).slice(-4096);
      });
      encoder.input.on("error", () => this.fail(channel, new LiveError(502, `The encoder stopped accepting frames. Check ${setup}; no software fallback is used.`)));
      encoder.progress.on("error", () => this.fail(channel, new LiveError(502, "The encoder progress pipe failed.")));
      encoder.errors.on("error", () => {});
      void encoder.exited.then(() => this.fail(channel, new LiveError(502,
        source.audio && /pulse|monitor|libopus|audio|opus/i.test(errorTail)
          ? `Resident audio setup failed with ${source.encoder}. Check the dedicated Pulse null sink, monitor capture and FFmpeg Opus support; no software fallback was used.`
          : `${source.encoder} encoder failed. Check its FFmpeg support, hardware/driver access and MediaMTX${source.audio ? ", plus dedicated Pulse monitor audio and Opus" : ""}; no software fallback was used.`)));
      // One HTTP chunk held at a time, at most two frames. Writes are <=64 KiB and
      // await the writable callback: no frame accumulation or unbounded stdin queue.
      const maxChunk = Math.max(65_536, width * height * 8);
      for (;;) {
        const next = await bounded(channel.reader.read(), IO_TIMEOUT, channel.abort.signal);
        if (next.done) throw new LiveError(502, "The framebuffer stream closed (world unloaded or resolution changed). Press Watch to reconnect.");
        if (next.value.byteLength > maxChunk) throw new LiveError(502, "The framebuffer source exceeded its buffer limit.");
        for (let offset = 0; offset < next.value.byteLength; offset += 65_536) {
          this.assertCurrent(channel);
          const bytes = next.value.subarray(offset, offset + 65_536);
          await bounded(new Promise<void>((resolve, reject) => encoder.input.write(bytes, error => error ? reject(error) : resolve())), IO_TIMEOUT, channel.abort.signal);
        }
      }
    } catch (error) {
      this.fail(channel, error instanceof LiveError ? error : new LiveError(502,
        `Unable to stream with ${this.source!.encoder}${this.source!.audio ? " and dedicated Pulse monitor audio/Opus" : " (video only)"}. Check source, encoder setup and MediaMTX; no software fallback was used.`));
    } finally {
      clearTimeout(startup);
      this.cancel(channel);
      if (channel.reader) { void channel.reader.cancel().catch(() => {}); channel.reader.releaseLock(); }
      const encoder = channel.process;
      if (encoder) {
        try { await bounded(encoder.exited, 1500); }
        catch {
          encoder.kill("SIGKILL");
          try { await bounded(encoder.exited, 1500); }
          catch {
            const error = new LiveError(503, "The encoder could not be reaped. Restart Commons before starting another stream.");
            this.blocked = error;
            if (this.channel === channel) { this.state = "error"; this.detail = error.message; }
            // Rejection propagates through the next channel's gate: never spawn over an unreaped child.
            throw error;
          }
        } finally { encoder.progress.destroy(); encoder.errors.destroy(); }
      }
      await Promise.allSettled([...channel.tasks]);
    }
  }

  private sessionLocation(response: Response): string {
    const location = response.headers.get("location"), endpoint = new URL(this.source!.whepUrl);
    if (!location) throw new LiveError(502, "MediaMTX did not return a playback session location.");
    let session: URL;
    try { session = new URL(location, endpoint); } catch { throw new LiveError(502, "MediaMTX returned an invalid playback session location."); }
    const prefix = `${endpoint.pathname}/`;
    if (session.origin !== endpoint.origin || session.username || session.password || session.search || session.hash
      || !session.pathname.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,128}$/.test(session.pathname.slice(prefix.length))) {
      throw new LiveError(502, "MediaMTX returned an unexpected playback session location.");
    }
    return session.href;
  }

  private async negotiate(channel: Channel, lease: Lease, sdp: string): Promise<{ sdp: string }> {
    let session: string | undefined;
    let response: Response | undefined;
    try {
      if (lease.session) {
        if (!await this.deleteSession(lease.session)) throw new LiveError(502, "The previous playback session could not be closed. Stop and reconnect after MediaMTX recovers.");
        lease.session = undefined;
      }
      this.requireLease(lease.id, channel.generation);
      // Do not abort on channel change: collect a late Location and DELETE it rather
      // than orphaning a successful POST. The independent deadline still bounds it.
      response = await this.request(this.source!.whepUrl, {
        method: "POST", headers: { "Content-Type": "application/sdp" }, body: sdp,
      }, 8000);
      if (response.status !== 201) { void response.body?.cancel().catch(() => {}); throw new LiveError(502, "MediaMTX refused playback. Check WebRTC configuration and publisher readiness."); }
      session = this.sessionLocation(response);
      const answer = await textLimited(response.body, SDP_LIMIT);
      if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/sdp" || !answer.startsWith("v=0")) {
        throw new LiveError(502, "MediaMTX returned an invalid SDP answer.");
      }
      this.requireLease(lease.id, channel.generation);
      lease.session = session;
      session = undefined;
      return { sdp: answer };
    } catch (error) {
      if (session) await this.deleteSession(session);
      throw error instanceof LiveError ? error : new LiveError(502, "Playback negotiation failed. Check the MediaMTX WebRTC service.");
    } finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  }

  private async deleteSession(url: string): Promise<boolean> {
    try {
      const response = await this.request(url, { method: "DELETE" }, 2000);
      void response.body?.cancel().catch(() => {});
      return response.ok || response.status === 404;
    } catch { return false; } // Released sessions have MediaMTX's ICE timeout as a backstop.
  }

  /** Called only after the app authenticates its secret URL path. */
  async handle(request: Request, action: string): Promise<Response> {
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
    try {
      if (action === "status" && request.method === "GET") return reply(this.status());
      if (request.method !== "POST" || !["watch", "heartbeat", "stop", "offer"].includes(action)) return reply({ error: "Not found." }, 404);
      // Origin-less CLI clients are allowed, but browser cross-site requests are not.
      const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) {
        throw new LiveError(403, "Live video changes must come from this page's origin.");
      }
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new LiveError(415, "Send a JSON live video request.");
      if (Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT) throw new LiveError(413, "The live video message is too large.");
      let body: Record<string, unknown>;
      try { body = object(JSON.parse(await textLimited(request.body, BODY_LIMIT, request.signal))); }
      catch (error) { throw error instanceof LiveError ? error : new LiveError(400, "Send a valid JSON live video request."); }
      if (action === "watch") {
        if (typeof body.resident !== "string" || body.resident.length > 128) throw new LiveError(400, "Choose a configured resident.");
        return reply(await this.watch(body.resident, request.signal));
      }
      if (typeof body.lease !== "string" || body.lease.length > 128 || typeof body.generation !== "number" || !Number.isSafeInteger(body.generation)) {
        throw new LiveError(400, "A lease and generation are required.");
      }
      if (action === "heartbeat") return reply(this.heartbeat(body.lease, body.generation));
      if (action === "stop") return reply(await this.stop(body.lease, body.generation));
      if (typeof body.sdp !== "string") throw new LiveError(400, "An SDP offer is required.");
      return reply(await this.offer(body.lease, body.generation, body.sdp));
    } catch (error) {
      return reply({ error: error instanceof LiveError ? error.message : "Live video request failed." }, error instanceof LiveError ? error.status : 502);
    }
  }
}
