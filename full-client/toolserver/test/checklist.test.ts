import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture as fakeFixture, type Fixture } from "./fake-synapse.ts";

const fixture = () => fakeFixture({ rotation: { yaw: 73, pitch: 10 }, selectedSlot: 4 });
const toolText = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
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
  expect(f.requests.some(r => r.body.text === "#stop")).toBe(false);
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
  expect(events).toContain("retreat rescue started"); expect(events).toContain("clear of threat");
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

test("A23 direct-away fallback walks and stops as soon as ground is lost", async () => {
  const f = await fixture(); await f.body.poll(); f.state.health = 18;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0], health: 20 }];
  await f.body.poll(); await f.body.api.state();
  expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", forward: true, ticks: 4 });
  f.state.onGround = false; await f.body.poll();
  expect(f.body.events.consume()).toContain("left safe ground; movement stopped");
  expect(f.requests.filter(r => r.body.action === "move")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.action === "release")).toHaveLength(1);
  expect(f.requests.filter(r => r.body.text === "#resume")).toHaveLength(1);
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

const chats = (f: Fixture) => f.requests.filter(r => r.path === "/chat").map(r => r.body.text);
async function startDrowning(f: Fixture) {
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air: 40, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
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

test("A13 a go_to that led into deep water is stopped after the rescue, not resumed", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, y: 60, z: -621 });
  moveTo(f, 387.5, 61, -617.5); await startDrowning(f);
  await reachDryGround(f, 388.3, 64, -617.2);
  expect(chats(f)).toEqual(["#goto 400 60 -621", "#pause", "#stop"]);
  expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("surface rescue ended");
  expect(events).toContain("navigation_stopped goal=goto 400 60 -621 reason=the path led into deep water you=388,64,-618 remaining=12.9");
  expect(events).not.toContain("times=");
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).not.toContain("stopped_short");
  expect(toolText(await f.tools.call("status"))).toContain("Navigation: none");
});

test("A13 the second rescue on one goal within ten minutes says so; other goals and later rescues count afresh", async () => {
  const f = await fixture(); await f.body.poll();
  const rescued = async (goal: { x: number; z: number }) => {
    await f.tools.call("go_to", goal); await startDrowning(f); await reachDryGround(f, 0, 64, 0);
    return f.body.events.consume();
  };
  expect(await rescued({ x: 400, z: -621 })).not.toContain("times=");
  f.tick(60_000);
  expect(await rescued({ x: 400, z: -621 })).toContain("navigation_stopped goal=goto 400 -621 reason=the path led into deep water you=0,64,0 remaining=738.7 times=2 in ten minutes");
  expect(await rescued({ x: 50, z: 0 })).not.toContain("times=");
  f.tick(600_000);
  const later = await rescued({ x: 400, z: -621 });
  expect(later).toContain("navigation_stopped goal=goto 400 -621"); expect(later).not.toContain("times=");
  expect(chats(f).filter(text => text === "#stop")).toHaveLength(4);
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
  expect(chats(f)).toEqual(["#goto 400 -621", "#pause", "#resume"]);
  expect(f.body.navigation?.description).toBe("goto 400 -621");
  const events = f.body.events.consume();
  expect(events).toContain("retreat rescue ended"); expect(events).not.toContain("navigation_stopped");
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short distance=738.7");
});

test("A13 death during a rescue on a go_to stops Baritone once and never resumes it", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  f.state.health = 0; f.tick(1000); await f.body.poll();
  expect(chats(f)).toEqual(["#goto 400 -621", "#pause", "#stop"]);
  expect(f.body.navigation).toBeUndefined();
  const events = f.body.events.consume();
  expect(events).toContain("died at=0,64,0");
  expect(events).toContain("navigation_stopped goal=goto 400 -621 reason=the path led into deep water and you died there");
  expect(events).not.toContain("you="); expect(events).not.toContain("remaining=");
  f.tick(1000); await f.body.poll();
  expect(chats(f)).toHaveLength(3);
});

test("A13 a go_to given during the rescue is a new path and is resumed, not stopped", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  await f.tools.call("go_to", { x: -30, z: 8 });
  await reachDryGround(f, 1, 64, 1);
  expect(chats(f)).toEqual(["#goto 400 -621", "#pause", "#goto -30 8", "#pause", "#resume"]);
  expect(f.body.navigation?.description).toBe("goto -30 8");
  expect(f.body.events.consume()).not.toContain("navigation_stopped");
});

test("A13 shutdown during a rescue on a go_to sends one stop and no resume", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f);
  await f.body.close();
  expect(chats(f)).toEqual(["#goto 400 -621", "#pause", "#stop"]);
});

test("a wait for arrival wakes when a rescue stops the navigation instead", async () => {
  const f = await fixture(); await f.body.poll();
  await f.tools.call("go_to", { x: 400, z: -621 });
  await startDrowning(f); f.body.events.consume();
  const waiting = f.tools.call("wait", { seconds: 2, for: ["arrived", "stopped_short"] });
  await reachDryGround(f, 0, 64, 0);
  const text = toolText(await waiting);
  expect(text).toContain("Waking event received."); expect(text).toContain("navigation_stopped goal=goto 400 -621");
});

test("the third stop-short of one destination from one place says so, and an arrival starts the count over", async () => {
  const f = await fixture(); const goal = { x: 50, z: 0 };
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 attempts=3 text=same destination has stopped short 3 times from about here baritone=no reply observed since start");
  expect(await stall(f, "go_to", goal)).toContain("stopped_short distance=50 attempts=4 text=same destination has stopped short 4 times from about here baritone=");
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
