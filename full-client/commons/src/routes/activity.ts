// Activity panel: what each resident did, newest first, and signs of looping; and each resident's thoughts.
import type { Entry, Indicators, SessionInfo, SummaryState, Thought } from "../rollouts.ts";
import { refuse, type Context, type Routes } from "./context.ts";

export interface ActivityReply {
  /** Changes when entry ids start over or stop naming the same entries: the server restarted, or read a file again. */
  boot: string;
  now: number; entries: Entry[];
  residents: { name: string; indicators: Indicators; sessions: SessionInfo[] }[];
}

/** A resident's latest thoughts and remarks, newest first: at most 200, read from its own host's rollouts. */
export interface ThoughtsReply { now: number; resident: string; summaries: SummaryState; thoughts: Thought[] }

export function activityRoutes({ config, tail, now, readSessions, resident }: Context): Routes {
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

    async "GET thoughts"({ query }): Promise<ThoughtsReply | Response> {
      const who = resident(query.get("resident"));
      if (!who) return refuse(404, "No resident by that name.");
      await readSessions();
      const { summaries } = tail.thoughtSummary(who.name);
      return { now: now(), resident: who.name, summaries, thoughts: tail.thoughts(who.name) };
    },
  };
}
