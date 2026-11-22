import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture, type Fixture } from "./fake-synapse.ts";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
// Rounded, with -0 read as 0: a yaw a hair either side of due south or due north is still that way.
const looks = (f: Fixture) => f.requests.filter(r => r.body.action === "look").map(r => Math.round(r.body.yaw as number) || 0);
const moves = (f: Fixture) => f.requests.filter(r => r.body.action === "move").map(r => r.body);
async function startDrowning(f: Fixture, air = 40) {
  await f.body.poll();
  Object.assign(f.state, { underwater: true, inWater: true, onGround: false, air, maxAir: 300 });
  await f.body.poll(); await f.body.api.state();
  expect(f.body.rescuing).toBe("surface");
}

test("mounted reflexes leave vehicle controls alone; surfacing resumes after dismount", async () => {
  const f = await fixture();
  Object.assign(f.state, { riding: true, food: 4, underwater: true, inWater: true, onGround: false, air: 0, maxAir: 300 });
  f.state.hotbar[0] = { slot: 0, item: "minecraft:bread", count: 8, edible: true };
  await f.body.poll();
  f.state.health = 8;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0], health: 20 }];
  f.tick(1000); await f.body.poll();
  expect(f.requests.filter(r => r.path === "/player")).toEqual([]);
  expect(f.body.rescuing).toBeUndefined();
  f.state.riding = false;
  await f.body.poll(); await f.body.api.state();
  expect(f.body.rescuing).toBe("surface");
  expect(moves(f).at(-1)?.jump).toBe(true);
});

describe("his own actions during a rescue from drowning or lava", () => {
  test("look while coming up for air is turned away and the rescue goes on", async () => {
    // Live (Margo, 23:36): a look ended a rescue at air -2/300 and her health fell to 8.
    const f = await fixture();
    await startDrowning(f);
    const before = f.requests.length;
    const result = await f.tools.call("look", { yaw: 10, pitch: 0 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Not done: your body is coming up for air (air 40/300) and keeps the controls until it is out");
    expect(text(result)).toContain("stop takes over at once and ends the rescue");
    expect(f.requests.slice(before).some(r => r.body.action === "look")).toBe(false);
    expect(f.body.rescuing).toBe("surface");
    f.tick(250); await f.body.poll(); await f.body.api.state();
    expect(f.body.rescuing).toBe("surface");
    expect(moves(f).at(-1)).toEqual({ action: "move", jump: true, ticks: 5 });
    expect(f.body.events.consume()).not.toContain("surface rescue ended");
  });

  test("a hotbar change while climbing out of lava is turned away too", async () => {
    const f = await fixture(); await f.body.poll();
    Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
    await f.body.poll(); await f.body.api.state();
    const result = await f.tools.call("select_hotbar", { slot: 3 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Not done: your body is climbing out of lava");
    expect(f.requests.some(r => r.body.action === "selectHotbar")).toBe(false);
    expect(f.body.rescuing).toBe("lava");
  });

  test("stop takes over at once and says what he is still in", async () => {
    const f = await fixture();
    await startDrowning(f);
    expect(await f.body.stopNavigation()).toBe("Stopped navigation and released keys.");
    expect(f.body.rescuing).toBeUndefined();
    expect(f.body.events.consume()).toContain("surface rescue ended after 0 s: ended by your stop; still under water, air 40/300");
  });

  test("a retreat from a mob still gives way to his own action", async () => {
    const f = await fixture(); await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0], health: 20 }];
    await f.body.poll(); await f.body.api.state();
    expect(f.body.rescuing).toBe("retreat");
    const result = await f.tools.call("look", { yaw: 10, pitch: 0 });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("retreat rescue ended after 0 s: interrupted by your action");
  });
});

describe("retreat", () => {
  /** Hit by a zombie 2 blocks east, with no weapon: the retreat starts at once. */
  async function hitByZombie(f: Fixture) {
    await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0], health: 20 }];
    await f.body.poll(); await f.body.api.state();
    expect(f.body.rescuing).toBe("retreat");
  }
  const step = async (f: Fixture) => { f.tick(500); await f.body.poll(); await f.body.api.state(); };

  test("a way that goes nowhere is tried once with a jump, then never again from there", async () => {
    const f = await fixture();
    await hitByZombie(f);
    for (let i = 0; i < 9; i++) await step(f);
    // Straight away (west, yaw 90), then turned 45 and 90 degrees either side (yaw 135, 45, 180, 0), each twice:
    // once walking, once jumping. No way found blocked is tried again.
    expect(looks(f)).toEqual([90, 90, 135, 135, 45, 45, 180, 180, 0, 0]);
    expect(moves(f).slice(0, 2)).toEqual([{ action: "move", forward: true, ticks: 4 }, { action: "move", forward: true, jump: true, ticks: 4 }]);
    await step(f);
    expect(f.body.events.consume()).toContain("retreat rescue ended after 5 s: timed out after 5 s, 2 blocks from minecraft:zombie (2 at the start); 4 ways found blocked; it is still near");
  });

  test("a step that gets him somewhere is not tried again with a jump", async () => {
    const f = await fixture();
    await hitByZombie(f);
    f.state.pos = { x: -1, y: 64, z: 0 }; f.state.eye = { x: -1, y: 65.62, z: 0 };
    await step(f);
    expect(moves(f)).toEqual([{ action: "move", forward: true, ticks: 4 }, { action: "move", forward: true, ticks: 4 }]);
    expect(looks(f)).toEqual([90, 90]);
  });

  test("runs on past 5 s while the gap still grows, never past 8 s, and promises nothing", async () => {
    const f = await fixture();
    await hitByZombie(f);
    for (let i = 1; i <= 16; i++) {
      const x = -0.4 * i;
      f.state.pos = { x, y: 64, z: 0 }; f.state.eye = { x, y: 65.62, z: 0 };
      await step(f);
      if (i === 10) expect(f.body.rescuing).toBe("retreat");
    }
    expect(f.body.rescuing).toBeUndefined();
    expect(f.body.events.consume()).toContain("retreat rescue ended after 8 s: timed out after 8 s, 8.4 blocks from minecraft:zombie (2 at the start); it is still near");
  });

  test("ten blocks away it ends without calling him safe", async () => {
    const f = await fixture();
    await hitByZombie(f);
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 12, pos: [12, 64, 0], health: 20 }];
    f.tick(1000); await f.body.poll();
    expect(f.body.events.consume()).toContain("12 blocks from minecraft:zombie (2 at the start); it may still follow or shoot");
  });
});
