// Shared skill, note and feedback storage. No body or sandbox dependencies.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { skillDefinitions, skillRecordSchema, type SkillArgs, type Expect, type Status, type SkillRow, type Listed, type NoteRow, type SkillStart, type SkillRecord } from "./resident-contracts-skills.ts";

const replyLength = 1200;
const oneLine = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
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

interface RunTicket { resident: string; skill: SkillRow; argsJson: string; startedAt: number }
const tickets = new WeakMap<Database, Map<string, RunTicket>>();
const ticketLifetime = 15 * 60_000;

class SkillStore {
  constructor(private database: Database, private resident: string) {}
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

  save(args: SkillArgs<"skill_save">): string {
    const db = this.database;
    const existing = db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(args.name);
    if (existing && existing.author !== this.resident) {
      const shared = existing.status === "verified" || existing.status === "curated";
      throw new Error(`The name ${args.name} belongs to a skill by ${existing.author}; nothing was saved. Choose another name${shared ? `, or use theirs (skill_show ${args.name})` : ""}.`);
    }
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

  find(args: SkillArgs<"skill_find">): string {
    const db = this.database;
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

  show(args: SkillArgs<"skill_show">): string {
    const db = this.database;
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

  noteShare(args: SkillArgs<"note_share">): string {
    const db = this.database;
    const same = db.query<{ id: number; status: string }, [string, string, string]>("SELECT id, status FROM shared_notes WHERE author = ? AND topic = ? AND text = ?").get(this.resident, args.topic, args.text);
    if (same) return `You already proposed this note (#${same.id}, ${same.status}); nothing was added.`;
    const waiting = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM shared_notes WHERE author = ? AND status = 'proposed'").get(this.resident)!.n;
    if (waiting >= 20) throw new Error("You have 20 notes waiting for review; nothing was added. Propose more after a caretaker has reviewed some.");
    const now = Date.now();
    const id = db.query("INSERT INTO shared_notes (author, topic, text, status, created_at, updated_at) VALUES (?, ?, ?, 'proposed', ?, ?)")
      .run(this.resident, args.topic, args.text, now, now).lastInsertRowid;
    return `Proposed note #${id} "${args.topic}". The other residents see it once it is accepted, usually within a minute; a caretaker may later edit or remove it. notes_shared shows its status.`;
  }

  notesShared(args: SkillArgs<"notes_shared">): string {
    const db = this.database;
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

  feedback(args: SkillArgs<"feedback">): string {
    const db = this.database;
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
  startRun(args: SkillArgs<"skill_run">): SkillStart {
    const db = this.database;
    const skill = db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(args.name);
    const mine = skill?.author === this.resident;
    if (!skill) throw new Error(`No skill named ${args.name}. skill_find lists the ones you can run.`);
    if (skill.status === "rejected") throw new Error(`${skill.name} was ${this.rejection(db, "skill", skill.id)}; it cannot be run.${mine ? " Change its code with skill_save to make a new draft." : ""}`);
    if (skill.status === "draft" && !mine) throw new Error(`${skill.name} is a draft by ${skill.author}; only ${skill.author} can run it until a run passes its check.`);
    const argsJson = JSON.stringify(args.args ?? {});
    if (argsJson.length > 2000) throw new Error("args is too large: 2,000 characters of JSON at most.");
    let pending = tickets.get(db);
    if (!pending) { pending = new Map(); tickets.set(db, pending); }
    const startedAt = Date.now();
    for (const [key, value] of pending) if (startedAt - value.startedAt > ticketLifetime) pending.delete(key);
    if (pending.size >= 1000) throw new Error("Too many skill runs are awaiting their record; try again after they finish.");
    const ticket = randomUUID();
    pending.set(ticket, { resident: this.resident, skill, argsJson, startedAt });
    return { skill, ticket };
  }

  recordRun(args: SkillRecord): { promoted: boolean } {
    const db = this.database, pending = tickets.get(db), captured = pending?.get(args.ticket);
    if (!captured || captured.resident !== this.resident || Date.now() - captured.startedAt > ticketLifetime)
      throw new Error("This skill run is unknown, expired or already recorded.");
    const { skill, argsJson, startedAt } = captured;
    if ((skill.expect_json === null) !== (args.checkOk === null)) throw new Error("The run check does not match the captured skill version.");
    // A save or review may have happened during execution. Record the captured version,
    // but only its author may promote that exact version, still in draft state.
    const promoted = db.transaction(() => {
      const exists = db.query<{ id: number }, [number, string, string]>("SELECT id FROM skills WHERE id = ? AND name = ? AND author = ?").get(skill.id, skill.name, skill.author);
      if (!exists) throw new Error("The skill for this run no longer exists.");
      db.query("INSERT INTO skill_runs (skill_id, version, resident, started_at, ms, ok, check_ok, error, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(skill.id, skill.version, this.resident, startedAt, args.ms, args.ok ? 1 : 0, args.checkOk === null ? null : args.checkOk ? 1 : 0, args.error ?? null, argsJson);
      return args.ok && args.checkOk === true && skill.author === this.resident && db.query("UPDATE skills SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'draft' AND version = ? AND author = ?")
        .run(Date.now(), skill.id, skill.version, skill.author).changes > 0;
    }).immediate();
    pending!.delete(args.ticket);
    return { promoted };
  }
}

export const skillsReadOnlyOperations = ["find", "show", "notes_shared"] as const;

/** Identity comes only from the authenticated caller; every request schema is strict. */
export function skillsOperation(db: Database, resident: string, operation: string, args: unknown): unknown {
  const store = new SkillStore(db, resident);
  switch (operation) {
    case "save": return db.transaction(() => store.save(skillDefinitions.skill_save.schema.parse(args))).immediate();
    case "find": return store.find(skillDefinitions.skill_find.schema.parse(args));
    case "show": return store.show(skillDefinitions.skill_show.schema.parse(args));
    case "start_run": return store.startRun(skillDefinitions.skill_run.schema.parse(args));
    case "record_run": return store.recordRun(skillRecordSchema.parse(args));
    case "note_share": return db.transaction(() => store.noteShare(skillDefinitions.note_share.schema.parse(args))).immediate();
    case "notes_shared": return store.notesShared(skillDefinitions.notes_shared.schema.parse(args));
    case "feedback": return db.transaction(() => store.feedback(skillDefinitions.feedback.schema.parse(args))).immediate();
    default: throw new Error("Unknown skills operation.");
  }
}
