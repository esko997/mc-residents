import { z } from "zod";

/**
 * Structured access to two modded screens whose real controls the generic
 * screen tools cannot reach: a Refined Storage 1.12.4 Grid (results are a
 * separate list keyed by network ids, not menu slots) and Mekanism 10.4.16
 * side configuration (custom GuiElement tabs and windows, not buttons).
 *
 * Synapse performs each action as the mod's own GUI does and refuses stale or
 * repeated requests; this module observes the outcome after every single
 * action and never resends one whose effect was not seen.
 */

/** The part of the Synapse client this module needs; `Synapse` satisfies it. */
export interface MachineGui { gui(body?: object): Promise<unknown> }

const GRID_PAGE = 12;
const transmissions = ["ENERGY", "FLUID", "GAS", "INFUSION", "PIGMENT", "SLURRY", "ITEM", "HEAT"] as const;
const sides = ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM"] as const;
// Plain enums and single types only: unions become anyOf in the tool's JSON schema, which Codex handles badly.
const itemId = z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Use an item registry id.").transform(id => id.includes(":") ? id : `minecraft:${id}`);

export const machineDefinitions = {
  storage_grid: {
    description: "Read an open Refined Storage Grid: its stored results are not menu slots, so screen does not list them. search sets the Grid's own search box as typing would (Refined Storage search syntax; empty clears it). Results come in the Grid's display order with an id, item, count and variant marks; page continues, 12 per page. Taking uses the id and item shown here.",
    schema: z.object({ search: z.string().max(100).refine(s => !/[\r\n]/.test(s), "One line.").optional(), page: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  storage_grid_take: {
    description: "Withdraw one Grid result by the id (first 8 characters are enough) and item from your latest storage_grid read, sent the way the Grid's own clicks send it; the server applies the network's security permissions, power and your inventory room. amount: stack (default, up to one full stack) or half; or count 1..64 instead, taken one item at a time with each confirmed before the next. to: inventory (default; a stack or half arrives only if all of it fits) or cursor (then place it with click_slot before closing). Reports what actually reached you and never resends an unconfirmed withdrawal.",
    schema: z.object({
      id: z.string().regex(/^[0-9a-fA-F]{8}[0-9a-fA-F-]{0,28}$/, "Use a result id from storage_grid."),
      item: itemId,
      amount: z.enum(["stack", "half"]).optional(),
      count: z.number().int().min(1).max(64).optional(),
      to: z.enum(["inventory", "cursor"]).optional(),
    }).strict().refine(a => a.amount === undefined || a.count === undefined, "Give amount or count, not both."),
  },
  machine_sides: {
    description: "Read the side configuration of the open Mekanism machine: for each kind of transmission (ITEM, ENERGY, FLUID, GAS...) every side's role (INPUT, OUTPUT, ENERGY, NONE...) with the compass direction it faces, and auto-eject. Opens Mekanism's side configuration window if needed, as clicking its tab would, so the server sends current values.",
    schema: z.object({}).strict(),
  },
  machine_sides_set: {
    description: "Change the open Mekanism machine's configuration through its side configuration window: either one side's role (side + data, e.g. FRONT and OUTPUT) or auto-eject (eject true/false) for one transmission. Sides are relative to the machine's front; machine_sides shows their compass directions. Works one click at a time, each confirmed from the server before the next. Read machine_sides on this machine first. A configured side is not proof that anything moves: put material in and check where it goes.",
    schema: z.object({
      transmission: z.enum(transmissions),
      side: z.enum(sides).optional(),
      data: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, "Use a role name from machine_sides.").transform(s => s.toUpperCase()).optional(),
      eject: z.boolean().optional(),
    }).strict().refine(a => (a.side !== undefined && a.data !== undefined && a.eject === undefined) || (a.side === undefined && a.data === undefined && a.eject !== undefined),
      "Give side with data, or eject alone."),
  },
};
export type MachineToolName = keyof typeof machineDefinitions;
export const machineToolNames = Object.keys(machineDefinitions) as MachineToolName[];
type Args<K extends MachineToolName> = z.infer<(typeof machineDefinitions)[K]["schema"]>;
/** A tool name with its parsed arguments, as the tool server's registry produces them. */
export type MachineCommand = { [K in MachineToolName]: [K, Args<K>] }[MachineToolName];

// Synapse /gui responses (see GuiController rsGrid*/mek* actions).
interface Carried { item: string; count: number; nbtHash?: string }
interface GridResult { index?: number; id: string; name: string; count: number; craftable: boolean; item: string; nbtHash?: string; nbt?: string; durability?: number; maxDurability?: number }
interface GridHeader { kind: "rs_grid"; containerId: number; gridType: string; active: boolean; search: string }
interface GridPage extends GridHeader { shown: number; stored: number; offset: number; results: GridResult[]; carried: Carried }
interface GridStack extends GridHeader { present: boolean; result?: GridResult; inventoryMatching: number; carried: Carried }
interface GridSent extends GridHeader { sent: true; id: string; item: string; nbtHash: string; before: { quantity: number; inventoryMatching: number; carried: Carried } }
interface Side { side: string; direction: string; enabled: boolean; data: string }
interface Transmission { transmission: string; available?: false; canEject?: boolean; ejecting?: boolean; dataTypes?: string[]; sides?: Side[] }
interface MachineView {
  kind: "mekanism_machine"; containerId: number; pos: [number, number, number]; block: string; title: string; facing: string;
  sideConfigWindowOpen: boolean; synced: boolean; currentTransmission?: string; sideConfigTabAvailable: boolean; transmissions: Transmission[];
}
interface MachineSent { sent: true; expectedAfter: string | boolean }

/** A request whose reply was lost: it may or may not have reached the game. */
const inTransit = (error: unknown) => error instanceof Error && /^Synapse (unreachable|returned invalid data)/.test(error.message);
const posText = (pos: number[]) => pos.join(",");

export class Machines {
  /** How often an outcome is read back, and for how long, after one action. */
  pollMs = 100;
  confirmMs = 2000;
  /** After opening Mekanism's side window, how long the server is given to send its values. */
  syncWaitMs = 1000;
  /** Grid results the resident has seen, by id, in the Grid menu they were seen in. */
  private grid?: { containerId: number; seen: Map<string, GridResult> };
  /** The machine the resident last read with machine_sides. */
  private machine?: { containerId: number; pos: string };

  constructor(private api: MachineGui, private sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms)) {}

  async run(command: MachineCommand): Promise<string> {
    const [tool, args] = command;
    switch (tool) {
      case "storage_grid": return this.readGrid(args);
      case "storage_grid_take": return this.take(args);
      case "machine_sides": return this.readSides();
      case "machine_sides_set": return this.setSides(args);
    }
  }

  private async gui<T>(body: object) { return await this.api.gui(body) as T; }

  private async readGrid(args: Args<"storage_grid">) {
    const page = args.page ?? 1;
    // Searching re-filters the Grid and answers with the first page; a later page is read after it.
    const searched = args.search === undefined ? undefined : await this.gui<GridPage>({ action: "rsGridSearch", text: args.search, limit: GRID_PAGE });
    const view = searched && page === 1 ? searched : await this.gui<GridPage>({ action: "rsGridResults", offset: (page - 1) * GRID_PAGE, limit: GRID_PAGE });
    if (this.grid?.containerId !== view.containerId) this.grid = { containerId: view.containerId, seen: new Map() };
    for (const result of view.results) {
      this.grid.seen.delete(result.id);
      this.grid.seen.set(result.id, result);
      if (this.grid.seen.size > 600) this.grid.seen.delete(this.grid.seen.keys().next().value!);
    }
    const pages = Math.max(1, Math.ceil(view.shown / GRID_PAGE));
    const lines = [`Refined Storage ${view.gridType.toLowerCase()} grid (container ${view.containerId})${view.search ? `, search "${view.search}"` : ""}: ${view.shown} shown of ${view.stored} entries; page ${page} of ${pages}.`];
    if (!view.active) lines.push("The Grid is inactive (no power or controller, or disabled by redstone): it shows and gives nothing.");
    for (const r of view.results) lines.push(`${r.id.slice(0, 8)} ${resultText(r)}`);
    if (!view.results.length && view.active) lines.push(page > pages ? "No results on this page." : "No results match.");
    if (view.carried.count > 0) lines.push(`Cursor holds ${view.carried.count} x ${view.carried.item}; place it before taking.`);
    if (view.results.length) lines.push("Take with storage_grid_take {id, item}. Ids change when stock leaves the network and returns.");
    return lines.join("\n");
  }

  private async take(args: Args<"storage_grid_take">) {
    if (!this.grid) throw new Error("Read the Grid with storage_grid first; take uses an id from that read.");
    const prefix = args.id.toLowerCase();
    const matches = [...this.grid.seen.values()].filter(r => r.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error(matches.length ? `Id ${prefix} matches ${matches.length} results; give more of it.` : `No result ${prefix} in your latest storage_grid reads of this Grid; read it again.`);
    const seen = matches[0]!;
    if (seen.item !== args.item) throw new Error(`Result ${prefix} was ${seen.item}, not ${args.item}. Nothing was taken.`);
    if (seen.craftable) throw new Error("That result is a crafting entry, not stored stock; this tool does not start autocrafting.");
    const to = args.to ?? "inventory";
    const where = to === "inventory" ? "into your inventory" : "onto your cursor";
    const cursorHint = to === "cursor" ? " Put it in a slot with click_slot before closing the Grid." : "";
    const request = { containerId: this.grid.containerId, id: seen.id, item: seen.item, to };

    if (args.count === undefined) {
      const outcome = await this.withdrawOnce({ ...request, amount: args.amount ?? "stack" }, to);
      if (outcome.kind === "error") throw new Error(outcome.message);
      if (outcome.kind === "unknown" || outcome.gained <= 0) return outcome.message;
      return `Took ${outcome.gained} x ${seen.item} ${where} (${outcome.detail}).${cursorHint}`;
    }

    let taken = 0;
    while (taken < args.count) {
      const outcome = await this.withdrawOnce({ ...request, amount: "one" }, to);
      if (outcome.kind === "error" && !taken) throw new Error(outcome.message);
      if (outcome.kind !== "done" || outcome.gained <= 0) {
        return `Took ${taken} of ${args.count} x ${seen.item} ${where}, one at a time; then stopped: ${outcome.message}${taken ? cursorHint : ""}`;
      }
      taken += outcome.gained;
      if (taken >= args.count) return `Took ${taken} x ${seen.item} ${where}, one at a time, each confirmed (${outcome.detail}).${cursorHint}`;
    }
    return `Took ${taken} x ${seen.item} ${where}.${cursorHint}`;
  }

  /** One withdrawal and its observed outcome. Never repeats the request. */
  private async withdrawOnce(request: {
    containerId: number; id: string; item: string; amount: "stack" | "half" | "one"; to: "inventory" | "cursor";
  }, to: "inventory" | "cursor"): Promise<
    { kind: "error"; message: string } | { kind: "unknown"; message: string } | { kind: "done"; gained: number; detail: string; message: string }> {
    let sent: GridSent;
    try { sent = await this.gui<GridSent>({ action: "rsGridWithdraw", ...request }); }
    catch (error) {
      if (inTransit(error)) return { kind: "unknown", message: "The withdrawal request got no answer, so it may or may not have been sent. Check inventory and storage_grid before trying again." };
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    const held = (carried: Carried) => carried.item === sent.item && (carried.nbtHash ?? "none") === sent.nbtHash ? carried.count : 0;
    const before = to === "inventory" ? sent.before.inventoryMatching : held(sent.before.carried);
    const readback = { action: "rsGridStack", containerId: sent.containerId, id: sent.id, item: sent.item, nbtHash: sent.nbtHash };
    let last: GridStack | undefined;
    for (let waited = 0; waited <= this.confirmMs; waited += this.pollMs) {
      await this.sleep(this.pollMs);
      try { last = await this.gui<GridStack>(readback); } catch { continue; }
      const now = to === "inventory" ? last.inventoryMatching : held(last.carried);
      if (now > before) {
        const left = last.present ? last.result?.count ?? 0 : 0;
        return { kind: "done", gained: now - before, detail: `${to === "inventory" ? "matching inventory" : "cursor"} ${before} → ${now}; the Grid shows ${left} left`, message: "" };
      }
    }
    const left = last ? (last.present ? last.result?.count ?? 0 : 0) : undefined;
    const network = left === undefined ? "the Grid could not be read back" : left < sent.before.quantity ? `the Grid count fell ${sent.before.quantity} → ${left} (someone else may have taken it)` : "the Grid count did not change";
    return {
      kind: "done", gained: 0, detail: "",
      message: `Sent the withdrawal, but nothing reached you within ${this.confirmMs / 1000} s and ${network}. It was not repeated. Likely causes: no extract permission on this network, no power, or not enough room for the whole amount; check, then decide.`,
    };
  }

  private async readSides() {
    let view = await this.gui<MachineView>({ action: "mekSideConfig" });
    let opened = false;
    if (!view.sideConfigWindowOpen) {
      await this.gui({ action: "mekOpenSideConfig", containerId: view.containerId });
      opened = true;
      await this.sleep(this.syncWaitMs);
      view = await this.gui<MachineView>({ action: "mekSideConfig" });
    }
    this.machine = { containerId: view.containerId, pos: posText(view.pos) };
    return [
      `${view.title} (${view.block}) at ${posText(view.pos)}, front faces ${view.facing}. ${opened ? "Opened the side configuration window; " : ""}${view.synced ? "values are synced from the server." : "the side window is not open, so values may be stale."}`,
      ...view.transmissions.map(transmissionText),
      "Change one with machine_sides_set; then prove the flow with real material.",
    ].join("\n");
  }

  private async setSides(args: Args<"machine_sides_set">) {
    let view = await this.gui<MachineView>({ action: "mekSideConfig" });
    if (!this.machine || this.machine.containerId !== view.containerId || this.machine.pos !== posText(view.pos)) {
      throw new Error("Read this machine with machine_sides first; the open screen is not the machine you last read. Nothing was changed.");
    }
    if (!view.synced) throw new Error("The side configuration window is closed; read machine_sides again (it reopens the window). Nothing was changed.");
    const base = { containerId: view.containerId, pos: view.pos, transmission: args.transmission };
    const find = (v: MachineView) => v.transmissions.find(t => t.transmission === args.transmission);
    const entry = find(view);
    if (!entry || entry.available === false) throw new Error(`This machine has no ${args.transmission} configuration.`);

    if (args.eject !== undefined) {
      if (!entry.canEject) throw new Error(`${args.transmission} cannot auto-eject on this machine.`);
      if (entry.ejecting === args.eject) return `${args.transmission} auto-eject is already ${args.eject ? "on" : "off"}.`;
      const result = await this.click({ action: "mekEjectToggle", ...base, expect: entry.ejecting }, v => find(v)?.ejecting !== entry.ejecting);
      if (result.kind !== "changed") return result.message;
      const now = find(result.view)?.ejecting;
      return now === args.eject ? `${args.transmission} auto-eject turned ${now ? "on" : "off"} (confirmed by the server). Check that material actually leaves the machine.`
        : `${args.transmission} auto-eject reads ${now ? "on" : "off"} after the click, not as wanted. Not clicked again.`;
    }

    const sideName = args.side!, target = args.data!;
    const roles = entry.dataTypes ?? [];
    if (!roles.includes(target)) throw new Error(`${args.transmission} sides take ${roles.join("/")} here, not ${target}.`);
    const sideOf = (v: MachineView) => find(v)?.sides?.find(s => s.side === sideName);
    const side = sideOf(view);
    if (!side) throw new Error(`No ${sideName} side in the ${args.transmission} configuration.`);
    if (!side.enabled) throw new Error(`${sideName} (${side.direction}) is fixed for ${args.transmission} on this machine.`);
    if (side.data === target) return `${args.transmission} ${sideName} (${side.direction}) is already ${target}.`;

    const from = roles.indexOf(side.data), to = roles.indexOf(target);
    const forward = from < 0 ? 1 : (to - from + roles.length) % roles.length;
    const direction = from >= 0 && roles.length - forward < forward ? "previous" : "next";
    const trail = [side.data];
    let current = side.data;
    for (let step = 0; step < roles.length && current !== target; step++) {
      const result = await this.click({ action: "mekSideCycle", ...base, side: sideName, direction, expect: current }, v => sideOf(v)?.data !== current);
      if (result.kind !== "changed") return `${args.transmission} ${sideName} (${side.direction}): ${trail.join(" → ")}. ${result.message}`;
      view = result.view;
      const next = sideOf(view)?.data ?? "unknown";
      trail.push(next);
      if (next !== result.expected) return `${args.transmission} ${sideName} (${side.direction}): ${trail.join(" → ")}; the last click gave ${next}, not ${result.expected}. Stopped; read machine_sides before deciding.`;
      current = next;
    }
    return current === target
      ? `${args.transmission} ${sideName} (${side.direction}): ${trail.join(" → ")}, each step confirmed by the server. Now prove the flow with real material.`
      : `${args.transmission} ${sideName} (${side.direction}): ${trail.join(" → ")}; did not reach ${target}. Read machine_sides.`;
  }

  /** One Mekanism click and its observed effect; never repeated here. */
  private async click(request: object, changed: (view: MachineView) => boolean): Promise<
    { kind: "changed"; view: MachineView; expected: string | boolean } | { kind: "none"; message: string }> {
    let sent: MachineSent;
    try { sent = await this.gui<MachineSent>(request); }
    catch (error) {
      if (inTransit(error)) return { kind: "none", message: "The click request got no answer, so it may or may not have been sent. Read machine_sides before trying again." };
      throw error;
    }
    for (let waited = 0; waited <= this.confirmMs; waited += this.pollMs) {
      await this.sleep(this.pollMs);
      let view: MachineView;
      try { view = await this.gui<MachineView>({ action: "mekSideConfig" }); } catch { continue; }
      if (changed(view)) return { kind: "changed", view, expected: sent.expectedAfter };
    }
    return { kind: "none", message: `Clicked once, but no change came back from the server within ${this.confirmMs / 1000} s. Not clicked again; read machine_sides before deciding.` };
  }
}

function resultText(r: GridResult) {
  const marks = [
    r.name && r.name !== r.item ? `"${r.name}"` : "",
    r.durability !== undefined ? `durability ${r.durability}/${r.maxDurability}` : "",
    r.nbtHash && r.nbtHash !== "none" ? `variant#${r.nbtHash}` : "",
    r.craftable ? "craft-only entry" : "",
  ].filter(Boolean);
  return `${r.count} x ${r.item}${marks.length ? ` ${marks.join(", ")}` : ""}`;
}

function transmissionText(t: Transmission) {
  if (t.available === false || !t.sides) return `${t.transmission}: not configurable.`;
  const eject = t.canEject ? `auto-eject ${t.ejecting ? "on" : "off"}` : "no auto-eject";
  const sideList = t.sides.map(s => `${s.side}(${s.direction}) ${s.data}${s.enabled ? "" : " fixed"}`).join(", ");
  return `${t.transmission}: ${eject}; roles ${(t.dataTypes ?? []).join("/")}\n  ${sideList}`;
}
