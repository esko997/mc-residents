// Activity panel: what each resident did, newest first, and signs of looping.
import type { Entry, Indicators, SessionInfo } from "../rollouts.ts";
import type { Context, Routes } from "./context.ts";

export interface ActivityReply {
  /** Changes when entry ids start over or stop naming the same entries: the server restarted, or read a file again. */
  boot: string;
  now: number; entries: Entry[];
  residents: { name: string; indicators: Indicators; sessions: SessionInfo[] }[];
}

export function activityRoutes({ config, tail, now, readSessions }: Context): Routes {
  return {
    async "GET activity"({ query }): Promise<ActivityReply> {
      await readSessions();
      const limit = Math.min(Math.max(Number(query.get("limit")) || 300, 1), 1000);
      // Ids restart with the process: a page holding ids from an earlier run must start over.
      const after = query.get("boot") === tail.boot ? Number(query.get("after")) || 0 : 0;
      return {
        boot: tail.boot, now: now(), entries: tail.recent({ after, limit }),
        residents: config.residents.map(resident => ({
          name: resident.name, indicators: tail.indicators(resident.name), sessions: tail.sessions(resident.name).slice(0, 5),
        })),
      };
    },
  };
}
