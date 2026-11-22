// Optional, read-only client for the server-side Resident Observer mod
// (../../server-observer). It is an adjunct source: what the Minecraft server itself sees of
// configured residents and registered facilities. It never replaces a resident client's own
// Synapse state, picture or health, and every value carries its source, time and the
// observer's own health so an outage is shown, never hidden behind the other source.
import { readFile } from "node:fs/promises";
import { expandHome } from "./config.ts";
import { finite, record } from "./json.ts";

export interface ObserverSource {
  /** Base URL of the observer (usually a loopback end of an SSH tunnel). No credentials in it. */
  url: string;
  /** File holding this consumer's bearer token; read on every request, never logged. */
  tokenFile: string;
}

/**
 * `COMMONS_OBSERVER_URL` and `COMMONS_OBSERVER_TOKEN_FILE`: both or neither.
 * Neither: undefined (the observer is simply not used). A URL carrying credentials,
 * a query or a fragment is refused so a secret can never sit in a URL or a log line.
 */
export function observerSourceFromEnv(env: Record<string, string | undefined>): ObserverSource | undefined {
  const url = env.COMMONS_OBSERVER_URL?.trim() || undefined;
  const tokenFile = env.COMMONS_OBSERVER_TOKEN_FILE?.trim() || undefined;
  if (!url && !tokenFile) return undefined;
  if (!url || !tokenFile) throw new Error("COMMONS_OBSERVER_URL and COMMONS_OBSERVER_TOKEN_FILE must be set together.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("COMMONS_OBSERVER_URL is not a URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("COMMONS_OBSERVER_URL must be http or https.");
  if (parsed.username || parsed.password) throw new Error("COMMONS_OBSERVER_URL must not contain credentials; put the token in COMMONS_OBSERVER_TOKEN_FILE.");
  if (parsed.search || parsed.hash) throw new Error("COMMONS_OBSERVER_URL must not have a query or fragment.");
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ""), tokenFile: expandHome(tokenFile) };
}

export type ObserverReach =
  | { ok: true; data: Record<string, unknown>; receivedAt: number }
  | { ok: false; status: "offline" | "unauthorized" | "forbidden" | "incompatible" | "error"; detail: string };

const SCHEMA = 1;
const SOURCE = "server-observer";

/** One GET against the observer. The token goes only into the Authorization header. */
export async function observerGet(
  source: ObserverSource, path: string, timeoutMs = 4000, fetchImpl: typeof fetch = fetch, now: () => number = Date.now,
): Promise<ObserverReach> {
  let secret = "";
  try { secret = (await readFile(source.tokenFile, "utf8")).trim(); } catch { /* reported below */ }
  if (!secret) return { ok: false, status: "unauthorized", detail: `No observer token in ${source.tokenFile}.` };
  let response: Response;
  try {
    response = await fetchImpl(`${source.url}${path}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: "offline", detail: "The server observer did not answer (server down, tunnel down, or mod not loaded)." };
  }
  let body: Record<string, unknown> | undefined;
  try { body = record(await response.json()); } catch { /* not JSON */ }
  const message = body ? String(record(body.error).message ?? `HTTP ${response.status}`) : `HTTP ${response.status} without JSON`;
  if (response.status === 401) return { ok: false, status: "unauthorized", detail: `The observer refused the token: ${message}` };
  if (response.status === 403) return { ok: false, status: "forbidden", detail: `The observer refused this request: ${message}` };
  if (!response.ok) return { ok: false, status: "error", detail: `Observer: ${message}` };
  if (!body) return { ok: false, status: "error", detail: `The observer answered ${message}.` };
  if (body.source !== SOURCE || body.schema !== SCHEMA) {
    return { ok: false, status: "incompatible", detail: `Expected ${SOURCE} schema ${SCHEMA}, got ${String(body.source)} schema ${String(body.schema)}.` };
  }
  return { ok: true, data: body, receivedAt: now() };
}

// === normalized shapes (what the UI renders) ===

/** Every `*At` below is on THIS machine's clock: server times shifted by (receivedAt - servedAt). */
export interface ObservedBody {
  at: number;
  gameTime: number;
  /** Full id, e.g. `minecraft:overworld`. */
  dimension: string;
  pos: { x: number; y: number; z: number };
  health: number; maxHealth: number; food: number;
  air: number; maxAir: number;
  gameMode: string | null;
  dead: boolean; sleeping: boolean;
  /** Entity id of what it rides, e.g. `minecraft:boat`; null on foot. */
  vehicle: string | null;
  xpLevel: number;
}
export interface ObservedResident {
  source: "server-observer";
  name: string;
  uuid: string;
  /** Online on the server at `checkedAt`. Independent of the client's own status. */
  online: boolean;
  checkedAt: number;
  /** Set when online. */
  body: ObservedBody | null;
  /** When offline: the last body the server saw in this server run, else null. History, not presence. */
  lastSeen: ObservedBody | null;
  /** When the snapshot holding this was fetched (local clock). */
  receivedAt: number;
}
export interface ObservedItem { item: string; count: number; /** Stacks with NBT (contents are never sent). */ nbtStacks: number }
export interface ObservedContents {
  block: string | null;
  slots: number; usedSlots: number; slotsTruncated: boolean;
  items: ObservedItem[]; itemsTruncated: boolean;
  energy: { stored: number; max: number } | null;
  fluids: { fluid: string; amount: number; capacity: number }[];
  readMicros: number;
}
export type FacilityStatus = "pending" | "observed" | "unloaded" | "no_level" | "no_block_entity" | "unsupported" | "error";
export interface ObservedFacility {
  id: string; label: string; dimension: string; pos: [number, number, number]; side: string | null;
  /** Only "observed" means `contents` is current as of `checkedAt`. */
  status: FacilityStatus;
  detail: string | null;
  checkedAt: number;
  gameTime: number;
  contents: ObservedContents | null;
  /** Last observed stock while not observable now (e.g. chunk unloaded). History, never current stock. */
  lastKnown: ObservedContents | null;
  lastObservedAt: number | null;
}
export interface ObservedWorld {
  source: "server-observer";
  /** The observer's own health when it answered: starting | ok | degraded | paused | stalled | tripped. */
  state: string;
  stateDetail: string | null;
  seq: number;
  builtAt: number;
  gameTime: number;
  /** servedAt - builtAt, measured on the server's clock (skew-free). */
  ageMs: number;
  receivedAt: number;
  /** receivedAt - servedAt: how far the server clock is behind this one (plus network latency). */
  clockOffsetMs: number;
  consumer: string;
  scopes: string[];
  residents: ObservedResident[];
  facilities: ObservedFacility[];
}
export interface ObservedEvent {
  seq: number;
  type: string;
  at: number;
  gameTime: number;
  resident: string | null;
  facility: string | null;
  detail: string | null;
}
export type ObserverStatus =
  | "unconfigured" | "unchecked"
  /** States reported by a reachable observer. */
  | "ok" | "degraded" | "paused" | "stalled" | "tripped" | "starting"
  /** Reachable and "ok", but its snapshot is older than staleMs. */
  | "stale"
  /** The request itself failed. */
  | "offline" | "unauthorized" | "forbidden" | "incompatible" | "error";
export interface ObserverHealth {
  source: "server-observer";
  status: ObserverStatus;
  detail: string | null;
  /** Local time of the last poll attempt; 0 before the first. */
  checkedAt: number;
  /** Local time of the last poll that returned a snapshot, or null. */
  okAt: number | null;
  /** Server-measured age of the last snapshot, or null. */
  snapshotAgeMs: number | null;
  /** True once the server's bounded event ring dropped events this feed had not read yet. */
  missedEvents: boolean;
}

const text = (value: unknown) => typeof value === "string" ? value : null;
const bool = (value: unknown) => value === true;

function body(value: unknown, shift: number): ObservedBody | null {
  const raw = record(value), pos = record(raw.pos);
  const x = finite(pos.x), y = finite(pos.y), z = finite(pos.z), at = finite(raw.atMs);
  if (x === undefined || y === undefined || z === undefined || at === undefined || typeof raw.dimension !== "string") return null;
  return {
    at: at + shift, gameTime: finite(raw.gameTime) ?? 0, dimension: raw.dimension, pos: { x, y, z },
    health: finite(raw.health) ?? 0, maxHealth: finite(raw.maxHealth) ?? 20, food: finite(raw.food) ?? 0,
    air: finite(raw.air) ?? 0, maxAir: finite(raw.maxAir) ?? 300, gameMode: text(raw.gameMode),
    dead: bool(raw.dead), sleeping: bool(raw.sleeping), vehicle: text(raw.vehicle), xpLevel: finite(raw.xpLevel) ?? 0,
  };
}

function contents(value: unknown): ObservedContents | null {
  if (value === null || typeof value !== "object") return null;
  const raw = record(value), energy = record(raw.energy);
  const stored = finite(energy.stored), max = finite(energy.max);
  return {
    block: text(raw.block), slots: finite(raw.slots) ?? 0, usedSlots: finite(raw.usedSlots) ?? 0,
    slotsTruncated: bool(raw.slotsTruncated),
    items: (Array.isArray(raw.items) ? raw.items : []).flatMap(entry => {
      const item = record(entry), count = finite(item.count);
      return typeof item.item === "string" && count !== undefined ? [{ item: item.item, count, nbtStacks: finite(item.nbtStacks) ?? 0 }] : [];
    }),
    itemsTruncated: bool(raw.itemsTruncated),
    energy: stored !== undefined && max !== undefined ? { stored, max } : null,
    fluids: (Array.isArray(raw.fluids) ? raw.fluids : []).flatMap(entry => {
      const fluid = record(entry), amount = finite(fluid.amount);
      return typeof fluid.fluid === "string" && amount !== undefined ? [{ fluid: fluid.fluid, amount, capacity: finite(fluid.capacity) ?? 0 }] : [];
    }),
    readMicros: finite(raw.readMicros) ?? 0,
  };
}

const FACILITY_STATUSES: Record<FacilityStatus, true> = {
  pending: true, observed: true, unloaded: true, no_level: true, no_block_entity: true, unsupported: true, error: true,
};

function facility(value: unknown, shift: number): ObservedFacility | null {
  const raw = record(value);
  const pos = Array.isArray(raw.pos) && raw.pos.length === 3 && raw.pos.every(n => finite(n) !== undefined) ? raw.pos as [number, number, number] : null;
  if (typeof raw.id !== "string" || !pos) return null;
  const status = typeof raw.status === "string" && Object.hasOwn(FACILITY_STATUSES, raw.status) ? raw.status as FacilityStatus : "error";
  const lastObserved = finite(raw.lastObservedAtMs);
  return {
    id: raw.id, label: text(raw.label) ?? raw.id, dimension: text(raw.dimension) ?? "unknown", pos, side: text(raw.side),
    status, detail: status === raw.status ? text(raw.detail) : `unknown status ${JSON.stringify(raw.status)}`,
    checkedAt: (finite(raw.checkedAtMs) ?? 0) + shift, gameTime: finite(raw.gameTime) ?? 0,
    // Only an observed facility has current contents, whatever the payload says.
    contents: status === "observed" ? contents(raw.contents) : null,
    lastKnown: contents(raw.lastKnown),
    lastObservedAt: lastObserved === undefined ? null : lastObserved + shift,
  };
}

/**
 * The full `/v1/snapshot` reply as the UI shows it, or null when it carries no snapshot
 * (observer still starting) or is not this schema. Server times are moved onto this
 * machine's clock using the reply's `servedAtMs`.
 */
export function normalizeObserverSnapshot(data: unknown, receivedAt: number): ObservedWorld | null {
  const raw = record(data);
  if (raw.source !== SOURCE || raw.schema !== SCHEMA) return null;
  const snap = record(raw.snapshot), servedAt = finite(raw.servedAtMs), builtAt = finite(snap.builtAtMs), seq = finite(snap.seq);
  if (servedAt === undefined || builtAt === undefined || seq === undefined) return null;
  const shift = receivedAt - servedAt;
  const residents = (Array.isArray(snap.residents) ? snap.residents : []).flatMap((entry): ObservedResident[] => {
    const r = record(entry);
    if (typeof r.name !== "string" || typeof r.uuid !== "string") return [];
    const current = body(r.body, shift);
    return [{
      source: SOURCE, name: r.name, uuid: r.uuid, online: r.online === true && current !== null,
      checkedAt: (finite(r.checkedAtMs) ?? builtAt) + shift, body: current, lastSeen: body(r.lastSeen, shift), receivedAt,
    }];
  });
  return {
    source: SOURCE, state: text(raw.state) ?? "unknown", stateDetail: text(raw.stateDetail),
    seq, builtAt: builtAt + shift, gameTime: finite(snap.gameTime) ?? 0, ageMs: Math.max(0, servedAt - builtAt),
    receivedAt, clockOffsetMs: shift, consumer: text(raw.consumer) ?? "",
    scopes: (Array.isArray(raw.scopes) ? raw.scopes : []).filter(scope => typeof scope === "string"),
    residents,
    facilities: (Array.isArray(snap.facilities) ? snap.facilities : []).flatMap(entry => facility(entry, shift) ?? []),
  };
}

/** States a reachable observer reports about itself. */
const OBSERVER_STATES: Record<string, true> = { ok: true, degraded: true, paused: true, stalled: true, tripped: true, starting: true };

export interface ObserverFeedOptions {
  /** A snapshot older than this (server-measured) makes an "ok" observer "stale". Default 30 s. */
  staleMs?: number;
  /** Events kept here, newest last. Default 200. */
  maxEvents?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Polls one observer: the latest snapshot plus new events. Absent source: health says
 * "unconfigured" and nothing is fetched. The last good world is kept through outages, and
 * `health()` always tells whether it is current.
 */
export class ObserverFeed {
  private latest: ObservedWorld | null = null;
  private recent: ObservedEvent[] = [];
  private cursor: number | null = null;
  private state: ObserverHealth;
  private polling?: Promise<void>;
  private readonly staleMs: number;
  private readonly maxEvents: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly source: ObserverSource | undefined, options: ObserverFeedOptions = {}) {
    this.staleMs = options.staleMs ?? 30_000;
    this.maxEvents = options.maxEvents ?? 200;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.state = {
      source: SOURCE, status: source ? "unchecked" : "unconfigured",
      detail: source ? null : "No server observer configured (COMMONS_OBSERVER_URL).",
      checkedAt: 0, okAt: null, snapshotAgeMs: null, missedEvents: false,
    };
  }

  get configured(): boolean { return this.source !== undefined; }

  /** One snapshot read, then the events after the last seen one. A poll still running is not doubled. */
  poll(): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.polling ??= this.pollOnce(this.source).finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private async pollOnce(source: ObserverSource) {
    const reach = await observerGet(source, "/v1/snapshot", this.timeoutMs, this.fetchImpl, this.now);
    const checkedAt = this.now();
    if (!reach.ok) {
      this.state = { ...this.state, status: reach.status, detail: reach.detail, checkedAt };
      return;
    }
    const world = normalizeObserverSnapshot(reach.data, reach.receivedAt);
    const reported = text(reach.data.state) ?? "error";
    const reportedDetail = text(reach.data.stateDetail);
    if (!world) {
      // Reachable, but no snapshot yet (or none any more): say what the observer says.
      this.state = {
        ...this.state, checkedAt,
        status: Object.hasOwn(OBSERVER_STATES, reported) ? reported as ObserverStatus : "error",
        detail: reportedDetail ?? "The observer answered without a snapshot.",
      };
      return;
    }
    this.latest = world;
    let status: ObserverStatus = Object.hasOwn(OBSERVER_STATES, reported) ? reported as ObserverStatus : "error";
    let detail = reportedDetail;
    if ((status === "ok" || status === "degraded") && world.ageMs > this.staleMs) {
      status = "stale";
      detail = `The newest snapshot is ${Math.round(world.ageMs / 1000)} s old.${reportedDetail ? ` ${reportedDetail}` : ""}`;
    }
    this.state = { ...this.state, status, detail, checkedAt, okAt: checkedAt, snapshotAgeMs: world.ageMs };
    await this.pollEvents(source, world.clockOffsetMs);
  }

  private async pollEvents(source: ObserverSource, shift: number) {
    const after = this.cursor ?? 0;
    const reach = await observerGet(source, `/v1/events?after=${after}&limit=500`, this.timeoutMs, this.fetchImpl, this.now);
    if (!reach.ok) return; // the snapshot answered; a failed event page is retried from the same cursor next poll
    const raw = reach.data;
    // The first page after start has nothing to have missed; later gaps are real losses.
    if (this.cursor !== null && raw.gap === true) this.state = { ...this.state, missedEvents: true };
    const fresh = (Array.isArray(raw.events) ? raw.events : []).flatMap((entry): ObservedEvent[] => {
      const e = record(entry), seq = finite(e.seq), at = finite(e.atMs);
      if (seq === undefined || at === undefined || typeof e.type !== "string") return [];
      return [{ seq, type: e.type, at: at + shift, gameTime: finite(e.gameTime) ?? 0, resident: text(e.resident), facility: text(e.facility), detail: text(e.detail) }];
    });
    const latest = finite(raw.latestSeq);
    const lastFresh = fresh.at(-1)?.seq;
    // Events this consumer may not see still advance the cursor (via latestSeq when the page was not full).
    this.cursor = fresh.length >= 500 && lastFresh !== undefined ? lastFresh : latest ?? lastFresh ?? this.cursor;
    if (fresh.length) this.recent = [...this.recent, ...fresh].slice(-this.maxEvents);
  }

  health(): ObserverHealth { return this.state; }
  /** The last snapshot that was read, possibly old: pair it with `health()`. */
  world(): ObservedWorld | null { return this.latest; }
  resident(name: string): ObservedResident | undefined {
    return this.latest?.residents.find(resident => resident.name.toLowerCase() === name.toLowerCase());
  }
  events(): ObservedEvent[] { return this.recent; }
}

// === choosing a position without hiding either source ===

/** The client side as the Watcher already records it (`Sighting` fits this shape). */
export interface ClientSighting {
  status: "online" | "offline" | "unauthorized" | "error" | "unchecked";
  detail?: string;
  checkedAt: number;
  state: { pos: { x: number; y: number; z: number }; dimension: string } | null;
}
export interface PositionChoice {
  source: "client" | "server-observer" | "none";
  pos: { x: number; y: number; z: number } | null;
  dimension: string | null;
  at: number | null;
  client: { status: ClientSighting["status"]; detail: string | null };
  observer: { status: ObserverStatus; detail: string | null };
  /** Plain sentences about every source that is down, stale, or disagrees. Empty only when all is well. */
  notes: string[];
}

/** Observer states whose snapshot may stand in for a missing client position. */
const USABLE: Partial<Record<ObserverStatus, true>> = { ok: true, degraded: true };

/**
 * Where a resident is, preferring its own client. The server observer fills in only while it is
 * healthy and fresh; whichever source is down is named in `notes`, never silently dropped.
 */
export function choosePosition(client: ClientSighting, observer: ObserverHealth, observed?: ObservedResident): PositionChoice {
  const notes: string[] = [];
  const clientOnline = client.status === "online" && client.state !== null;
  if (!clientOnline) notes.push(`Client ${client.status}${client.detail ? `: ${client.detail}` : "."}`);
  const observerUsable = USABLE[observer.status] === true;
  if (observer.status !== "unconfigured" && !observerUsable) {
    notes.push(`Server observer ${observer.status}${observer.detail ? `: ${observer.detail}` : "."}`);
  } else if (observer.status === "degraded") {
    notes.push(`Server observer degraded${observer.detail ? `: ${observer.detail}` : "."}`);
  }
  const serverBody = observerUsable && observed?.online ? observed.body : null;
  if (observerUsable && observed && !observed.online) notes.push("The server does not see this resident online.");
  if (observerUsable && !observed) notes.push("The server observer does not report this resident (not configured there, or no scope).");

  const base = {
    client: { status: client.status, detail: client.detail ?? null },
    observer: { status: observer.status, detail: observer.detail },
  };
  if (clientOnline && client.state) {
    if (serverBody) {
      const { pos } = client.state, other = serverBody.pos;
      const apart = Math.hypot(pos.x - other.x, pos.y - other.y, pos.z - other.z);
      const sameDimension = client.state.dimension === serverBody.dimension || `minecraft:${client.state.dimension}` === serverBody.dimension;
      if (!sameDimension || apart > 16) {
        notes.push(`Client and server disagree: client ${client.state.dimension} ${pos.x},${pos.y},${pos.z}; server ${serverBody.dimension} ${other.x},${other.y},${other.z}.`);
      }
    }
    return { ...base, source: "client", pos: client.state.pos, dimension: client.state.dimension, at: client.checkedAt, notes };
  }
  if (serverBody) {
    return { ...base, source: "server-observer", pos: serverBody.pos, dimension: serverBody.dimension, at: serverBody.at, notes };
  }
  return { ...base, source: "none", pos: null, dimension: null, at: null, notes };
}
