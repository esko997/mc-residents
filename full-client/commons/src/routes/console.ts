// Console panel: the merged stream of the server log and what players were shown,
// and the box that sends server commands.
import type { ConsoleLine, ServerState } from "../console.ts";
import { record } from "../json.ts";
import { json, refuse, type Context, type Routes } from "./context.ts";

export interface ConsoleReply {
  /** Changes when this app restarts and line ids and revisions start over. */
  boot: string;
  now: number;
  /** Pass as `after` next time. */
  rev: number;
  /** Lines added or changed since `after`, in time order. */
  lines: ConsoleLine[];
  /** Ids of lines withdrawn since `after`: the server log turned out to have them. */
  gone: number[];
  server: ServerState;
  /** Why the command box is off; null when commands can be sent. */
  commandsOff: string | null;
}

export function consoleRoutes({ stream, feed, now }: Context): Routes {
  return {
    async "GET console"({ query }): Promise<ConsoleReply> {
      // A page holding revisions from before a restart starts over.
      const after = query.get("boot") === stream.boot ? Number(query.get("after")) || 0 : 0;
      return { boot: stream.boot, now: now(), ...stream.since(after), server: stream.server, commandsOff: feed.commandsOff ?? null };
    },
    async "POST console/command"({ body }) {
      let request: unknown;
      try { request = await body(); } catch { return refuse(400, "Send JSON."); }
      const result = await feed.command(record(request).command);
      return result.ok ? json({ output: result.output }) : refuse(result.code, result.error);
    },
  };
}
