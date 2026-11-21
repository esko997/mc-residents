// What every route module gets, and the shape of a route. A new panel or action
// is one more module here: export a function from Context to Routes and add it
// to the list in app.ts. Everything is served under /<token>/api/<route>.
import type { Database } from "bun:sqlite";
import type { Config, ResidentConfig } from "../config.ts";
import type { RolloutTail } from "../rollouts.ts";
import type { Watcher } from "../watcher.ts";

export interface Context {
  config: Config;
  db: Database;
  watcher: Watcher;
  tail: RolloutTail;
  now(): number;
  /** Read what the session files gained, at most every two seconds. */
  readSessions(): Promise<void>;
  /** A resident by name, any letter case. */
  resident(name: string | null): ResidentConfig | undefined;
}
export interface Ask {
  query: URLSearchParams;
  /** The JSON body of a POST; rejects when it is not JSON. */
  body(): Promise<unknown>;
}
/** Returns the JSON to send with status 200, or a whole Response (a picture, an error with its status). */
export type Handler = (ask: Ask) => Promise<object | Response>;
/** Keyed by method and route: "GET residents", "POST review". */
export type Routes = Record<string, Handler>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
/** An error the page shows to the person as is. */
export const refuse = (status: number, error: string) => json({ error }, status);
