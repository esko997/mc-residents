// Residents panel: who is online, their vitals, units, tokens, and what they see.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pendingCount } from "../db.ts";
import { fileSize } from "../notes.ts";
import type { Quota, ThoughtSummary, TokenTotals } from "../rollouts.ts";
import { unitStates } from "../units.ts";
import type { Sighting } from "../watcher.ts";
import { refuse, type Context, type Routes } from "./context.ts";
import type { ObserverHealth, ObservedResident } from "../observer.ts";

interface UnitState { unit: string; state: string }
interface SessionHealth {
  status: string; reason: string; updated_at: number; end_at: number; thread_id: string | null;
  restart_count: number; next_retry_at: number | null; auto_restart: boolean;
}
async function sessionHealth(path: string): Promise<SessionHealth | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || !["starting", "healthy", "degraded", "restarting", "paused", "stopped", "failed"].includes(value.status)
      || !Number.isFinite(value.updated_at) || !Number.isFinite(value.end_at)) return null;
    return {
      status: value.status, reason: typeof value.reason === "string" ? value.reason.slice(0, 600) : "",
      updated_at: value.updated_at, end_at: value.end_at,
      thread_id: typeof value.thread_id === "string" ? value.thread_id : null,
      restart_count: Number.isInteger(value.restart_count) && value.restart_count >= 0 ? value.restart_count : 0,
      next_retry_at: Number.isFinite(value.next_retry_at) ? value.next_retry_at : null,
      auto_restart: value.auto_restart === true,
    };
  } catch { return null; }
}
export interface ResidentsReply {
  now: number; chatUrl: string | null;
  role: "hub" | "station";
  federationErrors: string[];
  /** Skills and notes waiting for a reviewer. */
  pending: number;
  quota: Quota | null; sampleSeconds: number; pictureSeconds: number;
  /** Units that belong to no single resident. */
  sharedUnits: UnitState[];
  observer: ObserverHealth;
  residents: (Sighting & { name: string; host: string; hostUnreachable: boolean; hostLastSeen: number | null; liveAvailable: boolean; audioAvailable: boolean; memoryBytes: number | null; units: UnitState[]; tokens: TokenTotals; pictureAt: number | null; sessionHealth: SessionHealth | null; serverObservation: ObservedResident | null;
    /** The newest thought or remark, and whether the latest session writes reasoning summaries. Dashboard only: never sent to the overlay. */
    thoughts: ThoughtSummary })[];
}

export function residentRoutes({ config, db, watcher, tail, now, readSessions, resident }: Context): Routes {
  return {
    async "GET residents"(): Promise<ResidentsReply> {
      await readSessions();
      const states = await unitStates(config.systemctl, config.units.map(entry => entry.unit));
      const unitsOf = (name?: string) => config.units.filter(entry => entry.resident === name).map(entry => ({ unit: entry.unit, state: states[entry.unit] }));
      return {
        now: now(), role: config.role, federationErrors: [],
        chatUrl: config.role === "hub" ? config.chatUrl ?? null : null,
        pending: config.role === "station" ? 0 : pendingCount(db), quota: tail.quota ?? null,
        sampleSeconds: config.sampleMs / 1000, pictureSeconds: config.pictureMs / 1000,
        sharedUnits: unitsOf(undefined),
        observer: watcher.observer.health(),
        residents: await Promise.all(config.residents.map(async entry => ({
          name: entry.name, ...watcher.sighting(entry.name),
          host: config.hostName, hostUnreachable: false, hostLastSeen: now(),
          // Hubs and stations both report their own Live setting; the hub merges reachability.
          liveAvailable: config.live?.enabled === true,
          audioAvailable: config.live?.enabled === true && config.live.audio === true && !!entry.audioSink,
          memoryBytes: await fileSize(join(entry.dir, "memory.md")),
          sessionHealth: await sessionHealth(join(config.home, "sessions", `${entry.name}-health.json`)),
          units: unitsOf(entry.name), tokens: tail.tokenTotals(entry.name), pictureAt: watcher.pictureAt(entry.name),
          thoughts: tail.thoughtSummary(entry.name),
          serverObservation: watcher.observer.resident(entry.name) ?? null,
        }))),
      };
    },

    async "GET picture"({ query }) {
      const who = resident(query.get("resident"));
      if (!who) return refuse(404, "No resident by that name.");
      const picture = await watcher.picture(who, query.get("fresh") === "1");
      if (!picture) return refuse(404, `No picture: ${who.name}'s client is not running.`);
      return new Response(picture.png, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Picture-At": String(picture.at) } });
    },
  };
}
