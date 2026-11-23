// Run control: start/stop/status of resident runs, through one controller API.
//
// Commons owns what a run is; the host's own launcher (tools/start-run.sh,
// stop-run.sh, run-status.sh) does the systemd work. Each host's Commons only
// ever invokes ITS OWN launcher, with a fixed argument vector built from
// validated fields (never a shell string), a scrubbed environment, one
// mutating operation at a time and a timeout. The hub fans a request out to
// stations server-side, as Live does, so one call can start or stop residents
// on every host with the same deadline; each host's result is reported
// separately. Contract and examples: docs/run-controller.md.
//
// Auth: writes need a controller bearer credential (hash-only file), never the
// dashboard URL. Reads are also served under the dashboard URL (status only).
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Federation } from "./federation.ts";
import { LiveError, textLimited } from "./live-stream.ts";
import type { RolloutTail } from "./rollouts.ts";

const NAME = /^\w{1,16}$/;
const MODEL = /^(claude:)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const THREAD = /^[A-Za-z0-9_-]{8,128}$/;
const LABEL = /^\w{1,40}$/;
const UNIT = /^[\w@.:-]{1,100}$/;
/** Who a caller acts for; a hub forwards "<label> via <its caller>" so a station records the whole chain. */
const BEHALF = /^\w{1,40}( via \w{1,40}){0,2}$/;
const RESULT = /^[a-z_]{1,32}$/;
const MAX_AHEAD = 24 * 3600;
const BODY_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
/** Exit codes of tools/runctl.py, and the HTTP status each maps to. */
const CODES: Record<number, string> = { 0: "ok", 2: "usage", 3: "deadline", 4: "conflict", 5: "config", 6: "systemd", 7: "still_active", 75: "busy", 77: "gate" };
const STATUS: Record<string, number> = {
  ok: 200, usage: 400, deadline: 422, conflict: 409, config: 422, unknown_resident: 404, systemd: 502, still_active: 502,
  busy: 429, gate: 403, unreachable: 502, timeout: 504, not_configured: 503, error: 502, unauthorized: 401, forbidden: 403, too_large: 413,
};
/** Launcher deadlines (ms); a hub's forward waits a little longer than the station's own launcher. */
const TIMEOUTS = { status: 15_000, start: 60_000, stop: 170_000 };
const FORWARD = { status: 8_000, start: 75_000, stop: 185_000 };
const STATUS_TTL = 3000;

const credentialSchema = z.array(z.object({ name: z.string().regex(LABEL), role: z.literal("controller"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(64);
const caretakerSchema = z.object({
  enabled: z.boolean().optional(), interval: z.number().int().min(1).max(240).optional(), speak: z.enum(["keep", "on", "off"]).optional(),
}).strict();
const names = z.union([z.literal("all"), z.array(z.string().regex(NAME)).min(1).max(16)]);
const startSchema = z.object({
  residents: names,
  end_at: z.number().int().positive().optional(),
  end: z.string().max(40).optional(),
  model: z.string().regex(MODEL).optional(),
  models: z.record(z.string().regex(NAME), z.string().regex(MODEL)).optional(),
  fresh: names.optional(),
  caretaker: caretakerSchema.optional(),
  note: z.string().max(300).regex(/^[^\p{Cc}]*$/u).optional(),
  on_behalf_of: z.string().regex(BEHALF).optional(),
}).strict();
const stopSchema = z.object({ residents: names, on_behalf_of: z.string().regex(BEHALF).optional() }).strict();
type StartRequest = z.infer<typeof startSchema> & { end_at: number };
type StopRequest = z.infer<typeof stopSchema>;

export interface ResidentRun {
  name: string; persona?: string; result?: string; running?: boolean; run_state?: string; client_state?: string;
  end_at?: number | null; model?: string | null; mode?: string | null; thread_id?: string | null; dry_run?: boolean;
  unit?: string; client_unit?: string; started_by?: string | null; started_at?: number | null; activation?: string | null;
  error?: string; active_units?: string[]; client_pids?: number[];
}
export interface CaretakerRun { unit?: string; state?: string; running?: boolean; result?: string; end_at?: number | null; roster?: string[]; interval?: number | null; error?: string }
/** One host's part of a reply: never merged into another host's. */
export interface HostResult {
  host: string; ok: boolean; code: string; error?: string;
  residents: ResidentRun[]; caretaker: CaretakerRun | null;
  end_at?: number | null; activation?: string | null; changed?: boolean; dry_run?: boolean; mixed_end_times?: boolean;
}
export interface RunsReply { ok: boolean; code: string; error?: string; now: number; end_at?: number; hosts: HostResult[]; warnings: string[] }

export interface RunControlOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeouts?: Partial<typeof TIMEOUTS>;
  forward?: Partial<typeof FORWARD>;
  log?: (line: string) => void;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 300): string | undefined =>
  typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").slice(0, max) : undefined;
const pick = <T>(value: unknown, test: (v: unknown) => v is T): T | undefined => test(value) ? value : undefined;
const isString = (pattern: RegExp) => (v: unknown): v is string => typeof v === "string" && pattern.test(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const failure = (code: string, error: string, extra: object = {}) => reply({ ok: false, code, error, ...extra }, STATUS[code] ?? 400);
const clockText = (epoch: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(epoch * 1000);

function residentRun(value: unknown): ResidentRun | undefined {
  const r = object(value);
  if (!isString(NAME)(r.name)) return undefined;
  const out: ResidentRun = { name: r.name };
  const set = <K extends keyof ResidentRun>(key: K, v: ResidentRun[K] | undefined) => { if (v !== undefined) out[key] = v; };
  set("persona", pick(r.persona, isString(/^[a-z0-9_-]{1,40}$/)));
  set("result", pick(r.result, isString(RESULT)));
  set("running", typeof r.running === "boolean" ? r.running : undefined);
  set("run_state", pick(r.run_state, isString(RESULT)));
  set("client_state", pick(r.client_state, isString(RESULT)));
  set("end_at", r.end_at === null ? null : pick(r.end_at, isInt));
  set("model", r.model === null ? null : pick(r.model, isString(MODEL)));
  set("mode", r.mode === null ? null : pick(r.mode, isString(/^(fresh|resume)$/)));
  set("thread_id", r.thread_id === null ? null : pick(r.thread_id, isString(THREAD)));
  set("dry_run", typeof r.dry_run === "boolean" ? r.dry_run : undefined);
  set("unit", pick(r.unit ?? r.run_unit, isString(UNIT)));
  set("client_unit", pick(r.client_unit, isString(UNIT)));
  set("started_by", r.started_by === null ? null : text(r.started_by, 120));
  set("started_at", r.started_at === null ? null : pick(r.started_at, isInt));
  set("activation", r.activation === null ? null : pick(r.activation, isString(/^[\w-]{1,80}$/)));
  set("error", text(r.error));
  if (Array.isArray(r.active_units)) out.active_units = r.active_units.filter(isString(UNIT)).slice(0, 8);
  if (Array.isArray(r.client_pids)) out.client_pids = r.client_pids.filter(isInt).slice(0, 16);
  return out;
}

function caretakerRun(value: unknown): CaretakerRun | null {
  if (value === null || value === undefined) return null;
  const c = object(value), out: CaretakerRun = {};
  if (isString(UNIT)(c.unit)) out.unit = c.unit;
  if (isString(RESULT)(c.state)) out.state = c.state;
  if (typeof c.running === "boolean") out.running = c.running;
  if (isString(RESULT)(c.result)) out.result = c.result;
  if (c.end_at === null || isInt(c.end_at)) out.end_at = c.end_at as number | null;
  if (Array.isArray(c.roster)) out.roster = c.roster.filter(isString(/^\w{1,16}:[a-z0-9_-]{1,40}$/)).slice(0, 16);
  if (c.interval === null || isInt(c.interval)) out.interval = c.interval as number | null;
  const error = text(c.error);
  if (error) out.error = error;
  return out;
}

/** A launcher's or station's reply, reduced to known fields. */
function hostResult(host: string, value: unknown, fallbackCode: string, scrub: (s: string) => string = s => s): HostResult {
  const data = object(value);
  const code = isString(/^[a-z_]{1,32}$/)(data.code) ? data.code : fallbackCode;
  const result: HostResult = {
    host, ok: data.ok === true && code === "ok", code,
    residents: Array.isArray(data.residents) ? data.residents.slice(0, 32).map(residentRun).filter((r): r is ResidentRun => !!r) : [],
    caretaker: caretakerRun(data.caretaker),
  };
  const error = text(data.error, 600);
  if (error) result.error = scrub(error);
  for (const r of result.residents) if (r.error) r.error = scrub(r.error);
  if (data.end_at === null || isInt(data.end_at)) result.end_at = data.end_at as number | null;
  const activation = data.activation ?? data.id;
  if (activation === null || isString(/^[\w-]{1,80}$/)(activation)) result.activation = activation as string | null;
  if (typeof data.changed === "boolean") result.changed = data.changed;
  if (typeof data.dry_run === "boolean") result.dry_run = data.dry_run;
  if (typeof data.mixed_end_times === "boolean") result.mixed_end_times = data.mixed_end_times;
  return result;
}

const unreachable = (host: string, what: "started" | "stopped" | "read") => ({
  host, ok: false, code: "unreachable", residents: [], caretaker: null,
  error: what === "read" ? `station ${host} unreachable: its runs are unknown` : `station ${host} unreachable: nothing was ${what} there`,
} satisfies HostResult);

/** Overall status for a multi-host reply: 200 only when every host is ok. */
function overall(hosts: HostResult[]): { status: number; ok: boolean; code: string } {
  if (hosts.length && hosts.every(h => h.ok)) return { status: 200, ok: true, code: "ok" };
  const codes = new Set(hosts.map(h => h.code));
  if (hosts.length === 1 || (codes.size === 1 && !hosts.some(h => h.ok))) {
    const code = hosts[0]?.code ?? "error";
    return { status: STATUS[code] ?? 502, ok: false, code };
  }
  return { status: 207, ok: false, code: "partial" };
}

/** A launcher's output, bounded in size but not in time (a stop can take minutes; the caller's timer kills it). */
async function pipeText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > OUTPUT_LIMIT) { await reader.cancel(); break; }
      chunks.push(next.value);
    }
  } catch { /* closed by a kill */ }
  return Buffer.concat(chunks).toString("utf8");
}

interface Credential { name: string; sha256: string }
interface Target { kind: "local" | "station"; host: string; url?: string; unreachable?: boolean; residents: "all" | string[] }

export class RunControl {
  private stamp = "";
  private credentials: Credential[] = [];
  private credentialProblem: string | undefined = "not_configured";
  private busy = false;
  private statusFlight?: { at: number; promise: Promise<HostResult> };
  private seen = new Set<string>();
  private controllers = new Set<AbortController>();
  private stopped = false;
  private readonly fetcher: NonNullable<RunControlOptions["fetch"]>;
  private readonly log: (line: string) => void;

  constructor(private config: Config, private tail: RolloutTail, private federation?: Federation, private options: RunControlOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.log = options.log ?? console.log;
  }

  stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }

  // ---------- HTTP ----------

  /** `/controller/v1/<route>`: bearer credential required for everything. */
  async handleController(request: Request, route: string): Promise<Response> {
    const who = this.authenticate(request);
    if (who instanceof Response) return who;
    try {
      if (route === "runs" && request.method === "GET") return this.statusReply();
      if (request.method !== "POST" || !["start", "stop"].includes(route)) return reply({ ok: false, code: "not_found", error: "Not found: use GET runs, POST start or POST stop." }, 404);
      const body = await this.body(request);
      return route === "start" ? await this.startReply(body, who.name) : await this.stopReply(body, who.name);
    } catch (error) {
      if (error instanceof LiveError && error.status === 413) return failure("too_large", `The request body is larger than ${BODY_LIMIT} bytes.`);
      if (error instanceof z.ZodError) return failure("usage", `Invalid request: ${error.issues.map(i => `${i.path.join(".") || "body"} ${i.message}`).join("; ").slice(0, 300)}.`);
      if (error instanceof SyntaxError) return failure("usage", error.message);
      this.log(`run control failed: ${error instanceof Error ? error.message : error}`);
      return failure("error", "Run control hit an unexpected problem; nothing more is known about this request. Check status.");
    }
  }

  /** `/<token>/api/runs` for the dashboard: status only. */
  statusReply = async (): Promise<Response> => {
    const hosts = await this.allStatus();
    const now = Math.floor(Date.now() / 1000);
    return reply({ ok: hosts.every(h => h.ok), code: hosts.every(h => h.ok) ? "ok" : "partial", now, hosts, warnings: [] } satisfies RunsReply);
  };

  private authenticate(request: Request): Credential | Response {
    const url = new URL(request.url), origin = request.headers.get("Origin"), site = request.headers.get("Sec-Fetch-Site");
    // Bearer headers are never attached by a browser on its own, so there is no CSRF path;
    // still, a browser request must come from this page's own origin.
    const host = request.headers.get("Host");
    if ((origin && origin !== `${url.protocol}//${host ?? url.host}`) || (site && !["same-origin", "none"].includes(site))) {
      return failure("forbidden", "Cross-origin requests to run control are refused.");
    }
    this.loadCredentials();
    if (this.credentialProblem === "not_configured") return failure("unauthorized", "Run control is not configured on this host: no controller credentials file.");
    if (this.credentialProblem) return failure("not_configured", "The controller credentials file is invalid: expected a mode-600 JSON array of {name, role: \"controller\", sha256}.");
    const header = request.headers.get("Authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{16,512}$/.test(header)) return failure("unauthorized", "A controller bearer token is required.");
    const digest = createHash("sha256").update(header.slice(7)).digest();
    let found: Credential | undefined;
    for (const credential of this.credentials) if (timingSafeEqual(digest, Buffer.from(credential.sha256, "hex"))) found = credential;
    return found ?? failure("unauthorized", "Unknown controller token.");
  }

  private loadCredentials() {
    const file = this.config.runControl.credentialsFile;
    try {
      const info = statSync(file);
      const stamp = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.mode}`;
      if (stamp === this.stamp) return;
      this.stamp = stamp;
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) throw new Error();
      const entries = credentialSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (new Set(entries.map(c => c.sha256)).size !== entries.length || new Set(entries.map(c => c.name.toLowerCase())).size !== entries.length) throw new Error();
      this.credentials = entries;
      this.credentialProblem = undefined;
    } catch (error) {
      this.credentials = [];
      this.credentialProblem = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_configured" : "invalid";
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.stamp = "";
    }
  }

  private async body(request: Request): Promise<unknown> {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new SyntaxError("Send the request as application/json.");
    if (Number(request.headers.get("Content-Length") ?? 0) > BODY_LIMIT) throw new LiveError(413, "too large");
    const body = await textLimited(request.body, BODY_LIMIT, request.signal);
    try { return JSON.parse(body); } catch { throw new SyntaxError("The request body is not JSON."); }
  }

  // ---------- planning ----------

  private stations() {
    return this.federation?.controlStations() ?? [];
  }

  /** Split the named residents (or all) by owning host; unknown or ambiguous names refuse the whole request. */
  private targets(residents: "all" | string[]): Target[] | Response {
    const stations = this.stations();
    const local = this.config.residents.map(r => r.name);
    if (residents === "all") {
      return [{ kind: "local", host: this.config.hostName, residents: "all" },
        ...stations.map(s => ({ kind: "station" as const, host: s.host, url: s.url, unreachable: s.unreachable, residents: "all" as const }))];
    }
    const byHost = new Map<string, Target>();
    for (const asked of residents) {
      const key = asked.toLowerCase();
      const owners = [
        ...local.filter(n => n.toLowerCase() === key).map(name => ({ host: this.config.hostName, name, station: undefined })),
        ...stations.flatMap(s => s.names.filter(n => n.toLowerCase() === key).map(name => ({ host: s.host, name, station: s }))),
      ];
      if (owners.length === 0) return failure("unknown_resident", `No resident named ${asked} on any host.`);
      if (owners.length > 1) return failure("conflict", `${asked} is configured on more than one host (${owners.map(o => o.host).join(", ")}); fix the station configuration first.`);
      const [owner] = owners;
      const target = byHost.get(owner.host) ?? (owner.station
        ? { kind: "station" as const, host: owner.host, url: owner.station.url, unreachable: owner.station.unreachable, residents: [] as string[] }
        : { kind: "local" as const, host: owner.host, residents: [] as string[] });
      (target.residents as string[]).push(owner.name);
      byHost.set(owner.host, target);
    }
    return [...byHost.values()];
  }

  private endOf(request: z.infer<typeof startSchema>): number | Response {
    let endAt = request.end_at;
    if ((endAt === undefined) === (request.end === undefined)) return failure("usage", "Give exactly one of end_at (Unix seconds) or end (ISO 8601 with a UTC offset, e.g. 2026-11-24T01:00:00-05:00).");
    if (request.end !== undefined) {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?(Z|[+-]\d\d:\d\d)$/.test(request.end)) return failure("usage", "end must be ISO 8601 with a UTC offset, e.g. 2026-11-24T01:00:00-05:00.");
      endAt = Math.floor(Date.parse(request.end) / 1000);
      if (!Number.isSafeInteger(endAt)) return failure("usage", "end is not a valid time.");
    }
    const now = Date.now() / 1000;
    if (endAt! <= now) return failure("deadline", `The end time ${clockText(endAt!)} is in the past.`);
    if (endAt! - now > MAX_AHEAD) return failure("deadline", "The end time is more than 24 hours away.");
    return endAt!;
  }

  // ---------- start / stop ----------

  private async exclusive<T>(work: () => Promise<T>): Promise<T | Response> {
    if (this.busy) return failure("busy", `Another start or stop is in progress on ${this.config.hostName}; try again shortly.`);
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }

  private async startReply(raw: unknown, caller: string): Promise<Response> {
    const parsed = startSchema.parse(raw);
    const endAt = this.endOf(parsed);
    if (endAt instanceof Response) return endAt;
    const request: StartRequest = { ...parsed, end_at: endAt, end: undefined };
    const by = request.on_behalf_of ? `${request.on_behalf_of} via ${caller}` : caller;
    const targets = this.targets(request.residents);
    if (targets instanceof Response) return targets;
    const all = [...new Set([...Object.keys(request.models ?? {}), ...(Array.isArray(request.fresh) ? request.fresh : [])])];
    for (const name of all) {
      const owner = targets.find(t => t.residents === "all" ? this.hostHas(t, name) : t.residents.some(n => n.toLowerCase() === name.toLowerCase()));
      if (!owner) return failure("usage", `${name} is named in models or fresh but is not being started.`);
    }
    const done = await this.exclusive(async () => {
      const warnings: string[] = [];
      // One end time for every run on every host: refuse before anything starts.
      if (this.stations().length) {
        const statuses = await this.allStatus(true);
        const conflicts: string[] = [];
        for (const host of statuses) {
          if (!host.ok) { warnings.push(`${host.host}: could not confirm its runs share this end time (${host.error ?? host.code}).`); continue; }
          for (const r of host.residents) if (r.running && r.end_at !== endAt) conflicts.push(`${r.name} is already running until ${r.end_at ? clockText(r.end_at) : "an unknown time"} on ${host.host}`);
          const c = host.caretaker;
          if (c?.running && c.end_at && c.end_at !== endAt) conflicts.push(`the caretaker on ${host.host} is running until ${clockText(c.end_at)}`);
        }
        if (conflicts.length) return failure("conflict", `${conflicts.join("; ")}. Every run shares one end time: stop them first or use the same end time. Nothing was started.`);
      }
      const hosts = await Promise.all(targets.map(target => target.kind === "local"
        ? this.localStart(request, target.residents, by)
        : this.forward(target, "start", { ...this.forStation(request, target), on_behalf_of: by })));
      this.refreshActivity();
      return this.combined(hosts, warnings, endAt, "start", by);
    });
    return done;
  }

  private async stopReply(raw: unknown, caller: string): Promise<Response> {
    const request: StopRequest = stopSchema.parse(raw);
    const by = request.on_behalf_of ? `${request.on_behalf_of} via ${caller}` : caller;
    const targets = this.targets(request.residents);
    if (targets instanceof Response) return targets;
    return this.exclusive(async () => {
      const hosts = await Promise.all(targets.map(target => target.kind === "local"
        ? this.localStop(target.residents, by)
        : this.forward(target, "stop", { residents: target.residents, on_behalf_of: by })));
      this.refreshActivity();
      return this.combined(hosts, [], undefined, "stop", by);
    }) as Promise<Response>;
  }

  private hostHas(target: Target, name: string): boolean {
    const key = name.toLowerCase();
    if (target.kind === "local") return this.config.residents.some(r => r.name.toLowerCase() === key);
    return this.stations().some(s => s.host === target.host && s.names.some(n => n.toLowerCase() === key));
  }

  /** The station's share of a start request: only its own residents' models and fresh list. */
  private forStation(request: StartRequest, target: Target): object {
    const mine = (name: string) => this.hostHas(target, name);
    const models = Object.fromEntries(Object.entries(request.models ?? {}).filter(([name]) => mine(name)));
    const fresh = request.fresh === "all" ? "all" : (request.fresh ?? []).filter(mine);
    return {
      residents: target.residents, end_at: request.end_at,
      ...(request.model ? { model: request.model } : {}), ...(Object.keys(models).length ? { models } : {}),
      ...(fresh === "all" || fresh.length ? { fresh } : {}),
      ...(request.caretaker ? { caretaker: request.caretaker } : {}), ...(request.note ? { note: request.note } : {}),
    };
  }

  private combined(hosts: HostResult[], warnings: string[], endAt: number | undefined, action: string, by: string): Response {
    const { status, ok, code } = overall(hosts);
    const summary = hosts.map(h => `${h.host} ${h.code}`).join(", ");
    this.log(`run control: ${action} by ${by}: ${summary}`);
    const error = ok ? undefined : hosts.filter(h => !h.ok).map(h => `${h.host}: ${h.error ?? h.code}`).join(" ");
    return reply({ ok, code, ...(error ? { error } : {}), now: Math.floor(Date.now() / 1000), ...(endAt ? { end_at: endAt } : {}), hosts, warnings } satisfies RunsReply, status);
  }

  // ---------- this host's launcher ----------

  private startArgs(request: StartRequest, residents: "all" | string[], by: string): string[] {
    const local = (name: string) => residents === "all" ? this.config.residents.some(r => r.name.toLowerCase() === name.toLowerCase())
      : residents.some(n => n.toLowerCase() === name.toLowerCase());
    // Every value rides in its option's own word (--opt=value): nothing can be read as another option.
    const argv = [...(residents === "all" ? ["--all"] : residents), `--end-at=${request.end_at}`];
    if (request.model) argv.push(`--model=${request.model}`);
    for (const [name, model] of Object.entries(request.models ?? {})) if (local(name)) argv.push(`--model=${name}=${model}`);
    if (request.fresh === "all") argv.push("--fresh=all");
    else for (const name of request.fresh ?? []) if (local(name)) argv.push(`--fresh=${name}`);
    const caretaker = request.caretaker;
    if (caretaker?.enabled !== undefined) argv.push(`--caretaker=${caretaker.enabled ? "on" : "off"}`);
    if (caretaker?.interval !== undefined) argv.push(`--caretaker-interval=${caretaker.interval}`);
    if (caretaker?.speak !== undefined) argv.push(`--caretaker-speak=${caretaker.speak}`);
    if (request.note) argv.push(`--note=${request.note}`);
    argv.push(`--by=${by}`, "--json");
    return argv;
  }

  private localStart(request: StartRequest, residents: "all" | string[], by: string): Promise<HostResult> {
    return this.launch("start-run.sh", this.startArgs(request, residents, by), TIMEOUTS.start, "started");
  }
  private localStop(residents: "all" | string[], by: string): Promise<HostResult> {
    return this.launch("stop-run.sh", [...(residents === "all" ? ["--all"] : residents), `--by=${by}`, "--json"], TIMEOUTS.stop, "stopped");
  }
  private localStatus(): Promise<HostResult> {
    const flight = this.statusFlight;
    if (flight && Date.now() - flight.at < STATUS_TTL) return flight.promise;
    const promise = this.launch("run-status.sh", ["--json"], TIMEOUTS.status, "read");
    this.statusFlight = { at: Date.now(), promise };
    return promise;
  }

  /** One launcher process: fixed argv, scrubbed environment, bounded time and output. */
  private async launch(script: string, args: string[], defaultTimeout: number, what: "started" | "stopped" | "read"): Promise<HostResult> {
    const host = this.config.hostName;
    const kind = script === "start-run.sh" ? "start" : script === "stop-run.sh" ? "stop" : "status";
    const timeout = this.options.timeouts?.[kind] ?? defaultTimeout;
    const env: Record<string, string> = { GARY_CLIENT_HOME: this.config.home, LANG: "C.UTF-8" };
    for (const key of ["HOME", "PATH", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "RESIDENTS_STATE_DIR", "RESIDENTS_RUN_CONF"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    if (this.config.runControl.stateDir) env.RESIDENTS_STATE_DIR = this.config.runControl.stateDir;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn([join(this.config.runControl.toolsDir, script), ...args], {
        env, cwd: this.config.home, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
    } catch {
      return { host, ok: false, code: "not_configured", residents: [], caretaker: null,
        error: `the run launcher (${script}) is not installed in ${this.config.runControl.toolsDir}; nothing was ${what}.` };
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    try {
      const output = Promise.all([
        pipeText(child.stdout), pipeText(child.stderr),
      ]);
      const exit = await child.exited;
      // After a timeout the pipes may stay open (a grandchild); what it printed is not needed.
      if (timedOut) {
        return { host, ok: false, code: "timeout", residents: [], caretaker: null,
          error: `the launcher did not finish within ${Math.round(timeout / 1000)} s; what it did is unknown. Check status before retrying.` };
      }
      const [stdout, stderr] = await output;
      let data: unknown;
      try { data = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { /* below */ }
      if (!data) {
        return { host, ok: false, code: exit === 0 ? "error" : CODES[exit] ?? "error", residents: [], caretaker: null,
          error: `the launcher gave no readable reply (exit ${exit})${stderr.trim() ? `: ${text(stderr.trim().split("\n").pop(), 200)}` : ""}` };
      }
      const result = hostResult(host, data, CODES[exit] ?? "error");
      if ((exit === 0) !== result.ok) { result.ok = false; if (result.code === "ok") result.code = "error"; }
      return result;
    } finally { clearTimeout(timer); }
  }

  // ---------- stations ----------

  private stationToken(host: string): string | undefined {
    try {
      const fd = openSync(join(this.config.runControl.stationTokensDir, `${host}.token`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024) return undefined;
        const token = readFileSync(fd, "utf8").trim();
        return /^[A-Za-z0-9_-]{16,512}$/.test(token) ? token : undefined;
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }

  private async forward(target: Target, action: "start" | "stop", body: object): Promise<HostResult> {
    const { host } = target, what = action === "start" ? "started" : "stopped";
    if (target.unreachable) return unreachable(host, what);
    const token = this.stationToken(host);
    if (!token) {
      return { host, ok: false, code: "not_configured", residents: [], caretaker: null,
        error: `the hub has no controller token for this station (${host}.token in its controller station tokens directory): nothing was ${what} there.` };
    }
    const url = new URL(`/controller/v1/${action}`, target.url!).href;
    const result = await this.call(target, url, action, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    }, what);
    // A station's reply for its own host, relabelled with the hub's name for it.
    if ("hosts" in result) return { ...hostResult(host, result.hosts[0], "error", this.scrubber(target)), host };
    return result;
  }

  private async stationStatus(target: Target): Promise<HostResult> {
    if (target.unreachable) return unreachable(target.host, "read");
    const result = await this.call(target, new URL("api/runs", target.url!).href, "status", { method: "GET", headers: { Accept: "application/json" } }, "read");
    if ("hosts" in result) return { ...hostResult(target.host, result.hosts[0], "error", this.scrubber(target)), host: target.host };
    return result;
  }

  private scrubber(target: Target): (s: string) => string {
    const url = new URL(target.url!);
    const secrets = [url.host, ...url.pathname.split("/")].filter(part => part.length >= 6);
    return s => secrets.reduce((out, secret) => out.split(secret).join("<station>"), s);
  }

  /** One bounded request to a station; never follows redirects (the bearer stays with the station). */
  private async call(target: Target, url: string, action: keyof typeof FORWARD, init: RequestInit, what: "started" | "stopped" | "read"):
    Promise<HostResult | { hosts: unknown[] }> {
    const { host } = target;
    if (this.stopped) return { host, ok: false, code: "error", residents: [], caretaker: null, error: "Commons is shutting down." };
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.forward?.[action] ?? FORWARD[action]);
    try {
      let response: Response;
      try { response = await this.fetcher(url, { ...init, redirect: "error", signal: controller.signal }); }
      catch {
        return timedOut
          ? { host, ok: false, code: "timeout", residents: [], caretaker: null, error: `station ${host} did not answer in time: whether anything was ${what} there is unknown. Check status.` }
          : unreachable(host, what);
      }
      let data: Record<string, unknown> = {};
      try { data = object(JSON.parse(await textLimited(response.body, OUTPUT_LIMIT, controller.signal))); } catch { /* below */ }
      if (Array.isArray(data.hosts)) return { hosts: data.hosts };
      if (response.status === 401 || response.status === 403) {
        return { host, ok: false, code: "unauthorized", residents: [], caretaker: null, error: `station ${host} refused the hub's controller token: nothing was ${what} there.` };
      }
      if (response.status === 404) {
        return { host, ok: false, code: "not_configured", residents: [], caretaker: null, error: `station ${host} has no run control (older Commons?): nothing was ${what} there.` };
      }
      const code = isString(/^[a-z_]{1,32}$/)(data.code) ? data.code : "error";
      return { host, ok: false, code, residents: [], caretaker: null,
        error: this.scrubber(target)(text(data.error, 600) ?? `station ${host} answered ${response.status}`) };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  /** This host, then every station; a station's failure is its own entry. */
  async allStatus(fresh = false): Promise<HostResult[]> {
    if (fresh) this.statusFlight = undefined;
    const stations = this.stations().map(s => ({ kind: "station" as const, host: s.host, url: s.url, unreachable: s.unreachable, residents: "all" as const }));
    return Promise.all([this.localStatus(), ...stations.map(target => this.stationStatus(target))]);
  }

  // ---------- Activity ----------

  /** Starts and stops recorded on this host (by Commons or by hand) become Activity events of each resident. */
  refreshActivity() {
    const dir = join(this.config.runControl.stateDir, "activations");
    let files: string[];
    try { files = readdirSync(dir).filter(file => file.endsWith(".json")).sort().slice(-200); } catch { return; }
    const cutoff = Date.now() - this.config.activityDays * 86_400_000;
    for (const file of files) {
      if (this.seen.has(file)) continue;
      this.seen.add(file);
      let record: Record<string, unknown>;
      try { record = object(JSON.parse(readFileSync(join(dir, file), "utf8"))); } catch { continue; }
      const at = Number(record.created_at) * 1000;
      if (record.schema !== "residents-activation/1" || !Number.isFinite(at) || at < cutoff) continue;
      const by = text(record.requested_by, 120) ?? "unknown", dry = record.dry_run === true ? " (dry run: no mind)" : "";
      const until = isInt(record.end_at) ? ` until ${clockText(record.end_at)}` : "";
      for (const entry of Array.isArray(record.residents) ? record.residents : []) {
        const r = residentRun(entry);
        if (!r || !this.config.residents.some(c => c.name === r.name)) continue;
        if (record.kind === "start" && (r.result === "started" || r.result === "failed")) {
          const how = r.mode === "resume" ? `resumed thread ${r.thread_id ?? ""}`.trim() : "fresh thread";
          this.tail.recordEvent(r.name, at, r.result === "started" ? "run_started" : "run_failed",
            r.result === "started" ? `by ${by}${until}, ${r.model ?? "model unknown"}, ${how}${dry}` : `start by ${by} failed: ${r.error ?? "unknown error"}`);
        } else if (record.kind === "stop" && r.result !== "not_running") {
          this.tail.recordEvent(r.name, at, "run_stopped", r.result === "stopped" ? `by ${by}` : `by ${by}, but still active: ${(r.active_units ?? []).join(", ")}${r.client_pids?.length ? ` client pid ${r.client_pids.join(", ")}` : ""}`);
        }
      }
    }
  }
}
