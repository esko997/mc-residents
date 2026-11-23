import { afterEach, describe, expect, test } from "bun:test";
import { computeFrontier, isRawTitle, readableId, rotate, type FrontierEntry, type FrontierReply } from "../src/resident-advancements.ts";
import type { IngestHealth } from "../src/observer-ingest.ts";
import { residentHub } from "./resident-api-fixture.ts";
import { catalog, garyFrontier, garyProgress, okHealth, savedAt, seedAdvancements } from "./advancement-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const progressRows = garyProgress.map(a => ({ id: a.id, done: a.done, criteriaDone: a.criteriaDone }));
const frontierOf = () => computeFrontier(catalog, progressRows, new Map([["minecraft:nether/explore_nether", ["minecraft:basalt_deltas", "minecraft:nether_wastes"]]]));

describe("the frontier", () => {
  test("not done, parent done; roots only of started tabs; hidden, recipe unlocks and display-less parents left out", () => {
    const { entries } = frontierOf();
    expect(entries.map(e => e.id).sort()).toEqual([...garyFrontier].sort());
    // Each left-out kind, for the record: hidden, recipe unlock, parent not done, tab not started, parent without a display.
    for (const id of ["minecraft:nether/all_effects", "minecraft:recipes/misc/pen", "mekanism:basic_control_circuit", "minecraft:adventure/root",
      "minecraft:adventure/kill_a_mob", "occultism:occultism/familiar_bat", "camping:main/bag"]) expect(entries.map(e => e.id)).not.toContain(id);
  });

  test("tabs count what is done and what the game shows; a mod's advancement in a base-game tab keeps its own mod", () => {
    const { entries, tabs } = frontierOf();
    const tab = (id: string) => tabs.find(t => t.id === id)!;
    expect(tab("minecraft:story/root")).toMatchObject({ title: "Minecraft", mod: "minecraft", done: 4, total: 7, withinReach: 3 });
    // The hidden one counts only once done.
    expect(tab("minecraft:nether/root")).toMatchObject({ done: 1, total: 2, withinReach: 1 });
    expect(tab("mekanism:root")).toMatchObject({ mod: "mekanism", done: 2, total: 5, withinReach: 2 });
    expect(tab("camping:main/root")).toMatchObject({ done: 0, total: 2, withinReach: 1 });
    expect(entries.find(e => e.id === "quark:get_all_blossom_saplings")).toMatchObject({ mod: "quark", tab: "minecraft:story/root", frame: "challenge" });
  });

  test("criteria: what is met, what kind of requirement; raw translation keys become a readable id, said to be one", () => {
    const byId = new Map(frontierOf().entries.map(e => [e.id, e]));
    expect(byId.get("minecraft:nether/explore_nether")!.criteria).toEqual({ met: 2, total: 5, needs: "all", groups: 5, metNames: ["minecraft:basalt_deltas", "minecraft:nether_wastes"] });
    expect(byId.get("mekanism:teleporter")).toMatchObject({ title: "teleporter", titleIsId: true, criteria: { met: 0, total: 4, needs: "groups", groups: 2 } });
    expect(byId.get("minecraft:story/lava_bucket")).toMatchObject({ title: "Hot Stuff", titleIsId: false });
    expect(isRawTitle("advancements.occultism.familiar_bat.title")).toBe(true);
    expect(isRawTitle(null)).toBe(true);
    expect(isRawTitle("GIGA...DRILL...BREAKER!!!")).toBe(false);
    expect(isRawTitle("Not Quite \"Nine\" Lives")).toBe(false);
    expect(readableId("immersiveengineering:main/main_root")).toBe("main");
    expect(readableId("minecraft:nether/explore_nether")).toBe("explore nether");
  });
});

describe("rotation", () => {
  const entries = (tabs: Record<string, number>): FrontierEntry[] => Object.entries(tabs).flatMap(([tab, n]) => Array.from({ length: n }, (_, i) => ({
    id: `${tab}:a${i}`, mod: tab, title: `${tab} ${i}`, titleIsId: false, frame: "task", tab: `${tab}:root`, parent: `${tab}:root`,
    criteria: { met: 0, total: 1, needs: "all" as const, groups: 1, metNames: [] },
  })));

  test("a page draws from different tabs, and successive pages bring every entry round", () => {
    const all = entries({ create: 30, mekanism: 12, minecraft: 5, lootr: 1 });
    const pages = Array.from({ length: 16 }, (_, turn) => rotate(all, 3, turn, 7));
    for (const page of pages) {
      expect(page).toHaveLength(3);
      expect(new Set(page.map(e => e.tab)).size).toBe(3);
    }
    expect(pages[0]).not.toEqual(pages[1]);
    // Every tab's entries come round in turn: 16 pages of 3 from four tabs reach 12 per tab, all of the small tabs.
    const seen = new Set(pages.flat().map(e => e.id));
    for (const id of all.filter(e => e.mod !== "create").map(e => e.id)) expect(seen.has(id)).toBe(true);
    expect([...seen].filter(id => id.startsWith("create:")).length).toBe(12);
    // Deterministic: the same turn gives the same page.
    expect(rotate(all, 3, 5, 7)).toEqual(pages[5]!);
  });

  test("one tab rotates through its own entries; a page never repeats an entry", () => {
    const one = entries({ mekanism: 5 });
    expect(rotate(one, 3, 0).map(e => e.id)).toEqual(["mekanism:a0", "mekanism:a1", "mekanism:a2"]);
    expect(rotate(one, 3, 1).map(e => e.id)).toEqual(["mekanism:a3", "mekanism:a4", "mekanism:a0"]);
    expect(rotate(entries({ lootr: 2 }), 5, 0)).toHaveLength(2);
    expect(rotate([], 3, 0)).toEqual([]);
  });
});

describe("Resident API advancements/frontier", () => {
  let health: IngestHealth | null = okHealth();
  const now = savedAt + 7 * 60_000;
  function hub() {
    health = okHealth();
    const h = residentHub({ advancements: { health: () => health, now: () => now } });
    cleanup.push(() => h.close());
    return h;
  }
  const ask = async (token: string, query = "") => {
    const response = await fetch(`${hubUrl}resident-api/v1/advancements/frontier${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as { result?: FrontierReply; error?: { code: string } } };
  };
  let hubUrl = "";

  test("the caller's own frontier with how old the record is; caretakers get none and nobody can name another resident", async () => {
    const h = hub(); hubUrl = h.url;
    seedAdvancements(h.db, "Gary");
    const gary = h.identity("Gary"), margo = h.identity("Margo"), caretaker = h.identity("Keeper", "caretaker");
    const reply = (await ask(gary.token, "?limit=10")).body.result!;
    expect(reply).toMatchObject({ status: "ok", savedAt, ageMs: 7 * 60_000, scope: null, total: 7, turn: 0, tabsTotal: 4 });
    if (reply.status !== "ok") throw new Error();
    expect(reply.entries.map(e => e.id).sort()).toEqual([...garyFrontier].sort());
    expect(reply.tabs.map(t => t.id)).toEqual(["camping:main/root", "mekanism:root", "minecraft:nether/root", "minecraft:story/root"]);
    // Margo has no stored progress: said so, nothing guessed from Gary's.
    expect((await ask(margo.token)).body.result).toEqual({ status: "unavailable", reason: expect.stringContaining("no advancement progress of yours") });
    expect((await ask(caretaker.token)).status).toBe(403);
    for (const query of ["?resident=Gary", "?limit=0", "?limit=11", "?limit=x", `?tab=${"x".repeat(65)}`]) expect((await ask(margo.token, query)).status).toBe(400);
  });

  test("bridge unsupported, unreachable, not yet checked, off, or its last advancement read failed: nothing, with the reason", async () => {
    const h = hub(); hubUrl = h.url;
    seedAdvancements(h.db, "Gary");
    const { token } = h.identity("Gary");
    const cases: [IngestHealth | null, string][] = [
      [okHealth({ status: "unsupported" }), "older version"],
      [okHealth({ status: "error", detail: "connect ECONNREFUSED" }), "unreachable"],
      [okHealth({ status: "unchecked" }), "not reached"],
      [null, "does not read advancement progress"],
      [okHealth({ kinds: ["stats"] }), "does not offer"],
      [okHealth({ status: "partial", steps: { advancements: { at: now, ok: false, detail: "503", stored: 0 } } }), "last read"],
    ];
    for (const [state, reason] of cases) {
      health = state;
      const reply = (await ask(token)).body.result!;
      expect(reply).toEqual({ status: "unavailable", reason: expect.stringContaining(reason) });
      expect(JSON.stringify(reply)).not.toContain("ECONNREFUSED");
    }
    // A failed statistics read does not hide advancements; the hub's last good advancement read is reported.
    health = okHealth({ status: "partial", steps: { stats: { at: now, ok: false, detail: "429", stored: 0 }, advancements: { at: now - 60_000, ok: true, detail: null, stored: 10 } } });
    expect((await ask(token)).body.result).toMatchObject({ status: "ok", readAt: now - 60_000 });
  });

  test("an empty catalog is unavailable; an old record says how old", async () => {
    const h = hub(); hubUrl = h.url;
    const { token } = h.identity("Gary");
    expect((await ask(token)).body.result).toEqual({ status: "unavailable", reason: expect.stringContaining("advancement list") });
    seedAdvancements(h.db, "Gary", garyProgress, savedAt - 6 * 3_600_000);
    expect((await ask(token)).body.result).toMatchObject({ status: "ok", ageMs: 6 * 3_600_000 + 7 * 60_000 });
  });

  test("repeated calls rotate per resident and scope; a tab or mod narrows it, an unknown one lists nothing", async () => {
    const h = hub(); hubUrl = h.url;
    seedAdvancements(h.db, "Gary");
    const { token } = h.identity("Gary");
    const pages: string[][] = [], tabs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const reply = (await ask(token, "?limit=2")).body.result!;
      if (reply.status !== "ok") throw new Error("unavailable");
      expect(reply.turn).toBe(i);
      expect(new Set(reply.entries.map(e => e.tab)).size).toBe(2);
      for (const entry of reply.entries) tabs.add(entry.tab);
      pages.push(reply.entries.map(e => e.id));
    }
    // Three pages of two from four tabs: every tab has come round, and the pages differ.
    expect(tabs.size).toBe(4);
    expect(new Set(pages.map(page => page.join())).size).toBe(3);
    const mekanism = (await ask(token, "?tab=Mekanism&limit=5")).body.result!;
    expect(mekanism).toMatchObject({ scope: "mekanism", scopeMatched: true, total: 2, turn: 0 });
    if (mekanism.status === "ok") expect(mekanism.entries.map(e => e.id).sort()).toEqual(["mekanism:metallurgic_infuser", "mekanism:teleporter"]);
    // A mod's advancement in a base-game tab is found by its mod and by its tab.
    const quark = (await ask(token, "?tab=quark")).body.result!;
    if (quark.status === "ok") expect(quark.entries.map(e => e.id)).toEqual(["quark:get_all_blossom_saplings"]);
    const story = (await ask(token, "?tab=minecraft&limit=10")).body.result!;
    if (story.status === "ok") expect(story.total).toBe(4);
    const unknown = (await ask(token, "?tab=create")).body.result!;
    expect(unknown).toMatchObject({ status: "ok", scopeMatched: false, total: 0, entries: [], tabsTotal: 4 });
    // The whole-frontier rotation went on where it was.
    expect((await ask(token, "?limit=2")).body.result).toMatchObject({ turn: 3 });
    expect(h.db.query<{ key: string }, []>("SELECT key FROM resident_api_state WHERE key LIKE 'advancement_turn:%' ORDER BY key").all().map(r => r.key))
      .toEqual(["advancement_turn:gary:", "advancement_turn:gary:mekanism", "advancement_turn:gary:minecraft", "advancement_turn:gary:quark"]);
  });
});
