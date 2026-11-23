// The server bridge's watch list, pushed from the hub (hub only). The bridge keeps no list of its own: which residents
// and facilities it watches comes from here, built from the hub's own data each time:
//   residents  every `role: "resident"` identity in the Resident API credentials (local and station bodies alike,
//              whether or not their station answers), with the offline-mode UUID the server gives that name;
//   facilities every row of the facilities table, as `facility-<id>`.
// The bridge holds the list in memory only, so it is pushed at start, whenever it changes, and whenever the bridge
// shows a different `bootId` (it restarted and lost it) or `revision` than the hub last sent.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  observerGet, observerPut, observerPutWatch, observerWatch, type ObserverSource, type WatchFacility, type WatchResident,
} from "./observer.ts";

/** The bridge's caps; a list over either is refused whole. */
const MAX_RESIDENTS = 64, MAX_FACILITIES = 1024;
const DIMENSION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** The UUID an offline-mode server gives a player name: version 3 of MD5("OfflinePlayer:" + name), as Java's UUID.nameUUIDFromBytes. */
export function offlineUuid(name: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface WatchList { revision: string; residents: WatchResident[]; facilities: WatchFacility[]; left: string[] }

/** The list as the bridge validates it: names it accepts, facilities with a valid dimension and a distinct position. */
export function buildWatchList(db: Database, residents: readonly string[]): WatchList {
  const left: string[] = [];
  const names: string[] = [];
  for (const name of residents) if (/^\w{1,16}$/.test(name) && !names.some(other => other.toLowerCase() === name.toLowerCase())) names.push(name);
  names.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  if (names.length > MAX_RESIDENTS) left.push(`${names.length - MAX_RESIDENTS} residents over the bridge's ${MAX_RESIDENTS}`);
  const facilities: WatchFacility[] = [], places = new Set<string>();
  for (const f of db.query<{ id: number; name: string; x: number; y: number; z: number; dimension: string }, []>(
    "SELECT id, name, x, y, z, dimension FROM facilities ORDER BY id").all()) {
    const dimension = f.dimension.includes(":") ? f.dimension : `minecraft:${f.dimension}`;
    const pos: [number, number, number] = [Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)];
    const place = `${dimension} ${pos.join(" ")}`;
    if (!DIMENSION.test(dimension) || Math.abs(pos[0]) > 30_000_000 || Math.abs(pos[1]) > 2048 || Math.abs(pos[2]) > 30_000_000) { left.push(`facility #${f.id}: not a valid place`); continue; }
    if (places.has(place)) { left.push(`facility #${f.id}: same block as an earlier facility`); continue; }
    places.add(place);
    facilities.push({ id: `facility-${f.id}`, label: f.name.slice(0, 80), dimension, pos, side: null });
  }
  if (facilities.length > MAX_FACILITIES) left.push(`${facilities.length - MAX_FACILITIES} facilities over the bridge's ${MAX_FACILITIES}`);
  const list = {
    residents: names.slice(0, MAX_RESIDENTS).map(name => ({ name, uuid: offlineUuid(name) })),
    facilities: facilities.slice(0, MAX_FACILITIES),
  };
  return { revision: createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16), ...list, left };
}

export interface WatchHealth {
  status: "unconfigured" | "unchecked" | "ok" | "error";
  detail: string | null;
  /** What the hub last pushed and the bridge run that accepted it. */
  revision: string | null;
  bootId: string | null;
  pushedAt: number | null;
  checkedAt: number;
}

export interface WatchPushOptions {
  /** Resident-role identity names; null when they cannot be read now (then nothing is pushed). */
  residents: () => string[] | null;
  /** How often the bridge's list is compared with the hub's. Default 30 s. */
  intervalMs?: number;
  now?: () => number;
  get?: typeof observerGet;
  put?: typeof observerPut;
  log?: (line: string) => void;
}

export class WatchPush {
  private readonly o: Required<WatchPushOptions>;
  private running?: Promise<void>;
  private again = false;
  private timers: Timer[] = [];
  private sent: { revision: string; bootId: string } | null = null;
  private logged = "";
  private state: WatchHealth;

  constructor(private readonly db: Database, private readonly source: ObserverSource | undefined, options: WatchPushOptions) {
    this.o = {
      residents: options.residents, intervalMs: options.intervalMs ?? 30_000, now: options.now ?? Date.now,
      get: options.get ?? observerGet, put: options.put ?? observerPut, log: options.log ?? (line => console.error(line)),
    };
    this.state = { status: source ? "unchecked" : "unconfigured", detail: null, revision: null, bootId: null, pushedAt: null, checkedAt: 0 };
  }

  start() {
    if (!this.source) return;
    this.timers.push(setTimeout(() => void this.pass(), 0), setInterval(() => void this.pass(), this.o.intervalMs));
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
  health(): WatchHealth { return this.state; }

  /** The hub's facilities or identities changed: compare and push now (after a pass already running, if any). */
  nudge() {
    if (this.running) this.again = true;
    else void this.pass();
  }

  /** One comparison, and a push when the bridge's list is not the hub's; a pass still running is not doubled. */
  pass(): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.running ??= this.passOnce(this.source).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; void this.pass(); }
    });
    return this.running;
  }

  private fail(detail: string) {
    this.state = { ...this.state, status: "error", detail, checkedAt: this.o.now() };
    if (detail !== this.logged) this.o.log(`server bridge watch list: ${detail}`);
    this.logged = detail;
  }

  private async passOnce(source: ObserverSource) {
    const names = this.o.residents();
    if (names === null) return this.fail("the resident identities could not be read; the bridge keeps its current list");
    const list = buildWatchList(this.db, names);
    const seen = await observerWatch(source, this.o.get);
    if (!seen.ok) return this.fail(seen.httpStatus === 404 ? "the bridge has no /v1/watch (older than 0.3.0)" : `${seen.status}: ${seen.detail}`);
    const current = seen.data.watch;
    if (this.sent && current.bootId === this.sent.bootId && current.revision === list.revision) {
      this.state = { ...this.state, status: "ok", detail: list.left.length ? `left out: ${list.left.join("; ")}` : null, checkedAt: this.o.now() };
      return;
    }
    const pushed = await observerPutWatch(source, { revision: list.revision, residents: list.residents, facilities: list.facilities },
      (s, path, body, timeoutMs) => this.o.put(s, path, body, timeoutMs));
    if (!pushed.ok) {
      return this.fail(pushed.status === "forbidden" ? `the bridge refused the push (the hub's token needs the watch scope): ${pushed.detail}` : `push refused: ${pushed.status}: ${pushed.detail}`);
    }
    if (pushed.data.watch.revision !== list.revision) {
      return this.fail("the bridge accepted the watch list but has not applied this revision yet");
    }
    const at = this.o.now();
    this.sent = { revision: list.revision, bootId: pushed.data.watch.bootId };
    this.o.log(`server bridge watch list ${list.revision} pushed to bridge run ${pushed.data.watch.bootId}: ${list.residents.length} residents, ${list.facilities.length} facilities${list.left.length ? `; left out: ${list.left.join("; ")}` : ""}`);
    this.logged = "";
    this.state = { status: "ok", detail: list.left.length ? `left out: ${list.left.join("; ")}` : null, revision: list.revision, bootId: pushed.data.watch.bootId, pushedAt: at, checkedAt: at };
  }
}
