import { afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "../src/body.ts";
import { Synapse, nonempty, type Screen, type Stack, type State } from "../src/synapse.ts";
import { Tools } from "../src/tools.ts";

export interface Request { path: string; body: Record<string, unknown> }
export type Item = Omit<Stack, "slot">;
export type MenuKind = "InventoryScreen" | "CraftingScreen";
/** A crafting recipe the fake server knows; every cell or ingredient lists the item ids it accepts. */
export interface FakeRecipe {
  /** Rows of cells, null for an empty one. Matches anywhere in the grid, like vanilla. */
  shaped?: (readonly string[] | null)[][];
  shapeless?: (readonly string[])[];
  output: Item;
}
export interface FakeOptions {
  closeFailures?: number; escapeBlocked?: boolean; eatWorks?: boolean; openWorks?: boolean;
  /** The resident's name (default Gary) and the commons database it shares with other fixtures. */
  name?: string; commonsDb?: string;
  swapWorks?: boolean; interactable?: boolean; forceMealScreen?: boolean;
  /** Fail this many plain /gui reads (no action) with a 500. */
  guiReadFailures?: number;
  rotation?: State["rotation"]; selectedSlot?: number;
  recipes?: FakeRecipe[];
  /** What a used-up ingredient leaves in its grid cell, e.g. milk bucket -> bucket. */
  remainders?: Record<string, string>;
  /** false: the output slot never shows anything, as when the server lacks the recipe. */
  resultWorks?: boolean;
  /** The output slot follows a grid change only after this many plain /gui reads (the server round trip). */
  resultDelayReads?: number;
  /** false: shift-clicking the output does nothing. */
  quickMoveResultWorks?: boolean;
  /** Clicks on these menu slots are ignored. */
  deadSlots?: number[];
}
export interface Fixture {
  dir: string; log: string; state: State; requests: Request[]; body: Body; tools: Tools; options: FakeOptions;
  tick(ms: number): void; setScreen(value: Screen): void; setUnavailable(): void;
  /** Open a menu with exactly these stacks (menu slot numbers) and cursor, replacing the player's inventory. */
  setMenu(kind: MenuKind, slots: Stack[], carried?: Item): void;
  /** The open menu's non-empty slots and cursor, or undefined when no menu is open. */
  menu(): { kind: MenuKind; slots: Stack[]; carried?: Item } | undefined;
}

// Vanilla 1.20.1 numbering: output 0, grid from 1 row by row, then main inventory and hotbar.
const menuShapes = { InventoryScreen: { width: 2, main: 9, hotbar: 36 }, CraftingScreen: { width: 3, main: 10, hotbar: 37 } };
const stackLimit = 64;
function assignable(needs: (readonly string[])[], items: string[]): boolean {
  return !needs.length || items.some((item, index) => needs[0]!.includes(item) && assignable(needs.slice(1), items.filter((_, other) => other !== index)));
}
/**
 * The player's inventory or a crafting table as the client shows it: a cursor,
 * left and right PICKUP clicks, shift-click (QUICK_MOVE) out of the grid and the
 * output, and an output slot that follows the grid through the server's recipes.
 */
class Menu {
  readonly slots = new Map<number, Item>();
  carried?: Item;
  private staleReads = 0;
  constructor(readonly kind: MenuKind, private options: FakeOptions) {}
  private get grid() { return Array.from({ length: menuShapes[this.kind].width ** 2 }, (_, index) => index + 1); }
  private get inventory() {
    const { main, hotbar } = menuShapes[this.kind];
    return Array.from({ length: hotbar + 9 - main }, (_, index) => main + index);
  }
  /** Replace the inventory slots with the player's stacks (hotbar 0..8, main 9..35). */
  load(stacks: Stack[]) {
    const { main, hotbar } = menuShapes[this.kind];
    for (const slot of this.inventory) this.slots.delete(slot);
    for (const { slot, ...item } of stacks.filter(nonempty)) this.slots.set(slot < 9 ? hotbar + slot : main + slot - 9, item);
  }
  /** The inventory slots as the player's stacks. */
  unload(): Stack[] {
    const { main, hotbar } = menuShapes[this.kind];
    return this.inventory.flatMap(slot => this.slots.has(slot) ? [{ ...this.slots.get(slot)!, slot: slot >= hotbar ? slot - hotbar : slot - main + 9 }] : []);
  }
  private crafted(): Item | undefined {
    if (this.options.resultWorks === false) return undefined;
    const { width } = menuShapes[this.kind];
    const filled = this.grid.flatMap(slot => this.slots.has(slot) ? [{ item: this.slots.get(slot)!.item, row: Math.floor((slot - 1) / width), col: (slot - 1) % width }] : []);
    if (!filled.length) return undefined;
    const top = Math.min(...filled.map(cell => cell.row)), left = Math.min(...filled.map(cell => cell.col));
    const height = Math.max(...filled.map(cell => cell.row)) - top + 1, across = Math.max(...filled.map(cell => cell.col)) - left + 1;
    for (const recipe of this.options.recipes ?? []) {
      const shaped = recipe.shaped;
      if (shaped ? shaped.length === height && shaped[0]!.length === across && shaped.every((cells, row) => cells.every((accepts, col) => {
        const item = this.slots.get(1 + (top + row) * width + left + col)?.item;
        return accepts ? item !== undefined && accepts.includes(item) : item === undefined;
      })) : recipe.shapeless?.length === filled.length && assignable(recipe.shapeless, filled.map(cell => cell.item))) return { ...recipe.output };
    }
    return undefined;
  }
  showResult() {
    const made = this.crafted();
    if (made) this.slots.set(0, made); else this.slots.delete(0);
    this.staleReads = 0;
  }
  /** A plain /gui read: one step closer to the server's answer about the output slot. */
  read() { if (this.staleReads && --this.staleReads === 0) this.showResult(); }
  private room(item: string) {
    return this.inventory.reduce((sum, slot) => sum + (this.slots.has(slot) ? this.slots.get(slot)!.item === item ? stackLimit - this.slots.get(slot)!.count : 0 : stackLimit), 0);
  }
  /** Shift-click destination: same-item stacks first, then empty slots. Returns how many did not fit. */
  private store(item: Item) {
    let left = item.count;
    for (const slot of this.inventory) {
      const here = this.slots.get(slot);
      if (here?.item !== item.item) continue;
      const moved = Math.min(left, stackLimit - here.count);
      here.count += moved; left -= moved;
    }
    for (const slot of this.inventory) {
      if (!left || this.slots.has(slot)) continue;
      this.slots.set(slot, { ...item, count: Math.min(left, stackLimit) }); left -= Math.min(left, stackLimit);
    }
    return left;
  }
  private consume() {
    for (const slot of this.grid) {
      const here = this.slots.get(slot);
      if (!here || --here.count > 0) continue;
      const remainder = this.options.remainders?.[here.item];
      if (remainder) this.slots.set(slot, { item: remainder, count: 1 }); else this.slots.delete(slot);
    }
    this.showResult();
  }
  click(slot: number, button: number, mode: string) {
    if (this.options.deadSlots?.includes(slot) || !(slot >= 0 && slot <= 45) || (mode !== "PICKUP" && mode !== "QUICK_MOVE")) return;
    const here = this.slots.get(slot), held = this.carried;
    if (slot === 0) {
      // The server acts on its own result, whatever the client still shows.
      this.showResult();
      const made = this.slots.get(0);
      if (!made) return;
      if (mode === "PICKUP") {
        if (held && (held.item !== made.item || held.count + made.count > stackLimit)) return;
        this.carried = { ...made, count: (held?.count ?? 0) + made.count };
        this.consume();
      } else if (this.options.quickMoveResultWorks !== false) {
        // Shift-click crafts for as long as the grid still makes the same thing and it fits.
        for (let out = this.slots.get(0); out?.item === made.item && this.room(out.item) >= out.count; out = this.slots.get(0)) { this.store(out); this.consume(); }
      }
      return;
    }
    if (mode === "QUICK_MOVE") {
      // Only grid -> inventory is modelled.
      if (!here || !this.grid.includes(slot)) return;
      const left = this.store(here);
      if (left) here.count = left; else this.slots.delete(slot);
    } else if (!held) {
      if (!here) return;
      const taken = button === 0 ? here.count : Math.ceil(here.count / 2);
      this.carried = { ...here, count: taken };
      if (taken === here.count) this.slots.delete(slot); else here.count -= taken;
    } else if (!here || here.item === held.item) {
      const moved = Math.min(button === 0 ? held.count : 1, stackLimit - (here?.count ?? 0));
      if (!moved) return;
      this.slots.set(slot, { ...held, count: (here?.count ?? 0) + moved });
      if (moved === held.count) this.carried = undefined; else held.count -= moved;
    } else { this.slots.set(slot, held); this.carried = here; }
    if (!this.grid.includes(slot)) return;
    if (this.options.resultDelayReads) this.staleReads = this.options.resultDelayReads; else this.showResult();
  }
  /** Closing hands the grid back to the player; returns whether anything moved. */
  close() {
    const left = this.grid.filter(slot => this.slots.has(slot));
    for (const slot of left) { this.store(this.slots.get(slot)!); this.slots.delete(slot); }
    return left.length > 0;
  }
  stacks(): Stack[] { return [...this.slots].map(([slot, item]) => ({ ...item, slot })).sort((a, b) => a.slot - b.slot); }
  /** Like Synapse, every slot is listed, empty ones as air. */
  render(): Screen {
    const empty = { item: "minecraft:air", count: 0 };
    return { screen: this.kind, container: {
      slots: Array.from({ length: 46 }, (_, slot) => ({ ...(this.slots.get(slot) ?? empty), slot })),
      carried: this.carried?.item ?? empty.item, carriedStack: { ...(this.carried ?? empty) },
    } };
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// One HTTP fake for every Body test. State read-backs are independent snapshots,
// and commands arrive through the real Synapse client rather than mocked methods.
export async function fixture(options: FakeOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "resident-body-"));
  const log = join(dir, "latest.log"); await writeFile(log, "");
  let clock = 0;
  const state: State = {
    pos: { x: 0, y: 64, z: 0 }, eye: { x: 0, y: 65.62, z: 0 }, dimension: "minecraft:overworld",
    health: 20, food: 20, rotation: { ...(options.rotation ?? { yaw: 0, pitch: 0 }) },
    hotbar: [], selectedSlot: options.selectedSlot ?? 0,
    screen: "none", lookingAt: { type: "miss" }, nearbyEntities: [],
    inventory: { main: [], armor: [], offhand: { slot: 0, item: "minecraft:air", count: 0 } },
    air: 300, maxAir: 300, underwater: false, inWater: false, inLava: false, onFire: false,
    onGround: true, fallDistance: 0, velocity: { x: 0, y: 0, z: 0 },
  };
  let screen: Screen = { screen: "none" };
  let menu: Menu | undefined;
  // The player's own stacks follow the menu, so /state and a reopened screen agree with what was clicked.
  const syncState = (from: Menu) => { state.inventory!.main = from.unload(); state.hotbar = state.inventory!.main.filter(stack => stack.slot < 9); };
  const show = (value: Screen, opened?: Menu) => {
    if (menu && menu !== opened && menu.close()) syncState(menu);
    menu = opened; screen = value; state.screen = value.screen;
  };
  const openMenu = (kind: MenuKind) => {
    const opened = new Menu(kind, options);
    opened.load(state.inventory!.main);
    show({ screen: kind }, opened);
  };
  let unavailable = false;
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() as Record<string, unknown> : {};
    requests.push({ path: url.pathname, body });
    if (req.headers.get("X-Synapse-Token") !== "test-token") return Response.json({ ok: false, error: { message: "Unauthorized" } }, { status: 401 });
    if (unavailable) return Response.json({ ok: false, error: { message: "No player in world." } }, { status: 409 });
    let data: unknown = {};
    if (url.pathname === "/state") data = state;
    else if (url.pathname === "/screenshot") data = { image: "aGVsbG8=" };
    else if (url.pathname === "/gui" && !body.action && options.guiReadFailures && options.guiReadFailures-- > 0) {
      return Response.json({ ok: false, error: { message: "read failed" } }, { status: 500 });
    }
    else if (url.pathname === "/gui") {
      if (!body.action) menu?.read();
      if (body.action === "open" && options.openWorks !== false) openMenu("InventoryScreen");
      if (body.action === "clickSlot" && body.mode === "SWAP" && options.swapWorks !== false) {
        const source = state.inventory!.main.find(s => s.slot === body.slot);
        if (source) {
          const slot = body.button as number;
          const displaced = state.hotbar.find(s => s.slot === slot);
          state.hotbar = [...state.hotbar.filter(s => s.slot !== slot), { ...source, slot }];
          state.inventory!.main = [...state.inventory!.main.filter(s => s.slot !== source.slot && s.slot !== slot), { ...source, slot }, ...(displaced ? [{ ...displaced, slot: source.slot }] : [])];
          menu?.load(state.inventory!.main);
        }
      } else if (body.action === "clickSlot" && menu) {
        menu.click(body.slot as number, (body.button as number | undefined) ?? 0, (body.mode as string | undefined) ?? "PICKUP");
        syncState(menu);
      }
      const close = body.action === "close" && !(options.closeFailures && options.closeFailures-- > 0);
      if (close || body.action === "clickButton" || (body.key === "ESCAPE" && !options.escapeBlocked)) show({ screen: "none" });
      data = menu ? menu.render() : screen;
    } else if (url.pathname === "/player") {
      if (body.action === "use" && !body.ticks && state.hotbar.some(s => s.item.endsWith("_sign"))) {
        show({ screen: "SignEditScreen", widgets: [{ index: 0, label: "Done", button: true, active: true, visible: true }] });
      }
      if (body.action === "use" && !body.ticks && state.lookingAt.block === "minecraft:crafting_table") openMenu("CraftingScreen");
      // Planting: a seed leaves the hand and the crop is what the crosshair then rests on.
      const hand = state.hotbar.find(s => s.slot === state.selectedSlot);
      if (body.action === "use" && !body.ticks && hand?.item === "minecraft:wheat_seeds" && state.lookingAt.block === "minecraft:farmland") {
        hand.count -= 1;
        const [x, y, z] = state.lookingAt.blockPos!;
        state.lookingAt = { type: "block", block: "minecraft:wheat", blockPos: [x, y + 1, z] };
      }
      if (body.action === "selectHotbar") state.selectedSlot = body.slot as number;
      if (body.action === "look") state.rotation = { yaw: body.yaw as number, pitch: body.pitch as number };
      if (body.action === "use" && body.ticks === 40) {
        if (options.forceMealScreen || (options.interactable && state.rotation.pitch !== -90)) {
          show({ screen: "CraftingScreen" });
        } else if (options.eatWorks !== false) state.food = Math.min(20, state.food + 6);
      }
    } else if (url.pathname !== "/chat" && url.pathname !== "/wait") return new Response("not found", { status: 404 });
    return Response.json({ ok: true, data });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const api = new Synapse(url, "test-token");
  const body = new Body({ url, tokenFile: "", log, name: options.name ?? "Gary", residentDir: dir, commonsDb: options.commonsDb }, api, () => clock);
  const tools = new Tools(body);
  cleanups.push(async () => { await body.close(); tools.close(); server.stop(true); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, log, state, requests, body, tools, options, tick: (ms: number) => { clock += ms; }, setScreen: show, setUnavailable: () => { unavailable = true; },
    setMenu: (kind, slots, carried) => {
      const opened = new Menu(kind, options);
      for (const { slot, ...item } of slots) opened.slots.set(slot, item);
      opened.carried = carried; opened.showResult();
      show({ screen: kind }, opened); syncState(opened);
    },
    menu: () => menu && { kind: menu.kind, slots: menu.stacks(), carried: menu.carried && { ...menu.carried } },
  };
}
