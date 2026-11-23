// Token-authenticated broadcast endpoints; no video side effects. On a hub, the
// on-stream resident may live on a station: its source comes from the federation
// cache (never awaited here) and passes through the same projection as local ones.
import type { Federation } from "./federation.ts";
import type { Context } from "./routes/context.ts";
import { json, refuse } from "./routes/context.ts";
import { overlayData, overlaySecrets, overlaySource, overlayText, parseOverlaySource, type OverlayData, type OverlaySource } from "./overlay-data.ts";
import { LAYOUTS, OverlayStateError, OverlayStore, overlayPresets, type OverlayLayout, type OverlayState } from "./overlay-state.ts";

export interface OverlaySnapshot { state: OverlayState; data: OverlayData; residents: { name: string; liveAvailable: boolean; detail?: string }[] }
const BODY_LIMIT = 32_768, MAX_CLIENTS = 8;
interface Client { controller: ReadableStreamDefaultController<Uint8Array>; removeAbort(): void }

export class Overlay {
  private store?: OverlayStore;
  private clients = new Set<Client>();
  private timer?: Timer;
  private stopped = false;
  private readonly encoder = new TextEncoder();
  constructor(private context: Context, private token: string, log: (line: string) => void = console.log, private federation?: Federation) {
    const names = () => [...context.config.residents.map(resident => resident.name), ...(federation?.remoteResidents().map(resident => resident.name) ?? [])];
    try { this.store = new OverlayStore(context.config.dbPath, names, context.config.owners); }
    catch { log("Overlay settings are unavailable; preserve and repair the overlay state file. Other Commons routes remain available."); }
  }
  snapshot(): OverlaySnapshot {
    if (!this.store || this.stopped) throw new OverlayStateError(503, "Overlay settings are unavailable; ask the operator to inspect the saved overlay file.");
    const state = this.store.get(), secrets = overlaySecrets(this.context.config, this.token);
    // State is broadcast alongside data. Never return its unfiltered user-editable strings.
    state.title = overlayText(state.title, state.hideNames, secrets, 160);
    state.nowPlaying = overlayText(state.nowPlaying, state.hideNames, secrets, 160);
    const { config, watcher } = this.context, remote = this.federation?.remoteResidents() ?? [];
    const key = (name: string) => name.toLowerCase();
    const counts = new Map<string, number>();
    for (const name of [...config.residents.map(resident => resident.name), ...remote.map(resident => resident.name)]) counts.set(key(name), (counts.get(key(name)) ?? 0) + 1);
    // Host labels are private on air; reasons stay generic.
    const entry = (name: string, available: boolean, reason: string) => counts.get(key(name))! > 1
      ? { name, liveAvailable: false, detail: "This name exists on more than one host." }
      : available ? { name, liveAvailable: true } : { name, liveAvailable: false, detail: reason };
    const residents = [
      ...config.residents.map(resident => entry(resident.name, config.live?.enabled === true, "Live video is disabled on its host.")),
      ...remote.map(resident => entry(resident.name, resident.liveAvailable, resident.unreachable ? "Its host is unreachable." : "Live video is disabled on its host.")),
    ];
    const local = this.context.resident(state.resident);
    let source: OverlaySource | null = null;
    if (local) source = overlaySource(this.context, local, secrets);
    else {
      const found = this.federation?.overlaySource(state.resident), parsed = found && parseOverlaySource(found.value, state.resident);
      // The last good sample stays visible with its own time, but never claims the resident is online.
      if (parsed) source = found?.current ? parsed : { ...parsed, online: false };
    }
    const located = (name: string) => {
      const body = this.context.resident(name) ? watcher.sighting(name).state : remote.find(resident => key(resident.name) === key(name))?.state;
      return body ? { pos: body.pos, dimension: body.dimension } : null;
    };
    return { state, data: overlayData(this.context, state, secrets, source, located), residents };
  }
  private remove(client: Client) {
    if (!this.clients.delete(client)) return;
    client.removeAbort();
    try { client.controller.close(); } catch { /* Cancelled readers are already closed. */ }
    if (!this.clients.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  private push() {
    if (!this.clients.size || this.stopped) return;
    let bytes: Uint8Array;
    try { bytes = this.encoder.encode(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`); }
    catch { for (const client of [...this.clients]) this.remove(client); return; }
    for (const client of [...this.clients]) {
      // One queued snapshot per connection. Slow viewers must reconnect, never accumulate history.
      if ((client.controller.desiredSize ?? 0) <= 0) { this.remove(client); continue; }
      try { client.controller.enqueue(bytes); } catch { this.remove(client); }
    }
  }
  private events(request: Request): Response {
    if (this.clients.size >= MAX_CLIENTS) return refuse(429, "Too many overlay viewers; close an unused viewer first.");
    if (request.signal.aborted) return refuse(400, "The overlay connection was cancelled.");
    let client: Client;
    const initial = this.encoder.encode(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const abort = () => this.remove(client);
        client = { controller, removeAbort: () => request.signal.removeEventListener("abort", abort) };
        this.clients.add(client);
        request.signal.addEventListener("abort", abort, { once: true });
        // Send only to this connection; opening another tab must not evict other queued viewers.
        controller.enqueue(initial);
        if (!this.timer) { this.timer = setInterval(() => this.push(), 2000); this.timer.unref(); }
      },
      cancel: () => this.remove(client),
    }, { highWaterMark: 1 });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no", "Referrer-Policy": "no-referrer",
    } });
  }
  private async body(request: Request): Promise<unknown> {
    if (Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT) throw new OverlayStateError(413, "Overlay settings are too large.");
    if (!request.body) throw new OverlayStateError(400, "Send overlay settings as JSON.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0, timer: Timer | undefined;
    // ES2022 target has no Promise.withResolvers(); the deadline also bounds slow uploads.
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new OverlayStateError(408, "Overlay settings upload timed out.")); }, 5000); });
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > BODY_LIMIT) throw new OverlayStateError(413, "Overlay settings are too large.");
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, length);
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new OverlayStateError(400, "Send valid JSON overlay settings."); }
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  /** A local resident's own secret-filtered source, for a hub's overlay. Needs no saved overlay state. */
  private source(request: Request): Response {
    const resident = this.context.resident(new URL(request.url).searchParams.get("resident"));
    if (!resident) return refuse(404, "No resident by that name.");
    return json(overlaySource(this.context, resident, overlaySecrets(this.context.config, this.token)));
  }
  /** App has already authenticated the dashboard URL before dispatch. */
  async handle(request: Request, action: string): Promise<Response> {
    try {
      if (request.method === "GET" && action === "source" && !this.stopped) return this.source(request);
      if (!this.store || this.stopped) throw new OverlayStateError(503, "Overlay settings are unavailable; ask the operator to inspect the saved overlay file.");
      if (request.method === "GET") {
        if (action === "") return json(this.snapshot());
        if (action === "events") return this.events(request);
        if (action === "presets") {
          const layout = new URL(request.url).searchParams.get("layout") ?? "1920x1080";
          if (!Object.hasOwn(LAYOUTS, layout)) throw new OverlayStateError(400, "Choose a supported overlay layout.");
          return json(overlayPresets(layout as OverlayLayout));
        }
      }
      if (request.method !== "POST" || action !== "") return refuse(404, "Not found.");
      // Origin-less operator clients remain possible; browser mutations are same-origin only.
      const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) throw new OverlayStateError(403, "Overlay changes must come from this page's origin.");
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new OverlayStateError(415, "Send overlay settings as JSON.");
      const body = await this.body(request);
      if (this.stopped) throw new OverlayStateError(503, "The overlay service is shutting down.");
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "revision,state") throw new OverlayStateError(400, "Send a revision and complete overlay state.");
      const change = body as { revision: number; state: unknown };
      if (!Number.isSafeInteger(change.revision) || change.revision < 0) throw new OverlayStateError(400, "Send a valid overlay revision.");
      // The store performs validation and atomic persistence before publishing anything.
      const before = this.store.get().revision;
      try { this.store.replace(change.revision, change.state); }
      finally { if (this.store.get().revision !== before) this.push(); }
      return json(this.snapshot());
    } catch (error) {
      return refuse(error instanceof OverlayStateError ? error.status : 500, error instanceof OverlayStateError ? error.message : "Overlay data could not be read safely.");
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = undefined;
    for (const client of [...this.clients]) this.remove(client);
  }
}
