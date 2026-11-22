import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeNavigation, navigationDefinitions, navigationStatus, type NavigationCommand } from "../src/navigation.ts";
import { fixture, type Fixture } from "./fake-synapse.ts";

const chats = (f: Fixture) => f.requests.filter(r => r.path === "/chat").map(r => String(r.body.text));
const sets = (f: Fixture) => chats(f).filter(text => text.startsWith("#set "));
/** A tool call as the resident makes it: the arguments go through the tool's own schema. */
async function go(f: Fixture, tool: "go_to" | "follow" | "explore" | "stop", args: object = {}) {
  const command = [tool, navigationDefinitions[tool].schema.parse(args)] as NavigationCommand;
  return executeNavigation(f.body, command);
}
/** Baritone's settings file as `name value` pairs. A setting it leaves out is at Baritone's default (true here). */
async function baritoneFile(f: Fixture) {
  const text = await readFile(join(f.dir, "baritone", "settings.txt"), "utf8").catch(() => "");
  return Object.fromEntries(text.split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
}
const baselineFile = (f: Fixture) => join(f.dir, "baritone", "resident-trip-baseline.json");
const exists = (path: string) => stat(path).then(() => true, () => false);
const walkSets = ["#set allowBreak false", "#set allowPlace false", "#set allowWaterBucketFall false"];
const digSets = ["#set allowBreak true", "#set allowPlace true", "#set allowWaterBucketFall true"];

describe("a walk-only trip", () => {
  test("is the default: Baritone is stopped, set not to break or place, and read back before the command", async () => {
    const f = await fixture();
    const reply = await go(f, "go_to", { x: 10.7, z: -0.2 });
    expect(chats(f)).toEqual(["#stop", ...walkSets, "#goto 10 -1"]);
    expect(reply).toBe("Started #goto 10 -1 (walk-only: Baritone's settings read back with breaking and placing off for this whole trip).");
    expect(await baritoneFile(f)).toMatchObject({ allowBreak: "false", allowPlace: "false", allowWaterBucketFall: "false" });
    expect(navigationStatus(f.body)).toBe("Navigation: goto 10 -1 (walk-only)");
  });

  test("keeps its settings for the whole trip: moving, arriving and later polls change nothing", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    for (const x of [3, 6, 9]) { f.state.pos = { x, y: 64, z: 0 }; f.tick(500); await f.body.poll(); }
    expect(f.body.events.consume()).toContain("arrived goal=goto 10 0");
    f.tick(10_000); await f.body.poll(); await f.body.poll();
    // Baritone may still be on the last blocks: an arrival report is no reason to let it dig.
    expect(sets(f)).toEqual(walkSets);
    expect(navigationStatus(f.body)).toBe("Navigation: goto 10 0 (walk-only) (arrival/stop reported)");
  });

  test("one walk after another sets nothing again and stops nothing", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    await go(f, "follow", { player: "Levi" });
    await go(f, "explore");
    expect(chats(f)).toEqual(["#stop", ...walkSets, "#goto 10 0", "#follow player Levi", "#explore"]);
  });

  test("excavate after a walk cancels the walk before allowing digging; excavate is said in the reply", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    const reply = await go(f, "go_to", { x: 10, z: 0, mode: "excavate" });
    // The same goal again: Baritone would keep walking a path planned under the other settings unless stopped.
    expect(chats(f)).toEqual(["#stop", ...walkSets, "#goto 10 0", "#stop", "#set allowBreak true", "#set allowPlace true", "#set allowWaterBucketFall true", "#goto 10 0"]);
    expect(reply).toBe("Started #goto 10 0 (excavate: Baritone may dig and build its way on this trip).");
    expect(navigationStatus(f.body)).toBe("Navigation: goto 10 0 (may dig and build)");
    expect(await exists(baselineFile(f))).toBe(false);
  });

  test("a mine job after a walk is never started with digging off", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    await f.body.navigate("#mine minecraft:stone", { mode: "excavate", mine: { block: "minecraft:stone", radius: 32 } });
    expect(chats(f).slice(-5)).toEqual(["#stop", ...digSets, "#mine minecraft:stone"]);
  });

  test("Baritone's answer to the switch's own stop is neither news nor the new trip's last reply", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    await appendFile(f.log, "[12:00:00] [Render thread/INFO]: [CHAT] [Baritone] ok canceled\n");
    f.tick(4000); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).not.toContain("ok canceled");
    expect(events).toContain("stopped_short distance=10 mode=walk-only baritone=no reply observed since start");
  });

  test("settings that do not read back as walk-only start no trip, and the next poll puts them back", async () => {
    const f = await fixture();
    // As a Baritone without one of the settings would: the command is taken and nothing changes.
    const chat = f.body.api.chat.bind(f.body.api);
    f.body.api.chat = text => text.startsWith("#set allowPlace ") ? Promise.resolve({}) : chat(text);
    await expect(go(f, "go_to", { x: 10, z: 0 })).rejects.toThrow("Baritone's settings did not read back as walk-only (allowPlace reads true); no trip was started.");
    expect(chats(f)).not.toContain("#goto 10 0");
    expect(f.body.navigation).toBeUndefined();
    await f.body.poll();
    expect(await baritoneFile(f)).toMatchObject({ allowBreak: "true", allowWaterBucketFall: "true" });
    expect(await exists(baselineFile(f))).toBe(false);
  });
});

describe("the settings go back when the trip is over", () => {
  test("stop: keys released, Baritone stopped, settings read back as before the trip", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    expect(await exists(baselineFile(f))).toBe(true);
    expect(await go(f, "stop")).toBe("Stopped navigation and released keys.");
    expect(chats(f).slice(-4)).toEqual(["#stop", ...digSets]);
    expect(f.requests.some(r => r.body.action === "release")).toBe(true);
    expect(f.body.navigation).toBeUndefined();
    expect(await exists(baselineFile(f))).toBe(false);
    expect(navigationStatus(f.body)).toBe("Navigation: none");
  });

  test("death: Baritone is stopped first, then the settings go back in the same poll", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    f.state.health = 0; await f.body.poll();
    expect(chats(f).slice(-4)).toEqual(["#stop", ...digSets]);
    expect(f.body.events.consume()).toContain("navigation_stopped goal=goto 10 0 reason=you died");
  });

  test("shutdown: after the stop, and the baseline record is removed", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    await f.body.close();
    expect(chats(f).slice(-4)).toEqual(["#stop", ...digSets]);
    expect(await exists(baselineFile(f))).toBe(false);
  });

  test("a walk trip Baritone gave up is reported as such, and only then is digging allowed again", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 30, z: 0 });
    f.baritone.active = false; // Baritone found no path it may take and dropped the goal, saying nothing.
    f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("stopped_short distance=30 mode=walk-only");
    expect(chats(f).at(-1)).toBe("#proc");
    expect(sets(f)).toEqual(walkSets);
    await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("navigation_stopped goal=goto 30 0 reason=Baritone stopped trying (no process left). On a walk-only trip that means it found no way it could walk from here");
    expect(events).toContain("remaining=30");
    expect(f.body.navigation).toBeUndefined();
    expect(sets(f)).toEqual([...walkSets, ...digSets]);
  });

  test("a walk trip Baritone is still at after a stop-short stays walk-only while Baritone is asked again", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 30, z: 0 });
    f.tick(4000); await f.body.poll(); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("stopped_short distance=30 mode=walk-only");
    expect(events).not.toContain("navigation_stopped");
    expect(f.body.navigation?.description).toBe("goto 30 0");
    f.tick(3000); await f.body.poll(); await f.body.poll();
    expect(chats(f).filter(text => text === "#proc")).toHaveLength(2);
    expect(sets(f)).toEqual(walkSets);
    // It got there in the end, and then had nothing left: that arrival is said, and the settings go back.
    f.state.pos = { x: 29, y: 64, z: 0 }; f.baritone.active = false;
    f.tick(3000); await f.body.poll(); await f.body.poll();
    expect(f.body.events.consume()).toContain("arrived goal=goto 30 0");
    expect(f.body.navigation).toBeUndefined();
    expect(sets(f)).toEqual([...walkSets, ...digSets]);
  });

  test("after an arrival, once Baritone has nothing left of the trip, it ends quietly and the settings go back", async () => {
    const f = await fixture();
    await go(f, "go_to", { x: 10, z: 0 });
    f.state.pos = { x: 9, y: 64, z: 0 }; await f.body.poll();
    expect(f.body.events.consume()).toContain("arrived goal=goto 10 0");
    f.baritone.active = false; // Baritone walked the last block and is done.
    f.tick(1000); await f.body.poll();
    expect(chats(f).at(-1)).toBe("#proc");
    expect(sets(f)).toEqual(walkSets);
    await f.body.poll();
    expect(f.body.navigation).toBeUndefined();
    expect(sets(f)).toEqual([...walkSets, ...digSets]);
    expect(await exists(baselineFile(f))).toBe(false);
    expect(f.body.events.consume()).toBe("Since last time:\nnone");
  });

  test("a mine job ended by its count goes back to a walk-only baseline at once", async () => {
    const f = await fixture({ baritoneSettings: "allowBreak false\nallowPlace false\nallowWaterBucketFall false\n" });
    await f.body.navigate("#mine 1 minecraft:stone", { mode: "excavate", mine: { block: "minecraft:stone", radius: 32, count: 1 } });
    expect(sets(f)).toEqual(["#set allowBreak true", "#set allowPlace true"]);
    f.tick(1000); f.state.inventory!.main = [{ slot: 0, item: "minecraft:cobblestone", count: 1 }]; await f.body.poll();
    expect(f.body.events.consume()).toContain("arrived goal=mine 1 minecraft:stone collected=1 x minecraft:cobblestone");
    expect(f.body.navigation).toBeUndefined();
    expect(chats(f).slice(-3)).toEqual(["#stop", "#set allowBreak false", "#set allowPlace false"]);
    expect(await exists(baselineFile(f))).toBe(false);
  });
});

describe("a tool server stopped in the middle of a trip", () => {
  test("the next one puts the recorded settings back before anything else", async () => {
    const f = await fixture({ baritoneSettings: "allowBreak false\nallowPlace false\nallowWaterBucketFall false\n" });
    await mkdir(join(f.dir, "baritone"), { recursive: true });
    await writeFile(baselineFile(f), JSON.stringify({ allowBreak: "true", allowPlace: "true", allowWaterBucketFall: "true" }));
    await f.body.start();
    expect(sets(f)).toEqual(digSets);
    expect(await exists(baselineFile(f))).toBe(false);
  });

  test("without a record, settings in Baritone's file are the operator's and are left alone", async () => {
    const f = await fixture({ baritoneSettings: "allowBreak false\nallowWaterBucketFall false\n" });
    await f.body.start();
    expect(sets(f)).toEqual([]);
    // An excavate trip digs, and goes back to them afterwards.
    await go(f, "go_to", { x: 10, z: 0, mode: "excavate" });
    expect(sets(f)).toEqual(["#set allowBreak true"]);
    await go(f, "stop");
    expect(sets(f)).toEqual(["#set allowBreak true", "#set allowBreak false"]);
  });

  test("walk-only refuses block-breaking exceptions before starting a route", async () => {
    const f = await fixture({ baritoneSettings: "allowBreakAnyway minecraft:cobweb,minecraft:oak_leaves\n" });
    await expect(go(f, "go_to", { x: 10, z: 0 })).rejects.toThrow("allowBreakAnyway exceptions");
    expect(chats(f)).toEqual([]);
    expect(f.body.navigation).toBeUndefined();
    expect(await baritoneFile(f)).toEqual({ allowBreakAnyway: "minecraft:cobweb,minecraft:oak_leaves" });
  });
});

test("mode is optional and only walk or excavate", () => {
  expect(navigationDefinitions.go_to.schema.parse({ x: 1, z: 2 })).toEqual({ x: 1, z: 2 });
  expect(navigationDefinitions.go_to.schema.safeParse({ x: 1, z: 2, mode: "dig" }).success).toBe(false);
  expect(navigationDefinitions.follow.schema.safeParse({ player: "Levi", mode: "excavate" }).success).toBe(true);
});
