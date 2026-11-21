import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Body } from "../src/body.ts";
import { Events, parseLogLine } from "../src/events.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import { Synapse } from "../src/synapse.ts";
import { Tools, definitions } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";

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
  test("exact goto command and immediate return", async () => {
    const f = await fixture();
    expect(text(await f.tools.call("go_to", { x: 135, z: -180 }))).toContain("Started #goto 135 -180.");
    expect(f.requests.find(r => r.path === "/chat")?.body).toEqual({ text: "#goto 135 -180" });
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
    expect(f.requests.filter(r => r.path === "/chat").map(r => r.body.text)).toEqual(["#mine 3 minecraft:iron_ore", "#follow player Levi", "#explore", "#stop"]);
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
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 1, item: "minecraft:oak_sign" }]; f.state.lookingAt = { type: "block", block: "minecraft:stone" };
    expect(text(await f.tools.call("write_sign", { lines: ["Gary", "lives here"] }))).toContain("editor closed (Done)");
    expect(f.requests.filter(r => r.path === "/gui" && r.body.action).map(r => r.body)).toEqual([{ action: "keys", text: "Gary" }, { action: "key", key: "ENTER" }, { action: "keys", text: "lives here" }, { action: "clickButton", index: 0 }]);
  });
  test("use reports what was in hand, what it was used on, and whether a screen opened", async () => {
    const f = await fixture(); f.state.hotbar = [{ slot: 0, count: 4, item: "minecraft:oak_planks" }]; f.state.selectedSlot = 0;
    f.state.lookingAt = { type: "miss" };
    expect(text(await f.tools.call("use", {}))).toContain("Used minecraft:oak_planks on nothing in reach (air, or more than about 4.5 blocks away); no screen opened.");
    f.state.lookingAt = { type: "block", block: "minecraft:crafting_table", blockPos: [109, 120, -209] };
    expect(text(await f.tools.call("use", {}))).toContain("on minecraft:crafting_table at 109,120,-209; CraftingScreen opened.");
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
  test("unreachable and not-in-world are one-line errors", async () => {
    const f = await fixture(); f.setUnavailable(); const result = text(await f.tools.call("status"));
    expect(result).toStartWith("Error: Synapse: No player in world.\n\nSince last time:"); expect(result).not.toContain(" at ");
    const offline = new Tools(new Body(f.body.config, new Synapse("http://127.0.0.1:1", "test")));
    expect(text(await offline.call("status"))).toContain("Synapse unreachable");
  });
  test("all tool text stays below 1500 characters with full inventory and event burst", async () => {
    const f = await fixture(); f.state.inventory!.main = Array.from({ length: 36 }, (_, slot) => ({ slot, count: 64, item: `mekanism:very_long_modded_material_stack_${slot}` }));
    const argumentsByTool: Record<string, unknown> = {
      wait: { seconds: 1 }, go_to: { x: 10, z: 10 }, mine: { block: "minecraft:stone" },
      follow: { player: "Levi" }, say: { text: "hello" }, look: { yaw: 0, pitch: 0 },
      use: { hold_ticks: 10 }, attack: { hold_ticks: 10 }, select_hotbar: { slot: 0 },
      eat: { item: "minecraft:bread" }, click_slot: { slot: 0 }, click_button: { index: 0 },
      type_text: { text: "hello" }, press_key: { key: "ENTER" }, write_sign: { lines: ["hello"] },
      find_item: { query: "bread" }, recipes: { item: "minecraft:bread" }, uses: { item: "minecraft:bread" },
      guide: { query: "bread" }, craft: { item: "minecraft:bread" }, note_difficulty: { text: "test" },
    };
    for (const tool of Object.keys(definitions)) {
      f.state.hotbar = [{ slot: 0, item: tool === "write_sign" ? "minecraft:oak_sign" : "minecraft:bread", count: 2 }];
      f.state.food = 8; f.state.selectedSlot = 0; f.state.lookingAt = { type: "block", block: "minecraft:stone" };
      f.setScreen(tool === "write_sign" || tool === "eat" ? { screen: "none" } : { screen: "InventoryScreen", container: { slots: f.state.inventory!.main, carried: "minecraft:air" } });
      for (let i = 0; i < 20; i++) f.body.events.add("chat", { from: "spesk01", text: "a".repeat(500) });
      const result = await f.tools.call(tool, argumentsByTool[tool] ?? {});
      if (!["find_item", "recipes", "craft", "uses", "guide"].includes(tool)) expect(result.isError).toBe(false);
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
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, "../src/main.ts")], stderr: "pipe",
    env: { CLIENT_LOG: f.log, RESIDENT_NAME: "Gary", RESIDENT_DIR: f.dir, SYNAPSE_TOKEN_FILE: tokenFile, SYNAPSE_URL: f.body.config.url, KNOWLEDGE_DB: join(f.dir, "missing.sqlite") },
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
    expect(events).toContain("stopped_short distance=10 baritone=No path found: goal unreachable");
    await f.tools.call("go_to", { x: 20, z: 0 }); f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("baritone=no reply observed since start");
  });
  test("mine rejects an unsupported near radius and reports no fixed destination", async () => {
    const f = await fixture();
    expect((await f.tools.call("mine", { block: "tall_grass", count: 6, near: 10 })).isError).toBe(true);
    await f.tools.call("mine", { block: "tall_grass", count: 6 }); f.tick(4000); await f.body.poll();
    expect(f.body.events.consume()).toContain("distance=unknown (no fixed destination)");
  });
});
