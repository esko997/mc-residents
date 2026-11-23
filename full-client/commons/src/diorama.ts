// The chunk diorama's block data (docs/map-3d.md): each host reads its own residents' clients
// through Synapse `GET /chunks` (client-loaded chunks only), only when a dashboard asks, at most
// every MIN_REFRESH_MS per resident, and keeps the latest window per resident keyed by section
// revision. Dashboard only: never sent to the overlay, the Resident API or the Live status.
import { inflateSync } from "node:zlib";
import type { ResidentConfig } from "./config.ts";
import { finite, record } from "./json.ts";
import { dimensionKey } from "./positions.ts";
import { synapseGet, type Reach } from "./synapse.ts";

/** One section: whole, or `same` when the asker said it holds this revision. x and z are chunk columns, y the section row. */
export type DioramaSection =
  | { x: number; y: number; z: number; rev: string; palette: string[]; bits: number; data?: string }
  | { x: number; y: number; z: number; rev: string; same: true };
export interface DioramaPlayer { name: string; x: number; y: number; z: number; self?: true }
export interface DioramaView {
  /** Dimension key (`overworld`, `the_nether`, `the_end`, or a mod's full id). */
  dimension: string;
  origin: [number, number, number];
  radius: number;
  /** The section-aligned window returned, inclusive; minY > maxY when it is empty. */
  minY: number; maxY: number; levelMinY: number; levelMaxY: number;
  hasSkyLight: boolean; hasCeiling: boolean;
  /** Sky light 0-15 at the feet when read. */
  skyLight: number;
  /** Columns read, and columns the client did not hold (not read). */
  chunks: { x: number; z: number }[];
  missing: [number, number][];
  players: DioramaPlayer[];
  sections: DioramaSection[];
}
export interface DioramaReply {
  resident: string;
  /** Hub replies name the host whose client was read. */
  host?: string;
  /**
   * ok: `view` was read from the running client at `asOf`. offline/unauthorized/error: the client
   * could not be read now; `view` is the last one read (or null). unavailable: this host cannot
   * serve a diorama for the resident (a station on an older Commons, or unreachable).
   */
  status: "ok" | "offline" | "unauthorized" | "error" | "unavailable";
  detail?: string;
  /** When the blocks in `view` were read from the client; null when never. */
  asOf: number | null;
  /** When this host last asked the client (or tried to). */
  checkedAt: number | null;
  view: DioramaView | null;
  /** What the last read cost on the client, as Synapse measured it. */
  timing?: { clientThreadMicros: number; encodeMicros: number; totalMicros: number };
}

/** A watched resident's client is asked at most this often; every viewer shares the answer. */
export const MIN_REFRESH_MS = 10_000;
/** The largest window Synapse serves: 5 x 5 columns, five sections each. */
export const MAX_SECTIONS = 125;
const MAX_PALETTE = 4096, MAX_PALETTE_TOTAL = 16_384, MAX_DATA = 8400, MAX_PLAYERS = 64;
const REVISION = /^[0-9a-f]{16}$/;
const BLOCK_ID = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}$/;
const PLAYER = /^\w{1,16}$/;
/**
 * Read 3 x 3 columns and ±32 blocks around the feet (Synapse's own cap, widened to whole
 * sections: always five, 45 sections, so the page's Levels control can show up to ±32). Bounds:
 * at most 45 sections of at most MAX_DATA characters each per read, one read per resident per
 * MIN_REFRESH_MS, and on the game's client thread one array copy per section in slices of about
 * 1 ms with a client tick between them.
 */
const RADIUS = 2, READ_RADIUS = 1, HALF_HEIGHT = 32;

const int = (value: unknown, low: number, high: number) => Number.isInteger(value) && (value as number) >= low && (value as number) <= high ? value as number : undefined;

/** Packed bytes for 4096 indices of `bits` bits. */
export const packedLength = (bits: number) => Math.ceil(4096 * bits / 8);

/** Whether base64 `data` is a zlib stream holding exactly the packed indices for `bits`. */
export function validData(data: string, bits: number): boolean {
  if (data.length > MAX_DATA || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  try {
    const raw = inflateSync(Buffer.from(data, "base64"), { maxOutputLength: packedLength(bits) });
    return raw.length === packedLength(bits);
  } catch { return false; }
}

/** One section as Synapse or a station sends it, or undefined when anything about it is off. */
function section(value: unknown, x: number, z: number, sameAllowed: boolean): DioramaSection | undefined {
  const raw = record(value);
  const y = int(raw.y, -64, 63);
  if (y === undefined || typeof raw.rev !== "string" || !REVISION.test(raw.rev)) return undefined;
  if (raw.same === true) return sameAllowed ? { x, y, z, rev: raw.rev, same: true } : undefined;
  const bits = int(raw.bits, 0, 12);
  if (bits === undefined || !Array.isArray(raw.palette) || raw.palette.length < 1 || raw.palette.length > MAX_PALETTE
    || !raw.palette.every(id => typeof id === "string" && BLOCK_ID.test(id))) return undefined;
  // bits is exactly what the palette needs, so every index fits and the decoder needs no guessing.
  if (bits !== (raw.palette.length === 1 ? 0 : Math.ceil(Math.log2(raw.palette.length)))) return undefined;
  if (bits === 0) return raw.data === undefined ? { x, y, z, rev: raw.rev, palette: raw.palette as string[], bits } : undefined;
  if (typeof raw.data !== "string" || !validData(raw.data, bits)) return undefined;
  return { x, y, z, rev: raw.rev, palette: raw.palette as string[], bits, data: raw.data };
}

function players(value: unknown): DioramaPlayer[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLAYERS) return undefined;
  const out: DioramaPlayer[] = [];
  for (const entry of value) {
    const raw = record(entry), x = finite(raw.x), y = finite(raw.y), z = finite(raw.z);
    if (typeof raw.name !== "string" || !PLAYER.test(raw.name) || x === undefined || y === undefined || z === undefined) return undefined;
    out.push({ name: raw.name, x, y, z, ...(raw.self === true ? { self: true as const } : {}) });
  }
  return out;
}

function counted(sections: DioramaSection[]): boolean {
  let palette = 0;
  for (const entry of sections) if ("palette" in entry) palette += entry.palette.length;
  return sections.length <= MAX_SECTIONS && palette <= MAX_PALETTE_TOTAL;
}

/** The `data` of Synapse `GET /chunks`, flattened to sections with their columns; undefined when the shape is off. */
export function fromSynapse(data: unknown): DioramaView | undefined {
  const raw = record(data), origin = raw.origin;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(v => Number.isInteger(v))) return undefined;
  const radius = int(raw.radius, 0, RADIUS), minY = int(raw.minY, -4096, 4096), maxY = int(raw.maxY, -4097, 4096);
  const levelMinY = int(raw.levelMinY, -4096, 4096), levelMaxY = int(raw.levelMaxY, -4096, 4096), sky = int(raw.skyLight, 0, 15);
  const who = players(raw.players);
  if (typeof raw.dimension !== "string" || radius === undefined || minY === undefined || maxY === undefined || levelMinY === undefined
    || levelMaxY === undefined || sky === undefined || !who || typeof raw.hasSkyLight !== "boolean" || typeof raw.hasCeiling !== "boolean"
    || !Array.isArray(raw.chunks) || !Array.isArray(raw.missing) || raw.chunks.length + raw.missing.length > (2 * RADIUS + 1) ** 2) return undefined;
  const chunks: DioramaView["chunks"] = [], sections: DioramaSection[] = [];
  for (const value of raw.chunks) {
    const chunk = record(value), x = int(chunk.x, -2_000_000, 2_000_000), z = int(chunk.z, -2_000_000, 2_000_000);
    if (x === undefined || z === undefined || !Array.isArray(chunk.sections) || chunk.sections.length > 5) return undefined;
    chunks.push({ x, z });
    for (const entry of chunk.sections) {
      const parsed = section(entry, x, z, true);
      if (!parsed) return undefined;
      sections.push(parsed);
    }
  }
  const missing: [number, number][] = [];
  for (const value of raw.missing) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(v => Number.isInteger(v))) return undefined;
    missing.push([value[0], value[1]]);
  }
  if (!counted(sections)) return undefined;
  return {
    dimension: dimensionKey(raw.dimension), origin: origin as [number, number, number], radius, minY, maxY, levelMinY, levelMaxY,
    hasSkyLight: raw.hasSkyLight, hasCeiling: raw.hasCeiling, skyLight: sky, chunks, missing, players: who, sections,
  };
}

/**
 * A whole DioramaReply as another host sends it (hub reading a station), or undefined. `same`
 * sections are allowed: the hub forwards the browser's `have` list.
 */
export function validReply(value: unknown): DioramaReply | undefined {
  const raw = record(value);
  if (typeof raw.resident !== "string" || !PLAYER.test(raw.resident)
    || !["ok", "offline", "unauthorized", "error", "unavailable"].includes(raw.status as string)) return undefined;
  const asOf = raw.asOf === null ? null : finite(raw.asOf), checkedAt = raw.checkedAt === null ? null : finite(raw.checkedAt);
  if (asOf === undefined || checkedAt === undefined || (raw.detail !== undefined && typeof raw.detail !== "string")) return undefined;
  let view: DioramaView | null = null;
  if (raw.view !== null) {
    const v = record(raw.view);
    // The same checks as a Synapse reply, on the flattened form.
    const byColumn = new Map<string, unknown[]>();
    if (!Array.isArray(v.sections) || v.sections.length > MAX_SECTIONS || !Array.isArray(v.chunks)) return undefined;
    for (const entry of v.sections) {
      const s = record(entry), key = `${s.x},${s.z}`;
      if (!byColumn.has(key)) byColumn.set(key, []);
      byColumn.get(key)!.push(entry);
    }
    const parsed = fromSynapse({ ...v, chunks: v.chunks.map(chunk => ({ ...record(chunk), sections: byColumn.get(`${record(chunk).x},${record(chunk).z}`) ?? [] })) });
    if (!parsed || parsed.sections.length !== v.sections.length || typeof v.dimension !== "string") return undefined;
    view = { ...parsed, dimension: dimensionKey(v.dimension) };
  }
  const timing = record(raw.timing);
  return {
    resident: raw.resident, status: raw.status as DioramaReply["status"], asOf, checkedAt, view,
    ...(typeof raw.detail === "string" ? { detail: raw.detail.slice(0, 300) } : {}),
    ...([timing.clientThreadMicros, timing.encodeMicros, timing.totalMicros].every(n => finite(n) !== undefined)
      ? { timing: { clientThreadMicros: timing.clientThreadMicros as number, encodeMicros: timing.encodeMicros as number, totalMicros: timing.totalMicros as number } } : {}),
  };
}

/** `have=rev,rev,...` from a browser: the valid revisions, at most MAX_SECTIONS * 2 of them. */
export function parseHave(raw: string | null): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").slice(0, 17 * MAX_SECTIONS * 2).split(",")) if (REVISION.test(part)) out.add(part);
  return out;
}

interface Held {
  view: DioramaView | null; asOf: number | null; checkedAt: number | null;
  status: DioramaReply["status"]; detail?: string; timing?: DioramaReply["timing"];
  pending?: Promise<void>;
}

/**
 * Per resident: the latest window read from its client. Nothing runs unless `read` is called
 * (a dashboard is looking), and the client is asked at most every MIN_REFRESH_MS.
 */
export class DioramaCache {
  private held = new Map<string, Held>();

  constructor(private now: () => number = Date.now,
    private get: (resident: ResidentConfig, path: string) => Promise<Reach> = (resident, path) => synapseGet(resident, path, 6000)) {}

  async read(resident: ResidentConfig, have: Set<string>): Promise<DioramaReply> {
    let held = this.held.get(resident.name);
    if (!held) { held = { view: null, asOf: null, checkedAt: null, status: "offline" }; this.held.set(resident.name, held); }
    if (held.checkedAt === null || this.now() - held.checkedAt >= MIN_REFRESH_MS) {
      held.pending ??= this.refresh(resident, held).finally(() => { held.pending = undefined; });
    }
    if (held.pending) await held.pending;
    return {
      resident: resident.name, status: held.status, asOf: held.asOf, checkedAt: held.checkedAt,
      ...(held.detail ? { detail: held.detail } : {}), ...(held.timing ? { timing: held.timing } : {}),
      view: held.view && { ...held.view, sections: held.view.sections.map(entry => have.has(entry.rev) ? { x: entry.x, y: entry.y, z: entry.z, rev: entry.rev, same: true as const } : entry) },
    };
  }

  private async refresh(resident: ResidentConfig, held: Held) {
    const at = this.now();
    // The client sends `same` for what this host already holds; the rest comes whole.
    const mine = new Map((held.view?.sections ?? []).map(entry => [entry.rev, entry]));
    const query = new URLSearchParams({ radius: String(READ_RADIUS), below: String(HALF_HEIGHT), above: String(HALF_HEIGHT) });
    if (mine.size) query.set("have", [...mine.keys()].join(","));
    const reach = await this.get(resident, `/chunks?${query}`);
    held.checkedAt = at;
    if (!reach.ok) {
      // "error" includes BUSY and NOT_IN_WORLD; the last good view stays, with its own time.
      held.status = reach.status; held.detail = reach.detail;
      return;
    }
    const view = fromSynapse(reach.data);
    const sections = view?.sections.map(entry => "same" in entry ? mine.get(entry.rev) : entry);
    if (!view || !sections || sections.some(entry => !entry)) {
      held.status = "error";
      held.detail = view ? "The client answered `same` for a section this host does not hold." : "The client's /chunks answer had an unexpected shape (an older Synapse without /chunks?).";
      return;
    }
    const timing = record(record(reach.data).timing);
    held.view = { ...view, sections: sections as DioramaSection[] };
    held.asOf = at; held.status = "ok"; held.detail = undefined;
    held.timing = [timing.clientThreadMicros, timing.encodeMicros, timing.totalMicros].every(n => finite(n) !== undefined)
      ? { clientThreadMicros: timing.clientThreadMicros as number, encodeMicros: timing.encodeMicros as number, totalMicros: timing.totalMicros as number } : undefined;
  }
}
