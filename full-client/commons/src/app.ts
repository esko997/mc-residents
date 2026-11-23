// The web app: one page and a JSON API, everything under /<token>/. The token in
// the path is the only access control (home LAN), as with the phone chat page.
// Each panel's routes live in their own module under routes/.
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { Console, ConsoleFeed } from "./console.ts";
import { openCommons } from "./db.ts";
import { Federation } from "./federation.ts";
import { openStation } from "./station-db.ts";
import { LiveStream } from "./live-stream.ts";
import { LiveRouter } from "./live-proxy.ts";
import type { TextFile } from "./notes.ts";
import { RolloutTail } from "./rollouts.ts";
import { activityRoutes, type ActivityReply, type ThoughtsReply } from "./routes/activity.ts";
import { commonsRoutes, type CommonsReply } from "./routes/commons.ts";
import { consoleRoutes, type ConsoleReply } from "./routes/console.ts";
import { json, refuse, type Context, type Routes } from "./routes/context.ts";
import { mapRoutes, type MapReply } from "./routes/map.ts";
import { notesRoutes, type NotesReply } from "./routes/notes.ts";
import { residentRoutes, type ResidentsReply } from "./routes/residents.ts";
import { Watcher } from "./watcher.ts";
import { ingestOptionsFromEnv, ObserverIngest } from "./observer-ingest.ts";
import { serverDataRoutes } from "./routes/server-data.ts";
import { ResidentApi } from "./resident-api.ts";
import { importSharedPlaces, sharedPlaces } from "./resident-places.ts";
import { alarmActivityText, recentAlarms } from "./resident-alarms.ts";
import type { AlarmEvent } from "./resident-contracts-alarm.ts";
import { Overlay } from "./overlay.ts";
import { RunControl } from "./run-control.ts";

/** The JSON each GET route under /<token>/api/ returns, for whoever reads it (the page, the tests). */
export interface Replies {
  residents: ResidentsReply; activity: ActivityReply; map: MapReply; commons: CommonsReply; notes: NotesReply; file: TextFile; console: ConsoleReply;
  thoughts: ThoughtsReply;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  /** Begin watching the residents' clients and reading their sessions. */
  start(): void;
  stop(): void;
  watcher: Watcher;
  tail: RolloutTail;
  stream: Console;
  feed: ConsoleFeed;
  db: Database;
  /** Hub only: station discovery, also awaited by tests. */
  federation?: Federation;
}

const STATIC: Record<string, string> = {
  "": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8",
  "map-trails.js": "text/javascript; charset=utf-8",
  "watch-layout.js": "text/javascript; charset=utf-8", "watch-layout.css": "text/css; charset=utf-8",
  "live-view.js": "text/javascript; charset=utf-8", "live-view.css": "text/css; charset=utf-8",
  "run-control.js": "text/javascript; charset=utf-8",
  "overlay": "text/html; charset=utf-8", "overlay/control": "text/html; charset=utf-8", "overlay/preview": "text/html; charset=utf-8",
  "overlay.js": "text/javascript; charset=utf-8", "overlay-control.js": "text/javascript; charset=utf-8",
  "overlay-preview.js": "text/javascript; charset=utf-8", "overlay-core.js": "text/javascript; charset=utf-8",
  "overlay-media.js": "text/javascript; charset=utf-8", "overlay.css": "text/css; charset=utf-8",
  "overlay-font.ttf": "font/ttf", "overlay-font-LICENSE.txt": "text/plain; charset=utf-8",
  // Unlinked prototype for docs/map-3d.md (synthetic terrain, reads no data).
  "iso-chunk.html": "text/html; charset=utf-8", "iso-chunk.js": "text/javascript; charset=utf-8",
};
const MAX_BODY = 8192;

export function createApp(config: Config, token: string, now: () => number = Date.now, log: (line: string) => void = console.log): App {
  const db = config.role === "station" ? openStation(config.dbPath) : openCommons(config.dbPath, config.schemaPath);
  if (config.role === "hub") importSharedPlaces(db, config.sharedPlaces);
  const watcher = new Watcher(config, db, now);
  const tail = new RolloutTail(config.sessionsDir, config.residents, { days: config.activityDays, now, callsDir: config.callsDir });
  const stream = new Console(config.consoleUrl !== undefined, { now, names: [...config.residents.map(resident => resident.name), ...config.owners] });
  const feed = new ConsoleFeed(stream, config, now);
  const alarmActivity = (event: AlarmEvent) =>
    tail.recordEvent(event.sender, event.at, "alarm", alarmActivityText(event));
  // Stations have no shared tables; only the hub restores durable alarm history.
  if (config.role === "hub") for (const event of recentAlarms(db, now() - config.activityDays * 86_400_000)) alarmActivity(event);
  const residentApi = config.role === "hub" ? new ResidentApi(db, config.credentialsFile, config.autoAccept, {
    now, command: command => feed.command(command), activity: alarmActivity,
  }, { source: config.observer ?? null }) : undefined;
  // Server bridge queries (stats, advancements, block changes, container flows) into the hub database.
  const ingestOptions = config.role === "hub" && config.observer ? ingestOptionsFromEnv(process.env) : null;
  const ingest = ingestOptions ? new ObserverIngest(db, config.observer, { ...ingestOptions, now, log }) : undefined;
  const live = new LiveStream(config, { now });
  let lastRead = 0;
  const context: Context = {
    config, db, watcher, tail, stream, feed, now,
    async readSessions() {
      if (now() - lastRead < 2000) return;
      lastRead = now();
      // Run starts/stops recorded on this host, including ones made from a shell.
      runControl.refreshActivity();
      await tail.refresh();
    },
    resident: name => config.residents.find(resident => resident.name.toLowerCase() === name?.toLowerCase()),
  };
  const federation = config.role === "hub" ? new Federation(config, now, { sharedPlaces: () => sharedPlaces(db) }) : undefined;
  const overlay = new Overlay(context, token, log, federation);
  const liveRouter = new LiveRouter(live, config.hostName, federation);
  const runControl = new RunControl(config, tail, federation, { log });
  const localRoutes: Routes = {
    ...residentRoutes(context), ...activityRoutes(context), ...mapRoutes(context), ...notesRoutes(context),
    ...(config.role === "hub" ? { ...commonsRoutes(context), ...consoleRoutes(context), ...serverDataRoutes(context, ingest) } : {}),
  };
  const routes = federation ? federation.wrap(localRoutes) : localRoutes;
  const secret = Buffer.from(token);

  /** `rest` is the path after the token, split at slashes; empty for a bare /<token>. */
  async function handle(request: Request, url: URL, rest: string[]): Promise<Response> {
    // Without the trailing slash the page's own relative requests would lose the token.
    if (rest.length === 0) return new Response(null, { status: 308, headers: { Location: `/${token}/` } });
    const route = rest.join("/");
    if (request.method === "GET" && ["overlay/", "overlay/control/", "overlay/preview/"].includes(route)) {
      return new Response(null, { status: 308, headers: { Location: `/${token}/${route.slice(0, -1)}`, "Referrer-Policy": "no-referrer" } });
    }
    // Overlay owns bounded bodies, same-origin writes and bounded streaming replies.
    if (rest[0] === "api" && rest[1] === "overlay") return overlay.handle(request, rest.slice(2).join("/"));
    // The URL token was checked before this dispatch. Live owns its larger,
    // stream-bounded SDP body limit and same-origin mutation checks; on a hub,
    // station residents' signaling is proxied to their own host.
    if (rest[0] === "api" && rest[1] === "live") return liveRouter.handle(request, rest.slice(2).join("/"));
    // Run status only; starting and stopping need a controller credential (/controller/v1/).
    if (request.method === "GET" && route === "api/runs") return runControl.statusReply();
    if (rest[0] === "api") {
      const key = `${request.method} ${rest.slice(1).join("/")}`;
      const handler = Object.hasOwn(routes, key) ? routes[key] : undefined;
      if (!handler) return refuse(404, "Not found.");
      if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return refuse(413, "That is too long.");
      const answer = await handler({ query: url.searchParams, body: () => request.json() });
      return answer instanceof Response ? answer : json(answer);
    }
    const type = STATIC[route];
    if (!type || request.method !== "GET") return refuse(404, "Not found.");
    const page = route === "overlay" ? "overlay.html" : route === "overlay/control" ? "overlay-control.html" : route === "overlay/preview" ? "overlay-preview.html" : route || "index.html";
    const file = Bun.file(join(config.publicDir, page));
    if (!await file.exists()) return refuse(404, "Not found.");
    return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  return {
    watcher, tail, stream, feed, db, federation,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/resident-api/v1/")) {
        return residentApi ? residentApi.fetch(request) : Response.json({ error: { code: "not_found", message: "Resident API is available only on the hub." } }, { status: 404 });
      }
      if (url.pathname.startsWith("/controller/v1/")) {
        // Bearer-authenticated, before and independent of the dashboard URL token.
        const response = await runControl.handleController(request, url.pathname.slice("/controller/v1/".length));
        if (request.method !== "GET" || response.status >= 400) log(`${request.method} ${url.pathname} -> ${response.status}`);
        return response;
      }
      const [given = "", ...rest] = url.pathname.replace(/^\//, "").split("/");
      const offered = Buffer.from(given);
      if (offered.length !== secret.length || !timingSafeEqual(offered, secret)) {
        log(`${request.method} without the token -> 404`);
        return refuse(404, "Not found.");
      }
      let response: Response;
      try { response = await handle(request, url, rest); }
      catch (error) {
        log(`request failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
        response = refuse(500, "The server hit a problem reading its data; this request was skipped.");
      }
      // The token is in every URL; keep it out of the journal. Polls that work are not worth a line each.
      if (request.method !== "GET" || response.status >= 400) log(`${request.method} /<token>/${rest.join("/")} -> ${response.status}`);
      return response;
    },
    start() { watcher.start(); if (config.role === "hub") feed.start(); federation?.start(); ingest?.start(); void context.readSessions(); },
    stop() {
      overlay.stop();
      runControl.stop();
      liveRouter.stop();
      // Abort capture and signal FFmpeg now; TERM → KILL/reap continues boundedly.
      void live.shutdown().catch(() => log("Live video encoder cleanup failed; restart Commons before streaming again."));
      residentApi?.close();
      ingest?.stop();
      federation?.stop(); watcher.stop(); feed.stop(); db.close();
    },
  };
}
