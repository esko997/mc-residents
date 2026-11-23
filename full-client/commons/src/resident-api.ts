import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { autoAccept } from "./reviews.ts";
import { ResidentEvents } from "./resident-events.ts";
import { placesOperation, sharedPlaces } from "./resident-places.ts";
import { skillsOperation } from "./resident-skills.ts";
import { societyOperation } from "./resident-society.ts";
import { knowledgeOperation } from "./resident-knowledge.ts";
import { alarmRequestSchema } from "./resident-contracts-alarm.ts";
import { AlarmRateLimitError, ResidentAlarms, type ResidentAlarmOptions } from "./resident-alarms.ts";
import { ResidentSight, type ResidentSightOptions } from "./resident-sight.ts";

const credentialSchema = z.array(z.object({ name: z.string().regex(/^\w{1,40}$/), role: z.enum(["resident", "caretaker"]), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
type Credential = z.infer<typeof credentialSchema>[number];
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const failure = (status: number, code: string, message: string) => response({ error: { code, message } }, status);
const reads: Record<string, readonly string[]> = {
  skills: ["find", "show", "notes_shared"], society: ["show", "showFacility", "snapshot"],
  knowledge: ["get", "list", "exact", "search", "overview", "capabilityOverview"], places: ["list"],
};
const MAX_BODY = 64 * 1024;

export class ResidentApi {
  readonly events: ResidentEvents;
  private stamp = "";
  private credentials: Credential[] = [];
  private alarms: ResidentAlarms;
  private sight: ResidentSight;
  constructor(private db: Database, private credentialsFile: string, private acceptNotes = true, options: ResidentAlarmOptions = {}, sight: ResidentSightOptions = {}) {
    this.events = new ResidentEvents(db);
    this.alarms = new ResidentAlarms(db, this.events, options);
    this.sight = new ResidentSight(sight);
  }

  private authenticate(request: Request): Credential | undefined {
    try {
      const stat = statSync(this.credentialsFile);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error();
      const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (stamp !== this.stamp) {
        const entries = credentialSchema.parse(JSON.parse(readFileSync(this.credentialsFile, "utf8")));
        if (new Set(entries.map(c => c.sha256)).size !== entries.length || new Set(entries.map(c => c.name.toLowerCase())).size !== entries.length) throw new Error();
        this.credentials = entries; this.stamp = stamp;
      }
    } catch { this.credentials = []; this.stamp = ""; return undefined; }
    const header = request.headers.get("Authorization") ?? "";
    if (!/^Bearer [^\s]{1,512}$/.test(header)) return undefined;
    const digest = createHash("sha256").update(header.slice(7)).digest();
    let found: Credential | undefined;
    for (const credential of this.credentials) if (timingSafeEqual(digest, Buffer.from(credential.sha256, "hex"))) found = credential;
    return found;
  }

  private async body(request: Request, raw = false): Promise<unknown> {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new SyntaxError("Expected application/json.");
    if (Number(request.headers.get("Content-Length")) > MAX_BODY) throw new RangeError("Request body exceeds 65536 bytes.");
    const reader = request.body?.getReader();
    if (!reader) throw new SyntaxError("Expected a JSON body.");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY) { await reader.cancel(); throw new RangeError("Request body exceeds 65536 bytes."); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return raw ? parsed : z.object({ args: z.unknown() }).strict().parse(parsed).args;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) return failure(403, "browser_forbidden", "Resident API does not accept browser requests.");
    const who = this.authenticate(request);
    if (!who) return failure(401, "unauthorized", "Unknown or unavailable resident credential.");
    const url = new URL(request.url), path = url.pathname.slice("/resident-api/v1/".length);
    if (path === "events" && request.method === "GET") {
      if (who.role !== "resident") return failure(403, "forbidden", "Only residents have an event feed.");
      const after = Number(url.searchParams.get("after") ?? 0), wait = Number(url.searchParams.get("wait") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0 || wait > 25) return failure(400, "invalid_request", "after must be a nonnegative integer; wait must be 0..25 seconds.");
      return response({ result: await this.events.poll(who.name, after, wait, request.signal) });
    }
    if (path === "caretaker/digest" && request.method === "GET") {
      if (who.role !== "caretaker") return failure(403, "forbidden", "Only caretakers may read resident digests.");
      const resident = url.searchParams.get("resident") ?? "";
      if (!/^\w{1,16}$/.test(resident)) return failure(400, "invalid_request", "resident must be a Minecraft player name.");
      return response(this.digest(resident));
    }
    if (path === "alarm" && request.method === "POST") {
      if (who.role !== "resident") return failure(403, "forbidden", "Only residents may raise alarms.");
      try {
        const alarm = alarmRequestSchema.parse(await this.body(request, true));
        return response({ result: this.alarms.raise(who.name, alarm, this.credentials.filter(c => c.role === "resident").map(c => c.name)) });
      } catch (error) {
        if (error instanceof AlarmRateLimitError) return failure(429, "rate_limited", error.message);
        if (error instanceof RangeError) return failure(413, "too_large", error.message);
        if (error instanceof z.ZodError || error instanceof SyntaxError) return failure(400, "invalid_request", "Invalid alarm arguments; identity is assigned by the hub.");
        return failure(503, "alarm_unavailable", "The hub could not record the alarm.");
      }
    }
    if (path === "sight" && request.method === "GET") {
      if (who.role !== "resident") return failure(403, "forbidden", "Only residents may ask about their own sight.");
      // Always the caller's own sight: no resident learns what another can see.
      const asked = url.searchParams.get("to") ?? "";
      const other = /^\w{1,16}$/.test(asked) && !url.searchParams.has("from")
        ? this.credentials.find(c => c.role === "resident" && c.name.toLowerCase() === asked.toLowerCase()) : undefined;
      if (!other || other.name.toLowerCase() === who.name.toLowerCase()) return failure(400, "invalid_request", "to must name another resident; sight is always from the caller.");
      return response({ result: await this.sight.between(who.name, other.name) });
    }
    const [group, operation, extra] = path.split("/");
    if (request.method !== "POST" || !group || !operation || extra !== undefined || !Object.hasOwn(reads, group)) return failure(404, "not_found", "Resident API endpoint not found.");
    // Caretakers read the library, not another resident's private collaborations or drafts.
    if (who.role === "caretaker" && (!(reads[group] ?? []).includes(operation) || group === "society")) return failure(403, "forbidden", "Caretaker credentials are read-only library/digest credentials.");
    try {
      const args = await this.body(request);
      const result = group === "skills" ? skillsOperation(this.db, who.name, operation, args)
        : group === "society" ? societyOperation(this.db, who.name, operation, args)
        : group === "knowledge" ? knowledgeOperation(this.db, who.name, operation, args)
        : placesOperation(this.db, who.name, operation, args);
      if (this.acceptNotes && group === "skills" && operation === "note_share") autoAccept(this.db);
      if (group === "society" && ["collaborate", "update"].includes(operation)) this.collaborationEvent(who.name);
      return response({ result });
    } catch (error) {
      if (error instanceof RangeError) return failure(413, "too_large", error.message);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return failure(400, "invalid_request", "Invalid request arguments.");
      const message = error instanceof Error ? error.message : "Shared operation failed.";
      // Do not expose SQL, filesystem details, tokens or credential data through errors.
      if (/SQLITE|no such table|constraint failed|disk|readonly database/i.test(message)) return failure(503, "store_unavailable", "Shared Knowledge store is unavailable.");
      return failure(/revision conflict/i.test(message) ? 409 : 400, /revision conflict/i.test(message) ? "conflict" : "operation_failed", message);
    }
  }

  private collaborationEvent(actor: string) {
    const row = this.db.query<{ collaboration_id: number; revision: number; action: string; sender: string; recipient: string | null }, [string]>(
      "SELECT h.collaboration_id,h.revision,h.action,c.sender,c.recipient FROM collaboration_history h JOIN collaborations c ON c.id=h.collaboration_id WHERE h.actor=? COLLATE NOCASE ORDER BY h.id DESC LIMIT 1").get(actor);
    if (!row) return;
    for (const target of [row.sender, row.recipient]) if (target && target.toLowerCase() !== actor.toLowerCase()) {
      this.events.publish(target, "collaboration", { from: actor, id: row.collaboration_id, revision: row.revision, action: row.action });
    }
  }

  private digest(resident: string) {
    return {
      skills: this.db.query("SELECT name,author,description,status FROM skills WHERE status IN ('verified','curated') ORDER BY updated_at DESC,id DESC LIMIT 8").all(),
      collaborations: this.db.query("SELECT id,kind,sender,recipient,project,terms,status,evidence,confirmation FROM collaborations WHERE sender=? COLLATE NOCASE OR recipient=? COLLATE NOCASE OR recipient IS NULL ORDER BY updated_at DESC,id DESC LIMIT 8").all(resident, resident),
      facilities: this.db.query(`SELECT f.id,f.name,f.purpose,f.x,f.y,f.z,f.dimension,f.steward,f.access_terms,o.condition,o.certainty,o.observer,o.observed_at,o.source,o.stock_json,
        CASE WHEN o.facility_revision=f.revision THEN 'matching metadata' ELSE 'metadata changed: uncertain' END AS metadata_status
        FROM facilities f LEFT JOIN facility_observations o ON o.id=(SELECT id FROM facility_observations WHERE facility_id=f.id ORDER BY observed_at DESC,id DESC LIMIT 1)
        ORDER BY f.updated_at DESC,f.id DESC LIMIT 8`).all(),
      knowledge_requests: this.db.query(`SELECT g.id,g.question,q.project,g.status,q.occurrences,g.reason,g.revision,g.published_revision,r.title
        FROM knowledge_requests q JOIN knowledge_gaps g ON g.id=q.gap_id LEFT JOIN knowledge_references r ON r.gap_id=g.id AND r.revision=g.published_revision
        WHERE q.resident=? COLLATE NOCASE ORDER BY q.last_at DESC,g.id DESC LIMIT 8`).all(resident),
      places: sharedPlaces(this.db),
    };
  }
  close() { this.events.close(); }
}
