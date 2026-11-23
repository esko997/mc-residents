import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readPlaces, rules, suggestions, whatNext, type Rule, type Snapshot } from "../src/ideas.ts";
import { summarizeRecipe } from "../src/knowledge/build.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import type { PlanFocus } from "../src/plan.ts";
import { createNotes } from "../src/notes.ts";
import type { Stack } from "../src/synapse.ts";
import { Tools } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function hub() {
  const value = residentHub();
  cleanups.push(() => value.close());
  return value;
}

const mc = (name: string) => `minecraft:${name}`;
const minute = 60_000, hour = 60 * minute;
const now = Date.UTC(2026, 10, 21, 12);
const overworld = mc("overworld");
const stacks = (items: Record<string, number>): Stack[] => Object.entries(items).map(([item, count], slot) => ({ slot, item, count }));
const plan = (over: Partial<PlanFocus> = {}): PlanFocus => ({ name: "wheat field", goal: "bread from my own field", total: 5, done: 1, current: { number: 2, text: "till 24 blocks by the stream" }, blocked: [], idleMs: 0, ...over });

/**
 * A resident with the basics covered: fed, armoured, an iron pickaxe, a bed, a
 * furnace and a chest saved as places, and a plan under way. No rule has
 * anything to say about it; each test takes one thing away.
 */
function settled(items: Record<string, number> = {}, over: Partial<Snapshot> = {}): Snapshot {
  return {
    now, health: 20, food: 20, pos: { x: 0.5, y: 64, z: 0.5 }, dimension: overworld,
    carried: stacks({ [mc("iron_pickaxe")]: 1, [mc("bread")]: 5, ...items }),
    armour: [{ slot: 2, item: mc("iron_chestplate"), count: 1, equip: "chest" }],
    places: [
      { name: "home", note: "my bed is here", x: 3, y: 64, z: 4, dimension: overworld },
      { name: "furnace", x: 10, y: 64, z: 0, dimension: overworld },
      { name: "home chest", x: 4, y: 64, z: 4, dimension: overworld },
    ],
    deaths: [], plan: plan(), ...over,
  };
}
const without = (snapshot: Snapshot, ...words: string[]): Snapshot => ({ ...snapshot, places: snapshot.places.filter(place => !words.some(word => `${place.name} ${place.note ?? ""}`.includes(word))) });
const said = (snapshot: Snapshot, id: string) => suggestions(snapshot).find(suggestion => suggestion.id === id)?.text;
const ids = (snapshot: Snapshot) => suggestions(snapshot).map(suggestion => suggestion.id);

// Recipe files as the game and a mod ship them, summarised and looked up by the real knowledge code.
const shaped = (key: Record<string, unknown>, pattern: string[], item: string) => ({ type: "minecraft:crafting_shaped", key, pattern, result: { item } });
const recipeFiles: Record<string, Record<string, unknown>> = {
  "minecraft:furnace": shaped({ "#": { tag: "minecraft:stone_crafting_materials" } }, ["###", "# #", "###"], mc("furnace")),
  "kits:furnace_from_kit": { type: "minecraft:crafting_shapeless", ingredients: [{ item: "kits:furnace_kit" }], result: { item: mc("furnace") } },
  "minecraft:stone_pickaxe": shaped({ "#": { item: mc("stick") }, X: { tag: "minecraft:stone_tool_materials" } }, ["XXX", " # ", " # "], mc("stone_pickaxe")),
  "minecraft:iron_pickaxe": shaped({ "#": { item: mc("stick") }, X: { item: mc("iron_ingot") } }, ["XXX", " # ", " # "], mc("iron_pickaxe")),
  "minecraft:white_bed": shaped({ "#": { item: mc("white_wool") }, X: { tag: "minecraft:planks" } }, ["###", "XXX"], mc("white_bed")),
  "minecraft:blue_bed_from_white_bed": { type: "minecraft:crafting_shapeless", ingredients: [{ item: mc("white_bed") }, { item: mc("blue_dye") }], result: { item: mc("blue_bed") } },
  "minecraft:iron_ingot_from_smelting": { type: "minecraft:smelting", ingredient: { item: mc("raw_iron") }, result: mc("iron_ingot") },
};
const tags: Record<string, string[]> = {
  "minecraft:stone_crafting_materials": [mc("cobblestone"), mc("andesite")],
  "minecraft:stone_tool_materials": [mc("cobblestone"), mc("andesite")],
  "minecraft:planks": [mc("oak_planks"), mc("spruce_planks")],
};
async function knowledge() {
  const dir = await mkdtemp(join(tmpdir(), "resident-ideas-"));
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
  cleanups.push(async () => { opened.close(); await rm(dir, { recursive: true, force: true }); });
  return opened;
}

describe("rules", () => {
  test("a resident with the basics covered gets no suggestion, said in one line after its own step", () => {
    expect(suggestions(settled())).toEqual([]);
    expect(whatNext(settled())).toBe(`Your plan "wheat field", step 2 of 5: till 24 blocks by the stream.\nNothing else to suggest: none of the ${rules.length} checks of what you carry, wear and have saved found something missing or unused.`);
  });

  test("low health with food too low to heal", () => {
    expect(said(settled({}, { health: 6, food: 12 }), "low_health")).toBe("Health 6/20 does not come back at food 12/20: it regrows only from food 18. Edible carried: 5 x minecraft:bread.");
    const hungry: Snapshot = { ...settled({}, { health: 6.5, food: 12 }), carried: stacks({ [mc("cobblestone")]: 3 }) };
    expect(said(hungry, "low_health")).toBe("Health 6.5/20 does not come back at food 12/20: it regrows only from food 18. Nothing edible is carried.");
    expect(ids(settled({}, { health: 6, food: 18 }))).not.toContain("low_health");
    expect(ids(settled({}, { health: 10, food: 12 }))).not.toContain("low_health");
  });

  test("food below 8 with nothing edible, judged by the client's edible flag when it sends one", () => {
    const empty = (items: Record<string, number>, food: number): Snapshot => ({ ...settled({}, { food }), carried: stacks(items) });
    expect(said(empty({ [mc("wheat")]: 2, [mc("cobblestone")]: 3 }, 5), "no_food")).toBe("Food 5/20 and nothing edible is carried. Wheat carried: 2 (bread takes 3).");
    expect(said(empty({ [mc("cobblestone")]: 3 }, 7), "no_food")).toBe("Food 7/20 and nothing edible is carried.");
    expect(ids(empty({ [mc("cobblestone")]: 3 }, 8))).not.toContain("no_food");
    expect(ids(settled({}, { food: 5 }))).not.toContain("no_food");
    // A modpack can make bread inedible and a stew edible; the flag decides, not the name.
    const flagged = (edible: boolean, item: string): Snapshot => ({ ...settled({}, { food: 5 }), carried: [{ slot: 0, item, count: 2, edible }] });
    expect(ids(flagged(false, mc("bread")))).toContain("no_food");
    expect(ids(flagged(true, "farmersdelight:beef_stew"))).not.toContain("no_food");
  });

  test("no bed after dying: counts the deaths of the last six hours and names what a bed is short of", () => {
    const died = (...ago: number[]) => ago.map(ms => ({ x: 1, y: 60, z: 1, dimension: overworld, at: now - ms }));
    const homeless = without(settled({ [mc("oak_planks")]: 12, [mc("white_wool")]: 1, [mc("red_wool")]: 2 }, { deaths: died(7 * hour, 2 * hour, 12 * minute, 50 * minute) }), "bed");
    expect(said(homeless, "no_bed_after_deaths")).toBe("Died 3 times in the last 6 hours, latest 12 min ago. No bed is known: none carried, no saved place mentions one. A bed sets where you come back after dying. minecraft:red_bed takes 3 minecraft:red_wool + 3 planks: short of 1 minecraft:red_wool.");
    expect(ids(homeless)).not.toContain("no_bed");
    // The store keeps five deaths, so five may be more.
    expect(said({ ...homeless, deaths: died(1 * minute, 2 * minute, 3 * minute, 4 * minute, 5 * minute) }, "no_bed_after_deaths")).toStartWith("Died 5 or more times in the last 6 hours, latest 1 min ago.");
    expect(said({ ...homeless, deaths: died(90 * minute) }, "no_bed_after_deaths")).toStartWith("Died 1 time in the last 6 hours, latest 90 min ago.");
    // A saved place that mentions a bed answers it; "bedrock" does not.
    expect(ids({ ...settled(), deaths: died(12 * minute) })).not.toContain("no_bed_after_deaths");
    expect(ids({ ...homeless, places: [{ name: "bedrock mine", x: 0, y: -60, z: 0, dimension: overworld }] })).toContain("no_bed_after_deaths");
  });

  test("no bed without recent deaths is a lesser suggestion, and a carried bed is named as unused", () => {
    const homeless = without(settled({ [mc("oak_planks")]: 3, [mc("white_wool")]: 3 }), "bed");
    expect(said(homeless, "no_bed")).toBe("No bed is known: none carried, no saved place mentions one. A bed sets where you come back after dying. minecraft:white_bed takes 3 minecraft:white_wool + 3 planks: all carried.");
    expect(ids(homeless)).not.toContain("no_bed_after_deaths");
    expect(said(without(settled({ [mc("red_bed")]: 1 }), "bed"), "no_bed")).toBe("1 x minecraft:red_bed carried and no saved place mentions a bed. A bed sets where you come back after dying once it is placed and slept in.");
    expect(ids(settled({ [mc("red_bed")]: 1 }))).not.toContain("no_bed");
  });

  test("raw ore carried with a furnace known", () => {
    const ore = { [mc("raw_iron")]: 6, [mc("raw_copper")]: 2, [mc("raw_iron_block")]: 1, [mc("coal")]: 3 };
    expect(said(settled(ore), "smelt_ore")).toBe('Raw ore carried (6 x minecraft:raw_iron, 2 x minecraft:raw_copper) and a furnace is known: place "furnace" (10,64,0), 10 blocks away. Fuel carried: 3 x minecraft:coal.');
    expect(said(without(settled({ [mc("iron_ore")]: 4, [mc("furnace")]: 1 }), "furnace"), "smelt_ore")).toBe("Raw ore carried (4 x minecraft:iron_ore) and a furnace is known: 1 x minecraft:furnace carried. Fuel carried: none.");
    const nether: Snapshot = { ...settled(ore), dimension: mc("the_nether") };
    expect(said(nether, "smelt_ore")).toContain('place "furnace" (10,64,0) in minecraft:overworld.');
    expect(ids(without(settled(ore), "furnace"))).not.toContain("smelt_ore");
    expect(ids(settled({ [mc("raw_iron_block")]: 1 }))).not.toContain("smelt_ore");
  });

  test("seeds carried and not planted, with and without a hoe", () => {
    expect(said(settled({ [mc("wheat_seeds")]: 27, [mc("stone_hoe")]: 1 }), "seeds_unplanted"))
      .toBe("27 x minecraft:wheat_seeds carried with a hoe (minecraft:stone_hoe). Seeds grow only once planted on farmland, which a hoe makes from dirt or grass within 4 blocks of water.");
    expect(said(settled({ [mc("wheat_seeds")]: 27, [mc("cobblestone")]: 2 }), "seeds_unplanted"))
      .toBe("27 x minecraft:wheat_seeds carried and no hoe. Seeds grow only on farmland, which a hoe makes from dirt or grass within 4 blocks of water. minecraft:stone_hoe takes 2 cobblestone + 2 minecraft:stick: short of 2 minecraft:stick.");
    expect(said(settled({ [mc("wheat_seeds")]: 4, [mc("beetroot_seeds")]: 2, [mc("oak_planks")]: 2, [mc("stick")]: 2 }), "seeds_unplanted"))
      .toEndWith("minecraft:wooden_hoe takes 2 planks + 2 minecraft:stick: all carried.");
    expect(ids(settled({ [mc("wheat_seeds")]: 5, [mc("stone_hoe")]: 1 }))).not.toContain("seeds_unplanted");
  });


  test("a better pickaxe than the best one carried, when the head material is on hand", () => {
    const carrying = (items: Record<string, number>): Snapshot => ({ ...settled(), carried: stacks({ [mc("bread")]: 5, ...items }) });
    expect(said(carrying({ [mc("stone_pickaxe")]: 1, [mc("wooden_pickaxe")]: 1, [mc("iron_ingot")]: 5, [mc("stick")]: 2 }), "pickaxe_upgrade"))
      .toBe("Best pickaxe carried: minecraft:stone_pickaxe. minecraft:iron_pickaxe takes 3 minecraft:iron_ingot + 2 minecraft:stick: all carried.");
    expect(said(carrying({ [mc("stone_pickaxe")]: 1, [mc("iron_ingot")]: 3, [mc("stick")]: 1 }), "pickaxe_upgrade"))
      .toBe("Best pickaxe carried: minecraft:stone_pickaxe. minecraft:iron_pickaxe takes 3 minecraft:iron_ingot + 2 minecraft:stick: short of 1 minecraft:stick.");
    expect(said(carrying({ [mc("oak_planks")]: 3, [mc("cobblestone")]: 2 }), "pickaxe_upgrade"))
      .toBe("Best pickaxe carried: none. minecraft:wooden_pickaxe takes 3 planks + 2 minecraft:stick: short of 2 minecraft:stick.");
    // The highest tier that can be made is the one named.
    expect(said(carrying({ [mc("wooden_pickaxe")]: 1, [mc("cobblestone")]: 9, [mc("diamond")]: 3, [mc("stick")]: 4 }), "pickaxe_upgrade")).toContain("minecraft:diamond_pickaxe takes 3 minecraft:diamond");
    // Silent: head material short, the tier already carried, or a pickaxe whose tier is not known.
    expect(ids(carrying({ [mc("stone_pickaxe")]: 1, [mc("iron_ingot")]: 2, [mc("stick")]: 2 }))).not.toContain("pickaxe_upgrade");
    expect(ids(carrying({ [mc("iron_pickaxe")]: 1, [mc("iron_ingot")]: 9, [mc("cobblestone")]: 9, [mc("stick")]: 2 }))).not.toContain("pickaxe_upgrade");
    expect(ids(carrying({ "mekanism:osmium_pickaxe": 1, [mc("iron_ingot")]: 9, [mc("stick")]: 2 }))).not.toContain("pickaxe_upgrade");
  });

  test("enough cobblestone for a furnace and none known", () => {
    expect(said(without(settled({ [mc("cobblestone")]: 12 }), "furnace"), "no_furnace"))
      .toBe("No furnace is known: none carried, no saved place mentions one. minecraft:furnace takes 8 cobblestone: all carried. A furnace cooks meat and smelts ore.");
    expect(ids(without(settled({ [mc("cobblestone")]: 7 }), "furnace"))).not.toContain("no_furnace");
    expect(ids(settled({ [mc("cobblestone")]: 12 }))).not.toContain("no_furnace");
    expect(ids(without(settled({ [mc("cobblestone")]: 12, [mc("furnace")]: 1 }), "furnace"))).not.toContain("no_furnace");
  });

  test("no armour worn", () => {
    expect(said(settled({ [mc("iron_ingot")]: 5 }, { armour: [] }), "no_armour"))
      .toBe("No armour is worn (0 of 4 pieces) and none is carried. Carried: 5 minecraft:iron_ingot, 0 minecraft:leather. Boots take 4, a helmet 5, leggings 7, a chestplate 8 of one of them.");
    expect(said(settled({ [mc("iron_helmet")]: 1, [mc("leather_boots")]: 1 }, { armour: [] }), "no_armour"))
      .toBe("No armour is worn (0 of 4 pieces). Carried but not worn: 1 x minecraft:iron_helmet, 1 x minecraft:leather_boots. use with a piece in hand puts it on.");
    expect(ids(settled({ [mc("iron_ingot")]: 5 }))).not.toContain("no_armour");
  });

  test("an inventory nearly full with no chest place saved", () => {
    const filler = (kinds: number) => Object.fromEntries(Array.from({ length: kinds }, (_, i) => [`test:thing_${i}`, 64]));
    // settled() carries two stacks of its own.
    expect(said(without(settled({ ...filler(30), [mc("oak_planks")]: 5 }), "chest"), "inventory_full"))
      .toBe("Inventory: 33 of 36 slots used and no saved place mentions a chest. minecraft:chest takes 8 planks: short of 3 planks.");
    expect(said(without(settled({ ...filler(32), [mc("chest")]: 2 }), "chest"), "inventory_full"))
      .toBe("Inventory: 35 of 36 slots used and no saved place mentions a chest. 2 x minecraft:chest carried.");
    expect(ids(without(settled(filler(30)), "chest"))).not.toContain("inventory_full");
    expect(ids(settled(filler(34)))).not.toContain("inventory_full");
  });

});

describe("recipes from the modpack's knowledge", () => {
  test("tags count toward a recipe; without knowledge the vanilla recipe written in the rule is used", async () => {
    const mixed = without(settled({ [mc("cobblestone")]: 5, [mc("andesite")]: 3 }), "furnace");
    expect(ids(mixed)).not.toContain("no_furnace");
    expect(said({ ...mixed, knowledge: await knowledge() }, "no_furnace"))
      .toBe("No furnace is known: none carried, no saved place mentions one. minecraft:furnace takes 8 #minecraft:stone_crafting_materials: all carried. A furnace cooks meat and smelts ore.");
    expect(ids({ ...without(settled({ [mc("cobblestone")]: 5, [mc("andesite")]: 2 }), "furnace"), knowledge: await knowledge() })).not.toContain("no_furnace");
  });

  test("of several recipes for one item, the one the inventory comes closest to is named", async () => {
    const kit = { ...without(settled({ "kits:furnace_kit": 1, [mc("cobblestone")]: 2 }), "furnace"), knowledge: await knowledge() };
    expect(said(kit, "no_furnace")).toContain("minecraft:furnace takes 1 kits:furnace_kit: all carried.");
    const stone = { ...without(settled({ [mc("cobblestone")]: 8 }), "furnace"), knowledge: await knowledge() };
    expect(said(stone, "no_furnace")).toContain("minecraft:furnace takes 8 #minecraft:stone_crafting_materials: all carried.");
  });

  test("one ingredient short is named with the recipe's own ids", async () => {
    const known = await knowledge();
    const carrying = (items: Record<string, number>): Snapshot => ({ ...settled(), carried: stacks(items), knowledge: known });
    expect(said(carrying({ [mc("andesite")]: 3 }), "pickaxe_upgrade"))
      .toBe("Best pickaxe carried: none. minecraft:stone_pickaxe takes 3 #minecraft:stone_tool_materials + 2 minecraft:stick: short of 2 minecraft:stick.");
    expect(said(carrying({ [mc("stone_pickaxe")]: 1, [mc("iron_ingot")]: 3, [mc("stick")]: 2 }), "pickaxe_upgrade"))
      .toBe("Best pickaxe carried: minecraft:stone_pickaxe. minecraft:iron_pickaxe takes 3 minecraft:iron_ingot + 2 minecraft:stick: all carried.");
    // Beds: only white is in this knowledge; the other colours fall back to their vanilla recipe.
    const homeless = (items: Record<string, number>) => without(carrying(items), "bed");
    // A tag is shown with one item it holds, so the name says what to look for.
    expect(said(homeless({ [mc("white_wool")]: 3, [mc("spruce_planks")]: 2 }), "no_bed")).toEndWith("minecraft:white_bed takes 3 minecraft:white_wool + 3 #minecraft:planks: short of 1 #minecraft:planks (such as minecraft:oak_planks).");
    expect(said(homeless({ [mc("red_wool")]: 3, [mc("spruce_planks")]: 3 }), "no_bed")).toEndWith("minecraft:red_bed takes 3 minecraft:red_wool + 3 planks: all carried.");
    // Dyeing a white bed blue takes two items, a bed from wool six: with nothing carried the wool recipe is still the one named.
    expect(said(homeless({ [mc("cobblestone")]: 1 }), "no_bed")).toEndWith("minecraft:white_bed takes 3 minecraft:white_wool + 3 #minecraft:planks: short of 3 minecraft:white_wool and 3 #minecraft:planks (such as minecraft:oak_planks).");
  });

  test("an item the knowledge has no crafting recipe for falls back to the vanilla recipe", async () => {
    const filler = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`test:thing_${i}`, 64]));
    const full = { ...without(settled({ ...filler, [mc("oak_planks")]: 8 }), "chest"), knowledge: await knowledge() };
    expect(said(full, "inventory_full")).toBe("Inventory: 34 of 36 slots used and no saved place mentions a chest. minecraft:chest takes 8 planks: all carried.");
  });
});

describe("what_next reply", () => {
  /** Much is wrong at once: nine rules have something to say. */
  const troubled = (): Snapshot => {
    const filler = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`test:thing_${i}`, 64]));
    return {
      now, health: 6, food: 5, pos: { x: 0.5, y: 64, z: 0.5 }, dimension: overworld,
      carried: stacks({ ...filler, [mc("wheat_seeds")]: 27, [mc("stone_pickaxe")]: 1, [mc("iron_ingot")]: 3, [mc("raw_iron")]: 4, [mc("furnace")]: 1 }),
      armour: [], places: [], deaths: [{ x: 1, y: 60, z: 1, dimension: overworld, at: now - 12 * minute }],
      plan: plan({ idleMs: 45 * minute }),
    };
  };

  test("the most useful come first, and survival comes before comfort", () => {
    expect(ids(troubled())).toEqual(["low_health", "no_food", "no_bed_after_deaths", "smelt_ore", "seeds_unplanted", "plan_stalled", "pickaxe_upgrade", "no_armour", "inventory_full"]);
    expect(rules.map(rule => rule.id)).toContain("no_furnace");
    expect(new Set(rules.map(rule => rule.id)).size).toBe(rules.length);
  });

  test("the resident's own current step is the first line, then at most five suggestions", () => {
    const lines = whatNext(troubled()).split("\n");
    expect(lines[0]).toBe('Your plan "wheat field", step 2 of 5: till 24 blocks by the stream.');
    expect(lines).toHaveLength(6);
    expect(lines.slice(1).map(line => line.slice(0, 3))).toEqual(["1. ", "2. ", "3. ", "4. ", "5. "]);
    expect(lines[1]).toBe("1. Health 6/20 does not come back at food 5/20: it regrows only from food 18. Nothing edible is carried.");
    expect(lines[5]).toStartWith("5. 27 x minecraft:wheat_seeds carried and no hoe.");
    expect(lines.join("\n")).not.toContain("No step of plan");
  });

  test("a plan with only blocked steps left says so in the first line", () => {
    const stuck = settled({}, { plan: plan({ current: undefined, blocked: [{ number: 3, text: "plant the seeds", note: "no water nearby" }] }) });
    expect(whatNext(stuck).split("\n")[0]).toBe('Your plan "wheat field" has no step todo or doing; step 3 of 5 is blocked: no water nearby.');
  });

  test("closed actions prompt outcome verification rather than a new project", () => {
    const criterion = "A harvest for both residents is stored";
    const snapshot = settled({}, { plan: plan({ current: undefined, blocked: [], awaitingVerification: true, done_when: criterion }) });
    const first = whatNext(snapshot).split("\n")[0]!;
    expect(first).toContain(criterion);
    expect(first).toContain("plan_finish");
    expect(ids(snapshot)).not.toContain("no_plan");
  });

  test("the reply stays within 1,300 characters by leaving out the least useful suggestions", () => {
    const long = (id: string, priority: number, length: number): Rule => ({ id, priority, suggest: () => `${id} ${"x".repeat(length)}`.slice(0, length) });
    const table = [long("c", 1, 290), long("a", 5, 290), long("e", 0, 10), long("b", 4, 500), long("d", 2, 290)];
    const text = whatNext(settled({}, { plan: plan({ current: { number: 2, text: "t".repeat(120) } }) }), table);
    expect(text.length).toBeLessThanOrEqual(1300);
    const lines = text.split("\n");
    // In order of use; b is cut to 300 characters; c would pass 1,300, and the short e after it does not jump the queue.
    expect(lines.slice(1).map(line => line.slice(0, 4))).toEqual(["1. a", "2. b", "3. d"]);
    expect(lines[2]).toHaveLength(303); expect(lines[2]).toEndWith("…");
    expect(whatNext(settled(), [long("a", 1, 2000)], 200).length).toBeLessThanOrEqual(200);
    // The real rules with long modded ids stay inside it too.
    const modded = troubled();
    modded.carried = modded.carried.map(stack => stack.item.startsWith("test:") ? stack : { ...stack, item: `some_long_mod_namespace:${"very_long_".repeat(6)}${stack.item.slice(10)}` });
    expect(whatNext({ ...modded, plan: plan({ current: { number: 2, text: "t".repeat(120) }, idleMs: 45 * minute }) }).length).toBeLessThanOrEqual(1300);
  });
});

describe("what_next through the body", () => {
  const reply = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n").split("\n\nSince last time:")[0]!;

  test("reads inventory, armour, saved places, recorded deaths and the plan in focus", async () => {
    const f = await fixture(hub().identity());
    f.state.health = 20; f.state.food = 20;
    f.state.inventory!.main = stacks({ [mc("wheat_seeds")]: 27, [mc("stone_hoe")]: 1, [mc("bread")]: 2 });
    f.state.inventory!.armor = [{ slot: 2, item: mc("iron_chestplate"), count: 1, equip: "chest" }];
    await f.tools.notes.recordDeath({ x: 5, y: 60, z: 5 }, overworld);
    await f.tools.call("plan_set", { name: "wheat field", goal: "bread", why: "renewable shared food", done_when: "harvest and replant the field", steps: ["make a hoe", "till 24 blocks by the stream"] });
    await f.tools.call("plan_step", { step: 1, state: "done" });
    expect(reply(await f.tools.call("what_next"))).toBe([
      'Your plan "wheat field", step 2 of 2: till 24 blocks by the stream.',
      "1. Died 1 time in the last 6 hours, latest 0 min ago. No bed is known: none carried, no saved place mentions one. A bed sets where you come back after dying. minecraft:white_bed takes 3 minecraft:white_wool + 3 planks: short of 3 minecraft:white_wool and 3 planks.",
      "2. 27 x minecraft:wheat_seeds carried with a hoe (minecraft:stone_hoe). Seeds grow only once planted on farmland, which a hoe makes from dirt or grass within 4 blocks of water.",
    ].join("\n"));

    // What the place tools save is what the rules read: a bed place answers the first suggestion.
    await f.tools.call("place_save", { name: "home", note: "bed and door", x: 8, y: 64, z: 8 });
    const after = reply(await f.tools.call("what_next"));
    expect(after).not.toContain("No bed is known");
    expect(after.split("\n")).toHaveLength(2);
  });

  test("the knowledge the tool server was given is used", async () => {
    const f = await fixture(hub().identity());
    const tools = new Tools(f.body, await knowledge());
    cleanups.push(() => tools.close());
    f.state.inventory!.main = stacks({ [mc("cobblestone")]: 5, [mc("andesite")]: 3, [mc("bread")]: 2, [mc("iron_pickaxe")]: 1 });
    f.state.inventory!.armor = [{ slot: 2, item: mc("iron_chestplate"), count: 1, equip: "chest" }];
    await tools.call("place_save", { name: "bed" });
    await tools.call("plan_set", { name: "house", goal: "a roof", why: "safe settlement", done_when: "lit enclosed room usable overnight", steps: ["collect planks"] });
    expect(reply(await tools.call("what_next"))).toBe([
      'Your plan "house", step 1 of 1: collect planks.',
      "1. No furnace is known: none carried, no saved place mentions one. minecraft:furnace takes 8 #minecraft:stone_crafting_materials: all carried. A furnace cooks meat and smelts ore.",
    ].join("\n"));
  });

  test("own and hub places and deaths are read as saved; a broken private file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-ideas-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const shared = hub();
    const notes = (name: string) => createNotes({ residentDir: join(dir, name), residentName: name, commons: shared.identity(name).client, position: async () => ({ x: 1.5, y: 64, z: -2.5, dimension: overworld }), now: () => now });
    await notes("Gary").place_save({ name: "furnace", note: "by the door" });
    await notes("Margo").place_save({ name: "village bed", x: 40, y: 70, z: 9, shared: true });
    await notes("Gary").recordDeath({ x: 5.2, y: 60, z: 5.9 }, overworld);
    expect(await readPlaces(join(dir, "Gary"), shared.identity().client)).toEqual({
      places: [{ name: "furnace", note: "by the door", x: 1, y: 64, z: -3, dimension: overworld }, { name: "village bed", x: 40, y: 70, z: 9, dimension: overworld }],
      deaths: [{ x: 5, y: 60, z: 5, dimension: overworld, at: now }],
    });
    expect(await readPlaces(join(dir, "Margo"), shared.identity("Margo").client)).toEqual({ places: [{ name: "village bed", x: 40, y: 70, z: 9, dimension: overworld }], deaths: [] });
    await writeFile(join(dir, "Gary", "places.json"), "{ broken");
    expect((await readPlaces(join(dir, "Gary"), shared.identity().client)).places.map(place => place.name)).toEqual(["village bed"]);
  });

  test("without an inventory from the client it says so instead of guessing", async () => {
    const f = await fixture(hub().identity());
    f.state.inventory = undefined;
    const result = await f.tools.call("what_next");
    expect(result.isError).toBe(true);
    expect(reply(result)).toBe("Error: Synapse did not provide inventory.");
  });
});
