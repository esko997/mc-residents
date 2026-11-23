import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { frontierRoom, whatNext, type Rule, type Snapshot } from "../src/ideas.ts";
import { frontierReport, frontierText, type Frontier } from "../src/advancement-ideas.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import { Tools } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";
import { okHealth, savedAt, seedAdvancements } from "../../commons/test/advancement-fixture.ts";
import { residentFrontier } from "../../commons/src/resident-advancements.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const now = savedAt + 7 * 60_000;
const advancementOptions = { health: () => okHealth(), now: () => now };
function hub(withAdvancements = true) {
  const h = residentHub(withAdvancements ? { advancements: advancementOptions } : {});
  cleanups.push(() => h.close());
  if (withAdvancements) seedAdvancements(h.db, "Gary");
  return h;
}
/** Gary's frontier as the hub gives it, `limit` entries of the next rotation, for one tab or mod when given. */
function frontier(limit = 3, scope?: string): Frontier {
  const reply = residentFrontier(hub().db, "Gary", { limit, scope }, advancementOptions);
  if (reply.status !== "ok") throw new Error(reply.reason);
  return reply;
}
/** The pack's own title and description for two of the fixture's advancements, as the knowledge export holds them. */
async function knowledge() {
  const dir = await mkdtemp(join(tmpdir(), "resident-frontier-"));
  const path = join(dir, "knowledge.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE advancements(id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, description TEXT NOT NULL, items TEXT NOT NULL)");
  db.query("INSERT INTO advancements VALUES (?,?,?,?,?)").run("mekanism:teleporter", "mekanism:materials", "Teleportation", "Craft a Teleporter", '["mekanism:teleporter"]');
  db.query("INSERT INTO advancements VALUES (?,?,?,?,?)").run("minecraft:nether/explore_nether", "minecraft:nether/root", "Hot Tourist Destinations", "Explore all Nether biomes", "[]");
  db.close();
  const opened = openKnowledge(path);
  cleanups.push(async () => { opened.close(); await rm(dir, { recursive: true, force: true }); });
  return opened;
}
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  now, health: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, dimension: "minecraft:overworld", carried: [], armour: [], places: [], deaths: [],
  plan: { name: "wheat field", goal: "bread", total: 5, done: 1, current: { number: 2, text: "till the field" }, blocked: [], idleMs: 0 }, ...over,
});
const rule = (id: string, priority: number, keeps?: boolean): Rule => ({ id, priority, keeps, suggest: () => `${id} says so.` });
/** The whole frontier, keeping only one entry. */
function only(id: string): Frontier {
  const all = frontier(10);
  return { ...all, entries: all.entries.filter(entry => entry.id === id) };
}

describe("advancement lines in what_next", () => {
  test("in plain words: what it is, its tab and how much is done there, what is missing, where to learn more, how old", async () => {
    const k = await knowledge(), f = only("minecraft:nether/explore_nether");
    expect(frontierText(f.entries[0]!, f, k)).toBe('Advancement within reach (server record 7 min old): "Hot Tourist Destinations", tab "Nether" (base game; 1 of 2 done there). Explore all Nether biomes. 2 of its 5 criteria met, 3 still missing. Learn more: guide.');
    const all = frontier(5, "mekanism");
    const teleporter = all.entries.find(entry => entry.id === "mekanism:teleporter")!;
    // A translation key on the server gives way to the pack's own title; without the export, the id says what it is.
    expect(frontierText(teleporter, all, k)).toBe('Advancement within reach (server record 7 min old): "Teleportation", tab "Mekanism" (mod mekanism; 2 of 5 done there). Craft a Teleporter. 0 of 4 criteria met; it needs one in each of 2 groups. Learn more: mods {query:"mekanism"}, recipes {item:"mekanism:teleporter"}, guide.');
    expect(frontierText(teleporter, all)).toStartWith('Advancement within reach (server record 7 min old): "teleporter" (no title on the server; id mekanism:teleporter), tab "Mekanism"');
    const quark = frontier(3, "quark");
    expect(frontierText(quark.entries[0]!, quark)).toBe('Advancement within reach (server record 7 min old): "Blossoming", tab "Minecraft" (base game; this one from mod quark; 4 of 7 done there). Needs all 5 of its criteria; none met yet. Learn more: mods {query:"quark"}, guide.');
  });

  test("up to three after the other suggestions, five in all; safety and stalled plans never give way", () => {
    const f = frontier(3);
    // Nothing else to say: three advancement lines after the plan's step.
    const settled = whatNext(snapshot({ frontier: f }), []).split("\n");
    expect(settled).toHaveLength(5);
    expect(settled[1]).toStartWith("Nothing else to suggest");
    expect(settled.slice(2).every((line, i) => line.startsWith(`${i + 1}. Advancement within reach (server record 7 min old): `))).toBe(true);
    // Two kept (priority from a stalled plan's up), four others: two advancement lines take the places of the two least useful.
    const table = [rule("health", 100), rule("stalled", 62), rule("pickaxe", 60), rule("furnace", 55), rule("chest", 48), rule("project", 10)];
    expect(frontierRoom(snapshot(), table)).toBe(2);
    const mixed = whatNext(snapshot({ frontier: frontier(2) }), table).split("\n").slice(1);
    expect(mixed.map(line => line.slice(0, 24))).toEqual(["1. health says so.", "2. stalled says so.", "3. pickaxe says so.", "4. Advancement within re", "5. Advancement within re"]);
    // Kept suggestions (a rule marked keeps counts too) leave one place; five kept leave none.
    const kept = [rule("health", 100), rule("food", 90), rule("stalled", 62), rule("armour", 20, true), rule("chest", 48), rule("project", 10)];
    expect(frontierRoom(snapshot(), kept)).toBe(1);
    expect(whatNext(snapshot({ frontier: f }), kept).split("\n").slice(1).map(line => line.slice(0, 13))).toEqual(["1. health say", "2. food says ", "3. stalled sa", "4. armour say", "5. Advancemen"]);
    const full = [...kept, rule("bed", 85)];
    expect(frontierRoom(snapshot(), full)).toBe(0);
    expect(whatNext(snapshot({ frontier: f }), full)).toBe(whatNext(snapshot(), full));
  });

  test("the real rules: a starving, injured resident gets no advancement line; the reply stays within 1,300 characters", () => {
    const troubled = snapshot({ health: 5, food: 4, deaths: [{ x: 0, y: 60, z: 0, dimension: "minecraft:overworld", at: now - 60_000 }],
      carried: [{ slot: 0, item: "minecraft:raw_iron", count: 9 }, { slot: 1, item: "minecraft:furnace", count: 1 }, { slot: 2, item: "minecraft:wheat_seeds", count: 20 }],
      plan: { name: "wheat field", goal: "bread", total: 5, done: 1, current: { number: 2, text: "t".repeat(200) }, blocked: [], idleMs: 3_600_000 } });
    expect(frontierRoom(troubled)).toBe(0);
    expect(whatNext({ ...troubled, frontier: frontier(3) })).toBe(whatNext(troubled));
    expect(whatNext(snapshot({ frontier: frontier(3), plan: { ...snapshot().plan!, current: { number: 2, text: "t".repeat(200) } } })).length).toBeLessThanOrEqual(1300);
  });
});

describe("what_next through the body", () => {
  const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n").split("\n\nSince last time:")[0]!;

  test("with the hub's advancement data: lines blended in, a different set on each ask, one tab listed on request", async () => {
    const h = hub(), f = await fixture(h.identity());
    const first = text(await f.tools.call("what_next")).split("\n"), second = text(await f.tools.call("what_next")).split("\n");
    // No armour (kept), no bed, no project, and two advancement lines.
    expect(first).toHaveLength(5);
    expect(first[0]).toStartWith("1. No armour is worn");
    expect(first.slice(3).every(line => /^\d\. Advancement within reach \(server record 7 min old\): "/.test(line))).toBe(true);
    expect(second.slice(3)).not.toEqual(first.slice(3));
    const nether = text(await f.tools.call("what_next", { advancements: "Nether" }));
    expect(nether).toBe([
      '1 advancement within reach for "Nether": not done yet, the one before done (server record 7 min old; the server saves about every 5 min and the hub reads it every 30 min).',
      '1. "Hot Tourist Destinations", tab "Nether" (base game; 1 of 2 done there). 2 of its 5 criteria met, 3 still missing. Learn more: guide.',
    ].join("\n"));
    const unknown = text(await f.tools.call("what_next", { advancements: "create" }));
    expect(unknown).toStartWith('No tab or mod "create" has an advancement within reach (server record 7 min old;');
    expect(unknown).toContain("Tabs with something within reach: Welcome to Camping! (camping) 1, Mekanism (mekanism) 2, Nether 1, Minecraft 3.");
    const all = text(await f.tools.call("what_next", { advancements: "all" }));
    expect(all.split("\n")[0]).toBe('7 advancements within reach across your advancement tabs: not done yet, the one before done (server record 7 min old; the server saves about every 5 min and the hub reads it every 30 min).');
    expect(all.split("\n")).toHaveLength(9);
  });

  test("the pack's titles and descriptions come from the knowledge the tool server was given", async () => {
    const h = hub(), f = await fixture(h.identity());
    const tools = new Tools(f.body, await knowledge());
    cleanups.push(() => tools.close());
    expect(text(await tools.call("what_next", { advancements: "mekanism" }))).toContain('"Teleportation", tab "Mekanism" (mod mekanism; 2 of 5 done there). Craft a Teleporter.');
  });

  test("without advancement data the reply is as before and silent about it, unless asked", async () => {
    const plain = await fixture(hub(false).identity());
    const reply = text(await plain.tools.call("what_next"));
    expect(reply).not.toContain("dvancement");
    expect(reply.split("\n")).toHaveLength(3);
    expect(text(await plain.tools.call("what_next", { advancements: "all" }))).toBe("Advancement progress unavailable: This hub does not read advancement progress from the server.");
    // No hub configured: asking says why.
    const alone = await fixture();
    expect(text(await alone.tools.call("what_next", { advancements: "Nether" }))).toStartWith("Advancement progress unavailable: Shared Knowledge unavailable");
  });
});
