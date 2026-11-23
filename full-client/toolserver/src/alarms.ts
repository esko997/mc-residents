import { z } from "zod";
import type { AlarmEvent, AlarmRequest } from "../../commons/src/resident-contracts-alarm.ts";
import { hostileEntity, type Entity, type State } from "./synapse.ts";

export const alarmDefinition = {
  description: "Shout a short alarm for danger your survival reflexes cannot sense. Only residents within earshot can hear it; they decide whether to help. Uses your current position, never moves you. At most once per 10 seconds.",
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
  return { kind, reason, ...state.pos, dimension: state.dimension, health: state.health, maxHealth: state.maxHealth ?? 20 };
}

/** Perception seam: future server-backed clear sight within 96 blocks belongs here, not in the hub fan-out. */
export function canPerceiveAlarm(listener: State, alarm: AlarmEvent): boolean {
  if (listener.health <= 0 || listener.dimension !== alarm.dimension) return false;
  return Math.hypot(alarm.x - listener.pos.x, alarm.y - listener.pos.y, alarm.z - listener.pos.z) <= 48;
}

const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export function perceivedAlarmText(listener: State, alarm: AlarmEvent): string {
  const dx = alarm.x - listener.pos.x, dy = alarm.y - listener.pos.y, dz = alarm.z - listener.pos.z;
  const direction = dx || dz ? compass[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8]!
    : dy > 0 ? "above" : dy < 0 ? "below" : "here";
  const distance = Math.round(Math.hypot(dx, dy, dz));
  const health = alarm.health === undefined ? "" : `, health ${alarm.health}${alarm.maxHealth === undefined ? "" : `/${alarm.maxHealth}`}`;
  return `${alarm.sender} ${distance} block${distance === 1 ? "" : "s"} ${direction}: ${alarm.reason}${health}`;
}
