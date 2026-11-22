import { describe, expect, test } from "bun:test";
import { zodToJsonSchema } from "zod-to-json-schema";
import { machineDefinitions, Machines, type MachineCommand } from "../src/machines.ts";
import { machineGuideSections } from "../src/machine-guides.ts";

type Body = Record<string, unknown> & { action?: string };
const IRON = "aaaaaaaa-1111-4000-8000-000000000001";
const PICK = "bbbbbbbb-2222-4000-8000-000000000002";
const CRAFT = "cccccccc-3333-4000-8000-000000000003";

/**
 * Stands in for Synapse's /gui RS Grid and Mekanism actions, following the
 * contract in GuiController: a withdrawal or click is only "sent"; its effect
 * shows up in later reads, after `delay` reads, or never.
 */
class FakeGui {
  calls: Body[] = [];
  // Refined Storage
  containerId = 7;
  stacks = [
    { id: IRON, name: "Iron Ingot", item: "minecraft:iron_ingot", count: 128, craftable: false, nbtHash: "none" },
    { id: PICK, name: "Iron Pickaxe", item: "minecraft:iron_pickaxe", count: 1, craftable: false, nbtHash: "1a2b3c4d", durability: 200, maxDurability: 250 },
    { id: CRAFT, name: "Torch", item: "minecraft:torch", count: 0, craftable: true, nbtHash: "none" },
  ];
  inventory: Record<string, number> = { "minecraft:iron_ingot": 5 };
  active = true;
  /** What the server does with a withdrawal: deliver it after `delay` reads, or ignore it (no permission, no room). */
  deliver = true;
  delay = 2;
  transitFailure = false;
  private pending: { apply: () => void; reads: number }[] = [];
  // Mekanism
  windowOpen = false;
  sides: Record<string, string> = { FRONT: "NONE", BACK: "NONE", LEFT: "NONE", RIGHT: "NONE", TOP: "NONE", BOTTOM: "ENERGY" };
  ejecting = false;
  /** Server reply to a side click: the honest next value, or a forced one. */
  clickResult?: string;
  ignoreClicks = false;

  constructor(init: Partial<FakeGui> = {}) { Object.assign(this, init); }

  private tick() {
    for (const p of this.pending) if (--p.reads <= 0) p.apply();
    this.pending = this.pending.filter(p => p.reads > 0);
  }

  async gui(body: Body = {}): Promise<unknown> {
    this.calls.push(body);
    switch (body.action) {
      case "rsGridSearch": case "rsGridResults": {
        const search = body.action === "rsGridSearch" ? String(body.text) : "";
        const shown = this.stacks.filter(s => s.item.includes(search));
        const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 12);
        return { kind: "rs_grid", containerId: this.containerId, gridType: "NORMAL", active: this.active, search, shown: shown.length, stored: this.stacks.length, offset, results: shown.slice(offset, offset + limit), carried: { item: "minecraft:air", count: 0 } };
      }
      case "rsGridWithdraw": {
        if (this.transitFailure) throw new Error("Synapse unreachable (client stopped or request timed out).");
        if (body.containerId !== this.containerId) throw new Error(`Synapse: The open Grid is container ${this.containerId}, not ${body.containerId} from your observation.`);
        const stack = this.stacks.find(s => s.id === body.id)!;
        const amount = body.amount === "one" ? 1 : body.amount === "half" ? Math.floor(stack.count / 2) : Math.min(64, stack.count);
        const before = { quantity: stack.count, inventoryMatching: this.inventory[stack.item] ?? 0, carried: { item: "minecraft:air", count: 0 } };
        if (this.deliver) this.pending.push({ reads: this.delay, apply: () => { stack.count -= amount; this.inventory[stack.item] = (this.inventory[stack.item] ?? 0) + amount; } });
        return { kind: "rs_grid", containerId: this.containerId, gridType: "NORMAL", active: true, search: "", sent: true, id: stack.id, item: stack.item, nbtHash: stack.nbtHash, before };
      }
      case "rsGridStack": {
        this.tick();
        const stack = this.stacks.find(s => s.id === body.id)!;
        return { kind: "rs_grid", containerId: this.containerId, gridType: "NORMAL", active: true, search: "", present: stack.count > 0, result: stack, inventoryMatching: this.inventory[stack.item] ?? 0, carried: { item: "minecraft:air", count: 0 } };
      }
      case "mekSideConfig": this.tick(); return this.machine();
      case "mekOpenSideConfig": this.windowOpen = true; return { ...this.machine(), opened: true };
      case "mekSideCycle": {
        const roles = ["NONE", "INPUT", "OUTPUT", "ENERGY"];
        const side = String(body.side), current = this.sides[side]!;
        if (body.expect !== current) throw new Error(`Synapse: ${side} ITEM is now ${current}, not ${body.expect} as observed. Nothing was clicked.`);
        const i = roles.indexOf(current), next = roles[(i + (body.direction === "next" ? 1 : roles.length - 1)) % roles.length]!;
        if (!this.ignoreClicks) this.pending.push({ reads: 1, apply: () => { this.sides[side] = this.clickResult ?? next; } });
        return { kind: "mekanism_machine", sent: true, side, before: current, expectedAfter: next };
      }
      case "mekEjectToggle": {
        if (body.expect !== this.ejecting) throw new Error("Synapse: Auto-eject is not as observed.");
        if (!this.ignoreClicks) this.pending.push({ reads: 1, apply: () => { this.ejecting = !this.ejecting; } });
        return { kind: "mekanism_machine", sent: true, before: this.ejecting, expectedAfter: !this.ejecting };
      }
      default: throw new Error(`Synapse: Unknown gui action '${body.action}'.`);
    }
  }

  private machine() {
    const directions: Record<string, string> = { FRONT: "north", BACK: "south", LEFT: "east", RIGHT: "west", TOP: "up", BOTTOM: "down" };
    return {
      kind: "mekanism_machine", containerId: 11, pos: [10, 64, -20], block: "mekanism:metallurgic_infuser", title: "Metallurgic Infuser", facing: "north",
      sideConfigWindowOpen: this.windowOpen, synced: this.windowOpen, sideConfigTabAvailable: true,
      transmissions: [
        { transmission: "ITEM", canEject: true, ejecting: this.ejecting, dataTypes: ["NONE", "INPUT", "OUTPUT", "ENERGY"],
          sides: Object.entries(this.sides).map(([side, data]) => ({ side, direction: directions[side], enabled: side !== "TOP", data })) },
        { transmission: "ENERGY", canEject: false, ejecting: false, dataTypes: ["NONE", "ENERGY"], sides: [] },
      ],
    };
  }

  actions(name: string) { return this.calls.filter(c => c.action === name); }
}

function setup(init: Partial<FakeGui> = {}) {
  const gui = new FakeGui(init);
  const machines = new Machines(gui, async () => {});
  // Parse like the tool server does, so tests exercise the published argument shapes.
  const run = <K extends keyof typeof machineDefinitions>(tool: K, args: unknown) =>
    machines.run([tool, machineDefinitions[tool].schema.parse(args)] as MachineCommand);
  return { gui, machines, run };
}

describe("tool schemas", () => {
  test("publish no anyOf/allOf, which Codex handles badly", () => {
    for (const [name, definition] of Object.entries(machineDefinitions)) {
      const json = JSON.stringify(zodToJsonSchema(definition.schema, { target: "jsonSchema7", $refStrategy: "none" }));
      expect({ name, anyOf: json.includes("anyOf"), allOf: json.includes("allOf") }).toEqual({ name, anyOf: false, allOf: false });
    }
  });

  test("reject ambiguous combinations instead of guessing", () => {
    const take = machineDefinitions.storage_grid_take.schema, set = machineDefinitions.machine_sides_set.schema;
    expect(() => take.parse({ id: "aaaaaaaa", item: "iron_ingot", amount: "half", count: 3 })).toThrow();
    expect(take.parse({ id: "aaaaaaaa", item: "iron_ingot" }).item).toBe("minecraft:iron_ingot");
    expect(() => set.parse({ transmission: "ITEM", side: "FRONT" })).toThrow();
    expect(() => set.parse({ transmission: "ITEM", side: "FRONT", data: "OUTPUT", eject: true })).toThrow();
    expect(set.parse({ transmission: "ITEM", side: "FRONT", data: "output" }).data).toBe("OUTPUT");
  });
});

describe("machine guide sections", () => {
  test("name only tools that exist, so a renamed tool cannot leave stale instructions", () => {
    const named = Object.values(machineGuideSections).flat()
      .flatMap(section => section.paragraphs.join(" ").match(/\b(?:storage_grid|machine_sides)\w*/g) ?? []);
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(Object.keys(machineDefinitions)).toContain(tool);
  });
});

describe("storage_grid", () => {
  test("lists displayed results with short ids, variants and craft-only entries", async () => {
    const { run } = setup();
    const text = await run("storage_grid", {});
    expect(text).toContain("grid (container 7)");
    expect(text).toContain("aaaaaaaa 128 x minecraft:iron_ingot");
    expect(text).toContain("bbbbbbbb 1 x minecraft:iron_pickaxe");
    expect(text).toContain("durability 200/250");
    expect(text).toContain("variant#1a2b3c4d");
    expect(text).toContain("craft-only entry");
  });

  test("search goes through the Grid's own search box, and later pages are read after it", async () => {
    const { gui, run } = setup();
    await run("storage_grid", { search: "iron", page: 2 });
    expect(gui.calls.map(c => c.action)).toEqual(["rsGridSearch", "rsGridResults"]);
    expect(gui.calls[1]!.offset).toBe(12);
  });

  test("says an inactive Grid gives nothing", async () => {
    const { run } = setup({ active: false });
    expect(await run("storage_grid", {})).toContain("inactive");
  });
});

describe("storage_grid_take", () => {
  test("requires a result seen in this Grid and checks its item before sending", async () => {
    const { gui, run } = setup();
    await expect(run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot" })).rejects.toThrow("storage_grid first");
    await run("storage_grid", {});
    await expect(run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:gold_ingot" })).rejects.toThrow("Nothing was taken");
    await expect(run("storage_grid_take", { id: "cccccccc", item: "minecraft:torch" })).rejects.toThrow("crafting entry");
    await expect(run("storage_grid_take", { id: "dddddddd", item: "minecraft:iron_ingot" })).rejects.toThrow("read it again");
    expect(gui.actions("rsGridWithdraw")).toHaveLength(0);
  });

  test("reports the stack that actually reached the inventory, with the observed counts", async () => {
    const { gui, run } = setup();
    await run("storage_grid", {});
    const text = await run("storage_grid_take", { id: "AAAAAAAA", item: "iron_ingot" });
    expect(text).toContain("Took 64 x minecraft:iron_ingot into your inventory");
    expect(text).toContain("5 → 69");
    expect(text).toContain("64 left");
    expect(gui.actions("rsGridWithdraw")).toEqual([{ action: "rsGridWithdraw", containerId: 7, id: IRON, item: "minecraft:iron_ingot", to: "inventory", amount: "stack" }]);
    expect(gui.actions("rsGridStack")[0]).toMatchObject({ id: IRON, nbtHash: "none", containerId: 7 });
  });

  test("an ignored withdrawal is reported, not repeated", async () => {
    const { gui, run } = setup({ deliver: false });
    await run("storage_grid", {});
    const text = await run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot" });
    expect(text).toContain("nothing reached you");
    expect(text).toContain("not repeated");
    expect(gui.actions("rsGridWithdraw")).toHaveLength(1);
  });

  test("a lost reply leaves the outcome unknown and is not retried", async () => {
    const { gui, run } = setup({ transitFailure: true });
    await run("storage_grid", {});
    expect(await run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot" })).toContain("may or may not have been sent");
    expect(gui.actions("rsGridWithdraw")).toHaveLength(1);
  });

  test("a count is taken one confirmed item at a time and stops at the first unconfirmed one", async () => {
    const { gui, run } = setup();
    await run("storage_grid", {});
    expect(await run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot", count: 3 })).toContain("Took 3 x minecraft:iron_ingot");
    expect(gui.actions("rsGridWithdraw").map(c => c.amount)).toEqual(["one", "one", "one"]);

    gui.calls = [];
    const original = gui.gui.bind(gui);
    let withdrawals = 0;
    gui.gui = async (body: Body = {}) => {
      if (body.action === "rsGridWithdraw" && ++withdrawals === 2) gui.deliver = false;
      return original(body);
    };
    const text = await run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot", count: 5 });
    expect(text).toContain("Took 1 of 5");
    expect(gui.actions("rsGridWithdraw")).toHaveLength(2);
  });

  test("a reopened Grid makes the old observation stale", async () => {
    const { gui, run } = setup();
    await run("storage_grid", {});
    gui.containerId = 8;
    await expect(run("storage_grid_take", { id: "aaaaaaaa", item: "minecraft:iron_ingot" })).rejects.toThrow("container 8, not 7");
    expect(gui.actions("rsGridStack")).toHaveLength(0);
  });
});

describe("machine_sides", () => {
  test("opens the side window as the tab would, waits for the server, and reports directions", async () => {
    const gui = new FakeGui();
    const waits: number[] = [];
    const machines = new Machines(gui, async ms => { waits.push(ms); });
    const text = await machines.run(["machine_sides", {}]);
    expect(gui.calls.map(c => c.action)).toEqual(["mekSideConfig", "mekOpenSideConfig", "mekSideConfig"]);
    expect(gui.calls[1]).toEqual({ action: "mekOpenSideConfig", containerId: 11 });
    expect(waits).toEqual([machines.syncWaitMs]);
    expect(text).toContain("front faces north");
    expect(text).toContain("FRONT(north) NONE");
    expect(text).toContain("TOP(up) NONE fixed");
    expect(text).toContain("auto-eject off");
  });

  test("refuses to change a machine that was not read first", async () => {
    const { gui, run } = setup({ windowOpen: true });
    await expect(run("machine_sides_set", { transmission: "ITEM", side: "FRONT", data: "OUTPUT" })).rejects.toThrow("machine_sides first");
    expect(gui.actions("mekSideCycle")).toHaveLength(0);
  });

  test("cycles the shorter way, one confirmed click at a time, each from the observed value", async () => {
    const { gui, run } = setup({ windowOpen: true });
    await run("machine_sides", {});
    // NONE -> ENERGY is one step backwards, three forwards.
    const text = await run("machine_sides_set", { transmission: "ITEM", side: "FRONT", data: "ENERGY" });
    expect(gui.actions("mekSideCycle")).toEqual([{ action: "mekSideCycle", containerId: 11, pos: [10, 64, -20], transmission: "ITEM", side: "FRONT", direction: "previous", expect: "NONE" }]);
    expect(text).toContain("NONE → ENERGY");
    expect(text).toContain("confirmed");

    gui.calls = [];
    await run("machine_sides_set", { transmission: "ITEM", side: "LEFT", data: "OUTPUT" });
    expect(gui.actions("mekSideCycle").map(c => [c.direction, c.expect])).toEqual([["next", "NONE"], ["next", "INPUT"]]);
    expect(gui.sides.LEFT).toBe("OUTPUT");
  });

  test("stops when a click has no effect or an unexpected one", async () => {
    const quiet = setup({ windowOpen: true, ignoreClicks: true });
    await quiet.run("machine_sides", {});
    expect(await quiet.run("machine_sides_set", { transmission: "ITEM", side: "LEFT", data: "OUTPUT" })).toContain("Not clicked again");
    expect(quiet.gui.actions("mekSideCycle")).toHaveLength(1);

    const odd = setup({ windowOpen: true, clickResult: "ENERGY" });
    await odd.run("machine_sides", {});
    expect(await odd.run("machine_sides_set", { transmission: "ITEM", side: "LEFT", data: "OUTPUT" })).toContain("not INPUT");
    expect(odd.gui.actions("mekSideCycle")).toHaveLength(1);
  });

  test("rejects fixed sides and unsupported roles without clicking", async () => {
    const { gui, run } = setup({ windowOpen: true });
    await run("machine_sides", {});
    await expect(run("machine_sides_set", { transmission: "ITEM", side: "TOP", data: "INPUT" })).rejects.toThrow("fixed");
    await expect(run("machine_sides_set", { transmission: "ITEM", side: "FRONT", data: "EXTRA" })).rejects.toThrow("not EXTRA");
    await expect(run("machine_sides_set", { transmission: "ENERGY", eject: true })).rejects.toThrow("cannot auto-eject");
    expect(gui.actions("mekSideCycle")).toHaveLength(0);
    expect(gui.actions("mekEjectToggle")).toHaveLength(0);
  });

  test("auto-eject toggles once from the observed state and reports the confirmed result", async () => {
    const { gui, run } = setup({ windowOpen: true });
    await run("machine_sides", {});
    expect(await run("machine_sides_set", { transmission: "ITEM", eject: false })).toContain("already off");
    expect(await run("machine_sides_set", { transmission: "ITEM", eject: true })).toContain("turned on");
    expect(gui.actions("mekEjectToggle")).toEqual([{ action: "mekEjectToggle", containerId: 11, pos: [10, 64, -20], transmission: "ITEM", expect: false }]);
  });
});
