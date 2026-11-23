import { z } from "zod";
import type { Knowledge, ModFacts, ModItemRef, RecipeSummary } from "./knowledge/types.ts";
import { referenceGuides } from "./guides-data.ts";
import type { PackKinds } from "./ideas.ts";

/**
 * `mods`: what is installed in this pack, the way a player browses it with JEI's `@mod` search, the
 * advancement tabs and the mods' own books. Everything shown comes from the knowledge export (built from the
 * jars); this file only sorts mods into kinds and words the replies. Information, never a suggestion of what
 * to pursue.
 */
export const modsDefinition = {
  description: "What this modpack has installed, as a player browses it in JEI and the advancement tabs: without query, the kinds of mods with their names; query a kind (\"guns\", \"magic\", \"machines\"…) for one line per mod; query a mod (name or id) for what it adds, where its advancement tab starts, a first craft from ordinary materials, its book and items to look up; query \"@mod words\" lists its items like JEI's @ search. page continues a long list. Information only.",
  schema: z.object({
    query: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(500).optional(),
  }).strict(),
};
export type ModsArgs = z.infer<typeof modsDefinition.schema>;

export interface Category { readonly id: string; readonly name: string; readonly words: RegExp }
/** Kinds a player would recognise, in the order the overview lists them. */
export const categories: readonly Category[] = [
  { id: "storage", name: "storage and carrying", words: /backpack|storage|chest|barrel|crate|\bbags?\b|hoard|drawer/ },
  { id: "tools", name: "tools, weapons and armour", words: /weapon|sword|armou?r|helmet|chestplate|spear|dagger|artifact|accessor|equipment|\btools?\b|drill/ },
  { id: "guns", name: "guns", words: /\bguns?\b|firearm|\bammo\b|turret|rifle|pistol/ },
  { id: "machines", name: "machines and power", words: /machine|energy|power|generator|reactor|industr|engineer|high-tech|tech\b|automat|factory|multiblock|simulation/ },
  { id: "redstone", name: "redstone and security", words: /redstone|logic gate|circuit|security|keypad|retinal|protect|safe with/ },
  { id: "magic", name: "magic", words: /magic|ritual|spirit|occult|\baura\b|spell|mana|arcane|summon/ },
  { id: "farming", name: "farming and food", words: /farm|crops?\b|\bfood|cook|kitchen|harvest|husbandry/ },
  { id: "building", name: "building and decoration", words: /decorat|furniture|blocks to build|build with|vanilla\+ blocks|vanilla blocks|bricks?\b|marble|shingles|chairs?\b/ },
  { id: "travel", name: "exploration and travel", words: /travel|teleport|waystone|aircraft|airship|elevator|explor|loot|camping|\btents?\b|outside|camera|photograph/ },
  { id: "world", name: "world generation", words: /biomes?|terrain|structures?|villages|oceans|\bores?\b|floating islands|world ?gen/ },
  { id: "mobs", name: "mobs and animals", words: /\bmobs?\b|creatures?|animals?|\bpets?\b/ },
  { id: "qol", name: "quality of life", words: /(?!)/ },
];
const kindOf: Record<string, Category> = Object.fromEntries(categories.map(category => [category.id, category]));
/**
 * Where a mod's own words would sort it wrongly ("technical" counts it among the unlisted helpers). Every
 * other mod, including one added to the pack later, is sorted from its data alone.
 */
const corrections: Record<string, string> = {
  quark: "building", supplementaries: "building", amendments: "building", vista: "building",
  artifacts: "tools", camping: "travel", hostilenetworks: "machines", compactmachines: "machines", jumbofurnace: "machines",
  exposure: "travel", exposure_polaroid: "travel", lootr: "travel", ags_day_counter: "qol", ftbchunks: "qol", craftable_slimeball: "farming", decorative_core: "storage",
  embeddium: "technical", oculus: "technical", serverpause: "technical", clumps: "technical", do_a_barrel_roll: "technical",
};
const libraryWords = /\b(?:librar(?:y|ies)|api|apis|framework|abstraction|lib|dependency|stub|translation layer|compatibility layer|cross-mod|coremod|shared (?:classes|code)|base mod|developers?|devs|animation engine|documentation)\b/i;
const technicalWords = /performance|optimi[sz]|memory|render|\bfps\b|cull|shader|particle|sound|visual|config|key ?binds?|\bgui\b|\bhud\b|tooltip|minimap|world map|\bmaps?\b|recipe viewing|what you are looking at|profil|pathfind|\bbot\b|inventory management|controll? over you inventory|search|resource pack|\bunif|light!/i;

export type Placement = { kind: "listed"; category: Category } | { kind: "hidden"; reason: "base game" | "client-side" | "library" | "technical" };

/** Where the overview puts a mod: in a kind, or among the counted-but-unlisted libraries and client-side helpers. */
export function placeMod(mod: ModFacts): Placement {
  if (mod.id === "minecraft" || mod.id === "forge") return { kind: "hidden", reason: "base game" };
  if (mod.side === "client") return { kind: "hidden", reason: "client-side" };
  const text = `${mod.name} ${mod.description}`;
  const content = mod.items + mod.biomes + mod.structures;
  const corrected = corrections[mod.id];
  if (corrected === "technical") return { kind: "hidden", reason: "technical" };
  // A jar inside another jar with nothing of its own to show is that jar's helper (Fabric API's modules, Mixin).
  const bundled = mod.jar.includes("!") && content === 0;
  // A library may carry an item or two of its own (Patchouli's book) or examples nobody can craft (GeckoLib).
  const slight = content <= 1 || mod.recipes === 0;
  if (!mod.tabs.length && mod.items <= 20 && (bundled || (slight && libraryWords.test(text)) || (mod.requiredBy.length > 0 && content === 0))) return { kind: "hidden", reason: "library" };
  if (!mod.tabs.length && mod.items <= 3 && mod.worldgen <= 10 && technicalWords.test(text)) return { kind: "hidden", reason: "technical" };
  if (corrected && kindOf[corrected]) return { kind: "listed", category: kindOf[corrected]! };
  if (mod.guns > 0) return { kind: "listed", category: kindOf.guns! };
  const words = mod.words.join(" ");
  let best: Category | undefined;
  let bestScore = 0;
  for (const category of categories) {
    const hits = (source: string) => (source.toLowerCase().match(new RegExp(category.words.source, "g")) ?? []).length;
    let score = 3 * hits(mod.name) + 2 * hits(mod.description) + hits(words) + hits(mod.recipeTypes.join(" "));
    if (category.id === "world" && mod.items <= 30 && mod.biomes + mod.structures > 0) score += 10;
    if (category.id === "machines" && mod.recipeTypes.length >= 10) score += 3;
    if (score > bestScore) { best = category; bestScore = score; }
  }
  if (best) return { kind: "listed", category: best };
  if (mod.items === 0 && mod.worldgen > 0) return { kind: "listed", category: kindOf.world! };
  return { kind: "listed", category: kindOf.qol! };
}

const LIMIT = 1300;
const label = (ref: ModItemRef) => (ref.name ? `${ref.name} (${ref.id})` : ref.id);
const sentence = (text: string, max: number) => {
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? `${text}.`;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};
function recipeLine(recipe: RecipeSummary): string {
  const stacks = (list: RecipeSummary["inputs"]) => list.map(part => `${part.count}x ${part.what}`).join(" + ");
  return `${stacks(recipe.inputs)} -> ${stacks(recipe.outputs)} (${recipe.type.replace(/^minecraft:/, "")})`;
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function contents(mod: ModFacts): string {
  const parts: string[] = [];
  // Gun-pack entries are counted apart: in the game they are data inside a few TaCZ items.
  const items = mod.items - mod.guns - mod.ammo - mod.attachments;
  if (items) parts.push(`${count(items, "item")}${mod.blocks ? ` (${count(mod.blocks, "block")} among them)` : ""}`);
  if (mod.guns) parts.push(`${count(mod.guns, "gun")}, ${count(mod.ammo, "kind")} of ammo and ${count(mod.attachments, "attachment")} in its gun pack`);
  if (mod.biomes) parts.push(count(mod.biomes, "biome"));
  if (mod.structures) parts.push(count(mod.structures, "structure"));
  if (!parts.length && mod.worldgen) parts.push(count(mod.worldgen, "world-generation file"));
  return parts.length ? parts.join(", ") : "no items or blocks";
}

/** Pages a list of lines under a header, keeping every line whole. */
function paged(header: string, lines: string[], footer: string, page: number, again: string): string {
  const pages: string[][] = [[]];
  const room = LIMIT - header.length - footer.length - 60;
  for (const line of lines) {
    const current = pages.at(-1)!;
    if (current.length && [...current, line].join("\n").length > room) pages.push([line]);
    else current.push(line);
  }
  if (page > pages.length) return `${header}\nNo page ${page}; there ${pages.length === 1 ? "is 1 page" : `are ${pages.length} pages`}.`;
  const more = page < pages.length ? `\nPage ${page} of ${pages.length}; more with ${again}, page ${page + 1}.` : pages.length > 1 ? `\nPage ${page} of ${pages.length}.` : "";
  return `${header}\n${pages[page - 1]!.join("\n")}${more}\n${footer}`.trimEnd();
}

interface Placed { mod: ModFacts; placement: Placement }

function overview(placed: Placed[], page: number): string {
  const listed = placed.filter(entry => entry.placement.kind === "listed");
  const hidden = placed.length - listed.length - placed.filter(entry => entry.placement.kind === "hidden" && entry.placement.reason === "base game").length;
  const header = `This pack: ${listed.length} mods that add things to the world, by kind, plus ${hidden} libraries and client-side helpers (query "libraries"). Information, not a to-do list.`;
  const lines = categories.flatMap(category => {
    const names = listed.filter(entry => entry.placement.kind === "listed" && entry.placement.category === category).map(entry => entry.mod.name);
    if (!names.length) return [];
    const shown = names.slice(0, 5).join(", ");
    return [`${category.name} (${names.length}): ${shown}${names.length > 5 ? `, ${names.length - 5} more` : ""}`];
  });
  return paged(header, lines, 'mods {query:"<kind>"} gives a line per mod; mods {query:"<mod>"} one mod in full; mods {query:"@<mod>"} its items.', page, "the same query");
}

function categoryReply(category: Category, placed: Placed[], page: number): string {
  const mods = placed.filter(entry => entry.placement.kind === "listed" && entry.placement.category === category).map(entry => entry.mod);
  const lines = mods.map(mod => {
    const start = mod.tabStart ? `its tab starts with ${mod.tabStart.name ?? mod.tabStart.id}` : mod.firstCraft ? `a first craft: ${mod.firstCraft.name ?? mod.firstCraft.id}` : "";
    const extras = [contents(mod), mod.books.length ? `book: ${mod.books[0]!.name}` : "", mod.tabs.length && !mod.tabStart ? `advancement tab "${mod.tabs[0]!.title}"` : "", start].filter(Boolean);
    return `- ${mod.name} (${mod.id}): ${mod.description ? `${sentence(mod.description, 110)} ` : ""}${extras.join("; ")}.`;
  });
  return paged(`${category.name}: ${mods.length} installed mod${mods.length === 1 ? "" : "s"}.`, lines, 'mods {query:"<mod id>"} for one in full.', page, `query "${category.id}"`);
}

function hiddenReply(placed: Placed[], page: number): string {
  const hidden = placed.filter(entry => entry.placement.kind === "hidden" && entry.placement.reason !== "base game");
  const groups: [string, string][] = [["library", "Libraries other mods need"], ["client-side", "Client-side only (rendering, menus, sound)"], ["technical", "Performance, interface and other technical helpers"]];
  const lines = groups.flatMap(([reason, title]) => {
    const names = hidden.filter(entry => entry.placement.kind === "hidden" && entry.placement.reason === reason).map(entry => entry.mod.name);
    if (!names.length) return [];
    // Lines short enough to page: a long group continues on the next line.
    const chunks: string[] = [`${title} (${names.length}):`];
    for (const name of names) {
      if (chunks.at(-1)!.length + name.length > 300) chunks.push("  …");
      chunks[chunks.length - 1] += ` ${name},`;
    }
    return chunks.map(chunk => chunk.replace(/,$/, ""));
  });
  return paged(`${hidden.length} installed mods add nothing to place or craft, so the overview only counts them.`, lines, "", page, 'query "libraries"');
}

function modReply(mod: ModFacts, placement: Placement, page: number): string {
  const where = placement.kind === "listed" ? placement.category.name : placement.reason;
  const lines: string[] = [];
  if (mod.description) lines.push(sentence(mod.description, 300));
  lines.push(`Adds ${contents(mod)}${mod.recipeTypes.length ? `, and ${count(mod.recipeTypes.length, "kind")} of recipe of its own` : ""}.`);
  if (mod.tabStart) {
    const leads = mod.tabStart.leadsTo.map(next => next.title).join(", ");
    lines.push(`Its advancement tab "${mod.tabs[0]?.title ?? mod.name}" (${count(mod.tabs.reduce((sum, tab) => sum + tab.advancements, 0), "advancement")}) starts with "${mod.tabStart.advancement}": ${label(mod.tabStart)}, ${recipeLine(mod.tabStart.recipe)}.${leads ? ` That opens: ${leads}.` : ""}`);
  } else if (mod.tabs.length) {
    lines.push(`Advancement tab${mod.tabs.length > 1 ? "s" : ""}: ${mod.tabs.map(tab => `"${tab.title}" (${tab.advancements})`).join(", ")}.`);
  }
  if (mod.firstCraft && mod.firstCraft.id !== mod.tabStart?.id) {
    lines.push(`A first craft, ${count(mod.firstCraft.steps, "step")} from things found in the world: ${label(mod.firstCraft)}, ${recipeLine(mod.firstCraft.recipe)}.`);
  }
  for (const book of mod.books) {
    lines.push(`Book: ${book.name}${book.item ? ` (item ${book.item}${book.item === "patchouli:guide_book" ? " holding this book" : ""})` : ""}${book.pages ? `; its ${book.pages} indexed pages answer guide {query:"<topic>", section:"books"}` : ""}.`);
  }
  const curated = referenceGuides.find(guide => guide.aliases.some(alias => alias.toLowerCase() === mod.id || alias.toLowerCase() === mod.name.toLowerCase()));
  if (curated) lines.push(`Reference: guide {query:"${curated.id}"} (${curated.title}).`);
  if (mod.signature.length) lines.push(`Some of its items: ${mod.signature.map(label).join(", ")}.`);
  const stations = mod.stations.filter(station => !mod.signature.some(entry => entry.id === station.id) && station.id !== mod.firstCraft?.id);
  if (stations.length) lines.push(`Where more of its own recipes are made: ${stations.slice(0, 3).map(label).join(", ")}.`);
  if (mod.requires.length) lines.push(`Needs: ${mod.requires.join(", ")}.`);
  if (mod.requiredBy.length) lines.push(`Installed mods that build on it: ${mod.requiredBy.join(", ")}.`);
  const key = mod.tabStart ?? mod.firstCraft ?? mod.signature[0];
  const footer = `${key ? `recipes/uses ${key.id} show how it fits; ` : ""}${mod.items ? `mods {query:"@${mod.id}"} lists its ${count(mod.items, "item")}.` : ""}`;
  return paged(`${mod.name} (${mod.id}), ${where}.`, lines, footer, page, `query "${mod.id}"`);
}

function itemsReply(knowledge: Knowledge, mod: ModFacts, words: string, page: number): string {
  const filter = words ? ` matching "${words}"` : "";
  // Pages are cut by length, so the whole match is read (the largest mod here has about 2,400 items).
  const items: { id: string; name: string | null; kind: string }[] = [];
  let total = 0;
  do {
    const found = knowledge.modItems!(mod.id, words, items.length, 500);
    total = found.total;
    items.push(...found.items);
    if (!found.items.length) break;
  } while (items.length < total);
  if (!total) return `${mod.name} has no indexed items${filter}.`;
  const lines = items.map(item => `${item.name ?? item.id} (${item.id})${item.kind === "item" ? "" : ` [${item.kind}]`}`);
  return paged(`${mod.name}: ${count(total, "item")}${filter}, by name. recipes/uses take any id below.`, lines, "", page, "the same query");
}

/** Mods whose id or name matches: an exact id or name wins, then any containing every word. */
function findMods(placed: Placed[], query: string): Placed[] {
  const wanted = query.toLowerCase();
  const exact = placed.filter(entry => entry.mod.id === wanted || entry.mod.name.toLowerCase() === wanted);
  if (exact.length) return exact;
  const words = wanted.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return placed.filter(entry => words.length > 0 && words.every(word => `${entry.mod.id} ${entry.mod.name}`.toLowerCase().includes(word)));
}

export function modsReply(knowledge: Knowledge, args: ModsArgs): string {
  const list = knowledge.modList?.();
  if (!list) return "This knowledge export predates the mod overview; rebuild it with scripts/build-knowledge.ts to list installed mods.";
  const placed = list.map(mod => ({ mod, placement: placeMod(mod) }));
  const page = args.page ?? 1;
  const query = args.query?.trim() ?? "";
  if (!query || /^(?:all|overview|list|kinds|categories)$/i.test(query)) return overview(placed, page);
  if (query.startsWith("@")) {
    const [name = "", ...rest] = query.slice(1).trim().split(/\s+/);
    const found = findMods(placed, name);
    if (found.length !== 1) return found.length ? `Several mods match "@${name}": ${found.map(entry => entry.mod.id).join(", ")}. Use one id.` : `No installed mod matches "@${name}". mods lists them.`;
    return itemsReply(knowledge, found[0]!.mod, rest.join(" "), page);
  }
  if (/^(?:libraries|library|hidden|client|client-side)$/i.test(query)) return hiddenReply(placed, page);
  const lower = query.toLowerCase();
  const category = categories.find(candidate => candidate.id === lower || candidate.name === lower || candidate.name.split(/[ ,]+/).includes(lower));
  if (category) return categoryReply(category, placed, page);
  const found = findMods(placed, query);
  if (found.length === 1) return modReply(found[0]!.mod, found[0]!.placement, page);
  if (found.length > 1) return `Several installed mods match "${query}":\n${found.slice(0, 12).map(entry => `- ${entry.mod.name} (${entry.mod.id})`).join("\n")}\nQuery one id.`;
  return `No installed mod or kind matches "${query}". Kinds: ${categories.map(candidate => candidate.id).join(", ")}, libraries. find_item searches item names.`;
}

/** The listed kinds with their mod counts, and an item's kind by its mod, for what_next. Undefined for an older export. */
export function packKinds(knowledge: Knowledge): PackKinds | undefined {
  const list = knowledge.modList?.();
  if (!list) return undefined;
  const kindOfMod = new Map<string, string>();
  for (const mod of list) {
    const placement = placeMod(mod);
    if (placement.kind === "listed") kindOfMod.set(mod.id, placement.category.name);
  }
  const kinds = categories.map(category => ({ name: category.name, mods: [...kindOfMod.values()].filter(name => name === category.name).length })).filter(kind => kind.mods > 0);
  return { kinds, kindOf: itemId => { const mod = knowledge.modOf?.(itemId); return mod ? kindOfMod.get(mod.id) : undefined; } };
}

/** "From Mekanism (mods mekanism)." for an item's lookup, or nothing for the base game or an older export. */
export function fromMod(knowledge: Knowledge, itemId: string): string {
  const mod = knowledge.modOf?.(itemId);
  return mod && mod.id !== "minecraft" ? `From ${mod.name} (mods {query:"${mod.id}"}).` : "";
}
