import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nonempty, type Position, type Stack, type State } from "./synapse.ts";
import type { Knowledge, RecipeSummary } from "./knowledge/types.ts";
import { span, type PlanFocus } from "./plan.ts";
import { beneficiaryOf, performerOf, type SocietySnapshot } from "./society.ts";
import { z } from "zod";

/**
 * `what_next`: suggestions worked out from what the body can see, for a
 * resident that is unsure. No model is asked. Each rule in the `rules` table
 * below reads one snapshot and returns a suggestion or nothing; every
 * number it prints comes from the snapshot.
 */
export interface SavedPlace { name: string; note?: string; x: number; y: number; z: number; dimension: string }
export interface SavedDeath { x: number; y: number; z: number; dimension: string; at: number }
export interface Snapshot {
  now: number;
  health: number;
  food: number;
  pos: Position;
  dimension: string;
  /** Non-empty stacks of the 36 inventory slots, hotbar included. */
  carried: Stack[];
  /** Armour pieces worn. */
  armour: Stack[];
  /** The resident's own and the shared saved places. */
  places: SavedPlace[];
  deaths: SavedDeath[];
  /** The plan in focus, when one is written. */
  plan?: PlanFocus;
  /** Recipes of this modpack; without it the rules use the vanilla recipes written beside them. */
  knowledge?: Pick<Knowledge, "recipesFor" | "itemsInTag">;
  /** Bounded resident reports, never machine-verified prerequisites. */
  society?: SocietySnapshot;
}
export interface Rule {
  id: string;
  /** Higher is shown first. */
  priority: number;
  suggest(view: View): string | undefined;
}
export interface Suggestion { id: string; priority: number; text: string }

type Match = (id: string) => boolean;
/** One ingredient of a recipe: `count` items out of those `accepts` allows. */
export interface Need { label: string; count: number; accepts: Match }
interface Checked extends Need { short: number }
/** A recipe held against what is carried; `share` is the part of its ingredients that is missing, 0 when all are carried. */
export interface Check { item: string; needs: Checked[]; missing: Checked[]; share: number }
interface Carried { total: number; kinds: [id: string, count: number][]; text: string }

const inventorySlots = 36, maxSuggestions = 5, suggestionLimit = 300;
const pathOf = (id: string) => id.slice(id.indexOf(":") + 1);
const suffix = (...endings: string[]): Match => id => endings.some(ending => id.endsWith(ending));
const named = (...paths: string[]): Match => id => paths.includes(pathOf(id));
const amount = (value: number) => String(Math.round(value * 10) / 10);
// Only for a client that sends no `edible` flag; with the flag, modded food counts too.
const vanillaFood = named(..."apple golden_apple enchanted_golden_apple bread baked_potato carrot golden_carrot beetroot melon_slice sweet_berries glow_berries dried_kelp cookie pumpkin_pie mushroom_stew rabbit_stew beetroot_soup cooked_beef cooked_porkchop cooked_chicken cooked_mutton cooked_rabbit cooked_cod cooked_salmon beef porkchop chicken mutton rabbit cod salmon tropical_fish potato honey_bottle".split(" "));

const planks = suffix("_planks"), sticks = named("stick");
const cobble = named("cobblestone", "cobbled_deepslate", "blackstone");
const need = (label: string, count: number, accepts: Match): Need => ({ label, count, accepts });
const twoSticks = need("minecraft:stick", 2, sticks);
const woolColours = "white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black".split(" ");

/** Crafting recipes for an item as ingredient lists, from the modpack's own recipe files. */
function knownRecipes(knowledge: NonNullable<Snapshot["knowledge"]>, item: string): Need[][] {
  const accepting = (choices: string[]): Match => {
    const ids = new Set(choices.flatMap(choice => choice.startsWith("#") ? knowledge.itemsInTag(choice.slice(1), 500) : [choice]));
    return id => ids.has(id);
  };
  const recipes: { recipe: RecipeSummary; needs: Need[] }[] = [];
  for (const recipe of knowledge.recipesFor(item, 40)) {
    if (!recipe.outputs.some(output => output.what === item)) continue;
    if (recipe.type === "minecraft:crafting_shaped" && recipe.pattern) {
      // A pattern cell holds only its first choice; the builder's note lists the others (coal or charcoal).
      const alternatives = new Map<string, string[]>();
      for (const match of (recipe.note ?? "").matchAll(/grid . alternatives: ([^;]+)/g)) {
        const choices = match[1]!.split(" or ");
        alternatives.set(choices[0]!, choices);
      }
      const cells = new Map<string, number>();
      for (const cell of recipe.pattern.flat()) if (cell) cells.set(cell, (cells.get(cell) ?? 0) + 1);
      if (cells.size) recipes.push({ recipe, needs: [...cells].map(([what, count]) => {
        const choices = alternatives.get(what) ?? [what];
        return need(choices.join(" or "), count, accepting(choices));
      }) });
    } else if (recipe.type === "minecraft:crafting_shapeless" && recipe.inputs.length && !recipe.note?.includes("ingredient alternatives are listed together")) {
      recipes.push({ recipe, needs: recipe.inputs.map(input => need(input.what, input.count, accepting([input.what]))) });
    }
  }
  // The game's own recipe first: mods add conversions that also make the item.
  return recipes.sort((a, b) => Number(!a.recipe.id.startsWith("minecraft:")) - Number(!b.recipe.id.startsWith("minecraft:"))).map(entry => entry.needs);
}

/** What one snapshot shows, with the questions rules ask of it. */
export class View {
  readonly counts = new Map<string, number>();
  private readonly edibleIds = new Set<string>();
  constructor(readonly snapshot: Snapshot) {
    const flagged = snapshot.carried.some(stack => stack.edible !== undefined);
    for (const stack of snapshot.carried) {
      if (!nonempty(stack)) continue;
      this.counts.set(stack.item, (this.counts.get(stack.item) ?? 0) + stack.count);
      if (flagged ? stack.edible === true : vanillaFood(stack.item)) this.edibleIds.add(stack.item);
    }
  }
  /** Carried items the match accepts, most numerous first. */
  carried(accepts: Match): Carried {
    const kinds = [...this.counts].filter(([id]) => accepts(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = kinds.slice(0, 3).map(([id, count]) => `${count} x ${id}`);
    if (kinds.length > 3) shown.push(`${kinds.length - 3} more kinds`);
    return { total: kinds.reduce((sum, [, count]) => sum + count, 0), kinds, text: shown.join(", ") };
  }
  edible(): Carried { return this.carried(id => this.edibleIds.has(id)); }
  /** A saved place whose name or note matches, the nearest in this dimension first, written out with its distance. */
  place(pattern: RegExp): string | undefined {
    const { pos, dimension, places } = this.snapshot;
    const found = places.filter(place => pattern.test(`${place.name} ${place.note ?? ""}`))
      .map(place => ({ place, distance: place.dimension === dimension ? Math.hypot(place.x - Math.floor(pos.x), place.y - Math.floor(pos.y), place.z - Math.floor(pos.z)) : Infinity }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!found) return undefined;
    const { place, distance } = found;
    return `place "${place.name}" (${place.x},${place.y},${place.z})${Number.isFinite(distance) ? `, ${Math.round(distance)} blocks away` : ` in ${place.dimension}`}`;
  }
  /**
   * Holds the recipe for an item against what is carried: the modpack's recipe
   * when the knowledge has one (tags included), otherwise the vanilla one given.
   * Of several recipes the one with the smallest share missing is returned, the game's own first on a tie:
   * mods add one-item conversions (a dyed bed from a white bed) that an absolute count would always prefer.
   */
  check(item: string, vanilla: Need[]): Check {
    const known = this.snapshot.knowledge ? knownRecipes(this.snapshot.knowledge, item) : [];
    let best: Check | undefined;
    for (const needs of known.length ? known : [vanilla]) {
      const left = new Map(this.counts);
      const held = (entry: Need) => [...left].filter(([id, count]) => count > 0 && entry.accepts(id)).sort((a, b) => b[1] - a[1]);
      const checked = new Map<Need, Checked>();
      // The most particular ingredient takes its share first, so planks wanted by one cell are not spent on a cell that takes anything.
      for (const entry of [...needs].sort((a, b) => held(a).length - held(b).length)) {
        let wanted = entry.count;
        for (const [id, count] of held(entry)) {
          const taken = Math.min(wanted, count);
          left.set(id, count - taken); wanted -= taken;
        }
        checked.set(entry, { ...entry, short: wanted });
      }
      const ordered = needs.map(entry => checked.get(entry)!);
      const share = ordered.reduce((sum, entry) => sum + entry.short, 0) / ordered.reduce((sum, entry) => sum + entry.count, 0);
      if (!best || share < best.share) best = { item, needs: ordered, missing: ordered.filter(entry => entry.short > 0), share };
    }
    return best!;
  }
  /** Of several items, the first one with the smallest share missing. */
  checkAny(items: { item: string; vanilla: Need[] }[]): Check {
    return items.map(entry => this.check(entry.item, entry.vanilla)).reduce((best, check) => check.share < best.share ? check : best);
  }
}

// A tag name alone ("#forge:rods/wooden") does not say what to look for; shown only if this pack's tag really holds the item.
const tagExamples: Record<string, string> = {
  "#forge:rods/wooden": "minecraft:stick", "#minecraft:planks": "minecraft:oak_planks", "#forge:ingots/iron": "minecraft:iron_ingot", "#forge:gems/diamond": "minecraft:diamond",
  "#minecraft:stone_tool_materials": "minecraft:cobblestone", "#minecraft:stone_crafting_materials": "minecraft:cobblestone", "#minecraft:wool": "minecraft:white_wool",
};

/** "minecraft:furnace takes 8 #minecraft:stone_crafting_materials: all carried." or what it is short of. */
function craftText(check: Check): string {
  const takes = check.needs.map(entry => `${entry.count} ${entry.label}`).join(" + ");
  const short = check.missing.map(entry => {
    const example = tagExamples[entry.label];
    return `${entry.short} ${entry.label}${example && entry.accepts(example) ? ` (such as ${example})` : ""}`;
  }).join(" and ");
  return `${check.item} takes ${takes}: ${short ? `short of ${short}` : "all carried"}.`;
}

const hasFurnace = named("furnace", "blast_furnace");
const pickaxeTiers = [
  { tier: "wooden", head: need("planks", 3, planks) },
  { tier: "stone", head: need("cobblestone", 3, cobble) },
  { tier: "iron", head: need("minecraft:iron_ingot", 3, named("iron_ingot")) },
  { tier: "diamond", head: need("minecraft:diamond", 3, named("diamond")) },
];
const pickaxeRank: Record<string, number> = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
const sixHours = 6 * 3_600_000;

/** What is known about a bed, or nothing when a saved place mentions one. */
function bedText(view: View): string | undefined {
  if (view.place(/\bbeds?\b/i)) return undefined;
  const beds = view.carried(suffix("_bed"));
  if (beds.total) return `${beds.text} carried and no saved place mentions a bed. A bed sets where you come back after dying once it is placed and slept in.`;
  const check = view.checkAny(woolColours.map(colour => ({ item: `minecraft:${colour}_bed`, vanilla: [need(`minecraft:${colour}_wool`, 3, named(`${colour}_wool`)), need("planks", 3, planks)] })));
  return `No bed is known: none carried, no saved place mentions one. A bed sets where you come back after dying. ${craftText(check)}`;
}

function recentDeaths(view: View): SavedDeath[] {
  const { now, deaths } = view.snapshot;
  return deaths.filter(death => death.at <= now && now - death.at <= sixHours).sort((a, b) => b.at - a.at);
}

/**
 * The rules, in no particular order: priority decides what is shown first.
 * To add one, append an entry; it gets a View and returns a sentence or two
 * with the numbers it rests on, or undefined when it has nothing to say.
 */
export const rules: Rule[] = [
  {
    id: "low_health", priority: 100,
    suggest(view) {
      const { health, food } = view.snapshot;
      if (health >= 10 || food >= 18) return undefined;
      const edible = view.edible();
      return `Health ${amount(health)}/20 does not come back at food ${amount(food)}/20: it regrows only from food 18. ${edible.total ? `Edible carried: ${edible.text}.` : "Nothing edible is carried."}`;
    },
  },
  {
    id: "no_food", priority: 90,
    suggest(view) {
      const { food } = view.snapshot;
      if (food >= 8 || view.edible().total) return undefined;
      const wheat = view.carried(named("wheat")).total;
      return `Food ${amount(food)}/20 and nothing edible is carried.${wheat ? ` Wheat carried: ${wheat} (bread takes 3).` : ""}`;
    },
  },
  {
    id: "no_bed_after_deaths", priority: 85,
    suggest(view) {
      const deaths = recentDeaths(view);
      const bed = deaths.length ? bedText(view) : undefined;
      if (!bed) return undefined;
      // The places store keeps the last five deaths, so five may stand for more.
      const times = `${deaths.length}${deaths.length >= 5 ? " or more" : ""} time${deaths.length === 1 ? "" : "s"}`;
      return `Died ${times} in the last 6 hours, latest ${span(view.snapshot.now - deaths[0]!.at)} ago. ${bed}`;
    },
  },
  {
    id: "collaboration", priority: 80,
    suggest(view) {
      const { society, plan } = view.snapshot;
      if (!society) return undefined;
      const me = society.resident.toLowerCase();
      const relevant = society.collaborations.filter(c => ["proposed", "accepted", "reported"].includes(c.status));
      const c = relevant.find(c => c.project?.toLowerCase() === plan?.name.toLowerCase()) ?? relevant[0];
      if (!c) return undefined;
      const beneficiary = beneficiaryOf(c)?.toLowerCase() === me, performer = performerOf(c)?.toLowerCase() === me;
      const lead = `Collaboration #${c.id} r${c.revision}${c.project ? ` for "${c.project}"` : ""}`;
      if (c.status === "reported") return beneficiary
        ? `${lead}: completion reported, not verified. Inspect the result before confirming with your own evidence/source. ${c.evidence?.slice(0, 100) ?? ""}`
        : `${lead}: your completion report awaits recipient confirmation; no need to idle. Continue another useful action.`;
      if (c.status === "accepted") return performer
        ? `${lead}: agreed dependency/help, not completed. ${c.terms.slice(0, 110)} Report observed evidence only after doing it.`
        : `${lead}: help agreed, not completed or a verified prerequisite. Check progress with your neighbour; continue independent work.`;
      return c.proposer.toLowerCase() === me
        ? `${lead}: your terms await agreement, not an assignment. Continue independent work while your neighbour chooses.`
        : `${lead}: voluntary ${c.kind}; accept, decline or counter only for yourself. ${c.terms.slice(0, 125)}`;
    },
  },
  {
    id: "facility", priority: 74,
    suggest(view) {
      const { society, plan, dimension, food } = view.snapshot;
      if (!society) return undefined;
      const words = (plan ? `${plan.needs ?? ""} ${plan.goal} ${plan.current?.text ?? ""}` : "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
      const relevant = words.filter(w => !["the", "and", "for", "with", "from", "need", "have", "own"].includes(w));
      if (food < 12 || !view.edible().total) relevant.push("food", "bread", "farm");
      if (view.carried(id => /^raw_/.test(pathOf(id)) || id.endsWith("_ore")).total) relevant.push("smelt", "furnace");
      if (view.snapshot.carried.filter(nonempty).length >= inventorySlots - 3) relevant.push("storage", "chest");
      const facilities = society.facilities.filter(f => f.dimension === dimension);
      const f = facilities.find(f => relevant.some(word => `${f.name} ${f.purpose} ${f.capabilities.join(" ")}`.toLowerCase().includes(word)));
      if (!f) return undefined;
      const condition = f.observation?.freshness ?? "unobserved";
      // Safety/access caveats precede optional detail, so bounded replies cannot hide them.
      return `Reported facility #${f.id} "${f.name}" (${condition}, not verified). Inspect first; counts are not live. Read facility_show for full access terms. Steward ${f.steward}; ${f.capabilities.join(", ").slice(0, 50)} at ${amount(f.x)},${amount(f.y)},${amount(f.z)}.`;
    },
  },
  {
    id: "smelt_ore", priority: 70,
    suggest(view) {
      const edible = new Set(view.edible().kinds.map(([id]) => id));
      const ore = view.carried(id => !edible.has(id) && (/^raw_(?!.*_block$)/.test(pathOf(id)) || id.endsWith("_ore")));
      if (!ore.total) return undefined;
      const furnace = view.carried(hasFurnace);
      const where = furnace.total ? `${furnace.text} carried` : view.place(/furnace/i);
      if (!where) return undefined;
      const fuel = view.carried(id => named("coal", "charcoal")(id) || planks(id) || suffix("_log", "_wood")(id));
      return `Raw ore carried (${ore.text}) and a furnace is known: ${where}. Fuel carried: ${fuel.text || "none"}.`;
    },
  },
  {
    id: "seeds_unplanted", priority: 65,
    suggest(view) {
      const seeds = view.carried(suffix("_seeds"));
      if (seeds.total < 6) return undefined;
      const hoe = view.carried(suffix("_hoe"));
      if (hoe.total) return `${seeds.text} carried with a hoe (${hoe.kinds[0]![0]}). Seeds grow only once planted on farmland, which a hoe makes from dirt or grass within 4 blocks of water.`;
      const check = view.checkAny([
        { item: "minecraft:stone_hoe", vanilla: [need("cobblestone", 2, cobble), twoSticks] },
        { item: "minecraft:wooden_hoe", vanilla: [need("planks", 2, planks), twoSticks] },
        { item: "minecraft:iron_hoe", vanilla: [need("minecraft:iron_ingot", 2, named("iron_ingot")), twoSticks] },
      ]);
      return `${seeds.text} carried and no hoe. Seeds grow only on farmland, which a hoe makes from dirt or grass within 4 blocks of water. ${craftText(check)}`;
    },
  },
  {
    id: "plan_stalled", priority: 62,
    suggest(view) {
      const plan = view.snapshot.plan;
      if (!plan || plan.idleMs < 30 * 60_000) return undefined;
      return `No action state in project "${plan.name}" has changed for ${span(plan.idleMs)}. Check its blocker or completion criterion with plan_show; use guide for missing mechanics, or agree help with a neighbour. Rewriting notes is not world progress.`;
    },
  },
  {
    id: "pickaxe_upgrade", priority: 60,
    suggest(view) {
      const carried = view.carried(suffix("_pickaxe")).kinds.map(([id]) => ({ id, rank: pickaxeRank[pathOf(id).replace(/_pickaxe$/, "")] }));
      // A pickaxe from a mod has a tier this table does not know: say nothing rather than guess.
      if (carried.some(pickaxe => pickaxe.rank === undefined)) return undefined;
      const best = carried.sort((a, b) => b.rank! - a.rank!)[0];
      for (let rank = pickaxeTiers.length - 1; rank > (best?.rank ?? -1); rank--) {
        const { tier, head } = pickaxeTiers[rank]!;
        const check = view.check(`minecraft:${tier}_pickaxe`, [head, twoSticks]);
        // The head material has to be there; sticks alone may be short, and are named.
        if (check.missing.every(entry => entry.accepts("minecraft:stick"))) return `Best pickaxe carried: ${best?.id ?? "none"}. ${craftText(check)}`;
      }
      return undefined;
    },
  },
  {
    id: "no_furnace", priority: 55,
    suggest(view) {
      if (view.carried(hasFurnace).total || view.place(/furnace/i)) return undefined;
      const check = view.check("minecraft:furnace", [need("cobblestone", 8, cobble)]);
      if (check.missing.length) return undefined;
      return `No furnace is known: none carried, no saved place mentions one. ${craftText(check)} A furnace cooks meat and smelts ore.`;
    },
  },
  {
    id: "no_armour", priority: 50,
    suggest(view) {
      if (view.snapshot.armour.some(nonempty)) return undefined;
      const pieces = view.carried(suffix("_helmet", "_chestplate", "_leggings", "_boots"));
      if (pieces.total) return `No armour is worn (0 of 4 pieces). Carried but not worn: ${pieces.text}. use with a piece in hand puts it on.`;
      const iron = view.carried(named("iron_ingot")).total, leather = view.carried(named("leather")).total;
      return `No armour is worn (0 of 4 pieces) and none is carried. Carried: ${iron} minecraft:iron_ingot, ${leather} minecraft:leather. Boots take 4, a helmet 5, leggings 7, a chestplate 8 of one of them.`;
    },
  },
  {
    id: "inventory_full", priority: 48,
    suggest(view) {
      const used = view.snapshot.carried.filter(nonempty).length;
      if (used < inventorySlots - 3 || view.place(/chest|storage|barrel/i)) return undefined;
      const start = `Inventory: ${used} of ${inventorySlots} slots used and no saved place mentions a chest.`;
      const chests = view.carried(named("chest", "barrel"));
      if (chests.total) return `${start} ${chests.text} carried.`;
      return `${start} ${craftText(view.check("minecraft:chest", [need("planks", 8, planks)]))}`;
    },
  },
  {
    id: "no_bed", priority: 35,
    suggest(view) { return recentDeaths(view).length ? undefined : bedText(view); },
  },
  {
    id: "no_plan", priority: 10,
    suggest(view) { return view.snapshot.plan ? undefined : "No project is written. Choose a useful outcome serving your vision; plan_set keeps why, done_when and immediate steps across restarts. guide explains mechanics; skill_find may offer a tested routine."; },
  },
];

/** Every rule that has something to say about this snapshot, most useful first. */
export function suggestions(snapshot: Snapshot, table: Rule[] = rules): Suggestion[] {
  const view = new View(snapshot);
  return table.flatMap(rule => {
    const text = rule.suggest(view);
    return text ? [{ id: rule.id, priority: rule.priority, text }] : [];
  }).sort((a, b) => b.priority - a.priority);
}

/** The reply of `what_next`: the resident's own current step first, then at most five suggestions. */
export function whatNext(snapshot: Snapshot, table: Rule[] = rules, limit = 1300): string {
  const lines: string[] = [];
  const plan = snapshot.plan;
  if (plan?.current) lines.push(`Your plan "${plan.name}", step ${plan.current.number} of ${plan.total}: ${plan.current.text}${/[.!?]$/.test(plan.current.text) ? "" : "."}`);
  else if (plan?.awaitingVerification) lines.push(`Your project "${plan.name}" awaits verification: ${plan.verification || plan.done_when || "set an observable done_when with plan_set"}. Inspect the result, then plan_finish with your reported evidence.`);
  else if (plan) {
    const blocked = plan.blocked[0];
    lines.push(`Your plan "${plan.name}" has no step todo or doing${blocked ? `; step ${blocked.number} of ${plan.total} is blocked${blocked.note ? `: ${blocked.note}` : ""}` : ""}.`);
  }
  const found = suggestions(snapshot, table).slice(0, maxSuggestions);
  if (!found.length) lines.push(`Nothing ${plan ? "else " : ""}to suggest: none of the ${table.length} checks of what you carry, wear and have saved found something missing or unused.`);
  for (const [index, suggestion] of found.entries()) {
    const text = suggestion.text.length > suggestionLimit ? `${suggestion.text.slice(0, suggestionLimit - 1)}…` : suggestion.text;
    const line = `${index + 1}. ${text}`;
    // Less useful suggestions give way, never a more useful one further up.
    if ([...lines, line].join("\n").length > limit) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/** A snapshot of the body as Synapse reports it; the caller adds what the stores know. */
export function snapshotOf(state: State, rest: Pick<Snapshot, "now" | "places" | "deaths" | "plan" | "knowledge" | "society">): Snapshot {
  if (!state.inventory) throw new Error("Synapse did not provide inventory.");
  return {
    ...rest, health: state.health, food: state.food, pos: state.pos, dimension: state.dimension,
    carried: state.inventory.main.filter(nonempty), armour: state.inventory.armor.filter(nonempty),
  };
}

const located = { x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), dimension: z.string() };
const savedPlace: z.ZodType<SavedPlace> = z.object({ ...located, name: z.string(), note: z.string().optional() });
const savedDeath: z.ZodType<SavedDeath> = z.object({ ...located, at: z.number().finite() });
const placesFile = z.object({ places: z.array(z.unknown()).default([]), deaths: z.array(z.unknown()).default([]) });

/**
 * Saved places and deaths as the place tools keep them (RESIDENT_DIR/places.json
 * and ../shared/places.json). Read-only and forgiving: a missing or broken file
 * counts as empty, because a suggestion must never fail over a notes file.
 */
export async function readPlaces(residentDir: string, sharedDir = join(dirname(residentDir), "shared")): Promise<{ places: SavedPlace[]; deaths: SavedDeath[] }> {
  const read = async (path: string) => {
    try { return placesFile.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch { return { places: [], deaths: [] }; }
  };
  const [own, shared] = await Promise.all([read(join(residentDir, "places.json")), read(join(sharedDir, "places.json"))]);
  // One entry the place tools would not have written does not hide the others.
  const valid = <T>(schema: z.ZodType<T>, entries: unknown[]) => entries.flatMap(entry => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return { places: valid(savedPlace, [...own.places, ...shared.places]), deaths: valid(savedDeath, own.deaths) };
}
