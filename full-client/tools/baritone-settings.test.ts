import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { AVOID_BREAKING_MULTIPLIER, blockRegistry, builtBlocks, craftedIds, settingsText } from "./baritone-settings.ts";

const registry = [
  "minecraft:air", "minecraft:dirt", "minecraft:stone", "minecraft:cobblestone", "minecraft:oak_log", "minecraft:oak_wood",
  "minecraft:stripped_oak_wood", "minecraft:oak_planks", "minecraft:composter", "minecraft:chest", "minecraft:white_bed",
  "minecraft:white_terracotta", "minecraft:white_glazed_terracotta", "minecraft:oak_sign", "minecraft:oak_wall_sign",
  "minecraft:brain_coral_wall_fan", "minecraft:farmland", "minecraft:coal_ore", "minecraft:water_cauldron",
  "securitycraft:reinforced_oak_log", "furnitury:oak_sittable_log", "immersiveengineering:coke_oven",
  "immersiveengineering:ore_lead", "mekanism:block_salt", "sundries:limestone", "sundries:limestone_bricks",
];
const crafted = [
  "minecraft:oak_planks", "minecraft:composter", "minecraft:oak_sign", "minecraft:stone", "minecraft:cobblestone",
  "minecraft:oak_wood", "minecraft:stripped_oak_wood", "minecraft:white_terracotta", "minecraft:white_glazed_terracotta",
  "furnitury:oak_sittable_log", "mekanism:block_salt", "sundries:limestone", "sundries:limestone_bricks",
  "minecraft:stick", "othermod:marble_table",
];

test("a made block is listed, terrain a recipe also makes is not, and nothing outside the registry gets in", () => {
  const { built } = builtBlocks(registry, crafted);
  expect(built).toEqual([
    "furnitury:oak_sittable_log", "immersiveengineering:coke_oven", "minecraft:chest", "minecraft:composter", "minecraft:farmland",
    "minecraft:oak_planks", "minecraft:oak_sign", "minecraft:oak_wall_sign", "minecraft:stripped_oak_wood", "minecraft:water_cauldron",
    "minecraft:white_bed", "minecraft:white_glazed_terracotta", "securitycraft:reinforced_oak_log", "sundries:limestone_bricks",
  ]);
});

test("the report names what each natural rule kept off the list, ores of a machine mod included", () => {
  const kept = [...builtBlocks(registry, crafted).natural.values()].flat().sort();
  expect(kept).toEqual(["immersiveengineering:ore_lead", "mekanism:block_salt", "minecraft:cobblestone", "minecraft:oak_wood", "minecraft:stone", "minecraft:white_terracotta", "sundries:limestone"]);
});

const home = ["chest", "barrel", "furnace", "composter", "crafting_table", "white_bed", "oak_planks", "oak_door", "oak_fence", "glass", "torch", "wall_torch", "oak_wall_sign", "farmland", "dirt_path", "stone_bricks", "white_wool"].map(name => `minecraft:${name}`);

test("the settings file keeps digging on and writes the list the way Baritone spells it", () => {
  const lines = settingsText([...home, "mekanism:digital_miner"]).split("\n");
  expect(lines).toContain("allowBreak true");
  expect(lines).toContain(`avoidBreakingMultiplier ${AVOID_BREAKING_MULTIPLIER}`);
  expect(lines.filter(line => line.startsWith("blocksToAvoidBreaking "))).toEqual([`blocksToAvoidBreaking ${home.map(id => id.slice(10)).join(",")},mekanism:digital_miner`]);
  // Baritone skips blank lines and lines starting with # and reports any other line it cannot read.
  expect(lines.filter(line => line && !line.startsWith("#") && !/^[A-Za-z]+ \S+$/.test(line))).toEqual([]);
});

test("a list that protects terrain or misses a composter is refused", () => {
  expect(() => settingsText([...home, "minecraft:dirt"])).toThrow("terrain listed [dirt]");
  expect(() => settingsText(home.filter(id => id !== "minecraft:composter"))).toThrow("missing [composter]");
});

test("only making recipes count, and the rest are reported with what they alone make", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE recipes(id TEXT PRIMARY KEY, type TEXT NOT NULL, summary TEXT NOT NULL)");
  db.run("CREATE TABLE recipe_outputs(recipe TEXT NOT NULL, what TEXT NOT NULL, PRIMARY KEY(recipe,what))");
  const add = (id: string, type: string, what: string) => { db.run("INSERT INTO recipes VALUES(?,?,'{}')", [id, type]); db.run("INSERT INTO recipe_outputs VALUES(?,?)", [id, what]); };
  add("planks", "minecraft:crafting_shaped", "minecraft:oak_planks");
  add("stone", "minecraft:smelting", "minecraft:stone");
  add("ore", "mekanism:combining", "minecraft:coal_ore");
  add("planks_by_saw", "mekanism:sawing", "minecraft:oak_planks");
  const { crafted, ignored } = craftedIds(db, registry);
  expect([...crafted].sort()).toEqual(["minecraft:oak_planks", "minecraft:stone"]);
  expect([...ignored]).toEqual([["mekanism:combining", 1]]);
});

test("the block registry is read from the Forge snapshot in level.dat", () => {
  const text = (value: string) => { const bytes = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]); };
  const named = (tag: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([tag]), text(name), payload]);
  const compound = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.from([0])]);
  const int = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
  const entry = (id: string, number: number) => compound(named(8, "K", text(id)), named(3, "V", int(number)));
  const ids = Buffer.concat([Buffer.from([10]), int(2), entry("minecraft:air", 0), entry("quark:jasper", 7)]);
  const level = named(10, "", compound(
    named(10, "Data", compound(named(4, "Time", Buffer.alloc(8)), named(11, "Ints", Buffer.concat([int(2), int(1), int(2)])))),
    named(10, "fml", compound(named(10, "Registries", compound(
      named(10, "minecraft:item", compound(named(9, "ids", Buffer.concat([Buffer.from([10]), int(0)])))),
      named(10, "minecraft:block", compound(named(9, "ids", ids))),
    )))),
  ));
  expect(blockRegistry(gzipSync(level))).toEqual(["minecraft:air", "quark:jasper"]);
  expect(() => blockRegistry(gzipSync(named(10, "", compound())))).toThrow("no Forge block registry");
});

test("the committed settings protect a home and leave terrain diggable", async () => {
  const lines = (await Bun.file(resolve(import.meta.dir, "../baritone-settings.txt")).text()).split("\n");
  const listed = new Set(lines.find(line => line.startsWith("blocksToAvoidBreaking "))!.split(" ")[1]!.split(","));
  for (const name of ["composter", "chest", "furnace", "white_bed", "oak_planks", "oak_door", "farmland", "mekanism:digital_miner"]) expect(listed).toContain(name);
  for (const name of ["dirt", "stone", "cobblestone", "oak_log", "oak_leaves", "iron_ore", "supplementaries:wild_flax"]) expect(listed).not.toContain(name);
  expect(lines).toContain("avoidBreakingMultiplier 0.01");
  expect(lines).toContain("allowBreak true");
});
