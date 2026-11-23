import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Body } from "../src/body.ts";
import { Events, parseLogLine } from "../src/events.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import { Synapse } from "../src/synapse.ts";
import { Tools, definitions } from "../src/tools.ts";
import { fixture, type Fixture } from "./fake-synapse.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
function knowledgeFixture(dir: string) {
  const path = join(dir, "knowledge.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE items (id TEXT, name TEXT);
    CREATE TABLE recipes (id TEXT, type TEXT, summary TEXT);
    CREATE TABLE recipe_outputs (recipe TEXT, what TEXT);
    CREATE TABLE recipe_inputs (recipe TEXT, what TEXT);
    CREATE TABLE tag_items (tag TEXT, item TEXT);
    CREATE VIRTUAL TABLE guides USING fts5(book, title, text);
    INSERT INTO items VALUES ('test:bronze_ingot', 'Bronze Ingot'), ('test:copper_ingot', 'Copper Ingot'), ('minecraft:oak_log', 'Oak Log');
  `);
  const insert = db.query("INSERT INTO recipes VALUES (?, ?, ?)");
  for (const output of ["test:bronze_ingot", "minecraft:oak_log"]) {
    const recipe = { id: output, type: "test:crafting", inputs: [{ what: "test:copper_ingot", count: 1 }], outputs: [{ what: output, count: 1 }], pattern: null, note: null };
    insert.run(recipe.id, recipe.type, JSON.stringify(recipe));
    db.query("INSERT INTO recipe_outputs VALUES (?, ?)").run(recipe.id, output);
    db.query("INSERT INTO recipe_inputs VALUES (?, ?)").run(recipe.id, "test:copper_ingot");
  }
  db.close();
  const knowledge = openKnowledge(path);
  cleanups.unshift(async () => { knowledge.close(); });
  return knowledge;
}

describe("log and events", () => {
  test("chat wakes wait in less than 300ms without extra HTTP polling", async () => {
    const f = await fixture(); await f.body.tail.start();
    const before = f.requests.length, started = performance.now();
    const waiting = f.tools.call("wait", { seconds: 2 });
    await appendFile(f.log, "[21:15:02] [Render thread/INFO]: [CHAT] <spesk01> hello gary\n");
    expect(text(await waiting)).toContain("chat from=spesk01 text=hello gary");
    expect(performance.now() - started).toBeLessThan(300);
    expect(f.requests.length).toBe(before);
  });
  test("own echo never wakes a pending wait", async () => {
    const f = await fixture(); await f.body.tail.start();
    let done = false;
    const waiting = f.tools.call("wait", { seconds: 1 }).then(r => { done = true; return r; });
    await appendFile(f.log, "[CHAT] <Gary> hello\n"); await Bun.sleep(200);
    expect(done).toBe(false); expect(text(await waiting)).toContain("Time is up.");
  });
  test("phone-style chat preserves the sender", () => {
    expect(parseLogLine("[21:15:02] [Render thread/INFO]: [System] [CHAT] <spesk01> hello gary", "Gary")).toEqual({ type: "chat", fields: { from: "spesk01", text: "hello gary" } });
    expect(parseLogLine("[CHAT] [Baritone] Going to: GoalXZ{x=165,z=-240}", "Gary")?.type).toBe("baritone");
    expect(parseLogLine("[System] [CHAT] Levi joined the game", "Gary")?.type).toBe("system");
  });
  test("tail survives replacement and in-place truncate/rewrite", async () => {
    const f = await fixture(); await f.body.tail.start();
    await appendFile(f.log, "[CHAT] <A> first\n"); await f.body.tail.read();
    await rename(f.log, `${f.log}.old`); await writeFile(f.log, "[System] [CHAT] <B> replacement\n"); await f.body.tail.read();
    await writeFile(f.log, "[CHAT] <C> rewritten with a larger log than the previous file\n"); await f.body.tail.read();
    const events = f.body.events.consume(); expect(events).toContain("from=A"); expect(events).toContain("from=B"); expect(events).toContain("from=C");
  });
  test("keeps eight events, reports dropped count, and marks them seen", () => {
    const events = new Events(); for (let i = 0; i < 140; i++) events.add("chat", { from: "A", text: `message${i}` });
    const result = events.consume(); expect(result).toContain("132 older dropped"); expect(result.split("\n")).toHaveLength(9);
    expect(events.consume()).toBe("Since last time:\nnone");
  });
  test("filtered wait ignores other wake events and supports cancellation", async () => {
    const events = new Events(); const controller = new AbortController(); let done = false;
    const waiting = events.wait(2, ["chat"], controller.signal).then(v => { done = true; return v; });
    events.add("hurt", { from: 20, to: 18 }); await Bun.sleep(10); expect(done).toBe(false);
    controller.abort(); expect(await waiting).toBe("Wait cancelled.");
  });
});

describe("navigation and observation", () => {
  test("starts the requested goal without waiting for arrival", async () => {
    const f = await fixture();
    expect((await f.tools.call("go_to", { x: 135, z: -180 })).isError).toBe(false);
    expect(f.body.navigation?.target).toEqual({ x: 135, z: -180 });
    expect(f.requests.some(r => r.path === "/chat" && r.body.text === "#goto 135 -180")).toBe(true);
    await f.tools.call("go_to", { x: 3, y: 64, z: -2 }); expect(f.requests.at(-1)?.body).toEqual({ text: "#goto 3 64 -2" });
  });
  test("arrival is horizontal and emitted once", async () => {
    const f = await fixture(); await f.tools.call("go_to", { x: 5, z: 0 });
    f.state.pos.x = 4; f.state.pos.y += 30; await f.body.poll();
    expect(f.body.events.consume()).toContain("arrived"); await f.body.poll(); expect(f.body.events.consume()).not.toContain("arrived");
  });
  test("a goal with a height is not reached from far above it", async () => {
    const f = await fixture(); const surface = f.state.pos.y;
    await f.tools.call("go_to", { x: 5, y: surface - 40, z: 0 });
    f.state.pos.x = 5; await f.body.poll();
    expect(f.body.events.consume()).not.toContain("arrived");
    f.state.pos.y = surface - 39; await f.body.poll();
    expect(f.body.events.consume()).toContain("arrived");
  });
  test("stopped short after four seconds without movement", async () => {
    const f = await fixture(); await f.tools.call("go_to", { x: 10, z: 0 });
    f.tick(3999); await f.body.poll(); expect(f.body.events.consume()).not.toContain("stopped_short");
    f.tick(1); await f.body.poll(); expect(f.body.events.consume()).toContain("stopped_short distance=10");
  });
  test("movement resets stalled timer", async () => {
    const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 });
    f.tick(3900); f.state.pos.x = 1; await f.body.poll(); f.tick(200); await f.body.poll();
    expect(f.body.events.consume()).not.toContain("stopped_short");
  });
  test("mine/follow/explore and stop commands", async () => {
    const f = await fixture();
    await f.tools.call("mine", { block: "minecraft:iron_ore", count: 3 });
    await f.tools.call("follow", { player: "Levi" }); await f.tools.call("explore"); await f.tools.call("stop");
    expect(f.requests.filter(r => r.path === "/chat" && /^#(mine|follow|explore)\b/.test(String(r.body.text)))
      .map(r => r.body.text)).toEqual(["#mine 3 minecraft:iron_ore", "#follow player Levi", "#explore"]);
    expect(f.baritone.active).toBe(false);
    expect(f.requests.some(r => r.body.action === "release")).toBe(true); expect(f.body.navigation).toBeUndefined();
  });
  test.each([["south", 0, 10, 0], ["east", 10, 0, -90], ["north", 0, -10, -180], ["west", -10, 0, 90]])("look %s at a block's centre has Minecraft yaw", async (_direction, x, z, yaw) => {
    // Eye over the centre of block 0,_,0, so the centres of blocks due south etc. are straight lines away.
    const f = await fixture(); f.state.pos = { x: 0.5, y: 64, z: 0.5 }; f.state.eye = { x: 0.5, y: 65.62, z: 0.5 };
    await f.tools.call("look", { x, y: 65, z });
    const look = f.requests.find(r => r.body.action === "look")!.body;
    expect(look.yaw as number).toBeCloseTo(yaw); expect(look.pitch as number).toBeCloseTo(Math.atan2(0.12, 10) * 180 / Math.PI);
  });
  test("look at a block says what is actually in the sights", async () => {
    const f = await fixture();
    f.state.lookingAt = { type: "block", block: "minecraft:crafting_table", blockPos: [104, 118, -205] };
    expect(text(await f.tools.call("look", { x: 104, y: 118, z: -205 }))).toContain("Looking at minecraft:crafting_table at 104,118,-205.");
    f.state.lookingAt = { type: "block", block: "minecraft:grass_block", blockPos: [104, 117, -205] };
    expect(text(await f.tools.call("look", { x: 104, y: 118, z: -205 }))).toContain("but minecraft:grass_block at 104,117,-205 is in the way");
    f.state.lookingAt = { type: "miss" };
    expect(text(await f.tools.call("look", { x: 104, y: 118, z: -205 }))).toContain("out of reach");
  });
  test("hurt/death/hunger and player arrival/departure", async () => {
    const f = await fixture(); await f.body.poll();
    f.state.health = 0; f.state.food = 6; f.state.nearbyEntities = [{ id: 3, type: "minecraft:player", name: "Levi", player: true, pos: [1, 64, 0], distance: 1 }];
    await f.body.poll(); const events = f.body.events.consume();
    for (const type of ["hurt", "died", "hungry", "player_near"]) expect(events).toContain(type);
    f.state.nearbyEntities = []; f.tick(1000); await f.body.poll(); expect(f.body.events.consume()).toContain("player_gone name=Levi");
  });
});

describe("reflexes and interactions", () => {
  test("modded edible metadata wins over vanilla fallback", async () => {
    const f = await fixture(); f.state.food = 8;
    f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:bread", edible: false }, { slot: 1, count: 1, item: "farmersdelight:beef_stew", edible: true }];
    await f.body.poll();
    expect(f.requests.find(r => r.body.action === "selectHotbar")?.body.slot).toBe(1);
  });
  test("inventory shows durability on tools and armor", async () => {
    const f = await fixture();
    f.state.inventory!.main = [{ slot: 0, count: 1, item: "minecraft:iron_pickaxe", durability: 212, maxDurability: 250 }];
    expect(text(await f.tools.call("inventory"))).toContain("H0: 1 x minecraft:iron_pickaxe (212/250)");
  });
  test("manual eat reports observed before and after and restores selected slot", async () => {
    const f = await fixture(); f.state.food = 8; f.state.hotbar = [{ slot: 1, count: 1, item: "farmersdelight:beef_stew", edible: true }];
    // Real client-tick duration is part of this HTTP integration test.
    const result = await f.tools.call("eat", { item: "farmersdelight:beef_stew" });
    expect(text(result)).toContain("food 8 -> 14"); expect(f.state.selectedSlot).toBe(0);
  });
  test("opening a screen releases an ongoing automatic hold", async () => {
    const f = await fixture(); f.state.food = 8; f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:bread" }];
    await f.body.poll(); f.state.screen = "InventoryScreen"; await f.body.poll();
    expect(f.requests.some(r => r.body.action === "release")).toBe(true);
  });
  test("auto-eat only with no screen open; reports before/after", async () => {
    const f = await fixture(); f.state.food = 8; f.state.hotbar = [{ slot: 1, count: 3, item: "minecraft:bread" }];
    f.state.screen = "InventoryScreen"; await f.body.poll(); expect(f.requests.some(r => r.body.action === "use")).toBe(false);
    f.state.screen = "none"; await f.body.poll(); expect(f.requests.find(r => r.body.action === "use")?.body).toEqual({ action: "use", ticks: 40 });
    f.tick(2200); await f.body.poll(); expect(f.body.events.consume()).toContain("ate minecraft:bread, food 8 -> 14");
  });
  test("auto-eat can be disabled", async () => {
    const f = await fixture(); f.state.food = 8; f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:bread" }];
    await f.tools.call("set_reflexes", { auto_eat: false }); await f.body.poll(); expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  });
  test("fight selects weapon, targets mob, respects cooldown, resumes", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 2, count: 1, item: "minecraft:iron_sword" }];
    await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2, health: 20 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
    await f.body.poll(); expect(f.requests.some(r => r.body.text === "#pause")).toBe(true);
    await f.body.poll(); await f.body.poll(); expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(1);
    f.tick(600); await f.body.poll(); expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(2);
    f.state.nearbyEntities = []; f.tick(1000); await f.body.poll(); expect(f.requests.some(r => r.body.text === "#resume")).toBe(true);
  });
  test("never fights players, even when they are hurt nearby", async () => {
    const f = await fixture(); await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 3, type: "minecraft:player", player: true, hostile: true, name: "Levi", pos: [0, 64, 1], distance: 1 }];
    await f.body.poll(); await f.body.poll(); expect(f.requests.some(r => r.body.action === "attack" || r.body.text === "#pause")).toBe(false);
  });
  test("fight will not swing when a player crosses the raycast", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:iron_sword" }]; await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:player", entityId: 3 };
    await f.body.poll(); await f.body.poll(); expect(f.requests.some(r => r.body.action === "attack")).toBe(false);
  });
  test("no reflex combat when a screen is open", async () => {
    const f = await fixture(); await f.body.poll(); f.state.health = 18; f.state.screen = "InventoryScreen";
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2 }];
    await f.body.poll(); expect(f.requests.some(r => r.body.text === "#pause")).toBe(false);
  });
  test("flee without a qualifying crumb walks directly away in short steps", async () => {
    const f = await fixture(); await f.tools.call("set_reflexes", { when_attacked: "flee" }); await f.body.poll();
    f.state.health = 18; f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0] }];
    await f.body.poll(); await f.body.api.state();
    expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", forward: true, ticks: 4 });
    expect(f.requests.find(r => r.body.action === "look")?.body.yaw as number).toBeCloseTo(90);
  });
  test("say refuses command injection and remains independent of navigation", async () => {
    const f = await fixture(); await f.tools.call("go_to", { x: 10, z: 10 });
    expect((await f.tools.call("say", { text: "#stop" })).isError).toBe(true);
    expect((await f.tools.call("say", { text: " /kill" })).isError).toBe(true);
    await f.tools.call("say", { text: "hello" }); expect(f.body.navigation).toBeDefined(); expect(f.requests.at(-1)?.body.text).toBe("hello");
  });
  test("say sends a long message as several chat lines, each within Minecraft's limit and split between words", async () => {
    const f = await fixture();
    const words = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    expect(text(await f.tools.call("say", { text: words }))).toContain("in 3 lines");
    const sent = f.requests.filter(r => r.path === "/chat").map(r => String(r.body.text));
    expect(sent).toHaveLength(3);
    for (const line of sent) expect(line.length).toBeLessThanOrEqual(256);
    expect(sent.join(" ")).toBe(words);
  });
  test("write sign opens editor, types lines and clicks Done", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:oak_sign" }]; f.state.lookingAt = { type: "block", block: "minecraft:stone", blockPos: [3, 63, 0], face: "up" };
    expect(text(await f.tools.call("write_sign", { lines: ["Gary", "lives here"] }))).toContain("Placed the sign at 3,64,0 on the up face of minecraft:stone at 3,63,0; entered 2 lines; editor closed (Done).");
    expect(f.requests.filter(r => r.path === "/gui" && r.body.action).map(r => r.body)).toEqual([{ action: "keys", text: "Gary" }, { action: "key", key: "ENTER" }, { action: "keys", text: "lives here" }, { action: "clickButton", index: 0 }]);
  });
  test("use reports what was in hand, what it was used on, and whether a screen opened", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 4, item: "minecraft:oak_planks" }]; f.state.selectedSlot = 0;
    f.state.lookingAt = { type: "miss" };
    expect(text(await f.tools.call("use", {}))).toContain("Used minecraft:oak_planks on nothing in reach (air, or more than about 4.5 blocks away); no screen opened.");
    f.state.lookingAt = { type: "block", block: "minecraft:crafting_table", blockPos: [109, 120, -209] };
    expect(text(await f.tools.call("use", {}))).toContain("on minecraft:crafting_table at 109,120,-209; CraftingScreen opened.");
  });
  test("use says whether a seed went in: what left the hand and what is in the sights now", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 3, item: "minecraft:wheat_seeds" }]; f.state.selectedSlot = 0;
    f.state.lookingAt = { type: "block", block: "minecraft:farmland", blockPos: [96, 113, -196] };
    expect(text(await f.tools.call("use", {}))).toContain("Used minecraft:wheat_seeds on minecraft:farmland at 96,113,-196; no screen opened. 1 minecraft:wheat_seeds used up, 2 left; now in your sights: minecraft:wheat at 96,114,-196.");
    f.state.lookingAt = { type: "block", block: "minecraft:grass_block", blockPos: [97, 113, -196] };
    expect(text(await f.tools.call("use", {}))).toContain("on minecraft:grass_block at 97,113,-196; no screen opened. Nothing your body can see changed.");
  });
  test("difficulty includes position and previous error", async () => {
    const f = await fixture(); await f.tools.call("say", { text: "/kill" }); await f.tools.call("note_difficulty", { text: "Machine labels confuse me." });
    const saved = await Bun.file(join(f.dir, "difficulties.md")).text();
    expect(saved).toContain("Machine labels confuse me."); expect(saved).toContain("0, 64, 0"); expect(saved).toContain("Plain chat only");
  });
  test("knowledge unavailable is a clear error and tools are omitted", async () => {
    const f = await fixture(); expect(f.tools.registeredNames).not.toContain("recipes");
    expect(text(await f.tools.call("recipes", { item: "minecraft:bread" }))).toContain("Knowledge unavailable");
  });
  test("status gives usable nearby livestock positions without confusing dropped food with animals", async () => {
    const f = await fixture();
    f.state.nearbyEntities = [
      { id: 2, type: "minecraft:cow", pos: [3.25, 64, -2.75], distance: 4.3 },
      { id: 3, type: "minecraft:sheep", pos: [1, 64, 0], distance: 1 },
      { id: 4, type: "minecraft:item", pos: [2, 64, 0], distance: 2 },
    ];
    const line = text(await f.tools.call("status")).split("\n").find(line => line.startsWith("Livestock:"))!;
    expect(line).toContain("minecraft:cow #2 at 3.3,64,-2.7");
    expect(line).toContain("minecraft:sheep #3 at 1,64,0");
    expect(line.indexOf("sheep")).toBeLessThan(line.indexOf("cow"));
    expect(line).not.toContain("minecraft:item");
  });
  test("unreachable and not-in-world are one-line errors", async () => {
    const f = await fixture(); f.setUnavailable(); const result = text(await f.tools.call("status"));
    expect(result).toStartWith("Error: Synapse: No player in world.\n\nSince last time:"); expect(result).not.toContain(" at ");
    const offline = new Tools(new Body(f.body.config, new Synapse("http://127.0.0.1:1", "test")));
    expect(text(await offline.call("status"))).toContain("Synapse unreachable");
  });
  test("all tool text stays below 1500 characters with full inventory and event burst", async () => {
    const hub = residentHub();
    cleanups.push(async () => hub.close());
    // Twenty far positions: with limit 16, the longest list find_block can give.
    const flax = Array.from({ length: 20 }, (_, i): [number, number, number] => [-40 - i, 44, -40 - i]);
    const f = await fixture({ ...hub.identity(), blocks: { "supplementaries:wild_flax": flax } }); f.state.inventory!.main = Array.from({ length: 36 }, (_, slot) => ({ slot, count: 64, item: `mekanism:very_long_modded_material_stack_${slot}` }));
    await writeFile(join(f.dir, "memory.md"), Array.from({ length: 60 }, (_, i) => `- bread note ${i} ${"n".repeat(200)}`).join("\n"));
    const facility = { name: "n".repeat(60), purpose: "p".repeat(160), capabilities: Array.from({ length: 8 }, (_, i) => `${i}${"c".repeat(47)}`), x: 100, y: 64, z: -200, dimension: "minecraft:overworld", access_terms: "a".repeat(200) };
    const argumentsByTool: Record<string, unknown> = {
      wait: { seconds: 1 }, go_to: { x: 10, z: 10 }, mine: { block: "minecraft:stone" }, find_block: { block: "supplementaries:wild_flax", radius: 96, limit: 16 },
      follow: { player: "Levi" }, say: { text: "hello" }, look: { yaw: 0, pitch: 0 },
      use: { hold_ticks: 10 }, attack: { hold_ticks: 10 }, select_hotbar: { slot: 0 },
      eat: { item: "minecraft:bread" }, click_slot: { slot: 0 }, click_button: { index: 0 },
      type_text: { text: "hello" }, press_key: { key: "ENTER" }, write_sign: { lines: ["hello"] },
      find_item: { query: "bread" }, recipes: { item: "minecraft:bread" }, uses: { item: "minecraft:bread" },
      guide: { query: "bread" }, craft: { item: "minecraft:bread" }, note_difficulty: { text: "test" },
      guide_feedback: { target: "survival", query: "q".repeat(200), verdict: "unhelpful", detail: "d".repeat(600) },
      guide_updates: {},
      collaborate: { kind: "offer", recipient: "Margo", project: "p".repeat(40), terms: "t".repeat(400) },
      collaboration_update: { id: 1, revision: 1, action: "withdraw" }, collaboration_show: { id: 1 },
      facility_register: facility, facility_update: { id: 1, revision: 1, ...facility },
      facility_observe: { id: 1, condition: "c".repeat(240), certainty: "observed", source: "s".repeat(200), stock: Array.from({ length: 12 }, (_, i) => ({ item: `${i}${"i".repeat(79)}`.slice(0, 80), count: 1_000_000 })) },
      facility_show: { id: 1 },
      recall: { query: "bread", limit: 8 }, place_save: { name: "home", note: "n".repeat(120) }, place_find: {},
      place_remove: { name: "home" },
      // Saved first, so the tools after it have a long skill, a long log and a long note to show.
      skill_save: {
        name: "long_routine", description: "d".repeat(300), params: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`param_${i}`, "p".repeat(120)])),
        code: Array.from({ length: 40 }, (_, i) => `log("step ${i} ${"s".repeat(120)}");`).join("\n") + `\nreturn "${"r".repeat(900)}";`,
        expect: { gain: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`mekanism:very_long_modded_material_stack_${i}`, 64])) },
      },
      skill_find: {}, skill_show: { name: "long_routine" }, skill_run: { name: "long_routine" },
      note_share: { topic: "t".repeat(60), text: "x".repeat(600) }, notes_shared: { limit: 8 }, feedback: { skill: "long_routine", worked: true, text: "f".repeat(120) },
      plan_set: { name: "n".repeat(40), goal: "g".repeat(140), why: "w".repeat(140), done_when: "d".repeat(200), steps: Array.from({ length: 12 }, (_, i) => `${i} ${"s".repeat(118)}`.slice(0, 120)) },
      plan_step: { step: 1, state: "blocked", note: "b".repeat(100) },
      plan_focus: { name: "n".repeat(40) },
      plan_finish: { outcome: "dropped", evidence: "Not pursued." },
    };
    for (const tool of [...Object.keys(definitions).filter(name => name !== "plan_finish"), "plan_finish"]) {
      f.state.hotbar = [{ slot: 0, item: tool === "write_sign" ? "minecraft:oak_sign" : "minecraft:bread", count: 2 }];
      f.state.food = 8; f.state.selectedSlot = 0; f.state.lookingAt = { type: "block", block: "minecraft:stone" };
      f.setScreen(tool === "write_sign" || tool === "eat" ? { screen: "none" } : { screen: "InventoryScreen", container: { slots: f.state.inventory!.main, carried: "minecraft:air" } });
      for (let i = 0; i < 20; i++) f.body.events.add("chat", { from: "spesk01", text: "a".repeat(500) });
      const result = await f.tools.call(tool, argumentsByTool[tool] ?? {});
      expect(text(result).length).toBeLessThan(1500); expect(text(result)).toContain("Since last time:");
    }
  });
  test("shutdown releases held keys and stops Baritone", async () => {
    const f = await fixture(); await f.body.close();
    expect(f.requests.some(r => r.body.action === "release")).toBe(true); expect(f.requests.some(r => r.body.text === "#stop")).toBe(true);
  });
});

test("stdio MCP registration, union-schema tool calls and clean shutdown", async () => {
  const f = await fixture(); const tokenFile = join(f.dir, "token"); await writeFile(tokenFile, "test-token");
  const hub = residentHub(), identity = hub.identity();
  cleanups.push(async () => hub.close());
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, "../src/main.ts")], stderr: "pipe",
    env: { CLIENT_LOG: f.log, RESIDENT_NAME: "Gary", RESIDENT_DIR: f.dir, SYNAPSE_TOKEN_FILE: tokenFile, SYNAPSE_URL: f.body.config.url, KNOWLEDGE_DB: join(f.dir, "missing.sqlite"), COMMONS_URL: identity.commonsUrl, COMMONS_TOKEN_FILE: identity.commonsTokenFile },
  });
  const client = new Client({ name: "integration-test", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(f.tools.registeredNames);
    const result = await client.callTool({ name: "look", arguments: { yaw: -90, pitch: 0 } });
    expect(result.isError).toBe(false);
    const picture = CallToolResultSchema.parse(await client.callTool({ name: "picture", arguments: {} }));
    expect(picture.content[0].type).toBe("image");
    // A skill end to end in the real server process: the commons is created, the interpreter starts beside it,
    // and the code's tool call reaches the client.
    expect(Object.keys(listed.tools.find(t => t.name === "skill_save")!.inputSchema.properties!)).toEqual(["name", "description", "code", "params", "expect"]);
    const saved = CallToolResultSchema.parse(await client.callTool({ name: "skill_save", arguments: { name: "face_east", description: "Turns to face east and reports health.", code: "await body.look({ yaw: -90, pitch: 10 });\nreturn 'health ' + (await state()).health;", expect: { screen: "none" } } }));
    expect(saved.isError).toBe(false);
    const ran = CallToolResultSchema.parse(await client.callTool({ name: "skill_run", arguments: { name: "face_east" } }));
    expect(text(ran)).toMatch(/^Skill face_east v1 finished in \d+(\.\d)? s, 1 tool call\.\nCheck passed: screen is none, needs none\.\nInventory changes: none\.\nReturned: health 20\nface_east is now verified/);
    expect(f.state.rotation).toEqual({ yaw: -90, pitch: 10 });
  } finally { await client.close(); }
});

describe("live-run regressions", () => {
  test("bare ids default to minecraft and explicit ids remain intact", async () => {
    const f = await fixture();
    expect((await f.tools.call("mine", { block: "oak_log" })).isError).toBe(false);
    expect(f.requests.at(-1)?.body.text).toBe("#mine minecraft:oak_log");
    expect(definitions.eat.schema.parse({ item: "bread" }).item).toBe("minecraft:bread");
    expect(definitions.mine.schema.parse({ block: "test:ore" }).block).toBe("test:ore");
  });
  test.each(["recipes", "uses"] as const)("%s falls back to indexed matches and identifies the id", async tool => {
    const f = await fixture(); const tools = new Tools(f.body, knowledgeFixture(f.dir));
    const result = await tools.call(tool, { item: tool === "recipes" ? "bronze_ingot" : "copper_ingot" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain(`Using test:${tool === "recipes" ? "bronze_ingot" : "copper_ingot"}`);
    expect(text(result)).toContain("test:crafting");
  });
  test("exact bare recipe lookup is preferred to alternate matches", async () => {
    const f = await fixture(); const tools = new Tools(f.body, knowledgeFixture(f.dir));
    const result = text(await tools.call("recipes", { item: "oak_log" }));
    expect(result).toContain("minecraft:oak_log"); expect(result).not.toContain("Using ");
  });
  test("three automatic meals produce three completion events, not six", async () => {
    const f = await fixture(); f.state.food = 0; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
    f.body.reflexes.eat_below = 20; await f.body.poll();
    expect(f.body.events.consume()).not.toContain("reflex");
    const meals: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (i === 2) f.body.reflexes.auto_eat = false;
      f.tick(2200); await f.body.poll();
      const result = f.body.events.consume();
      expect(result.match(/reflex/g)).toHaveLength(1);
      expect(result).toContain(`ate minecraft:bread, food ${i * 6} -> ${(i + 1) * 6}`);
      meals.push(result);
    }
    expect(meals.join("\n")).not.toContain("started");
  });
  test("Baritone command echoes are discarded but replies remain", () => {
    expect(parseLogLine("[CHAT] [Baritone] > stop", "Gary")).toBeUndefined();
    expect(parseLogLine("[System] [CHAT] [Baritone] > goto 2 3", "Gary")).toBeUndefined();
    expect(parseLogLine("[CHAT] [Baritone] Canceled", "Gary")).toEqual({ type: "baritone", fields: { text: "Canceled" } });
  });
  const independentTools: [string, object][] = [
    ["go_to", { x: 20, z: 20 }], ["mine", { block: "oak_log" }], ["follow", { player: "Levi" }], ["explore", {}],
    ["say", { text: "hi" }], ["wait", { seconds: 1 }], ["status", {}], ["inventory", {}], ["screen", {}],
    ["find_item", { query: "oak" }], ["recipes", { item: "oak_log" }], ["uses", { item: "copper_ingot" }], ["guide", { query: "oak" }],
  ];
  test.each(independentTools)("%s leaves an automatic meal running", async (tool, args) => {
    const f = await fixture(); const tools = new Tools(f.body, knowledgeFixture(f.dir));
    f.state.food = 8; f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }]; await f.body.poll();
    f.body.events.add("chat", { from: "Levi", text: "hi" });
    expect((await tools.call(tool, args)).isError).toBe(false);
    expect(f.requests.some(r => r.body.action === "release")).toBe(false);
    expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(1);
    f.tick(2200); await f.body.poll(); expect(f.body.events.consume()).toContain("ate minecraft:bread");
  });
  test.each(independentTools)("%s leaves a fight running", async (tool, args) => {
    const f = await fixture(); const tools = new Tools(f.body, knowledgeFixture(f.dir));
    f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
    await f.body.poll(); f.body.events.add("chat", { from: "Levi", text: "hi" });
    expect((await tools.call(tool, args)).isError).toBe(false);
    expect(f.requests.some(r => r.body.action === "release" || r.body.text === "#resume")).toBe(false);
    await f.body.poll(); expect(f.requests.some(r => r.body.action === "attack")).toBe(true);
    if (["go_to", "mine", "follow", "explore"].includes(tool)) expect(f.requests.filter(r => r.path === "/chat").at(-1)?.body.text).toBe("#pause");
  });
  test.each([
    ["unarmed", 18, false, "no weapon", "move"],
    ["armed but below eight health", 7, true, "low health", "move"],
    ["armed with eight health", 8, true, "defending", "attack"],
  ] as const)("auto response: %s", async (_label, health, armed, expectedEvent, action) => {
    const f = await fixture();
    if (armed) f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }];
    await f.body.poll(); f.state.health = health;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
    await f.body.poll(); expect(f.body.events.consume()).toContain(expectedEvent);
    if (action === "attack") await f.body.poll();
    // Observe the asynchronous movement HTTP request directly, rather than sleeping.
    await f.body.api.state();
    expect(f.requests.some(r => r.body.action === action)).toBe(true);
  });
  test.each(["auto", "fight"] as const)("%s breaks off a fight at six health and flees", async mode => {
    const f = await fixture(); f.body.reflexes.when_attacked = mode;
    f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }]; await f.body.poll(); f.state.health = 18;
    f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, pos: [0, 64, 2], distance: 2 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
    await f.body.poll(); await f.body.poll(); const attacks = f.requests.filter(r => r.body.action === "attack").length;
    f.state.health = 6; await f.body.poll(); await f.body.api.state();
    expect(f.body.events.consume()).toContain("fleeing from minecraft:zombie (low health)");
    expect(f.requests.some(r => r.body.action === "release")).toBe(true);
    expect(f.requests.some(r => r.body.action === "move")).toBe(true);
    expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(attacks);
  });
});

describe("body-tool repair regressions", () => {
  test("float coordinates use the containing block, including negative coordinates", async () => {
    const f = await fixture();
    expect((await f.tools.call("go_to", { x: 10.9, y: 64.8, z: -0.2 })).isError).toBe(false);
    expect(f.requests.at(-1)?.body.text).toBe("#goto 10 64 -1");
    expect(f.body.navigation?.target).toEqual({ x: 10, y: 64, z: -1 });
    await f.tools.call("look", { x: 10.9, y: 65.9, z: -0.2 });
    // Block 10,65,-1, aimed at its centre 10.5,65.5,-0.5 from the eye at 0,65.62,0.
    const look = f.requests.find(r => r.body.action === "look")!.body;
    expect(look.yaw as number).toBeCloseTo(-Math.atan2(10.5, -0.5) * 180 / Math.PI);
    expect(look.pitch as number).toBeCloseTo(Math.atan2(0.12, Math.hypot(10.5, 0.5)) * 180 / Math.PI);
    expect((await f.tools.call("go_to", { x: Infinity, z: 0 })).isError).toBe(true);
  });
  test("open_inventory uses the mod endpoint and verifies the resulting screen", async () => {
    const f = await fixture();
    expect(text(await f.tools.call("open_inventory"))).toContain("Opened InventoryScreen.");
    expect(f.requests.some(r => r.path === "/gui" && r.body.action === "open" && r.body.target === "inventory")).toBe(true);
    f.setScreen({ screen: "CraftingScreen" });
    expect(text(await f.tools.call("open_inventory"))).toContain("Close CraftingScreen");
    expect(f.requests.filter(r => r.body.action === "open")).toHaveLength(1);
    f.setScreen({ screen: "none" }); f.options.openWorks = false;
    expect((await f.tools.call("open_inventory")).isError).toBe(true);
  });
  test("manual eat swaps off-hotbar food, reports the move, and restores selected slot and aim", async () => {
    const f = await fixture({ interactable: true }); f.state.food = 6;
    f.state.rotation = { yaw: 73, pitch: 10 }; f.state.selectedSlot = 2;
    f.state.inventory!.main = [{ slot: 17, count: 30, item: "minecraft:bread", edible: true }];
    const result = await f.tools.call("eat", { item: "bread" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("food 6 -> 12");
    expect(text(result)).toContain("Moved 30 x minecraft:bread from inventory 17 to H0.");
    expect(f.requests.find(r => r.body.mode === "SWAP")?.body).toEqual({ action: "clickSlot", slot: 17, button: 0, mode: "SWAP" });
    expect(f.state.screen).toBe("none"); expect(f.state.selectedSlot).toBe(2);
    expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
    const actions = f.requests.filter(r => r.path === "/player" || r.path === "/wait");
    const use = actions.findIndex(r => r.body.action === "use");
    expect(actions[use - 2]?.body).toEqual({ action: "look", yaw: 73, pitch: -90 });
    expect(actions[use - 1]?.path).toBe("/wait");
    expect(actions.some(r => r.body.action === "release")).toBe(true);
  });
  test("auto-eat moves food to a full hotbar, reports displacement and avoids the crafting table", async () => {
    const f = await fixture({ interactable: true }); f.state.food = 6; f.state.selectedSlot = 4;
    f.state.hotbar = Array.from({ length: 9 }, (_, slot) => ({ slot, item: "minecraft:stone", count: 64 }));
    f.state.inventory!.main = [{ slot: 35, item: "minecraft:bread", count: 30 }];
    await f.body.poll(); expect(f.state.screen).toBe("none");
    expect(f.requests.find(r => r.body.mode === "SWAP")?.body.button).toBe(4);
    f.tick(2200); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("Moved 30 x minecraft:bread from inventory 35 to H4");
    expect(events).toContain("swapped minecraft:stone");
    expect(f.state.selectedSlot).toBe(4);
  });
  test("food movement is not claimed successful when the hotbar read-back disagrees", async () => {
    const f = await fixture({ swapWorks: false }); f.state.food = 6;
    f.state.inventory!.main = [{ slot: 9, item: "minecraft:bread", count: 30 }];
    const result = await f.tools.call("eat");
    expect(result.isError).toBe(true); expect(text(result)).toContain("was not observed");
    expect(f.requests.some(r => r.body.action === "use")).toBe(false);
  });
  test("close_screen verifies close and falls back to ESCAPE, never trusting the action response", async () => {
    const f = await fixture({ closeFailures: 1 }); f.setScreen({ screen: "CraftingScreen" });
    const result = await f.tools.call("close_screen");
    expect(result.isError).toBe(false); expect(text(result)).toContain("Closed CraftingScreen.");
    expect(f.requests.filter(r => r.path === "/gui").map(r => r.body)).toEqual([
      {}, {}, { action: "close" }, {}, { action: "key", key: "ESCAPE" }, {},
    ]);
    expect(f.state.screen).toBe("none");
  });
  test("close_screen says where a stack left on the cursor went; click_slot says what the cursor holds", async () => {
    const f = await fixture(); f.setScreen({ screen: "InventoryScreen", container: { slots: [], carried: "minecraft:wooden_pickaxe" } });
    expect(text(await f.tools.call("click_slot", { slot: 37 }))).toContain("Cursor now holds minecraft:wooden_pickaxe; put it in a slot before closing.");
    expect(text(await f.tools.call("close_screen"))).toContain("The minecraft:wooden_pickaxe on your cursor was dropped on the ground in front of you");
  });
  test("a failed read-back after a click or before a close never turns the action into an error", async () => {
    const f = await fixture({ guiReadFailures: 1 }); f.setScreen({ screen: "InventoryScreen", container: { slots: [], carried: "minecraft:air" } });
    const clicked = await f.tools.call("click_slot", { slot: 37 });
    expect(clicked.isError).toBe(false); expect(text(clicked)).toContain("Clicked slot 37 (cursor read-back unavailable).");
    expect(f.requests.filter(r => r.body.action === "clickSlot")).toHaveLength(1);
    f.options.guiReadFailures = 1;
    const closed = await f.tools.call("close_screen");
    expect(closed.isError).toBe(false); expect(text(closed)).toContain("Closed InventoryScreen.");
    expect(f.state.screen).toBe("none");
  });
  test("close_screen and press_key report a surviving CraftingScreen honestly", async () => {
    const f = await fixture({ closeFailures: 10, escapeBlocked: true }); f.setScreen({ screen: "CraftingScreen" });
    const closed = await f.tools.call("close_screen");
    expect(closed.isError).toBe(true); expect(text(closed)).toContain("CraftingScreen is still open after close and ESCAPE");
    expect(text(closed)).not.toContain("Closed ");
    expect(text(await f.tools.call("press_key", { key: "ESCAPE" }))).toContain("screen afterwards: CraftingScreen");
    f.options.escapeBlocked = false;
    expect(text(await f.tools.call("press_key", { key: "ESCAPE" }))).toContain("screen afterwards: none");
  });
  test("eat refuses an open screen by name, without moving food or using it", async () => {
    const f = await fixture(); f.setScreen({ screen: "CraftingScreen" }); f.state.food = 6;
    const result = await f.tools.call("eat");
    expect(result.isError).toBe(true); expect(text(result)).toContain("Close CraftingScreen before eating");
    expect(f.requests.some(r => r.body.action === "use" || r.body.action === "open")).toBe(false);
  });
  test("manual and automatic meals fail rather than saying ate when food did not increase", async () => {
    const f = await fixture({ eatWorks: false }); f.state.food = 6;
    f.state.hotbar = [{ slot: 0, item: "minecraft:bread", count: 30 }];
    const result = await f.tools.call("eat");
    expect(result.isError).toBe(true); expect(text(result)).toContain("no food increase observed");
    expect(text(result)).not.toContain("Ate ");
    await f.body.poll(); f.tick(2200); await f.body.poll();
    expect(f.body.events.consume()).toContain("Eating failed: no food increase observed");
  });
  test("auto-eat emits one screen-blocking warning after more than 20 seconds, resets when unblocked", async () => {
    const f = await fixture(); f.state.food = 6; f.setScreen({ screen: "CraftingScreen" });
    await f.body.poll(); f.tick(20000); await f.body.poll();
    expect(f.body.events.consume()).not.toContain("blocking meals");
    f.tick(1); await f.body.poll(); expect(f.body.events.consume()).toContain("CraftingScreen is blocking meals");
    f.tick(30000); await f.body.poll(); expect(f.body.events.consume()).not.toContain("blocking meals");
    f.setScreen({ screen: "none" }); await f.body.poll();
    f.setScreen({ screen: "InventoryScreen" }); await f.body.poll(); f.tick(20001); await f.body.poll();
    expect(f.body.events.consume()).toContain("InventoryScreen is blocking meals");
  });
  test("a meal-opened screen is closed once and suppresses auto-eat for ten seconds", async () => {
    const f = await fixture({ forceMealScreen: true, closeFailures: 1 }); f.state.food = 6;
    f.state.hotbar = [{ slot: 0, item: "minecraft:bread", count: 30 }];
    await f.body.poll(); expect(f.state.screen).toBe("CraftingScreen");
    await f.body.poll(); expect(f.state.screen).toBe("none");
    const events = f.body.events.consume();
    expect(events).toContain("Meal opened CraftingScreen instead of eating");
    expect(events.match(/reflex/g)).toHaveLength(1);
    const release = f.requests.findIndex(r => r.body.action === "release");
    const close = f.requests.findIndex(r => r.body.action === "close");
    expect(release).toBeLessThan(close);
    f.tick(9999); await f.body.poll();
    expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(1);
    expect(f.body.events.consume()).not.toContain("Meal opened");
    f.options.forceMealScreen = false; f.tick(1); await f.body.poll();
    expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(2);
  });
  test("manual meal-opened screens are also closed and reported as a failure", async () => {
    const f = await fixture({ forceMealScreen: true }); f.state.food = 6;
    f.state.hotbar = [{ slot: 0, item: "minecraft:bread", count: 30 }];
    const result = await f.tools.call("eat");
    expect(result.isError).toBe(true); expect(text(result)).toContain("Meal opened CraftingScreen instead of eating");
    expect(f.state.screen).toBe("none");
    await f.body.poll(); expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(1);
  });
  test("Baritone calculation replies reset the stall timer and the last failure survives consumed events", async () => {
    const f = await fixture(); await f.tools.call("go_to", { x: 10, z: 0 });
    f.tick(3900); await appendFile(f.log, "[CHAT] [Baritone] Calculating path...\n"); await f.body.poll();
    f.body.events.consume(); f.tick(3900); await f.body.poll();
    expect(f.body.events.consume()).not.toContain("stopped_short");
    await appendFile(f.log, "[CHAT] [Baritone] No path found: goal unreachable\n"); await f.body.poll(); f.body.events.consume();
    f.tick(3999); await f.body.poll(); expect(f.body.events.consume()).not.toContain("stopped_short");
    f.tick(1); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("stopped_short distance=10");
    expect(events).toContain("baritone=No path found: goal unreachable");
    await f.tools.call("go_to", { x: 20, z: 0 }); f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("baritone=no reply observed since start");
  });
  test("mine rejects an unknown argument and a radius over 96, and reports no fixed destination", async () => {
    const f = await fixture();
    expect((await f.tools.call("mine", { block: "tall_grass", count: 6, near: 10 })).isError).toBe(true);
    const tooFar = await f.tools.call("mine", { block: "tall_grass", radius: 97 });
    expect(tooFar.isError).toBe(true); expect(text(tooFar)).toContain("radius: Number must be less than or equal to 96");
    expect(text(tooFar)).toContain("within radius blocks (default 32, max 96)");
    expect(f.requests.filter(r => r.path === "/chat")).toHaveLength(0);
    expect(text(await f.tools.call("mine", { block: "tall_grass", count: 6 }))).toContain("Started #mine 6 minecraft:tall_grass, kept within 32 blocks of here.");
    f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("distance=unknown (no fixed destination)");
  });
});

const chats = (f: Fixture) => f.requests.filter(r => r.path === "/chat").map(r => r.body.text);
const stopLines = (events: string) => events.split("\n").filter(line => line.includes(" navigation_stopped "));

describe("mine stays near where it began", () => {
  test("a body carried past the radius is stopped at once, with what it collected", async () => {
    const f = await fixture();
    f.state.pos = { x: 104.5, y: 116, z: -200.3 };
    f.state.inventory!.main = [{ slot: 0, item: "minecraft:oak_log", count: 2 }, { slot: 1, item: "minecraft:bread", count: 4 }];
    await f.tools.call("mine", { block: "oak_log", count: 8, radius: 10 });
    // Ten blocks out is still inside the radius.
    f.state.pos = { x: 114.5, y: 116, z: -200.3 }; await f.body.poll();
    expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).not.toContain("navigation_stopped");
    // Three logs and their sticks came in on the way; a bread was eaten.
    f.state.inventory!.main = [{ slot: 0, item: "minecraft:oak_log", count: 5 }, { slot: 1, item: "minecraft:bread", count: 3 }, { slot: 9, item: "minecraft:stick", count: 1 }];
    f.state.pos = { x: 115, y: 116, z: -200.3 }; await f.body.poll();
    expect(chats(f)).toEqual(["#mine 8 minecraft:oak_log", "#stop"]);
    expect(f.baritone.active).toBe(false); expect(f.body.navigation).toBeUndefined();
    expect(f.body.events.consume()).toContain("counted=3 of 8");
    // Said once: nothing more follows, and no stall is reported for the job the body ended itself.
    f.tick(5000); await f.body.poll(); await f.body.poll();
    const later = f.body.events.consume();
    expect(later).not.toContain("navigation_stopped"); expect(later).not.toContain("stopped_short");
    expect(chats(f)).toHaveLength(2);
    expect(text(await f.tools.call("status"))).toContain("Navigation: none");
  });
  test("the default radius is 32 blocks, measured in three dimensions", async () => {
    const f = await fixture(); await f.tools.call("mine", { block: "stone" });
    f.state.pos = { x: 0, y: 64 - 32, z: 0 }; await f.body.poll();
    expect(f.baritone.active).toBe(true);
    f.state.pos = { x: 4, y: 64 - 32, z: 0 }; await f.body.poll();
    expect(f.baritone.active).toBe(false);
  });
  test("a wake-up waiting for arrival is woken when the body stops the job", async () => {
    const f = await fixture(); await f.tools.call("mine", { block: "stone", radius: 5 });
    f.state.pos = { x: 6, y: 64, z: 0 }; await f.body.poll();
    expect(text(await f.tools.call("wait", { seconds: 1, for: ["arrived", "stopped_short"] }))).toContain("Waking event received.");
  });
  test("the nearest block Baritone is heading for lies past the radius: stopped before any walk, and it is named", async () => {
    // Margo's one wild flax: the only ones Baritone knew were 150 and 200 blocks off.
    const f = await fixture({ mineTargets: [[200, 70, 0], [150, 64, 0]] });
    await f.tools.call("mine", { block: "supplementaries:wild_flax", count: 1 });
    f.tick(499); await f.body.poll(); expect(chats(f)).toEqual(["#mine 1 supplementaries:wild_flax"]);
    f.tick(1); await f.body.poll(); expect(chats(f).at(-1)).toBe("#proc");
    await f.body.poll();
    expect(chats(f)).toEqual(["#mine 1 supplementaries:wild_flax", "#proc", "#stop"]);
    expect(f.baritone.active).toBe(false);
    const events = f.body.events.consume();
    expect(stopLines(events)).toEqual([
      "1 navigation_stopped goal=mine 1 supplementaries:wild_flax collected=nothing reason=no supplementaries:wild_flax left within 32 blocks of where you started (0,64,0) nearest=150,64,0, 150 blocks from where you started you=0,64,0",
    ]);
    // Baritone's answer to the body's question is read by the body and is no news for the resident.
    expect(events).not.toContain("baritone");
  });
  test("Baritone knows no such block and has begun to explore: stopped, and the place it runs from is no target", async () => {
    const f = await fixture({ mineTargets: [] });
    await f.tools.call("mine", { block: "diamond_ore", radius: 96 });
    f.tick(500); await f.body.poll(); await f.body.poll();
    expect(chats(f)).toEqual(["#mine minecraft:diamond_ore", "#proc", "#stop"]);
    expect(f.body.events.consume()).toContain("collected=nothing reason=no minecraft:diamond_ore left within 96 blocks of where you started (0,64,0) nearest=none known in the loaded chunks you=0,64,0");
  });
  test("while the nearest block is inside the radius the job goes on, asked again every three seconds", async () => {
    const f = await fixture({ mineTargets: [[20, 64, 0], [300, 64, 0]] });
    await f.tools.call("mine", { block: "stone" });
    for (let second = 0; second < 7; second++) { f.tick(1000); f.state.pos.x += 1; await f.body.poll(); }
    expect(chats(f)).toEqual(["#mine minecraft:stone", "#proc", "#proc", "#proc"]);
    expect(f.baritone.active).toBe(true);
    expect(f.body.events.consume()).toBe("Since last time:\nnone");
    // The near ones are gone; what is left is 300 blocks from the start.
    f.options.mineTargets = [[300, 64, 0]];
    f.tick(3000); f.state.pos.x += 1; await f.body.poll(); await f.body.poll();
    expect(f.baritone.active).toBe(false);
    expect(f.body.events.consume()).toContain("nearest=300,64,0, 300 blocks from where you started you=8,64,0");
  });
  test("a block known inside the radius whose path leaves it is not called none left", async () => {
    const f = await fixture({ mineTargets: [[20, 64, 0]] });
    await f.tools.call("mine", { block: "stone" });
    f.tick(500); await f.body.poll(); await f.body.poll();
    f.state.pos = { x: 0, y: 64, z: 40 }; await f.body.poll();
    expect(f.body.events.consume()).toContain("reason=the way to the next minecraft:stone led more than 32 blocks from where you started (0,64,0) nearest=20,64,0, 20 blocks from where you started you=0,64,40");
  });
  test("asking Baritone where it is heading is no sign of life: a stalled job is still reported after four seconds", async () => {
    const f = await fixture(); await f.tools.call("mine", { block: "stone" });
    f.tick(3999); await f.body.poll(); expect(chats(f).at(-1)).toBe("#proc");
    f.tick(1); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("stopped_short distance=unknown (no fixed destination)");
    expect(events).toContain("baritone=no reply observed since start");
    expect(events).not.toContain("Last command");
  });
  test("after a stall report the radius still holds while Baritone has a job", async () => {
    // A hard block outlasts the four-second stall clock; Baritone is still at work and walks on afterwards.
    const f = await fixture(); await f.tools.call("mine", { block: "obsidian", radius: 8 });
    f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("stopped_short");
    f.tick(1000); f.state.pos = { x: 9, y: 64, z: 0 }; await f.body.poll();
    expect(chats(f).at(-1)).toBe("#stop"); expect(f.baritone.active).toBe(false);
    expect(f.body.events.consume()).toContain("navigation_stopped goal=mine minecraft:obsidian collected=nothing reason=the way to the next minecraft:obsidian led more than 8 blocks from where you started (0,64,0)");
  });
  test("when Baritone says twice that it has no job left, the radius and the asking end with it", async () => {
    const f = await fixture(); await f.tools.call("mine", { block: "stone", count: 2, radius: 8 });
    f.tick(500); await f.body.poll();
    f.baritone.active = false; // It has its two and is done.
    f.tick(3000); await f.body.poll();
    f.tick(1000); await f.body.poll();
    const events = f.body.events.consume();
    expect(events).toContain("stopped_short"); expect(events).not.toContain("No process in control");
    // Where he goes afterwards is his own business.
    for (let second = 0; second < 10; second++) { f.tick(1000); f.state.pos.x += 5; await f.body.poll(); }
    expect(f.body.events.consume()).not.toContain("navigation_stopped");
  });
  test("other trips are not asked about and have no radius", async () => {
    const f = await fixture({ mineTargets: [] }); await f.tools.call("go_to", { x: 500, z: 0 });
    for (let second = 0; second < 5; second++) { f.tick(1000); f.state.pos.x += 60; await f.body.poll(); }
    expect(chats(f).filter(command => /^#(goto|proc)\b/.test(String(command)))).toEqual(["#goto 500 0"]);
    expect(f.body.events.consume()).not.toContain("navigation_stopped");
  });
});

describe("mine ends at its count by the body's own counting", () => {
  // On this client Baritone logs "Currently have 0 valid items" while holding what it mined: its count never ends the job.
  const carry = (f: Fixture, items: Record<string, number>) => { f.state.inventory!.main = Object.entries(items).map(([item, count], slot) => ({ slot, item, count })); };
  test("the block's own item is counted, not what else was picked up; then Baritone is stopped and arrival reported", async () => {
    const f = await fixture(); carry(f, { "minecraft:oak_log": 2 });
    await f.tools.call("mine", { block: "oak_log", count: 3 });
    f.tick(1000); carry(f, { "minecraft:oak_log": 4, "minecraft:stick": 1 }); await f.body.poll();
    expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).not.toContain("arrived");
    f.tick(1000); carry(f, { "minecraft:oak_log": 5, "minecraft:stick": 1 }); await f.body.poll();
    expect(chats(f)).toEqual(["#mine 3 minecraft:oak_log", "#proc", "#stop"]);
    expect(f.baritone.active).toBe(false);
    expect(f.body.events.consume()).toBe("Since last time:\n1 arrived goal=mine 3 minecraft:oak_log collected=3 x minecraft:oak_log, 1 x minecraft:stick");
    expect(f.body.navigation).toBeUndefined();
    // Done is done: no stall is reported for it and Baritone is not asked again.
    for (let second = 0; second < 8; second++) { f.tick(1000); f.state.pos.x += 10; await f.body.poll(); }
    expect(chats(f)).toHaveLength(3); expect(f.body.events.consume()).toBe("Since last time:\nnone");
  });
  test("a block that drops something else is counted in that drop alone, and the line says what else came in", async () => {
    const f = await fixture(); carry(f, { "minecraft:cobblestone": 10 });
    await f.tools.call("mine", { block: "stone", count: 2 });
    f.tick(1000); carry(f, { "minecraft:cobblestone": 11 }); await f.body.poll();
    expect(f.baritone.active).toBe(true);
    // Flint from gravel on the way is not stone: the count stays at one.
    f.tick(1000); carry(f, { "minecraft:cobblestone": 11, "minecraft:flint": 1 }); await f.body.poll();
    expect(f.baritone.active).toBe(true);
    f.tick(1000); carry(f, { "minecraft:cobblestone": 12, "minecraft:flint": 1 }); await f.body.poll();
    expect(f.baritone.active).toBe(false);
    // A wait for arrival is woken by it and shows the line.
    const woken = text(await f.tools.call("wait", { seconds: 1, for: ["arrived"] }));
    expect(woken).toBe("Waking event received.\n\nSince last time:\n1 arrived goal=mine 2 minecraft:stone collected=2 x minecraft:cobblestone, 1 x minecraft:flint");
  });
  test("what he was holding before the job began is no gain, even on a reading taken before it", async () => {
    const f = await fixture(); carry(f, { "minecraft:oak_planks": 4 }); await f.body.poll();
    // Crafted a moment before the call: the body's last reading still shows the planks.
    carry(f, { "minecraft:stick": 8 });
    await f.tools.call("mine", { block: "stone", count: 2 });
    f.tick(500); await f.body.poll();
    expect(f.baritone.active).toBe(true);
    f.tick(500); await f.body.poll();
    expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).not.toContain("arrived");
  });
  test("without a count nothing ends the job but the radius", async () => {
    const f = await fixture(); await f.tools.call("mine", { block: "stone" });
    for (let second = 1; second <= 5; second++) { f.tick(1000); f.state.pos.x += 1; carry(f, { "minecraft:cobblestone": second * 4 }); await f.body.poll(); }
    expect(f.baritone.active).toBe(true); expect(f.body.events.consume()).toBe("Since last time:\nnone");
  });
});

describe("mine of a block Baritone avoids breaking", () => {
  const lift = "#set avoidBreakingMultiplier 1", keep = "#set avoidBreakingMultiplier 0.01";
  // Vanilla ids are written without their namespace, as Baritone writes them.
  const settings = "allowBreak true\navoidBreakingMultiplier 0.01\nblocksToAvoidBreaking oak_planks,chest,furnace,crafting_table,quark:oak_chest\n";
  test("the cost is lifted before #mine and stays lifted through a stall report while Baritone has the job; its answers to #set are no news", async () => {
    const f = await fixture({ baritoneSettings: settings });
    await f.tools.call("mine", { block: "chest", count: 1 });
    expect(chats(f)).toEqual([lift, "#mine 1 minecraft:chest"]);
    f.tick(4000); await f.body.poll();
    expect(chats(f)).toEqual([lift, "#mine 1 minecraft:chest", "#proc"]);
    await f.body.poll(); f.tick(5000); await f.body.poll();
    expect(chats(f)).not.toContain(keep);
    const events = f.body.events.consume();
    // Neither an event nor the "last reply" of the job.
    expect(events).toContain("stopped_short distance=unknown (no fixed destination)");
    expect(events).toContain("baritone=no reply observed since start");
    expect(events).not.toContain("Successfully set"); expect(events).not.toContain("Old value");
  });
  test.each(["minecraft:crafting_table", "quark:oak_chest"])("%s is on the list whichever way its id is written", async block => {
    const f = await fixture({ baritoneSettings: settings });
    await f.tools.call("mine", { block });
    expect(chats(f)).toEqual([lift, `#mine ${block}`]);
  });
  test("a block that is not on the list, or no settings file, changes nothing", async () => {
    for (const f of [await fixture({ baritoneSettings: settings }), await fixture()]) {
      await f.tools.call("mine", { block: "oak_log" });
      f.tick(4000); await f.body.poll(); await f.tools.call("stop"); await f.body.poll();
      expect(chats(f).filter(sent => String(sent).startsWith("#set"))).toHaveLength(0);
    }
  });
  const endings: Record<string, (f: Fixture) => Promise<unknown>> = {
    "the stop tool": async f => { await f.tools.call("stop"); await f.body.poll(); },
    "the radius": async f => { f.state.pos = { x: 40, y: 64, z: 0 }; await f.body.poll(); },
    "its count": async f => { f.tick(1000); f.state.inventory!.main = [{ slot: 0, item: "minecraft:chest", count: 2 }]; await f.body.poll(); },
    "death": async f => { f.state.health = 0; await f.body.poll(); },
    "another trip": f => f.tools.call("go_to", { x: 5, z: 0 }),
    "shutdown": f => f.body.close(),
  };
  test.each(Object.keys(endings))("the cost is put back when the job ends by %s", async ending => {
    const f = await fixture({ baritoneSettings: settings });
    await f.tools.call("mine", { block: "chest", count: 2 });
    await f.body.poll();
    expect(chats(f)).not.toContain(keep);
    await endings[ending]!(f);
    expect(chats(f).filter(sent => sent === lift)).toHaveLength(1);
    expect(chats(f)).toContain(keep);
    // A trip that replaces the job starts with the cost already back.
    if (ending === "another trip") expect(chats(f).slice(-2)).toEqual([keep, "#goto 5 0"]);
    if (ending !== "shutdown") { await f.body.poll(); f.tick(3000); await f.body.poll(); expect(chats(f).filter(sent => sent === keep)).toHaveLength(1); }
  });
  test("one listed block mined after another keeps the cost lifted in between", async () => {
    const f = await fixture({ baritoneSettings: settings });
    await f.tools.call("mine", { block: "chest" }); await f.body.poll();
    await f.tools.call("mine", { block: "furnace" }); await f.body.poll();
    expect(chats(f)).toEqual([lift, "#mine minecraft:chest", "#mine minecraft:furnace"]);
  });
  test("a tool server killed in the middle of such a job: the next one puts the cost back when it starts", async () => {
    // Baritone wrote the lifted value to its settings file, as it does for every #set.
    const f = await fixture({ baritoneSettings: "avoidBreakingMultiplier 1.0\nblocksToAvoidBreaking chest\n" });
    await f.body.start();
    expect(chats(f)).toEqual([keep]);
    const untouched = await fixture({ baritoneSettings: settings });
    await untouched.body.start();
    expect(chats(untouched)).toEqual([]);
  });
});

describe("find_block", () => {
  const blockRequests = (f: Fixture) => f.requests.filter(r => r.path === "/blocks");
  const unreached = "This is where the blocks are as your client sees them now; whether you can get to one is not checked.";
  test("a natural block in the loaded chunks: nearest first with distance and direction, by one read that moves nothing", async () => {
    const f = await fixture({ blocks: { "minecraft:iron_ore": [[112, 119, -205], [104, 116, -190], [300, 70, -190], [104, 120, -201], [90, 116, -201], [104, 116, -140], [110, 116, -260], [104, 116, -202]] } });
    f.state.pos = { x: 104.5, y: 116, z: -200.3 };
    await f.tools.call("go_to", { x: 400, z: -200 });
    const before = f.requests.length;
    // Three of the eight are more than 32 blocks off; a bare name means minecraft:.
    expect(text(await f.tools.call("find_block", { block: "iron_ore" }))).toStartWith([
      "minecraft:iron_ore: 5 within 32 blocks of you (104,116,-201), nearest first; every chunk in that radius was searched (21):",
      "104,116,-202, 1 block north",
      "104,120,-201, 4 blocks straight up",
      "112,119,-205, 9 blocks north-east, 3 up",
      "104,116,-190, 11 blocks south",
      "90,116,-201, 14 blocks west",
      `${unreached}\n\n`,
    ].join("\n"));
    // No chat to Baritone, no key, no screen, not even a state read: the trip under way is untouched.
    expect(f.requests.slice(before).map(r => r.path)).toEqual(["/blocks"]);
    expect(f.baritone).toEqual({ active: true, paused: false }); expect(f.body.navigation?.description).toBe("goto 400 -200");
  });
  test("the radius is a sphere that includes its surface: a block one farther, across or up, is not listed", async () => {
    const f = await fixture({ blocks: { "minecraft:oak_log": [[40, 60, -30], [0, 64, 90], [0, 96, 0], [0, 97, 0], [33, 64, 0]] } });
    expect(text(await f.tools.call("find_block", { block: "oak_log", radius: 31 }))).toStartWith(
      "No minecraft:oak_log within 31 blocks of you (0,64,0); every chunk in that radius was searched (16). A larger radius (max 96) looks farther.\n\n");
    expect(text(await f.tools.call("find_block", { block: "oak_log" }))).toStartWith(
      `minecraft:oak_log: 1 within 32 blocks of you (0,64,0), nearest first; every chunk in that radius was searched (18):\n0,96,0, 32 blocks straight up\n${unreached}\n\n`);
    expect(text(await f.tools.call("find_block", { block: "oak_log", radius: 51 }))).toStartWith([
      "minecraft:oak_log: 4 within 51 blocks of you (0,64,0), nearest first; every chunk in that radius was searched (48):",
      "0,96,0, 32 blocks straight up", "0,97,0, 33 blocks straight up", "33,64,0, 33 blocks east", "40,60,-30, 50 blocks north-east, 4 down", unreached,
    ].join("\n"));
    expect(text(await f.tools.call("find_block", { block: "oak_log", radius: 96 }))).toContain("\n40,60,-30, 50 blocks north-east, 4 down\n0,64,90, 90 blocks south\n");
  });
  test("below zero on every axis the containing block is the origin and distances stay right", async () => {
    const f = await fixture({ blocks: { "minecraft:deepslate_diamond_ore": [[-16, -64, -33], [2, -60, -17], [-1, -59, -17], [-1, -60, -50]] } });
    f.state.pos = { x: -0.3, y: -60, z: -16.01 };
    expect(text(await f.tools.call("find_block", { block: "minecraft:deepslate_diamond_ore" }))).toStartWith([
      "minecraft:deepslate_diamond_ore: 3 within 32 blocks of you (-1,-60,-17), nearest first; every chunk in that radius was searched (18):",
      "-1,-59,-17, 1 block straight up",
      "2,-60,-17, 3 blocks east",
      "-16,-64,-33, 22 blocks north-west, 4 down",
      unreached,
    ].join("\n"));
  });
  test("more matches than the limit: the nearest are listed and the reply says there are more", async () => {
    const f = await fixture({ blocks: { "minecraft:stone": Array.from({ length: 10 }, (_, i): [number, number, number] => [10 - i, 64, 0]) } });
    const eight = text(await f.tools.call("find_block", { block: "stone" }));
    expect(eight).toStartWith("minecraft:stone: the 8 nearest within 32 blocks of you (0,64,0), there are more; every chunk in that radius was searched (18):\n1,64,0, 1 block east\n2,64,0, 2 blocks east\n");
    expect(eight).toContain(`\n8,64,0, 8 blocks east\n${unreached}`); expect(eight).not.toContain("9,64,0");
    expect(text(await f.tools.call("find_block", { block: "stone", limit: 2 }))).toStartWith(
      `minecraft:stone: the 2 nearest within 32 blocks of you (0,64,0), there are more; every chunk in that radius was searched (18):\n1,64,0, 1 block east\n2,64,0, 2 blocks east\n${unreached}`);
    const all = text(await f.tools.call("find_block", { block: "stone", limit: 16 }));
    expect(all).toStartWith("minecraft:stone: 10 within 32 blocks of you (0,64,0), nearest first;"); expect(all).toContain("\n10,64,0, 10 blocks east\n");
  });
  test("no match where every chunk is loaded is told apart from chunks that were never searched", async () => {
    const f = await fixture({ blocks: { "minecraft:diamond_ore": [], "minecraft:wheat": [[20, 64, 0], [-5, 64, 0]], "minecraft:carrots": [[20, 64, 0]] } });
    expect(text(await f.tools.call("find_block", { block: "diamond_ore" }))).toStartWith(
      "No minecraft:diamond_ore within 32 blocks of you (0,64,0); every chunk in that radius was searched (18). A larger radius (max 96) looks farther.\n\n");
    expect(text(await f.tools.call("find_block", { block: "diamond_ore", radius: 96 }))).toStartWith(
      "No minecraft:diamond_ore within 96 blocks of you (0,64,0); every chunk in that radius was searched (134). 96 is the largest radius: to look farther, go there first.\n\n");
    // The chunk east of his own (blocks 16..31) is not in the client: what stands there is not seen, and the reply says so.
    f.options.unloadedChunks = ["1,0"];
    expect(text(await f.tools.call("find_block", { block: "wheat" }))).toStartWith(
      `minecraft:wheat: 1 within 32 blocks of you (0,64,0), nearest first; only 17 of the 18 chunks in that radius are loaded in your client; the rest was not searched:\n-5,64,0, 5 blocks west\n${unreached}`);
    expect(text(await f.tools.call("find_block", { block: "carrots" }))).toStartWith(
      "No minecraft:carrots in the loaded chunks within 32 blocks of you (0,64,0), but only 17 of the 18 chunks in that radius are loaded in your client; the rest was not searched.\n\n");
    f.state.pos = { x: 8, y: 64, z: 8 }; f.options.unloadedChunks = ["0,0"];
    expect(text(await f.tools.call("find_block", { block: "wheat", radius: 4 }))).toStartWith(
      "Nothing was searched: no chunk within 4 blocks of you (8,64,8) is loaded in your client (1 in that radius).\n\n");
  });
  test("an id that names no block is Synapse's error; a malformed id, a radius out of range or a limit below 1 never reaches it", async () => {
    const f = await fixture({ blocks: { "minecraft:diamond_ore": [[1, 64, 0]] } });
    const item = await f.tools.call("find_block", { block: "diamond" });
    expect(item.isError).toBe(true);
    expect(text(item)).toStartWith("Error: Synapse: Unknown block id 'minecraft:diamond': no block is registered under it (an item that is not a block cannot be searched for).\n\n");
    expect(blockRequests(f)).toHaveLength(1);
    // A limit above the cap is lowered, not refused (test/limits.test.ts).
    for (const args of [{ block: "Diamond Ore" }, { block: "diamond_ore", radius: 97 }, { block: "diamond_ore", radius: 0 }, { block: "diamond_ore", limit: 0 }, { block: "diamond_ore", near: true }]) {
      expect((await f.tools.call("find_block", args)).isError).toBe(true);
    }
    expect(blockRequests(f)).toHaveLength(1);
    expect((await f.tools.call("find_block", { block: "diamond_ore", radius: 96, limit: 16 })).isError).toBe(false);
  });
  test("out of a world the search fails with Synapse's reason instead of an empty list", async () => {
    const f = await fixture({ blocks: { "minecraft:stone": [[1, 64, 0]] } }); f.setUnavailable();
    const result = await f.tools.call("find_block", { block: "stone" });
    expect(result.isError).toBe(true); expect(text(result)).toStartWith("Error: Synapse: No player in world.");
  });
});

describe("meals and idle screens", () => {
  const bread = { slot: 0, item: "minecraft:bread", count: 3 };
  /** The reflex lines of an event tail, without their sequence numbers. */
  const reflexLines = (events: string) => events.split("\n").filter(line => line.includes(" reflex ")).map(line => line.replace(/^\d+ reflex text=/, ""));
  test("at food 6 or less a screen untouched for 30 s with an empty cursor is closed for the meal, in one line", async () => {
    const f = await fixture(); f.state.food = 5; f.state.hotbar = [bread];
    f.setScreen({ screen: "FurnaceScreen" }); await f.body.poll();
    f.tick(29999); await f.body.poll();
    expect(f.state.screen).toBe("FurnaceScreen");
    expect(reflexLines(f.body.events.consume())).toEqual(["FurnaceScreen is blocking meals; close it to eat (food 5)."]);
    f.tick(1); await f.body.poll();
    expect(f.state.screen).toBe("none");
    expect(f.requests.filter(r => r.body.action === "use" && r.body.ticks === 40)).toHaveLength(1);
    f.tick(2200); await f.body.poll();
    expect(reflexLines(f.body.events.consume())).toEqual(["closed FurnaceScreen (no action for 30 s) to eat; ate minecraft:bread, food 5 -> 11."]);
  });
  test("a stack on the cursor keeps the screen open and the meal blocked, however long", async () => {
    const f = await fixture(); f.state.food = 5;
    f.setMenu("CraftingScreen", [{ ...bread, slot: 37 }], { item: "minecraft:oak_planks", count: 4 });
    await f.body.poll();
    for (let second = 0; second < 90; second++) { f.tick(1000); await f.body.poll(); }
    expect(f.state.screen).toBe("CraftingScreen"); expect(f.menu()?.carried).toEqual({ item: "minecraft:oak_planks", count: 4 });
    expect(f.requests.some(r => r.body.action === "close" || r.body.key === "ESCAPE" || r.body.action === "use")).toBe(false);
    expect(reflexLines(f.body.events.consume())).toEqual(["CraftingScreen is blocking meals; close it to eat (food 5)."]);
    // Once the stack is put down, the screen has gone untouched long enough.
    await f.tools.call("click_slot", { slot: 20 });
    f.tick(29999); await f.body.poll(); expect(f.state.screen).toBe("CraftingScreen");
    f.tick(1); await f.body.poll(); expect(f.state.screen).toBe("none");
    f.tick(2200); await f.body.poll();
    expect(f.body.events.consume()).toContain("reflex text=closed CraftingScreen (no action for 30 s) to eat; ate minecraft:bread, food 5 -> 11.");
    expect(f.state.inventory!.main.find(s => s.item === "minecraft:oak_planks")?.count).toBe(4);
  });
  const screenActions: Record<string, object> = { screen: {}, click_slot: { slot: 3 }, type_text: { text: "a" }, use: {}, craft: { item: "stick" } };
  test.each(Object.keys(screenActions))("%s within the last 30 s keeps the screen open", async tool => {
    const f = await fixture(); f.state.food = 5; f.state.hotbar = [bread];
    f.setScreen({ screen: "FurnaceScreen" }); await f.body.poll();
    f.tick(25000); await f.body.poll();
    await f.tools.call(tool, screenActions[tool]);
    f.tick(29999); await f.body.poll();
    expect(f.state.screen).toBe("FurnaceScreen"); expect(f.requests.some(r => r.body.action === "close")).toBe(false);
    f.tick(1); await f.body.poll();
    expect(f.state.screen).toBe("none");
  });
  test("above food 6, or with nothing to eat, the screen stays as it is", async () => {
    const f = await fixture(); f.state.food = 7; f.state.hotbar = [bread];
    f.setScreen({ screen: "FurnaceScreen" }); await f.body.poll();
    f.tick(60000); await f.body.poll();
    expect(f.state.screen).toBe("FurnaceScreen");
    f.state.food = 6; f.state.hotbar = []; f.state.inventory!.main = [];
    f.tick(60000); await f.body.poll(); f.tick(1000); await f.body.poll();
    expect(f.state.screen).toBe("FurnaceScreen"); expect(f.requests.some(r => r.body.action === "close")).toBe(false);
  });
  test("a screen that will not close is tried once in 30 s and the meal stays blocked", async () => {
    const f = await fixture({ closeFailures: 99, escapeBlocked: true }); f.state.food = 4; f.state.hotbar = [bread];
    f.setScreen({ screen: "FurnaceScreen" }); await f.body.poll();
    f.tick(30000); await f.body.poll();
    for (let second = 0; second < 29; second++) { f.tick(1000); await f.body.poll(); }
    expect(f.requests.filter(r => r.body.action === "close")).toHaveLength(1);
    expect(f.state.screen).toBe("FurnaceScreen"); expect(f.requests.some(r => r.body.action === "use")).toBe(false);
    expect(reflexLines(f.body.events.consume())).toEqual(["FurnaceScreen is blocking meals; close it to eat (food 4)."]);
  });
  test("the death screen is never closed for a meal", async () => {
    const f = await fixture(); f.state.food = 3; f.state.hotbar = [bread];
    f.setScreen({ screen: "DeathScreen" }); await f.body.poll();
    f.tick(60000); await f.body.poll();
    expect(f.requests.some(r => r.path === "/gui" && r.body.action !== undefined)).toBe(false);
    expect(f.state.screen).toBe("DeathScreen");
  });
  test("a refused meal after the closing still names the screen, in the one line", async () => {
    const f = await fixture({ overhead: { type: "block", block: "minecraft:oak_trapdoor", blockPos: [0, 66, 0] } });
    f.state.food = 5; f.state.hotbar = [bread];
    f.setScreen({ screen: "FurnaceScreen" }); await f.body.poll();
    f.tick(30000); await f.body.poll();
    expect(reflexLines(f.body.events.consume()).at(-1)).toBe("closed FurnaceScreen (no action for 30 s) to eat; Meal not started: minecraft:oak_trapdoor is directly overhead and the meal would use it instead. Nothing was used. Auto-eat retries in 10 s.");
  });
});

test("screen exposes empty machine inputs beside occupied menu slots", async () => {
  const f = await fixture();
  f.setScreen({
    screen: "GuiMetallurgicInfuser", title: "Metallurgic Infuser",
    container: { carried: "minecraft:air", slots: [
      { slot: 0, item: "minecraft:air", count: 0 },
      { slot: 1, item: "minecraft:redstone", count: 4 },
      { slot: 2, item: "minecraft:air", count: 0 },
      { slot: 4, item: "minecraft:iron_ingot", count: 3 },
    ] },
  });
  const reply = text(await f.tools.call("screen"));
  expect(reply).toContain("Empty slots: 0, 2");
  expect(reply).toContain("redstone");
  expect(reply).toContain("iron_ingot");
});
