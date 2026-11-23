import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openKnowledge } from "../src/knowledge/index.ts";
import type { Knowledge, ModFacts } from "../src/knowledge/types.ts";
import { modsReply, packKinds, placeMod } from "../src/mods.ts";
import { rules, suggestions, type PackKinds, type Snapshot } from "../src/ideas.ts";
import { Tools } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";
import { buildPackFixture } from "./pack-fixture.ts";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
/** A mod as the export would describe it; tests set only what they are about. */
const mod = (over: Partial<ModFacts> & { id: string }): ModFacts => ({
  name: over.id, description: "", side: "both", jar: `${over.id}.jar`, requires: [], requiredBy: [], items: 0, blocks: 0, guns: 0, ammo: 0, attachments: 0,
  recipes: 0, recipeTypes: [], biomes: 0, structures: 0, worldgen: 0, tabs: [], books: [], stations: [], signature: [], words: [], ...over,
});
const fakeKnowledge = (list: ModFacts[] | undefined): Knowledge => ({
  findItems: () => [], recipesFor: () => [], usesOf: () => [], itemsInTag: () => [], searchGuides: () => [], close() {},
  modList: () => list, modOf: () => undefined, modItems: () => ({ items: [], total: 0 }),
});

describe("mods replies over a pack built from jars", () => {
  let dir = "";
  let knowledge: Knowledge;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "resident-mods-"));
    knowledge = openKnowledge(await buildPackFixture(dir));
  });
  afterAll(async () => { knowledge?.close(); await rm(dir, { recursive: true, force: true }); });

  test("overview: kinds with their mods; libraries and client-only mods counted, not named", () => {
    const reply = modsReply(knowledge, {});
    expect(reply).toContain("machines and power (1): Machina");
    expect(reply).toContain("guns (1): Guns Zero");
    expect(reply).toContain("world generation (1): Terrain Plus");
    expect(reply).toContain("plus 2 libraries and client-side helpers");
    expect(reply).toContain("Information, not a to-do list.");
    expect(reply).not.toContain("Shiny Shaders");
    expect(reply).not.toMatch(/\bLib\b/);
    expect(modsReply(knowledge, { query: "libraries" })).toMatch(/Libraries other mods need \(1\): Lib[\s\S]*Client-side only[^:]*\(1\): Shiny Shaders/);
  });
  test("one kind: a line per mod with what it adds, its book and where its tab starts", () => {
    expect(modsReply(knowledge, { query: "machines" })).toContain("- Machina (machina): Machines that grind stone into gravel. 6 items (2 blocks among them); book: Machina Manual; its tab starts with Tin Ingot.");
    expect(modsReply(knowledge, { query: "guns" })).toContain("- Guns Zero (tacz): 1 item (1 block among them), 1 gun, 1 kind of ammo and 0 attachments in its gun pack; a first craft: Gun Smith Table.");
  });
  test("one mod: tab start with its recipe and what it opens, first craft, book, items, needs, handles to look further", () => {
    const reply = modsReply(knowledge, { query: "Machina" });
    expect(reply.startsWith("Machina (machina), machines and power.")).toBe(true);
    expect(reply).toContain('Its advancement tab "Machina" (3 advancements) starts with "Shiny": Tin Ingot (machina:tin_ingot), 1x machina:tin_ore -> 1x machina:tin_ingot (smelting). That opens: Grind Time.');
    expect(reply).toContain("A first craft, 1 step from things found in the world: Gear (machina:gear), 4x minecraft:iron_ingot -> 1x machina:gear (crafting_shaped).");
    expect(reply).toContain('Book: Machina Manual (item patchouli:guide_book holding this book); its 1 indexed pages answer guide {query:"<topic>", section:"books"}.');
    expect(reply).toContain("Some of its items: Grinder (machina:grinder), Tin Nugget (machina:tin_nugget), Circuit (machina:circuit), Tin Ore (machina:tin_ore).");
    expect(reply).toContain("Needs: lib.");
    expect(reply).toContain('recipes/uses machina:tin_ingot show how it fits; mods {query:"@machina"} lists its 6 items.');
    expect(modsReply(knowledge, { query: "guns zero" })).toContain("Guns Zero (tacz), guns.");
  });
  test("@mod lists its items by name, narrowed by words; unknown names say so", () => {
    expect(modsReply(knowledge, { query: "@machina tin" })).toBe("Machina: 3 items matching \"tin\", by name. recipes/uses take any id below.\nTin Ingot (machina:tin_ingot)\nTin Nugget (machina:tin_nugget)\nTin Ore (machina:tin_ore) [block]");
    expect(modsReply(knowledge, { query: "@tacz" })).toContain("Rifle One (tacz:rifle) [gun]");
    expect(modsReply(knowledge, { query: "@nobody" })).toBe('No installed mod matches "@nobody". mods lists them.');
    expect(modsReply(knowledge, { query: "@machina", page: 2 })).toBe("Machina: 6 items, by name. recipes/uses take any id below.\nNo page 2; there is 1 page.");
    expect(modsReply(knowledge, { query: "zeppelins" })).toContain('No installed mod or kind matches "zeppelins". Kinds: storage, tools, guns');
  });
  test("recipes and uses name the mod an item comes from; the base game is not named", async () => {
    const f = await fixture(); const tools = new Tools(f.body, knowledge);
    expect(tools.registeredNames).toContain("mods");
    expect(text(await tools.call("recipes", { item: "machina:gear" }))).toContain('From Machina (mods {query:"machina"}).\nminecraft:crafting_shaped');
    expect(text(await tools.call("uses", { item: "machina:gear" }))).toContain("From Machina");
    expect(text(await tools.call("uses", { item: "minecraft:iron_ingot" }))).not.toContain("From ");
    expect(text(await tools.call("mods", { query: "terrain" }))).toContain("Adds 2 biomes, 1 structure.");
  });
});

describe("mods without the overview, and sorting new mods", () => {
  test("an export built before the overview asks for a rebuild; without a database the tool is not offered", async () => {
    expect(modsReply(fakeKnowledge(undefined), {})).toContain("predates the mod overview");
    const f = await fixture();
    expect(f.tools.registeredNames).not.toContain("mods");
  });
  test("a mod the corrections never heard of is sorted from its own data", () => {
    const kind = (facts: ModFacts) => { const placement = placeMod(facts); return placement.kind === "listed" ? placement.category.id : placement.reason; };
    expect(kind(mod({ id: "satchels", description: "Leather satchels and bags to carry more.", items: 12, recipes: 12, words: ["satchel", "bag"] }))).toBe("storage");
    expect(kind(mod({ id: "boomsticks", items: 30, guns: 25, recipes: 30 }))).toBe("guns");
    expect(kind(mod({ id: "wands", description: "Cast spells with mana.", items: 40, recipes: 40 }))).toBe("magic");
    expect(kind(mod({ id: "valleys", description: "Deeper valleys.", worldgen: 120, biomes: 6 }))).toBe("world");
    expect(kind(mod({ id: "fabric_thing_v1", jar: "fabric-api.jar!thing.jar" }))).toBe("library");
    expect(kind(mod({ id: "prettier", side: "client", items: 5 }))).toBe("client-side");
    expect(kind(mod({ id: "fastgame", description: "Improves rendering performance." }))).toBe("technical");
    expect(kind(mod({ id: "corelib", description: "Shared code.", requiredBy: ["satchels"] }))).toBe("library");
  });
  test("long kinds page with every line whole and each page within the reply budget", () => {
    const list = Array.from({ length: 40 }, (_, i) => mod({ id: `deco${String(i).padStart(2, "0")}`, description: `Furniture and decoration blocks, set number ${i}, in many woods and colours.`, items: 100 + i, blocks: 90, recipes: 100 }));
    const knowledge = fakeKnowledge(list);
    const first = modsReply(knowledge, { query: "building" });
    const second = modsReply(knowledge, { query: "building", page: 2 });
    expect(first.length).toBeLessThanOrEqual(1300);
    expect(second.length).toBeLessThanOrEqual(1300);
    expect(first).toMatch(/Page 1 of \d+; more with query "building", page 2\./);
    expect(first).toContain("- deco00 (deco00): Furniture and decoration blocks, set number 0, in many woods and colours. 100 items (90 blocks among them).");
    const shown = (reply: string) => reply.match(/^- deco\d+/gm) ?? [];
    expect(shown(second)[0]).not.toBe(shown(first)[0]);
    expect(new Set([...shown(first), ...shown(second)]).size).toBe(shown(first).length + shown(second).length);
    expect(modsReply(knowledge, { query: "building", page: 99 })).toContain("No page 99");
  });
});

describe("what_next names kinds of mods nothing carried comes from", () => {
  const pack: PackKinds = {
    kinds: [{ name: "guns", mods: 2 }, { name: "magic", mods: 2 }, { name: "machines and power", mods: 7 }, { name: "storage and carrying", mods: 4 }],
    kindOf: item => ({ "sophisticatedbackpacks:backpack": "storage and carrying", "mekanism:ingot_osmium": "machines and power" } as Record<string, string>)[item],
  };
  const snapshot = (items: string[], over: Partial<Snapshot> = {}): Snapshot => ({
    now: 0, health: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, dimension: "minecraft:overworld",
    carried: items.map((item, slot) => ({ slot, item, count: 1 })), armour: [], places: [], deaths: [], pack, ...over,
  });
  const only = rules.filter(rule => rule.id === "mod_kinds");
  test("lists the untouched kinds and points at mods, without telling what to do", () => {
    const [found] = suggestions(snapshot(["minecraft:bread", "sophisticatedbackpacks:backpack"]), only);
    expect(found?.text).toBe("None of what you carry or wear comes from these kinds of installed mods: guns; magic; machines and power. mods describes each kind.");
  });
  test("says nothing once fewer than three kinds are untouched, or without the overview", () => {
    expect(suggestions(snapshot(["sophisticatedbackpacks:backpack", "mekanism:ingot_osmium"]), only)).toEqual([]);
    expect(suggestions(snapshot(["minecraft:bread"], { pack: undefined }), only)).toEqual([]);
  });
  test("packKinds counts listed mods per kind and maps an item to its mod's kind", () => {
    const knowledge = fakeKnowledge([mod({ id: "boomsticks", guns: 3, items: 3 }), mod({ id: "lib", jar: "x.jar!lib.jar" })]);
    const kinds = packKinds({ ...knowledge, modOf: item => (item.startsWith("boomsticks:") ? { id: "boomsticks", name: "Boomsticks" } : undefined) })!;
    expect(kinds.kinds).toEqual([{ name: "guns", mods: 1 }]);
    expect(kinds.kindOf("boomsticks:rifle")).toBe("guns");
    expect(kinds.kindOf("minecraft:bread")).toBeUndefined();
  });
});
