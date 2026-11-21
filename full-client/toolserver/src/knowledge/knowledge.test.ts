import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { buildKnowledge, conditionAllows, plainText, summarizeRecipe } from "./build";
import { openKnowledge } from "./index";

const cache = resolve(import.meta.dir, "../../../../.cache");
const dbPath = join(cache, "knowledge.sqlite");
const haveInputs = existsSync(join(cache, "mods")) && existsSync(join(cache, "minecraft-1.20.1-client.jar"))
  && existsSync(join(cache, "forge-1.20.1-47.4.10-universal.jar"));
if (!haveInputs) console.warn("SKIP real knowledge tests: .cache/mods, vanilla client jar, and Forge universal jar are required.");
if (haveInputs && !existsSync(dbPath)) throw new Error("Real cache inputs exist; build .cache/knowledge.sqlite before running knowledge tests.");

(haveInputs ? describe : describe.skip)("real modpack knowledge", () => {
  const knowledge = haveInputs ? openKnowledge(dbPath) : undefined;
  afterAll(() => knowledge?.close());
  test("English item names, including osmium", () => {
    expect(knowledge!.findItems("osmium ingot").map((item) => item.id)).toContain("mekanism:ingot_osmium");
  });
  test("furnace recipe retains its exact three by three grid", () => {
    const recipe = knowledge!.recipesFor("minecraft:furnace").find((recipe) => recipe.type === "minecraft:crafting_shaped");
    expect(recipe?.pattern).toEqual([
      ["#minecraft:stone_crafting_materials", "#minecraft:stone_crafting_materials", "#minecraft:stone_crafting_materials"],
      ["#minecraft:stone_crafting_materials", null, "#minecraft:stone_crafting_materials"],
      ["#minecraft:stone_crafting_materials", "#minecraft:stone_crafting_materials", "#minecraft:stone_crafting_materials"],
    ]);
    expect(recipe?.inputs).toEqual([{ what: "#minecraft:stone_crafting_materials", count: 8 }]);
  });
  test("modded recipes and iron's indirect tag uses", () => {
    expect(knowledge!.recipesFor("mekanism:ingot_osmium").length).toBeGreaterThan(0);
    expect(knowledge!.usesOf("minecraft:iron_ingot", 500).some((recipe) => recipe.inputs.some((part) => part.what === "#forge:ingots/iron"))).toBe(true);
  });
  test("osmium prioritizes direct vanilla recipes over tagged machine outputs", () => {
    const recipes = knowledge!.recipesFor("mekanism:ingot_osmium", 3);
    expect(recipes).toHaveLength(3);
    for (const recipe of recipes) {
      expect(recipe.type.startsWith("minecraft:")).toBe(true);
      expect(recipe.outputs.some((output) => output.what === "mekanism:ingot_osmium")).toBe(true);
    }
  });
  test("nested vanilla tags are resolved", () => {
    expect(knowledge!.itemsInTag("minecraft:planks")).toContain("minecraft:oak_planks");
  });
  test("Nature's Aura ancient trees text and translated Occultism text are searchable", () => {
    const hits = knowledge!.searchGuides("Ancient Trees");
    expect(hits.some((hit) => hit.where.startsWith("naturesaura:book / Ancient Trees"))).toBe(true);
    const occultism = knowledge!.searchGuides("Foliot", 100).filter((hit) => hit.where.startsWith("occultism:"));
    expect(occultism.length).toBeGreaterThan(0);
    for (const hit of [...hits, ...occultism]) {
      expect(hit.excerpt.length).toBeLessThanOrEqual(360);
      expect(hit.excerpt).not.toMatch(/\$\(|§[a-z0-9]|book\.occultism/);
    }
  });
  test("empty and punctuation-only searches, literal FTS text, limits", () => {
    expect(knowledge!.findItems(" ")).toEqual([]);
    expect(knowledge!.searchGuides('"()')).toEqual([]);
    expect(() => knowledge!.searchGuides('"Foliot" OR *')).not.toThrow();
    expect(knowledge!.findItems("ingot", 0)).toEqual([]);
  });
});

describe("recipe and guide boundaries", () => {
  test("nested counts, gases, fluids, and stonecutting string result count", () => {
    expect(summarizeRecipe("test:chemistry", {
      type: "test:chemistry", itemInput: { amount: 4, ingredient: { tag: "forge:dusts/gold" } },
      leftInput: { amount: 10, gas: "test:gas" }, fluidInput: { fluid: "minecraft:water", amount: 100 },
      output: { count: 2, base_ingredient: { tag: "forge:ingots/gold" } },
    })).toMatchObject({
      inputs: [{ what: "#forge:dusts/gold", count: 4 }, { what: "test:gas", count: 10 }, { what: "minecraft:water", count: 100 }],
      outputs: [{ what: "#forge:ingots/gold", count: 2 }],
    });
    expect(summarizeRecipe("test:cut", { type: "minecraft:stonecutting", result: "test:block", count: 4 }).outputs)
      .toEqual([{ what: "test:block", count: 4 }]);
  });
  test("three-valued mod guards do not discard unknown config conditions", () => {
    const mods = new Set(["test"]);
    expect(conditionAllows({ type: "forge:mod_loaded", modid: "absent" }, mods)).toBe(false);
    expect(conditionAllows({ type: "forge:not", value: { type: "forge:mod_loaded", modid: "absent" } }, mods)).toBe(true);
    expect(conditionAllows({ type: "forge:and", values: [{ type: "test:config" }, { type: "forge:mod_loaded", modid: "absent" }] }, mods)).toBe(false);
    expect(conditionAllows({ type: "forge:or", values: [{ type: "test:config" }, { type: "forge:mod_loaded", modid: "test" }] }, mods)).toBe(true);
    expect(conditionAllows({ type: "test:config" }, mods)).toBeUndefined();
  });
  test("guide formatting is plain text", () => {
    expect(plainText("$(bold)Hello$() $(br)§a[world](entry://book/page) **friend** <&recipe>"))
      .toBe("Hello world friend");
  });
  test("jar merge, replace, cycles, guards, odd files and tagged outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-knowledge-"));
    try {
      const jar = join(dir, "first.jar");
      const second = join(dir, "second.jar");
      const out = join(dir, "knowledge.sqlite");
      const files: Record<string, Uint8Array> = {};
      const add = (path: string, value: unknown) => { files[path] = strToU8(JSON.stringify(value)); };
      add("data/test/tags/items/base.json", { values: ["test:old"] });
      add("data/test/tags/items/a.json", { values: ["#test:b", "#test:base"] });
      add("data/test/tags/items/b.json", { values: ["#test:a", "test:second"] });
      add("data/test/recipes/tagged.json", { type: "test:machine", input: { tag: "test:a" }, result: { tag: "test:base" } });
      add("data/test/recipes/absent.json", { type: "test:machine", conditions: [{ type: "forge:mod_loaded", modid: "absent" }], result: "test:absent" });
      add("data/test/recipes/present.json", { type: "test:machine", conditions: [{ type: "forge:mod_loaded", modid: "late_mod" }], result: "test:present" });
      files["data/test/recipes/broken.json"] = strToU8("{");
      await Bun.write(jar, zipSync(files));
      await Bun.write(second, zipSync({
        "META-INF/mods.toml": strToU8('[[mods]]\nmodId="late_mod"'),
        "data/test/tags/items/base.json": strToU8(JSON.stringify({ replace: true, values: ["test:new"] })),
      }));
      await buildKnowledge([jar, second], [], out);
      const knowledge = openKnowledge(out);
      try {
        expect(knowledge.itemsInTag("test:a")).toEqual(["test:new", "test:second"]);
        expect(knowledge.itemsInTag("test:b")).toEqual(["test:new", "test:second"]);
        expect(knowledge.itemsInTag("test:base")).toEqual(["test:new"]);
        expect(knowledge.usesOf("test:new")[0]?.id).toBe("test:tagged");
        expect(knowledge.recipesFor("test:new")[0]?.id).toBe("test:tagged");
        expect(knowledge.recipesFor("test:absent")).toEqual([]);
        expect(knowledge.recipesFor("test:present")).toHaveLength(1);
      } finally { knowledge.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("recipe lookup ranks direct matches, approachable types, then type and recipe id before limiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-knowledge-order-"));
    try {
      const files: Record<string, Uint8Array> = {
        "data/test/tags/items/target.json": strToU8(JSON.stringify({ values: ["test:target"] })),
      };
      const ordered = [
        ["z_shaped", "minecraft:crafting_shaped"],
        ["y_shapeless", "minecraft:crafting_shapeless"],
        ["x_smelting", "minecraft:smelting"],
        ["w_blasting", "minecraft:blasting"],
        ["v_smoking", "minecraft:smoking"],
        ["u_campfire", "minecraft:campfire_cooking"],
        ["t_stonecutting", "minecraft:stonecutting"],
        ["s_smithing", "minecraft:smithing_transform"],
        ["r_custom_a", "aaa:machine"],
        ["q_custom_z_first", "zzz:machine"],
        ["q_custom_z_second", "zzz:machine"],
      ];
      for (const [id, type] of ordered) {
        files[`data/test/recipes/${id}.json`] = strToU8(JSON.stringify({
          type, input: { item: "test:target" }, output: { item: "test:target" },
        }));
      }
      files["data/test/recipes/a_tagged.json"] = strToU8(JSON.stringify({
        type: "minecraft:crafting_shaped", input: { tag: "test:target" }, output: { tag: "test:target" },
      }));
      const jar = join(dir, "order.jar");
      const out = join(dir, "knowledge.sqlite");
      await Bun.write(jar, zipSync(files));
      await buildKnowledge([jar], [], out);
      const knowledge = openKnowledge(out);
      try {
        const expected = [...ordered.map(([id]) => `test:${id}`), "test:a_tagged"];
        expect(knowledge.recipesFor("test:target", 100).map((recipe) => recipe.id)).toEqual(expected);
        expect(knowledge.usesOf("test:target", 100).map((recipe) => recipe.id)).toEqual(expected);
        expect(knowledge.recipesFor("test:target", 2).map((recipe) => recipe.id)).toEqual(expected.slice(0, 2));
        expect(knowledge.usesOf("test:target", 2).map((recipe) => recipe.id)).toEqual(expected.slice(0, 2));
      } finally { knowledge.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
