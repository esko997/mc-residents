// The web app: one page and a JSON API, everything under /<token>/. The token in
// the path is the only access control (home LAN), as with the phone chat page.
// Each panel's routes live in their own module under routes/.
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { openCommons } from "./db.ts";
import type { TextFile } from "./notes.ts";
import { RolloutTail } from "./rollouts.ts";
import { activityRoutes, type ActivityReply } from "./routes/activity.ts";
import { commonsRoutes, type CommonsReply } from "./routes/commons.ts";
import { json, refuse, type Context, type Routes } from "./routes/context.ts";
import { mapRoutes, type MapReply } from "./routes/map.ts";
import { notesRoutes, type NotesReply } from "./routes/notes.ts";
import { residentRoutes, type ResidentsReply } from "./routes/residents.ts";
import { Watcher } from "./watcher.ts";

/** The JSON each GET route under /<token>/api/ returns, for whoever reads it (the page, the tests). */
export interface Replies { residents: ResidentsReply; activity: ActivityReply; map: MapReply; commons: CommonsReply; notes: NotesReply; file: TextFile }

export interface App {
  fetch(request: Request): Promise<Response>;
  /** Begin watching the residents' clients and reading their sessions. */
  start(): void;
  stop(): void;
  watcher: Watcher;
  tail: RolloutTail;
  db: Database;
}

const STATIC: Record<string, string> = {
  "": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8",
};
const MAX_BODY = 8192;

export function createApp(config: Config, token: string, now: () => number = Date.now, log: (line: string) => void = console.log): App {
  const db = openCommons(config.dbPath, config.schemaPath);
  const watcher = new Watcher(config, db, now);
  const tail = new RolloutTail(config.sessionsDir, config.residents, { days: config.activityDays, now });
  let lastRead = 0;
  const context: Context = {
    config, db, watcher, tail, now,
    async readSessions() {
      if (now() - lastRead < 2000) return;
      lastRead = now();
      await tail.refresh();
    },
    resident: name => config.residents.find(resident => resident.name.toLowerCase() === name?.toLowerCase()),
  };
  const routes: Routes = {
    ...residentRoutes(context), ...activityRoutes(context), ...mapRoutes(context), ...notesRoutes(context), ...commonsRoutes(context),
  };
  const secret = Buffer.from(token);

  /** `rest` is the path after the token, split at slashes; empty for a bare /<token>. */
  async function handle(request: Request, url: URL, rest: string[]): Promise<Response> {
    // Without the trailing slash the page's own relative requests would lose the token.
    if (rest.length === 0) return new Response(null, { status: 308, headers: { Location: `/${token}/` } });
    const route = rest.join("/");
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
    const file = Bun.file(join(config.publicDir, route || "index.html"));
    if (!await file.exists()) return refuse(404, "Not found.");
    return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  }

  return {
    watcher, tail, db,
    async fetch(request) {
      const url = new URL(request.url);
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
    start() { watcher.start(); void context.readSessions(); },
    stop() { watcher.stop(); db.close(); },
  };
}
