// Reads a resident's running Minecraft client through the Synapse HTTP API on
// loopback. A client that is not running refuses the connection: that is the
// normal "offline" case, never an error for the caller.
import { readFile } from "node:fs/promises";
import type { ResidentConfig } from "./config.ts";
import { finite, record } from "./json.ts";

export type Reach =
  | { ok: true; data: unknown }
  /** offline: no client. unauthorized: a client answered but refused the token. error: it answered nonsense. */
  | { ok: false; status: "offline" | "unauthorized" | "error"; detail: string };

async function token(resident: ResidentConfig): Promise<string | undefined> {
  for (const file of resident.tokenFiles) {
    try {
      const value = (await readFile(file, "utf8")).trim();
      if (value) return value;
    } catch { /* try the next place */ }
  }
  return undefined;
}

export async function synapseGet(resident: ResidentConfig, path: string, timeoutMs = 4000): Promise<Reach> {
  const secret = await token(resident);
  let response: Response;
  try {
    response = await fetch(`${resident.synapseUrl}${path}`, {
      headers: secret ? { "X-Synapse-Token": secret } : {}, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return { ok: false, status: "offline", detail: "The client is not running (connection refused or no answer)." }; }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return {
      ok: false, status: "unauthorized",
      detail: secret ? "The client refused the Synapse token." : `No Synapse token file found (looked in ${resident.tokenFiles.join(", ")}).`,
    };
  }
  let envelope: Record<string, unknown>;
  try { envelope = record(await response.json()); }
  catch { return { ok: false, status: "error", detail: `The client answered HTTP ${response.status} without JSON.` }; }
  if (!response.ok || envelope.ok !== true) {
    const error = envelope.error;
    const message = typeof error === "string" ? error : record(error).message ?? record(error).code ?? `HTTP ${response.status}`;
    return { ok: false, status: "error", detail: `Synapse: ${String(message)}` };
  }
  return { ok: true, data: envelope.data };
}

export interface Stack { item: string; count: number; slot?: number; durability?: number; maxDurability?: number }
export interface ResidentState {
  pos: { x: number; y: number; z: number };
  dimension: string;
  health: number; maxHealth: number;
  food: number;
  air?: { now: number; max: number };
  /** Plain words for what is wrong right now: "on fire", "in lava", "underwater". */
  dangers: string[];
  gameMode?: string;
  held: Stack | null;
  selectedSlot: number;
  /** null when no screen is open. */
  screen: string | null;
  lookingAt: string | null;
  hotbar: Stack[];
  /** Everything carried, same items added together, most first. null when the client sent no inventory. */
  inventory: { items: { item: string; count: number }[]; usedSlots: number; totalSlots: number } | null;
  armor: string[];
  offhand: Stack | null;
  nearby: { players: string[]; hostiles: number; others: number };
  world?: { weather?: string; biome?: string; timeOfDay?: "day" | "night" };
  level?: number;
}

/** `minecraft:dirt` reads as `dirt`; other mods keep their namespace because the same name can exist twice. */
export const shortId = (id: string) => id.replace(/^minecraft:/, "");
const round1 = (value: number) => Math.round(value * 10) / 10;

function stack(value: unknown): Stack | null {
  const raw = record(value);
  const count = finite(raw.count) ?? 0;
  if (typeof raw.item !== "string" || raw.item === "minecraft:air" || count <= 0) return null;
  return {
    item: shortId(raw.item), count, slot: finite(raw.slot),
    ...(finite(raw.maxDurability) ? { durability: finite(raw.durability), maxDurability: finite(raw.maxDurability) } : {}),
  };
}
const stacks = (value: unknown) => (Array.isArray(value) ? value : []).map(stack).filter(entry => entry !== null);

/** The `data` of `GET /state` (summary or full), reduced to what the page shows. Missing fields are tolerated. */
export function normalizeState(data: unknown): ResidentState | null {
  const raw = record(data), pos = record(raw.pos);
  const x = finite(pos.x), y = finite(pos.y), z = finite(pos.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const hotbar = stacks(raw.hotbar);
  const selectedSlot = finite(raw.selectedSlot) ?? 0;
  const looking = record(raw.lookingAt);
  const lookingAt = typeof looking.block === "string"
    ? `${shortId(looking.block)}${Array.isArray(looking.blockPos) ? ` at ${looking.blockPos.join(",")}` : ""}`
    : typeof looking.entity === "string" ? shortId(looking.entity) : null;

  const inventoryRaw = record(raw.inventory);
  let inventory: ResidentState["inventory"] = null;
  if (Array.isArray(inventoryRaw.main)) {
    const totals = new Map<string, number>();
    const carried = stacks(inventoryRaw.main);
    for (const entry of carried) totals.set(entry.item, (totals.get(entry.item) ?? 0) + entry.count);
    inventory = {
      items: [...totals].map(([item, count]) => ({ item, count })).sort((a, b) => b.count - a.count || a.item.localeCompare(b.item)),
      usedSlots: carried.length, totalSlots: inventoryRaw.main.length,
    };
  }

  const players: string[] = [];
  let hostiles = 0, others = 0;
  for (const value of Array.isArray(raw.nearbyEntities) ? raw.nearbyEntities : []) {
    const entity = record(value);
    if (entity.player === true || entity.type === "minecraft:player") players.push(typeof entity.name === "string" ? entity.name : "a player");
    else if (entity.hostile === true) hostiles++;
    else others++;
  }

  const air = finite(raw.air), maxAir = finite(raw.maxAir);
  const dangers = [raw.onFire === true && "on fire", raw.inLava === true && "in lava", raw.underwater === true && "underwater"]
    .filter(danger => typeof danger === "string");
  const world = record(raw.world), dayTime = finite(world.dayTime);
  return {
    pos: { x: round1(x), y: round1(y), z: round1(z) },
    dimension: typeof raw.dimension === "string" ? shortId(raw.dimension) : "unknown",
    health: round1(finite(raw.health) ?? 0), maxHealth: finite(record(raw.attributes).maxHealth) ?? 20,
    food: finite(raw.food) ?? 0,
    ...(air !== undefined && maxAir !== undefined ? { air: { now: air, max: maxAir } } : {}),
    dangers, gameMode: typeof raw.gameMode === "string" ? raw.gameMode : undefined,
    held: hotbar.find(entry => entry.slot === selectedSlot) ?? null, selectedSlot,
    screen: typeof raw.screen === "string" && raw.screen !== "none" ? raw.screen : null,
    lookingAt, hotbar, inventory,
    armor: stacks(inventoryRaw.armor).map(entry => entry.item),
    offhand: stack(inventoryRaw.offhand),
    nearby: { players, hostiles, others },
    ...("world" in raw ? {
      world: {
        weather: typeof world.weather === "string" ? world.weather : undefined,
        biome: typeof world.biome === "string" ? shortId(world.biome) : undefined,
        // Minecraft's day is 24000 ticks; mobs spawn from 13000 to 23000.
        timeOfDay: dayTime === undefined ? undefined : dayTime % 24000 >= 13000 && dayTime % 24000 < 23000 ? "night" : "day",
      },
    } : {}),
    level: finite(record(raw.experience).level),
  };
}
