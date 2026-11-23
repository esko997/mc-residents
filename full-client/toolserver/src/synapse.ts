import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { VehicleSnapshot } from "./vehicles.ts";

export interface Position { x: number; y: number; z: number }
export interface Stack { slot: number; item: string; count: number; equip?: string; edible?: boolean; durability?: number; maxDurability?: number }
export interface Entity {
  id: number; type: string; name?: string; hostile?: boolean;
  pos: [number, number, number]; distance: number; health?: number; player?: boolean;
  fuse?: boolean;
  passengers?: number; mountable?: boolean;
}
export interface FluidHit { fluid: string; source: boolean; blockPos: number[]; face: string }
/**
 * The latest held attack as a Synapse that keeps breaking without window focus reports it (`HeldKeys`,
 * `AttackHold`): its hold reply carries the same `id`. `progress` is the most of the block's breaking seen (0..1;
 * vanilla starts from zero again on every hold), `ticksNeeded` the hold that breaks it from zero at the measured
 * rate. `ended`: done (all ticks held), target (the crosshair left the block: it broke, the view turned, or
 * something moved into the line), screen, released, replaced, player (death, respawn, leaving, pause).
 */
export interface AttackHoldState {
  id: number; active: boolean; requestedTicks: number; heldTicks: number;
  target: { type: string; pos?: number[]; entityId?: number };
  progress?: number; ticksNeeded?: number;
  ended?: "done" | "target" | "screen" | "released" | "replaced" | "player";
}
export interface State {
  pos: Position; dimension: string; health: number; food: number;
  maxHealth?: number;
  eye: Position; rotation: { yaw: number; pitch: number };
  hotbar: Stack[]; selectedSlot: number; screen: string;
  lookingAt: {
    type: string; block?: string; blockPos?: number[]; face?: string; entity?: string; entityId?: number;
    /** A Synapse that reports fluids on the view ray sets this; without it, `fluid` absent means unknown. */
    fluidsChecked?: boolean;
    /** The first fluid cell on the view ray within block reach, nearer than any block outline (the crosshair ignores fluids). */
    fluid?: FluidHit;
    /** The first source fluid cell on that ray: what an empty bucket would take. */
    fluidSource?: FluidHit;
  };
  nearbyEntities?: Entity[];
  inventory?: { main: Stack[]; armor: Stack[]; offhand: Stack };
  air?: number; maxAir?: number;
  underwater?: boolean; inWater?: boolean; inLava?: boolean; onFire?: boolean;
  onGround?: boolean; fallDistance?: number; velocity?: Position;
  riding?: boolean; vehicle?: VehicleSnapshot;
  attackHold?: AttackHoldState;
}
export interface Widget {
  index: number; label: string; button?: boolean; editable?: boolean;
  value?: string; active: boolean; visible: boolean;
}
export interface Screen {
  screen: string; title?: string; widgets?: Widget[];
  container?: { slots: Stack[]; carried: string; carriedStack?: Omit<Stack, "slot"> };
  screenWidth?: number; screenHeight?: number;
  modAdapter?: { kind: string; sideConfiguration?: boolean; error?: string };
}
/** Synapse's answer to `GET /blocks`: the nearest blocks of one kind in the chunks the client has loaded. */
export interface BlockSearch {
  block: string; dimension: string;
  /** The block the player stood in; distances are measured from it, between block coordinates. */
  origin: [number, number, number]; radius: number; limit: number;
  /** Nearest first; ties by x, then y, then z. */
  positions: [number, number, number][];
  /** More matches lie within the radius than `positions` holds. */
  truncated: boolean;
  /** Chunk columns the radius touches, and how many of them the client holds; only those were searched. */
  chunksLoaded: number; chunksInRadius: number;
}
export interface Config {
  url: string; tokenFile: string; log: string; residentDir: string;
  name: string; knowledgeDb?: string;
  /** Hub base URL and this resident's private bearer-token file. */
  commonsUrl?: string;
  commonsTokenFile?: string;
  /** Players this body never perceives, as a person cannot see a spectator (see `Synapse.hideUnseen`). */
  unseen?: readonly string[];
  /** The names of every resident body; a chat line from anyone else (a person, the caretaker) always wakes `wait`. */
  residents?: readonly string[];
}
/** The owner's spectator account, watching the world unseen. */
export const defaultUnseen = ["Lantern_"];
export const defaultResidents = ["Gary", "Margo", "Wren", "Tobin"];
/** A comma-separated list of player names; empty means none. */
function names(variable: string, value: string): string[] {
  const list = value.split(",").map(name => name.trim()).filter(Boolean);
  const bad = list.find(name => !/^\w{1,16}$/.test(name));
  if (bad !== undefined) throw new Error(`${variable}: "${bad}" is not a Minecraft player name.`);
  return list;
}
export const expandHome = (path: string) => path === "~" ? homedir() : path.replace(/^~\//, `${homedir()}/`);
export function configuration(env = process.env): Config {
  if (!env.CLIENT_LOG || !env.RESIDENT_NAME) throw new Error("CLIENT_LOG and RESIDENT_NAME are required.");
  if (!/^\w{1,16}$/.test(env.RESIDENT_NAME)) throw new Error("RESIDENT_NAME must be a Minecraft player name.");
  return {
    url: (env.SYNAPSE_URL ?? "http://127.0.0.1:25599").replace(/\/$/, ""),
    tokenFile: expandHome(env.SYNAPSE_TOKEN_FILE ?? "~/.synapse/token"),
    log: expandHome(env.CLIENT_LOG), residentDir: expandHome(env.RESIDENT_DIR ?? process.cwd()),
    name: env.RESIDENT_NAME, knowledgeDb: env.KNOWLEDGE_DB ? expandHome(env.KNOWLEDGE_DB) : undefined,
    commonsUrl: env.COMMONS_URL,
    commonsTokenFile: env.COMMONS_TOKEN_FILE ? expandHome(env.COMMONS_TOKEN_FILE) : undefined,
    unseen: names("RESIDENT_UNSEEN_PLAYERS", env.RESIDENT_UNSEEN_PLAYERS ?? defaultUnseen.join(",")),
    residents: names("RESIDENT_NAMES", env.RESIDENT_NAMES ?? defaultResidents.join(",")),
  };
}
export class Synapse {
  private readonly unseen: ReadonlySet<string>;
  /** Entity ids of unseen players in the latest full state: the crosshair can rest on one between full reads. */
  private unseenIds = new Set<number>();
  constructor(private url: string, private token: string, unseen: readonly string[] = []) {
    this.unseen = new Set(unseen.map(name => name.toLowerCase()));
  }
  static async connect(config: Config) {
    let token: string;
    try { token = (await readFile(config.tokenFile, "utf8")).trim(); }
    catch { throw new Error(`Cannot read Synapse token file: ${config.tokenFile}`); }
    if (!token) throw new Error("Synapse token file is empty.");
    return new Synapse(config.url, token, config.unseen);
  }
  async request<T>(path: string, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: body ? "POST" : "GET", headers: { "X-Synapse-Token": this.token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6500),
      });
    } catch { throw new Error("Synapse unreachable (client stopped or request timed out)."); }
    let envelope: { ok: boolean; data: T; error?: { message?: string; code?: string } | string };
    try { envelope = await response.json() as typeof envelope; }
    catch { throw new Error(`Synapse returned invalid data (HTTP ${response.status}).`); }
    if (!response.ok || !envelope.ok) {
      const error = envelope.error;
      throw new Error(`Synapse: ${typeof error === "string" ? error : error?.message ?? error?.code ?? `HTTP ${response.status}`}`);
    }
    return envelope.data;
  }
  player(body: object) { return this.request<Record<string, unknown>>("/player", body); }
  gui(body?: object) { return this.request<Screen>("/gui", body); }
  chat(text: string) { return this.request("/chat", { text }); }
  /** Every state the body reads passes through here, so an unseen player is in no list, target or sight. */
  async state(full = false) { return this.hideUnseen(await this.request<State>(`/state?mode=${full ? "full" : "summary"}`)); }
  /** Unseen players are taken out of `nearbyEntities`; one in the crosshair reads as nothing in the sights (`miss`). */
  private hideUnseen(state: State): State {
    if (!this.unseen.size) return state;
    if (state.nearbyEntities) {
      const unseen = (entity: Entity) => playerEntity(entity) && this.unseen.has((entity.name ?? "").toLowerCase());
      this.unseenIds = new Set(state.nearbyEntities.filter(unseen).map(entity => entity.id));
      state.nearbyEntities = state.nearbyEntities.filter(entity => !unseen(entity));
    }
    const at = state.lookingAt;
    if (at?.type === "entity" && at.entityId !== undefined && this.unseenIds.has(at.entityId)) {
      const { entity: _entity, entityId: _id, ...rest } = at;
      state.lookingAt = { ...rest, type: "miss" };
      unseenSights.add(state.lookingAt);
    }
    return state;
  }
  /** Reads loaded chunks only: nothing moves, loads or breaks. radius 1..96, limit 1..32; an id that names no block is an error. */
  blocks(block: string, radius: number, limit: number) {
    return this.request<BlockSearch>(`/blocks?block=${encodeURIComponent(block)}&radius=${radius}&limit=${limit}`);
  }
  async picture(): Promise<string> {
    const data = await this.request<{ image: string }>("/screenshot?format=base64");
    return data.image;
  }
}
/** Sights that read `miss` only because an unseen player is in the crosshair: a click there would still hit or use
 * that player, so the tools that click (attack) do not. A set, not a field, so skill code never sees the mark. */
export const unseenSights = new WeakSet<object>();
export function angles(eye: Position, target: Position) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  return { yaw: -Math.atan2(dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI };
}
export const nonempty = (stack: Stack) => stack.count > 0 && stack.item !== "minecraft:air";
export const playerEntity = (entity: Entity) => entity.player === true || entity.type === "minecraft:player";
// The explicit flag also covers modded enemies without guessing from their registry names.
const hostileIds: Record<string, true> = Object.fromEntries("zombie husk drowned skeleton stray wither_skeleton creeper spider cave_spider endermite silverfish witch slime magma_cube phantom pillager vindicator evoker ravager vex guardian elder_guardian blaze ghast hoglin zoglin piglin_brute wither ender_dragon warden".split(" ").map(id => [`minecraft:${id}`, true]));
export const hostileEntity = (entity: Entity) => !playerEntity(entity) && entity.health !== 0 && (entity.hostile === true || hostileIds[entity.type] === true);
