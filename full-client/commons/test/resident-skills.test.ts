import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openCommons } from "../src/db.ts";
import { skillsOperation, skillsReadOnlyOperations } from "../src/resident-skills.ts";
import type { SkillStart } from "../src/resident-contracts-skills.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function library() {
  const db = openCommons(":memory:", new URL("../schema.sql", import.meta.url).pathname);
  databases.push(db);
  return db;
}
const routine = { name: "look_up", description: "Looks straight up into the sky.", code: "return 1;", expect: { screen: "none" } };
const op = (db: Database, resident: string, operation: string, args: unknown) => skillsOperation(db, resident, operation, args);
const start = (db: Database, resident = "Gary", args: unknown = { name: routine.name }) => op(db, resident, "start_run", args) as SkillStart;
const record = (db: Database, resident: string, ticket: string, extra = {}) => op(db, resident, "record_run", { ticket, ms: 10, ok: true, checkOk: true, ...extra });

describe("resident skill hub", () => {
  test("whitelists operations, validates envelopes and refuses identity overrides", () => {
    const db = library();
    expect(skillsReadOnlyOperations).toEqual(["find", "show", "notes_shared"]);
    expect(() => op(db, "Gary", "constructor", {})).toThrow("Unknown skills operation");
    expect(() => op(db, "Gary", "save", [routine])).toThrow();
    const requests = [
      ["save", routine], ["find", {}], ["show", { name: routine.name }],
      ["start_run", { name: routine.name }], ["record_run", { ticket: crypto.randomUUID(), ms: 1, ok: true, checkOk: true }],
      ["note_share", { topic: "furnace", text: "Eight cobblestone make a furnace." }], ["notes_shared", {}],
      ["feedback", { skill: routine.name, worked: true }],
    ] as const;
    for (const [operation, args] of requests) {
      for (const key of ["resident", "author", "actor"]) {
        expect(() => op(db, "Gary", operation, { ...args, [key]: "Margo" })).toThrow();
      }
    }
    expect(db.query("SELECT * FROM skills").all()).toEqual([]);
    expect(db.query("SELECT * FROM shared_notes").all()).toEqual([]);
  });

  test("only an author can revise a skill or run its draft; run records bind opaque tickets to caller", () => {
    const db = library();
    op(db, "Gary", "save", routine);
    expect(() => op(db, "Margo", "save", { ...routine, code: "return 2;" })).toThrow("belongs to a skill by Gary");
    expect(() => start(db, "Margo")).toThrow("only Gary can run it");
    expect(op(db, "Margo", "find", {})).toBe("No skills yet. Save a routine that worked with skill_save.");
    const { ticket } = start(db, "Gary", { name: routine.name, args: { count: 3 } });
    expect(() => record(db, "Margo", ticket)).toThrow("unknown, expired or already recorded");
    expect(() => record(db, "Gary", crypto.randomUUID())).toThrow("unknown, expired or already recorded");
    expect(() => record(db, "Gary", ticket, { skill_id: 1 })).toThrow();
    expect(record(db, "Gary", ticket)).toEqual({ promoted: true });
    expect(() => record(db, "Gary", ticket)).toThrow("unknown, expired or already recorded");
    expect(db.query("SELECT resident, version, args_json FROM skill_runs").all()).toEqual([{ resident: "Gary", version: 1, args_json: '{"count":3}' }]);
    const shared = start(db, "Margo");
    expect(record(db, "Margo", shared.ticket)).toEqual({ promoted: false });
    expect(op(db, "Gary", "find", {})).toContain("check passed in 2 of 2 runs | used by 1 other resident");
  });

  test("a run records its captured version without promoting a concurrently saved revision", () => {
    const db = library();
    op(db, "Gary", "save", routine);
    const first = start(db);
    op(db, "Gary", "save", { ...routine, code: "return 2;" });
    const second = start(db);
    op(db, "Gary", "save", { ...routine, code: "return 3;" });
    expect(record(db, "Gary", first.ticket)).toEqual({ promoted: false });
    expect(record(db, "Gary", second.ticket)).toEqual({ promoted: false });
    expect(db.query("SELECT version, status FROM skills").all()).toEqual([{ version: 3, status: "draft" }]);
    expect(db.query("SELECT version FROM skill_runs ORDER BY id").all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(op(db, "Gary", "find", {})).toContain("check passed in 0 of 0 runs");
    const current = start(db);
    expect(record(db, "Gary", current.ticket)).toEqual({ promoted: true });
  });

  test("reviews during a run are not undone, and a changed author cannot receive its record", () => {
    const db = library();
    op(db, "Gary", "save", routine);
    const rejected = start(db);
    db.query("UPDATE skills SET status = 'rejected'").run();
    expect(record(db, "Gary", rejected.ticket)).toEqual({ promoted: false });
    expect(() => start(db)).toThrow("cannot be run");
    db.query("UPDATE skills SET status = 'draft'").run();
    const reassigned = start(db);
    db.query("UPDATE skills SET author = 'Margo'").run();
    expect(() => record(db, "Gary", reassigned.ticket)).toThrow("no longer exists");
    expect(db.query("SELECT COUNT(*) AS n FROM skill_runs").get()).toEqual({ n: 1 });
  });

  test("unchecked code cannot be promoted by supplying a fabricated check result", () => {
    const db = library();
    op(db, "Gary", "save", { name: routine.name, description: routine.description, code: routine.code });
    const { ticket } = start(db);
    expect(() => record(db, "Gary", ticket)).toThrow("does not match the captured skill version");
    expect(record(db, "Gary", ticket, { checkOk: null })).toEqual({ promoted: false });
    expect(db.query("SELECT status FROM skills").get()).toEqual({ status: "draft" });
  });

  test("notes and feedback preserve visibility, deduplication, limits and current-version counts", () => {
    const db = library(), note = { topic: "furnace", text: "Eight cobblestone make a furnace." };
    op(db, "Gary", "note_share", note);
    expect(op(db, "Gary", "note_share", note)).toContain("already proposed this note (#1, proposed)");
    expect(op(db, "Margo", "notes_shared", {})).toBe("No shared notes yet. note_share proposes one.");
    expect(() => op(db, "Margo", "feedback", { note: 1, worked: true })).toThrow("that you can see");
    db.query("UPDATE shared_notes SET status = 'curated' WHERE id = 1").run();
    op(db, "Gary", "feedback", { note: 1, worked: false });
    op(db, "Margo", "feedback", { note: 1, worked: true });
    expect(op(db, "Margo", "notes_shared", {})).toContain("worked for 1, not for 0");
    expect(op(db, "Margo", "feedback", { note: 1, worked: false })).toContain("replaces your earlier verdict (worked)");
    expect(op(db, "Gary", "notes_shared", {})).toContain("worked for 0, not for 1");
    for (let i = 0; i < 20; i++) op(db, "Gary", "note_share", { ...note, text: `${note.text} ${i}` });
    expect(() => op(db, "Gary", "note_share", { ...note, text: `${note.text} overflow` })).toThrow("20 notes waiting");
    op(db, "Gary", "save", routine);
    record(db, "Gary", start(db).ticket);
    op(db, "Margo", "feedback", { skill: routine.name, worked: true });
    expect(op(db, "Gary", "find", {})).toContain("worked for 1, not for 0");
    op(db, "Gary", "save", { ...routine, code: "return 2;" });
    expect(op(db, "Gary", "find", {})).toContain("no feedback yet");
    expect(db.query("SELECT version FROM feedback WHERE kind = 'skill'").get()).toEqual({ version: 1 });
  });
});
