// Pure resident skill tool contracts shared by the hub and local executor.
import { z } from "zod";

const finite = z.number().finite();
const skillName = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, "Use a snake_case name of 3 to 40 characters, such as make_sticks.");
const counts = z.record(z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Use item ids such as minecraft:stick."), z.number().int().min(1).max(2304));
const expectSchema = z.object({
  gain: counts.optional(), lose: counts.optional(),
  near: z.object({ x: finite, y: finite.optional(), z: finite, within: z.number().positive().max(128) }).strict().optional(),
  screen: z.string().trim().min(1).max(60).optional(),
}).strict().refine(e => Object.keys(e.gain ?? {}).length + Object.keys(e.lose ?? {}).length > 0 || e.near !== undefined || e.screen !== undefined, "Give at least one of gain, lose, near or screen.");
export type Expect = z.infer<typeof expectSchema>;

export const skillDefinitions = {
  skill_save: {
    description: "Save or update your own skill: a routine you can run again in one call with skill_run; save again under the same name to revise it. code is the body of an async JavaScript function. Inside it: `await body.<tool>(args)` calls one of your body tools and returns its text; a tool error is thrown as an error with .tool and .message, which the code may catch. `await state()` returns {pos, dimension, health, food, screen, lookingAt, held, hotbar, inventory, nearby, onFire, inWater, inLava, navigation}; inventory is item id -> total count, nearby lists entities with type, name, distance, hostile, x, y, z. `args` is what skill_run was given, `log(text)` adds a line to the run report, `await sleep(ms)` pauses. Nothing else exists there: no files, network, imports or timers. params names each args key and says what it means. expect is the check that proves a run worked: gain and lose ({item id: least change in count}), near ({x, y, z, within}), screen (screen name after the run, \"none\" for closed). Only a skill with expect can become verified and visible to the other residents. Changing code or expect makes it a draft again.",
    schema: z.object({
      name: skillName, description: z.string().trim().min(10).max(300), code: z.string().min(1).max(12000),
      params: z.record(z.string().regex(/^\w{1,24}$/), z.string().max(120)).optional(), expect: expectSchema.optional(),
    }).strict(),
  },
  skill_find: {
    description: "Search skills by words in their name and description; no query lists them all. Shows your own skills and everyone's verified or curated ones. Each line: name, status, author, what it does, args, how many runs passed the check, and how many other residents have used it.",
    schema: z.object({ query: z.string().trim().min(1).max(100).optional(), limit: z.number().int().min(1).max(10).optional() }).strict(),
  },
  skill_show: {
    description: "Show one skill in full: description, args, check, run record, review and code. from_line continues code that was cut.",
    schema: z.object({ name: skillName, from_line: z.number().int().min(1).optional() }).strict(),
  },
  skill_run: {
    description: "Run a skill by name. It stops early when you die, when a rescue or fight reflex starts, when a body tool error is not caught by the code, after 300 tool calls, or after max_seconds (default 120, at most 600). The reply says whether it finished, the check result with the observed numbers, what changed in your inventory, the time taken and the last log lines.",
    schema: z.object({ name: skillName, args: z.record(z.unknown()).optional(), max_seconds: z.number().min(1).max(600).optional() }).strict(),
  },
  note_share: {
    description: "Offer something you learned to the other residents: one fact or method per note, text up to 600 characters. They see it once it is accepted, usually within a minute; a caretaker may later edit or remove it.",
    schema: z.object({ topic: z.string().trim().min(3).max(60), text: z.string().trim().min(10).max(600) }).strict(),
  },
  notes_shared: {
    description: "Search the notes residents share: curated ones (reviewed and kept) from everyone, plus your own proposals with their status. No query lists the newest.",
    schema: z.object({ query: z.string().trim().min(1).max(100).optional(), limit: z.number().int().min(1).max(8).optional() }).strict(),
  },
  feedback: {
    description: "Say whether another resident's skill, or a curated shared note you acted on, worked for you: give skill (its name) or note (its number from notes_shared), worked true or false, and optionally text (up to 120 characters: when or why). One verdict per skill or note; a new one replaces your earlier one. The others see the count.",
    schema: z.object({ skill: skillName.optional(), note: z.number().int().positive().optional(), worked: z.boolean(), text: z.string().trim().max(120).optional() }).strict()
      .refine(a => (a.skill === undefined) !== (a.note === undefined), "Give either skill (a name) or note (a number), not both."),
  },
};
export type SkillArgs<K extends keyof typeof skillDefinitions> = z.infer<(typeof skillDefinitions)[K]["schema"]>;

export type Status = "draft" | "verified" | "curated" | "rejected";
export interface SkillRow {
  id: number; name: string; author: string; description: string; code: string;
  params_json: string; expect_json: string | null; status: Status; version: number;
}
/**
 * A skill with its three records, kept apart: runs of the current version (did it work),
 * other residents who ran any version (is it used), and other residents' verdicts on the
 * current version (did it help them).
 */
export interface Listed extends SkillRow { runs: number; passed: number; finished: number; users: number; helped: number; failed: number }
export interface NoteRow { id: number; author: string; topic: string; text: string; status: "proposed" | "curated" | "rejected"; helped: number; failed: number }

export interface SkillStart { skill: SkillRow; ticket: string }
export const skillRecordSchema = z.object({
  ticket: z.string().uuid(), ms: z.number().int().min(0).max(610_000),
  ok: z.boolean(), checkOk: z.boolean().nullable(), error: z.string().max(300).optional(),
}).strict();
export type SkillRecord = z.infer<typeof skillRecordSchema>;
