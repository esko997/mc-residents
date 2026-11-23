/**
 * What a resident can look up about this modpack without asking a human:
 * items by name, how to make them, what they are used for, and what the mods'
 * own guide books say. Built once from the mod jars into a SQLite file; the
 * tool server only reads it.
 */

export interface ItemHit {
  /** Registry id, for example `mekanism:ingot_osmium`. */
  readonly id: string;
  /** English display name when the mod's language file has one. */
  readonly name: string | null;
}

export interface RecipeIngredient {
  /** An item id, or a tag written with a leading `#` such as `#forge:ingots/iron`. */
  readonly what: string;
  readonly count: number;
}

export interface RecipeSummary {
  /** Recipe id from its file path, for example `mekanism:processing/osmium/ingot/from_ore_smelting`. */
  readonly id: string;
  /** Recipe type, for example `minecraft:crafting_shaped` or `mekanism:enriching`. */
  readonly type: string;
  readonly outputs: readonly RecipeIngredient[];
  /** Inputs with duplicates merged; fluids and gases appear as their ids. */
  readonly inputs: readonly RecipeIngredient[];
  /**
   * For shaped crafting only: rows of the grid, each cell an item id, a `#tag`, or `null` for empty.
   * Lets a craft helper place the pattern without re-reading the recipe file.
   */
  readonly pattern: readonly (readonly (string | null)[])[] | null;
  /** Anything else worth a line: processing time, energy, required machine or catalyst. */
  readonly note: string | null;
}

export interface GuideHit {
  /** Book and entry, for example `occultism:dictionary_of_spirits / Summoning a Foliot`. */
  readonly where: string;
  /** Plain text around the match, formatting codes removed, at most a few hundred characters. */
  readonly excerpt: string;
}

export interface Knowledge {
  /** Match on id or display name, case-insensitive substring; exact matches first. */
  findItems(query: string, limit?: number): ItemHit[];
  /** Recipes whose output is this item id. */
  recipesFor(itemId: string, limit?: number): RecipeSummary[];
  /** Recipes that take this item id (directly, or through a tag that contains it). */
  usesOf(itemId: string, limit?: number): RecipeSummary[];
  /** Items in a tag, for example `forge:ingots/iron` (no leading `#`). */
  itemsInTag(tag: string, limit?: number): string[];
  /** Full-text search over guide-book entries. */
  searchGuides(query: string, limit?: number): GuideHit[];
  /**
   * Items a block's loot table can drop when broken with an ordinary tool (entries that need Silk Touch or
   * shears left out), for example `denseores:dense_iron_ore` -> `minecraft:raw_iron`. Undefined when the export
   * predates loot tables; empty when the block has none.
   */
  blockDrops?(blockId: string): string[] | undefined;
  close(): void;
}
