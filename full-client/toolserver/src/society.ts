import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openCommons } from "./commons.ts";

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
type Args<K extends keyof typeof societyDefinitions> = z.infer<(typeof societyDefinitions)[K]["schema"]>;
export interface Collaboration {
  id: number; kind: "request" | "offer"; sender: string; recipient: string | null; project: string | null;
  terms: string; proposer: string; revision: number; accepted_revision: number | null;
  status: "proposed" | "accepted" | "reported" | "confirmed" | "declined" | "withdrawn";
  evidence: string | null; evidence_source: string | null; confirmation: string | null; confirmation_source: string | null;
  created_at: number; updated_at: number;
}
interface FacilityRow {
  id: number; name: string; purpose: string; capabilities_json: string; x: number; y: number; z: number;
  dimension: string; steward: string; access_terms: string; revision: number; created_at: number; updated_at: number;
}
interface ObservationRow {
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
export interface SocietyOptions { path?: string; db?: Database; resident: string; now?: () => number }
export interface Society {
  collaborate(input: Args<"collaborate">): string;
  update(input: Args<"collaboration_update">): string;
  show(input: Args<"collaboration_show">): string;
  register(input: Args<"facility_register">): string;
  updateFacility(input: Args<"facility_update">): string;
  observe(input: Args<"facility_observe">): string;
  showFacility(input: Args<"facility_show">): string;
  snapshot(context?: SocietyContext): SocietySnapshot;
  close(): void;
}

const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
export const performerOf = (c: Collaboration) => c.kind === "offer" ? c.sender : c.recipient;
export const beneficiaryOf = (c: Collaboration) => c.kind === "request" ? c.sender : c.recipient;
export function observationFreshness(at: number, now: number, certainty: "observed" | "uncertain", stockCount = false): Freshness {
  if (certainty === "uncertain" || at > now) return "uncertain";
  return now - at > (stockCount ? 30 * 60_000 : 6 * 3_600_000) ? "stale" : "recent";
}
const date = (at: number) => new Date(at).toISOString();
const pageSize = 4, pageChars = 1400;
function paged(text: string, number: number, label: string): string {
  const pages = Math.max(1, Math.ceil(text.length / pageChars));
  if (number > pages) return `${label}: page ${number} does not exist (${pages} pages).`;
  return `${label} — page ${number}/${pages}\n${text.slice((number - 1) * pageChars, number * pageChars)}${number < pages ? `\nContinue with page:${number + 1}.` : ""}`;
}
function collaborationText(c: Collaboration): string {
  return `#${c.id} r${c.revision} ${c.kind} ${c.status}: ${c.sender} → ${c.recipient ?? "public (unclaimed)"}${c.project ? `; project ${c.project}` : ""}\nTerms by ${c.proposer}: ${c.terms}${c.accepted_revision ? `\nAccepted terms at r${c.accepted_revision}.` : "\nNo current acceptance."}${c.evidence ? `\nReported completion (not machine-verified): ${c.evidence}; source: ${c.evidence_source}` : ""}${c.confirmation ? `\nRecipient confirmation (not machine-verified): ${c.confirmation}; source: ${c.confirmation_source}` : ""}`;
}
function observationText(o: FacilityObservation): string {
  return `${date(o.observed_at)} ${o.observer} (facility r${o.facility_revision}): ${o.freshness} / ${o.certainty}: ${o.condition}; source: ${o.source}${o.stock ? `; stock (${o.stockFreshness}, not live): ${JSON.stringify(o.stock)}` : ""}`;
}
function facilityText(f: Facility): string {
  return `#${f.id} r${f.revision} ${f.name}: ${f.purpose}; capabilities: ${f.capabilities.join(", ")}\n${f.x},${f.y},${f.z} ${f.dimension}; steward: ${f.steward}; access: ${f.access_terms}\n${f.observation ? observationText(f.observation) : "Condition unobserved."}${f.stockObservation && f.stockObservation.id !== f.observation?.id ? `\nLast stock observation: ${observationText(f.stockObservation)}` : ""}\nResident-reported, not a verified prerequisite or live stock guarantee.`;
}

/** A borrowed db stays open on close(); otherwise this store opens/closes its own commons connection. */
export function createSociety(options: SocietyOptions): Society {
  const resident = name.parse(options.resident), now = options.now ?? Date.now;
  if (!options.db && !options.path) throw new Error("Society needs a commons db or path.");
  const db = options.db ?? openCommons(options.path!);
  const getCollaboration = (key: number) => {
    const c = db.query<Collaboration, [number]>("SELECT * FROM collaborations WHERE id = ?").get(key);
    if (!c) throw new Error("Collaboration not found.");
    if (c.recipient && !same(c.sender, resident) && !same(c.recipient, resident)) throw new Error("This named collaboration is not yours.");
    return c;
  };
  const history = (c: Collaboration, action: string, detail: string, at: number) => {
    db.query("INSERT INTO collaboration_history (collaboration_id, revision, actor, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, c.revision, resident, action, detail, at);
    db.query("DELETE FROM collaboration_history WHERE collaboration_id = ? AND id NOT IN (SELECT id FROM collaboration_history WHERE collaboration_id = ? ORDER BY id DESC LIMIT 50)").run(c.id, c.id);
  };
  const getFacility = (key: number) => {
    const f = db.query<FacilityRow, [number]>("SELECT * FROM facilities WHERE id = ?").get(key);
    if (!f) throw new Error("Facility not found.");
    return f;
  };
  const observed = (o: ObservationRow, at: number, revision: number): FacilityObservation => {
    const { stock_json, ...fields } = o;
    const certainty = o.facility_revision === revision ? o.certainty : "uncertain";
    return {
      ...fields, ...(stock_json !== null ? { stock: JSON.parse(stock_json) } : {}),
      freshness: observationFreshness(o.observed_at, at, certainty),
      stockFreshness: observationFreshness(o.observed_at, at, certainty, true),
    };
  };
  const facility = (f: FacilityRow, at: number): Facility => {
    const latest = db.query<ObservationRow, [number]>("SELECT * FROM facility_observations WHERE facility_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1").get(f.id);
    const stocked = db.query<ObservationRow, [number]>("SELECT * FROM facility_observations WHERE facility_id = ? AND stock_json IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1").get(f.id);
    const { capabilities_json, ...fields } = f;
    return { ...fields, capabilities: JSON.parse(capabilities_json), ...(latest ? { observation: observed(latest, at, f.revision) } : {}), ...(stocked ? { stockObservation: observed(stocked, at, f.revision) } : {}) };
  };

  return {
    collaborate(input: Args<"collaborate">): string {
      const a = societyDefinitions.collaborate.schema.parse(input);
      if (a.recipient && same(a.recipient, resident)) throw new Error("Collaborations need another resident; you cannot accept for yourself.");
      return db.transaction(() => {
        const at = now();
        const result = db.query("INSERT INTO collaborations (kind, sender, recipient, project, terms, proposer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(a.kind, resident, a.recipient ?? null, a.project ?? null, a.terms, resident, at, at);
        const c = getCollaboration(Number(result.lastInsertRowid));
        history(c, "propose", c.terms, at);
        return collaborationText(c);
      }).immediate();
    },
    update(input: Args<"collaboration_update">): string {
      const a = societyDefinitions.collaboration_update.schema.parse(input);
      return db.transaction(() => {
        const c = getCollaboration(a.id);
        if (a.revision !== c.revision) throw new Error(`Revision conflict: current r${c.revision}; read collaboration_show before deciding again.`);
        if (["confirmed", "declined", "withdrawn"].includes(c.status)) throw new Error(`Collaboration is already ${c.status}.`);
        const sender = same(c.sender, resident), recipient = same(c.recipient, resident);
        if (a.action !== "counter" && a.terms !== undefined) throw new Error("Changed terms require counter and renewed acceptance.");
        if (!["report", "confirm"].includes(a.action) && (a.evidence !== undefined || a.source !== undefined)) throw new Error("Evidence/source belong to report or confirm.");
        if (!sender && !c.recipient && a.action === "decline" && c.status === "proposed") {
          db.query("INSERT INTO collaboration_declines (collaboration_id,resident,revision) VALUES (?,?,?) ON CONFLICT(collaboration_id,resident) DO UPDATE SET revision=excluded.revision").run(c.id, resident, c.revision);
          history(c, "decline", "Declined for myself; public invitation remains open to others.", now());
          return `Declined collaboration #${c.id} r${c.revision} for yourself. It remains open to others; changed terms may be offered again.`;
        }
        if (!sender && !recipient && (c.recipient || !["accept", "counter"].includes(a.action))) throw new Error("Only participants may change this collaboration; a public invitation can be accepted, declined or countered for yourself.");
        let detail: string = a.action;
        switch (a.action) {
          case "accept":
            if (c.status !== "proposed" || same(c.proposer, resident)) throw new Error("Only the other party can accept proposed terms.");
            c.recipient ??= resident;
            c.accepted_revision = c.revision;
            c.status = "accepted";
            break;
          case "counter":
            if (!["proposed", "accepted"].includes(c.status) || !a.terms) throw new Error("Counter needs terms and a proposed/accepted agreement.");
            if (a.terms === c.terms) throw new Error("Counter must change the terms; use accept to agree.");
            if (!sender) c.recipient ??= resident;
            c.terms = a.terms;
            c.proposer = resident;
            c.accepted_revision = null;
            c.status = "proposed";
            detail = c.terms;
            break;
          case "decline":
            if (c.status !== "proposed" || same(c.proposer, resident)) throw new Error("Only the other party can decline proposed terms; use withdraw for your own proposal.");
            c.status = "declined";
            break;
          case "withdraw": c.status = "withdrawn"; break;
          case "report":
            if (c.status !== "accepted" || !same(performerOf(c), resident)) throw new Error("Only the agreed performer can report completion after acceptance.");
            if (!a.evidence || !a.source) throw new Error("Reported completion requires observed evidence and its source.");
            c.status = "reported"; c.evidence = a.evidence; c.evidence_source = a.source;
            detail = `${a.evidence}; source: ${a.source}`;
            break;
          case "confirm":
            if (c.status !== "reported" || !same(beneficiaryOf(c), resident) || same(performerOf(c), resident)) throw new Error("Only the distinct beneficiary can confirm the performer's reported completion.");
            if (!a.evidence || !a.source) throw new Error("Confirmation requires your own evidence and source.");
            c.status = "confirmed"; c.confirmation = a.evidence; c.confirmation_source = a.source;
            detail = `${a.evidence}; source: ${a.source}`;
            break;
        }
        c.revision++; c.updated_at = now();
        db.query("UPDATE collaborations SET recipient=?, terms=?, proposer=?, revision=?, accepted_revision=?, status=?, evidence=?, evidence_source=?, confirmation=?, confirmation_source=?, updated_at=? WHERE id=?")
          .run(c.recipient, c.terms, c.proposer, c.revision, c.accepted_revision, c.status, c.evidence, c.evidence_source, c.confirmation, c.confirmation_source, c.updated_at, c.id);
        history(c, a.action, detail, c.updated_at);
        return collaborationText(c);
      }).immediate();
    },
    show(input: Args<"collaboration_show">): string {
      const a = societyDefinitions.collaboration_show.schema.parse(input), number = a.page ?? 1;
      if (a.id) {
        const c = getCollaboration(a.id);
        const rows = db.query<{ revision: number; actor: string; action: string; detail: string; at: number }, [number]>("SELECT revision, actor, action, detail, at FROM collaboration_history WHERE collaboration_id = ? ORDER BY id DESC LIMIT 50").all(a.id);
        return paged(`${collaborationText(c)}\nHistory (last 50, newest first):\n${rows.map(r => `r${r.revision} ${date(r.at)} ${r.actor} ${r.action}: ${r.detail}`).join("\n")}`, number, `Collaboration #${c.id}`);
      }
      const rows = db.query<Collaboration, [string, string, string | null, string | null, number, number, number]>("SELECT * FROM collaborations WHERE (sender=? OR recipient=? OR recipient IS NULL) AND (? IS NULL OR project=? COLLATE NOCASE) AND (?=1 OR status IN ('proposed','accepted','reported')) ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?")
        .all(resident, resident, a.project ?? null, a.project ?? null, a.closed ? 1 : 0, pageSize + 1, (number - 1) * pageSize);
      return `Collaborations page ${number}:\n${rows.slice(0, pageSize).map(c => `#${c.id} r${c.revision} ${c.kind} ${c.status}: ${c.sender} → ${c.recipient ?? "public"}${c.project ? ` [${c.project}]` : ""}; ${c.terms.slice(0, 160)}${c.terms.length > 160 ? "… (show id for full terms)" : ""}`).join("\n") || "None."}${rows.length > pageSize ? `\nContinue with page:${number + 1}.` : ""}`;
    },
    register(input: Args<"facility_register">): string {
      const a = societyDefinitions.facility_register.schema.parse(input), at = now();
      const result = db.query("INSERT INTO facilities (name,purpose,capabilities_json,x,y,z,dimension,access_terms,steward,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(a.name, a.purpose, JSON.stringify(a.capabilities), a.x, a.y, a.z, a.dimension, a.access_terms, resident, at, at);
      return `Registered facility #${result.lastInsertRowid} r1, steward ${resident}. Condition unobserved; use facility_observe. This is not verified ownership or capability.`;
    },
    updateFacility(input: Args<"facility_update">): string {
      const a = societyDefinitions.facility_update.schema.parse(input);
      return db.transaction(() => {
        const f = getFacility(a.id);
        if (!same(f.steward, resident)) throw new Error("Only the steward may change facility metadata/access terms. Observations do not grant stewardship.");
        if (f.revision !== a.revision) throw new Error(`Revision conflict: current r${f.revision}; read facility_show.`);
        db.query("UPDATE facilities SET name=?,purpose=?,capabilities_json=?,x=?,y=?,z=?,dimension=?,access_terms=?,revision=revision+1,updated_at=? WHERE id=?").run(a.name, a.purpose, JSON.stringify(a.capabilities), a.x, a.y, a.z, a.dimension, a.access_terms, now(), a.id);
        return `Facility #${a.id} r${f.revision + 1} updated; steward remains ${f.steward}. Existing observations keep their original dates and may need refreshing.`;
      }).immediate();
    },
    observe(input: Args<"facility_observe">): string {
      const a = societyDefinitions.facility_observe.schema.parse(input);
      return db.transaction(() => {
        const f = getFacility(a.id);
        const at = now(), seen = a.observed_at ?? at;
        if (seen > at) throw new Error("An observation cannot be dated in the future.");
        db.query("INSERT INTO facility_observations (facility_id,facility_revision,observer,condition,certainty,source,stock_json,observed_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a.id, f.revision, resident, a.condition, a.certainty, a.source, a.stock === undefined ? null : JSON.stringify(a.stock), seen, at);
        // Keep dated history bounded, including the last stock observation when later reports omit stock.
        db.query("DELETE FROM facility_observations WHERE facility_id=? AND id NOT IN (SELECT id FROM facility_observations WHERE facility_id=? ORDER BY observed_at DESC,id DESC LIMIT 49) AND id NOT IN (SELECT id FROM facility_observations WHERE facility_id=? AND stock_json IS NOT NULL ORDER BY observed_at DESC,id DESC LIMIT 1)").run(a.id, a.id, a.id);
        return `Observation recorded for facility #${a.id} at ${date(seen)} (${observationFreshness(seen, at, a.certainty)}; resident-reported, not verified). Steward and access terms unchanged; stock is not live.`;
      }).immediate();
    },
    showFacility(input: Args<"facility_show">): string {
      const a = societyDefinitions.facility_show.schema.parse(input), number = a.page ?? 1, at = now();
      if (a.id) {
        const f = facility(getFacility(a.id), at);
        const rows = db.query<ObservationRow, [number]>("SELECT * FROM facility_observations WHERE facility_id=? ORDER BY observed_at DESC,id DESC LIMIT 50").all(a.id);
        return paged(`${facilityText(f)}\nHistory (last 50 observations; older facility revisions are uncertain):\n${rows.map(o => observationText(observed(o, at, f.revision))).join("\n")}`, number, `Facility #${f.id}`);
      }
      const search = `%${a.query ?? ""}%`;
      const rows = db.query<FacilityRow, [string, string, string, number, number]>("SELECT * FROM facilities WHERE name LIKE ? OR purpose LIKE ? OR capabilities_json LIKE ? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?").all(search, search, search, pageSize + 1, (number - 1) * pageSize);
      return `Facilities page ${number} (claims, not verified prerequisites; show id for access and observations):\n${rows.slice(0, pageSize).map(f => `#${f.id} r${f.revision} ${f.name}: ${f.purpose}; steward ${f.steward}`).join("\n") || "None."}${rows.length > pageSize ? `\nContinue with page:${number + 1}.` : ""}`;
    },
    snapshot(context: SocietyContext = {}): SocietySnapshot {
      const collaborations = db.query<Collaboration, [string, string, string, string, string]>("SELECT * FROM collaborations c WHERE status IN ('proposed','accepted','reported') AND (sender=? OR recipient=? OR recipient IS NULL) AND NOT EXISTS (SELECT 1 FROM collaboration_declines d WHERE d.collaboration_id=c.id AND d.resident=? AND d.revision=c.revision) ORDER BY CASE WHEN project=? COLLATE NOCASE THEN 0 ELSE 1 END, CASE WHEN recipient=? COLLATE NOCASE THEN 0 ELSE 1 END, updated_at DESC,id DESC LIMIT 12")
        .all(resident, resident, resident, context.project ?? "", resident);
      const words = [...new Set((context.needs ?? "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter(w => !["the", "and", "for", "with", "from", "need", "have"].includes(w)).slice(0, 12);
      const relevance = words.length ? `CASE WHEN ${words.map(() => "lower(name || ' ' || purpose || ' ' || capabilities_json) LIKE ?").join(" OR ")} THEN 0 ELSE 1 END,` : "";
      const rows = db.query<FacilityRow, (string | null)[]>(`SELECT * FROM facilities WHERE (? IS NULL OR dimension=?) ORDER BY ${relevance} updated_at DESC,id DESC LIMIT 12`).all(context.dimension ?? null, context.dimension ?? null, ...words.map(w => `%${w}%`));
      const at = now();
      return { resident, collaborations, facilities: rows.map(f => facility(f, at)) };
    },
    close() { if (!options.db) db.close(); },
  };
}
