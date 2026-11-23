// A small advancement tree stored through the hub's real ingest writers (observer-store.ts), shared by the hub's
// frontier tests and the toolserver's what_next tests.
import type { Database } from "bun:sqlite";
import { storeAdvancements, storeCatalog } from "../src/observer-store.ts";
import type { IngestHealth } from "../src/observer-ingest.ts";
import type { AdvancementProgress, CatalogEntry } from "../src/observer-query.ts";

export const savedAt = Date.UTC(2026, 10, 23, 12);
export const okHealth = (over: Partial<IngestHealth> = {}): IngestHealth => ({
  status: "ok", detail: null, checkedAt: savedAt, okAt: savedAt, run: 1, kinds: ["stats", "advancements", "advancement_catalog"], steps: {}, ...over,
});

const entry = (id: string, title: string | null, parent: string | null, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ id, title, frame: "task", hidden: false, criteria: 1, requirements: 1, parent, ...extra });
/**
 * Tabs: Minecraft (story; a Quark advancement hangs in it), Nether (one hidden), Adventure (not started), Mekanism
 * (one raw translation-key title, one needing one of each of two groups), Camping (root not done, a child started),
 * an Occultism entry under a parent without a display, and a recipe unlock that has a display.
 */
export const catalog: CatalogEntry[] = [
  entry("minecraft:story/root", "Minecraft", null),
  entry("minecraft:story/mine_stone", "Stone Age", "minecraft:story/root"),
  entry("minecraft:story/upgrade_tools", "Getting an Upgrade", "minecraft:story/mine_stone"),
  entry("minecraft:story/smelt_iron", "Acquire Hardware", "minecraft:story/upgrade_tools"),
  entry("minecraft:story/lava_bucket", "Hot Stuff", "minecraft:story/smelt_iron"),
  entry("minecraft:story/iron_tools", "Isn't It Iron Pick", "minecraft:story/smelt_iron"),
  entry("quark:get_all_blossom_saplings", "Blossoming", "minecraft:story/mine_stone", { frame: "challenge", criteria: 5, requirements: 5 }),
  entry("minecraft:recipes/misc/pen", "One pen", "minecraft:story/root"),
  entry("minecraft:nether/root", "Nether", null),
  entry("minecraft:nether/explore_nether", "Hot Tourist Destinations", "minecraft:nether/root", { criteria: 5, requirements: 5 }),
  entry("minecraft:nether/all_effects", "How Did We Get Here?", "minecraft:nether/root", { hidden: true }),
  entry("minecraft:adventure/root", "Adventure", null, { criteria: 2 }),
  entry("minecraft:adventure/kill_a_mob", "Monster Hunter", "minecraft:adventure/root", { criteria: 3 }),
  entry("mekanism:root", "Mekanism", null),
  entry("mekanism:materials", "First Steps", "mekanism:root"),
  entry("mekanism:metallurgic_infuser", "A Metallur-what?", "mekanism:materials"),
  entry("mekanism:basic_control_circuit", "advancements.mekanism.basic_control_circuit.title", "mekanism:metallurgic_infuser"),
  entry("mekanism:teleporter", "advancements.mekanism.teleporter.title", "mekanism:materials", { criteria: 4, requirements: 2 }),
  entry("camping:main/root", "Welcome to Camping!", null),
  entry("camping:main/bag", "Big bags!", "camping:main/root", { criteria: 2, requirements: 2 }),
  entry("occultism:occultism/familiar_bat", "Bat Familiar", "occultism:occultism/root"),
];

const progress = (id: string, done: boolean, criteria: string[] = ["done"]): AdvancementProgress =>
  ({ id, done, criteriaDone: criteria.length, criteriaTotal: null, title: null, frame: null, criteriaTruncated: false, criteria: criteria.map(name => ({ name, atMs: savedAt - 3_600_000 })) });
export const garyProgress: AdvancementProgress[] = [
  ...["minecraft:story/root", "minecraft:story/mine_stone", "minecraft:story/upgrade_tools", "minecraft:story/smelt_iron", "minecraft:nether/root",
    "mekanism:root", "mekanism:materials", "occultism:occultism/root"].map(id => progress(id, true)),
  progress("minecraft:nether/explore_nether", false, ["minecraft:basalt_deltas", "minecraft:nether_wastes"]),
  progress("camping:main/bag", false, ["has_bundle"]),
];
/** What `computeFrontier` should find for Gary: three in Minecraft, one in Nether, two in Mekanism, the Camping root. */
export const garyFrontier = [
  "minecraft:story/iron_tools", "minecraft:story/lava_bucket", "quark:get_all_blossom_saplings", "minecraft:nether/explore_nether",
  "mekanism:metallurgic_infuser", "mekanism:teleporter", "camping:main/root",
];

/** Stores the catalog and a resident's progress as the hub's ingest does. */
export function seedAdvancements(db: Database, resident = "Gary", advancements: AdvancementProgress[] = garyProgress, at = savedAt) {
  storeCatalog(db, catalog, at - 86_400_000);
  storeAdvancements(db, {
    resident, status: "observed", reason: null, savedAtMs: at, total: advancements.length, done: advancements.filter(a => a.done).length,
    matched: advancements.length, offset: 0, more: false, advancements,
  }, at + 60_000);
}
