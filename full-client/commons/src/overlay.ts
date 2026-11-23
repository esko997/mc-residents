// Token-authenticated broadcast endpoints; no network calls or video side effects.
import type { Context } from "./routes/context.ts";
import { json, refuse } from "./routes/context.ts";
import { overlayData, overlaySecrets, overlayText, type OverlayData } from "./overlay-data.ts";
import { LAYOUTS, OverlayStateError, OverlayStore, overlayPresets, type OverlayLayout, type OverlayState } from "./overlay-state.ts";

export interface OverlaySnapshot { state: OverlayState; data: OverlayData; residents: { name: string; liveAvailable: boolean }[] }
const BODY_LIMIT = 32_768, MAX_CLIENTS = 8;
interface Client { controller: ReadableStreamDefaultController<Uint8Array>; removeAbort(): void }

export class Overlay {
  private store?: OverlayStore;
  private clients = new Set<Client>();
  private timer?: Timer;
  private stopped = false;
  private readonly encoder = new TextEncoder();
  constructor(private context: Context, private token: string, log: (line: string) => void = console.log) {
    try { this.store = new OverlayStore(context.config.dbPath, context.config.residents.map(resident => resident.name), context.config.owners); }
    catch { log("Overlay settings are unavailable; preserve and repair the overlay state file. Other Commons routes remain available."); }
  }
  snapshot(): OverlaySnapshot {
    if (!this.store || this.stopped) throw new OverlayStateError(503, "Overlay settings are unavailable; ask the operator to inspect the saved overlay file.");
    const state = this.store.get(), secrets = overlaySecrets(this.context.config, this.token);
    // State is broadcast alongside data. Never return its unfiltered user-editable strings.
    state.title = overlayText(state.title, state.hideNames, secrets, 160);
    state.nowPlaying = overlayText(state.nowPlaying, state.hideNames, secrets, 160);
    const data = overlayData(this.context, state, secrets);
    return { state, data, residents: this.context.config.residents.map(resident => ({
      name: resident.name, liveAvailable: this.context.config.role === "hub" && this.context.config.live?.enabled === true,
    })) };
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
  /** App has already authenticated the dashboard URL before dispatch. */
  async handle(request: Request, action: string): Promise<Response> {
    try {
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
