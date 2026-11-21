// Commons panel: the review queue for skills and shared notes, and the caretaker's notes.
import { join } from "node:path";
import { commonsOverview, type NoteView, type SkillView } from "../db.ts";
import { record } from "../json.ts";
import { caretakerNotes, type CaretakerEntry } from "../notes.ts";
import { review } from "../reviews.ts";
import { json, refuse, type Context, type Routes } from "./context.ts";

export interface CommonsReply {
  now: number; skills: SkillView[]; notes: NoteView[]; pending: number;
  caretaker: { resident: string; entries: CaretakerEntry[] }[];
}

export function commonsRoutes({ config, db, now }: Context): Routes {
  return {
    async "GET commons"(): Promise<CommonsReply> {
      const caretaker = await Promise.all(config.residents.map(async resident => ({
        resident: resident.name, entries: await caretakerNotes(join(config.overseerDir, `${resident.name}.md`)),
      })));
      return { now: now(), ...commonsOverview(db), caretaker };
    },
    async "POST review"({ body }) {
      let request: unknown;
      try { request = await body(); } catch { return refuse(400, "Send JSON."); }
      const result = review(db, record(request), now());
      return result.ok ? json(result) : refuse(result.code, result.error);
    },
  };
}
