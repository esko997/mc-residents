import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture as fakeFixture, type Fixture } from "./fake-synapse.ts";

const fixture = () => fakeFixture({ rotation: { yaw: 73, pitch: 10 }, selectedSlot: 4 });
const toolText = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
// Exact mode-boundary commands: keep every later #stop visible to cancellation assertions.
const walkPreamble = ["#stop", "#set allowBreak false", "#set allowPlace false", "#set allowWaterBucketFall false"];
const restoreTripSettings = ["#set allowBreak true", "#set allowPlace true", "#set allowWaterBucketFall true"];
function moveTo(f: Fixture, x: number, y: number, z: number) {
  f.state.pos = { x, y, z }; f.state.eye = { x, y: y + 1.62, z };
}

async function startFight(f: Fixture) {
  f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }];
  await f.body.poll();
  f.state.health = 18;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [0, 64, 2], health: 20 }];
  f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
  await f.body.poll(); await f.body.poll();
  expect(f.requests.some(r => r.body.action === "attack")).toBe(true);
}

async function startMeal(f: Fixture, food = 8) {
  f.state.food = food;
  f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
  await f.body.poll();
  expect(f.state.rotation.pitch).toBe(-90);
  expect(f.state.selectedSlot).toBe(1);
}

test("A22 Reflex fight monopolizes the body indefinitely", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 }); await startFight(f);
  f.tick(14999); await f.body.poll();
  expect(f.requests.some(r => r.body.text === "#resume")).toBe(false);
  const attacks = f.requests.filter(r => r.body.action === "attack").length;
  f.tick(1); await f.body.poll();
  const cleanup = f.requests.filter(r => r.path === "/player" || r.path === "/chat").slice(-3).map(r => r.body);
  expect(cleanup).toEqual([{ action: "release" }, { action: "selectHotbar", slot: 4 }, { text: "#resume" }]);
  expect(f.body.events.consume()).toContain("fight ended; navigation resumed");
  await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(attacks);
  expect(f.state.selectedSlot).toBe(4);
  expect(f.body.navigation?.description).toBe("goto 20 0");
});

test.each(["meal", "fight"] as const)("I05 Automatic controls fight a direct tool action (%s)", async kind => {
  const f = await fixture();
  if (kind === "meal") await startMeal(f); else await startFight(f);
  const start = f.requests.length;
  const result = await f.tools.call("look", { yaw: -31, pitch: 27 });
  expect(result.isError).toBe(false);
  const actions = f.requests.slice(start).filter(r => r.path === "/player").map(r => r.body);
  expect(actions[0]).toEqual({ action: "release" });
  expect(actions.at(-1)).toEqual({ action: "look", yaw: -31, pitch: 27 });
  expect(actions.find(r => r.action === "selectHotbar")).toEqual({ action: "selectHotbar", slot: 4 });
  f.body.reflexes.auto_eat = false;
  f.tick(20000); await f.body.poll();
  expect(f.state.rotation).toEqual({ yaw: -31, pitch: 27 });
  expect(f.state.selectedSlot).toBe(4);
  expect(f.requests.slice(start).some(r => r.body.action === "attack" || r.body.action === "use")).toBe(false);
});

test("look with only pitch keeps the current yaw; with neither it explains", async () => {
  const f = await fixture(); await f.body.poll();
  const result = await f.tools.call("look", { pitch: -45 });
  expect(result.isError).toBe(false);
  expect(f.requests.filter(r => r.body.action === "look").at(-1)?.body).toEqual({ action: "look", yaw: 73, pitch: -45 });
  const empty = await f.tools.call("look", {});
  expect(empty.isError).toBe(true);
  expect(toolText(empty)).toContain("Look by yaw and/or pitch");
});

test.each(["meal", "fight"] as const)("I06 Automatic controls remain held on death (%s)", async kind => {
  const f = await fixture();
  if (kind === "meal") await startMeal(f); else await startFight(f);
  const start = f.requests.length;
  f.state.health = 0; await f.body.poll();
  expect(f.requests.slice(start).some(r => r.body.action === "release")).toBe(true);
  expect(f.state.selectedSlot).toBe(4);
  expect(f.body.events.consume()).toContain("died");
  f.tick(20000); await f.body.poll();
  expect(f.requests.slice(start).some(r => r.body.action === "attack" || r.body.action === "use" || r.body.action === "move")).toBe(false);
});

test.each([1, 2])("I10 Automatic meal leaves aim or slot captured from the previous meal (%i meals)", async meals => {
  const f = await fixture(); await startMeal(f, meals === 1 ? 8 : 0);
  for (let i = 0; i < meals; i++) {
    f.tick(2200); await f.body.poll();
    expect(f.body.events.consume()).toContain(`ate minecraft:bread, food ${meals === 1 ? 8 : i * 6} -> ${meals === 1 ? 14 : (i + 1) * 6}`);
    if (i + 1 < meals) {
      // The next meal begins immediately, but release restored the original
      // orientation and slot before this new meal recorded its baseline.
      expect(f.state.rotation.pitch).toBe(-90);
      const actions = f.requests.filter(r => r.path === "/player").map(r => r.body);
      const release = actions.findIndex(r => r.action === "release");
      expect(actions.slice(release, release + 3)).toEqual([
        { action: "release" }, { action: "selectHotbar", slot: 4 }, { action: "look", yaw: 73, pitch: 10 },
      ]);
    }
  }
  expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
  expect(f.state.selectedSlot).toBe(4);
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(meals);
  const uses = f.requests.filter(r => r.body.action === "use").length;
  await f.body.poll();
  expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(uses);
});

test.each(["abort", "timeout"] as const)("R04 Cancelled wait is mistaken for cancelled movement (%s)", async kind => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 });
  const start = f.requests.length, controller = new AbortController();
  const waiting = f.tools.call("wait", { seconds: 1 }, controller.signal);
  if (kind === "abort") controller.abort();
  const result = await waiting;
  expect(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")).toContain(kind === "abort" ? "Wait cancelled." : "Time is up.");
  expect(f.body.navigation?.description).toBe("goto 20 0");
  expect(f.requests).toHaveLength(start);
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short");
  expect(f.requests.slice(start).some(r => r.body.text === "#stop")).toBe(false);
});

test("A23 retreat follows the newest safer crumb and re-aims twice a second", async () => {
  const f = await fixture(); await f.body.poll();
  moveTo(f, 0, 64, 2); await f.body.poll();
  moveTo(f, 0, 64, 4); await f.body.poll();
  f.state.health = 18;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 4], health: 20 }];
  await f.body.poll(); await f.body.api.state();
  const looks = f.requests.filter(r => r.body.action === "look");
  expect(Math.abs(looks.at(-1)?.body.yaw as number)).toBeCloseTo(180); // crumb north, not open air west
  expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", forward: true, sprint: true, ticks: 5 });
  f.tick(499); await f.body.poll(); expect(f.requests.filter(r => r.body.action === "look")).toHaveLength(looks.length);
  f.tick(1); await f.body.poll(); expect(f.requests.filter(r => r.body.action === "look")).toHaveLength(looks.length + 1);
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 20, pos: [20, 64, 4], health: 20 }];
  f.tick(1000); await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
  const events = f.body.events.consume();
  expect(events).toContain("retreat rescue started");
  expect(events).toContain("20 blocks from minecraft:zombie (2 at the start); it may still follow or shoot");
});

test("A23 retreat never heads for a crumb on the far side of the threat", async () => {
  const f = await fixture(); await f.body.poll();
  // He walked west along z=0 from x=6 to x=0; a lit creeper now stands at x=2, between him and those crumbs.
  for (const x of [6, 5, 4, 3, 2, 1, 0]) { moveTo(f, x, 64, 0); await f.body.poll(); }
  f.state.nearbyEntities = [{ id: 5, type: "minecraft:creeper", hostile: true, distance: 2, pos: [2, 64, 0], health: 20, fuse: true }];
  f.tick(1000); await f.body.poll(); await f.body.api.state();
  const look = f.requests.filter(r => r.body.action === "look").at(-1)?.body;
  // Yaw 90 faces west (-x), away from the creeper; -90 would run east past it.
  expect(look?.yaw as number).toBeCloseTo(90);
  expect(f.body.events.consume()).toContain("retreat rescue started");
});

const zombie = (x: number, z: number) => [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [x, 64, z] as [number, number, number], health: 20 }];
const moves = (f: Fixture) => f.requests.filter(r => r.body.action === "move").map(r => r.body);

test("A23 a hit that throws him into the air does not end the retreat: it waits for the ground, then walks away", async () => {
  const f = await fixture(); await f.body.poll();
  // The zombie's hit knocks him up: his feet are off the ground and he is rising when the retreat starts.
  Object.assign(f.state, { health: 18, onGround: false, velocity: { x: -0.3, y: 0.31, z: 0 } });
  f.state.nearbyEntities = zombie(2, 0);
  await f.body.poll();
  expect(f.body.rescuing).toBe("retreat");
  // Coming down again, as far and as fast as a jump on level ground.
  Object.assign(f.state, { fallDistance: 1.1, velocity: { x: -0.2, y: -0.39, z: 0 } });
  f.tick(250); await f.body.poll(); await f.body.api.state();
  expect(f.body.rescuing).toBe("retreat");
  expect(moves(f)).toHaveLength(0); // No step is begun in the air.
  Object.assign(f.state, { onGround: true, fallDistance: 0, velocity: { x: 0, y: -0.08, z: 0 } });
  f.tick(250); await f.body.poll(); await f.body.api.state();
  expect(moves(f)).toEqual([{ action: "move", forward: true, ticks: 4 }]);
  expect(f.requests.filter(r => r.body.action === "look").at(-1)?.body.yaw as number).toBeCloseTo(90);
  const events = f.body.events.consume();
  expect(events).toContain("retreat rescue started: fleeing from minecraft:zombie (no weapon)");
  expect(events).not.toContain("rescue ended");
  expect(f.requests.some(r => r.body.text === "#resume")).toBe(false);
});

test("A23 a retreat that walks off a drop stops when he is falling and says how far", async () => {
  const f = await fixture(); await f.body.poll(); f.state.health = 18;
  f.state.nearbyEntities = zombie(2, 0);
  await f.body.poll(); await f.body.api.state();
  expect(moves(f)).toEqual([{ action: "move", forward: true, ticks: 4 }]);
  // Over the edge: at first no different from a step down.
  Object.assign(f.state, { onGround: false, fallDistance: 0.4, velocity: { x: 0, y: -0.23, z: 0 } });
  f.tick(250); await f.body.poll();
  expect(f.body.rescuing).toBe("retreat");
  // Further and faster than any jump or step.
  moveTo(f, -1, 61.1, 0); Object.assign(f.state, { fallDistance: 2.9, velocity: { x: 0, y: -0.72, z: 0 } });
  f.tick(250); await f.body.poll();
  expect(f.body.events.consume()).toContain("retreat rescue ended after 0.5 s: falling, 2.9 blocks so far; movement stopped");
  expect(moves(f)).toHaveLength(1);
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
});

test("A23 a retreat with no ground for longer than a jump lasts stops and says so", async () => {
  const f = await fixture(); await f.body.poll(); f.state.health = 18;
  f.state.nearbyEntities = zombie(2, 0);
  await f.body.poll(); await f.body.api.state();
  // Feet off the ground without falling, as in a cobweb or on a vine.
  f.state.onGround = false;
  f.tick(250); await f.body.poll();
  f.tick(999); await f.body.poll();
  expect(f.body.rescuing).toBe("retreat");
  f.tick(1); await f.body.poll();
  expect(f.body.events.consume()).toContain("retreat rescue ended after 1.3 s: no ground underfoot for 1 s; movement stopped");
  expect(moves(f)).toHaveLength(1);
});

test("A23 a retreat begun afloat swims away instead of ending for want of ground, and runs once his feet are down", async () => {
  const f = await fixture();
  Object.assign(f.state, { inWater: true, onGround: false }); await f.body.poll();
  f.state.health = 17.5;
  f.state.nearbyEntities = [{ id: 4, type: "minecraft:drowned", hostile: true, distance: 2, pos: [2, 63, 0], health: 20 }];
  await f.body.poll(); await f.body.api.state();
  expect(f.body.events.consume()).toContain("retreat rescue started: fleeing from minecraft:drowned (no weapon); afloat, swimming away");
  expect(moves(f)).toEqual([{ action: "move", forward: true, jump: true, ticks: 5 }]);
  expect(f.requests.filter(r => r.body.action === "look").at(-1)?.body.yaw as number).toBeCloseTo(90);
  f.tick(500); await f.body.poll(); await f.body.api.state();
  expect(moves(f)).toHaveLength(2);
  // Wading: water at his feet, the bed under them.
  f.state.onGround = true;
  f.tick(500); await f.body.poll(); await f.body.api.state();
  expect(moves(f).at(-1)).toEqual({ action: "move", forward: true, ticks: 4 });
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("retreat rescue ended after 5 s: timed out after 5 s");
});

test("A23 a retreat on foot wades on, and stops once he is afloat in water he walked into", async () => {
  const f = await fixture(); await f.body.poll(); f.state.health = 18;
  f.state.nearbyEntities = zombie(2, 0);
  await f.body.poll(); await f.body.api.state();
  f.state.inWater = true;
  f.tick(500); await f.body.poll(); await f.body.api.state();
  expect(moves(f)).toHaveLength(2);
  f.state.onGround = false;
  f.tick(250); await f.body.poll();
  f.tick(499); await f.body.poll();
  expect(f.body.rescuing).toBe("retreat");
  f.tick(1); await f.body.poll();
  expect(f.body.events.consume()).toContain("retreat rescue ended after 1.3 s: entered deep water; movement stopped");
  expect(moves(f)).toHaveLength(2);
});

test("A13 surfacing repeats jump, seeks the trail after six seconds, then resumes", async () => {
  const f = await fixture(); await f.body.poll();
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air: 40, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
  expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", jump: true, ticks: 5 });
  for (const air of [35, 30, 25]) { f.state.air = air; f.tick(250); await f.body.poll(); await f.body.api.state(); }
  expect(f.requests.filter(r => r.body.action === "move").length).toBeGreaterThanOrEqual(4);
  f.tick(6000); await f.body.poll(); await f.body.api.state();
  f.tick(250); await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "move").at(-1)?.body).toEqual({ action: "move", forward: true, jump: true, ticks: 5 });
  Object.assign(f.state, { underwater: false, inWater: false, onGround: true, air: 300 });
  f.tick(250); await f.body.poll();
  const events = f.body.events.consume();
  expect(events.match(/surface rescue started/g)).toHaveLength(1);
  expect(events.match(/surface rescue ended/g)).toHaveLength(1);
  expect(events).toContain("air 40 -> 300");
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
});

test("A13 a screen open while drowning is closed so the rescue can run", async () => {
  const f = await fixture(); await f.body.poll();
  f.setScreen({ screen: "CraftingScreen", title: "Crafting" });
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air: 40, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
  const events = f.body.events.consume();
  expect(events).toContain("closed CraftingScreen to escape danger");
  expect(events).toContain("surface rescue started");
  expect(f.requests.some(r => r.body.action === "move" && r.body.jump === true)).toBe(true);
});

test("A13 after surfacing he swims for the shore instead of floating and sinking again", async () => {
  const f = await fixture(); await f.body.poll();
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air: 40, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
  Object.assign(f.state, { underwater: false, inWater: true, air: 120 });
  for (let i = 0; i < 3; i++) { f.tick(600); await f.body.poll(); await f.body.api.state(); }
  let events = f.body.events.consume();
  expect(events).not.toContain("surface rescue ended");
  expect(f.requests.filter(r => r.body.action === "move").at(-1)?.body).toEqual({ action: "move", forward: true, jump: true, ticks: 5 });
  Object.assign(f.state, { inWater: false, onGround: true, air: 300 });
  f.tick(600); await f.body.poll();
  events = f.body.events.consume();
  expect(events).toContain("surface rescue ended");
  expect(events).toContain("out of the water");
});

test("A13 a screen that will not close is reported once as blocking the rescue", async () => {
  const f = await fixture(); Object.assign(f.options, { closeFailures: 99, escapeBlocked: true }); await f.body.poll();
  f.setScreen({ screen: "CraftingScreen", title: "Crafting" });
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air: 40, maxAir: 300 });
  await f.body.poll(); await f.body.poll();
  const events = f.body.events.consume();
  expect(events.match(/rescue blocked/g)).toHaveLength(1);
  expect(events).not.toContain("surface rescue started");
});

test("A12 lava rescue jumps and sprints toward the last safe crumb until out", async () => {
  const f = await fixture(); await f.body.poll(); moveTo(f, 2, 64, 0);
  Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
  await f.body.poll(); await f.body.api.state();
  expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", forward: true, jump: true, sprint: true, ticks: 20 });
  expect(f.requests.find(r => r.body.action === "look")?.body.yaw as number).toBeCloseTo(90);
  f.tick(250); await f.body.poll(); await f.body.api.state(); expect(f.requests.filter(r => r.body.action === "move")).toHaveLength(2);
  Object.assign(f.state, { inLava: false, onFire: false, onGround: true });
  await f.body.poll(); const events = f.body.events.consume();
  expect(events.match(/lava rescue started/g)).toHaveLength(1);
  expect(events.match(/lava rescue ended/g)).toHaveLength(1);
  expect(events).toContain("escaped lava");
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
});

test("A12 lava rescue steers past the rim crumb he just stepped off", async () => {
  const f = await fixture(); await f.body.poll();
  moveTo(f, 2, 64, 1); await f.body.poll(); // last dry step: the rim of a 1x1 lava hole
  moveTo(f, 2, 63.5, 0.8); Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
  await f.body.poll(); await f.body.api.state();
  // Aim at the older crumb (0, 0), 2.2 blocks away, not the rim 0.2 blocks off (yaw 0).
  expect(f.requests.find(r => r.body.action === "look")?.body.yaw as number).toBeCloseTo(111.8, 0);
});

test("A11 fire rescue places and retrieves water when bucket use is on, restoring view and hotbar", async () => {
  const f = await fixture(); f.body.reflexes.water_bucket = true; await f.body.poll();
  f.state.hotbar = [{ slot: 2, item: "minecraft:water_bucket", count: 1 }]; f.state.onFire = true;
  await f.body.poll();
  expect(f.state.selectedSlot).toBe(2); expect(f.state.rotation.pitch).toBe(90);
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(1);
  f.tick(999); await f.body.poll(); expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(1);
  f.state.onFire = false; f.tick(1); await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(2);
  expect(f.state.selectedSlot).toBe(4); expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
  const events = f.body.events.consume();
  expect(events.match(/fire rescue started/g)).toHaveLength(1);
  expect(events.match(/fire rescue ended/g)).toHaveLength(1);
  expect(events).toContain("no longer burning");
});

test("A11 a missed water pickup is reported, not claimed as retrieved", async () => {
  const f = await fixture(); f.body.reflexes.water_bucket = true; await f.body.poll();
  f.state.hotbar = [{ slot: 2, item: "minecraft:water_bucket", count: 1 }]; f.state.onFire = true;
  await f.body.poll();
  f.state.hotbar = [{ slot: 2, item: "minecraft:bucket", count: 1 }]; f.state.onFire = false;
  f.tick(1000); await f.body.poll();
  const events = f.body.events.consume();
  expect(events).toContain("NOT picked back up");
  expect(events).not.toContain("placed and retrieved");
});

test.each([
  ["no bucket", "minecraft:overworld", [], true, "no water bucket"],
  ["Nether", "minecraft:the_nether", [{ slot: 2, item: "minecraft:water_bucket", count: 1 }], true, "Nether"],
  ["bucket use off by default", "minecraft:overworld", [{ slot: 2, item: "minecraft:water_bucket", count: 1 }], false, "water bucket use is off"],
] as const)("A11 fire without usable water is report-only (%s)", async (_label, dimension, hotbar, bucket, expected) => {
  const f = await fixture(); if (bucket) f.body.reflexes.water_bucket = true; await f.body.poll();
  f.state.dimension = dimension; f.state.hotbar = [...hotbar]; f.state.onFire = true;
  await f.body.poll(); let events = f.body.events.consume();
  expect(events).toContain("fire rescue started"); expect(events).toContain(expected);
  expect(events).not.toContain("fire rescue ended");
  await f.body.poll(); expect(f.body.events.consume()).not.toContain("fire rescue started");
  f.state.onFire = false; await f.body.poll(); events = f.body.events.consume();
  expect(events.match(/fire rescue ended/g)).toHaveLength(1);
  expect(f.requests.some(r => ["#pause", "#resume"].includes(String(r.body.text)))).toBe(false);
  expect(f.requests.some(r => r.body.action === "use" || r.body.action === "release")).toBe(false);
});

test.each(["fuse", "close"] as const)("A08 creeper %s triggers retreat before damage and never an attack", async trigger => {
  const f = await fixture(); f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: trigger === "fuse" ? 8 : 2, pos: [trigger === "fuse" ? 8 : 2, 64, 0], health: 20, ...(trigger === "fuse" ? { fuse: true } : {}) }];
  f.tick(1000); await f.body.poll(); await f.body.api.state();
  expect(f.body.events.consume()).toContain("retreat rescue started");
  expect(f.requests.some(r => r.body.action === "move")).toBe(true);
  expect(f.requests.some(r => r.body.action === "attack")).toBe(false);
  expect(f.state.health).toBe(20);
});

test("A08 fight mode never attacks a creeper when avoidance is disabled", async () => {
  const f = await fixture(); await f.tools.call("set_reflexes", { when_attacked: "fight", avoid_creepers: false });
  f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll();
  f.state.health = 18; f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 2, pos: [2, 64, 0], health: 20, fuse: true }];
  await f.body.poll(); await f.body.poll();
  expect(f.requests.some(r => r.body.action === "attack" || r.body.action === "move")).toBe(false);
});

test("A06/A02 lava interrupts a meal, no meal starts during rescue, and injury starts meals", async () => {
  const f = await fixture(); await startMeal(f, 8);
  Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
  await f.body.poll();
  const release = f.requests.findIndex(r => r.body.action === "release");
  const pause = f.requests.findIndex(r => r.body.text === "#pause");
  expect(release).toBeGreaterThanOrEqual(0); expect(release).toBeLessThan(pause);
  const mealUses = f.requests.filter(r => r.body.action === "use" && r.body.ticks === 40).length;
  f.tick(2200); await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "use" && r.body.ticks === 40)).toHaveLength(mealUses);
  Object.assign(f.state, { inLava: false, onFire: false, onGround: true }); await f.body.poll();
  const f2 = await fixture(); f2.state.health = 13; f2.state.food = 19;
  f2.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }]; await f2.body.poll();
  expect(f2.requests.some(r => r.body.action === "use" && r.body.ticks === 40)).toBe(true);
});

test("A06 lava interrupts a fight with keys released before rescue movement", async () => {
  const f = await fixture(); await startFight(f);
  const attacks = f.requests.filter(r => r.body.action === "attack").length;
  Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
  await f.body.poll(); await f.body.api.state();
  const release = f.requests.findIndex(r => r.body.action === "release");
  const pause = f.requests.map(r => r.body.text).lastIndexOf("#pause");
  const move = f.requests.findIndex(r => r.body.action === "move");
  expect(release).toBeLessThan(pause); expect(release).toBeLessThan(move);
  expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(attacks);
  expect(f.body.events.consume()).toContain("lava rescue started");
});

test("priority is lava, drowning, fire, then creeper", async () => {
  const f = await fixture(); await f.body.poll();
  Object.assign(f.state, { inLava: true, underwater: true, inWater: true, onFire: true, air: 40, maxAir: 300 });
  f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 2, pos: [2, 64, 0], health: 20, fuse: true }];
  f.tick(1000); await f.body.poll(); let events = f.body.events.consume();
  expect(events).toContain("lava rescue started");
  expect(events).not.toContain("surface rescue started"); expect(events).not.toContain("fire rescue started"); expect(events).not.toContain("retreat rescue started");
  f.state.inLava = false; await f.body.poll(); await f.body.poll(); events = f.body.events.consume();
  expect(events).toContain("surface rescue started"); expect(events).not.toContain("fire rescue started");
  Object.assign(f.state, { underwater: false, inWater: false, air: 300 }); await f.body.poll(); await f.body.poll(); events = f.body.events.consume();
  expect(events).toContain("fire rescue started"); expect(events).not.toContain("retreat rescue started");
});

test.each(["success", "timeout", "death", "screen", "manual", "shutdown"] as const)("rescue cleanup releases and resumes exactly once on %s", async exit => {
  const f = await fixture(); await f.body.poll();
  f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 2, pos: [2, 64, 0], health: 20, fuse: true }];
  f.tick(1000); await f.body.poll(); await f.body.api.state();
  if (exit === "success") {
    f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 12, pos: [12, 64, 0], health: 20 }];
    f.tick(1000); await f.body.poll();
  } else if (exit === "timeout") { f.tick(5000); await f.body.poll(); }
  else if (exit === "death") { f.state.health = 0; await f.body.poll(); }
  // An ordinary screen is closed so the rescue can go on; only one that refuses to close ends it.
  else if (exit === "screen") { Object.assign(f.options, { closeFailures: 99, escapeBlocked: true }); f.setScreen({ screen: "InventoryScreen" }); await f.body.poll(); }
  else if (exit === "manual") await f.tools.call("look", { yaw: 10, pitch: 0 });
  else await f.body.close();
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#pause")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
});

test("rescue events wake a pending wait", async () => {
  const f = await fixture(); await f.body.poll();
  const waiting = f.tools.call("wait", { seconds: 2, for: ["reflex"] });
  f.state.inLava = true; f.state.onFire = true; await f.body.poll();
  expect(toolText(await waiting)).toContain("lava rescue started");
});

test("old Synapse payload keeps legacy flee and eating, with every new rescue off", async () => {
  const f = await fixture();
  for (const key of ["air", "maxAir", "underwater", "inWater", "inLava", "onFire", "onGround", "fallDistance", "velocity"] as const) delete f.state[key];
  await f.body.poll();
  f.state.health = 18; f.state.food = 8; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0], health: 20 }];
  await f.body.poll(); await f.body.api.state();
  expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", forward: true, sprint: true, ticks: 60 });
  expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  f.state.nearbyEntities = []; f.tick(1000); await f.body.poll();
  expect(f.requests.some(r => r.body.action === "use" && r.body.ticks === 40)).toBe(true);
  f.tick(2200); await f.body.poll();
  const events = f.body.events.consume();
  const status = toolText(await f.tools.call("status"));
  expect(status.match(/Survival senses unavailable/g)).toHaveLength(1);
  expect(status).toContain("surface off"); expect(status).toContain("fire/lava rescue off"); expect(status).toContain("legacy flee remains active");
  expect(events).not.toContain("rescue started"); expect(events).toContain("ate minecraft:bread");
});

test("status shows air and burning/lava, and new rescues can be disabled", async () => {
  const f = await fixture();
  const configured = toolText(await f.tools.call("set_reflexes", { surface: false, escape_fire: false, avoid_creepers: false }));
  expect(configured).toContain("surface=false"); expect(configured).toContain("escape_fire=false"); expect(configured).toContain("avoid_creepers=false");
  Object.assign(f.state, { underwater: true, air: 20, maxAir: 300, onFire: true, inLava: true });
  await f.body.poll(); expect(f.requests.some(r => r.body.text === "#pause" || r.body.action === "move")).toBe(false);
  const status = toolText(await f.tools.call("status"));
  expect(status).toContain("Air 20/300"); expect(status).toContain("Hazard: burning, in lava");
});

const chats = (f: Fixture, from = 0) => f.requests.slice(from).filter(r => r.path === "/chat").map(r => r.body.text);
async function startDrowning(f: Fixture, air = 40) {
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
}
/** Under water with air just below half, then three seconds later the head is out and the air is back. */
async function breath(f: Fixture) {
  await startDrowning(f, 148);
  Object.assign(f.state, { underwater: false, air: 300 });
  f.tick(3000); await f.body.poll();
  return f.body.events.consume();
}
async function lavaDip(f: Fixture) {
  Object.assign(f.state, { inLava: true, onFire: true, onGround: false }); await f.body.poll(); await f.body.api.state();
  Object.assign(f.state, { inLava: false, onFire: false, onGround: true }); f.tick(1000); await f.body.poll();
}
async function reachDryGround(f: Fixture, x: number, y: number, z: number) {
  moveTo(f, x, y, z); Object.assign(f.state, { underwater: false, inWater: false, onGround: true, air: 300 });
  f.tick(1000); await f.body.poll();
}
/** Give a navigation command and let four seconds pass without movement. */
async function stall(f: Fixture, tool: "go_to" | "mine", args: object) {
  await f.tools.call(tool, args); f.tick(4000); await f.body.poll();
  return f.body.events.consume();
}

test("death report gives the last living block and dimension, and hands the death to a recorder", async () => {
  const f = await fixture(); const recorded: unknown[] = []; f.body.onDeath = death => { recorded.push(death); };
  moveTo(f, 104.7, 63, -91.3); f.state.dimension = "minecraft:the_nether"; await f.body.poll();
  // The body is knocked on before the death is seen; the drop is reported where he last stood alive.
  f.tick(5000); moveTo(f, 106.2, 60.4, -93.5); f.state.health = 0; await f.body.poll();
  expect(f.body.events.consume()).toContain("died at=104,63,-92 dimension=minecraft:the_nether text=what you carried dropped there; items last about five minutes");
  expect(f.body.lastDeath).toEqual({ pos: { x: 104, y: 63, z: -92 }, dimension: "minecraft:the_nether", at: 5000 });
  expect(recorded).toEqual([f.body.lastDeath]);
  await f.body.poll();
  expect(f.body.events.consume()).not.toContain("died");
  expect(recorded).toHaveLength(1);
});

test("a death recorder that fails is reported and does not keep held keys down", async () => {
  const f = await fixture(); f.body.onDeath = () => { throw new Error("disk full"); };
  await startFight(f);
  const start = f.requests.length;
  f.state.health = 0; await f.body.poll();
  const events = f.body.events.consume();
  expect(events).toContain("died at=0,64,0 dimension=minecraft:overworld");
  expect(events).toContain("death not recorded: disk full");
  expect(f.requests.slice(start).some(r => r.body.action === "release")).toBe(true);
  expect(f.body.error).toBeUndefined();
});

test("A13 a breath during a go_to holds the head up until the air is back, then resumes the same trip", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  moveTo(f, 30, 62, -40); await startDrowning(f, 148);
  f.body.events.consume();
  // Head out, air still short of 80%: he is held up where he is, not sent back to the shore crumb at 0,0.
  Object.assign(f.state, { underwater: false, air: 239 });
  f.tick(1000); await f.body.poll(); await f.body.api.state();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause"]);
  expect(f.body.events.consume()).not.toContain("surface rescue ended");
  const moves = f.requests.filter(r => r.body.action === "move").map(r => r.body);
  expect(moves).toHaveLength(2);
  for (const move of moves) expect(move).toEqual({ action: "move", jump: true, ticks: 5 });
  expect(f.requests.some(r => r.body.action === "look")).toBe(false);
  f.state.air = 240; f.tick(2400); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#resume"]);
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.body.navigation?.description).toBe("goto 400 -621");
  const events = f.body.events.consume();
  expect(events).toContain("surface rescue ended after 3.4 s: took a breath, air 148 -> 240; trip resumed");
  expect(events).not.toContain("navigation_stopped");
  // The stall timer starts over at the resume: 3.4 s of standing still for air is not a stop-short.
  f.tick(3999); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("stopped_short");
  f.tick(1); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=688.8");
});

test("A13 breaths that come with 8 blocks of progress keep the trip; three that do not stop it", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 100, z: 0 });
  for (const x of [0, 5, 9]) { // 9 blocks closer over three breaths
    moveTo(f, x, 62, 0);
    const events = await breath(f);
    expect(events).toContain("trip resumed"); expect(events).not.toContain("navigation_stopped");
  }
  expect(chats(f)).toEqual([...walkPreamble, "#goto 100 0", "#pause", "#resume", "#pause", "#resume", "#pause", "#resume"]);
  expect(f.body.navigation?.description).toBe("goto 100 0");
  moveTo(f, 12, 62, 0); // the last three breaths were at 5, 9 and 12: 7 blocks
  const events = await breath(f);
  expect(events).toContain("surface rescue ended after 3 s: took a breath, air 148 -> 300");
  expect(events).not.toContain("trip resumed");
  expect(events).toContain("navigation_stopped goal=goto 100 0 reason=needed air 3 times in 2 minutes and got only 7 closer you=12,62,0 remaining=88");
  expect(chats(f)).toEqual([...walkPreamble, "#goto 100 0", "#pause", "#resume", "#pause", "#resume", "#pause", "#resume", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
});

test("A13 the third breath in two minutes with no progress stops the go_to; the next go_to starts a fresh count", async () => {
  const f = await fixture(); await f.body.poll();
  moveTo(f, 3.5, 62.4, 0.5);
  await f.tools.call("go_to", { x: 27, z: 0 });
  expect(await breath(f)).toContain("trip resumed");
  expect(await breath(f)).toContain("trip resumed");
  const third = await breath(f);
  expect(third).toContain("navigation_stopped goal=goto 27 0 reason=needed air 3 times in 2 minutes and got no closer you=3,62,0 remaining=23.5");
  expect(third).not.toContain("times=");
  expect(chats(f)).toEqual([...walkPreamble, "#goto 27 0", "#pause", "#resume", "#pause", "#resume", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("stopped_short");
  await f.tools.call("go_to", { x: 27, z: 0 });
  const restarted = f.requests.length;
  for (let i = 0; i < 2; i++) {
    const events = await breath(f);
    expect(events).toContain("trip resumed"); expect(events).not.toContain("navigation_stopped");
  }
  expect(f.body.navigation?.description).toBe("goto 27 0");
  expect(await breath(f)).toContain("reason=needed air 3 times in 2 minutes and got no closer you=3,62,0 remaining=23.5 times=2 in ten minutes");
  expect(chats(f, restarted)).toEqual(["#pause", "#resume", "#pause", "#resume", "#pause", "#stop", ...restoreTripSettings]);
});

test("A13 explore is stopped on the third breath within two minutes; older breaths do not count", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("explore");
  expect(chats(f)).toEqual([...walkPreamble, "#explore"]);
  const started = f.requests.length;
  expect(await breath(f)).toContain("trip resumed");
  expect(await breath(f)).toContain("trip resumed");
  f.tick(121_000); moveTo(f, 40, 62, 0); // still swimming; the first two breaths are now too old
  expect(await breath(f)).toContain("trip resumed");
  expect(await breath(f)).toContain("trip resumed");
  expect(chats(f, started)).not.toContain("#stop");
  const events = await breath(f);
  expect(events).toContain("navigation_stopped goal=explore reason=needed air 3 times in 2 minutes; no destination to measure progress by you=40,62,0");
  expect(events).not.toContain("remaining=");
  expect(chats(f).filter(text => text === "#resume")).toHaveLength(4);
  expect(chats(f, started)).toEqual(["#pause", "#resume", "#pause", "#resume", "#pause", "#resume", "#pause", "#resume", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
});

test("A13 a breath that cannot get the head out in 12 s stops the trip, and the shore rescue takes over", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  // Past six seconds a rescue without a trip turns for the shore crumb; a breath only goes up.
  f.state.air = 38; f.tick(6500); await f.body.poll(); await f.body.api.state();
  expect(f.requests.filter(r => r.body.action === "move").at(-1)?.body).toEqual({ action: "move", jump: true, ticks: 5 });
  expect(f.requests.some(r => r.body.action === "look")).toBe(false);
  f.state.air = 35; f.tick(5500); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
  let events = f.body.events.consume();
  expect(events).toContain("surface rescue ended after 12 s: timed out, air 40 -> 35");
  expect(events).toContain("navigation_stopped goal=goto 400 -621 reason=could not keep your head above water for 12 s (air 35/300) you=0,64,0 remaining=738.7");
  const stopped = f.requests.length;
  await f.body.poll(); await f.body.api.state();
  events = f.body.events.consume();
  expect(events).toContain("surface rescue started: air 35/300");
  expect(chats(f, stopped)).toEqual(["#pause"]);
  f.tick(6000); await f.body.poll(); await f.body.api.state();
  expect(f.requests.filter(r => r.body.action === "move").at(-1)?.body).toEqual({ action: "move", forward: true, jump: true, ticks: 5 });
});

test("A13 with the trip already reported as stopped short, the rescue makes for the shore and stops Baritone", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 50, z: 0 });
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=50");
  moveTo(f, 3, 62, 0); await startDrowning(f);
  Object.assign(f.state, { underwater: false, air: 300 });
  f.tick(600); await f.body.poll(); await f.body.api.state();
  // Air is back, but with no trip under way he is not left floating: he swims for the crumb at 0,0.
  expect(f.body.events.consume()).not.toContain("surface rescue ended");
  expect(f.requests.filter(r => r.body.action === "move").at(-1)?.body).toEqual({ action: "move", forward: true, jump: true, ticks: 5 });
  expect(f.requests.filter(r => r.body.action === "look").at(-1)?.body.yaw as number).toBeCloseTo(90);
  moveTo(f, 0.5, 64, 0); Object.assign(f.state, { inWater: false, onGround: true });
  f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 50 0", "#proc", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("out of the water after 1.6 s, air 40 -> 300");
  expect(events).toContain("navigation_stopped goal=goto 50 0 reason=the path led into deep water you=0,64,0 remaining=49.5");
  expect(toolText(await f.tools.call("status"))).toContain("Navigation: none");
});

test("A13 a tool call during a breath leaves the rescue in control; explicit stop sends one cancellation", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f, 148);
  const rescuing = f.requests.length;
  const looked = await f.tools.call("look", { yaw: 10, pitch: 0 });
  expect(looked.isError).toBe(true);
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause"]);
  expect(f.requests.slice(rescuing).some(r => r.body.action === "look")).toBe(false);
  expect(f.body.rescuing).toBe("surface");
  expect(f.body.navigation?.description).toBe("goto 400 -621");
  const events = toolText(looked);
  expect(events).toContain("coming up for air (air 148/300) and keeps the controls until it is out");
  expect(events).not.toContain("surface rescue ended");
  expect(events).not.toContain("navigation_stopped");
  // The same breath continues: no extra pause, resume or cancellation from the rejected look.
  await f.body.poll(); await f.body.api.state();
  expect(chats(f, rescuing)).toEqual([]);
  expect(f.body.rescuing).toBe("surface");
  const result = await f.tools.call("stop");
  expect(toolText(result)).toContain("Stopped navigation and released keys.");
  expect(result.isError).toBe(false);
  expect(toolText(result)).toContain("ended by your stop; still under water, air 148/300");
  expect(toolText(result)).not.toContain("navigation_stopped");
  expect(chats(f, rescuing)).toEqual(["#resume", "#stop", ...restoreTripSettings]);
  expect(f.body.rescuing).toBeUndefined();
  expect(f.baritone).toEqual({ active: false, paused: false });
  expect(f.body.navigation).toBeUndefined();
});

test("A12 lava taking over from a breath stops the trip once and leaves Baritone unpaused", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f, 148);
  Object.assign(f.state, { inLava: true, onFire: true }); f.tick(500); await f.body.poll(); await f.body.api.state();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#stop", "#pause", ...restoreTripSettings]);
  const lava = f.requests.length;
  expect(f.body.navigation).toBeUndefined();
  Object.assign(f.state, { inLava: false, onFire: false, underwater: false, inWater: false, onGround: true, air: 300 });
  f.tick(1000); await f.body.poll();
  expect(chats(f, lava)).toEqual(["#resume"]);
  expect(f.baritone).toEqual({ active: false, paused: false });
  const events = f.body.events.consume();
  expect(events).toContain("surface rescue ended after 0.5 s: superseded by lava");
  expect(events.match(/navigation_stopped/g)).toHaveLength(1);
});

test("A12 the second lava rescue on one goal within ten minutes says so; other goals and later rescues count afresh", async () => {
  const f = await fixture(); await f.body.poll();
  const rescued = async (goal: { x: number; z: number }) => {
    await f.tools.call("go_to", goal);
    const started = f.requests.length;
    await lavaDip(f);
    expect(chats(f, started)).toEqual(["#pause", "#stop", ...restoreTripSettings]);
    return f.body.events.consume();
  };
  expect(await rescued({ x: 400, z: -621 })).not.toContain("times=");
  f.tick(60_000);
  expect(await rescued({ x: 400, z: -621 })).toContain("navigation_stopped goal=goto 400 -621 reason=the path led into lava you=0,64,0 remaining=738.7 times=2 in ten minutes");
  expect(await rescued({ x: 50, z: 0 })).not.toContain("times=");
  f.tick(600_000);
  const later = await rescued({ x: 400, z: -621 });
  expect(later).toContain("navigation_stopped goal=goto 400 -621"); expect(later).not.toContain("times=");
  expect(chats(f)).not.toContain("#resume");
});

test("A12 a mine command that led into lava is stopped; no distance is given without a destination", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("mine", { block: "iron_ore" });
  moveTo(f, 2, 63.5, 0); Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
  await f.body.poll(); await f.body.api.state();
  moveTo(f, -3.4, 64, 0.2); Object.assign(f.state, { inLava: false, onFire: false, onGround: true });
  f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual(["#mine minecraft:iron_ore", "#pause", "#stop"]);
  expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("navigation_stopped goal=mine minecraft:iron_ore reason=the path led into lava you=-4,64,0");
  expect(events).not.toContain("remaining=");
});

test("A23 a retreat during a go_to still pauses and resumes the same navigation", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 2, pos: [2, 64, 0], health: 20, fuse: true }];
  f.tick(1000); await f.body.poll(); await f.body.api.state();
  f.state.nearbyEntities = [{ id: 7, type: "minecraft:creeper", hostile: true, distance: 12, pos: [12, 64, 0], health: 20 }];
  f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#resume"]);
  expect(f.body.navigation?.description).toBe("goto 400 -621");
  const events = f.body.events.consume();
  expect(events).toContain("retreat rescue ended"); expect(events).not.toContain("navigation_stopped");
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=738.7");
});

test("A13 death during a breath on a go_to stops Baritone once and never resumes it", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  f.state.health = 0; f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("died at=0,64,0");
  expect(events).toContain("navigation_stopped goal=goto 400 -621 reason=the path led into deep water and you died there");
  expect(events).not.toContain("you="); expect(events).not.toContain("remaining=");
  f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#stop", ...restoreTripSettings]);
});

test("A13 a go_to given during a breath is a new trip: it is resumed, and the breath is not counted against it", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  await f.tools.call("go_to", { x: -30, z: 8 });
  await reachDryGround(f, 1, 64, 1);
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#goto -30 8", "#pause", "#resume"]);
  expect(f.body.navigation?.description).toBe("goto -30 8");
  const events = f.body.events.consume();
  expect(events).toContain("took a breath, air 40 -> 300; trip resumed"); expect(events).not.toContain("navigation_stopped");
  // Had that breath counted, the second of these would be the third; the new trip gets its own three.
  expect(await breath(f)).toContain("trip resumed");
  expect(await breath(f)).toContain("trip resumed");
  expect(await breath(f)).toContain("navigation_stopped goal=goto -30 8 reason=needed air 3 times in 2 minutes and got no closer");
});

test("A13 shutdown during a rescue on a go_to sends one stop and no resume", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  await f.body.close();
  expect(chats(f)).toEqual([...walkPreamble, "#goto 400 -621", "#pause", "#stop", ...restoreTripSettings]);
});

test("a wait for arrival wakes when a rescue stops the navigation instead", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  f.body.events.consume();
  const waiting = f.tools.call("wait", { seconds: 2, for: ["arrived", "stopped_short"] });
  await lavaDip(f);
  const text = toolText(await waiting);
  expect(text).toContain("Waking event received."); expect(text).toContain("navigation_stopped goal=goto 400 -621");
});

test("the third stop-short of one destination from one place says so, and an arrival starts the count over", async () => {
  const f = await fixture(); const goal = { x: 50, z: 0 };
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 mode=walk-only baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 mode=walk-only baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 attempts=3 text=same destination has stopped short 3 times from about here mode=walk-only baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 attempts=4 text=same destination has stopped short 4 times from about here mode=walk-only baritone=");
  await f.tools.call("go_to", goal); moveTo(f, 49, 64, 0); await f.body.poll();
  expect(f.body.events.consume()).toContain("arrived goal=goto 50 0");
  moveTo(f, 0, 64, 0);
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).toContain("attempts=3");
});

test("the stop-short count ends with a start more than 8 blocks away or with another goal", async () => {
  const f = await fixture(); const goal = { x: 50, z: 0 };
  await stall(f, "go_to", goal); await stall(f, "go_to", goal);
  moveTo(f, 6, 64, 5); // 7.8 blocks across the ground from the previous start
  expect(await stall(f, "go_to", goal)).toContain("attempts=3");
  moveTo(f, 6, 64, 14); // 9 blocks from the previous start
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", { x: 50, z: 1 })).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).not.toContain("attempts=");
  expect(await stall(f, "go_to", goal)).toContain("attempts=3");
});

test("a mine command ending three times from one place is counted without naming a destination", async () => {
  const f = await fixture(); const args = { block: "oak_log", count: 3 };
  expect(await stall(f, "mine", args)).not.toContain("attempts=");
  expect(await stall(f, "mine", args)).not.toContain("attempts=");
  expect(await stall(f, "mine", args)).toContain("stopped_short distance=unknown (no fixed destination) attempts=3 text=same command has ended 3 times from about here baritone=");
});

const craftingTable = { type: "block", block: "minecraft:crafting_table", blockPos: [1, 64, 1] };
const guiActions = (f: Fixture, from = 0) => f.requests.slice(from).filter(r => r.path === "/gui" && r.body.action !== undefined);
const mealUses = (f: Fixture) => f.requests.filter(r => r.body.action === "use" && r.body.ticks === 40);

test("I01 a meal straight after a fight, the trip resumed and a crafting table in the sights, eats without opening it", async () => {
  // Baritone turns the view back to its work on every tick it is not paused; anything but straight up opens the table.
  const f = await fakeFixture({ rotation: { yaw: 73, pitch: 10 }, selectedSlot: 4, interactable: true, steering: { yaw: 120, pitch: 35 } });
  f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }, { slot: 2, item: "minecraft:iron_sword", count: 1 }];
  f.state.food = 15; f.state.lookingAt = craftingTable;
  await f.tools.call("mine", { block: "minecraft:stone" }); await f.body.poll();
  f.state.health = 10.5;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:skeleton", hostile: true, distance: 2, pos: [0, 64, 2], health: 20 }];
  await f.body.poll();
  expect(f.baritone.paused).toBe(true);
  // The skeleton backs off: the fight ends and the trip goes on, a moment before the meal the wounds call for.
  f.state.nearbyEntities = []; f.tick(1000); await f.body.poll();
  expect(f.baritone).toEqual({ active: true, paused: false });
  await f.body.poll();
  expect(mealUses(f)).toHaveLength(1);
  expect(f.state.screen).toBe("none");
  expect(f.baritone.paused).toBe(true);
  f.tick(2200); await f.body.poll();
  const events = f.body.events.consume();
  expect(events).toContain("ate minecraft:bread, food 15 -> 20");
  expect(events).not.toContain("Meal opened"); expect(events).not.toContain("stopped_short");
  expect(guiActions(f)).toHaveLength(0);
  // The trip is a mine job: once it is going again the body asks Baritone where it is heading (#proc).
  expect(chats(f)).toEqual(["#mine minecraft:stone", "#pause", "#resume", "#proc", "#pause", "#resume"]);
  expect(f.state.selectedSlot).toBe(4);
});

test("I01 a meal whose view will not stay up uses nothing and says why, for the reflex and for eat", async () => {
  // A command Baritone still has from before a toolserver restart: the body knows of no trip to pause.
  const f = await fakeFixture({ rotation: { yaw: 73, pitch: 10 }, selectedSlot: 4, interactable: true, steering: { yaw: 120, pitch: 35 }, baritoneBusy: true });
  f.state.food = 8; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }]; f.state.lookingAt = craftingTable;
  await f.body.poll();
  expect(f.body.events.consume()).toContain("reflex text=Meal not started: The view did not stay straight up (pitch 35); something else is turning it. Nothing was used. Auto-eat retries in 10 s.");
  expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  expect(f.state.screen).toBe("none"); expect(f.state.selectedSlot).toBe(4); expect(f.body.error).toBeUndefined();
  f.tick(9999); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("Meal not started");
  f.tick(1); await f.body.poll();
  expect(f.body.events.consume()).toContain("Meal not started");
  const manual = await f.tools.call("eat");
  expect(manual.isError).toBe(true);
  expect(toolText(manual)).toContain("Error: The view did not stay straight up (pitch 35); something else is turning it. Nothing was used.");
  expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  expect(f.state.food).toBe(8);
});

test("I01 a meal is not started under a block that the held use would open; under plain stone it is", async () => {
  const f = await fakeFixture({ selectedSlot: 4, overhead: { type: "block", block: "minecraft:oak_trapdoor", blockPos: [0, 66, 0] } });
  f.state.food = 8; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
  await f.body.poll();
  expect(f.body.events.consume()).toContain("Meal not started: minecraft:oak_trapdoor is directly overhead and the meal would use it instead. Nothing was used. Auto-eat retries in 10 s.");
  expect(mealUses(f)).toHaveLength(0); expect(f.state.selectedSlot).toBe(4);
  f.options.overhead = { type: "block", block: "minecraft:stone", blockPos: [0, 66, 0] };
  f.tick(10000); await f.body.poll(); f.tick(2200); await f.body.poll();
  expect(f.body.events.consume()).toContain("ate minecraft:bread, food 8 -> 14");
});

test("a meal's own pause of the trip is not reported as the trip stopping", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 });
  f.tick(3000); await startMeal(f);
  expect(f.baritone.paused).toBe(true);
  f.tick(2200); await f.body.poll();
  const events = f.body.events.consume();
  expect(events).toContain("ate minecraft:bread, food 8 -> 14"); expect(events).not.toContain("stopped_short");
  expect(f.baritone.paused).toBe(false);
  // A trip that then really stands still is still reported.
  f.tick(4000); await f.body.poll(); f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=20");
});

test("I06 death during a meal clicks nothing and closes nothing, and the meal is not blamed for the death screen", async () => {
  const f = await fixture(); await startMeal(f);
  const start = f.requests.length;
  f.state.health = 0; f.setScreen({ screen: "DeathScreen" });
  for (let poll = 0; poll < 3; poll++) { f.tick(500); await f.body.poll(); }
  const events = f.body.events.consume();
  expect(events).toContain("died at=0,64,0");
  expect(events).not.toContain("Meal"); expect(events).not.toContain("DeathScreen"); expect(events).not.toContain("reflex");
  expect(guiActions(f, start)).toHaveLength(0);
  const actions = f.requests.slice(start).filter(r => r.path === "/player").map(r => r.body.action);
  expect(actions).toContain("release");
  expect(actions.some(action => action === "use" || action === "attack" || action === "move")).toBe(false);
  expect(f.state.screen).toBe("DeathScreen"); expect(f.body.error).toBeUndefined();
  const meal = await f.tools.call("eat");
  expect(toolText(meal)).toContain("Error: You are dead; nothing was eaten.");
  expect(guiActions(f, start)).toHaveLength(0);
});

test("I06 a death the state has not shown yet starts no meal and says nothing about the death screen", async () => {
  const f = await fixture(); f.state.food = 8; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
  // He died between the two reads: the screen is up, the polled state still shows him alive with none open.
  f.setScreen({ screen: "DeathScreen" }); f.state.screen = "none";
  await f.body.poll(); f.tick(500); await f.body.poll();
  expect(f.body.events.consume()).toBe("Since last time:\nnone");
  expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  expect(guiActions(f)).toHaveLength(0); expect(f.body.error).toBeUndefined();
});

test("N04 death ends the trip at once: Baritone is stopped, no stop-short follows, and no trip starts while dead", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 }); await startMeal(f);
  expect(f.baritone).toEqual({ active: true, paused: true });
  const start = f.requests.length;
  f.state.health = 0; f.setScreen({ screen: "DeathScreen" }); f.tick(500); await f.body.poll();
  expect(f.baritone).toEqual({ active: false, paused: false });
  expect(chats(f)).toEqual([...walkPreamble, "#goto 20 0", "#pause", "#stop", ...restoreTripSettings]);
  expect(f.body.navigation).toBeUndefined();
  f.tick(4000); await f.body.poll();
  const events = f.body.events.consume();
  expect(events).toContain("navigation_stopped goal=goto 20 0 reason=you died");
  expect(events).not.toContain("stopped_short"); expect(events).not.toContain("Meal");
  expect(guiActions(f, start)).toHaveLength(0);
  const trip = await f.tools.call("go_to", { x: 5, z: 0 });
  expect(trip.isError).toBe(true);
  expect(toolText(trip)).toContain("Error: You are dead; no trip can start before you respawn.");
  expect(chats(f)).toEqual([...walkPreamble, "#goto 20 0", "#pause", "#stop", ...restoreTripSettings]);
});

test("a wait for arrival wakes when death ends the trip", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 }); await f.body.poll();
  f.body.events.consume();
  const waiting = f.tools.call("wait", { seconds: 2, for: ["arrived", "stopped_short"] });
  f.state.health = 0; await f.body.poll();
  expect(toolText(await waiting)).toContain("navigation_stopped goal=goto 20 0 reason=you died");
});

test("following a player who stands still is arrival within Baritone's three blocks, and a real gap still stops short", async () => {
  const player = (x: number) => [{ id: 3, type: "minecraft:player", name: "Margo", player: true, pos: [x, 64, 0] as [number, number, number], distance: x }];
  const f = await fixture(); await f.body.poll();
  await f.tools.call("follow", { player: "Margo" });
  f.state.nearbyEntities = player(2.7); f.tick(1000); await f.body.poll();
  expect(f.body.events.consume()).toContain("arrived goal=follow player Margo distance=2.7");
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("stopped_short");
  const far = await fixture(); await far.body.poll();
  await far.tools.call("follow", { player: "Margo" });
  far.state.nearbyEntities = player(8.4); far.tick(1000); await far.body.poll(); far.tick(3000); await far.body.poll();
  const events = far.body.events.consume();
  expect(events).toContain("stopped_short distance=8.4"); expect(events).not.toContain("arrived");
});

test("a stop short of a goal with a height says how far across and how far above or below the goal is", async () => {
  const f = await fixture(); moveTo(f, 50.5, 117, -189.5);
  expect(await stall(f, "go_to", { x: 50, y: 120, z: -190 })).toContain("stopped_short distance=3.1 across=0.7 height=goal is 3 above you mode=walk-only baritone=");
  expect(await stall(f, "go_to", { x: 50, y: 112, z: -190 })).toContain("stopped_short distance=5 across=0.7 height=goal is 5 below you mode=walk-only baritone=");
  expect(await stall(f, "go_to", { x: 60, y: 117, z: -190 })).toContain("stopped_short distance=9.5 across=9.5 height=goal is level with you mode=walk-only baritone=");
  expect(await stall(f, "go_to", { x: 60, z: -190 })).toContain("stopped_short distance=9.5 mode=walk-only baritone=");
});

test("Baritone's Paused and Resumed, answers to the body's own reflexes, take no event line and do not replace its last word on the trip", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 50, z: 0 });
  await appendFile(f.log, "[CHAT] [Baritone] Going to: GoalXZ{x=50,z=0}\n[CHAT] [Baritone] Paused\n[CHAT] [Baritone] Resumed\n");
  await f.body.poll();
  expect(f.body.events.consume()).toBe("Since last time:\n1 baritone text=Going to: GoalXZ{x=50,z=0}");
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=50 mode=walk-only baritone=Going to: GoalXZ{x=50,z=0}");
});

test("breaking blocks from one spot is work, not a stop, until 30 s have passed in one place", async () => {
  const f = await fixture(); await f.tools.call("mine", { block: "oak_log" });
  const chop = async (log: number) => {
    // Three seconds a log by hand; when it breaks, the next one up the trunk is in the sights.
    f.state.lookingAt = { type: "block", block: "minecraft:oak_log", blockPos: [1, 64 + log, 0] };
    f.tick(3000); await f.body.poll();
  };
  for (let log = 0; log < 9; log++) await chop(log);
  expect(f.body.events.consume()).not.toContain("stopped_short");
  await chop(9);
  expect(f.body.events.consume()).toContain("stopped_short distance=unknown (no fixed destination)");
  // With nothing turning and nothing breaking, four seconds are still a stop.
  await f.tools.call("mine", { block: "oak_log" }); f.tick(3999); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("stopped_short");
  f.tick(1); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short");
});

const chatLine = (label: string) => `${label} ${"word ".repeat(60)}`.slice(0, 250) + ` end${label}`.padEnd(6, ".");

test("a full 256-character chat line reaches the resident whole", async () => {
  const f = await fixture(); const said = chatLine("a1");
  expect(said).toHaveLength(256);
  await appendFile(f.log, `[12:10:00] [Render thread/INFO]: [CHAT] <Margo_Longname16> ${said}\n`);
  await f.body.poll();
  const text = toolText(await f.tools.call("status"));
  expect(text).toContain(`chat from=Margo_Longname16 text=${said}`);
  expect(text.length).toBeLessThan(1500);
});

test("more long chat than a tool result holds drops the oldest lines whole, counted, and cuts none", async () => {
  const f = await fixture(); const said = ["b1", "b2", "b3", "b4", "b5", "b6"].map(chatLine);
  await appendFile(f.log, said.map(line => `[CHAT] <Margo> ${line}\n`).join(""));
  await f.body.poll();
  const text = toolText(await f.tools.call("status"));
  expect(text.length).toBeLessThan(1500);
  expect(text).toContain("Position 0, 64, 0"); expect(text).toContain("Screen: none");
  expect(text).toContain("Since last time: (3 older dropped)");
  const shown = text.split("\n").filter(line => line.includes(" chat from=Margo "));
  expect(shown).toEqual(said.slice(3).map((line, index) => `${index + 4} chat from=Margo text=${line}`));
  // The dropped lines are gone for good, as the count said; nothing is shown twice.
  expect(toolText(await f.tools.call("status"))).toContain("Since last time:\nnone");
});

const carry = (f: Fixture, items: Record<string, number>) => { f.state.inventory!.main = Object.entries(items).map(([item, count], slot) => ({ slot, item, count })); };
const lift = "#set avoidBreakingMultiplier 1", keep = "#set avoidBreakingMultiplier 0.01";
/** A client whose Baritone avoids breaking chests, as its settings file says. */
const avoidingChests = () => fakeFixture({ baritoneSettings: "avoidBreakingMultiplier 0.01\nblocksToAvoidBreaking chest,furnace\n" });

test("R09 a mine count is not reached by other pickups: stone is counted in cobblestone, whatever else came in", async () => {
  const f = await fixture(); carry(f, { "minecraft:cobblestone": 10 });
  await f.tools.call("mine", { block: "stone", count: 2 });
  // Seven items came in on the way, and one of them is what stone drops.
  f.tick(1000); carry(f, { "minecraft:cobblestone": 11, "minecraft:flint": 1, "minecraft:dirt": 3, "minecraft:wheat_seeds": 2 }); await f.body.poll();
  expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).not.toContain("arrived");
  f.tick(1000); carry(f, { "minecraft:cobblestone": 12, "minecraft:flint": 1, "minecraft:dirt": 3, "minecraft:wheat_seeds": 2 }); await f.body.poll();
  expect(f.baritone.active).toBe(false);
  expect(f.body.events.consume()).toBe("Since last time:\n1 arrived goal=mine 2 minecraft:stone collected=2 x minecraft:cobblestone, 1 x minecraft:flint, 3 x minecraft:dirt and 1 more kinds");
});

test("R09 a mine count is exact: what the block drops in vanilla and the block's own item, together", async () => {
  const f = await fixture();
  await f.tools.call("mine", { block: "deepslate_iron_ore", count: 3 });
  f.tick(1000); carry(f, { "minecraft:cobbled_deepslate": 40, "minecraft:raw_iron": 2 }); await f.body.poll();
  expect(f.baritone.active).toBe(true);
  // The third comes in as the block itself, as under Silk Touch.
  f.tick(1000); carry(f, { "minecraft:cobbled_deepslate": 40, "minecraft:raw_iron": 2, "minecraft:deepslate_iron_ore": 1 }); await f.body.poll();
  expect(f.baritone.active).toBe(false);
  expect(f.body.events.consume()).toContain("arrived goal=mine 3 minecraft:deepslate_iron_ore collected=2 x minecraft:raw_iron, 1 x minecraft:deepslate_iron_ore, 40 x minecraft:cobbled_deepslate");
});

test("R09 a block whose drop is not known is counted by its own item alone, and the end of the job says so", async () => {
  const f = await fakeFixture({ mineTargets: [[3, 64, 0]] });
  await f.tools.call("mine", { block: "create:zinc_ore", count: 2, radius: 8 });
  // Five raw zinc is very likely what it dropped, and nothing here knows that: the count stays at none.
  f.tick(500); carry(f, { "create:raw_zinc": 5, "minecraft:cobblestone": 9 }); await f.body.poll(); await f.body.poll();
  expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).toBe("Since last time:\nnone");
  // The job is still bounded: the next one Baritone knows is 40 blocks off, and the radius ends it.
  f.options.mineTargets = [[40, 64, 0]];
  f.tick(3000); await f.body.poll(); await f.body.poll();
  expect(f.baritone.active).toBe(false);
  expect(f.body.events.consume()).toBe("Since last time:\n1 navigation_stopped goal=mine 2 create:zinc_ore collected=5 x create:raw_zinc, 9 x minecraft:cobblestone counted=0 of 2 (only create:zinc_ore itself is counted; what it drops is not known) reason=no create:zinc_ore left within 8 blocks of where you started (0,64,0) nearest=40,64,0, 40 blocks from where you started you=0,64,0");
});

test("N08 a mine job carried past its radius before Baritone said anything claims nothing about what is left", async () => {
  const f = await fixture(); await f.tools.call("mine", { block: "stone", radius: 5 });
  moveTo(f, 6, 64, 0); await f.body.poll();
  expect(f.baritone.active).toBe(false); expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("navigation_stopped goal=mine minecraft:stone collected=nothing reason=you were more than 5 blocks from where you started (0,64,0) before Baritone said where it was heading; whether any minecraft:stone is left near there is not known you=6,64,0");
  expect(events).not.toContain("left within");
});

test("S05 Baritone ending a mine job itself puts the breaking cost back without a stall report; one early no-process answer does not", async () => {
  const f = await avoidingChests(); await f.tools.call("mine", { block: "chest", radius: 8 });
  expect(chats(f)).toEqual([lift, "#mine minecraft:chest"]);
  // Asked before the job's first tick, Baritone has no process in control yet.
  f.baritone.active = false; f.tick(500); await f.body.poll();
  f.baritone.active = true; await f.body.poll();
  // Asked again half a second later it has: the job is still watched, its cost still lifted.
  f.tick(500); moveTo(f, 1, 64, 0); await f.body.poll(); await f.body.poll();
  expect(chats(f)).toEqual([lift, "#mine minecraft:chest", "#proc", "#proc"]);
  // Now Baritone gives the job up. He walks on, so no stall is reported; its second answer ends the watch and the cost.
  f.baritone.active = false;
  f.tick(3000); moveTo(f, 2, 64, 0); await f.body.poll();
  f.tick(250); moveTo(f, 3, 64, 0); await f.body.poll();
  expect(chats(f)).not.toContain(keep);
  f.tick(500); moveTo(f, 4, 64, 0); await f.body.poll();
  f.tick(250); moveTo(f, 5, 64, 0); await f.body.poll();
  expect(chats(f)).toEqual([lift, "#mine minecraft:chest", "#proc", "#proc", "#proc", "#proc", keep]);
  // Where he goes afterwards is his own business: nothing more is asked, stopped or set.
  for (let step = 0; step < 6; step++) { f.tick(1000); moveTo(f, 10 + step * 5, 64, 0); await f.body.poll(); }
  expect(chats(f)).toHaveLength(7);
  const events = f.body.events.consume();
  expect(events).not.toContain("stopped_short"); expect(events).not.toContain("No process in control");
});

test("S05 a stall report on a mine job Baritone is still working leaves its breaking cost lifted and its radius in force", async () => {
  const f = await avoidingChests(); await f.tools.call("mine", { block: "chest", radius: 8 });
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short");
  // A hard block outlasts the stall clock. Baritone still has the job and cannot finish it at the avoiding cost.
  f.tick(3000); await f.body.poll(); await f.body.poll();
  expect(f.baritone.active).toBe(true); expect(chats(f)).not.toContain(keep);
  // It walks on and out of the radius: stopped there, and only then is the cost put back, once.
  f.tick(1000); moveTo(f, 9, 64, 0); await f.body.poll();
  expect(chats(f).slice(-2)).toEqual(["#stop", keep]); expect(f.baritone.active).toBe(false);
  expect(f.body.events.consume()).toContain("navigation_stopped goal=mine minecraft:chest collected=nothing reason=the way to the next minecraft:chest led more than 8 blocks from where you started (0,64,0) nearest=1,64,0, 1 blocks from where you started you=9,64,0");
  await f.body.poll(); f.tick(3000); await f.body.poll();
  expect(chats(f).filter(sent => sent === keep)).toHaveLength(1);
});

test("N04 death stops a mine job that outlived its stall report, and its breaking cost goes back", async () => {
  const f = await avoidingChests(); await f.body.poll();
  await f.tools.call("mine", { block: "chest" });
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short");
  f.tick(1000); f.state.health = 0; await f.body.poll();
  expect(chats(f).slice(-2)).toEqual(["#stop", keep]); expect(f.baritone.active).toBe(false);
  expect(f.body.navigation).toBeUndefined();
  expect(f.body.events.consume()).toContain("navigation_stopped goal=mine minecraft:chest reason=you died");
});

test.each(["excavate", "walk"] as const)("S05 a trip that could not be sent preserves the mine job unless the mode switch cancelled it (%s)", async mode => {
  const f = await avoidingChests(); await f.tools.call("mine", { block: "chest", radius: 8 });
  const chat = f.body.api.chat.bind(f.body.api);
  f.body.api.chat = text => text.startsWith("#goto") ? Promise.reject(new Error("Synapse did not answer.")) : chat(text);
  expect((await f.tools.call("go_to", { x: 50, z: 0, mode })).isError).toBe(true);
  if (mode === "walk") {
    // A path planned with digging must be cancelled before walk-only settings are applied,
    // even if sending the replacement goal then fails. It must not revive the old mine.
    expect(chats(f)).toEqual([lift, "#mine minecraft:chest", ...walkPreamble, keep]);
    expect(f.body.navigation).toBeUndefined();
    expect(f.baritone).toEqual({ active: false, paused: false });
    const failed = f.requests.length;
    await f.body.poll();
    expect(chats(f, failed)).toEqual(restoreTripSettings);
    moveTo(f, 9, 64, 0); await f.body.poll();
    expect(chats(f, failed)).toEqual(restoreTripSettings);
    expect(f.body.navigation).toBeUndefined();
    expect(f.baritone).toEqual({ active: false, paused: false });
    return;
  }
  // No mode change: the failed send leaves Baritone at the chest, which still needs the cost lifted.
  expect(chats(f)).toEqual([lift, "#mine minecraft:chest", keep]);
  expect(f.body.navigation?.description).toBe("mine minecraft:chest");
  await f.body.poll();
  expect(chats(f).at(-1)).toBe(lift);
  moveTo(f, 9, 64, 0); await f.body.poll();
  expect(chats(f).slice(-2)).toEqual(["#stop", keep]); expect(f.baritone.active).toBe(false);
});
