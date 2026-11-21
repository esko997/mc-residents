import { expect, test } from "bun:test";
import { normalizeState } from "../src/synapse.ts";
import { fixture } from "./helpers.ts";

const full = () => JSON.parse(fixture("state-full.json")).data;
const summary = () => JSON.parse(fixture("state-summary.json")).data;

test("a real full state becomes what the page shows: vitals, what is held, and the inventory added up", () => {
  const state = normalizeState(full())!;
  expect(state.pos).toEqual({ x: 110.5, y: 120, z: -207.6 });
  expect(state.dimension).toBe("overworld");
  expect(state).toMatchObject({ health: 2.7, maxHealth: 20, food: 14, gameMode: "survival", screen: null, selectedSlot: 0, dangers: [] });
  expect(state.held).toMatchObject({ item: "dirt", count: 46 });
  expect(state.lookingAt).toBe("birch_planks at 111,121,-207");
  expect(state.air).toBeUndefined();
  // 36 slots, the empty ones (minecraft:air, count 0) dropped; most numerous first; mod items keep their namespace.
  expect(state.inventory!.totalSlots).toBe(36);
  expect(state.inventory!.usedSlots).toBe(16);
  expect(state.inventory!.items.slice(0, 3)).toEqual([
    { item: "cobblestone", count: 59 }, { item: "dirt", count: 46 }, { item: "sundries:raw_zinc", count: 23 },
  ]);
  expect(state.inventory!.items.some(entry => entry.item === "air")).toBe(false);
  expect(state.hotbar.find(entry => entry.item === "stone_pickaxe")).toMatchObject({ slot: 4, durability: 41, maxDurability: 131 });
  expect(state.armor).toEqual([]);
  expect(state.offhand).toBeNull();
  expect(state.nearby).toEqual({ players: [], hostiles: 0, others: 0 });
  expect(state.world).toMatchObject({ weather: "clear", biome: "terralith:birch_taiga" });
});

test("a summary state has no inventory, and says so rather than showing an empty one", () => {
  const state = normalizeState(summary())!;
  expect(state.inventory).toBeNull();
  expect(state.held).toMatchObject({ item: "dirt", count: 46 });
  expect(state.hotbar.length).toBe(9);
  expect(state.world).toBeUndefined();
});

test("trouble is spelled out: an open screen, low air, fire, who is near", () => {
  const state = normalizeState({
    ...full(), screen: "CraftingScreen", selectedSlot: 7, air: 120, underwater: true, onFire: true,
    world: { dayTime: 24000 * 3 + 14000 },
    nearbyEntities: [
      { id: 1, type: "minecraft:player", name: "Margo", pos: [1, 2, 3], distance: 4, player: true },
      { id: 2, type: "minecraft:zombie", hostile: true, pos: [1, 2, 3], distance: 9 },
      { id: 3, type: "minecraft:cow", pos: [1, 2, 3], distance: 9 },
    ],
  })!;
  expect(state.screen).toBe("CraftingScreen");
  expect(state.held).toMatchObject({ item: "wooden_sword" });
  expect(state.air).toEqual({ now: 120, max: 300 });
  expect(state.dangers).toEqual(["on fire", "underwater"]);
  expect(state.nearby).toEqual({ players: ["Margo"], hostiles: 1, others: 1 });
  expect(state.world!.timeOfDay).toBe("night");
});

test("an empty hand is null, and a reply without a position is no state at all", () => {
  expect(normalizeState({ ...full(), selectedSlot: 8, hotbar: [{ slot: 8, item: "minecraft:air", count: 0 }] })!.held).toBeNull();
  expect(normalizeState(null)).toBeNull();
  expect(normalizeState("starting")).toBeNull();
  expect(normalizeState({ pos: { x: 1, y: "two", z: 3 }, health: 20 })).toBeNull();
  expect(normalizeState({ pos: { x: 1, y: 2, z: 3 } })).toMatchObject({ health: 0, food: 0, hotbar: [], held: null, inventory: null, dimension: "unknown" });
});
