import type { Database } from "bun:sqlite";
import { parseToml, type TomlValue } from "./toml";
import type { ModFacts, ModItemRef, ModRecipeRef, RecipeSummary } from "./types";

/**
 * The pack overview part of the knowledge export: which mods are installed, what each adds and where a
 * player gets into it. Everything here is read from the jars (mods.toml, assets, data, advancements, books)
 * and the recipe index built beside it; nothing is written by hand, so a rebuilt export follows the pack.
 */

/** What a jar's own metadata says about one mod in it. */
export interface ModMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Marked as needed on the client only (Forge displayTest IGNORE_*_VERSION, NeoForge clientSideOnly, Fabric environment client). */
  readonly clientOnly: boolean;
  /** Mod ids it cannot run without. */
  readonly requires: readonly string[];
}

/** What one jar (or a jar nested inside one) contains, gathered while the build reads it. */
export interface JarFacts {
  readonly file: string;
  readonly mods: ModMeta[];
  /** Namespaces of its `assets/` and `data/` folders and of its English item/block names. */
  readonly namespaces: Set<string>;
  biomes: number;
  structures: number;
  /** All world-generation files: features, biomes, structures, structure templates, biome modifiers. */
  worldgen: number;
}

const str = (value: TomlValue | unknown): string => (typeof value === "string" ? value : "");
const clean = (text: string): string => text.replace(/\$\{[^}]*\}/g, "").replace(/§[0-9a-fk-or]/gi, "").replace(/\s+/g, " ").trim();
const isTable = (value: unknown): value is Record<string, TomlValue> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Namespaces every mod writes into; they say nothing about who owns them. */
const shared: Record<string, true> = { c: true, forge: true, minecraft: true, fabric: true, neoforge: true, realms: true, common: true };

/** The `[[mods]]` entries (or inline `mods = [{…}]`) of a Forge/NeoForge mods.toml, with their required dependencies. */
export function modsFromToml(text: string): ModMeta[] {
  const doc = parseToml(text);
  const entries = [...(Array.isArray(doc.root.mods) ? doc.root.mods : []), ...doc.tables.filter(table => table.header === "mods" && table.array).map(table => table.values)]
    .filter(isTable).filter(entry => typeof entry.modId === "string");
  const requires = new Map<string, string[]>();
  const dependency = (owner: string, value: unknown) => {
    if (!isTable(value) || typeof value.modId !== "string") return;
    // Forge: mandatory = true; NeoForge: type = "required".
    if (value.mandatory === true || value.type === "required") requires.set(owner, [...(requires.get(owner) ?? []), value.modId]);
  };
  for (const table of doc.tables) {
    const owner = /^dependencies\.(.+)$/.exec(table.header)?.[1];
    if (owner && table.array) dependency(owner, table.values);
  }
  if (isTable(doc.root.dependencies)) {
    for (const [owner, list] of Object.entries(doc.root.dependencies)) if (Array.isArray(list)) for (const value of list) dependency(owner, value);
  }
  const fileClientOnly = doc.root.clientSideOnly === true;
  return entries.map(entry => {
    const id = str(entry.modId);
    return {
      id, name: clean(str(entry.displayName)) || id, description: clean(str(entry.description)),
      clientOnly: fileClientOnly || entry.clientSideOnly === true || /^IGNORE_(?:ALL|SERVER)_VERSION$/.test(str(entry.displayTest)),
      requires: (requires.get(id) ?? []).filter(dep => dep !== id),
    };
  });
}

/** A Fabric mod's `fabric.mod.json` (loaded here through Sinytra Connector). */
export function modsFromFabric(text: string): ModMeta[] {
  const data: unknown = JSON.parse(text);
  if (!isTable(data) || typeof data.id !== "string") return [];
  const depends = isTable(data.depends) ? Object.keys(data.depends) : [];
  return [{ id: data.id, name: clean(str(data.name)) || data.id, description: clean(str(data.description)), clientOnly: data.environment === "client", requires: depends }];
}

/** Counts a jar entry toward the jar's world-generation figures. */
export function countWorldgen(facts: JarFacts, path: string): void {
  if (/^data\/[^/]+\/worldgen\/biome\/.+\.json$/.test(path)) facts.biomes++;
  if (/^data\/[^/]+\/worldgen\/structure\/.+\.json$/.test(path)) facts.structures++;
  if (/^data\/[^/]+\/(?:worldgen\/|structures?\/|forge\/biome_modifier\/|tags\/worldgen\/)/.test(path) && !path.endsWith("/")) facts.worldgen++;
}

const handTypes = ["minecraft:crafting_shaped", "minecraft:crafting_shapeless", "minecraft:smelting", "minecraft:blasting"];
/** Made in a crafting grid or a furnace, no machine: vanilla types, and mods' own grid types (a recipe with a pattern, or named shaped/shapeless). */
const byHand = (recipe: RecipeSummary) => handTypes.includes(recipe.type) || recipe.pattern !== null || /shaped|shapeless/.test(recipe.type);
const handOrder = (recipe: RecipeSummary) => (handTypes.includes(recipe.type) ? handTypes.indexOf(recipe.type) : handTypes.length);
/** Words in recipe-type names that say nothing about which block does the work. */
const generic: Record<string, true> = Object.fromEntries("crafting recipe recipes shaped shapeless custom special processing machine the and with".split(" ").map(word => [word, true]));
const tokens = (path: string): string[] => path.split(/[/_.-]+/).filter(Boolean);
const close = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
const namespace = (id: string) => id.slice(0, id.indexOf(":"));
const pathOf = (id: string) => id.slice(id.indexOf(":") + 1);

interface Advancement { id: string; parent: string | null; title: string; description: string; items: string[] }

/**
 * Writes the `mods` and `namespaces` tables and fills `registered.mod`, once every jar has been read and the
 * recipe, tag, advancement and guide tables are complete.
 */
export function indexMods(db: Database, jars: readonly JarFacts[]): void {
  db.exec(`CREATE TABLE mods(id TEXT PRIMARY KEY, name TEXT NOT NULL, facts TEXT NOT NULL);
    CREATE TABLE namespaces(namespace TEXT PRIMARY KEY, mod TEXT NOT NULL);`);
  const metas = new Map<string, { meta: ModMeta; jar: JarFacts }>();
  for (const jar of jars) for (const meta of jar.mods) if (!metas.has(meta.id)) metas.set(meta.id, { meta, jar });
  // The game itself: its items live in the vanilla client jar, which has no mods.toml.
  if (!metas.has("minecraft")) metas.set("minecraft", { meta: { id: "minecraft", name: "Minecraft", description: "The base game.", clientOnly: false, requires: [] }, jar: { file: "", mods: [], namespaces: new Set(), biomes: 0, structures: 0, worldgen: 0 } });
  const owner = new Map<string, string>([["minecraft", "minecraft"], ["forge", "forge"]]);
  for (const id of metas.keys()) if (!shared[id]) owner.set(id, id);
  for (const jar of jars) {
    const primary = jar.mods[0]?.id;
    if (!primary) continue;
    for (const ns of [...jar.namespaces].sort()) if (!shared[ns] && !owner.has(ns)) owner.set(ns, primary);
  }
  const nsInsert = db.query("INSERT INTO namespaces VALUES (?,?)");
  for (const [ns, mod] of owner) nsInsert.run(ns, mod);
  db.exec(`UPDATE registered SET mod = (SELECT mod FROM namespaces WHERE namespace = substr(registered.id, 1, instr(registered.id, ':') - 1));
    CREATE INDEX registered_mod ON registered(mod, id);`);

  const names = new Map((db.query("SELECT id, name FROM items").all() as { id: string; name: string | null }[]).map(row => [row.id, row.name]));
  const nameOf = (id: string) => names.get(id) ?? null;
  const ref = (id: string): ModItemRef => ({ id, name: nameOf(id) });
  const uses = new Map((db.query("SELECT what, count(*) AS n FROM recipe_inputs GROUP BY what").all() as { what: string; n: number }[]).map(row => [row.what, row.n]));
  const typeCounts = db.query("SELECT type, count(*) AS n FROM recipes GROUP BY type").all() as { type: string; n: number }[];
  const produced = new Map((db.query(`SELECT r.mod AS mod, count(DISTINCT o.recipe) AS n FROM recipe_outputs o JOIN registered r ON r.id = o.what
    JOIN items i ON i.id = r.id GROUP BY r.mod`).all() as { mod: string | null; n: number }[]).map(row => [row.mod, row.n]));
  const contents = new Map<string, { id: string; kind: string }[]>();
  for (const row of db.query("SELECT r.id AS id, r.mod AS mod, r.kind AS kind FROM registered r JOIN items i ON i.id = r.id WHERE r.mod IS NOT NULL ORDER BY r.id").all() as { id: string; mod: string; kind: string }[]) {
    const list = contents.get(row.mod) ?? [];
    list.push({ id: row.id, kind: row.kind });
    contents.set(row.mod, list);
  }
  const byHandMaking = (item: string): RecipeSummary[] => anyRecipeMaking.all(item).map(row => JSON.parse(row.summary) as RecipeSummary)
    .filter(byHand).sort((a, b) => handOrder(a) - handOrder(b) || a.id.localeCompare(b.id));
  const tagItems = db.query<{ item: string }, [string]>("SELECT item FROM tag_items WHERE tag = ?");
  const anyRecipeMaking = db.query<{ summary: string }, [string]>("SELECT r.summary FROM recipes r JOIN recipe_outputs o ON o.recipe = r.id WHERE o.what = ?");
  // Does a recipe making the first item take the second, directly or through a tag holding it?
  const madeFromStatement = db.query<{ one: number }, [string, string, string]>(`SELECT 1 AS one FROM recipe_outputs o JOIN recipe_inputs i ON i.recipe = o.recipe
    LEFT JOIN tag_items t ON i.what = '#' || t.tag WHERE o.what = ? AND (i.what = ? OR t.item = ?) LIMIT 1`);
  const advancements = (db.query("SELECT id, parent, title, description, items FROM advancements").all() as { id: string; parent: string | null; title: string; description: string; items: string }[])
    .map((row): Advancement => ({ ...row, items: JSON.parse(row.items) as string[] }));
  const byId = new Map(advancements.map(adv => [adv.id, adv]));
  const children = new Map<string, Advancement[]>();
  for (const adv of advancements) if (adv.parent && byId.has(adv.parent)) children.set(adv.parent, [...(children.get(adv.parent) ?? []), adv]);
  for (const list of children.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  const books = db.query("SELECT id, name, item FROM books ORDER BY id").all() as { id: string; name: string; item: string | null }[];
  const pages = new Map((db.query("SELECT book, count(*) AS n FROM guides GROUP BY book").all() as { book: string; n: number }[]).map(row => [row.book, row.n]));

  const requiredBy = new Map<string, string[]>();
  for (const { meta } of metas.values()) for (const dep of meta.requires) if (metas.has(dep) && dep !== "minecraft" && dep !== "forge") requiredBy.set(dep, [...(requiredBy.get(dep) ?? []), meta.id]);

  // Recipe types each mod defines (its machines, altars, workbenches) and the block named like each.
  const stationOfType = new Map<string, string>();
  const machinery = new Map<string, { types: { type: string; n: number }[]; stations: ModItemRef[]; stationScore: Map<string, number> }>();
  for (const id of metas.keys()) {
    const types = typeCounts.filter(row => owner.get(namespace(row.type)) === id && id !== "minecraft").sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));
    const blocks = (contents.get(id) ?? []).filter(entry => entry.kind === "block").map(entry => entry.id);
    const stationScore = new Map<string, number>();
    const stations: ModItemRef[] = [];
    for (const { type, n } of types) {
      const wanted = tokens(pathOf(type)).filter(word => !generic[word] && word.length >= 3);
      if (!wanted.length) continue;
      const matches = blocks.filter(block => wanted.every(word => tokens(pathOf(block)).some(part => close(part, word))));
      // Mekanism's factories also match "enriching"; the chamber they are built from is the station.
      const basic = matches.filter(block => !anyRecipeMaking.all(block).some(row => matches.some(other => other !== block && row.summary.includes(`"${other}"`))));
      const found = (basic.length ? basic : matches).sort((a, b) => tokens(pathOf(a)).length - tokens(pathOf(b)).length || a.localeCompare(b))[0];
      if (!found) continue;
      stationOfType.set(type, found);
      stationScore.set(found, (stationScore.get(found) ?? 0) + n);
      if (!stations.some(station => station.id === found)) stations.push(ref(found));
    }
    machinery.set(id, { types, stations, stationScore });
  }

  // Steps from the world to each item, across every mod: what an add-on's parts really cost. Vanilla items and
  // things no recipe makes (or that drop from a block no recipe makes: raw ores) cost 0; a crafting or smelting
  // recipe costs one step more than its dearest input; a machine recipe also needs its machine.
  const members = new Map<string, string[]>();
  for (const row of db.query("SELECT tag, item FROM tag_items").all() as { tag: string; item: string }[]) members.set(row.tag, [...(members.get(row.tag) ?? []), row.item]);
  const allRecipes = (db.query("SELECT summary FROM recipes").all() as { summary: string }[]).map(row => JSON.parse(row.summary) as RecipeSummary);
  const made = new Set(allRecipes.flatMap(recipe => recipe.outputs.map(output => output.what)));
  // A block that drops something other than itself is a natural one (ore to raw metal, leaves to saplings).
  const natural = new Set<string>();
  for (const row of db.query("SELECT block, item FROM block_drops").all() as { block: string; item: string }[]) if (row.item !== row.block) natural.add(row.item);
  const kinds = new Map((db.query("SELECT id, kind FROM registered").all() as { id: string; kind: string }[]).map(row => [row.id, row.kind]));
  const cost = new Map<string, number>();
  const costOf = (what: string): number => {
    if (what.startsWith("#")) {
      const tagged = members.get(what.slice(1));
      // A tag no jar fills is a shared material name (#forge:ingots/iron) when it is in a shared namespace.
      if (!tagged?.length) return shared[namespace(what.slice(1))] ? 0 : 3;
      return Math.min(...tagged.map(costOf));
    }
    if (namespace(what) === "minecraft" || natural.has(what)) return 0;
    // Made by no recipe: a block is placed by world generation; anything else comes from loot, mobs or rituals.
    if (!made.has(what)) return kinds.get(what) === "block" ? 0 : 3;
    return cost.get(what) ?? Infinity;
  };
  for (let round = 0, changed = true; changed && round < 30; round++) {
    changed = false;
    for (const recipe of allRecipes) {
      if (!recipe.inputs.length) continue;
      const station = stationOfType.get(recipe.type);
      const need = byHand(recipe) ? 0 : station ? costOf(station) : 2;
      const value = Math.max(need, ...recipe.inputs.map(input => costOf(input.what))) + 1;
      if (!Number.isFinite(value)) continue;
      for (const output of recipe.outputs) {
        if (output.what.startsWith("#") || value >= (cost.get(output.what) ?? Infinity)) continue;
        cost.set(output.what, value);
        changed = true;
      }
    }
  }
  const stepsOf = (recipe: RecipeSummary) => Math.max(...recipe.inputs.map(input => costOf(input.what))) + 1;
  // Recipes mostly ask for a material tag (#forge:ingots/osmium), not the item: a tag of three or fewer items
  // stands for each of them, so its uses count as theirs. Broad tags (#minecraft:planks) would credit every plank.
  const tagUses = new Map<string, number>();
  for (const [tag, items] of members) {
    const n = uses.get(`#${tag}`) ?? 0;
    if (n && items.length <= 3) for (const item of items) tagUses.set(item, (tagUses.get(item) ?? 0) + n);
  }

  const insert = db.query("INSERT INTO mods VALUES (?,?,?)");
  for (const [id, { meta, jar }] of [...metas].sort(([a], [b]) => a.localeCompare(b))) {
    const own = contents.get(id) ?? [];
    const mine = new Set(own.map(entry => entry.id));
    const counts = { items: own.length, blocks: 0, guns: 0, ammo: 0, attachments: 0 };
    for (const entry of own) if (entry.kind === "block") counts.blocks++; else if (entry.kind === "gun") counts.guns++; else if (entry.kind === "ammo") counts.ammo++; else if (entry.kind === "attachment") counts.attachments++;
    const { types, stations, stationScore } = machinery.get(id)!;
    const score = (item: string) => (uses.get(item) ?? 0) + (tagUses.get(item) ?? 0) + (stationScore.get(item) ?? 0);
    // Nuggets back into an ingot is no way in: skip a recipe whose input is itself made from the item.
    const madeFrom = (input: string, item: string) => (input.startsWith("#") ? tagItems.all(input.slice(1)).map(row => row.item) : [input])
      .some(member => madeFromStatement.get(member, item, item) !== null);
    const recipeFor = (item: string): RecipeSummary | undefined =>
      byHandMaking(item).find(recipe => recipe.inputs.length > 0 && !recipe.inputs.some(input => madeFrom(input.what, item)));

    // A first craft: of its items the fewest crafting steps from the world, the mod's namesake (a Backpack in
    // Sophisticated Backpacks) first, then the most used (as an ingredient, or the block its own recipes are made in).
    const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(word => word.replace(/s$/, ""));
    const modWords = new Set(wordsOf(meta.name));
    const namesake = (item: string) => { const named = wordsOf(nameOf(item) ?? ""); return named.length > 0 && named.every(word => modWords.has(word)); };
    const rank = (a: { id: string; steps: number }, b: { id: string; steps: number }) =>
      a.steps - b.steps || Number(namesake(b.id)) - Number(namesake(a.id)) || score(b.id) - score(a.id) || a.id.localeCompare(b.id);
    let firstCraft: ModFacts["firstCraft"];
    for (const item of mine) {
      const recipe = byHandMaking(item).filter(candidate => candidate.inputs.length > 0).sort((a, b) => stepsOf(a) - stepsOf(b))[0];
      if (!recipe || !Number.isFinite(stepsOf(recipe))) continue;
      const candidate = { ...ref(item), recipe, steps: stepsOf(recipe) };
      if (!firstCraft || rank(candidate, firstCraft) < 0) firstCraft = candidate;
    }

    // Its own advancement tabs, as the advancement screen shows them.
    const roots = advancements.filter(adv => !adv.parent && owner.get(namespace(adv.id)) === id).sort((a, b) => a.id.localeCompare(b.id));
    const order: { adv: Advancement; depth: number }[] = [];
    const tabs = roots.map(root => {
      let size = 0;
      const queue = [{ adv: root, depth: 0 }];
      while (queue.length) {
        const next = queue.shift()!;
        size++;
        order.push(next);
        for (const child of children.get(next.adv.id) ?? []) queue.push({ adv: child, depth: next.depth + 1 });
      }
      const first = (children.get(root.id) ?? []).slice(0, 6).map(child => child.title);
      return { title: root.title, description: root.description, advancements: size, first };
    });
    order.sort((a, b) => a.depth - b.depth || a.adv.id.localeCompare(b.adv.id));
    let tabStart: ModFacts["tabStart"];
    // One item per advancement, in the order the tab unfolds: what the mod's authors chose to celebrate.
    const highlighted: string[] = [];
    for (const { adv } of order) {
      const items = adv.items.filter(item => mine.has(item));
      if (!tabStart) {
        for (const item of items) {
          const recipe = recipeFor(item);
          if (!recipe) continue;
          const leadsTo = (children.get(adv.id) ?? []).slice(0, 4).map(child => ({ title: child.title, item: child.items.find(entry => mine.has(entry)) ?? null }));
          tabStart = { ...ref(item), recipe, advancement: adv.title, leadsTo };
          break;
        }
        if (tabStart) continue;
      }
      const item = items.find(entry => !highlighted.includes(entry));
      if (item) highlighted.push(item);
    }
    const signature: ModItemRef[] = [];
    const add = (item: string) => { if (signature.length < 5 && item !== firstCraft?.id && item !== tabStart?.id && !signature.some(entry => entry.id === item) && nameOf(item)) signature.push(ref(item)); };
    for (const item of highlighted) add(item);
    for (const station of stations) add(station.id);
    // Gun-pack guns are used in no recipe, so no ranking finds them; three by name stand for the rest.
    for (const entry of own.filter(entry => entry.kind === "gun").sort((a, b) => (nameOf(a.id) ?? a.id).localeCompare(nameOf(b.id) ?? b.id)).slice(0, 3)) add(entry.id);
    for (const item of [...mine].sort((a, b) => score(b) - score(a) || a.localeCompare(b))) { if (signature.length >= 5 || !score(item)) break; add(item); }

    const words = new Map<string, number>();
    for (const item of mine) for (const word of tokens(pathOf(item))) if (word.length >= 3) words.set(word, (words.get(word) ?? 0) + 1);
    const facts: ModFacts = {
      // Placeholder text ("None.") says nothing; the advancement tab's own line is the next best description.
      id, name: meta.name, description: (/^(?:none|n\/a|todo|tbd|description)?\.?$/i.test(meta.description) ? "" : meta.description) || tabs[0]?.description || "",
      side: meta.clientOnly ? "client" : "both", jar: jar.file,
      requires: meta.requires.filter(dep => metas.has(dep) && dep !== id && dep !== "minecraft" && dep !== "forge"),
      requiredBy: (requiredBy.get(id) ?? []).sort(),
      ...counts, recipes: produced.get(id) ?? 0,
      recipeTypes: types.map(row => row.type),
      biomes: jar.biomes, structures: jar.structures, worldgen: jar.worldgen,
      tabs,
      books: books.filter(book => owner.get(namespace(book.id)) === id).map(book => ({ ...book, pages: pages.get(book.id) ?? 0 })),
      firstCraft, tabStart, stations: stations.slice(0, 6), signature,
      words: [...words].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([word]) => word),
    };
    // A jar shared by several mods (a library bundled with its user) counts its world generation once.
    if (jar.mods[0]?.id !== id) Object.assign(facts, { biomes: 0, structures: 0, worldgen: 0 });
    insert.run(id, meta.name, JSON.stringify(facts));
  }
}
