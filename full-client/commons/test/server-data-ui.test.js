import { describe, expect, test } from "bun:test";
import {
  areaName, changeText, chunkOf, chunkSummaries, counterLabel, counterValue, deltaText, formatDistance, formatHearts, formatTicks, gapText,
  hourBars, itemName, kindsText, readableTitle, shade, tabName,
} from "../public/server-data.js";

describe("readable names", () => {
  test("translation keys the server could not resolve become words; real titles stay as they are", () => {
    expect(readableTitle("advancements.occultism.craft_dimensional_matrix.title", "occultism:occultism/craft_dimensional_matrix"))
      .toEqual({ text: "Craft dimensional matrix", made: true });
    expect(readableTitle("Isn't It Iron Pick", "minecraft:story/iron_tools")).toEqual({ text: "Isn't It Iron Pick", made: false });
    // A title with dots that is a sentence is not a key.
    expect(readableTitle("Injecting... 1, 2, 3, 4", "mekanism:injection_chamber").made).toBe(false);
    expect(readableTitle(null, "minecraft:adventure/adventuring_time")).toEqual({ text: "Adventuring time", made: true });
    expect(readableTitle(null, "occultism:occultism/root").text).toBe("Occultism");
    expect(tabName({ id: "occultism:*", title: null })).toBe("Occultism, outside the tabs");
    expect(tabName({ id: "immersiveengineering:main/main_root", title: "Immersive Engineering" })).toBe("Immersive Engineering");
  });

  test("items and counters read as words, mods named", () => {
    expect(itemName("minecraft:oak_log")).toBe("oak log");
    expect(itemName("mekanism:metallurgic_infuser")).toBe("metallurgic infuser (Mekanism)");
    expect(counterLabel("minecraft:interact_with_crafting_table")).toBe("interact with crafting table");
    expect(counterLabel("minecraft:time_since_death")).toBe("time since last death");
    expect(counterLabel("lootr:looted_stat")).toBe("looted stat (Lootr)");
  });
});

describe("units of Minecraft's statistics", () => {
  test("ticks, centimetres and tenths of a health point", () => {
    expect(formatTicks(3_123_884)).toBe("43 h 23 min");
    expect(formatTicks(1199)).toBe("under a minute");
    expect(formatTicks(0)).toBe("0 min");
    expect(formatDistance(2_555_398)).toBe("25.6 km");
    expect(formatDistance(48_049)).toBe("480 blocks");
    expect(formatHearts(7426)).toBe("371 hearts");
    expect(formatHearts(20)).toBe("1 heart");
    expect(counterValue("minecraft:boat_one_cm", 329_257)).toBe("3,293 blocks");
    expect(counterValue("minecraft:sneak_time", 72_000)).toBe("1 h 0 min");
    expect(counterValue("minecraft:damage_dealt", 4318)).toBe("216 hearts");
    expect(counterValue("minecraft:open_chest", 360)).toBe("360");
    expect(changeText(0, formatTicks)).toBeNull();
    expect(changeText(72_000, formatTicks)).toBe("+1 h 0 min");
  });
});

describe("the map's building layer", () => {
  const cells = [
    { dimension: "overworld", chunkX: -1, chunkZ: -1, resident: "Gary", placed: 10, broken: 2, lastAt: 5 },
    { dimension: "overworld", chunkX: -1, chunkZ: -1, resident: "Margo", placed: 0, broken: 20, lastAt: 9 },
    { dimension: "overworld", chunkX: 3, chunkZ: 0, resident: "Gary", placed: 0, broken: 4, lastAt: 1 },
    { dimension: "the_nether", chunkX: -1, chunkZ: -1, resident: "Margo", placed: 7, broken: 0, lastAt: 2 },
  ];

  test("per chunk of one dimension: the busiest resident leads, filters by resident and by kind of change", () => {
    const all = chunkSummaries(cells, { dimension: "overworld" });
    expect(all.map(c => [c.chunkX, c.total, c.lead, c.residents.length])).toEqual([[-1, 32, "Margo", 2], [3, 4, "Gary", 1]]);
    expect(chunkSummaries(cells, { dimension: "overworld", show: "placed" }).map(c => [c.chunkX, c.total, c.lead])).toEqual([[-1, 10, "Gary"]]);
    expect(chunkSummaries(cells, { dimension: "overworld", who: "Gary", show: "broken" }).map(c => [c.chunkX, c.total])).toEqual([[-1, 2], [3, 4]]);
    expect(chunkSummaries(cells, { dimension: "the_nether" })).toHaveLength(1);
  });

  test("chunk coordinates and shading", () => {
    expect(chunkOf(-1, -16)).toEqual([-1, -1]);
    expect(chunkOf(-17, 15.9)).toEqual([-2, 0]);
    expect(chunkOf(16, 0)).toEqual([1, 0]);
    expect(shade(0, 10)).toBe(0);
    expect(shade(10, 10)).toBeCloseTo(0.8);
    expect(shade(1, 1000)).toBeLessThan(shade(100, 1000));
  });

  test("areas are named after the nearest saved place within 64 blocks in the same dimension", () => {
    const places = [{ name: "Cabin", owner: "Gary", dimension: "overworld", x: 100, z: -200 }, { name: "Portal", owner: "shared", dimension: "the_nether", x: 96, z: -224 }];
    expect(areaName({ dimension: "overworld", areaX: 1, areaZ: -4 }, places)).toMatchObject({ text: "near Cabin", owner: "Gary", span: "x 64..127, z -256..-193" });
    expect(areaName({ dimension: "overworld", areaX: 5, areaZ: 5 }, places)).toMatchObject({ text: "around x 352, z 352", owner: null });
  });

  test("hourly bars cover every hour of the window, in one dimension, for the chosen kind of change", () => {
    const H = 3_600_000, since = 10 * H + 600_000;
    const rows = [{ hour: 10 * H, dimension: "overworld", resident: "Gary", placed: 3, broken: 1 }, { hour: 12 * H, dimension: "overworld", resident: "Margo", placed: 0, broken: 5 },
      { hour: 12 * H, dimension: "the_nether", resident: "Margo", placed: 9, broken: 0 }];
    expect(hourBars(rows, { since, until: 13 * H, dimension: "overworld" })).toEqual([
      { hour: 10 * H, placed: 3, broken: 1 }, { hour: 11 * H, placed: 0, broken: 0 }, { hour: 12 * H, placed: 0, broken: 5 }]);
    expect(hourBars(rows, { since, until: 13 * H, dimension: "overworld", show: "placed" })[2]).toEqual({ hour: 12 * H, placed: 0, broken: 0 });
  });
});

describe("flows and gaps in words", () => {
  test("item changes and recorded gaps", () => {
    expect(deltaText([{ item: "minecraft:wheat", before: 82, after: 84 }, { item: "minecraft:wheat_seeds", before: 1025, after: 1024 },
      { item: "create:wrench", before: 1, after: 1 }])).toBe("+2 wheat, −1 wheat seeds, wrench (Create) (item data changed)");
    const stamp = ms => `<${ms}>`;
    expect(gapText("bridge restarted; counts of run 1795201278236 after the last read are lost", stamp))
      .toBe("bridge restarted; counts of the bridge run that started <1795201278236> after the last read are lost");
    expect(gapText("cell table full: cells up to hour 1795449600000 may have been evicted", stamp)).toBe("cell table full: cells up to the hour from <1795449600000> may have been evicted");
    expect(gapText("ring overwritten before it was read: seq 3..4 lost", stamp)).toBe("ring overwritten before it was read: seq 3..4 lost");
    expect(kindsText(["block_hours", "blocks"])).toBe("block counts and individual block changes");
    expect(kindsText(["advancements", "advancement_catalog", "stats"])).toBe("advancement progress, the list of advancements and statistics");
  });
});
