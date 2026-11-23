import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bestWeapon, swingCooldown } from "../src/fight.ts";
import type { Entity } from "../src/synapse.ts";
import { fixture, type Fixture } from "./fake-synapse.ts";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
const attacks = (f: Fixture) => f.requests.filter(r => r.body.action === "attack").length;
const moves = (f: Fixture) => f.requests.filter(r => r.body.action === "move").map(r => r.body);
const mob = (id: number, type: string, distance: number, y = 64): Entity => ({ id, type, hostile: true, pos: [0, y, distance], distance, health: 20 });
/** Polls every 250 ms of body clock until a reflex line contains `until`, at most `ms`. */
async function pollUntil(f: Fixture, until: string, ms = 25_000) {
  let seen = "";
  for (let spent = 0; spent <= ms && !seen.includes(until); spent += 250) { f.tick(250); await f.body.poll(); await f.body.api.state(); seen += f.body.events.consume(); }
  return seen;
}

test("the hotbar's best weapon is chosen by damage per second, and swings wait out its cooldown", () => {
  const hotbar = (...items: string[]) => items.map((item, slot) => ({ slot, item, count: 1 }));
  expect(bestWeapon(hotbar("minecraft:iron_pickaxe", "minecraft:iron_axe", "minecraft:iron_sword"))?.item).toBe("minecraft:iron_sword");
  expect(bestWeapon(hotbar("minecraft:iron_sword", "minecraft:netherite_axe"))?.item).toBe("minecraft:netherite_axe");
  expect(bestWeapon(hotbar("minecraft:bread", "minecraft:diamond_pickaxe"))).toBeUndefined();
  expect(swingCooldown(bestWeapon(hotbar("minecraft:stone_axe")))).toBe(1300);
  expect(swingCooldown(undefined)).toBe(300);
});

test("a zombie coming within reach is fought without waiting to be hit; a neutral enderman or a creeper is not", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_sword", count: 1 }];
  await f.tools.call("set_reflexes", { avoid_creepers: false });
  f.state.nearbyEntities = [mob(7, "minecraft:enderman", 2), mob(8, "minecraft:creeper", 2.5)];
  await f.body.poll(); f.tick(250); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("fighting back");
  f.state.nearbyEntities.push(mob(9, "minecraft:zombie", 4.5));
  f.tick(250); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("fighting back"); // Not yet within reach.
  f.state.nearbyEntities[2] = mob(9, "minecraft:zombie", 3.2);
  f.tick(250); await f.body.poll();
  expect(f.body.events.consume()).toContain("reflex text=fighting back against minecraft:zombie 3.2 blocks away (it came within reach) with minecraft:iron_sword in H0, health 20");
  f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
  f.tick(250); await f.body.poll();
  expect(attacks(f)).toBe(1);
  expect(f.requests.some(r => r.body.action === "look" && (r.body.yaw as number) !== 0)).toBe(false); // Only ever toward the zombie, due south.
});

test("a skeleton out of reach is closed in on a few steps, then left with a plain report; it starts no new fight from afar", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  f.state.health = 15; f.state.nearbyEntities = [mob(4, "minecraft:skeleton", 5)];
  await f.body.poll();
  expect(f.body.events.consume()).toContain("fighting back against minecraft:skeleton 5 blocks away (you were just hurt)");
  const seen = await pollUntil(f, "fight ended");
  // It keeps its distance however he steps: after 1.5 s without getting closer he stops, and 2 s later the fight ends.
  expect(moves(f).length).toBeGreaterThan(0);
  for (const move of moves(f)) expect(move).toEqual({ action: "move", forward: true, sprint: true, ticks: 5 });
  expect(seen).toContain("fight ended after 3.5 s: minecraft:skeleton stayed 5 blocks off: it got no closer in 1.5 s. The body closes in on a mob that shoots only 6 blocks and on level dry ground; out of its line of sight is safer; minecraft:skeleton still 5 blocks away (0 hits); 0 swings; your health 15 -> 15");
  expect(attacks(f)).toBe(0);
  // Shot again from out of reach: nothing more is started against that skeleton for a while.
  const stepped = moves(f).length;
  f.state.health = 12; f.tick(250); await f.body.poll(); await f.body.api.state();
  expect(f.body.events.consume()).not.toContain("fighting back");
  expect(moves(f)).toHaveLength(stepped);
});

test("a zombie within reach that is never in a clear swing ends the fight after 2 s, naming what is in the way", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  f.state.health = 17; f.state.nearbyEntities = [mob(9, "minecraft:zombie", 1.8)];
  f.state.lookingAt = { type: "block", block: "minecraft:oak_fence", blockPos: [0, 64, 1] };
  await f.body.poll();
  const seen = await pollUntil(f, "fight ended");
  expect(seen).toContain("fight ended after 2 s: minecraft:zombie was within reach but never in a clear swing (minecraft:oak_fence in the way)");
  expect(attacks(f)).toBe(0);
  // It stays behind the fence: no new fight starts just because it is close.
  f.tick(250); await f.body.poll(); f.tick(250); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("fighting back");
});

test("a trip given during a fight waits for it and is resumed when it ends, with the walk said in both lines", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  f.state.health = 17; f.state.nearbyEntities = [mob(9, "minecraft:zombie", 2)];
  f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
  await f.body.poll();
  expect(f.body.events.consume()).not.toContain("walk paused"); // No trip was running.
  await f.tools.call("go_to", { x: 30, z: 0 });
  expect(f.baritone).toEqual({ active: true, paused: true });
  f.tick(250); await f.body.poll(); expect(attacks(f)).toBe(1);
  f.state.nearbyEntities = []; f.tick(100); await f.body.poll();
  const seen = await pollUntil(f, "fight ended");
  expect(seen).toMatch(/fight ended after 2\.\d s: no hostile within reach for 2 s; minecraft:zombie killed \(1 hit\); 1 swing; your health 17 -> 17; walk resumed/);
  expect(f.baritone).toEqual({ active: true, paused: false });
  expect(f.body.navigation?.description).toBe("goto 30 0");
});
test("a player who steps into the crosshair after the body's read is not struck: the click names the mob and Synapse refuses it", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  const zombie = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
  f.state.health = 17;
  f.state.nearbyEntities = [mob(9, "minecraft:zombie", 2), { id: 3, type: "minecraft:player", player: true, name: "Piper", pos: [0.3, 64, 1], distance: 1 }];
  f.state.lookingAt = zombie;
  await f.body.poll();
  // The body sees the zombie in its sights; by the time the click arrives Piper stands in the way.
  f.options.beforeAttack = state => { state.lookingAt = { type: "entity", entity: "minecraft:player", entityId: 3 }; f.options.beforeAttack = undefined; };
  f.tick(250); await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "attack").map(r => r.body)).toEqual([{ action: "attack", expectEntityId: 9 }]);
  expect(f.options.struck ?? []).toEqual([]);
  // He steps out again: the next swing, not held back by the refused one, lands on the zombie.
  f.state.lookingAt = zombie; f.tick(250); await f.body.poll();
  expect(f.options.struck).toEqual([9]);
  f.state.nearbyEntities = [];
  expect(await pollUntil(f, "fight ended")).toContain("minecraft:zombie killed (1 hit); 1 swing; your health 17 -> 17");
});

test("attack says what one click hit, and after a hold whether the block broke", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:iron_pickaxe", count: 1, durability: 200, maxDurability: 250 }];
  f.state.lookingAt = { type: "entity", entity: "minecraft:cow", entityId: 3 };
  expect(text(await f.tools.call("attack", {}))).toStartWith("Hit minecraft:cow.");
  expect(text(await f.tools.call("attack", { hold_ticks: 1 }))).toStartWith("Held attack for 1 ticks with minecraft:iron_pickaxe on minecraft:cow: a held attack hits a creature once");
  f.state.lookingAt = { type: "block", block: "minecraft:obsidian", blockPos: [0, 64, 2], face: "north" };
  const stuck = text(await f.tools.call("attack", { hold_ticks: 2 }));
  expect(stuck).toStartWith("Held attack for 2 ticks with minecraft:iron_pickaxe on minecraft:obsidian at 0,64,2: it is still there (minecraft:iron_pickaxe durability 200 -> 200).");
  expect(stuck).toContain("only while its game window has input focus (an older build)");
  // This time the block breaks during the hold.
  f.options.onHold = state => { state.lookingAt = { type: "block", block: "minecraft:stone", blockPos: [0, 64, 3], face: "north" }; state.hotbar[0]!.durability = 199; };
  expect(text(await f.tools.call("attack", { hold_ticks: 2 }))).toStartWith("Held attack for 2 ticks with minecraft:iron_pickaxe: minecraft:obsidian at 0,64,2 broke (minecraft:iron_pickaxe durability 200 -> 199). Now in your sights: minecraft:stone at 0,64,3.");
});

test("with a Synapse that breaks without focus, a hold that left the block standing says how far it got and why it ended", async () => {
  const f = await fixture(); f.state.hotbar = [{ slot: 0, item: "minecraft:wooden_pickaxe", count: 1, durability: 59, maxDurability: 59 }];
  f.state.lookingAt = { type: "block", block: "minecraft:deepslate", blockPos: [0, 64, 2], face: "north" };
  const target = { type: "block", pos: [0, 64, 2] };
  f.options.attackHold = { active: false, requestedTicks: 20, heldTicks: 20, target, progress: 0.44, ticksNeeded: 45, ended: "done" };
  const short = text(await f.tools.call("attack", { hold_ticks: 20 }));
  expect(short).toStartWith("Held attack for 20 ticks with minecraft:wooden_pickaxe on minecraft:deepslate at 0,64,2: it is still there");
  expect(short).toContain("Breaking got 44% of the way. With minecraft:wooden_pickaxe it needs about 45 ticks of holding. Breaking starts again from zero on every hold.");
  expect(short).not.toContain("focus");
  // A screen cut the next one short; the reply says so instead of blaming the tool.
  f.options.attackHold = { active: false, requestedTicks: 60, heldTicks: 12, target, progress: 0.27, ticksNeeded: 45, ended: "screen" };
  expect(text(await f.tools.call("attack", { hold_ticks: 60 }))).toContain("A screen opened after 12 ticks and ended the hold. Breaking got 27% of the way.");
  // An unbreakable block makes no progress at all.
  f.options.attackHold = { active: false, requestedTicks: 10, heldTicks: 10, target, progress: 0, ended: "done" };
  expect(text(await f.tools.call("attack", { hold_ticks: 10 }))).toContain("Holding made no breaking progress: it cannot be broken by hand here");
  // A block that broke ends the hold early; the reply counts the ticks it took.
  f.options.attackHold = { active: false, requestedTicks: 60, heldTicks: 23, target, progress: 0.98, ticksNeeded: 23, ended: "target" };
  f.options.onHold = state => { state.lookingAt = { type: "block", block: "minecraft:stone", blockPos: [0, 64, 3], face: "north" }; state.hotbar[0]!.durability = 58; };
  expect(text(await f.tools.call("attack", { hold_ticks: 60 }))).toStartWith("Held attack for 23 ticks with minecraft:wooden_pickaxe: minecraft:deepslate at 0,64,2 broke (minecraft:wooden_pickaxe durability 59 -> 58). Now in your sights: minecraft:stone at 0,64,3.");
});
