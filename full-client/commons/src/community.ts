import type { Database } from "bun:sqlite";

interface Collaboration {
  id: number; kind: string; sender: string; recipient: string | null; project: string | null;
  terms: string; revision: number; status: string; evidence: string | null;
  confirmation: string | null; updatedAt: number;
}
interface Facility {
  id: number; name: string; purpose: string; capabilities: string; x: number; y: number; z: number;
  dimension: string; steward: string; access: string; condition: string | null;
  observer: string | null; observedAt: number | null; source: string | null; conditionFreshness: string;
  stock: string | null; stockAt: number | null; stockObserver: string | null; stockFreshness: string;
}
interface KnowledgeGap {
  id: number; question: string; scope: string; status: string; occurrences: number;
  attempts: number; reason: string; updatedAt: number; requests: string;
}
interface Reference {
  gapId: number; revision: number; title: string; scope: string; answer: string;
  prerequisites: string; controls: string; sources: string; caveats: string; publishedAt: number; stale: number;
}

/** Social records only. No world scans, inventory promises, or write authority. */
export function communityOverview(db: Database, now: number) {
  const collaborations = db.query(`SELECT id, kind, sender, recipient, project, terms,
    revision, status, evidence, confirmation, updated_at AS updatedAt
    FROM collaborations ORDER BY updated_at DESC, id DESC LIMIT 50`).all() as Collaboration[];
  const facilities = db.query(`SELECT f.id, f.name, f.purpose, f.capabilities_json AS capabilities,
    f.x, f.y, f.z, f.dimension, f.steward, f.access_terms AS access,
    o.condition, o.observer, o.observed_at AS observedAt, o.source,
    CASE WHEN o.id IS NULL THEN 'unobserved'
      WHEN o.certainty != 'observed' OR o.facility_revision != f.revision THEN 'uncertain'
      WHEN ?1 - o.observed_at > 21600000 THEN 'stale' ELSE 'recent report' END AS conditionFreshness,
    s.stock_json AS stock, s.observed_at AS stockAt, s.observer AS stockObserver,
    CASE WHEN s.id IS NULL THEN 'not counted'
      WHEN s.certainty != 'observed' OR s.facility_revision != f.revision THEN 'uncertain'
      WHEN ?1 - s.observed_at > 1800000 THEN 'stale' ELSE 'recent report' END AS stockFreshness
    FROM facilities f
    LEFT JOIN facility_observations o ON o.id = (SELECT id FROM facility_observations
      WHERE facility_id=f.id ORDER BY observed_at DESC, id DESC LIMIT 1)
    LEFT JOIN facility_observations s ON s.id = (SELECT id FROM facility_observations
      WHERE facility_id=f.id AND stock_json IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1)
    ORDER BY f.updated_at DESC, f.id DESC LIMIT 50`).all(now) as Facility[];
  const knowledgeGaps = db.query(`SELECT g.id, g.question, g.scope, g.status, g.occurrences,
    g.attempts, g.reason, g.updated_at AS updatedAt,
    COALESCE((SELECT group_concat(resident || CASE WHEN project='' THEN '' ELSE ' (' || project || ')' END, '; ')
      FROM knowledge_requests WHERE gap_id=g.id), '') AS requests
    FROM knowledge_gaps g ORDER BY g.updated_at DESC, g.id DESC LIMIT 50`).all() as KnowledgeGap[];
  const references = db.query(`SELECT r.gap_id AS gapId, r.revision, r.title, r.scope, r.answer,
    r.prerequisites_json AS prerequisites, r.controls_json AS controls, r.sources_json AS sources,
    r.caveats, r.published_at AS publishedAt, (g.revision != r.revision) AS stale
    FROM knowledge_references r JOIN knowledge_gaps g ON g.id=r.gap_id AND g.published_revision=r.revision
    ORDER BY r.published_at DESC, r.gap_id DESC LIMIT 30`).all() as Reference[];
  return { collaborations, facilities, knowledgeGaps, references };
}
