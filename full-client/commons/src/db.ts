// The commons database: skills, their runs, shared notes, reviews and position
// samples. Each resident's tool server writes here too, hence WAL and a busy timeout.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { record } from "./json.ts";

export function openCommons(path: string, schemaPath: string): Database {
  let schema: string;
  try { schema = readFileSync(schemaPath, "utf8"); }
  catch { throw new Error(`Cannot read the commons schema at ${schemaPath}. It ships next to this app as schema.sql.`); }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // Before the schema, whose first statement switches to WAL: another process may hold the file right now.
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(schema);
  return db;
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
export interface ReviewRow { id: number; reviewer: string; verdict: "keep" | "reject" | "comment"; text: string; at: number }
export interface SkillView {
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
  const reviews = new Map<string, ReviewRow[]>();
  for (const row of db.query<ReviewRow & { kind: string; target_id: number }, []>(
    "SELECT id, kind, target_id, reviewer, verdict, text, at FROM reviews ORDER BY at DESC, id DESC").all()) {
    const key = `${row.kind}:${row.target_id}`;
    reviews.set(key, [...(reviews.get(key) ?? []), { id: row.id, reviewer: row.reviewer, verdict: row.verdict, text: row.text, at: row.at }]);
  }
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
      reviews: reviews.get(`skill:${row.id}`) ?? [], feedback: feedbackFor("skill", row.id, row.version),
    };
  });
  interface NoteRow { id: number; author: string; topic: string; text: string; status: string; created_at: number; updated_at: number }
  const notes = db.query<NoteRow, []>("SELECT * FROM shared_notes ORDER BY updated_at DESC, id DESC").all().map((row): NoteView => ({
    id: row.id, author: row.author, topic: row.topic, text: row.text, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, reviews: reviews.get(`note:${row.id}`) ?? [], feedback: feedbackFor("note", row.id),
  }));
  return {
    skills, notes,
    pending: skills.filter(skill => skill.status === "verified").length + notes.filter(note => note.status === "proposed").length,
  };
}

export function pendingCount(db: Database): number {
  const row = db.query<{ n: number }, []>(
    "SELECT (SELECT COUNT(*) FROM skills WHERE status = 'verified') + (SELECT COUNT(*) FROM shared_notes WHERE status = 'proposed') AS n").get();
  return row?.n ?? 0;
}

export interface ReviewRequest { kind?: unknown; id?: unknown; verdict?: unknown; text?: unknown; reviewer?: unknown; version?: unknown }
export type ReviewResult = { ok: true; status: string; reviewId: number } | { ok: false; code: 400 | 404 | 409; error: string };

/** Record a verdict and, for keep or reject, move the skill or note to its new status. One transaction. */
export function review(db: Database, request: ReviewRequest, now = Date.now()): ReviewResult {
  const { kind, id, verdict } = request;
  if (kind !== "skill" && kind !== "note") return { ok: false, code: 400, error: "kind must be skill or note." };
  if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, code: 400, error: "id must be a whole number." };
  if (verdict !== "keep" && verdict !== "reject" && verdict !== "comment") return { ok: false, code: 400, error: "verdict must be keep, reject or comment." };
  const reviewer = typeof request.reviewer === "string" ? request.reviewer.trim().replace(/\s+/g, " ") : "";
  if (!reviewer || reviewer.length > 40) return { ok: false, code: 400, error: "Say who is reviewing: a name of 1 to 40 characters." };
  // Residents may be shown this text; keep it one plain line.
  const text = typeof request.text === "string" ? request.text.trim().replace(/\s+/g, " ") : "";
  if (text.length > 600) return { ok: false, code: 400, error: `The reason is ${text.length} characters; the limit is 600.` };
  if (verdict === "reject" && !text) return { ok: false, code: 400, error: "A rejection needs a reason, so its author learns something from it." };
  if (verdict === "comment" && !text) return { ok: false, code: 400, error: "Write the comment first." };
  const table = kind === "skill" ? "skills" : "shared_notes";
  const status = verdict === "keep" ? "curated" : verdict === "reject" ? "rejected" : undefined;
  return db.transaction((): ReviewResult => {
    const row = db.query<{ status: string; version?: number }, [number]>(
      `SELECT status${kind === "skill" ? ", version" : ""} FROM ${table} WHERE id = ?`).get(id);
    if (!row) return { ok: false, code: 404, error: `There is no ${kind} with id ${id}.` };
    if (kind === "skill" && request.version !== undefined && request.version !== row.version) {
      return { ok: false, code: 409, error: `This skill changed while you were reading it (now version ${row.version}). Read the new code, then decide.` };
    }
    if (kind === "skill" && verdict === "keep" && row.status === "draft") {
      return { ok: false, code: 409, error: "A draft cannot be kept: it has not passed its own check yet. Reject it or leave a comment." };
    }
    const inserted = db.query("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kind, id, reviewer, verdict, text, now);
    if (status) db.query(`UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
    return { ok: true, status: status ?? row.status, reviewId: Number(inserted.lastInsertRowid) };
  }).immediate();
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
