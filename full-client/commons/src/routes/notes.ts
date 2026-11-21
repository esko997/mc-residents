// Notes panel: a read-only view of what a resident wrote for itself.
import { residentFile, residentNotes, type NotesView } from "../notes.ts";
import { refuse, type Context, type Routes } from "./context.ts";

export interface NotesReply extends NotesView { name: string }

export function notesRoutes({ config, resident }: Context): Routes {
  return {
    async "GET notes"({ query }) {
      const who = resident(query.get("resident"));
      if (!who) return refuse(404, "No resident by that name.");
      const reply: NotesReply = { name: who.name, ...await residentNotes(who.dir, config.sharedPlaces) };
      return reply;
    },
    async "GET file"({ query }) {
      const who = resident(query.get("resident"));
      const file = who && await residentFile(who.dir, query.get("path") ?? "");
      return file ?? refuse(404, "No such note file.");
    },
  };
}
