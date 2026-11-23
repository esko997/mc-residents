// Live routing: one channel per host. A resident on this host uses the local
// LiveStream; a station resident's signaling (status, watch, offer, heartbeat,
// stop) is proxied server-side to the owning station's secret URL. The browser
// only talks to this Commons; media then flows between the browser and the
// station's MediaMTX, whose candidates are the only station detail it learns
// (inside the SDP answer). The station alone owns leases and generation fencing.
import type { Federation, LiveTarget } from "./federation.ts";
import {
  LIVE_BODY_LIMIT, LiveError, SDP_LIMIT, isLiveAction, liveFailure, liveReply, readLiveRequest, textLimited,
  type LiveAction, type LiveRequest, type LiveStatus, type LiveStream,
} from "./live-stream.ts";

type Remote = Extract<LiveTarget, { kind: "remote" }>;
type Action = "status" | LiveAction;
export interface LiveRouterOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Proxy deadlines per action (ms). Each stays below the browser's own deadline. */
  timeouts?: Partial<Record<Action, number>>;
}
export type RoutedStatus = LiveStatus & { host: string };

const TIMEOUTS: Record<Action, number> = { status: 2500, watch: 33_000, offer: 11_000, heartbeat: 6000, stop: 6000 };
/** Concurrent proxied requests per station: four viewers' heartbeats, offers and stops, plus status. */
const MAX_PENDING = 12;
const STATES: Record<string, true> = { disabled: true, idle: true, starting: true, live: true, error: true };
const PASSED: Record<number, true> = { 400: true, 409: true, 413: true, 429: true, 502: true, 503: true, 504: true };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// URLs, control characters, IPv4/IPv6 addresses, address:port pairs and long token-like runs.
const LEAKY = /:\/\/|[\p{Cc}]|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}|[\w.-]+:\d{2,5}\b|[A-Za-z0-9_+/=-]{24,}/iu;
/**
 * Station messages are fixed sentences. Anything that looks like an address or
 * token, or names this station's own URL host, port or secret path, is replaced.
 */
function sentence(value: unknown, fallback: string, target: Remote): string {
  if (typeof value !== "string" || value.length > 500 || LEAKY.test(value)) return fallback;
  const url = new URL(target.url), text = value.toLowerCase();
  const secrets = [url.hostname, url.port, ...url.pathname.split("/")].filter(part => part.length >= 2);
  return secrets.some(secret => text.includes(secret.toLowerCase())) ? fallback : value;
}

function status(value: unknown, target: Remote): RoutedStatus {
  const { host } = target;
  const data = object(value);
  if (typeof data.enabled !== "boolean" || typeof data.state !== "string" || !Object.hasOwn(STATES, data.state)
    || !(data.resident === null || (typeof data.resident === "string" && /^[\w-]{1,64}$/.test(data.resident)))
    || !Number.isSafeInteger(data.generation) || (data.generation as number) < 0
    || !Number.isSafeInteger(data.viewers) || (data.viewers as number) < 0 || (data.viewers as number) > 64
    || typeof data.videoOnly !== "boolean" || typeof data.audio !== "boolean"
    || (data.resuming !== undefined && typeof data.resuming !== "boolean")) {
    throw new LiveError(502, `${host}: Live returned an unreadable status.`);
  }
  return {
    enabled: data.enabled as boolean, state: data.state as LiveStatus["state"], resident: data.resident as string | null,
    generation: data.generation as number, viewers: data.viewers as number, detail: sentence(data.detail, "", target),
    videoOnly: data.videoOnly as boolean, audio: data.audio as boolean, resuming: data.resuming === true, host,
  };
}

export class LiveRouter {
  private readonly fetcher: NonNullable<LiveRouterOptions["fetch"]>;
  private pending = new Map<string, number>();
  /** Bumped by watch/stop: a status read joins an in-flight one only within the same epoch. */
  private epochs = new Map<string, number>();
  private flights = new Map<string, { epoch: number; promise: Promise<RoutedStatus> }>();
  private controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private live: LiveStream, private hostName: string, private federation?: Federation, private options: LiveRouterOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Called only after the app authenticates its secret URL path. */
  async handle(request: Request, action: string): Promise<Response> {
    try {
      if (action === "status" && request.method === "GET") {
        const target = this.target(new URL(request.url).searchParams.get("resident") ?? "");
        return liveReply(target.kind === "local" ? { ...this.live.status(), host: this.hostName } : await this.remoteStatus(target));
      }
      if (request.method !== "POST" || !isLiveAction(action)) return liveReply({ error: "Not found." }, 404);
      const body = await readLiveRequest(request, action);
      const target = this.target(body.resident ?? "");
      if (target.kind === "remote") return liveReply(await this.forward(target, body, request.signal));
      const answer = await this.live.act(body, request.signal);
      return liveReply(body.action === "offer" ? answer : { ...answer, host: this.hostName });
    } catch (error) { return liveFailure(error); }
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }

  private target(name: string): { kind: "local" } | Remote {
    // Old pages send lease requests without a resident: they can only be this host's.
    const target = name && this.federation ? this.federation.liveTarget(name) : { kind: "local" as const };
    if (target.kind === "duplicate") throw new LiveError(400, "This resident name exists on more than one host. Fix the station configuration before watching.");
    return target;
  }

  private remoteStatus(target: Remote): Promise<RoutedStatus> {
    const { host } = target;
    if (target.unreachable) throw new LiveError(502, `${host}: host unreachable; Live status is unavailable.`);
    if (!target.liveAvailable) {
      return Promise.resolve({ enabled: false, state: "disabled", resident: null, generation: 0, viewers: 0,
        detail: `Live video is disabled on host ${host}.`, videoOnly: true, audio: false, resuming: false, host });
    }
    const epoch = this.epochs.get(host) ?? 0, flight = this.flights.get(host);
    if (flight?.epoch === epoch) return flight.promise;
    const promise: Promise<RoutedStatus> = this.call(target, "status").then(data => status(data, target))
      .finally(() => { if (this.flights.get(host)?.promise === promise) this.flights.delete(host); });
    this.flights.set(host, { epoch, promise });
    return promise;
  }

  private async forward(target: Remote, body: LiveRequest, signal: AbortSignal): Promise<object> {
    const { host } = target;
    if (body.action === "watch") {
      if (target.unreachable) throw new LiveError(502, `${host}: host unreachable; ${body.resident} cannot be watched right now.`);
      if (!target.liveAvailable) throw new LiveError(503, `Live video is disabled on host ${host}; ${body.resident} cannot be watched.`);
    }
    if (body.action === "offer" && (!body.sdp.startsWith("v=0") || Buffer.byteLength(body.sdp) > SDP_LIMIT)) {
      throw new LiveError(400, "A valid SDP offer of at most 64 KiB is required.");
    }
    // Rebuild the body from validated fields only.
    const { action, ...fields } = body;
    // Before and after: a status read in flight across a watch/stop never answers for the new channel.
    if (action === "watch" || action === "stop") this.epochs.set(host, (this.epochs.get(host) ?? 0) + 1);
    try {
      const data = await this.call(target, action, JSON.stringify(fields), signal);
      if (action !== "offer") {
        const routed = status(data, target);
        if (action !== "watch") return routed;
        const lease = data.lease, heartbeatMs = data.heartbeatMs, expiresInMs = data.expiresInMs;
        if (typeof lease !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(lease)
          || ![heartbeatMs, expiresInMs].every(value => typeof value === "number" && value > 0 && value <= 120_000)) {
          throw new LiveError(502, `${host}: Live returned an unreadable viewing lease.`);
        }
        return { ...routed, lease, heartbeatMs, expiresInMs };
      }
      const sdp = data.sdp;
      if (typeof sdp !== "string" || !sdp.startsWith("v=0") || Buffer.byteLength(sdp) > SDP_LIMIT) {
        throw new LiveError(502, `${host}: Live returned an invalid SDP answer.`);
      }
      return { sdp };
    } finally {
      if (action === "watch" || action === "stop") this.epochs.set(host, (this.epochs.get(host) ?? 0) + 1);
    }
  }

  /** One bounded request to the station's own Live API under its secret URL. */
  private async call(target: Remote, action: Action, body?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { host } = target, count = this.pending.get(host) ?? 0;
    if (this.stopped) throw new LiveError(503, "Live video is shutting down.");
    if (count >= MAX_PENDING) throw new LiveError(429, `${host}: too many Live requests are pending. Try again shortly.`);
    this.pending.set(host, count + 1);
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeouts?.[action] ?? TIMEOUTS[action]);
    // A viewer that leaves abandons its request; the station then releases a late lease itself.
    const abandon = () => controller.abort();
    signal?.addEventListener("abort", abandon, { once: true });
    if (signal?.aborted) controller.abort();
    const failed = () => timedOut ? new LiveError(504, `${host}: Live signaling timed out.`)
      : new LiveError(502, `${host}: host unreachable; Live signaling failed.`);
    try {
      let response: Response;
      try {
        response = await this.fetcher(new URL(`api/live/${action}`, target.url).href, {
          method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
          headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body }),
        });
      } catch { throw failed(); }
      let text: string;
      try { text = await textLimited(response.body, action === "offer" ? LIVE_BODY_LIMIT : 16_384, controller.signal); }
      catch (error) {
        if (error instanceof LiveError && error.status === 413) throw new LiveError(502, `${host}: Live returned an oversized reply.`);
        throw controller.signal.aborted ? failed() : new LiveError(502, `${host}: Live returned an unreadable reply.`);
      }
      let data: Record<string, unknown> | undefined;
      try { data = object(JSON.parse(text)); } catch { /* checked below */ }
      if (!response.ok) {
        // A station that lacks this API (older Commons) or rejects the secret URL answers 404.
        if (!Object.hasOwn(PASSED, response.status)) throw new LiveError(502, `${host}: the station refused Live signaling. Check its Commons version and the stations file.`);
        throw new LiveError(response.status, `${host}: ${sentence(data?.error, "Live request failed.", target)}`);
      }
      if (!data) throw new LiveError(502, `${host}: Live returned an unreadable reply.`);
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      this.controllers.delete(controller);
      const left = (this.pending.get(host) ?? 1) - 1;
      if (left > 0) this.pending.set(host, left); else this.pending.delete(host);
    }
  }
}
