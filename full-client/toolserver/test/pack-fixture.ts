import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { buildKnowledge } from "../src/knowledge/build.ts";

/**
 * A small pack, written as jars the way mods ship them, for the pack overview: a machine mod with an
 * advancement tab, a book and its own recipe type; a gun mod with a commented gun pack; a library it needs;
 * a client-only mod; a world-generation datapack mod (Fabric metadata); and a mod nested in another jar.
 */
export async function buildPackFixture(dir: string): Promise<string> {
  const json = (value: unknown) => strToU8(JSON.stringify(value));
  const shaped = (pattern: string[], key: Record<string, unknown>, result: string, count = 1) =>
    json({ type: "minecraft:crafting_shaped", pattern, key, result: { item: result, count } });
  const advancement = (title: string, parent: string | undefined, items: string[] | undefined, extra: Record<string, unknown> = {}) => json({
    ...(parent ? { parent } : {}),
    display: { title: { translate: title }, description: `About ${title}`, icon: { item: "minecraft:stone" }, ...extra },
    criteria: { got: items ? { trigger: "minecraft:inventory_changed", conditions: { items: [{ items }] } } : { trigger: "minecraft:tick" } },
  });
  const jars: Record<string, Record<string, Uint8Array>> = {
    "machina.jar": {
      "META-INF/mods.toml": strToU8(`modLoader="javafml"
loaderVersion="[47,)"
[[mods]]
modId="machina"
displayName="Machina"
description='''
Machines that grind
stone into gravel.
'''
[[dependencies.machina]]
modId="lib"
mandatory=true
[[dependencies.machina]]
modId="absent_optional"
mandatory=false
`),
      "assets/machina/lang/en_us.json": json({
        "item.machina.gear": "Gear", "item.machina.circuit": "Circuit", "block.machina.grinder": "Grinder",
        "item.machina.tin_ingot": "Tin Ingot", "item.machina.tin_nugget": "Tin Nugget", "block.machina.tin_ore": "Tin Ore",
        "item.machina.gear.tooltip": "Not an item", "machina.book.name": "Machina Manual",
        "advancement.machina.root": "Machina", "advancement.machina.ingot": "Shiny", "advancement.machina.grind": "Grind Time", "advancement.machina.secret": "Secret",
      }),
      "assets/machina/blockstates/grinder.json": json({}),
      "assets/machina/blockstates/tin_ore.json": json({}),
      "assets/machina/models/item/gear.json": json({}),
      "assets/machina/models/item/circuit.json": json({}),
      "assets/machina/models/item/grinder.json": json({}),
      "assets/machina/models/item/tin_ingot.json": json({}),
      "assets/machina/models/item/tin_nugget.json": json({}),
      "assets/machina/models/item/tin_ore.json": json({}),
      "assets/machina/models/item/gear_spinning.json": json({}),
      "data/machina/recipes/gear.json": shaped([" I ", "I I", " I "], { I: { item: "minecraft:iron_ingot" } }, "machina:gear"),
      "data/machina/recipes/grinder.json": shaped(["G", "F"], { G: { item: "machina:gear" }, F: { item: "minecraft:furnace" } }, "machina:grinder"),
      "data/machina/recipes/circuit.json": shaped(["G", "R"], { G: { item: "machina:gear" }, R: { item: "minecraft:redstone" } }, "machina:circuit"),
      "data/machina/recipes/tin_ingot_from_nuggets.json": shaped(["NNN", "NNN", "NNN"], { N: { tag: "forge:nuggets/tin" } }, "machina:tin_ingot"),
      "data/machina/recipes/tin_nugget.json": json({ type: "minecraft:crafting_shapeless", ingredients: [{ item: "machina:tin_ingot" }], result: { item: "machina:tin_nugget", count: 9 } }),
      "data/machina/recipes/tin_ingot_smelting.json": json({ type: "minecraft:smelting", ingredient: { item: "machina:tin_ore" }, result: "machina:tin_ingot" }),
      "data/machina/recipes/grinding/cobble.json": json({ type: "machina:grinding", input: { item: "minecraft:cobblestone" }, output: { item: "minecraft:gravel" } }),
      "data/machina/recipes/grinding/gravel.json": json({ type: "machina:grinding", input: { item: "minecraft:gravel" }, output: { item: "minecraft:sand" } }),
      "data/machina/recipes/optional_compat.json": json({ type: "minecraft:crafting_shapeless", conditions: [{ type: "forge:mod_loaded", modid: "absent_optional" }], ingredients: [{ item: "machina:gear" }], result: { item: "absent_optional:thing" } }),
      "data/forge/tags/items/nuggets/tin.json": json({ values: ["machina:tin_nugget"] }),
      "data/machina/advancements/root.json": advancement("advancement.machina.root", undefined, undefined, { background: "minecraft:textures/block/stone.png" }),
      "data/machina/advancements/ingot.json": advancement("advancement.machina.ingot", "machina:root", ["machina:tin_ingot"]),
      "data/machina/advancements/grind.json": advancement("advancement.machina.grind", "machina:ingot", ["machina:grinder"]),
      "data/machina/advancements/secret.json": advancement("advancement.machina.secret", "machina:ingot", ["machina:circuit"], { hidden: true }),
      "data/machina/advancements/recipes/misc/gear.json": json({ parent: "minecraft:recipes/root", criteria: {} }),
      "data/machina/patchouli_books/manual/book.json": json({ name: "machina.book.name", landing_text: "Welcome" }),
      "data/machina/patchouli_books/manual/en_us/entries/grinding.json": json({ name: "Grinding", pages: [{ type: "text", text: "The $(item)Grinder$() turns cobblestone into gravel." }] }),
    },
    "tacz.jar": {
      "META-INF/mods.toml": strToU8('[[mods]]\nmodId = "tacz"\ndisplayName = "Guns Zero"\ndescription = \'\'\'\n\'\'\'\n'),
      "assets/tacz/lang/en_us.json": json({ "block.tacz.gun_smith_table": "Gun Smith Table" }),
      "assets/tacz/blockstates/gun_smith_table.json": json({}),
      "assets/tacz/models/item/gun_smith_table.json": json({}),
      "data/tacz/recipes/gun_smith_table.json": shaped(["II", "LL"], { I: { tag: "forge:ingots/iron" }, L: { tag: "minecraft:logs" } }, "tacz:gun_smith_table"),
      "assets/tacz/custom/pack/assets/tacz/lang/en_us.json": json({ "tacz.gun.rifle.name": "Rifle One", "tacz.ammo.r9.name": "9mm Rounds" }),
      "assets/tacz/custom/pack/data/tacz/index/guns/rifle.json": strToU8('{\n  // the gun\'s name, see https://example.org/x\n  "name": "tacz.gun.rifle.name",\n  "type": "rifle"\n}'),
      "assets/tacz/custom/pack/data/tacz/index/ammo/r9.json": strToU8('{ /* ammo */ "name": "tacz.ammo.r9.name" }'),
      "assets/tacz/custom/pack/data/tacz/recipes/gun/rifle.json": strToU8('{\n  // costs\n  "materials": [{ "item": { "tag": "forge:ingots/iron" }, "count": 20 }],\n  "result": { "type": "gun", "id": "tacz:rifle" },\n  "type": "tacz:gun_smith_table_crafting"\n}'),
    },
    // An add-on built on Machina's parts. Its Frame is the most used item, but needs grit from Machina's grinder
    // and Machina's circuit: four steps from the world, the grinder counted. Upgrade Base and the Tin Bag (made
    // in the add-on's own crafting-grid type, and its namesake) are three steps each.
    "tinbags.jar": {
      "META-INF/mods.toml": strToU8('[[mods]]\nmodId="tinbags"\ndisplayName="Tin Bags"\ndescription="Bags of tin."\n[[dependencies.tinbags]]\nmodId="machina"\nmandatory=true\n'),
      "assets/tinbags/lang/en_us.json": json({ "item.tinbags.frame": "Frame", "item.tinbags.grit": "Grit", "item.tinbags.upgrade_base": "Upgrade Base", "item.tinbags.tin_bag": "Tin Bag", "item.tinbags.upgrade_a": "Upgrade A", "item.tinbags.upgrade_b": "Upgrade B", "item.tinbags.upgrade_c": "Upgrade C" }),
      ...Object.fromEntries(["frame", "grit", "upgrade_base", "tin_bag", "upgrade_a", "upgrade_b", "upgrade_c"].map(item => [`assets/tinbags/models/item/${item}.json`, json({})])),
      "data/tinbags/recipes/grit.json": json({ type: "machina:grinding", input: { item: "minecraft:iron_ingot" }, output: { item: "tinbags:grit" } }),
      "data/tinbags/recipes/frame.json": shaped(["CG"], { C: { item: "machina:circuit" }, G: { item: "tinbags:grit" } }, "tinbags:frame"),
      "data/tinbags/recipes/upgrade_base.json": shaped(["TL"], { T: { tag: "forge:nuggets/tin" }, L: { item: "minecraft:leather" } }, "tinbags:upgrade_base"),
      "data/tinbags/recipes/tin_bag.json": json({ type: "tinbags:bag_crafting", pattern: ["TS"], key: { T: { tag: "forge:nuggets/tin" }, S: { item: "minecraft:string" } }, result: { item: "tinbags:tin_bag" } }),
      "data/tinbags/recipes/upgrade_a.json": shaped(["UF"], { U: { item: "tinbags:upgrade_base" }, F: { item: "tinbags:frame" } }, "tinbags:upgrade_a"),
      "data/tinbags/recipes/upgrade_b.json": shaped(["FU"], { U: { item: "tinbags:upgrade_base" }, F: { item: "tinbags:frame" } }, "tinbags:upgrade_b"),
      "data/tinbags/recipes/upgrade_c.json": shaped(["F"], { F: { item: "tinbags:frame" } }, "tinbags:upgrade_c"),
    },
    "lib.jar": {
      "META-INF/mods.toml": strToU8('[[mods]]\nmodId="lib"\ndisplayName="Lib"\ndescription="A library other mods use."\n'),
    },
    "shiny-client.jar": {
      "META-INF/mods.toml": strToU8('[[mods]]\nmodId="shiny"\ndisplayName="Shiny Shaders"\ndisplayTest="IGNORE_ALL_VERSION"\n'),
    },
    "terrain.jar": {
      "fabric.mod.json": json({ schemaVersion: 1, id: "terrain", name: "Terrain Plus", description: "New biomes to explore.", environment: "*" }),
      "data/terrain/worldgen/biome/dunes.json": json({}),
      "data/terrain/worldgen/biome/mesa.json": json({}),
      "data/terrain/worldgen/structure/tower.json": json({}),
      "data/minecraft/worldgen/configured_feature/ore_iron.json": json({}),
    },
    "outer.jar": {
      "META-INF/mods.toml": strToU8('mods = [ { modId = "outer", displayName = "Outer", description = "Holds a friend." }, ]\n'),
      "META-INF/jarjar/inner.jar": zipSync({
        "META-INF/mods.toml": strToU8('[[mods]]\nmodId="inner"\ndisplayName="Inner Furnace"\ndescription="A bigger furnace."\n'),
        "assets/inner/lang/en_us.json": json({ "block.inner.big_furnace": "Big Furnace" }),
        "assets/inner/blockstates/big_furnace.json": json({}),
        "assets/inner/models/item/big_furnace.json": json({}),
        "data/inner/recipes/big_furnace.json": shaped(["FF"], { F: { item: "minecraft:furnace" } }, "inner:big_furnace"),
      }),
    },
  };
  const paths: string[] = [];
  for (const [name, files] of Object.entries(jars)) {
    const path = join(dir, name);
    await Bun.write(path, zipSync(files));
    paths.push(path);
  }
  const out = join(dir, "knowledge.sqlite");
  const log = console.log;
  console.log = () => {};
  try { await buildKnowledge(paths, [], out); } finally { console.log = log; }
  return out;
}
