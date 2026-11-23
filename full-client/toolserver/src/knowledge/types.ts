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
  /** Every installed mod with what the export found in its jar; undefined when the export predates the pack overview. */
  modList?(): ModFacts[] | undefined;
  /** The installed mod an item or block id belongs to (by its namespace), with that mod's display name. */
  modOf?(itemId: string): { id: string; name: string } | undefined;
  /** One mod's registered items, by display name, like JEI's `@mod` search; `words` narrows by name or id. */
  modItems?(mod: string, words: string, offset: number, limit: number): { items: (ItemHit & { kind: string })[]; total: number };
  /** A displayed, not hidden advancement as the pack's jars define it, with its English title and description and the
   * item ids its criteria name; undefined when the export has no such advancement (or predates advancements). */
  advancement?(id: string): { title: string; description: string; items: string[] } | undefined;
  close(): void;
}

export interface ModItemRef { readonly id: string; readonly name: string | null }
export interface ModRecipeRef extends ModItemRef { readonly recipe: RecipeSummary }

/** One installed mod as the export sees it: metadata, contents, and where a player gets into it. */
export interface ModFacts {
  readonly id: string;
  readonly name: string;
  /** From mods.toml/fabric.mod.json, else its advancement tab's own description; may be empty. */
  readonly description: string;
  /** "client" when the mod declares it is needed only on the client (rendering, menus, sounds). */
  readonly side: "both" | "client";
  readonly jar: string;
  /** Installed mods it needs, and installed mods that need it (its add-ons, or the mods a library serves). */
  readonly requires: readonly string[];
  readonly requiredBy: readonly string[];
  /** Registered items (a block's item included), blocks among them, and TaCZ gun-pack guns, ammo and attachments. */
  readonly items: number;
  readonly blocks: number;
  readonly guns: number;
  readonly ammo: number;
  readonly attachments: number;
  /** Recipes whose output is one of its items. */
  readonly recipes: number;
  /** Recipe types it defines, most recipes first: its machines, altars and workbenches. */
  readonly recipeTypes: readonly string[];
  readonly biomes: number;
  readonly structures: number;
  readonly worldgen: number;
  /** Its own advancement tabs: title, size, and the titles of the root's first children. */
  readonly tabs: readonly { title: string; description: string; advancements: number; first: readonly string[] }[];
  /** In-game guide books (Patchouli, Modonomicon, the IE manual) and how many indexed pages `guide` can search. */
  readonly books: readonly { id: string; name: string; item: string | null; pages: number }[];
  /**
   * A first craft: of its items with a crafting or smelting recipe, the fewest steps from things found in the
   * world (every mod's parts counted, a machine recipe also needing its machine), the mod's namesake item first,
   * then the most used; `steps` is that count.
   */
  readonly firstCraft?: ModRecipeRef & { steps: number };
  /**
   * The first item in its own advancement tab that has a crafting or smelting recipe, that advancement's title,
   * and the advancements it opens (with an item each names, when it names one of the mod's).
   */
  readonly tabStart?: ModRecipeRef & { advancement: string; leadsTo: readonly { title: string; item: string | null }[] };
  /** Blocks whose names match its own recipe types: where its special recipes are made. */
  readonly stations: readonly ModItemRef[];
  /** A few items that stand for the mod: stations, items its advancements name, its most used ingredients. */
  readonly signature: readonly ModItemRef[];
  /** The commonest words in its item ids, for sorting mods into kinds. */
  readonly words: readonly string[];
}
