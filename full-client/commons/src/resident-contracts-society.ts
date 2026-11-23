import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), "Use one line.");
const id = z.number().int().positive();
const page = z.number().int().min(1).max(10_000).optional();
const name = line(40);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const stock = z.array(z.object({ item: line(80), count: z.number().int().nonnegative().max(1_000_000) }).strict()).max(12);
const facilityFields = {
  name: line(60), purpose: line(160), capabilities: z.array(line(48)).min(1).max(8),
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), dimension: line(80), access_terms: line(200),
};

/** Identity is supplied by the tool server, never by tool arguments. No tool here acts in the world. */
export const societyDefinitions = {
  collaborate: {
    description: "Post your own voluntary request or offer. Omit recipient for a public invitation; nobody is assigned. project optionally links your project. Terms should say what and where, and what counts as done. Returns id and revision for negotiation.",
    schema: z.object({ kind: z.enum(["request", "offer"]), recipient: name.optional(), project: name.optional(), terms: line(400) }).strict(),
  },
  collaboration_update: {
    description: "Negotiate your own collaboration using its latest revision. accept agrees to the other person's terms; counter replaces terms and requires their renewed acceptance; decline refuses; withdraw ends your involvement. report is only for the performer (request: recipient; offer: sender) after acceptance, with evidence and source. confirm is only for the beneficiary after report, with their distinct evidence/source. Neither is machine verification. Read collaboration_show after a revision conflict; do not blindly replay actions.",
    schema: z.object({ id, revision: id, action: z.enum(["accept", "decline", "counter", "withdraw", "report", "confirm"]), terms: line(400).optional(), evidence: line(400).optional(), source: line(200).optional() }).strict(),
  },
  collaboration_show: {
    description: "Read your named/public collaborations, or one id with its last 50 history entries. page continues bounded output. Closed agreements remain available with closed:true or by id.",
    schema: z.object({ id: id.optional(), project: name.optional(), closed: z.boolean().optional(), page }).strict(),
  },
  facility_register: {
    description: "Register a facility you steward, with capabilities, location and access terms. This is your claim, not verified ownership or working infrastructure. Use facility_observe to record its condition. For another person's facility, ask them to register it; you may observe an existing entry without changing rights.",
    schema: z.object(facilityFields).strict(),
  },
  facility_update: {
    description: "Only the registered steward can revise facility metadata/access terms. Give latest revision and all fields. This never transfers stewardship; observations by visitors use facility_observe instead.",
    schema: z.object({ id, revision: id, ...facilityFields }).strict(),
  },
  facility_observe: {
    description: "Record a dated condition/source for an existing facility, optionally stock counts you observed (empty list means no stock observed). observed_at is Unix milliseconds, default now; uncertain marks hearsay/inference. Counts are snapshots, never live inventory or a permission to use it. Does not change steward/access. Older observations remain history, not the current condition.",
    schema: z.object({ id, condition: line(240), certainty: z.enum(["observed", "uncertain"]), source: line(200), observed_at: timestamp.optional(), stock: stock.optional() }).strict(),
  },
  facility_show: {
    description: "Read facilities and access terms, or one id with its last 50 observations. query searches capabilities/name/purpose; page continues bounded output. Conditions older than 6h and stock older than 30min are labelled stale; even recent observations are resident reports, not verified prerequisites.",
    schema: z.object({ id: id.optional(), query: line(100).optional(), page }).strict(),
  },
};
export type SocietyArgs<K extends keyof typeof societyDefinitions> = z.infer<(typeof societyDefinitions)[K]["schema"]>;
export interface Collaboration {
  id: number; kind: "request" | "offer"; sender: string; recipient: string | null; project: string | null;
  terms: string; proposer: string; revision: number; accepted_revision: number | null;
  status: "proposed" | "accepted" | "reported" | "confirmed" | "declined" | "withdrawn";
  evidence: string | null; evidence_source: string | null; confirmation: string | null; confirmation_source: string | null;
  created_at: number; updated_at: number;
}
export interface FacilityRow {
  id: number; name: string; purpose: string; capabilities_json: string; x: number; y: number; z: number;
  dimension: string; steward: string; access_terms: string; revision: number; created_at: number; updated_at: number;
}
export interface ObservationRow {
  id: number; facility_id: number; observer: string; condition: string; certainty: "observed" | "uncertain";
  facility_revision: number;
  source: string; stock_json: string | null; observed_at: number; recorded_at: number;
}
export type Freshness = "recent" | "stale" | "uncertain";
export interface FacilityObservation extends Omit<ObservationRow, "stock_json"> {
  stock?: z.infer<typeof stock>;
  freshness: Freshness;
  stockFreshness: Freshness;
}
export interface Facility extends Omit<FacilityRow, "capabilities_json"> {
  capabilities: string[];
  observation?: FacilityObservation;
  stockObservation?: FacilityObservation;
}
export interface SocietySnapshot { resident: string; collaborations: Collaboration[]; facilities: Facility[] }
export interface SocietyContext { project?: string; needs?: string; dimension?: string }

export const performerOf = (c: Collaboration) => c.kind === "offer" ? c.sender : c.recipient;
export const beneficiaryOf = (c: Collaboration) => c.kind === "request" ? c.sender : c.recipient;
export function observationFreshness(at: number, now: number, certainty: "observed" | "uncertain", stockCount = false): Freshness {
  if (certainty === "uncertain" || at > now) return "uncertain";
  return now - at > (stockCount ? 30 * 60_000 : 6 * 3_600_000) ? "stale" : "recent";
}

export const societyContextSchema = z.object({ project: line(200).optional(), needs: z.string().max(2000).optional(), dimension: line(80).optional() }).strict();
