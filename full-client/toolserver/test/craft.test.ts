import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { summarizeRecipe } from "../src/knowledge/build.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import { Tools } from "../src/tools.ts";
import { fixture, type FakeOptions, type FakeRecipe, type Fixture } from "./fake-synapse.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
const mc = (name: string) => `minecraft:${name}`;

// Recipe files as the game ships them; the knowledge database is built from these by the real summarizer.
const shaped = (key: Record<string, unknown>, pattern: string[], item: string, count = 1) => ({ type: "minecraft:crafting_shaped", key, pattern, result: { item, count } });
const recipeFiles: Record<string, Record<string, unknown>> = {
  "minecraft:stick": shaped({ "#": { tag: "minecraft:planks" } }, ["#", "#"], mc("stick"), 4),
  "minecraft:stick_from_bamboo_item": shaped({ "#": { item: mc("bamboo") } }, ["#", "#"], mc("stick")),
  "minecraft:furnace": shaped({ "#": { tag: "minecraft:stone_crafting_materials" } }, ["###", "# #", "###"], mc("furnace")),
  "minecraft:torch": shaped({ "#": { item: mc("stick") }, X: [{ item: mc("coal") }, { item: mc("charcoal") }] }, ["X", "#"], mc("torch"), 4),
  "minecraft:cake": shaped({ A: { item: mc("milk_bucket") }, B: { item: mc("sugar") }, C: { item: mc("wheat") }, E: { item: mc("egg") } }, ["AAA", "BEB", "CCC"], mc("cake")),
  "minecraft:lever": shaped({ "#": { item: mc("cobblestone") }, X: { item: mc("stick") } }, ["   ", " X ", " # "], mc("lever")),
  "minecraft:oak_planks": { type: "minecraft:crafting_shapeless", ingredients: [{ tag: "minecraft:oak_logs" }], result: { item: mc("oak_planks"), count: 4 } },
  "minecraft:flint_and_steel": { type: "minecraft:crafting_shapeless", ingredients: [{ item: mc("iron_ingot") }, { item: mc("flint") }], result: { item: mc("flint_and_steel") } },
  "minecraft:iron_ingot_from_smelting": { type: "minecraft:smelting", ingredient: { item: mc("raw_iron") }, result: mc("iron_ingot") },
  "minecraft:chest": shaped({ "#": { tag: "minecraft:planks" } }, ["###", "# #", "###"], mc("chest")),
  "quark:building/crafting/chests/chest_revert": { type: "minecraft:crafting_shapeless", ingredients: [{ tag: "quark:revertable_chests" }], result: { item: mc("chest") } },
};
const tags: Record<string, string[]> = {
  "minecraft:planks": [mc("oak_planks"), mc("spruce_planks")],
  "minecraft:stone_crafting_materials": [mc("cobblestone"), mc("andesite")],
  "minecraft:oak_logs": [mc("oak_log"), mc("stripped_oak_log")],
  "quark:revertable_chests": ["quark:oak_chest", "quark:birch_chest", "quark:spruce_chest", "quark:cherry_chest"],
};
function knowledge(dir: string) {
  const path = join(dir, "knowledge.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE items (id TEXT, name TEXT);
    CREATE TABLE recipes (id TEXT, type TEXT, summary TEXT);
    CREATE TABLE recipe_outputs (recipe TEXT, what TEXT);
    CREATE TABLE recipe_inputs (recipe TEXT, what TEXT);
    CREATE TABLE tag_items (tag TEXT, item TEXT);
    CREATE VIRTUAL TABLE guides USING fts5(book, title, text);
  `);
  for (const [id, file] of Object.entries(recipeFiles)) {
    const summary = summarizeRecipe(id, file);
    db.query("INSERT INTO recipes VALUES (?, ?, ?)").run(id, summary.type, JSON.stringify(summary));
    for (const output of summary.outputs) db.query("INSERT INTO recipe_outputs VALUES (?, ?)").run(id, output.what);
    for (const input of summary.inputs) db.query("INSERT INTO recipe_inputs VALUES (?, ?)").run(id, input.what);
  }
  for (const [tag, items] of Object.entries(tags)) for (const item of items) db.query("INSERT INTO tag_items VALUES (?, ?)").run(tag, item);
  db.close();
  const opened = openKnowledge(path);
  cleanups.push(() => opened.close());
  return opened;
}

// What the fake server crafts. A row of two oak planks is a pressure plate and a
// lone plank is a button, so a pattern laid the wrong way round shows the wrong thing.
const planks = tags["minecraft:planks"]!, stone = tags["minecraft:stone_crafting_materials"]!;
const serverRecipes: FakeRecipe[] = [
  { shaped: [[planks], [planks]], output: { item: mc("stick"), count: 4 } },
  { shaped: [[[mc("bamboo")]], [[mc("bamboo")]]], output: { item: mc("stick"), count: 1 } },
  { shaped: [[[mc("oak_planks")], [mc("oak_planks")]]], output: { item: mc("oak_pressure_plate"), count: 1 } },
  { shaped: [[planks]], output: { item: mc("oak_button"), count: 1 } },
  { shaped: [[stone, stone, stone], [stone, null, stone], [stone, stone, stone]], output: { item: mc("furnace"), count: 1 } },
  { shaped: [[[mc("coal"), mc("charcoal")]], [[mc("stick")]]], output: { item: mc("torch"), count: 4 } },
  { shaped: [[[mc("stick")]], [[mc("cobblestone")]]], output: { item: mc("lever"), count: 1 } },
  { shaped: [[[mc("milk_bucket")], [mc("milk_bucket")], [mc("milk_bucket")]], [[mc("sugar")], [mc("egg")], [mc("sugar")]], [[mc("wheat")], [mc("wheat")], [mc("wheat")]]], output: { item: mc("cake"), count: 1 } },
  { shapeless: [tags["minecraft:oak_logs"]!], output: { item: mc("oak_planks"), count: 4 } },
  { shapeless: [[mc("iron_ingot")], [mc("flint")]], output: { item: mc("flint_and_steel"), count: 1 } },
  // Quark hands out a chest of the wood it is made from.
  { shaped: [[[mc("spruce_planks")], [mc("spruce_planks")], [mc("spruce_planks")]], [[mc("spruce_planks")], null, [mc("spruce_planks")]], [[mc("spruce_planks")], [mc("spruce_planks")], [mc("spruce_planks")]]], output: { item: "quark:spruce_chest", count: 1 } },
];
async function crafter(options: FakeOptions = {}, waitMs = 2000) {
  const f = await fixture({ recipes: serverRecipes, ...options });
  const tools = new Tools(f.body, knowledge(f.dir));
  tools.craftWaitMs = waitMs;
  return { f, tools };
}
/** The player's stacks before any screen is open: hotbar 0..8, main inventory 9..35. */
function carry(f: Fixture, ...stacks: [slot: number, count: number, item: string][]) {
  f.state.inventory!.main = stacks.map(([slot, count, item]) => ({ slot, count, item }));
}
/** Everything in the open menu: what sits in the output and grid, what is on the cursor, and inventory totals. */
function menu(f: Fixture) {
  const open = f.menu();
  if (!open) return undefined;
  const cells = open.kind === "CraftingScreen" ? 9 : 4;
  const inventory: Record<string, number> = {};
  for (const stack of open.slots) if (stack.slot > (open.kind === "CraftingScreen" ? 9 : 8)) inventory[stack.item] = (inventory[stack.item] ?? 0) + stack.count;
  return { screen: open.kind, cursor: open.carried?.item, grid: open.slots.filter(stack => stack.slot <= cells).map(stack => `${stack.slot}: ${stack.count} x ${stack.item}`), inventory };
}
const clicks = (f: Fixture) => f.requests.filter(request => request.body.action === "clickSlot").length;

describe("craft", () => {
  test("sticks with no screen open: opens the inventory, lays the column and takes the four sticks", async () => {
    // The output slot answers a few reads late, as it does through a real server.
    const { f, tools } = await crafter({ resultDelayReads: 5 });
    carry(f, [9, 5, mc("oak_planks")]);
    const result = await tools.call("craft", { item: "stick" });
    expect(text(result)).toContain("Crafted 4 x minecraft:stick (recipe minecraft:stick) using 2 x minecraft:oak_planks; you now have 4.");
    expect(result.isError).toBe(false);
    expect(menu(f)).toEqual({ screen: "InventoryScreen", cursor: undefined, grid: [], inventory: { [mc("oak_planks")]: 3, [mc("stick")]: 4 } });
  });
  test("a #tag ingredient takes any item in the tag, across stacks and repeated crafts", async () => {
    const { f, tools } = await crafter();
    carry(f, [0, 3, mc("stick")], [9, 3, mc("oak_planks")], [20, 3, mc("spruce_planks")], [21, 9, mc("oak_log")]);
    const result = await tools.call("craft", { item: "minecraft:stick", count: 3 });
    expect(text(result)).toContain("Crafted 12 x minecraft:stick");
    expect(text(result)).toContain("you now have 15.");
    expect(menu(f)).toEqual({ screen: "InventoryScreen", cursor: undefined, grid: [], inventory: { [mc("stick")]: 15, [mc("oak_log")]: 9 } });
  });
  test("a furnace at a crafting table opened with use", async () => {
    const { f, tools } = await crafter();
    carry(f, [0, 5, mc("cobblestone")], [20, 4, mc("cobblestone")], [21, 2, mc("dirt")]);
    f.state.lookingAt = { type: "block", block: mc("crafting_table"), blockPos: [1, 64, 1] };
    expect(text(await tools.call("use", {}))).toContain("CraftingScreen opened");
    const result = await tools.call("craft", { item: "furnace" });
    expect(text(result)).toContain("Crafted 1 x minecraft:furnace (recipe minecraft:furnace) using 8 x minecraft:cobblestone; you now have 1.");
    expect(text(result)).toContain("CraftingScreen stays open");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("cobblestone")]: 1, [mc("dirt")]: 2, [mc("furnace")]: 1 } });
  });
  test("a mod's own version of the item is taken and named, as the game made it", async () => {
    const { f, tools } = await crafter();
    carry(f, [0, 8, mc("spruce_planks")]);
    f.state.lookingAt = { type: "block", block: mc("crafting_table"), blockPos: [1, 64, 1] };
    await tools.call("use", {});
    const result = await tools.call("craft", { item: "chest" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("quark:spruce_chest");
    expect(menu(f)?.inventory).toEqual({ "quark:spruce_chest": 1 });
  });
  test("different chest variants in successive crafts retain both output totals", async () => {
    const { f, tools } = await crafter({ recipes: [
      { shapeless: [["quark:oak_chest"]], output: { item: "quark:spruce_chest", count: 1 } },
      { shapeless: [["quark:birch_chest"]], output: { item: "quark:cherry_chest", count: 1 } },
    ] });
    carry(f, [0, 1, "quark:oak_chest"], [1, 1, "quark:birch_chest"]);
    const result = await tools.call("craft", { item: "chest", count: 2 });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("1 x quark:spruce_chest");
    expect(text(result)).toContain("1 x quark:cherry_chest");
    expect(menu(f)?.inventory).toEqual({ "quark:spruce_chest": 1, "quark:cherry_chest": 1 });
  });
  test.each(["minecraft:trapped_chest", "unknown:chest", "unknown:birch_chest"])("similar output %s is not accepted as an ordinary chest", async output => {
    const { f, tools } = await crafter({ recipes: [{
      shapeless: [["quark:oak_chest"]], output: { item: output, count: 1 },
    }] }, 100);
    carry(f, [0, 1, "quark:oak_chest"]);
    expect((await tools.call("craft", { item: "chest" })).isError).toBe(true);
    expect(f.state.inventory!.main.map(({ item, count }) => ({ item, count }))).toEqual([{ count: 1, item: "quark:oak_chest" }]);
  });
  test("an ingredient with alternatives uses the one you have (charcoal torches)", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 2, mc("charcoal")], [10, 6, mc("stick")]);
    expect(text(await tools.call("craft", { item: "torch", count: 2 }))).toContain("Crafted 8 x minecraft:torch");
    expect(menu(f)?.inventory).toEqual({ [mc("stick")]: 4, [mc("torch")]: 8 });
  });
  test("the first recipe you have the ingredients for, then shapeless recipes in the same open inventory", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 1, mc("stripped_oak_log")], [10, 1, mc("flint")], [11, 1, mc("iron_ingot")], [12, 2, mc("bamboo")]);
    expect(text(await tools.call("craft", { item: "stick" }))).toContain("Crafted 1 x minecraft:stick (recipe minecraft:stick_from_bamboo_item) using 2 x minecraft:bamboo");
    expect(text(await tools.call("craft", { item: "oak_planks" }))).toContain("Crafted 4 x minecraft:oak_planks (recipe minecraft:oak_planks) using 1 x minecraft:stripped_oak_log");
    expect(text(await tools.call("craft", { item: "flint_and_steel" }))).toContain("Crafted 1 x minecraft:flint_and_steel (recipe minecraft:flint_and_steel) using 1 x minecraft:iron_ingot + 1 x minecraft:flint");
    expect(menu(f)).toEqual({ screen: "InventoryScreen", cursor: undefined, grid: [], inventory: { [mc("flint_and_steel")]: 1, [mc("oak_planks")]: 4, [mc("stick")]: 1 } });
  });
  test("a pattern with blank borders still fits the 2x2 grid", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 1, mc("stick")], [10, 1, mc("cobblestone")]);
    expect(text(await tools.call("craft", { item: "lever" }))).toContain("Crafted 1 x minecraft:lever");
    expect(menu(f)?.inventory).toEqual({ [mc("lever")]: 1 });
  });
  test("what a craft leaves in the grid is put away before the next one and at the end", async () => {
    const { f, tools } = await crafter({ remainders: { [mc("milk_bucket")]: mc("bucket") } });
    f.setMenu("CraftingScreen", [
      ...[10, 11, 12, 13, 14, 15].map(slot => ({ slot, count: 1, item: mc("milk_bucket") })),
      { slot: 20, count: 4, item: mc("sugar") }, { slot: 21, count: 2, item: mc("egg") }, { slot: 22, count: 6, item: mc("wheat") },
    ]);
    const result = await tools.call("craft", { item: "cake", count: 2 });
    expect(text(result)).toContain("Crafted 2 x minecraft:cake");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("bucket")]: 6, [mc("cake")]: 2 } });
  });
  test("stacks already in the grid are moved back first and can be the ingredients", async () => {
    const { f, tools } = await crafter();
    f.setMenu("CraftingScreen", [{ slot: 2, count: 2, item: mc("oak_planks") }, { slot: 9, count: 1, item: mc("dirt") }]);
    expect(text(await tools.call("craft", { item: "stick" }))).toContain("Crafted 4 x minecraft:stick");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("dirt")]: 1, [mc("stick")]: 4 } });
  });
  test("shift-click on the output doing nothing falls back to carrying the result over", async () => {
    const { f, tools } = await crafter({ quickMoveResultWorks: false }, 100);
    carry(f, [9, 2, mc("spruce_planks")]);
    expect(text(await tools.call("craft", { item: "stick" }))).toContain("Crafted 4 x minecraft:stick");
    expect(menu(f)).toEqual({ screen: "InventoryScreen", cursor: undefined, grid: [], inventory: { [mc("stick")]: 4 } });
  });

  test("missing ingredients are named and nothing is clicked", async () => {
    const { f, tools } = await crafter();
    f.setMenu("CraftingScreen", [{ slot: 10, count: 3, item: mc("cobblestone") }, { slot: 40, count: 2, item: mc("oak_planks") }]);
    const furnace = await tools.call("craft", { item: "furnace" });
    expect(furnace.isError).toBe(true);
    expect(text(furnace)).toContain("Not enough ingredients for 1 x recipe minecraft:furnace: you need 5 more #minecraft:stone_crafting_materials (it takes 8). Nothing was moved.");
    const sticks = await tools.call("craft", { item: "stick", count: 3 });
    expect(text(sticks)).toContain("Not enough ingredients for 3 x recipe minecraft:stick: you need 4 more #minecraft:planks (it takes 6).");
    expect(clicks(f)).toBe(0);
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("cobblestone")]: 3, [mc("oak_planks")]: 2 } });
  });
  test("missing ingredients with no screen open: the inventory it opened is closed again", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 1, mc("oak_planks")]);
    const result = await tools.call("craft", { item: "stick" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("you need 1 more #minecraft:planks (it takes 2). Nothing was moved. Closed your inventory again.");
    expect(clicks(f)).toBe(0); expect(f.state.screen).toBe("none");
  });
  test("an output that never appears leaves the grid and cursor empty and the ingredients in the inventory", async () => {
    const { f, tools } = await crafter({ resultWorks: false }, 100);
    f.setMenu("CraftingScreen", [{ slot: 10, count: 5, item: mc("cobblestone") }, { slot: 45, count: 5, item: mc("andesite") }]);
    const result = await tools.call("craft", { item: "furnace" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Crafted nothing with recipe minecraft:furnace: the output slot showed nothing, not minecraft:furnace");
    expect(text(result)).toContain("The grid and your cursor are empty");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("cobblestone")]: 5, [mc("andesite")]: 5 } });
  });
  test("an output that never appears in the inventory it opened: ingredients kept, inventory closed again", async () => {
    const { f, tools } = await crafter({ resultWorks: false }, 100);
    carry(f, [9, 5, mc("oak_planks")]);
    const result = await tools.call("craft", { item: "stick" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Closed your inventory again.");
    expect(f.state.screen).toBe("none");
    expect(f.state.inventory!.main).toEqual([{ slot: 9, count: 5, item: mc("oak_planks") }]);
  });
  test("a different item in the output slot is never taken", async () => {
    const { f, tools } = await crafter({ recipes: [{ shaped: [[planks], [planks]], output: { item: mc("oak_door"), count: 3 } }] }, 100);
    carry(f, [9, 5, mc("oak_planks")]);
    const result = await tools.call("craft", { item: "stick" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("the output slot showed 3 x minecraft:oak_door, not minecraft:stick");
    expect(f.state.inventory!.main).toEqual([{ slot: 9, count: 5, item: mc("oak_planks") }]);
  });
  test("a click that does not land stops the craft with nothing on the cursor or in the grid", async () => {
    const { f, tools } = await crafter({ deadSlots: [2] });
    f.setMenu("CraftingScreen", [{ slot: 30, count: 8, item: mc("cobblestone") }]);
    const result = await tools.call("craft", { item: "furnace" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("placing one minecraft:cobblestone in grid slot 2 left nothing there");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("cobblestone")]: 8 } });
  });
  test("a stack on the cursor is refused untouched", async () => {
    const { f, tools } = await crafter();
    f.setMenu("CraftingScreen", [{ slot: 10, count: 4, item: mc("oak_planks") }], { item: mc("wooden_pickaxe"), count: 1 });
    const result = await tools.call("craft", { item: "stick" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Your cursor holds minecraft:wooden_pickaxe");
    expect(clicks(f)).toBe(0);
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: mc("wooden_pickaxe"), grid: [], inventory: { [mc("oak_planks")]: 4 } });
  });
  test("a 3x3 recipe without a crafting table says to use one and opens nothing", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 8, mc("cobblestone")]);
    const closed = await tools.call("craft", { item: "furnace" });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain("minecraft:furnace needs a 3x3 grid: look at a crafting table and use it");
    expect(f.state.screen).toBe("none");
    await tools.call("open_inventory");
    expect(text(await tools.call("craft", { item: "furnace" }))).toContain("needs a 3x3 grid: close your inventory, look at a crafting table");
    expect(clicks(f)).toBe(0);
  });
  test("a missing ingredient is named for the recipe that was meant, not a mod's one-slot conversion", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 5, mc("oak_planks")]);
    const short = await tools.call("craft", { item: "chest" });
    expect(text(short)).toContain("Not enough ingredients for 1 x recipe minecraft:chest: you need 3 more #minecraft:planks (it takes 8). It also needs a 3x3 grid, so a crafting table.");
    carry(f, [9, 5, mc("oak_planks")], [10, 3, mc("spruce_planks")]);
    expect(text(await tools.call("craft", { item: "chest" }))).toContain("minecraft:chest needs a 3x3 grid (recipe minecraft:chest) and you carry the ingredients: look at a crafting table");
    expect(clicks(f)).toBe(0);
  });
  test("other screens are refused by name, and items without a crafting recipe say so", async () => {
    const { f, tools } = await crafter();
    f.setScreen({ screen: "FurnaceScreen", container: { slots: [{ slot: 3, count: 8, item: mc("oak_planks") }], carried: "minecraft:air" } });
    const furnace = await tools.call("craft", { item: "stick" });
    expect(furnace.isError).toBe(true);
    expect(text(furnace)).toContain("not in FurnaceScreen");
    f.setScreen({ screen: "none" });
    const smelted = await tools.call("craft", { item: "iron_ingot" });
    expect(smelted.isError).toBe(true);
    expect(text(smelted)).toContain("No crafting-grid recipe for minecraft:iron_ingot");
    expect(f.state.screen).toBe("none");
    expect(clicks(f)).toBe(0);
  });
  test("count is 1..16 crafts and unknown arguments are rejected", async () => {
    const { f, tools } = await crafter();
    carry(f, [9, 64, mc("oak_planks")]);
    expect((await tools.call("craft", { item: "stick", count: 17 })).isError).toBe(true);
    expect((await tools.call("craft", { item: "stick", quantity: 4 })).isError).toBe(true);
    expect(f.state.screen).toBe("none");
  });
  test("without a knowledge database the tool is not offered", async () => {
    const f = await fixture();
    expect(f.tools.registeredNames).not.toContain("craft");
    expect(text(await f.tools.call("craft", { item: "stick" }))).toContain("Knowledge unavailable");
    expect(f.state.screen).toBe("none");
  });
});

const realDb = resolve(import.meta.dir, "../../../.cache/knowledge.sqlite");
(existsSync(realDb) ? describe : describe.skip)("craft with the real modpack knowledge", () => {
  test("sticks, a furnace and charcoal torches use recipes the game accepts", async () => {
    const f = await fixture({ recipes: serverRecipes });
    const real = openKnowledge(realDb);
    cleanups.push(() => real.close());
    const tools = new Tools(f.body, real);
    f.setMenu("CraftingScreen", [{ slot: 10, count: 2, item: mc("oak_planks") }, { slot: 11, count: 8, item: mc("cobblestone") }, { slot: 12, count: 1, item: mc("charcoal") }]);
    expect(text(await tools.call("craft", { item: "stick" }))).toContain("Crafted 4 x minecraft:stick (recipe minecraft:stick)");
    expect(text(await tools.call("craft", { item: "furnace" }))).toContain("Crafted 1 x minecraft:furnace");
    expect(text(await tools.call("craft", { item: "torch" }))).toContain("Crafted 4 x minecraft:torch");
    expect(menu(f)).toEqual({ screen: "CraftingScreen", cursor: undefined, grid: [], inventory: { [mc("stick")]: 3, [mc("furnace")]: 1, [mc("torch")]: 4 } });
  });
});
