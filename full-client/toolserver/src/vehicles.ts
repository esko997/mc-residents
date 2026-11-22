import { z } from "zod";
import type { Entity, Position } from "./synapse.ts";

/**
 * Boats, minecarts and Immersive Aircraft through Synapse's /player vehicle actions. Synapse boards by
 * ordinary entity interaction, steers vanilla vehicles with player input and aircraft with their
 * configured key mappings, and reads the rider's actual vehicle back; these tools say what happened,
 * never what was merely sent. Nothing here retries a world action on its own.
 */

/** `state.vehicle` from Synapse: the vehicle the player rides now. */
export interface VehicleSnapshot {
  type: string; id: number; uuid?: string;
  family: "minecart" | "boat" | "airplane" | "airship" | "quadrocopter" | "gyrodyne" | "other";
  /** The first rider steers; others are passengers. */
  controlling: boolean; seat: number; passengers: number;
  onGround: boolean; inWater: boolean; pos: Position; velocity: Position;
  /** Blocks per second. */
  speed: number; yaw: number;
  /** Blocks down to the first solid surface or fluid; null when none within 64 blocks of loaded world. */
  dropBelow: number | null;
  dismount: "sneak" | "aircraft_key" | "unsupported";
  aircraftVersion?: string | null; supported: boolean; unsupportedReason?: string; rootVehicleId?: number;
}
/** Nearby entities as Synapse's full state reports them, with the vehicle fields. */
export interface VehicleEntity extends Entity { passengers?: number; mountable?: boolean }
export interface VehicleState {
  pos: Position; screen: string;
  riding?: boolean; vehicle?: VehicleSnapshot; nearbyEntities?: VehicleEntity[];
}
/** The parts of the Synapse client these tools use; `Synapse` itself fits. */
export interface VehicleApi {
  player(body: object): Promise<Record<string, unknown>>;
  state(full?: boolean): Promise<VehicleState>;
}

const control = z.enum(["left", "right", "forward", "backward", "up", "down", "pull", "push"]);
export const vehicleDefinitions = {
  vehicle: {
    description: "What you ride (vehicle, seat, on ground/water/airborne, drop below, speed, how to leave) and the boats, minecarts and aircraft near you with their ids, without acting.",
    schema: z.object({}).strict(),
  },
  mount: {
    description: "Board a boat, minecart or Immersive Aircraft by its entity id (from vehicle or status): turns to it and uses it once, then reports whether you actually ride it. It must be within about 3 blocks with nothing in the way, and you must not be sneaking. A damaged aircraft is repaired by use instead of boarded. Not retried on its own.",
    schema: z.object({ entity_id: z.number().int().nonnegative() }).strict(),
  },
  dismount: {
    description: "Leave the vehicle you ride and report whether you did. Boats and minecarts: sneaks until the server lets you go. Aircraft: presses the aircraft's own dismount key, never sneak (in an aircraft sneak is the down control). Off the ground it refuses and presses nothing unless confirm_airborne is true: you would fall, and an aircraft flies on without a pilot.",
    schema: z.object({ confirm_airborne: z.boolean().optional() }).strict(),
  },
  vehicle_control: {
    description: "Steer the vehicle you drive: hold 1..4 controls for hold_ticks (1..200, 20 per second), then report where it went. Boats: forward, backward, left, right. Minecarts: forward/backward nudge a stopped cart. Airplanes (biplane, bamboo hopper): up/down throttle (down also brakes), push/pull nose down/up, left/right turn. Airships, quadrocopter, gyrodyne: up/down climb/descend, forward/backward, left/right. Opposite controls cannot be held together.",
    schema: z.object({ controls: z.array(control).min(1).max(4), hold_ticks: z.number().int().min(1).max(200) }).strict(),
  },
  vehicle_boost: {
    description: "Press an aircraft's rocket boost key once and report its speed before and after. It only boosts with firework rockets in the aircraft's booster slot and no boost already running; the rockets are used up.",
    schema: z.object({}).strict(),
  },
  vehicle_inventory: {
    description: "While seated, open the vehicle's own inventory (aircraft fuel and upgrade slots, a chest boat's chest), the way the inventory key does; then use screen and click_slot. Plain boats and minecarts have none.",
    schema: z.object({}).strict(),
  },
};
export type VehicleToolName = keyof typeof vehicleDefinitions;
type Args<K extends VehicleToolName> = z.infer<(typeof vehicleDefinitions)[K]["schema"]>;

/** Wait or reject on abort; injectable so tests need no real time. */
export type Pause = (ms: number, signal?: AbortSignal) => Promise<void>;
const pause: Pause = (ms, signal) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new Error("aborted"));
    return promise;
  }
  const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
};

const round = (value: number) => Math.round(value * 10) / 10;
const at = (p: Position) => `${round(p.x)},${round(p.y)},${round(p.z)}`;
const label = (v: { type: string; id: number }) => `${v.type} #${v.id}`;

function footing(v: VehicleSnapshot) {
  if (v.onGround) return "on the ground";
  if (v.inWater) return "on water";
  return v.dropBelow === null ? "airborne, ground not in sight (over 64 blocks down or unloaded)" : `airborne, ${round(v.dropBelow)} blocks above the surface`;
}
function leaving(v: VehicleSnapshot) {
  if (v.dismount === "sneak") return "dismount leaves it (sneaks)";
  if (v.dismount === "aircraft_key") return "dismount leaves it with its dismount key once landed; in the air only with confirm_airborne";
  return `no supported way to leave it${v.unsupportedReason ? `: ${v.unsupportedReason}` : ""}`;
}
/** One line about the vehicle, for vehicle and status. */
export function describeVehicle(v: VehicleSnapshot) {
  const seat = v.controlling ? "you steer it" : `you are a passenger (seat ${v.seat + 1} of ${v.passengers})`;
  return `Riding ${label(v)} (${v.family}) at ${at(v.pos)}; ${seat}; ${footing(v)}; ${round(v.speed)} blocks/s; ${leaving(v)}.`;
}
/** For the status tool: what the body rides, or nothing when it is on foot. */
export function vehicleStatusLine(state: VehicleState): string | undefined {
  return state.vehicle ? describeVehicle(state.vehicle) : undefined;
}
const steering: Record<VehicleSnapshot["family"], string> = {
  boat: "Steer with vehicle_control forward/backward/left/right.",
  minecart: "Rails carry it; vehicle_control forward/backward only nudge a stopped cart.",
  airplane: "vehicle_control: up raises throttle, down lowers it and brakes, push/pull tilt the nose, left/right turn. See guide vehicles for takeoff and landing.",
  airship: "vehicle_control: up/down climb and descend, forward/backward drive, left/right turn. It burns fuel while you pilot it.",
  quadrocopter: "vehicle_control: up/down climb and descend, forward/backward/left/right move; it turns toward where you look. It burns fuel while you pilot it.",
  gyrodyne: "Hold vehicle_control forward to spin the rotor up to full power (it uses your food), then up/down climb and descend.",
  other: "",
};

// Synapse's /player replies, shaped by Vehicles.java in synapse-forge; Synapse is the versioned peer of this file.
interface MountResult {
  sent: boolean; mounted?: boolean; reason?: string; inSights?: string; interaction?: string;
  target: { type: string; id: number; distance: number; passengers: number };
  riding?: boolean; vehicle?: VehicleSnapshot; waitedTicks?: number; screen?: string;
}
interface DismountResult {
  method: string; pressed: number; dismounted: boolean; refused?: string;
  /** Why the confirmed airborne exit's second press was not sent. */
  secondPressSkipped?: "left_after_first_press" | "screen_opened" | "binding_changed";
  before: VehicleSnapshot; riding?: boolean; vehicle?: VehicleSnapshot; pos?: Position; onGround?: boolean; waitedTicks?: number;
}
interface ControlResult { holding: string[]; ticks: number; mode: string; vehicle: VehicleSnapshot }
interface BoostResult { speedBefore: number; riding?: boolean; vehicle?: VehicleSnapshot }
interface InventoryResult { vehicleType: string; opened: boolean; screen: string; menu?: string; slots?: number; waitedTicks: number }

export class Vehicles {
  constructor(private api: VehicleApi, private wait: Pause = pause) {}

  /** Runs one vehicle tool; input is validated again here, so raw tool arguments are safe to pass. */
  async run(tool: VehicleToolName, input: unknown, signal?: AbortSignal): Promise<string> {
    switch (tool) {
      case "vehicle": return this.vehicle();
      case "mount": return this.mount(vehicleDefinitions.mount.schema.parse(input));
      case "dismount": return this.dismount(vehicleDefinitions.dismount.schema.parse(input));
      case "vehicle_control": return this.control(vehicleDefinitions.vehicle_control.schema.parse(input), signal);
      case "vehicle_boost": return this.boost();
      case "vehicle_inventory": return this.inventory();
    }
    throw new Error(`Unknown vehicle tool: ${tool}`);
  }

  private async vehicle() {
    const state = await this.api.state(true);
    const riding = state.vehicle;
    const nearby = (state.nearbyEntities ?? []).filter(e => e.mountable === true && e.id !== riding?.id).slice(0, 8);
    const lines = [riding ? describeVehicle(riding) : "Not riding anything."];
    lines.push(nearby.length
      ? `Vehicles near you: ${nearby.map(e => `${e.type} #${e.id} at ${e.pos.map(round).join(",")} (${e.distance}m, ${e.passengers ? `${e.passengers} aboard` : "empty"})`).join("; ")}.`
      : "No boats, minecarts or aircraft sensed near you.");
    return lines.join("\n");
  }

  private async mount(args: Args<"mount">) {
    const r = await this.api.player({ action: "mount", entityId: args.entity_id, waitTicks: 40 }) as unknown as MountResult;
    const target = `${r.target.type} #${r.target.id}`;
    if (!r.sent) {
      return `Did not use ${target} (${r.target.distance} blocks away): it is out of reach (about 3 blocks) or something is in the way; in your sights: ${r.inSights ?? "nothing"}. Go next to it and try again.`;
    }
    if (r.mounted && r.vehicle) {
      return `Boarded ${target}. ${describeVehicle(r.vehicle)} ${steering[r.vehicle.family]}`.trim();
    }
    const hints = [
      r.riding && r.vehicle ? `you ride ${label(r.vehicle)} instead` : "",
      r.target.passengers > 0 ? `${r.target.passengers} already aboard, it may be full` : "",
      r.target.type.startsWith("immersive_aircraft:") ? "a damaged aircraft is repaired by use instead of boarded (use it until whole, then board)" : "",
      r.screen && r.screen !== "none" ? `${r.screen} is open` : "",
    ].filter(Boolean);
    return `Used ${target} (${r.interaction ?? "no result"}), but you are not riding it after ${r.waitedTicks ?? 0} ticks${hints.length ? `: ${hints.join("; ")}` : ""}. Not repeated; look at vehicle before trying again.`;
  }

  private async dismount(args: Args<"dismount">) {
    const r = await this.api.player({ action: "dismount", confirmAirborne: args.confirm_airborne === true, waitTicks: 40 }) as unknown as DismountResult;
    const before = r.before;
    if (r.refused === "airborne_unconfirmed") {
      const drop = before.dropBelow === null ? "an unknown distance (over 64 blocks or unloaded)" : `about ${round(before.dropBelow)} blocks`;
      const aircraft = before.dismount === "aircraft_key" ? ", and the aircraft would fly on without a pilot" : "";
      return `Did not leave ${label(before)}: it is not on the ground, so you would fall ${drop}${aircraft}. Nothing was pressed. Land first, or call dismount with confirm_airborne: true if you mean to jump.`;
    }
    const how = r.method === "aircraft_key" ? `its dismount key (pressed ${r.pressed}x)` : "sneaking";
    if (r.dismounted) {
      const where = r.pos ? ` You are at ${at(r.pos)}${r.onGround === false ? ", not yet on the ground" : ""}.` : "";
      return `Left ${label(before)} by ${how}.${where}`;
    }
    const skipped = r.secondPressSkipped === "screen_opened" ? " The second press was not sent because a screen opened."
      : r.secondPressSkipped === "binding_changed" ? " The second press was not sent because the dismount key changed or is now shared."
      : "";
    return `Tried to leave ${label(before)} by ${how}, but you still ride it after ${r.waitedTicks ?? 0} ticks.${skipped} Not repeated; check vehicle before trying again.`;
  }

  private async control(args: Args<"vehicle_control">, signal?: AbortSignal) {
    const r = await this.api.player({ action: "vehicleControl", controls: args.controls, ticks: args.hold_ticks }) as unknown as ControlResult;
    const start = r.vehicle, held = r.holding.join("+");
    try {
      await this.wait(args.hold_ticks * 50 + 250, signal);
    } catch {
      await this.api.player({ action: "release" }).catch(() => undefined);
      return `Stopped holding ${held} early and released it.`;
    }
    const after = await this.api.state().catch(() => undefined);
    if (!after) return `Held ${held} for ${args.hold_ticks} ticks (read-back unavailable).`;
    const now = after.vehicle;
    if (!now || now.id !== start.id) {
      return `Held ${held}, but you no longer ride ${label(start)}; the controls let go when you left. You are at ${at(after.pos)}.`;
    }
    const dx = now.pos.x - start.pos.x, dy = now.pos.y - start.pos.y, dz = now.pos.z - start.pos.z;
    const moved = round(Math.hypot(dx, dy, dz));
    return `Held ${held} for ${args.hold_ticks} ticks: ${label(now)} moved ${moved} blocks (${dy >= 0 ? "+" : ""}${round(dy)} up) from ${at(start.pos)} to ${at(now.pos)}; now ${footing(now)}, ${round(now.speed)} blocks/s.`;
  }

  private async boost() {
    const r = await this.api.player({ action: "vehicleBoost" }) as unknown as BoostResult;
    if (!r.vehicle) return `Pressed boost (speed was ${r.speedBefore} blocks/s), but you no longer ride an aircraft.`;
    const gained = r.vehicle.speed - r.speedBefore;
    return `Pressed boost: speed ${r.speedBefore} → ${round(r.vehicle.speed)} blocks/s${gained > 1 ? "" : " (no clear boost: the booster slot may hold no rockets, or a boost was still running)"}.`;
  }

  private async inventory() {
    const r = await this.api.player({ action: "vehicleInventory", waitTicks: 20 }) as unknown as InventoryResult;
    if (!r.opened) return `Asked ${r.vehicleType} to open its inventory, but no screen opened after ${r.waitedTicks} ticks. Not repeated.`;
    return `Opened ${r.screen}${r.menu ? ` (${r.menu}, ${r.slots} slots)` : ""} for ${r.vehicleType}. Read it with screen; slot indexes belong to this menu. Aircraft fuel goes in its fuel slot (guide vehicles, section fuel).`;
  }
}
