/**
 * The skill library and shared notes: what a resident worked out once and can
 * use again, kept in the commons so the other residents and their caretakers
 * see it too.
 *
 * A skill is JavaScript the resident wrote. It runs in an isolated interpreter
 * (sandbox.ts) whose only powers are the bridge built in `run` below:
 * `body.<tool>` for every body tool but the few in `closed`, `state`, `args`,
 * `log` and `sleep`. This file decides policy and keeps three records apart:
 * whether a run worked (skill_runs, from the declared check), whether the skill
 * is used (runs by residents other than its author) and whether it helped them
 * (their feedback); reviews are the caretaker's word on top.
 *
 * How a run sits beside the body's reflexes: skill_run itself is not a manual
 * action. Each body tool the code calls goes through the same path as a call
 * from the resident, so a look or click still takes over from a fight or meal
 * for just that call and reflexes work between calls. A rescue or fight that
 * starts during a run ends the run at once, before the code's next action could
 * take the body away from it.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Body } from "./body.ts";
import { openCommons } from "./commons.ts";
import type { ResidentEvent } from "./events.ts";
import { memoryBytes, runInSandbox, type Bridge, type Outcome } from "./sandbox.ts";
import { hostileEntity, nonempty, playerEntity, type State } from "./synapse.ts";

const maxCalls = 300, maxDepth = 2, maxSays = 5, replyLength = 1200;
/**
 * Skill code may call every body tool but these. Saving skills is the resident's
 * own act, as are the things it tells the others in its own name; a picture is
 * an image, which code cannot read.
 */
const closed: Record<string, string> = {
  skill_save: "skill_save cannot be called from skill code; save skills yourself.",
  note_share: "note_share cannot be called from skill code; share notes yourself.",
  feedback: "feedback cannot be called from skill code; give feedback yourself.",
  picture: "picture returns an image, which skill code cannot read; use state() or screen.",
};

const finite = z.number().finite();
const skillName = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, "Use a snake_case name of 3 to 40 characters, such as make_sticks.");
const counts = z.record(z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Use item ids such as minecraft:stick."), z.number().int().min(1).max(2304));
const expectSchema = z.object({
  gain: counts.optional(), lose: counts.optional(),
  near: z.object({ x: finite, y: finite.optional(), z: finite, within: z.number().positive().max(128) }).strict().optional(),
  screen: z.string().trim().min(1).max(60).optional(),
}).strict().refine(e => Object.keys(e.gain ?? {}).length + Object.keys(e.lose ?? {}).length > 0 || e.near !== undefined || e.screen !== undefined, "Give at least one of gain, lose, near or screen.");
type Expect = z.infer<typeof expectSchema>;

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
    description: "Offer something you learned to the other residents: one fact or method per note, text up to 600 characters. They see it only after a caretaker has reviewed it.",
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
type Args<K extends keyof typeof skillDefinitions> = z.infer<(typeof skillDefinitions)[K]["schema"]>;

/** What one top-level skill_run and the skills it calls share: one clock, one tool-call count, one reason to stop. */
class Budget {
  readonly controller = new AbortController();
  calls = 0; says = 0;
  /** Why the run is ending early; set once. */
  stopped?: string;
  /** Events up to this number have been returned by a `wait` inside the run. */
  eventCursor: number;
  readonly deadline: number;
  constructor(readonly seconds: number, eventCursor: number) { this.deadline = Date.now() + seconds * 1000; this.eventCursor = eventCursor; }
  stop(reason: string) {
    if (this.stopped !== undefined) return;
    this.stopped = reason; this.controller.abort();
  }
}
/** Passed to the body tools a skill calls, so they know they run inside one. */
export interface SkillRun { depth: number; shared: Budget }
export interface ToolReply { text: string; isError: boolean }

type Status = "draft" | "verified" | "curated" | "rejected";
interface SkillRow {
  id: number; name: string; author: string; description: string; code: string;
  params_json: string; expect_json: string | null; status: Status; version: number;
}
/**
 * A skill with its three records, kept apart: runs of the current version (did it work),
 * other residents who ran any version (is it used), and other residents' verdicts on the
 * current version (did it help them).
 */
interface Listed extends SkillRow { runs: number; passed: number; finished: number; users: number; helped: number; failed: number }
interface NoteRow { id: number; author: string; topic: string; text: string; status: "proposed" | "curated" | "rejected"; helped: number; failed: number }
/** What `state()` gives skill code; the check after a run reads the same thing. */
interface Snapshot {
  pos: State["pos"]; dimension: string; health: number; food: number; air?: number; screen: string;
  lookingAt: State["lookingAt"];
  /** Item id in the selected hotbar slot, or null for an empty hand. */
  held: string | null; selectedSlot: number; hotbar: { slot: number; item: string; count: number }[];
  /** Item id -> total count over inventory, armour and offhand. */
  inventory: Record<string, number>;
  /** The 24 nearest entities. */
  nearby: { type: string; name?: string; distance: number; hostile: boolean; player: boolean; x: number; y: number; z: number }[];
  onGround?: boolean; inWater?: boolean; inLava?: boolean; onFire?: boolean;
  /** The Baritone command still running, or null. */
  navigation: string | null;
}

const oneLine = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
const secondsText = (ms: number) => `${Math.round(ms / 100) / 10} s`;
/** Other residents' verdicts, a figure of its own beside runs and use. */
const verdicts = (counted: { helped: number; failed: number }) => counted.helped + counted.failed ? `worked for ${counted.helped}, not for ${counted.failed}` : "no feedback yet";
const words = (query?: string) => query?.toLowerCase().split(/[^a-z0-9:]+/).filter(Boolean) ?? [];
/** Entries holding every query word; when none does, those holding any. */
function matching<T>(entries: T[], query: string | undefined, text: (entry: T) => string): T[] {
  const wanted = words(query);
  if (!wanted.length) return entries;
  const scored = entries.map(entry => { const hay = text(entry).toLowerCase(); return { entry, hits: wanted.filter(word => hay.includes(word)).length }; });
  const all = scored.filter(s => s.hits === wanted.length);
  return (all.length ? all : scored.filter(s => s.hits > 0)).map(s => s.entry);
}
/** The first `limit` lines, as many as fit the reply, then how many of all the matches are not shown. */
function capped(head: string, lines: string[], limit: number) {
  let text = head, shown = 0;
  for (const line of lines.slice(0, limit)) {
    if (text.length + line.length + 1 > replyLength - 80) break;
    text += `\n${line}`; shown++;
  }
  return shown < lines.length ? `${text}\n${lines.length - shown} more not shown; use a narrower query${shown === limit ? " or a higher limit" : ""}.` : text;
}
function expectText(expect: Expect) {
  return [
    ...Object.entries(expect.gain ?? {}).map(([item, count]) => `gain ${count} ${item}`),
    ...Object.entries(expect.lose ?? {}).map(([item, count]) => `lose ${count} ${item}`),
    ...(expect.near ? [`end within ${expect.near.within} blocks of ${expect.near.x},${expect.near.y ?? "any y"},${expect.near.z}`] : []),
    ...(expect.screen ? [`screen ${expect.screen}`] : []),
  ].join("; ");
}
/** The declared check against what was observed. Every part states the observed value and what was needed. */
function evaluate(expect: Expect, before: Snapshot, after: Snapshot | undefined): { ok: boolean; text: string } {
  if (!after) return { ok: false, text: "Check FAILED: your state could not be read after the run." };
  const parts: { ok: boolean; text: string }[] = [];
  for (const [item, least] of Object.entries(expect.gain ?? {})) {
    const change = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
    parts.push({ ok: change >= least, text: `${item} changed by ${signed(change)}, needs +${least} or more` });
  }
  for (const [item, least] of Object.entries(expect.lose ?? {})) {
    const change = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
    parts.push({ ok: change <= -least, text: `${item} changed by ${signed(change)}, needs -${least} or less` });
  }
  if (expect.near) {
    const { x, y, z, within } = expect.near;
    const away = Math.hypot(after.pos.x - x, y === undefined ? 0 : after.pos.y - y, after.pos.z - z);
    parts.push({ ok: away <= within, text: `you are ${Math.round(away * 10) / 10} blocks from ${x},${y ?? "any y"},${z}, needs ${within} or less` });
  }
  if (expect.screen) parts.push({ ok: after.screen.toLowerCase() === expect.screen.toLowerCase(), text: `screen is ${after.screen}, needs ${expect.screen}` });
  const failed = parts.filter(p => !p.ok), passed = parts.filter(p => p.ok);
  if (!failed.length) return { ok: true, text: `Check passed: ${passed.map(p => p.text).join("; ")}.` };
  return { ok: false, text: `Check FAILED: ${failed.map(p => p.text).join("; ")}.${passed.length ? ` Passed: ${passed.map(p => p.text).join("; ")}.` : ""}` };
}
function inventoryChanges(before: Snapshot, after: Snapshot | undefined) {
  if (!after) return "Inventory changes: unknown.";
  const changes = [...new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])]
    .map(item => ({ item, change: (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0) }))
    .filter(c => c.change !== 0).sort((a, b) => b.change - a.change);
  if (!changes.length) return "Inventory changes: none.";
  return `Inventory changes: ${changes.slice(0, 8).map(c => `${signed(c.change)} ${c.item}`).join(", ")}${changes.length > 8 ? ` and ${changes.length - 8} more` : ""}.`;
}
/**
 * Events after which the body is no longer the skill's to drive: death, and the
 * reflexes that move it (rescues, fleeing, fighting), as body.ts words them.
 */
function takeover(event: ResidentEvent): string | undefined {
  if (event.type === "died") return `you died at ${event.at} in ${event.dimension}`;
  if (event.type === "reflex" && /^(\w+ rescue started|fleeing from|defending against)/.test(String(event.text))) return `a reflex took over your body (${oneLine(String(event.text), 100)})`;
  return undefined;
}
function stopReason(outcome: Exclude<Outcome, { kind: "finished" } | { kind: "unavailable" }>, seconds: number): string {
  switch (outcome.kind) {
    case "time": return `time limit of ${seconds} s reached while the code was still running`;
    case "cancelled": return "the call was cancelled";
    case "stalled": return "the code waits on a promise that nothing will ever resolve";
    case "syntax": return `syntax error${outcome.line ? ` at line ${outcome.line}` : ""}: ${outcome.message}`;
    case "error": {
      const where = outcome.line ? ` (line ${outcome.line})` : "";
      // A skill it called has already said which skill stopped and why.
      if (outcome.tool === "skill_run") return oneLine(outcome.message, 300);
      if (outcome.tool) return `${outcome.tool} failed and the code did not catch it${where}: ${oneLine(outcome.message, 300)}`;
      const memory = outcome.message === "out of memory" ? `; a skill may use ${memoryBytes / 1024 / 1024} MB` : "";
      return `${outcome.name}${where}: ${oneLine(outcome.message, 300)}${memory}`;
    }
  }
}

export class Skills {
  /** Default wall time of a run, seconds. */
  defaultSeconds = 120;
  /** The interpreter's worker file. If it cannot start, skills are neither checked nor run. */
  interpreter?: string;
  private database?: Database;
  /** The top-level skill running now; one body cannot follow two routines. */
  private active?: string;
  private readonly resident: string;
  constructor(
    private body: Body, private path: string | undefined,
    private invoke: (tool: string, args: unknown, signal: AbortSignal, run: SkillRun) => Promise<ToolReply>,
  ) { this.resident = body.config.name; }
  close() { this.database?.close(); this.database = undefined; }
  /** Opened on first use and retried on every call until it works, so a commons that appears later is picked up. */
  private db(): Database {
    if (this.database) return this.database;
    let reason = "COMMONS_DB is not set";
    if (this.path) {
      try { return this.database = openCommons(this.path); }
      catch (error) { reason = `${this.path}: ${error instanceof Error ? error.message : "cannot be opened"}`; }
    }
    throw new Error(`Skills and shared notes are unavailable: the commons database could not be opened (${reason}). Your other tools work as before.`);
  }
  private rejection(db: Database, kind: "skill" | "note", id: number) {
    const review = db.query<{ reviewer: string; text: string }, [string, number]>(
      "SELECT reviewer, text FROM reviews WHERE kind = ? AND target_id = ? AND verdict = 'reject' ORDER BY at DESC, id DESC LIMIT 1").get(kind, id);
    return review ? `rejected by ${review.reviewer}${review.text ? `: ${oneLine(review.text, 160)}` : ""}` : "rejected by a reviewer";
  }
  private statusText(db: Database, skill: SkillRow) {
    switch (skill.status) {
      case "draft": return "draft (only you see it)";
      case "verified": return "verified, not yet reviewed";
      case "curated": return "curated";
      case "rejected": return this.rejection(db, "skill", skill.id);
    }
  }
  /** Own skills in any state; from others only verified and curated ones. */
  private listed(db: Database, name?: string): Listed[] {
    return db.query<Listed, [string, string | null]>(`
      SELECT s.*,
        (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id = s.id AND r.version = s.version) AS runs,
        (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id = s.id AND r.version = s.version AND r.ok = 1 AND r.check_ok = 1) AS passed,
        (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id = s.id AND r.version = s.version AND r.ok = 1) AS finished,
        (SELECT COUNT(DISTINCT r.resident) FROM skill_runs r WHERE r.skill_id = s.id AND r.resident <> s.author) AS users,
        (SELECT COUNT(*) FROM feedback f WHERE f.kind = 'skill' AND f.target_id = s.id AND f.version = s.version AND f.resident <> s.author AND f.worked = 1) AS helped,
        (SELECT COUNT(*) FROM feedback f WHERE f.kind = 'skill' AND f.target_id = s.id AND f.version = s.version AND f.resident <> s.author AND f.worked = 0) AS failed
      FROM skills s WHERE (s.author = ?1 OR s.status IN ('verified', 'curated')) AND (?2 IS NULL OR s.name = ?2)`).all(this.resident, name ?? null);
  }
  private evidence(skill: Listed) {
    const worked = skill.expect_json ? `check passed in ${skill.passed} of ${plural(skill.runs, "run")}` : `finished ${skill.finished} of ${plural(skill.runs, "run")}, no check`;
    return `${worked} | used by ${plural(skill.users, "other resident")} | ${verdicts(skill)}`;
  }

  async save(args: Args<"skill_save">): Promise<string> {
    const db = this.db();
    const existing = db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(args.name);
    if (existing && existing.author !== this.resident) {
      const shared = existing.status === "verified" || existing.status === "curated";
      throw new Error(`The name ${args.name} belongs to a skill by ${existing.author}; nothing was saved. Choose another name${shared ? `, or use theirs (skill_show ${args.name})` : ""}.`);
    }
    const checked = (await runInSandbox({ code: args.code, check: true, deadline: Date.now() + 5000, entry: this.interpreter })).outcome;
    if (checked.kind === "syntax") {
      // Past the last line the parser has met the function's own closing brace: something in the code is still open.
      const where = !checked.line ? "" : checked.line > args.code.split("\n").length ? " at the end, where a brace, bracket or quote is still open" : ` at line ${checked.line}`;
      throw new Error(`Syntax error in code${where}: ${checked.message}. Nothing was saved.`);
    }
    if (checked.kind !== "finished") throw new Error(`Skills cannot be checked or run: the isolated interpreter is unavailable (${checked.kind === "unavailable" ? checked.message : checked.kind}). Nothing was saved.`);
    const full = (item: string) => item.includes(":") ? item : `minecraft:${item}`;
    const sorted = (list?: Record<string, number>) => list && Object.keys(list).length
      ? Object.fromEntries(Object.entries(list).map(([item, count]) => [full(item), count] as const).sort(([a], [b]) => a.localeCompare(b))) : undefined;
    const expect = args.expect && JSON.stringify({ gain: sorted(args.expect.gain), lose: sorted(args.expect.lose), near: args.expect.near, screen: args.expect.screen });
    const params = JSON.stringify(args.params ?? {});
    const now = Date.now();
    const unchecked = "It has no check, so it can never become verified or be seen by the other residents. To share it add expect: gain or lose for items it makes or uses up, near for the place it should end at, screen for a screen that should be open or closed.";
    const run = `Run it with skill_run ${args.name}`;
    if (!existing) {
      db.query("INSERT INTO skills (name, author, description, code, params_json, expect_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)")
        .run(args.name, this.resident, args.description, args.code, params, expect ?? null, now, now);
      return `Saved ${args.name} v1 as a draft; only you can see and run it. ${expect ? `${run}: the first run that passes its check makes it verified, and then the other residents can find it.` : `${unchecked} ${run}.`}`;
    }
    // A check proves one version of the code against one expectation; change either and the proof is gone.
    const changed = args.code !== existing.code || (expect ?? null) !== existing.expect_json;
    const version = existing.version + (changed ? 1 : 0), status: Status = changed ? "draft" : existing.status;
    db.query("UPDATE skills SET description = ?, code = ?, params_json = ?, expect_json = ?, status = ?, version = ?, updated_at = ? WHERE id = ?")
      .run(args.description, args.code, params, expect ?? null, status, version, now, existing.id);
    if (!changed) return `Updated the description and args of ${args.name} v${version}; code and check are unchanged, so it stays ${existing.status}.${existing.status === "rejected" ? " Change its code to make a new draft." : ""}`;
    return `Saved ${args.name} v${version}. Code or check changed, so it is a draft again${existing.status === "draft" ? "" : ` (it was ${existing.status})`}; only you can see and run it. ${expect ? `${run}: a run that passes its check makes it verified.` : `${unchecked} ${run}.`}`;
  }

  async find(args: Args<"skill_find">): Promise<string> {
    const db = this.db();
    const visible = this.listed(db);
    if (!visible.length) return "No skills yet. Save a routine that worked with skill_save.";
    const rate = (s: Listed) => s.runs ? s.passed / s.runs : 0;
    const found = matching(visible, args.query, s => `${s.name} ${s.name.replaceAll("_", " ")} ${s.description}`).sort((a, b) =>
      Number(b.status === "curated") - Number(a.status === "curated") || b.users - a.users || rate(b) - rate(a) || b.runs - a.runs || a.name.localeCompare(b.name));
    if (!found.length) return `No skills match "${args.query}". ${plural(visible.length, "skill")} in all; skill_find without a query lists them.`;
    const lines = found.map(skill => [
      skill.name, this.statusText(db, skill), skill.author === this.resident ? "by you" : `by ${skill.author}`, oneLine(skill.description, 110),
      `args: ${Object.keys(JSON.parse(skill.params_json) as object).join(", ") || "none"}`, this.evidence(skill),
    ].join(" | "));
    return capped(`${plural(found.length, "skill")}${args.query ? ` for "${args.query}"` : ""}. skill_show gives details, skill_run runs one.`, lines, args.limit ?? 5);
  }

  async show(args: Args<"skill_show">): Promise<string> {
    const db = this.db();
    const skill = this.listed(db, args.name)[0];
    if (!skill) throw new Error(`No skill named ${args.name} that you can see. skill_find lists yours and the shared ones.`);
    const head = `${skill.name} v${skill.version} | ${this.statusText(db, skill)} | ${skill.author === this.resident ? "by you" : `by ${skill.author}`}`;
    const details: string[] = [];
    if (args.from_line === undefined) {
      const params = Object.entries(JSON.parse(skill.params_json) as Record<string, string>);
      const runs = db.query<{ resident: string; version: number; ok: number; check_ok: number | null; error: string | null; ms: number }, [number]>(
        "SELECT resident, version, ok, check_ok, error, ms FROM skill_runs WHERE skill_id = ? ORDER BY started_at DESC, id DESC LIMIT 3").all(skill.id);
      const reviews = db.query<{ reviewer: string; verdict: string; text: string }, [number]>(
        "SELECT reviewer, verdict, text FROM reviews WHERE kind = 'skill' AND target_id = ? ORDER BY at DESC, id DESC LIMIT 2").all(skill.id);
      // Most telling first: when everything is at its longest the cut falls on the run list.
      details.push(
        oneLine(skill.description, 300),
        oneLine(`Args: ${params.map(([name, meaning]) => `${name} = ${oneLine(meaning, 60)}`).join("; ") || "none"}`, 220),
        oneLine(`Check: ${skill.expect_json ? expectText(JSON.parse(skill.expect_json) as Expect) : "none, so it cannot become verified"}`, 220),
        `Record of v${skill.version}: ${this.evidence(skill)}`,
        ...reviews.map(r => `Review by ${r.reviewer}: ${r.verdict}${r.text ? `, ${oneLine(r.text, 160)}` : ""}`),
        ...db.query<{ resident: string; worked: number; text: string }, [number, number, string]>(
          "SELECT resident, worked, text FROM feedback WHERE kind = 'skill' AND target_id = ? AND version = ? AND resident <> ? ORDER BY at DESC LIMIT 2").all(skill.id, skill.version, skill.author)
          .map(f => `${f.resident}: ${f.worked ? "worked for me" : "did not work for me"}${f.text ? `, ${oneLine(f.text, 120)}` : ""}`),
        ...(runs.length ? [`Latest runs: ${runs.map(r => `${r.resident} v${r.version} ${r.ok ? r.check_ok === 1 ? "check passed" : r.check_ok === 0 ? "check failed" : "finished" : `stopped (${oneLine(r.error ?? "unknown", 50)})`} ${secondsText(r.ms)}`).join(" | ")}`] : []),
      );
    }
    const code = skill.code.split("\n"), first = args.from_line ?? 1;
    if (first > code.length) throw new Error(`${skill.name} has ${plural(code.length, "line")} of code; from_line ${first} is past the end.`);
    let text = [head, ...details].join("\n"), last = first - 1;
    if (text.length > 900) text = `${text.slice(0, 899)}…`;
    const shown: string[] = [];
    // Room for the code after the two lines that frame it.
    let room = replyLength - text.length - 110;
    while (last < code.length && code[last]!.length + 1 <= room) { room -= code[last]!.length + 1; shown.push(code[last]!); last++; }
    // A single line longer than the room left would otherwise never be shown.
    if (!shown.length) { shown.push(`${code[last]!.slice(0, Math.max(room, 150))} … (line cut)`); last++; }
    text += `\nCode, lines ${first}-${last} of ${code.length}:\n${shown.join("\n")}`;
    return last < code.length ? `${text}\nCode cut after line ${last}; skill_show with from_line ${last + 1} continues.` : text;
  }

  private async snapshot(): Promise<Snapshot> {
    const state = await this.body.api.state(true);
    const inventory: Record<string, number> = {};
    const carried = state.inventory ? [...state.inventory.main, ...state.inventory.armor, state.inventory.offhand] : state.hotbar;
    for (const stack of carried) if (nonempty(stack)) inventory[stack.item] = (inventory[stack.item] ?? 0) + stack.count;
    const hotbar = state.hotbar.filter(nonempty).map(({ slot, item, count }) => ({ slot, item, count }));
    const navigation = this.body.navigation;
    return {
      pos: state.pos, dimension: state.dimension, health: state.health, food: state.food, air: state.air, screen: state.screen,
      lookingAt: state.lookingAt, held: hotbar.find(s => s.slot === state.selectedSlot)?.item ?? null, selectedSlot: state.selectedSlot, hotbar, inventory,
      nearby: [...(state.nearbyEntities ?? [])].sort((a, b) => a.distance - b.distance).slice(0, 24).map(e => ({
        type: e.type, name: e.name, distance: e.distance, hostile: hostileEntity(e), player: playerEntity(e), x: e.pos[0], y: e.pos[1], z: e.pos[2],
      })),
      onGround: state.onGround, inWater: state.inWater, inLava: state.inLava, onFire: state.onFire,
      navigation: navigation && !navigation.reported ? navigation.description : null,
    };
  }

  async run(args: Args<"skill_run">, signal?: AbortSignal, parent?: SkillRun): Promise<ToolReply> {
    const db = this.db();
    const skill = db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(args.name);
    const mine = skill?.author === this.resident;
    if (!skill) throw new Error(`No skill named ${args.name}. skill_find lists the ones you can run.`);
    if (skill.status === "rejected") throw new Error(`${skill.name} was ${this.rejection(db, "skill", skill.id)}; it cannot be run.${mine ? " Change its code with skill_save to make a new draft." : ""}`);
    if (skill.status === "draft" && !mine) throw new Error(`${skill.name} is a draft by ${skill.author}; only ${skill.author} can run it until a run passes its check.`);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > maxDepth) throw new Error(`Skills can call other skills only ${maxDepth} levels deep; ${skill.name} was not run.`);
    if (!parent && this.active) throw new Error(`Skill ${this.active} is still running; wait for it to finish.`);
    const argsJson = JSON.stringify(args.args ?? {});
    if (argsJson.length > 2000) throw new Error("args is too large: 2,000 characters of JSON at most.");
    const before = await this.snapshot();
    if (!parent && before.health <= 0) throw new Error("You are dead; respawn before running a skill.");
    if (!parent && this.body.rescuing) throw new Error(`A ${this.body.rescuing} rescue is moving your body; run the skill when it has ended.`);

    const shared = parent?.shared ?? new Budget(args.max_seconds ?? this.defaultSeconds, this.body.events.latest);
    const run: SkillRun = { depth, shared };
    const callsBefore = shared.calls;
    let inFlight: Promise<unknown> = Promise.resolve(), lastRead = -Infinity;
    const bridge: Bridge = {
      call: (tool, input) => {
        lastRead = -Infinity;
        const reply = this.bridgeCall(run, tool, input);
        inFlight = reply.catch(() => {});
        return reply;
      },
      state: async () => {
        // A loop polling state with nothing in between reads at most five times a second.
        const early = lastRead + 200 - performance.now();
        if (early > 0) await Bun.sleep(early);
        lastRead = performance.now();
        return JSON.stringify(await this.snapshot());
      },
    };
    const cancelled = () => shared.stop("the call was cancelled");
    let unsubscribe: (() => void) | undefined;
    if (!parent) {
      this.active = skill.name;
      unsubscribe = this.body.events.subscribe(event => { const reason = takeover(event); if (reason) shared.stop(reason); });
      if (signal?.aborted) cancelled(); else signal?.addEventListener("abort", cancelled, { once: true });
    }
    const startedAt = Date.now(), clock = performance.now();
    let why: string | undefined, value = "", logs: string[] = [], logCount = 0;
    try {
      const result = await runInSandbox({ code: skill.code, argsJson, bridge, deadline: shared.deadline, signal: shared.controller.signal, entry: this.interpreter });
      const outcome = result.outcome;
      ({ logs, logCount } = result);
      // Fail closed: code that cannot be isolated is not run at all.
      if (outcome.kind === "unavailable") throw new Error(`Skills cannot run: the isolated interpreter is unavailable (${outcome.message}). Nothing was run.`);
      if (outcome.kind === "finished") value = outcome.value;
      else {
        // A reason set from outside (death, reflex, limit, cancel) is the cause; the code's last error is its effect.
        why = (shared.stopped ?? stopReason(outcome, shared.seconds)).replace(/[.\s]+$/, "");
        if (outcome.kind === "time" || !parent) shared.stop(why);
      }
      // A tool call the code had started is not left running behind the reply; waits and crafts end on the stop above.
      const patience = Promise.withResolvers<void>(), timer = setTimeout(patience.resolve, 5000);
      await Promise.race([inFlight, patience.promise]);
      clearTimeout(timer);
    } finally {
      if (!parent) {
        this.active = undefined; unsubscribe?.();
        signal?.removeEventListener("abort", cancelled);
      }
    }
    const ms = Math.round(performance.now() - clock);
    const after = await this.snapshot().catch(() => undefined);
    const expect = skill.expect_json ? JSON.parse(skill.expect_json) as Expect : undefined;
    const check = expect && evaluate(expect, before, after);
    const ok = why === undefined;
    const lines: string[] = [];
    let promoted = false;
    try {
      db.query("INSERT INTO skill_runs (skill_id, version, resident, started_at, ms, ok, check_ok, error, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(skill.id, skill.version, this.resident, startedAt, ms, ok ? 1 : 0, check ? check.ok ? 1 : 0 : null, why ? oneLine(why, 300) : null, argsJson);
      if (ok && check?.ok) {
        promoted = db.query("UPDATE skills SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'draft' AND version = ? AND author = ?")
          .run(Date.now(), skill.id, skill.version, this.resident).changes > 0;
      }
    } catch (error) { lines.push(`This run was not recorded: ${oneLine(error instanceof Error ? error.message : "commons write failed", 120)}.`); }

    // To the skill that called this one a failure is an error to catch, so it gets the reason alone.
    if (parent && !ok) return { text: `${skill.name} stopped: ${oneLine(why!, 300)}`, isError: true };
    if (parent && check?.ok === false) return { text: `${skill.name} finished, but: ${oneLine(check.text, 300)}`, isError: true };
    const calls = plural(shared.calls - callsBefore, "tool call");
    const head = ok ? `Skill ${skill.name} v${skill.version} finished in ${secondsText(ms)}, ${calls}.` : `Skill ${skill.name} v${skill.version} STOPPED after ${secondsText(ms)}, ${calls}: ${oneLine(why!, 300)}.`;
    lines.unshift(head, check ? oneLine(check.text, 420) : "No check declared, so this skill cannot become verified.", inventoryChanges(before, after));
    if (after && after.screen !== "none") lines.push(`Screen open now: ${after.screen}.`);
    if (after?.navigation) lines.push(`Navigation still running: ${after.navigation}.`);
    if (promoted) lines.push(`${skill.name} is now verified: the other residents can find and run it. A caretaker will review it.`);
    else if (skill.status === "draft" && check) lines.push(`${skill.name} is still a draft: it becomes verified when a run finishes and passes its check.`);
    // The author's check says it ran as the author meant; only the one who used it knows whether that helped.
    const invitation = !parent && !mine ? `\nDid ${skill.name} do what you needed? Tell the others: feedback with skill ${skill.name} and worked true or false.` : "";
    // What the code returned is its answer to the resident: it gets the room the facts leave, ahead of the log.
    const room = replyLength - invitation.length - lines.join("\n").length - 12;
    if (value && room >= 40) lines.splice(3, 0, `Returned: ${oneLine(value, Math.min(room, 400))}`);
    let text = lines.join("\n");
    const tail: string[] = [];
    for (const line of [...logs].reverse()) {
      if (text.length + tail.reduce((sum, l) => sum + l.length + 1, 0) + line.length + 40 + invitation.length > replyLength) break;
      tail.unshift(line);
    }
    if (tail.length) text += `\nLog (last ${tail.length} of ${logCount}):\n${tail.join("\n")}`;
    if (text.length + invitation.length > replyLength) text = `${text.slice(0, replyLength - invitation.length - 1)}…`;
    return { text: text + invitation, isError: !ok || check?.ok === false };
  }

  /** One body tool call from skill code. A thrown error reaches the code, which may catch it. */
  private async bridgeCall(run: SkillRun, tool: string, input: unknown): Promise<string> {
    const shared = run.shared;
    if (shared.stopped !== undefined) throw new Error(`The run is stopping: ${shared.stopped}.`);
    if (Object.hasOwn(closed, tool)) throw new Error(closed[tool]);
    if (++shared.calls > maxCalls) {
      shared.calls = maxCalls;
      shared.stop(`tool-call limit of ${maxCalls} reached`);
      throw new Error(`The run is stopping: ${shared.stopped}.`);
    }
    if (tool === "say" && ++shared.says > maxSays) throw new Error(`A skill run may send at most ${maxSays} chat messages.`);
    const reply = await this.invoke(tool, input, shared.controller.signal, run);
    if (reply.isError) throw new Error(reply.text.replace(/^Error: /, ""));
    return reply.text;
  }

  async noteShare(args: Args<"note_share">): Promise<string> {
    const db = this.db();
    const same = db.query<{ id: number; status: string }, [string, string, string]>("SELECT id, status FROM shared_notes WHERE author = ? AND topic = ? AND text = ?").get(this.resident, args.topic, args.text);
    if (same) return `You already proposed this note (#${same.id}, ${same.status}); nothing was added.`;
    const waiting = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM shared_notes WHERE author = ? AND status = 'proposed'").get(this.resident)!.n;
    if (waiting >= 20) throw new Error("You have 20 notes waiting for review; nothing was added. Propose more after a caretaker has reviewed some.");
    const now = Date.now();
    const id = db.query("INSERT INTO shared_notes (author, topic, text, status, created_at, updated_at) VALUES (?, ?, ?, 'proposed', ?, ?)")
      .run(this.resident, args.topic, args.text, now, now).lastInsertRowid;
    return `Proposed note #${id} "${args.topic}". The other residents cannot see it yet: they will only after a caretaker has reviewed it. notes_shared shows its status.`;
  }

  async notesShared(args: Args<"notes_shared">): Promise<string> {
    const db = this.db();
    const visible = db.query<NoteRow, [string]>(`
      SELECT n.*,
        (SELECT COUNT(*) FROM feedback f WHERE f.kind = 'note' AND f.target_id = n.id AND f.resident <> n.author AND f.worked = 1) AS helped,
        (SELECT COUNT(*) FROM feedback f WHERE f.kind = 'note' AND f.target_id = n.id AND f.resident <> n.author AND f.worked = 0) AS failed
      FROM shared_notes n WHERE n.status = 'curated' OR n.author = ? ORDER BY n.status = 'curated' DESC, n.updated_at DESC, n.id DESC`).all(this.resident);
    if (!visible.length) return "No shared notes yet. note_share proposes one.";
    const found = matching(visible, args.query, note => `${note.topic} ${note.text}`);
    if (!found.length) return `No shared notes match "${args.query}". ${plural(visible.length, "note")} in all; notes_shared without a query lists the newest.`;
    const lines = found.map(note => {
      const mine = note.author === this.resident;
      const status = note.status === "curated" ? `curated, by ${mine ? "you" : note.author} | ${verdicts(note)}`
        : note.status === "proposed" ? "yours, waiting for review; others cannot see it" : `yours, ${this.rejection(db, "note", note.id)}; others cannot see it`;
      return `#${note.id} [${status}] ${note.topic}: ${oneLine(note.text, 600)}`;
    });
    return capped(`${plural(found.length, "shared note")}${args.query ? ` for "${args.query}"` : ""}.`, lines, args.limit ?? 3);
  }

  async feedback(args: Args<"feedback">): Promise<string> {
    const db = this.db();
    let target: { kind: "skill" | "note"; id: number; label: string; author: string; version: number | null };
    if (args.skill !== undefined) {
      const skill = this.listed(db, args.skill)[0];
      if (!skill) throw new Error(`No skill named ${args.skill} that you can see; no feedback was recorded.`);
      target = { kind: "skill", id: skill.id, label: `${skill.name} v${skill.version}`, author: skill.author, version: skill.version };
    } else {
      const note = db.query<{ id: number; topic: string; author: string }, [number, string]>(
        "SELECT id, topic, author FROM shared_notes WHERE id = ? AND (status = 'curated' OR author = ?)").get(args.note!, this.resident);
      if (!note) throw new Error(`No shared note #${args.note} that you can see; no feedback was recorded. notes_shared gives the numbers.`);
      target = { kind: "note", id: note.id, label: `note #${note.id} "${note.topic}"`, author: note.author, version: null };
    }
    const earlier = db.query<{ worked: number }, [string, number, string]>("SELECT worked FROM feedback WHERE kind = ? AND target_id = ? AND resident = ?").get(target.kind, target.id, this.resident);
    db.query(`INSERT INTO feedback (kind, target_id, resident, worked, text, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, target_id, resident) DO UPDATE SET worked = excluded.worked, text = excluded.text, version = excluded.version, at = excluded.at`)
      .run(target.kind, target.id, this.resident, args.worked ? 1 : 0, args.text ?? "", target.version, Date.now());
    return `Recorded: ${target.label} ${args.worked ? "worked for you" : "did not work for you"}.`
      + (earlier ? ` This replaces your earlier verdict (${earlier.worked ? "worked" : "did not work"}).` : "")
      + (target.author === this.resident ? " It is your own, so it is not counted in what the others see." : "");
  }
}
