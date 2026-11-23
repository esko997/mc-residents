import { z } from "zod";
import type { AlarmEvent, AlarmRequest } from "../../commons/src/resident-contracts-alarm.ts";
import { hostileEntity, type Entity, type State } from "./synapse.ts";

export const alarmDefinition = {
  description: "Shout a short alarm for danger your survival reflexes cannot sense. Residents within earshot (48 blocks) hear it, and those up to 96 blocks away who can see you; they decide whether to help. Uses your current position, never moves you. At most once per 10 seconds.",
  schema: z.object({ reason: z.string().trim().min(1).max(120).refine(value => !/[\r\n\x00-\x1f\x7f]/.test(value), "Use one short line.") }).strict(),
};

export type AutoAlarmClass = "attacked" | "low health" | "creeper close" | "in lava";
export function automaticAlarmReasons(state: State, entities: readonly Entity[], hurt: boolean): { kind: AutoAlarmClass; reason: string }[] {
  if (state.health <= 0) return [];
  const reasons: { kind: AutoAlarmClass; reason: string }[] = [];
  const enemy = hurt ? entities.find(e => hostileEntity(e) && e.distance <= 6) : undefined;
  // Nearby danger is observable; the client does not identify the actual damage source.
  if (enemy) reasons.push({ kind: "attacked", reason: `attacked near ${enemy.type.replace(/^minecraft:/, "")}`.slice(0, 120) });
  const maximum = state.maxHealth ?? 20;
  if (state.health < maximum * 0.3) reasons.push({ kind: "low health", reason: "low health" });
  if (entities.some(e => e.type === "minecraft:creeper" && hostileEntity(e) && (e.distance <= 3 || (e.fuse === true && e.distance <= 6)))) {
    reasons.push({ kind: "creeper close", reason: "creeper close" });
  }
  if (state.inLava === true) reasons.push({ kind: "in lava", reason: "in lava" });
  return reasons;
}

export function alarmFromState(kind: AlarmRequest["kind"], reason: string, state: State): AlarmRequest {
  // Only the coordinates: Synapse's pos also carries `block`, which the hub's strict schema refuses.
  const { x, y, z } = state.pos;
  return { kind, reason, x, y, z, dimension: state.dimension, health: state.health, maxHealth: state.maxHealth ?? 20 };
}

/** Earshot, and the farthest an alarm can be seen with a clear line of sight confirmed by the server. */
export const alarmRange = { heard: 48, seen: 96 } as const;
/**
 * Perception seam. Within 48 blocks (three-dimensional, same dimension) an alarm is heard. Beyond that and up to
 * 96 it is perceived only if the server confirms clear line of sight ("sight"), which the caller asks the hub;
 * anything else, or a dead listener, perceives nothing. No hive mind.
 */
export function alarmPerception(listener: State, alarm: AlarmEvent): "heard" | "sight" | undefined {
  if (listener.health <= 0 || listener.dimension !== alarm.dimension) return undefined;
  const distance = Math.hypot(alarm.x - listener.pos.x, alarm.y - listener.pos.y, alarm.z - listener.pos.z);
  return distance <= alarmRange.heard ? "heard" : distance <= alarmRange.seen ? "sight" : undefined;
}

const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** `Margo 34 blocks north-east: …` when heard; `Margo 80 blocks east, in sight: …` when seen. */
export function perceivedAlarmText(listener: State, alarm: AlarmEvent, seen = false): string {
  const dx = alarm.x - listener.pos.x, dy = alarm.y - listener.pos.y, dz = alarm.z - listener.pos.z;
  const direction = dx || dz ? compass[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8]!
    : dy > 0 ? "above" : dy < 0 ? "below" : "here";
  const distance = Math.round(Math.hypot(dx, dy, dz));
  const health = alarm.health === undefined ? "" : `, health ${alarm.health}${alarm.maxHealth === undefined ? "" : `/${alarm.maxHealth}`}`;
  return `${alarm.sender} ${distance} block${distance === 1 ? "" : "s"} ${direction}${seen ? ", in sight" : ""}: ${alarm.reason}${health}`;
}
