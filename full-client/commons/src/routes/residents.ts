// Residents panel: who is online, their vitals, units, tokens, and what they see.
import { join } from "node:path";
import { pendingCount } from "../db.ts";
import { fileSize } from "../notes.ts";
import type { Quota, TokenTotals } from "../rollouts.ts";
import { unitStates } from "../units.ts";
import type { Sighting } from "../watcher.ts";
import { refuse, type Context, type Routes } from "./context.ts";

interface UnitState { unit: string; state: string }
export interface ResidentsReply {
  now: number; chatUrl: string | null;
  /** Skills and notes waiting for a reviewer. */
  pending: number;
  quota: Quota | null; sampleSeconds: number; pictureSeconds: number;
  /** Units that belong to no single resident. */
  sharedUnits: UnitState[];
  residents: (Sighting & { name: string; memoryBytes: number | null; units: UnitState[]; tokens: TokenTotals; pictureAt: number | null })[];
}

export function residentRoutes({ config, db, watcher, tail, now, readSessions, resident }: Context): Routes {
  return {
    async "GET residents"(): Promise<ResidentsReply> {
      await readSessions();
      const states = await unitStates(config.systemctl, config.units.map(entry => entry.unit));
      const unitsOf = (name?: string) => config.units.filter(entry => entry.resident === name).map(entry => ({ unit: entry.unit, state: states[entry.unit] }));
      return {
        now: now(), chatUrl: config.chatUrl ?? null, pending: pendingCount(db), quota: tail.quota ?? null,
        sampleSeconds: config.sampleMs / 1000, pictureSeconds: config.pictureMs / 1000,
        sharedUnits: unitsOf(undefined),
        residents: await Promise.all(config.residents.map(async entry => ({
          name: entry.name, ...watcher.sighting(entry.name),
          memoryBytes: await fileSize(join(entry.dir, "memory.md")),
          units: unitsOf(entry.name), tokens: tail.tokenTotals(entry.name), pictureAt: watcher.pictureAt(entry.name),
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
