// Notes panel: a read-only view of what a resident wrote for itself.
import { join } from "node:path";
import { caretakerNotes, residentFile, residentNotes, type CaretakerEntry, type NotesView } from "../notes.ts";
import { refuse, type Context, type Routes } from "./context.ts";
import { sharedPlaces } from "../resident-places.ts";

export interface NotesReply extends NotesView { name: string; caretaker: CaretakerEntry[] }

export function notesRoutes({ config, db, resident }: Context): Routes {
  return {
    async "GET notes"({ query }) {
      const who = resident(query.get("resident"));
      if (!who) return refuse(404, "No resident by that name.");
      const reply: NotesReply = {
        name: who.name, ...await residentNotes(who.dir),
        shared: { places: config.role === "hub" ? sharedPlaces(db) : [], deaths: [] },
        caretaker: await caretakerNotes(join(config.overseerDir, `${who.name}.md`)),
      };
      return reply;
    },
    async "GET file"({ query }) {
      const who = resident(query.get("resident"));
      const file = who && await residentFile(who.dir, query.get("path") ?? "");
      return file ?? refuse(404, "No such note file.");
    },
  };
}
