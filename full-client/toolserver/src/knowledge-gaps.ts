import type { Database } from "bun:sqlite";
import { z } from "zod";

export const KNOWLEDGE_SCOPE = "Minecraft Java 1.20.1; Forge; Mekanism/Generators 10.4.16.80; Refined Storage 1.12.4; Immersive Engineering 10.2.0-183. Installed recipes/JEI override generic recipes.";
export const normalizeQuestion = (question: string): string => (question.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

export const guideFeedbackDefinition = {
  description: "Report an unhelpful or inaccurate guide/reference, with the question and what failed. Queues caretaker research, not a tested skill or a promise of success. Use the displayed topic/book source or ref-N handle as target.",
  schema: z.object({ target: z.string().trim().min(1).max(200), query: z.string().trim().min(1).max(200), verdict: z.enum(["unhelpful", "inaccurate"]), detail: z.string().trim().min(1).max(600) }),
};
export const guideUpdatesDefinition = {
  description: "Read your requested reference results and pending/unavailable reasons, without nagging. New-only by default; all=true revisits previously read results. References are untested, never verified skills.",
  schema: z.object({ all: z.boolean().optional(), page: z.number().int().min(1).max(10000).optional(), after: z.number().int().min(0).optional() }),
};
export type Reference = { gap_id: number; revision: number; title: string; scope: string; answer: string; prerequisites_json: string; controls_json: string; sources_json: string; caveats: string; stale: number };
type Gap = { id: number; revision: number; status: string; published_revision: number | null };

/** Read-only compact projection for caretaker/web; bind LIMIT then OFFSET. No raw trace. */
export const knowledgeOverviewSql = `SELECT g.id, 'ref-' || g.id AS handle,g.question,g.scope,g.revision,g.status,
  g.occurrences,g.attempts,g.next_attempt_at,g.reason,g.published_revision,g.updated_at,
  r.title AS reference_title,r.published_at,
  (g.published_revision IS NOT NULL AND g.published_revision != g.revision) AS reference_stale,
  (SELECT group_concat(resident || CASE WHEN project='' THEN '' ELSE ' [' || project || ']' END, '; ')
   FROM knowledge_requests WHERE gap_id=g.id) AS requesters
  FROM knowledge_gaps g LEFT JOIN knowledge_references r ON r.gap_id=g.id AND r.revision=g.published_revision
  ORDER BY g.updated_at DESC,g.id DESC LIMIT ? OFFSET ?`;
export type KnowledgeOverview = Readonly<{
  id: number; handle: string; question: string; scope: string; revision: number; status: string;
  occurrences: number; attempts: number; next_attempt_at: number; reason: string; published_revision: number | null;
  updated_at: number; reference_title: string | null; published_at: number | null; reference_stale: number; requesters: string | null;
}>;
export function knowledgeOverview(db?: Database, limit = 20, offset = 0): readonly KnowledgeOverview[] {
  if (!db) return [];
  try { return db.query(knowledgeOverviewSql).all(Math.min(100, Math.max(1, Math.trunc(limit))), Math.max(0, Math.trunc(offset))) as KnowledgeOverview[]; }
  catch { return []; }
}

/** One instance per resident; project is a snapshot label, never a required plan. */
export class KnowledgeGaps {
  constructor(private connection: Database | undefined, private resident: string, private project: () => string = () => "", readonly scope = KNOWLEDGE_SCOPE) {}

  private get db(): Database {
    if (!this.connection) throw new Error("Reference queue unavailable");
    return this.connection;
  }

  private request(id: number, at: number): void {
    // A broken optional project reader must not lose the actual question.
    let project = "";
    try { project = this.project().slice(0, 200); } catch { /* no active project */ }
    this.db.query(`INSERT INTO knowledge_requests(gap_id,resident,project,first_at,last_at) VALUES(?,?,?,?,?)
      ON CONFLICT(gap_id,resident,project) DO UPDATE SET occurrences=occurrences+1,last_at=excluded.last_at`)
      .run(id, this.resident, project, at, at);
  }

  private record(query: string, target: string | null, at: number): Gap {
    const normalized = normalizeQuestion(query);
    if (!normalized) throw new Error("Question has no searchable words");
    this.db.query(`INSERT INTO knowledge_gaps(normalized_question,question,scope,target,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(normalized_question,scope) DO UPDATE SET occurrences=occurrences+1,updated_at=excluded.updated_at`)
      .run(normalized, query, this.scope, target, at, at);
    const gap = this.db.query("SELECT id,revision,status,published_revision FROM knowledge_gaps WHERE normalized_question=? AND scope=?").get(normalized, this.scope) as Gap;
    this.request(gap.id, at);
    return gap;
  }

  recordMiss(query: string): number {
    return this.db.transaction(() => this.record(query, null, Date.now()).id).immediate();
  }

  feedback(input: z.infer<typeof guideFeedbackDefinition.schema>): string {
    const parsed = guideFeedbackDefinition.schema.safeParse(input);
    if (!parsed.success) return "Give target, query, verdict=unhelpful|inaccurate, and detail (what failed or is wrong).";
    const args = parsed.data;
    try {
      return this.db.transaction(() => {
        const at = Date.now();
        const ref = args.target.match(/^ref-([1-9][0-9]*)$/);
        let gap: Gap;
        if (ref) {
          const existing = this.db.query("SELECT id,revision,status,published_revision FROM knowledge_gaps WHERE id=?").get(Number(ref[1])) as Gap | null;
          if (!existing) return "Unknown reference handle; use its displayed ref-N handle.";
          gap = existing;
          this.request(gap.id, at);
          this.db.query("UPDATE knowledge_gaps SET occurrences=occurrences+1 WHERE id=?").run(gap.id);
        } else gap = this.record(args.query, args.target, at);
        // Every explicit correction invalidates an in-flight answer. Mere recurrence does not.
        const revision = gap.revision + 1;
        this.db.query(`UPDATE knowledge_gaps SET revision=?,status='pending',attempts=0,next_attempt_at=0,
          lease_token=NULL,lease_until=NULL,reason='',target=?,updated_at=? WHERE id=?`).run(revision, args.target, at, gap.id);
        this.db.query("INSERT INTO knowledge_feedback(gap_id,revision,resident,target,verdict,detail,at) VALUES(?,?,?,?,?,?,?)")
          .run(gap.id, revision, this.resident, args.target, args.verdict, args.detail, at);
        return `Correction queued for ref-${gap.id}, revision ${revision}. Previous text remains labelled outdated until researched. Check guide_updates when useful.`;
      }).immediate();
    } catch { return "Could not save guide feedback; the reference library remains available. Try again later."; }
  }

  get(id: number): Reference | null {
    if (!this.connection) return null;
    return this.db.query(`SELECT r.*, (g.revision != r.revision) AS stale FROM knowledge_references r
      JOIN knowledge_gaps g ON g.id=r.gap_id AND g.published_revision=r.revision WHERE g.id=?`).get(id) as Reference | null;
  }

  list(page = 1): Reference[] {
    if (!this.connection) return [];
    const rows = this.db.query("SELECT id FROM knowledge_gaps WHERE scope=? AND published_revision IS NOT NULL ORDER BY id LIMIT 7 OFFSET ?").all(this.scope, (page - 1) * 6) as { id: number }[];
    return rows.map(row => this.get(row.id)).filter((row): row is Reference => !!row);
  }

  exact(query: string): Reference | null {
    if (!this.connection) return null;
    const row = this.db.query("SELECT id FROM knowledge_gaps WHERE normalized_question=? AND scope=? AND published_revision IS NOT NULL")
      .get(normalizeQuestion(query), this.scope) as { id: number } | null;
    return row ? this.get(row.id) : null;
  }

  search(query: string): Reference[] {
    if (!this.connection) return [];
    const filler = new Set("how do does did can could should would please the with what where when about tell get getting make making start starting guide help need want learn use using".split(" "));
    const tokens = [...new Set(normalizeQuestion(query).split(" ").filter(token => token.length > 2 && !filler.has(token)))].slice(0, 12);
    if (!tokens.length) return [];
    const exact = normalizeQuestion(query);
    // Bound candidate retrieval; do not load full reference prose for a broad library scan.
    const rows = this.db.query(`SELECT g.id, g.normalized_question, r.title FROM knowledge_gaps g
      JOIN knowledge_references r ON r.gap_id=g.id AND r.revision=g.published_revision
      WHERE g.scope=? AND (g.normalized_question=? OR ${tokens.map(() => "(' ' || g.normalized_question || ' ' || lower(r.title) || ' ') LIKE ?").join(" OR ")})
      ORDER BY (g.normalized_question=?) DESC,g.updated_at DESC LIMIT 40`)
      .all(this.scope, exact, ...tokens.map(token => `% ${token} %`), exact) as { id: number; normalized_question: string; title: string }[];
    const ranked = rows.map(row => ({ row, score: row.normalized_question === exact ? 1000 : tokens.filter(token => normalizeQuestion(`${row.normalized_question} ${row.title}`).split(" ").includes(token)).length }))
      .sort((a, b) => b.score - a.score || a.row.id - b.row.id).slice(0, 6);
    return ranked.map(({ row }) => this.get(row.id)).filter((row): row is Reference => !!row);
  }

  updates(input: z.infer<typeof guideUpdatesDefinition.schema> = {}): string {
    const parsed = guideUpdatesDefinition.schema.safeParse(input);
    if (!parsed.success) return "Use guide_updates {all?:true, page?:1, after?:returned cursor}.";
    if (!parsed.data.all && (parsed.data.page ?? 1) > 1) return "For new results use the returned after cursor; page is for all=true.";
    try {
      return this.db.transaction(() => {
        const rows = this.db.query(`SELECT g.id,g.question,g.revision,g.published_revision,g.status,g.reason,
          MIN(q.seen_revision) AS seen FROM knowledge_requests q JOIN knowledge_gaps g ON g.id=q.gap_id
          WHERE q.resident=? AND g.id>? GROUP BY g.id HAVING ? OR MIN(q.seen_revision)<g.revision
          ORDER BY g.id LIMIT 6 OFFSET ?`).all(this.resident, parsed.data.after ?? 0, parsed.data.all ? 1 : 0, ((parsed.data.page ?? 1) - 1) * 5) as { id: number; question: string; revision: number; published_revision: number | null; status: string; reason: string }[];
        const shown = rows.slice(0, 5);
        for (const row of shown) {
          // Pending/researching are not consumed: their eventual result must still be new.
          if (row.status === "published" || row.status === "unavailable") this.db.query("UPDATE knowledge_requests SET seen_revision=? WHERE gap_id=? AND resident=?").run(row.revision, row.id, this.resident);
        }
        return shown.length ? shown.map(row => `ref-${row.id} r${row.revision}: ${row.status} — ${row.question}${row.reason ? ` (${row.reason})` : ""}${row.published_revision ? `; guide {query:'ref-${row.id}'}` : ""}`).join("\n")
          + (rows.length > 5 ? `\nMore: guide_updates ${parsed.data.all ? `{all:true,page:${(parsed.data.page ?? 1) + 1}}` : `{after:${shown[shown.length - 1]!.id}}`}` : "")
          : "No new requested references. Use all=true to revisit requests; no action required.";
      }).immediate();
    } catch { return "Reference updates unavailable; existing guides still work."; }
  }
}
