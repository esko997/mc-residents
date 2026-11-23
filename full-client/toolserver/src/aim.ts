/**
 * What the crosshair rests on, said plainly, and the two actions that depend most on it: putting up a sign and
 * using a bucket. The client's crosshair target ignores fluids and right-clicks whatever block it rests on; a
 * bucket aims along the same line with its own rule (an empty bucket stops at the first source block). Synapse
 * reports both (`lookingAt.fluid` / `fluidSource`, with `fluidsChecked`); an older build reports only the block.
 */
import type { Body } from "./body.ts";
import { interactable } from "./body.ts";
import { nonempty, type AttackHoldState, type FluidHit, type Position, type State } from "./synapse.ts";

type Sights = State["lookingAt"];
const normals: Record<string, readonly [number, number, number]> = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
const xyz = (pos: readonly number[]) => pos.join(",");
const same = (a: readonly number[] | undefined, b: readonly number[] | undefined) => !!a && !!b && a.length === 3 && a.every((v, i) => v === b[i]);
/** The block cell on the far side of a face: where a sign or a bucket's fluid goes. */
export function beside(pos: readonly number[], face: string | undefined): number[] | undefined {
  const normal = face ? normals[face] : undefined;
  return normal && pos.length === 3 ? pos.map((v, i) => v + normal[i]!) : undefined;
}
const fluidText = (hit: FluidHit) => `${hit.fluid} ${hit.source ? "source" : "(flowing)"} at ${xyz(hit.blockPos)}`;
export function sightsText(at: Sights): string {
  return at.type === "block" ? `${at.block}${at.blockPos ? ` at ${xyz(at.blockPos)}` : ""}` : at.type === "entity" ? String(at.entity) : "nothing";
}
/** The reply to a single attack click, from what was in the sights and what Synapse says the click met. */
export function attackReport(at: Sights, on: unknown): string {
  if (on === "entity") return `Hit ${at.type === "entity" ? at.entity : "the creature in your sights"}.`;
  if (on === "block") return `Struck ${sightsText(at)}. One click breaks only what breaks at once (plants, torches); hold_ticks keeps at a harder block.`;
  if (on === "air") return "Nothing in your sights was in reach; nothing was hit.";
  return `Attacked ${sightsText(at)}.`;
}
/**
 * The reply to a held attack, once the hold is over: what became of the block it began on. Vanilla goes on
 * breaking a block only while `continueAttack` is passed `MouseHandler.isMouseGrabbed()`, and only the focused
 * window has the mouse, so a Synapse built before the fix gives a client in the background one click and no more
 * (live on 2026-11-23, 01:03 to 02:40 UTC, Gary's holds on chalk, bauxite, amethyst and obsidian changed nothing
 * while Margo's broke the same obsidian with the same pick). A Synapse with the fix opens that gate for its own hold
 * while the crosshair stays on the hold's target, and reports the hold (`hold`, matched by the id in its hold reply):
 * ticks held, breaking progress and why it ended. Without `hold` the reply says that this build needs focus.
 */
export function holdReport(before: State, after: State | undefined, ticks: number, hold?: AttackHoldState): string {
  const at = before.lookingAt, slot = before.selectedSlot;
  const hand = before.hotbar.find(s => s.slot === slot && nonempty(s));
  const head = `Held attack for ${hold ? hold.heldTicks : ticks} ticks with ${hand?.item ?? "an empty hand"}`;
  if (at.type === "entity") return `${head} on ${at.entity}: a held attack hits a creature once, on its first tick, as in the game. To fight, attack once per swing (a sword is ready again after about 0.6 s, an axe after 1 s), or leave it to your body, which fights back when attacked.`;
  if (at.type !== "block" || !at.blockPos) return `${head} at nothing in reach: nothing was broken.`;
  const block = `${at.block} at ${xyz(at.blockPos)}`;
  if (!after) return `${head} on ${block}; the read-back failed, so whether it broke is not known.`;
  const now = after.lookingAt, moved = Math.abs(after.rotation.yaw - before.rotation.yaw) > 1 || Math.abs(after.rotation.pitch - before.rotation.pitch) > 1;
  const kept = after.hotbar.find(s => s.slot === slot && nonempty(s));
  const wear = hand?.durability !== undefined && kept?.item === hand.item && kept.durability !== undefined ? ` (${hand.item} durability ${hand.durability} -> ${kept.durability})` : "";
  if (now.type === "block" && now.block === at.block && same(now.blockPos, at.blockPos)) {
    if (!hold) return `${head} on ${block}: it is still there${wear}. This client's Synapse goes on breaking a block under a held attack only while its game window has input focus (an older build), so in the background a hold is one hit and no more; the block may also need a better tool or a longer hold, or be protected. mine breaks blocks through Baritone without needing focus.`;
    return `${head} on ${block}: it is still there${wear}. ${stillThere(hold, hand?.item ?? "an empty hand")}`;
  }
  if (moved) return `${head} on ${block}: your view moved during the hold (something else turned it), and now rests on ${sightsText(now)}; whether the block broke was not seen.`;
  return `${head}: ${block} broke${wear}. Now in your sights: ${sightsText(now)}.`;
}
/** Why a block outlived a hold, from the hold Synapse reports. */
function stillThere(hold: AttackHoldState, tool: string): string {
  const got = `Breaking got ${Math.round((hold.progress ?? 0) * 100)}% of the way`;
  const needs = hold.ticksNeeded === undefined ? "" : hold.ticksNeeded > 200
    ? ` With ${tool} it needs about ${hold.ticksNeeded} ticks, more than one hold (200 at most): use a better tool, or mine.`
    : ` With ${tool} it needs about ${hold.ticksNeeded} ticks of holding.`;
  const restart = " Breaking starts again from zero on every hold.";
  switch (hold.ended) {
    case "done":
      if (hold.ticksNeeded === undefined) return "Holding made no breaking progress: it cannot be broken by hand here (an unbreakable block, or a game mode that cannot break).";
      return `${got}.${needs}${restart}`;
    case "target":
      return `The hold stopped after ${hold.heldTicks} ticks because the crosshair left the block: something moved into the line, the view turned, or it broke on this client and the server put it back (a protected spot, a claim). ${got}.${needs}`;
    case "screen": return `A screen opened after ${hold.heldTicks} ticks and ended the hold. ${got}.${needs}`;
    case "player": return `The hold ended after ${hold.heldTicks} ticks: you died, respawned, left the world or the game paused. ${got}.`;
    case "released": return `The hold was released after ${hold.heldTicks} ticks. ${got}.${needs}`;
    case "replaced": return `Another attack hold replaced this one after ${hold.heldTicks} ticks. ${got}.`;
    default: return `The hold had not finished when it was read back. ${got} so far.`;
  }
}

/** The reply to `look` at block x,y,z, after aiming at its centre: what is actually in the sights, fluids included. */
export function lookReport(target: readonly [number, number, number], at: Sights): string {
  const asked = xyz(target), fluid = at.fluid, source = at.fluidSource;
  // An entity takes the click before any block or fluid behind it.
  if (at.type === "entity") return `Looked toward ${asked}, but ${at.entity} is in the way.`;
  if (fluid && same(fluid.blockPos, target)) {
    const what = fluid.source ? "a source block: an empty bucket takes it" : "flowing, not a source block: a bucket cannot take it";
    const behind = at.type === "block" && at.blockPos ? `; behind it ${sightsText(at)}` : "";
    return `Looking at ${fluid.fluid} at ${asked} (${what})${behind}.`;
  }
  if (source && same(source.blockPos, target)) {
    return `Looking at ${source.fluid} at ${asked} (a source block: an empty bucket takes it); ${fluid ? `${fluidText(fluid)} is in front of it` : "it is the first source on your line"}.`;
  }
  const front = fluid ? ` ${fluidText(fluid)} is in front of it, and a bucket acts on the fluid first.` : "";
  if (at.type === "block" && same(at.blockPos, target)) return `Looking at ${at.block} at ${asked}.${front}`;
  const blind = at.fluidsChecked ? "" : " (This body does not report fluids under the crosshair: if that block is water or lava, a bucket still aims along this same line.)";
  if (fluid) return `Looked toward ${asked}, but ${fluidText(fluid)} is first on your line${at.type === "block" ? `, then ${sightsText(at)}` : ""}.`;
  if (at.type !== "block") return `Looked toward ${asked}, but it is out of reach (more than about 4.5 blocks) or hidden.${blind}`;
  return `Looked toward ${asked}, but ${sightsText(at)} is in the way.${blind}`;
}

/** Bucket kinds by item id. Milk is drunk, not poured. */
export function bucketKind(item: string | undefined): "empty" | "full" | undefined {
  if (item === "minecraft:bucket") return "empty";
  if (!item || item === "minecraft:milk_bucket" || !item.endsWith("_bucket")) return undefined;
  return "full";
}
/** What a fluid bucket holds, by its item id: minecraft:water_bucket -> minecraft:water. Fish buckets hold water. */
const pourOf = (item: string) => /^minecraft:(?:cod|salmon|pufferfish|tropical_fish|axolotl|tadpole)_bucket$/.test(item) ? "minecraft:water" : item.replace(/_bucket$/, "");

/** Before a plain `use` with a bucket: refuses an entity that would take the click instead of the fluid. */
export async function bucketGuard(body: Body, before: State) {
  const at = before.lookingAt;
  if (at.type !== "entity") return;
  const full = await body.api.state(true).catch(() => undefined);
  const entity = full?.nearbyEntities?.find(e => e.id === at.entityId);
  const boards = entity ? entity.mountable === true || entity.player === true : /boat|minecart|raft|player/.test(String(at.entity));
  if (boards) throw new Error(`${at.entity} is in your sights, so use would act on it (board it or interact), not on the fluid. Nothing was used. Look past it at the fluid block (look x,y,z says what is there) or move.`);
}

/** After a plain `use` with a bucket: what the bucket did, from the hand before and after and the sights before. */
export function bucketReport(held: string, kind: "empty" | "full", before: State, after: State | undefined): string {
  const at = before.lookingAt, slot = before.selectedSlot;
  const hand = after?.hotbar.find(s => s.slot === slot && nonempty(s))?.item;
  if (!after) return `Used ${held} (read-back unavailable: check your hand).`;
  if (kind === "empty") {
    const source = at.fluidSource;
    if (hand && hand !== held && bucketKind(hand) === "full") {
      return `Picked up ${pourOf(hand)}${source ? ` from ${xyz(source.blockPos)}, the first source block on your line` : ""}; your hand now holds ${hand}.`;
    }
    if (hand && hand !== held) return `Used ${held} on ${sightsText(at)}; your hand now holds ${hand}.`;
    if (!at.fluidsChecked) return `Used ${held} on ${sightsText(at)}; nothing was picked up. (This body does not report fluids under the crosshair; look at a source block of water or lava within about 4.5 blocks.)`;
    if (source) return `Nothing was picked up from the ${source.fluid} source at ${xyz(source.blockPos)}: the bucket is still empty (the server refused it, or ${sightsText(at)} took the click).`;
    return `Nothing was picked up: no source block of a fluid lies on your line within reach${at.fluid ? `; ${fluidText(at.fluid)} is not one, and a bucket only takes a source block` : ""}. Look at a source block first (look x,y,z says whether it is one).`;
  }
  const into = at.type === "block" && at.blockPos ? beside(at.blockPos, at.face) : undefined;
  const against = at.type === "block" ? ` against the ${at.face ?? "near"} face of ${sightsText(at)}` : "";
  if (hand !== held) {
    const nether = before.dimension === "minecraft:the_nether" && pourOf(held) === "minecraft:water" ? " In the Nether water boils away at once." : "";
    return `Poured ${pourOf(held)}${into ? ` at ${xyz(into)}` : ""}${against} (or into that block itself if it holds water, like a slab or stairs); your hand now holds ${hand ?? "nothing"}.${nether}`;
  }
  if (at.type !== "block") return `The bucket stayed full: nothing is in reach to pour against (about 4.5 blocks). Look at the block face where the ${pourOf(held)} should go.`;
  return `The bucket stayed full: nothing was poured${against}${into ? ` into ${xyz(into)}` : ""} (that space may be taken, or the server refused it).`;
}

/**
 * Puts up the selected sign against the looked-at face and writes its lines. Crouching makes the click place the
 * sign instead of opening or toggling the block (chest, barrel, door, composter...), as a player does; crouching
 * lowers the eye, so the same face is aimed at again and checked before the click.
 */
export async function writeSign(body: Body, lines: string[], waitMs = 2000): Promise<string> {
  const api = body.api;
  const state = await api.state();
  const held = state.hotbar.find(s => s.slot === state.selectedSlot && nonempty(s));
  if (!held?.item.endsWith("_sign")) throw new Error(`Select a sign in the hotbar first (you hold ${held?.item ?? "nothing"}).`);
  if (state.screen !== "none") throw new Error("Close the current screen before placing a sign.");
  if (state.riding) throw new Error("Get off the vehicle first: placing a sign crouches, and crouching would dismount you.");
  const at = state.lookingAt;
  if (at.type !== "block" || !at.blockPos) {
    throw new Error(`Look at the block the sign should go on first; ${at.type === "entity" ? `${at.entity} is in your sights` : "nothing is in reach (about 4.5 blocks)"}.`);
  }
  const target = sightsText(at), face = at.face ? ` ${at.face} face of` : "", cell = beside(at.blockPos, at.face);
  if (/_sign$/.test(at.block ?? "")) throw new Error(`${target} is a sign already; write_sign puts up a new one beside it. Look at another block. To change that sign's text, use it with an empty hand to open its editor.`);
  const normal = at.face ? normals[at.face] : undefined;
  const [bx, by, bz] = at.blockPos as [number, number, number];
  const aim: Position = { x: bx + 0.5 + (normal?.[0] ?? 0) * 0.49, y: by + 0.5 + (normal?.[1] ?? 0) * 0.49, z: bz + 0.5 + (normal?.[2] ?? 0) * 0.49 };
  const count = held.count;
  // Synapse answers a move only when it ends (the editor opening ends it early); release below ends it otherwise.
  const crouch = api.player({ action: "move", sneak: true, ticks: 40 }).catch(() => undefined);
  let screen = "none";
  try {
    await api.request("/wait?ticks=3");
    const crouched = await api.state();
    const lowered = crouched.eye.y < state.eye.y - 0.2;
    if (!lowered && interactable.test(at.block ?? "")) {
      throw new Error(`Could not crouch, and right-clicking ${target} would open or toggle it instead of placing the sign. Nothing was placed.`);
    }
    await body.lookAt(aim, crouched);
    await api.request("/wait?ticks=2");
    const aimed = (await api.state()).lookingAt;
    if (aimed.type !== "block" || !same(aimed.blockPos, at.blockPos) || (at.face && aimed.face !== at.face)) {
      throw new Error(`Crouching moved your sights off the${face} ${target}: now ${sightsText(aimed)}${aimed.face ? ` (${aimed.face} face)` : ""}. Nothing was placed; step back a little or look at another face.`);
    }
    await api.player({ action: "use" });
    const end = Date.now() + waitMs;
    let hand = count;
    for (;;) {
      screen = (await api.gui()).screen;
      if (screen !== "none") break;
      const now = await api.state().catch(() => undefined);
      if (now) hand = now.hotbar.find(s => s.slot === state.selectedSlot && s.item === held.item)?.count ?? 0;
      if (Date.now() >= end) break;
      await Bun.sleep(100);
    }
    if (screen === "none") {
      if (hand < count) throw new Error(`A sign left your hand but no editor opened, so it is blank${cell ? `, probably at ${xyz(cell)}` : ""}. Look at it and use it with an empty hand to open its editor, then type_text.`);
      throw new Error(`Nothing was placed on the${face} ${target}: the sign stayed in your hand. ${cell ? `The space at ${xyz(cell)} must be free (air, water, grass) ` : "The space in front of that face must be free "}and the block must hold a sign there: a solid side for a wall sign, a solid top for a standing one (not a torch, fence, glass pane or a slab's side). Look at another face or block.`);
    }
  } finally {
    await api.player({ action: "release" }).catch(() => undefined);
    await crouch;
  }
  if (!/sign/i.test(screen)) {
    const closed = await body.closeScreen().catch(() => undefined);
    throw new Error(`Using the sign opened ${screen} from ${target} instead of placing it (the crouch did not reach the server in time)${closed?.after === "none" ? "; it was closed again" : ""}. No sign was placed.`);
  }
  for (let i = 0; i < lines.length; i++) {
    if (i) await api.gui({ action: "key", key: "ENTER" });
    await api.gui({ action: "keys", text: lines[i] });
  }
  const editor = await api.gui();
  const done = editor.widgets?.find(w => w.button && w.active && w.visible && /^done$/i.test(w.label));
  await api.gui(done ? { action: "clickButton", index: done.index } : { action: "key", key: "ESCAPE" });
  const after = await api.gui();
  if (/sign/i.test(after.screen)) throw new Error("Text entered, but sign editor is still open; inspect screen before continuing.");
  return `Placed the sign${cell ? ` at ${xyz(cell)}` : ""} on the${face} ${target}; entered ${lines.length} line${lines.length === 1 ? "" : "s"}; editor closed (${done ? "Done" : "ESCAPE"}). Text persistence is server-controlled.`;
}
