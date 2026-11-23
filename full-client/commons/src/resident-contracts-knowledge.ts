import { z } from "zod";

export const KNOWLEDGE_SCOPE = "Minecraft Java 1.20.1; Forge; Mekanism/Generators 10.4.16.80; Refined Storage 1.12.4; Immersive Engineering 10.2.0-183. Installed recipes/JEI override generic recipes.";
export const normalizeQuestion = (question: string): string => (question.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

export const guideFeedbackDefinition = {
  description: "Report an unhelpful or inaccurate guide/reference, with the question and what failed. Queues caretaker research, not a tested skill or a promise of success. Use the displayed topic/book source or ref-N handle as target. verdict=missing_control instead tells body maintainers that a step needs an action none of your tools performs (give capability, a short name of that action); it does not research the guide again.",
  schema: z.object({ target: z.string().trim().min(1).max(200), query: z.string().trim().min(1).max(200), verdict: z.enum(["unhelpful", "inaccurate", "missing_control"]), detail: z.string().trim().min(1).max(600), capability: z.string().trim().min(3).max(120).optional() }).strict(),
};
export const guideUpdatesDefinition = {
  description: "Read your requested reference results and pending/unavailable reasons, without nagging. New-only by default; all=true revisits previously read results. References are untested, never verified skills.",
  schema: z.object({ all: z.boolean().optional(), page: z.number().int().min(1).max(10000).optional(), after: z.number().int().min(0).optional() }).strict(),
};
export type Reference = { gap_id: number; revision: number; title: string; scope: string; answer: string; prerequisites_json: string; controls_json: string; sources_json: string; caveats: string; stale: number };

export const NEVER_RETRY = 9007199254740991;
export type KnowledgeOverview = Readonly<{
  id: number; handle: string; question: string; scope: string; revision: number; status: string;
  occurrences: number; attempts: number; next_attempt_at: number; reason: string; published_revision: number | null;
  updated_at: number; reference_title: string | null; published_at: number | null; reference_stale: number; requesters: string | null;
  parked: number; gap_kind: "knowledge" | "capability"; blocked_by: string | null;
}>;
export type CapabilityOverview = Readonly<{
  id: number; handle: string; capability: string; detail: string; status: "open" | "provided" | "declined"; occurrences: number;
  resolution: string; first_at: number; last_at: number; resolved_at: number | null; reporters: string | null; refs: string | null;
  parked_requests: number; reports_since_resolution: number;
}>;
