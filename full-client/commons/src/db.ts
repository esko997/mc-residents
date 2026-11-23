// Hub-owned shared database; central caretaker jobs also use it locally.
// Residents use HTTP rather than opening this file.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { record } from "./json.ts";
import { AUTO, LOOKED } from "./reviews.ts";

export function openCommons(path: string, schemaPath: string): Database {
  let schema: string;
  try { schema = readFileSync(schemaPath, "utf8"); }
  catch { throw new Error(`Cannot read the commons schema at ${schemaPath}. It ships next to this app as schema.sql.`); }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    // Before the schema: central caretaker jobs may hold the write lock.
    db.exec("PRAGMA busy_timeout = 3000;");
    db.exec(schema);
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch (error) { db.close(); throw error; }
}

export interface RunCounts {
  /** Every run. */
  total: number;
  /** Ran to the end and its expectation, when it has one, held. */
  passed: number;
  /** Ran to the end but nothing was checked: the skill declared no expectation at the time. */
  unchecked: number;
}
export interface SkillUser extends RunCounts { resident: string; isAuthor: boolean; lastAt: number }
export interface ReviewRow {
  id: number; reviewer: string; verdict: "keep" | "reject" | "comment"; text: string; at: number;
  /** About the item as it is now. False: written before its last change; history only. */
  current: boolean;
}
/**
 * Where an item stands for a reviewer. new: residents can see it (or, for a proposed note, are
 * waiting to) and nobody but `auto` has looked at it as it is now. kept: looked at and still
 * visible. removed: rejected. draft: a skill only its author sees.
 */
export type ReviewGroup = "new" | "kept" | "removed" | "draft";
export interface SkillView {
  group: ReviewGroup;
  id: number; name: string; author: string; description: string; code: string;
  params: Record<string, unknown>; expect: unknown; status: string; version: number;
  createdAt: number; updatedAt: number;
  /** Did it work: mechanical results, for the current version and for every version. */
  runs: { current: RunCounts; all: RunCounts };
  /** Is it worth having: who chose to run it. Residents other than the author are the signal. */
  users: SkillUser[];
  otherUsers: number;
  recentRuns: { resident: string; version: number; startedAt: number; ms: number; ok: boolean; checkOk: boolean | null; error: string | null; args: string }[];
  reviews: ReviewRow[];
  feedback: Feedback;
}
export interface NoteView {
  group: ReviewGroup;
  id: number; author: string; topic: string; text: string; status: string; createdAt: number; updatedAt: number;
  reviews: ReviewRow[];
  feedback: Feedback;
}
export interface FeedbackEntry {
  resident: string; worked: boolean; text: string; at: number;
  /** The skill version the verdict was about; null for notes. */
  version: number | null;
  /** About an older version of the skill than the one shown. */
  outdated: boolean;
}
/**
 * Residents' own verdicts ("worked for me" / "did not"), one per resident. A third figure beside
 * run results and reviews. The counts cover verdicts on the current version; older ones are `outdated`.
 */
export interface Feedback { worked: number; notWorked: number; outdated: number; entries: FeedbackEntry[] }

function parseJson(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string") return fallback;
  try { return JSON.parse(text); } catch { return text; }
}
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function commonsOverview(db: Database): { skills: SkillView[]; notes: NoteView[]; pending: number } {
  const reviewRows = new Map<string, Omit<ReviewRow, "current">[]>();
  for (const row of db.query<Omit<ReviewRow, "current"> & { kind: string; target_id: number }, []>(
    "SELECT id, kind, target_id, reviewer, verdict, text, at FROM reviews ORDER BY at DESC, id DESC").all()) {
    const key = `${row.kind}:${row.target_id}`;
    reviewRows.set(key, [...(reviewRows.get(key) ?? []), { id: row.id, reviewer: row.reviewer, verdict: row.verdict, text: row.text, at: row.at }]);
  }
  const judged = (kind: string, id: number, status: string, updatedAt: number): { reviews: ReviewRow[]; group: ReviewGroup } => {
    const reviews = (reviewRows.get(`${kind}:${id}`) ?? []).map(row => ({ ...row, current: row.at >= updatedAt }));
    const looked = reviews.some(row => row.current && row.reviewer !== AUTO);
    return {
      reviews,
      group: status === "rejected" ? "removed" : status === "draft" ? "draft" : status === "proposed" || !looked ? "new" : "kept",
    };
  };
  interface FeedbackRow { kind: string; target_id: number; resident: string; worked: number; text: string; version: number | null; at: number }
  const feedbackRows = db.query<FeedbackRow, []>("SELECT kind, target_id, resident, worked, text, version, at FROM feedback ORDER BY at DESC").all();
  const feedbackFor = (kind: string, id: number, version?: number): Feedback => {
    const entries = feedbackRows.filter(row => row.kind === kind && row.target_id === id).map((row): FeedbackEntry => ({
      resident: row.resident, worked: row.worked === 1, text: row.text, at: row.at, version: row.version,
      outdated: version !== undefined && row.version !== null && row.version !== version,
    }));
    const current = entries.filter(entry => !entry.outdated);
    return {
      worked: current.filter(entry => entry.worked).length, notWorked: current.filter(entry => !entry.worked).length,
      outdated: entries.length - current.length, entries,
    };
  };
  interface Group { skill_id: number; version: number; resident: string; total: number; passed: number; unchecked: number; last_at: number }
  const groups = db.query<Group, []>(`
    SELECT skill_id, version, resident, COUNT(*) AS total,
           SUM(ok = 1 AND COALESCE(check_ok, 1) = 1) AS passed,
           SUM(ok = 1 AND check_ok IS NULL) AS unchecked, MAX(started_at) AS last_at
    FROM skill_runs GROUP BY skill_id, version, resident`).all();
  interface RunRow { resident: string; version: number; started_at: number; ms: number; ok: number; check_ok: number | null; error: string | null; args_json: string }
  const recent = db.query<RunRow, [number]>(
    "SELECT resident, version, started_at, ms, ok, check_ok, error, args_json FROM skill_runs WHERE skill_id = ? ORDER BY started_at DESC, id DESC LIMIT 8");
  interface SkillRow {
    id: number; name: string; author: string; description: string; code: string; params_json: string;
    expect_json: string | null; status: string; version: number; created_at: number; updated_at: number;
  }
  const skills = db.query<SkillRow, []>("SELECT * FROM skills ORDER BY updated_at DESC, id DESC").all().map((row): SkillView => {
    const current: RunCounts = { total: 0, passed: 0, unchecked: 0 }, all: RunCounts = { total: 0, passed: 0, unchecked: 0 };
    const users = new Map<string, SkillUser>();
    for (const group of groups) {
      if (group.skill_id !== row.id) continue;
      // Minecraft names differ in letter case at most; "margo" and "Margo" are one resident.
      const key = group.resident.toLowerCase();
      const user = users.get(key) ?? { resident: group.resident, isAuthor: sameName(group.resident, row.author), total: 0, passed: 0, unchecked: 0, lastAt: 0 };
      users.set(key, user);
      for (const counts of group.version === row.version ? [current, all, user] : [all, user]) {
        counts.total += group.total; counts.passed += group.passed; counts.unchecked += group.unchecked;
      }
      user.lastAt = Math.max(user.lastAt, group.last_at);
    }
    const list = [...users.values()].sort((a, b) => Number(a.isAuthor) - Number(b.isAuthor) || b.total - a.total);
    return {
      id: row.id, name: row.name, author: row.author, description: row.description, code: row.code,
      params: record(parseJson(row.params_json, {})), expect: parseJson(row.expect_json, null),
      status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      runs: { current, all }, users: list, otherUsers: list.filter(user => !user.isAuthor).length,
      recentRuns: recent.all(row.id).map(run => ({
        resident: run.resident, version: run.version, startedAt: run.started_at, ms: run.ms, ok: run.ok === 1,
        checkOk: run.check_ok === null ? null : run.check_ok === 1, error: run.error, args: run.args_json,
      })),
      ...judged("skill", row.id, row.status, row.updated_at), feedback: feedbackFor("skill", row.id, row.version),
    };
  });
  interface NoteRow { id: number; author: string; topic: string; text: string; status: string; created_at: number; updated_at: number }
  const notes = db.query<NoteRow, []>("SELECT * FROM shared_notes ORDER BY updated_at DESC, id DESC").all().map((row): NoteView => ({
    id: row.id, author: row.author, topic: row.topic, text: row.text, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, ...judged("note", row.id, row.status, row.updated_at), feedback: feedbackFor("note", row.id),
  }));
  return { skills, notes, pending: [...skills, ...notes].filter(item => item.group === "new").length };
}

/** How many skills and notes are in the "new" group. The same rule as `commonsOverview`, in one query. */
export function pendingCount(db: Database): number {
  const looked = (kind: string) => `EXISTS (SELECT 1 FROM reviews r WHERE r.kind = '${kind}' AND r.target_id = i.id AND ${LOOKED})`;
  const row = db.query<{ n: number }, []>(`SELECT
    (SELECT COUNT(*) FROM skills i WHERE i.status IN ('verified', 'curated') AND NOT ${looked("skill")}) +
    (SELECT COUNT(*) FROM shared_notes i WHERE i.status = 'proposed' OR (i.status = 'curated' AND NOT ${looked("note")})) AS n`).get();
  return row?.n ?? 0;
}

export interface PositionSample { x: number; y: number; z: number; dimension: string; health?: number; food?: number }
export function recordPosition(db: Database, resident: string, at: number, sample: PositionSample) {
  db.query("INSERT OR REPLACE INTO positions (resident, at, x, y, z, dimension, health, food) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(resident, at, sample.x, sample.y, sample.z, sample.dimension, sample.health ?? null, sample.food === undefined ? null : Math.round(sample.food));
}

export const isOverworld = (dimension: unknown) => typeof dimension === "string" && /(^|:)overworld$/.test(dimension);

/**
 * A resident's overworld trail since a time, as [at, x, z] rounded to whole blocks.
 * Standing still adds no point (the one point keeps the latest time it was seen there, so
 * the gap to the next point is real travel time), and long trails are thinned to `maxPoints`.
 */
export function trail(db: Database, resident: string, since: number, maxPoints = 3000): [number, number, number][] {
  const rows = db.query<{ at: number; x: number; z: number; dimension: string }, [string, number]>(
    "SELECT at, x, z, dimension FROM positions WHERE resident = ? AND at >= ? ORDER BY at").all(resident, since);
  const points: [number, number, number][] = [];
  for (const row of rows) {
    if (!isOverworld(row.dimension)) continue;
    const x = Math.round(row.x), z = Math.round(row.z), last = points[points.length - 1];
    if (last && last[1] === x && last[2] === z) { last[0] = row.at; continue; }
    points.push([row.at, x, z]);
  }
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const thinned = Array.from({ length: maxPoints }, (_, index) => points[Math.floor(index * step)]);
  thinned[thinned.length - 1] = points[points.length - 1];
  return thinned;
}
