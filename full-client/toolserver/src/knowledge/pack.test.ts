import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledge } from "./index";
import { modsFromFabric, modsFromToml } from "./pack";
import { parseToml } from "./toml";
import { criteriaItems, withoutComments } from "./build";
import type { Knowledge, ModFacts } from "./types";
import { buildPackFixture } from "../../test/pack-fixture";

describe("mod metadata", () => {
  test("[[mods]] tables, multi-line descriptions, required dependencies and client-only mods", () => {
    const mods = modsFromToml(`modLoader="javafml" # comment
[[mods]]
modId="alpha"
displayName="Alpha \\"A\\""
description='''
First line,
second line.
'''
displayTest="IGNORE_SERVER_VERSION"
[[mods]]
modId='beta'
[[dependencies.alpha]]
    modId="beta"
    mandatory=true
[[dependencies.alpha]]
    modId="gamma"
    mandatory=false
[[dependencies.beta]]
    modId="delta"
    type="required"
`);
    expect(mods).toEqual([
      { id: "alpha", name: 'Alpha "A"', description: "First line, second line.", clientOnly: true, requires: ["beta"] },
      { id: "beta", name: "beta", description: "", clientOnly: false, requires: ["delta"] },
    ]);
  });
  test("inline mods arrays (Moog's jars) and Fabric metadata", () => {
    expect(modsFromToml("mods = [\n\t{ modId = 'mvs', displayName = \"Moog's Voyager\", description = 'Structures!' },\n]\n").map(mod => [mod.id, mod.name, mod.description]))
      .toEqual([["mvs", "Moog's Voyager", "Structures!"]]);
    expect(modsFromFabric(JSON.stringify({ id: "pretty", name: "Pretty", environment: "client", depends: { fabricloader: "*" } })))
      .toEqual([{ id: "pretty", name: "Pretty", description: "", clientOnly: true, requires: ["fabricloader"] }]);
    expect(() => parseToml("[[mods]\nmodId=1")).toThrow();
  });
  test("gun-pack comments go, strings holding // stay; advancement criteria name items", () => {
    expect(JSON.parse(withoutComments('{ // a\n "url": "https://x.org/y", /* b */ "n": 1 }'))).toEqual({ url: "https://x.org/y", n: 1 });
    expect(criteriaItems({
      a: { trigger: "minecraft:inventory_changed", conditions: { items: [{ items: ["mod:a", "b"] }, { tag: "forge:ingots" }] } },
      b: { trigger: "minecraft:consume_item", conditions: { item: { items: "mod:c" } } },
      c: { trigger: "minecraft:tick" },
    })).toEqual(["mod:a", "minecraft:b", "mod:c"]);
  });
});

describe("pack overview built from jars", () => {
  let dir = "";
  let knowledge: Knowledge;
  let mods: Map<string, ModFacts>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "resident-pack-"));
    knowledge = openKnowledge(await buildPackFixture(dir));
    mods = new Map(knowledge.modList!()!.map(mod => [mod.id, mod]));
  });
  afterAll(async () => { knowledge?.close(); await rm(dir, { recursive: true, force: true }); });

  test("every mod is listed with its metadata, including a nested jar's mod and a Fabric one", () => {
    expect([...mods.keys()].sort()).toEqual(["inner", "lib", "machina", "minecraft", "outer", "shiny", "tacz", "terrain", "tinbags"]);
    const machina = mods.get("machina")!;
    expect(machina).toMatchObject({ name: "Machina", description: "Machines that grind stone into gravel.", side: "both", jar: "machina.jar", requires: ["lib"] });
    expect(mods.get("lib")!.requiredBy).toEqual(["machina"]);
    expect(mods.get("shiny")!.side).toBe("client");
    expect(mods.get("inner")).toMatchObject({ jar: "outer.jar!inner.jar", items: 1, blocks: 1 });
    expect(mods.get("terrain")).toMatchObject({ name: "Terrain Plus", biomes: 2, structures: 1, worldgen: 4, items: 0 });
  });
  test("counts registered items only: a model without a name, or a name without a model, is not an item", () => {
    const machina = mods.get("machina")!;
    expect(machina).toMatchObject({ items: 6, blocks: 2, recipes: 6, recipeTypes: ["machina:grinding"] });
    expect(knowledge.modItems!("machina", "", 0, 50).items.map(item => item.id)).not.toContain("machina:gear_spinning");
  });
  test("an optional dependency is not an installed mod: its compat recipe is left out", () => {
    expect(knowledge.recipesFor("absent_optional:thing")).toEqual([]);
  });
  test("tab start skips nuggets-into-ingot and takes the smelting recipe; it records what the advancement opens", () => {
    const start = mods.get("machina")!.tabStart!;
    expect(start).toMatchObject({ id: "machina:tin_ingot", name: "Tin Ingot", advancement: "Shiny" });
    expect(start.recipe.type).toBe("minecraft:smelting");
    // The hidden advancement stays hidden, as on the advancement screen.
    expect(start.leadsTo).toEqual([{ title: "Grind Time", item: "machina:grinder" }]);
    expect(mods.get("machina")!.tabs).toEqual([{ title: "Machina", description: "About advancement.machina.root", advancements: 3, first: ["Shiny"] }]);
  });
  test("first craft: fewest steps from the world, then the most used; the block named like its recipe type is the station", () => {
    const machina = mods.get("machina")!;
    expect(machina.firstCraft).toMatchObject({ id: "machina:gear", name: "Gear", steps: 1 });
    expect(machina.firstCraft!.recipe.inputs).toEqual([{ what: "minecraft:iron_ingot", count: 4 }]);
    expect(machina.stations.map(station => station.id)).toEqual(["machina:grinder"]);
    // The nugget's own uses come through the one-item #forge:nuggets/tin tag.
    expect(machina.signature.map(item => item.id)).toEqual(["machina:grinder", "machina:tin_nugget", "machina:circuit", "machina:tin_ore"]);
  });
  test("an add-on's way in counts the steps its parent's parts and machines take, and prefers the namesake to a busier part", () => {
    // Frame is the most used and made only of Machina parts, which a namespace rule would call "nothing from the
    // mod"; it is four steps out (grit needs Machina's grinder). Upgrade Base ties with the Tin Bag on steps.
    const tinbags = mods.get("tinbags")!;
    expect(tinbags.firstCraft).toMatchObject({ id: "tinbags:tin_bag", name: "Tin Bag", steps: 3 });
    expect(tinbags.firstCraft!.recipe.type).toBe("tinbags:bag_crafting");
    expect(mods.get("machina")!.requiredBy).toEqual(["tinbags"]);
  });
  test("a Patchouli book is found with its item and searchable pages", () => {
    expect(mods.get("machina")!.books).toEqual([{ id: "machina:manual", name: "Machina Manual", item: "patchouli:guide_book", pages: 1 }]);
  });
  test("TaCZ gun-pack guns and ammo are items with names and gun-smith recipes", () => {
    const tacz = mods.get("tacz")!;
    expect(tacz).toMatchObject({ items: 3, guns: 1, ammo: 1, attachments: 0, description: "" });
    expect(tacz.firstCraft?.id).toBe("tacz:gun_smith_table");
    expect(tacz.signature.map(item => item.name)).toContain("Rifle One");
    expect(knowledge.findItems("Rifle One").map(item => item.id)).toEqual(["tacz:rifle"]);
    const [recipe] = knowledge.recipesFor("tacz:rifle");
    expect(recipe?.inputs).toEqual([{ what: "#forge:ingots/iron", count: 20 }]);
    expect(recipe?.note).toContain("made at the Gun Smith Table (tacz:gun_smith_table); carried as tacz:modern_kinetic_gun with GunId tacz:rifle");
  });
  test("items by mod, like JEI's @mod search: names first, words narrow, pages continue", () => {
    expect(knowledge.modItems!("machina", "", 0, 3)).toEqual({ total: 6, items: [
      { id: "machina:circuit", name: "Circuit", kind: "item" },
      { id: "machina:gear", name: "Gear", kind: "item" },
      { id: "machina:grinder", name: "Grinder", kind: "block" },
    ] });
    expect(knowledge.modItems!("machina", "", 3, 3).items.map(item => item.id)).toEqual(["machina:tin_ingot", "machina:tin_nugget", "machina:tin_ore"]);
    expect(knowledge.modItems!("machina", "tin ore", 0, 10).items.map(item => item.id)).toEqual(["machina:tin_ore"]);
    expect(knowledge.modItems!("tacz", "rifle", 0, 10).items).toEqual([{ id: "tacz:rifle", name: "Rifle One", kind: "gun" }]);
    expect(knowledge.modOf!("machina:gear")).toEqual({ id: "machina", name: "Machina" });
    expect(knowledge.modOf!("nobody:thing")).toBeUndefined();
  });
});
