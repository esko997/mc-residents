// What a reviewer (a person in the page, or this app's automatic acceptance) may do
// to a skill or a shared note. Residents see things at once; review comes afterwards:
// keep, edit, remove with a reason, restore. Every action writes a `reviews` row.
//
// "Looked at" is per revision: a review counts only when its `at` is not older than
// the item's `updated_at`. So a status change or an edit made here writes both with
// one timestamp in one transaction, and a skill its author saved again is new again.
import type { Database } from "bun:sqlite";
import { finite, record } from "./json.ts";

/** The reviewer name of automatic acceptance. It never counts as someone having looked. */
export const AUTO = "auto";
export const AUTO_TEXT = "accepted automatically; nobody has looked at it yet";
/** SQL condition on a `reviews` row `r` and an item row `i`: this review is a look at the item as it is now. */
export const LOOKED = `r.reviewer != '${AUTO}' AND r.at >= i.updated_at`;

/**
 * Make every proposed shared note visible to the residents (status curated), each with a
 * review row by `auto`. Returns how many were accepted.
 */
export function autoAccept(db: Database, now = Date.now()): number {
  return db.transaction(() => {
    const waiting = db.query<{ id: number }, []>("SELECT id FROM shared_notes WHERE status = 'proposed'").all();
    for (const { id } of waiting) {
      db.query("UPDATE shared_notes SET status = 'curated', updated_at = ? WHERE id = ?").run(now, id);
      db.query("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES ('note', ?, ?, 'keep', ?, ?)").run(id, AUTO, AUTO_TEXT, now);
    }
    return waiting.length;
  }).immediate();
}

export type ReviewAction = "keep" | "remove" | "restore" | "comment" | "edit";
const ACTIONS: Record<string, ReviewAction> = { keep: "keep", remove: "remove", restore: "restore", comment: "comment", edit: "edit" };
export interface ReviewRequest {
  kind?: unknown; id?: unknown; action?: unknown; text?: unknown; reviewer?: unknown;
  /** The item's `updatedAt` as the page showed it; a different value now means it changed meanwhile. */
  updatedAt?: unknown;
  /** edit: note `{topic, text}`; skill `{description, params, expect}` with params and expect as JSON text. */
  fields?: unknown;
}
export type ReviewResult =
  | { ok: true; status: string; reviewId: number; /** edit: the names of the fields that changed. */ changed?: string[] }
  | { ok: false; code: 400 | 404 | 409; error: string };

const refuse = (code: 400 | 404 | 409, error: string): ReviewResult => ({ ok: false, code, error });

interface NoteRow { status: string; updated_at: number; topic: string; text: string }
interface SkillRow { status: string; updated_at: number; version: number; description: string; params_json: string; expect_json: string | null }
interface Change { column: string; value: string | number | null }
interface Edit { changes: Change[]; /** Field names as the reviewer knows them. */ names: string[]; checkChanged: boolean }
/** What the reviewer typed cannot be stored; the message says why, in words for the page. */
class Invalid extends Error {}

function editedNote(row: NoteRow, fields: Record<string, unknown>): Edit {
  const changes: Change[] = [];
  // The same limits the residents' note_share tool applies.
  for (const [name, min, max] of [["topic", 3, 60], ["text", 10, 600]] as const) {
    if (!(name in fields)) continue;
    const typed = fields[name], value = typeof typed === "string" ? typed.trim() : "";
    if (value.length < min || value.length > max) throw new Invalid(`The ${name} must be ${min} to ${max} characters; this is ${value.length}.`);
    if (value !== row[name]) changes.push({ column: name, value });
  }
  return { changes, names: changes.map(change => change.column), checkChanged: false };
}

function jsonObject(name: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Invalid(`${name} is not valid JSON: ${error instanceof Error ? error.message : "it cannot be read"}.`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Invalid(`${name} must be a JSON object in braces.`);
  return record(parsed);
}

function itemCounts(name: string, value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Invalid(`expect.${name} must be an object of item id to count, such as {"minecraft:stick": 4}.`);
  const counts: [string, number][] = [];
  for (const [item, count] of Object.entries(value)) {
    if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(item)) throw new Invalid(`expect.${name}: "${item}" is not an item id such as minecraft:stick.`);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 2304) throw new Invalid(`expect.${name}: the count of ${item} must be a whole number from 1 to 2304.`);
    counts.push([item.includes(":") ? item : `minecraft:${item}`, count]);
  }
  return counts.length ? Object.fromEntries(counts.sort(([a], [b]) => a.localeCompare(b))) : undefined;
}

/**
 * A skill's check, validated as the tool server validates it and written in the exact form the
 * tool server stores, so the same check saved again by its author compares equal. Throws Invalid.
 */
function canonicalExpect(value: Record<string, unknown>): string {
  const unknown = Object.keys(value).find(key => !["gain", "lose", "near", "screen"].includes(key));
  if (unknown) throw new Invalid(`expect has an unknown key "${unknown}". It may hold gain, lose, near and screen.`);
  const gain = itemCounts("gain", value.gain), lose = itemCounts("lose", value.lose);
  let near: { x: number; y?: number; z: number; within: number } | undefined;
  if (value.near !== undefined) {
    const raw = record(value.near), x = finite(raw.x), y = finite(raw.y), z = finite(raw.z), within = finite(raw.within);
    const extra = Object.keys(raw).some(key => !["x", "y", "z", "within"].includes(key));
    if (x === undefined || z === undefined || within === undefined || within <= 0 || within > 128 || (raw.y !== undefined && y === undefined) || extra) {
      throw new Invalid('expect.near must be {"x": number, "z": number, "within": blocks up to 128}, with "y" optional.');
    }
    near = { x, ...(y === undefined ? {} : { y }), z, within };
  }
  let screen: string | undefined;
  if (value.screen !== undefined) {
    screen = typeof value.screen === "string" ? value.screen.trim() : "";
    if (!screen || screen.length > 60) throw new Invalid("expect.screen must be a screen name of 1 to 60 characters.");
  }
  if (!gain && !lose && !near && !screen) throw new Invalid("expect needs at least one of gain, lose, near or screen. Leave the field empty for no check.");
  return JSON.stringify({ gain, lose, near, screen });
}

function editedSkill(row: SkillRow, fields: Record<string, unknown>): Edit {
  const changes: Change[] = [];
  let checkChanged = false;
  if ("description" in fields) {
    const value = typeof fields.description === "string" ? fields.description.trim() : "";
    if (value.length < 10 || value.length > 300) throw new Invalid(`The description must be 10 to 300 characters; this is ${value.length}.`);
    if (value !== row.description) changes.push({ column: "description", value });
  }
  if ("params" in fields) {
    const parsed = jsonObject("params", String(fields.params ?? "").trim() || "{}");
    for (const [name, meaning] of Object.entries(parsed)) {
      if (!/^\w{1,24}$/.test(name)) throw new Invalid(`params: "${name}" is not a name of 1 to 24 letters, digits or _.`);
      if (typeof meaning !== "string" || meaning.length > 120) throw new Invalid(`params: the meaning of ${name} must be text of at most 120 characters.`);
    }
    let before: unknown;
    try { before = JSON.parse(row.params_json); } catch { before = undefined; }
    if (JSON.stringify(parsed) !== JSON.stringify(before)) changes.push({ column: "params_json", value: JSON.stringify(parsed) });
  }
  if ("expect" in fields) {
    const typed = String(fields.expect ?? "").trim();
    const value = typed && typed !== "null" ? canonicalExpect(jsonObject("expect", typed)) : null;
    // Compare meanings, not spellings: the stored text may have been written with other spacing.
    let before = row.expect_json;
    try { if (before !== null) before = canonicalExpect(record(JSON.parse(before))); } catch { /* compare with the stored text as it is */ }
    if (value !== before) { changes.push({ column: "expect_json", value }); checkChanged = true; }
  }
  const labels: Record<string, string> = { params_json: "params", expect_json: "expect" };
  return { changes, names: changes.map(change => labels[change.column] ?? change.column), checkChanged };
}

/** Carry out one review action. One transaction, one timestamp for the review row and the item. */
export function review(db: Database, request: ReviewRequest, now = Date.now()): ReviewResult {
  const { kind, id } = request;
  if (kind !== "skill" && kind !== "note") return refuse(400, "kind must be skill or note.");
  if (typeof id !== "number" || !Number.isInteger(id)) return refuse(400, "id must be a whole number.");
  const action = typeof request.action === "string" && Object.hasOwn(ACTIONS, request.action) ? ACTIONS[request.action] : undefined;
  if (!action) return refuse(400, "action must be keep, remove, restore, comment or edit.");
  const reviewer = typeof request.reviewer === "string" ? request.reviewer.trim().replace(/\s+/g, " ") : "";
  if (!reviewer || reviewer.length > 40) return refuse(400, "Say who is reviewing: a name of 1 to 40 characters.");
  if (reviewer.toLowerCase() === AUTO) return refuse(400, `"${AUTO}" is the name automatic acceptance signs with. Type your own name.`);
  // Residents are shown this text; keep it one plain line.
  const said = typeof request.text === "string" ? request.text.trim().replace(/\s+/g, " ") : "";
  if (said.length > 600) return refuse(400, `The reason is ${said.length} characters; the limit is 600.`);
  if (action === "remove" && !said) return refuse(400, "Removing needs a reason: its author is shown it and learns from it.");
  if (action === "comment" && !said) return refuse(400, "Write the comment first.");
  const table = kind === "skill" ? "skills" : "shared_notes";

  return db.transaction((): ReviewResult => {
    const row = db.query<NoteRow & SkillRow, [number]>(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) return refuse(404, `There is no ${kind} with id ${id}.`);
    if (request.updatedAt !== undefined && request.updatedAt !== row.updated_at) {
      return refuse(409, `This ${kind} changed while you were reading it${kind === "skill" ? ` (it is now version ${row.version})` : ""}. Read it again, then decide.`);
    }
    let status = row.status, version = row.version, words = said, changed: string[] | undefined;
    const set: Change[] = [];
    if (action === "keep") {
      if (row.status === "rejected") return refuse(409, `This ${kind} was removed. Use Restore to bring it back.`);
      if (row.status === "draft") return refuse(409, "A draft cannot be kept: it has not passed its own check yet. Remove it or leave a comment.");
      status = "curated";
    } else if (action === "remove") {
      if (row.status === "rejected") return refuse(409, `This ${kind} is already removed.`);
      status = "rejected";
    } else if (action === "restore") {
      if (row.status !== "rejected") return refuse(409, `This ${kind} is not removed; there is nothing to restore.`);
      // A skill is shown to everyone only once this version has passed its check; one that never did goes back to its author.
      const proven = kind === "note" || db.query("SELECT 1 FROM skill_runs WHERE skill_id = ? AND version = ? AND ok = 1 AND check_ok = 1 LIMIT 1").get(id, row.version) !== null;
      status = proven ? "curated" : "draft";
      words = `restored${said ? `: ${said}` : ""}`;
    } else if (action === "edit") {
      let edit: Edit;
      try { edit = kind === "note" ? editedNote(row, record(request.fields)) : editedSkill(row, record(request.fields)); }
      catch (error) { if (error instanceof Invalid) return refuse(400, error.message); throw error; }
      if (!edit.changes.length) return refuse(400, "Nothing was changed.");
      set.push(...edit.changes);
      changed = edit.names;
      // As in the tool server: a check proves one version against one expectation. Change the expectation and the proof is gone.
      if (edit.checkChanged) { version = row.version + 1; if (row.status !== "rejected") status = "draft"; }
      words = `edited: ${changed.join(", ")}${said ? `; ${said}` : ""}`;
    }
    // The caretaker's script writes skill reviews the same way: which version the words are about.
    const text = kind === "skill" ? `v${version}${words ? `: ${words}` : ""}` : words;
    const verdict = action === "remove" ? "reject" : action === "keep" || action === "restore" ? "keep" : "comment";
    const inserted = db.query("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)").run(kind, id, reviewer, verdict, text, now);
    if (status !== row.status) set.push({ column: "status", value: status });
    if (kind === "skill" && version !== row.version) set.push({ column: "version", value: version });
    if (set.length) {
      db.query(`UPDATE ${table} SET ${set.map(change => `${change.column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...set.map(change => change.value), now, id);
    }
    return { ok: true, status, reviewId: Number(inserted.lastInsertRowid), ...(changed ? { changed } : {}) };
  }).immediate();
}
