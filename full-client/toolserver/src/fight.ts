import { nonempty, type Stack } from "./synapse.ts";

/**
 * The fight-back reflex's limits. It defends, never hunts: a fight starts only when the body was just hurt with a
 * hostile mob close by, or a hostile mob comes within reach, and it never targets players, passive animals or
 * creepers. See Body.fightOn.
 */
export const fightLimit = {
  /** Centre-to-centre distance within which a mob can be hit: vanilla reach is 3 blocks from the eye to its box. */
  reach: 3.5,
  /** Being hurt with a hostile this close (blocks) starts a fight with it. */
  notice: 6,
  /** The fight ends when no hostile was within a clear swing (or hurt the body) for this long (ms)... */
  quietMs: 2000,
  /** ...or after this long, whatever is still about (ms). */
  capMs: 20_000,
  /** At this health or below the fight hands over to fleeing; `auto` starts a fight only from `startHealth`. */
  fleeHealth: 6, startHealth: 8,
  /** Closing in on a mob that shoots: only on level dry ground, at most `leash` blocks from where the fight began,
   * giving up once `stuckMs` pass without getting half a block closer. */
  leash: 6, stuckMs: 1500,
  /** A mob a fight gave up on (out of reach or the cap) starts no new fight by coming close for this long (ms). */
  calmMs: 30_000,
};
/** Mobs that shoot from where they stand and walk on the ground: the body closes in on them, within the leash. */
export const closable: Record<string, true> = { "minecraft:skeleton": true, "minecraft:stray": true, "minecraft:pillager": true, "minecraft:witch": true };
/** Neutral until provoked: one coming close is no attack, so only being hurt starts a fight with it. */
export const neutral: Record<string, true> = { "minecraft:enderman": true, "minecraft:zombified_piglin": true, "minecraft:piglin": true };

export interface Weapon { slot: number; item: string; damage: number; speed: number }
/** Vanilla 1.20.1 attack damage of swords and axes by material, and an axe's attack speed (a sword's is 1.6). */
const tiers: Record<string, { sword: number; axe: number; axeSpeed: number }> = {
  wooden: { sword: 4, axe: 7, axeSpeed: 0.8 }, golden: { sword: 4, axe: 7, axeSpeed: 1 }, stone: { sword: 5, axe: 9, axeSpeed: 0.8 },
  iron: { sword: 6, axe: 9, axeSpeed: 0.9 }, diamond: { sword: 7, axe: 9, axeSpeed: 1 }, netherite: { sword: 8, axe: 10, axeSpeed: 1 },
};
/**
 * The hotbar's best sword or axe by damage per second (an iron sword's 6 x 1.6 beats an iron axe's 9 x 0.9).
 * A modded one of unknown material counts as iron: its real numbers are not in the state Synapse reports.
 */
export function bestWeapon(hotbar: Stack[]): Weapon | undefined {
  let best: Weapon | undefined;
  for (const stack of hotbar) {
    const match = nonempty(stack) ? /:(?:(\w+)_)?(sword|axe)$/.exec(stack.item) : null;
    if (!match) continue;
    const tier = tiers[match[1] ?? ""] ?? tiers.iron!, sword = match[2] === "sword";
    const weapon = { slot: stack.slot, item: stack.item, damage: sword ? tier.sword : tier.axe, speed: sword ? 1.6 : tier.axeSpeed };
    if (!best || weapon.damage * weapon.speed > best.damage * best.speed || (weapon.damage * weapon.speed === best.damage * best.speed && weapon.damage > best.damage)) best = weapon;
  }
  return best;
}
/** A full-strength swing waits out the attack cooldown, 20 / attack speed ticks (an empty hand's speed is 4), with a tick to spare. */
export const swingCooldown = (weapon?: Weapon) => Math.ceil(1000 / (weapon?.speed ?? 4)) + 50;
/** How far above its feet to aim at a mob: about the middle of it. */
const middles: Record<string, number> = {
  "minecraft:spider": 0.45, "minecraft:cave_spider": 0.25, "minecraft:silverfish": 0.15, "minecraft:endermite": 0.15,
  "minecraft:slime": 0.5, "minecraft:magma_cube": 0.5, "minecraft:phantom": 0.25, "minecraft:vex": 0.4, "minecraft:enderman": 1.4,
};
export const aimHeight = (type: string) => middles[type] ?? 0.9;
