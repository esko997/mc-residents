import type { Body } from "./body.ts";
import { nonempty, type Screen, type Synapse } from "./synapse.ts";
import type { Knowledge, RecipeSummary } from "./knowledge/types.ts";

const air = "minecraft:air";
interface Layout { name: string; size: number; first: number; last: number }
/**
 * Menu slots as /gui numbers them (vanilla 1.20.1 InventoryMenu and
 * CraftingMenu): 0 is the output, the grid follows row by row from 1, and
 * first..last are the main inventory and hotbar. Armour, offhand and slots
 * that mods append are never touched.
 */
const layouts: Record<string, Layout> = {
  InventoryScreen: { name: "InventoryScreen", size: 2, first: 9, last: 44 },
  CraftingScreen: { name: "CraftingScreen", size: 3, first: 10, last: 45 },
};
interface Cell { row: number; col: number; what: string; accepts: Set<string> }
/** A recipe as grid cells: shaped keeps its rows and columns, shapeless just fills cells in order (row 0). */
interface Candidate { recipe: RecipeSummary; shaped: boolean; width: number; height: number; cells: Cell[] }
/** Per craft, the item chosen for each cell (indexed like the candidate's cells), and what could not be found. */
interface Allotment { picks: string[][]; short: Map<string, number>; missing: number }

function candidates(knowledge: Knowledge, item: string) {
  const usable: Candidate[] = [], unsupported: string[] = [];
  const known = new Map<string, Set<string>>();
  const cell = (row: number, col: number, choices: string[]): Cell => {
    const what = choices.join(" or ");
    let accepts = known.get(what);
    if (!accepts) known.set(what, accepts = new Set(choices.flatMap(choice => choice.startsWith("#") ? knowledge.itemsInTag(choice.slice(1), 500) : [choice])));
    return { row, col, what, accepts };
  };
  for (const recipe of knowledge.recipesFor(item, 100)) {
    if (!recipe.outputs.some(output => output.what === item)) continue;
    if (recipe.type === "minecraft:crafting_shaped" && recipe.pattern) {
      // A pattern cell holds only its first choice; the builder's note lists the others (coal or charcoal).
      const alternatives = new Map<string, string[]>();
      for (const match of (recipe.note ?? "").matchAll(/grid . alternatives: ([^;]+)/g)) {
        const choices = match[1]!.split(" or ");
        alternatives.set(choices[0]!, choices);
      }
      const filled = recipe.pattern.flatMap((cells, row) => cells.flatMap((what, col) => what ? [{ row, col, what }] : []));
      if (!filled.length) continue;
      // Patterns may carry blank border rows and columns; the game ignores them and so does the fit.
      const top = Math.min(...filled.map(c => c.row)), left = Math.min(...filled.map(c => c.col));
      usable.push({
        recipe, shaped: true,
        height: Math.max(...filled.map(c => c.row)) - top + 1, width: Math.max(...filled.map(c => c.col)) - left + 1,
        cells: filled.map(c => cell(c.row - top, c.col - left, alternatives.get(c.what) ?? [c.what])),
      });
    } else if (recipe.type === "minecraft:crafting_shapeless") {
      // The summary cannot say which of these inputs are alternatives to each other, so a layout would be a guess.
      if (recipe.note?.includes("ingredient alternatives are listed together")) { unsupported.push(recipe.id); continue; }
      const cells = recipe.inputs.flatMap(input => Array.from({ length: input.count }, () => input.what)).map((what, index) => cell(0, index, [what]));
      if (cells.length) usable.push({ recipe, shaped: false, width: 0, height: 0, cells });
    }
  }
  return { usable, unsupported };
}

/** Chooses an item for every cell of every craft from what is on hand, most particular cells first. */
function allot(candidate: Candidate, supply: Map<string, number>, crafts: number): Allotment {
  const left = new Map(supply);
  const order = candidate.cells.map((_, index) => index).sort((a, b) => candidate.cells[a]!.accepts.size - candidate.cells[b]!.accepts.size);
  const picks: string[][] = [];
  const short = new Map<string, number>();
  let missing = 0;
  for (let craft = 0; craft < crafts; craft++) {
    const row: string[] = [];
    for (const index of order) {
      const cell = candidate.cells[index]!;
      let best: string | undefined, most = 0;
      for (const id of cell.accepts) {
        const have = left.get(id) ?? 0;
        if (have > most) { best = id; most = have; }
      }
      if (best) { left.set(best, most - 1); row[index] = best; }
      else { short.set(cell.what, (short.get(cell.what) ?? 0) + 1); missing++; }
    }
    picks.push(row);
  }
  return { picks, short, missing };
}

/** The open crafting screen: every click is followed by a fresh /gui read, and decisions use only what was read. */
class Bench {
  /** The screen closed or changed under us; no further click is safe. */
  gone = false;
  constructor(private api: Synapse, readonly layout: Layout, private screen: Screen, private waitMs: number) {}
  get grid() { return Array.from({ length: this.layout.size ** 2 }, (_, index) => index + 1); }
  get carried() { return this.screen.container?.carried ?? air; }
  get cursor() { return this.carried === air ? "nothing" : this.carried; }
  at(slot: number) { return this.screen.container?.slots.find(stack => stack.slot === slot && nonempty(stack)); }
  show(slot: number) { const stack = this.at(slot); return stack ? `${stack.count} x ${stack.item}` : "nothing"; }
  stacks(first: number, last: number) { return this.screen.container?.slots.filter(stack => stack.slot >= first && stack.slot <= last && nonempty(stack)) ?? []; }
  inventory() { return this.stacks(this.layout.first, this.layout.last); }
  total(item: string) { return this.inventory().reduce((sum, stack) => stack.item === item ? sum + stack.count : sum, 0); }
  free() {
    const taken = new Set(this.inventory().map(stack => stack.slot));
    return Array.from({ length: this.layout.last - this.layout.first + 1 }, (_, index) => this.layout.first + index).filter(slot => !taken.has(slot));
  }
  async read() {
    const screen = await this.api.gui();
    if (screen.screen !== this.layout.name) {
      this.gone = true;
      throw new Error(`${this.layout.name} closed while crafting (the screen is now ${screen.screen})`);
    }
    this.screen = screen;
  }
  async click(slot: number, button: 0 | 1, mode: "PICKUP" | "QUICK_MOVE" = "PICKUP") {
    await this.api.gui({ action: "clickSlot", slot, button, mode });
    await this.read();
  }
  private async until(done: () => boolean) {
    const deadline = performance.now() + this.waitMs;
    while (!done() && performance.now() < deadline) { await Bun.sleep(50); await this.read(); }
    return done();
  }
  /** The output slot is computed by the server: give it two ticks to answer the clicks before reading. */
  async settle() { await this.api.request("/wait?ticks=2"); await this.read(); }
  private async sweepGrid() {
    for (const slot of this.grid) if (this.at(slot)) await this.click(slot, 0, "QUICK_MOVE");
    return this.grid.filter(slot => this.at(slot)).map(slot => `${this.show(slot)} in grid slot ${slot}`);
  }
  async clearGrid() {
    const stuck = await this.sweepGrid();
    if (stuck.length) throw new Error(`${stuck.join(", ")} would not move back to your inventory (is it full?)`);
  }
  /** Puts the cursor stack down and sends the grid back to the inventory; returns what would not move. */
  async tidy() {
    await this.read();
    const held = this.carried;
    if (held !== air) {
      // An empty slot takes the whole stack; same-item stacks are the fallback when none is empty.
      for (const slot of [...this.free(), ...this.inventory().filter(stack => stack.item === held).map(stack => stack.slot)]) {
        if (this.carried === air) break;
        await this.click(slot, 0);
      }
    }
    const stuck = await this.sweepGrid();
    return [...(this.carried === air ? [] : [`${this.carried} on your cursor (click an empty slot before closing, or it drops)`]), ...stuck];
  }
  /** One item into an empty grid slot: pick the stack up, right-click one down, put the rest back. */
  async lay(slot: number, item: string) {
    // The smallest stack first, so crafting uses up odd stacks rather than splitting full ones.
    const source = this.inventory().filter(stack => stack.item === item).sort((a, b) => a.count - b.count)[0];
    if (!source) throw new Error(`no ${item} was left in your inventory for grid slot ${slot}`);
    await this.click(source.slot, 0);
    if (this.carried !== item || this.at(source.slot)) throw new Error(`picking up ${source.count} x ${item} from slot ${source.slot} left ${this.show(source.slot)} there and ${this.cursor} on the cursor`);
    await this.click(slot, 1);
    const placed = this.at(slot);
    if (placed?.item !== item || placed.count !== 1) throw new Error(`placing one ${item} in grid slot ${slot} left ${this.show(slot)} there`);
    if (this.carried === air) return;
    await this.click(source.slot, 0);
    const back = this.at(source.slot);
    if (this.carried !== air || back?.item !== item || back.count !== source.count - 1) throw new Error(`putting the other ${source.count - 1} x ${item} back in slot ${source.slot} left ${this.show(source.slot)} there and ${this.cursor} on the cursor`);
  }
  /** Waits for the output slot to show the item, then moves it into the inventory and checks it arrived. */
  async take(item: string) {
    await this.settle();
    if (!await this.until(() => this.at(0)?.item === item)) throw new Error(`the output slot showed ${this.show(0)}, not ${item}; this server may not have the recipe`);
    const had = this.total(item);
    await this.click(0, 0, "QUICK_MOVE");
    if (await this.until(() => this.total(item) > had)) return;
    // Shift-click moved nothing: carry the result to an empty slot by hand.
    const free = this.free()[0];
    if (free !== undefined && this.carried === air && this.at(0)?.item === item) {
      await this.click(0, 0);
      if (this.carried === item) await this.click(free, 0);
      if (await this.until(() => this.total(item) > had)) return;
    }
    throw new Error(`taking ${item} from the output slot added none to your inventory${free === undefined ? " (no empty inventory slot)" : ""}`);
  }
}

export interface CraftOptions {
  /** How long to wait for the server to show a result or deliver it. */
  waitMs?: number;
  signal?: AbortSignal;
}

/**
 * Crafts `crafts` operations of a known recipe in the open crafting table, or
 * in the player's own 2x2 grid (opened here when no screen is open). One item
 * per cell per operation, so each shift-click on the output crafts exactly once.
 */
export async function craft(body: Body, knowledge: Knowledge, item: string, crafts: number, options: CraftOptions = {}): Promise<string> {
  let screen = await body.api.gui();
  const found = screen.screen;
  if (found !== "none" && !Object.hasOwn(layouts, found)) throw new Error(`craft works in your own inventory or at a crafting table, not in ${found}; close it first.`);
  if (screen.container && screen.container.carried !== air) throw new Error(`Your cursor holds ${screen.container.carried}; click a slot to put it down, then craft again. Nothing was moved.`);
  const { usable, unsupported } = candidates(knowledge, item);
  if (!usable.length) {
    throw new Error(unsupported.length
      ? `craft cannot lay out ${unsupported.join(", ")} (its ingredients have alternatives); place it by hand with click_slot.`
      : `No crafting-grid recipe for ${item} is indexed. recipes shows how an item is made; find_item finds exact ids.`);
  }
  const size = found === "CraftingScreen" ? 3 : 2;
  const fitting = usable.filter(candidate => candidate.shaped ? candidate.width <= size && candidate.height <= size : candidate.cells.length <= size * size);
  if (!fitting.length) {
    throw new Error(size === 3
      ? `No recipe for ${item} fits a 3x3 crafting grid; recipes shows what it needs.`
      : `${item} needs a 3x3 grid: ${found === "none" ? "" : "close your inventory, "}look at a crafting table and use it, then craft again.`);
  }
  const larger = size === 2 && fitting.length < usable.length ? " Other recipes for it need a crafting table." : "";
  if (found === "none") screen = await body.openInventory();
  const bench = new Bench(body.api, layouts[screen.screen]!, screen, options.waitMs ?? 2000);
  const nothingMade = async (message: string): Promise<never> => {
    // An inventory this call opened is not left open over a craft that made nothing.
    if (found === "none" && bench.carried === air && (await body.closeScreen().catch(() => undefined))?.after === "none") message += " Closed your inventory again.";
    throw new Error(message);
  };

  // Stacks left in the grid count: they go back to the inventory before anything is laid.
  const supply = new Map<string, number>();
  for (const stack of [...bench.inventory(), ...bench.stacks(1, size * size)]) supply.set(stack.item, (supply.get(stack.item) ?? 0) + stack.count);
  let chosen: { candidate: Candidate; plan: Allotment } | undefined;
  let closest: typeof chosen;
  for (const candidate of fitting) {
    const plan = allot(candidate, supply, crafts);
    if (!plan.missing) { chosen = { candidate, plan }; break; }
    if (!closest || plan.missing < closest.plan.missing) closest = { candidate, plan };
  }
  if (!chosen) {
    const { candidate, plan } = closest!;
    const missing = [...plan.short].map(([what, short]) => `${short} more ${what} (it takes ${candidate.cells.filter(cell => cell.what === what).length * crafts})`).join(", ");
    return nothingMade(`Not enough ingredients for ${crafts} x recipe ${candidate.recipe.id}: you need ${missing}. Nothing was moved.${larger}`);
  }

  const { candidate, plan } = chosen;
  const used = new Map<string, number>();
  let done = 0, before = 0, failure: string | undefined;
  try {
    await bench.clearGrid();
    before = bench.total(item);
    for (; done < crafts; done++) {
      if (options.signal?.aborted) throw new Error("the call was cancelled");
      // A craft can leave things behind in the grid, such as empty buckets.
      if (done) await bench.clearGrid();
      // Shaped cells keep their row and column from the top-left corner; shapeless ones fill the grid in order.
      for (const [index, cell] of candidate.cells.entries()) await bench.lay(1 + (candidate.shaped ? cell.row * size + cell.col : cell.col), plan.picks[done]![index]!);
      await bench.take(item);
      for (const id of plan.picks[done]!) used.set(id, (used.get(id) ?? 0) + 1);
    }
    await bench.settle();
  } catch (error) { failure = error instanceof Error ? error.message.replace(/\.$/, "") : "an unknown error"; }
  if (bench.gone) throw new Error(`${failure}. ${done} of ${crafts} crafts were finished. Grid items return to you when a screen closes, but a stack on the cursor drops at your feet; check inventory.`);
  const untidy = await bench.tidy().catch(error => [`nothing checked: tidying up failed (${error instanceof Error ? error.message : "unknown error"})`]);
  const have = bench.total(item), made = have - before;
  if (failure === undefined && made <= 0) failure = `the server did not keep the result (you have ${have} x ${item}, as before)`;
  const state = untidy.length ? `Could not put everything away: ${untidy.join("; ")}.` : "The grid and your cursor are empty; unused ingredients are back in your inventory.";
  if (failure === undefined) {
    const using = [...used].map(([id, count]) => `${count} x ${id}`).join(" + ");
    return `Crafted ${made} x ${item} (recipe ${candidate.recipe.id}) using ${using}; you now have ${have}.${untidy.length ? ` ${state}` : ""} ${bench.layout.name} stays open for more crafting; close_screen when done.`;
  }
  if (done && made > 0) throw new Error(`Crafted ${made} x ${item} in ${done} of ${crafts} crafts (recipe ${candidate.recipe.id}), then stopped: ${failure}. ${state} You now have ${have}.`);
  return nothingMade(`Crafted nothing with recipe ${candidate.recipe.id}: ${failure}. ${state}${larger}`);
}
