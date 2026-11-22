#!/usr/bin/env bun
// Writes full-client/baritone-settings.txt, the Baritone settings every resident client starts with.
//
// Baritone runs with `allowBreak true` so a resident can dig through terrain, which also lets it break what
// players built. Baritone 1.10.1 has two lists for that (baritone.api.Settings):
//   blocksToAvoidBreaking     breaking costs 1 / avoidBreakingMultiplier times as much (default list: crafting
//                             table, furnace, chest, trapped chest; default multiplier 0.1)
//   blocksToDisallowBreaking  never broken (default empty)
// This script fills the first one. The hard list is left empty on purpose: a resident sealed in by planks could
// not get out, `#mine` could not take a listed block at all, and that list is searched once per block the
// pathfinder considers breaking, where the soft list is searched once per kind of block per path.
//
// A block counts as built when a player makes it and worldgen does not: every block that is the output of a
// crafting, stonecutting, smelting or workbench recipe in the knowledge database, plus the forms a made block
// takes once placed (PLACED), minus terrain and plants that some recipe also makes (NATURAL).
//
// Inputs, both cached under full-client/toolserver/.cache (ignored by git):
//   knowledge.sqlite  tools/with-inspiron.sh fetch-knowledge <<'EOF'
//                     scp -q -o BatchMode=yes $INSPIRON:gary-client/knowledge.sqlite full-client/toolserver/.cache/
//                     EOF
//   level.dat         the server's block registry as Forge saves it in the world; one unknown id makes Baritone
//                     drop the whole line, so only ids the server registered are written:
//                     ssh swatson@192.168.1.233 'cat ~/mc-servers/simon_vanilla_plus/mc-data/ServerReset2/level.dat' \
//                       > full-client/toolserver/.cache/level.dat
//
//   bun full-client/tools/baritone-settings.ts [--db <knowledge.sqlite>] [--level <level.dat>] [--out <settings.txt>]
import { Database } from "bun:sqlite";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";

/** Breaking a listed block costs 100 times its normal time: by hand an oak plank costs as much as walking about
 * 1,300 blocks, so Baritone goes round anything it can go round. Smaller is not safer: a move costing 1,000,000
 * ticks or more is impossible to Baritone, and at 0.001 two stone bricks broken by hand (300,000) are near it
 * and an iron door (1,000,000) is past it, which would turn the soft list into a hard one. */
export const AVOID_BREAKING_MULTIPLIER = 0.01;

const BASE_SETTINGS = ["allowBreak true", "allowPlace true", "allowSprint true", "chatControl true", "prefixControl true"];

/** Recipe types whose outputs a player makes to use or place. Machine recipes that crush, grow, saw or mine
 * (Mekanism crushing and combining, the Occultism miner, the garden cloche) are left out: what they add is ore,
 * gravel, flowers and other raw material. */
const MAKING_TYPES = [
  "minecraft:crafting_shaped", "minecraft:crafting_shapeless", "minecraft:stonecutting", "minecraft:smelting",
  "minecraft:blasting", "minecraft:smithing_transform",
  "furnitury:furniture_workbench", "deco_storage:storage_crafter", "mekanism:mek_data", "mekanism:painting",
  "morered:soldering", "redstonepen:crafting_extended_shapeless", "immersiveengineering:turn_and_copy",
  "immersiveengineering:shaped_fluid", "sophisticatedbackpacks:basic_backpack",
  "sophisticatedbackpacks:backpack_upgrade", "sophisticatedbackpacks:smithing_backpack_upgrade",
  "occultism:ritual", "naturesaura:tree_ritual", "quark:exclusion",
];

type Rule = [pattern: RegExp, reason: string];

/** Built blocks no recipe lists, because they only exist once something made is placed or worked on. */
const PLACED: Rule[] = [
  [/^minecraft:(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|composter|crafting_table|hopper|[a-z_]+_bed)$/, "containers, workstations and beds residents place, whatever the recipe data says"],
  [/^(?!.*coral).*[:_]wall(_|$)/, "the wall-mounted form of a sign, banner, torch, head or lantern"],
  [/:potted_/, "a flower pot with a plant in it"],
  [/candle_cake$/, "a cake with a candle"],
  [/[:_](water|lava|powder_snow|dye|liquid)_cauldron$/, "a filled cauldron"],
  [/shulker_box$/, "dyed shulker boxes (a special recipe with no listed output)"],
  [/^minecraft:(chipped|damaged)_anvil$/, "a worn anvil"],
  [/^minecraft:(farmland|dirt_path)$/, "fields and paths, made with a hoe or shovel"],
  [/^minecraft:(bell|redstone_wire|[a-z_]+_head)$/, "village bells, laid redstone and mob heads"],
  [/:(exposed|weathered|oxidized|rusted|rusty|waxed)_/, "aged or waxed forms of metal blocks"],
  [/^(securitycraft|moreprotectables|amendments):/, "reinforced, keypad and combined forms made in the world from placed blocks"],
  [/^camping:tent_/, "the parts of a pitched tent"],
  [/^(lootr:|quark:lootr_)/, "loot containers: taking the loot does not need them broken"],
  [/^(immersiveengineering|mekanism|mekanismgenerators|refinedstorage|jumbofurnace|furnitury|tacz):/, "machines and the multiblock parts they turn into when formed"],
  [/^supplementaries:(safe|sign_post|book_pile(_horizontal)?|raked_gravel|(trapped_)?present_[a-z_]+)$/, "safes, sign posts, book piles, raked gravel and wrapped presents"],
];

/** Terrain and wild plants that a recipe or a PLACED rule would otherwise list. Baritone must stay free to dig
 * and cut these, and `#mine` must be able to take them. */
const NATURAL: Rule[] = [
  [/^minecraft:(stone|deepslate|granite|diorite|andesite|calcite|tuff|basalt|smooth_basalt|blackstone|dripstone_block)$/, "underground rock (stone is smelted from cobblestone; granite, diorite and andesite are crafted)"],
  [/^minecraft:(cobblestone|mossy_cobblestone|cobbled_deepslate)$/, "boulders, dungeons, lava meeting water, and what digging leaves behind"],
  [/^minecraft:(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|packed_mud|muddy_mangrove_roots|clay|moss_block|moss_carpet)$/, "soil, mud and moss"],
  [/^minecraft:(sand|red_sand|gravel|sandstone|red_sandstone|smooth_sandstone|smooth_red_sandstone)$/, "beaches, deserts and badlands (this pack's terrain also places the smooth sandstones)"],
  [/^minecraft:(?!.*glazed)([a-z_]+_)?terracotta$/, "badlands and this pack's painted hills"],
  [/^minecraft:(snow|snow_block|powder_snow|ice|packed_ice|blue_ice)$/, "snow and ice"],
  [/^minecraft:(netherrack|soul_sand|soul_soil|magma_block|glowstone|nether_wart_block|warped_wart_block|end_stone)$/, "Nether and End terrain"],
  [/^minecraft:(amethyst_block|raw_iron_block|raw_copper_block|raw_gold_block)$/, "geodes and large ore veins"],
  [/[:_]ore(_|$)|^minecraft:ancient_debris$/, "ores"],
  [/^(minecraft|quark|sundries|naturesaura|occultism):(?!stripped_|hollow_|stacked_)[a-z_]+_(log|wood|stem|leaves)$/, "trees: trunks, branches and leaves"],
  [/^minecraft:(cactus|sugar_cane|bamboo|melon|pumpkin|cobweb|grass|fern|vine)$/, "wild plants and cobwebs"],
  [/^quark:(?!waxed_)[a-z]+_corundum$/, "crystal caves"],
  [/^sundries:(brownstone|limestone|shale|white_marble|pink_granodiorite|pink_rock_salt|sea_sand|sea_sandstone|jade_mushroom)$/, "placed by Sundries' own worldgen features"],
  [/^mekanism:block_salt$/, "salt beds in rivers"],
  [/fluid_block$|^mekanism:(heavy_water|nutritional_paste)$|^mekanismgenerators:bioethanol$/, "liquids"],
];

/** A wrong list is worse than none, so the script refuses to write one that fails these. */
const MUST_AVOID = ["chest", "barrel", "furnace", "composter", "crafting_table", "white_bed", "oak_planks", "oak_door", "oak_fence", "glass", "torch", "wall_torch", "oak_wall_sign", "farmland", "dirt_path", "stone_bricks", "white_wool"];
const MUST_NOT_AVOID = ["air", "water", "dirt", "grass_block", "stone", "cobblestone", "deepslate", "tuff", "sand", "gravel", "clay", "snow", "ice", "netherrack", "oak_log", "oak_leaves", "coal_ore", "iron_ore", "deepslate_diamond_ore"];

export interface BuiltBlocks {
  /** Block ids to avoid breaking, sorted, each one in the registry. */
  built: string[];
  /** For each NATURAL reason, the ids it kept off the list. */
  natural: Map<string, string[]>;
  /** For each PLACED reason, how many ids it added that no recipe makes. */
  placed: Map<string, number>;
}

/** The built blocks among `registry`, given the ids recipes make (items that are not blocks are ignored). */
export function builtBlocks(registry: Iterable<string>, crafted: Iterable<string>): BuiltBlocks {
  const known = new Set(registry);
  const candidates = new Set([...crafted].filter(id => known.has(id)));
  const placed = new Map<string, number>();
  for (const id of known) {
    const rule = candidates.has(id) ? undefined : PLACED.find(([pattern]) => pattern.test(id));
    if (!rule) continue;
    candidates.add(id);
    placed.set(rule[1], (placed.get(rule[1]) ?? 0) + 1);
  }
  const natural = new Map<string, string[]>();
  const built: string[] = [];
  for (const id of [...candidates].sort()) {
    const rule = NATURAL.find(([pattern]) => pattern.test(id));
    if (!rule) { built.push(id); continue; }
    natural.set(rule[1], [...(natural.get(rule[1]) ?? []), id]);
  }
  return { built, natural, placed };
}

/** Baritone's own spelling of a block id: vanilla ids without the namespace. */
const baritoneName = (id: string) => id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;

/** The whole settings file. Throws when the list would protect terrain or leave a home unprotected. */
export function settingsText(built: string[]): string {
  const names = built.map(baritoneName);
  const listed = new Set(names);
  const missing = MUST_AVOID.filter(name => !listed.has(name));
  const wrong = MUST_NOT_AVOID.filter(name => listed.has(name));
  if (missing.length || wrong.length) throw new Error(`refusing to write: built blocks missing [${missing}] terrain listed [${wrong}]`);
  return [
    "# Generated by full-client/tools/baritone-settings.ts; edit that, not this. launch.sh copies this file over",
    "# <game dir>/baritone/settings.txt at every client start, because Baritone rewrites its own copy.",
    ...BASE_SETTINGS,
    `avoidBreakingMultiplier ${AVOID_BREAKING_MULTIPLIER}`,
    `blocksToAvoidBreaking ${names.join(",")}`,
    "",
  ].join("\n");
}

/** Block ids the server registered, from the Forge registry snapshot in a world's gzipped level.dat. */
export function blockRegistry(levelDat: Uint8Array): string[] {
  const data = gunzipSync(levelDat);
  let at = 0;
  const text = () => { const length = data.readUInt16BE(at); at += 2 + length; return data.toString("utf8", at - length, at); };
  const sizes: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 };
  const arrays: Record<number, number> = { 7: 1, 11: 4, 12: 8 };
  const payload = (tag: number): unknown => {
    if (tag === 8) return text();
    if (tag in sizes) { at += sizes[tag]!; return undefined; }
    if (tag in arrays) { const length = data.readInt32BE(at); at += 4 + length * arrays[tag]!; return undefined; }
    if (tag === 9) {
      const inner = data.readUInt8(at); const length = data.readInt32BE(at + 1); at += 5;
      return Array.from({ length }, () => payload(inner));
    }
    if (tag !== 10) throw new Error(`level.dat: unknown NBT tag ${tag} at byte ${at}`);
    const compound: Record<string, unknown> = {};
    for (let inner = data.readUInt8(at++); inner !== 0; inner = data.readUInt8(at++)) { const key = text(); compound[key] = payload(inner); }
    return compound;
  };
  const rootTag = data.readUInt8(at++); text();
  const root = payload(rootTag) as { fml?: { Registries?: Record<string, { ids?: { K: string }[] }> } };
  const ids = root.fml?.Registries?.["minecraft:block"]?.ids;
  if (!ids?.length) throw new Error("level.dat has no Forge block registry (fml.Registries.minecraft:block.ids)");
  return ids.map(entry => entry.K);
}

/** Every id that a making recipe outputs, and how many block ids each other recipe type would have added. */
export function craftedIds(db: Database, registry: Iterable<string>): { crafted: Set<string>; ignored: Map<string, number> } {
  const known = new Set(registry);
  const making = new Set(MAKING_TYPES);
  const crafted = new Set<string>();
  const others = new Map<string, Set<string>>();
  const rows = db.query("SELECT r.type AS type, o.what AS what FROM recipes r JOIN recipe_outputs o ON o.recipe = r.id").all() as { type: string; what: string }[];
  for (const { type, what } of rows) {
    if (making.has(type)) crafted.add(what);
    else if (known.has(what)) others.set(type, (others.get(type) ?? new Set()).add(what));
  }
  const ignored = new Map<string, number>();
  for (const [type, ids] of others) {
    const extra = [...ids].filter(id => !crafted.has(id)).length;
    if (extra) ignored.set(type, extra);
  }
  return { crafted, ignored };
}

if (import.meta.main) {
  const cache = resolve(import.meta.dir, "../toolserver/.cache");
  const paths = { db: resolve(cache, "knowledge.sqlite"), level: resolve(cache, "level.dat"), out: resolve(import.meta.dir, "../baritone-settings.txt") };
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]!.replace(/^--/, "");
    if (!(name in paths) || !process.argv[i + 1]) { console.error("usage: baritone-settings.ts [--db <knowledge.sqlite>] [--level <level.dat>] [--out <settings.txt>]"); process.exit(2); }
    paths[name as keyof typeof paths] = resolve(process.argv[i + 1]!);
  }
  const registry = blockRegistry(new Uint8Array(await Bun.file(paths.level).arrayBuffer()));
  const db = new Database(paths.db, { readonly: true });
  const { crafted, ignored } = craftedIds(db, registry);
  db.close();
  const { built, natural, placed } = builtBlocks(registry, crafted);
  await Bun.write(paths.out, settingsText(built));
  console.log(`${paths.out}: ${built.length} of ${registry.length} registered blocks count as built; avoidBreakingMultiplier ${AVOID_BREAKING_MULTIPLIER}.`);
  console.log("\nPlaced forms added (no recipe makes them):");
  for (const [reason, count] of placed) console.log(`  ${count}  ${reason}`);
  console.log("\nKept off the list as natural:");
  for (const [reason, ids] of natural) console.log(`  ${reason}: ${ids.map(baritoneName).join(" ")}`);
  console.log("\nRecipe types not counted, with the block ids only they make:");
  console.log(`  ${[...ignored].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type} ${count}`).join(", ")}`);
}
