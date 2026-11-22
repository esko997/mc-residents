import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { schemaFile } from "../src/commons.ts";
import { createSociety, observationFreshness, societyDefinitions } from "../src/society.ts";
import { suggestions, whatNext, type Snapshot } from "../src/ideas.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const start = Date.UTC(2026, 10, 21, 12), minute = 60_000;
function household() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(schemaFile, "utf8"));
  let clock = start;
  const gary = createSociety({ db, resident: "Gary", now: () => clock });
  const margo = createSociety({ db, resident: "Margo", now: () => clock });
  const neighbour = createSociety({ db, resident: "Neighbour", now: () => clock });
  return { db, gary, margo, neighbour, advance: (ms: number) => { clock += ms; }, current: () => clock };
}
const request = { kind: "request" as const, recipient: "Margo", project: "bread supply", terms: "Deliver 12 wheat to the marked pantry chest." };
const pantry = {
  name: "Pantry", purpose: "Shared bread and wheat storage", capabilities: ["food", "bread", "storage"],
  x: 10, y: 70, z: -20, dimension: "minecraft:overworld", access_terms: "Ask Gary before taking wheat; bread is shared.",
};
const observation = { id: 1, condition: "Chest intact and accessible", certainty: "observed" as const, source: "Opened the pantry chest at 10,70,-20" };

// Test the real commons store; no world action is executed or inferred from a report.
describe("voluntary agreements", () => {
  test("identity cannot be supplied in tool args or used to accept/withdraw another's agreement", () => {
    const { gary, margo, neighbour } = household();
    expect(societyDefinitions.collaborate.schema.safeParse({ ...request, sender: "Margo" }).success).toBe(false);
    expect(() => gary.collaborate({ ...request, recipient: "gArY" })).toThrow("another resident");
    gary.collaborate(request);
    expect(() => gary.update({ id: 1, revision: 1, action: "accept" })).toThrow("other party");
    expect(() => neighbour.update({ id: 1, revision: 1, action: "accept" })).toThrow("not yours");
    expect(() => neighbour.update({ id: 1, revision: 1, action: "withdraw" })).toThrow("not yours");
    expect(neighbour.snapshot().collaborations).toHaveLength(0);
    expect(margo.update({ id: 1, revision: 1, action: "accept" })).toContain("r2 request accepted");
    expect(() => margo.update({ id: 1, revision: 1, action: "withdraw" })).toThrow("Revision conflict");
    expect(margo.snapshot().collaborations[0]?.status).toBe("accepted");
  });

  test("counterproposals invalidate acceptance, and only the other party accepts revised terms", () => {
    const { gary, margo } = household();
    gary.collaborate(request);
    margo.update({ id: 1, revision: 1, action: "accept" });
    gary.update({ id: 1, revision: 2, action: "counter", terms: "Deliver 6 wheat instead; keep the rest." });
    expect(margo.snapshot().collaborations[0]).toMatchObject({ status: "proposed", revision: 3, accepted_revision: null });
    expect(() => margo.update({ id: 1, revision: 3, action: "report", evidence: "Six wheat delivered", source: "Chest UI" })).toThrow("after acceptance");
    expect(() => gary.update({ id: 1, revision: 3, action: "accept" })).toThrow("other party");
    expect(() => margo.update({ id: 1, revision: 3, action: "accept", terms: "I will do something else" })).toThrow("Changed terms");
    expect(margo.update({ id: 1, revision: 3, action: "accept" })).toContain("r4 request accepted");
    expect(gary.snapshot().collaborations[0]?.accepted_revision).toBe(3);
  });

  test("reported completion needs performer evidence, then distinct beneficiary confirmation", () => {
    const { gary, margo } = household();
    gary.collaborate(request);
    margo.update({ id: 1, revision: 1, action: "accept" });
    expect(() => gary.update({ id: 1, revision: 2, action: "report", evidence: "I think it is done", source: "Guess" })).toThrow("performer");
    expect(() => margo.update({ id: 1, revision: 2, action: "report" })).toThrow("evidence");
    const reported = margo.update({ id: 1, revision: 2, action: "report", evidence: "Placed 12 wheat into pantry", source: "Chest slot after transfer" });
    expect(reported).toContain("reported");
    expect(reported).toContain("not machine-verified");
    expect(gary.snapshot().collaborations[0]?.confirmation).toBeNull();
    expect(() => margo.update({ id: 1, revision: 3, action: "confirm", evidence: "Done", source: "Same transfer" })).toThrow("distinct beneficiary");
    expect(() => gary.update({ id: 1, revision: 3, action: "confirm", evidence: "Done" })).toThrow("source");
    expect(gary.update({ id: 1, revision: 3, action: "confirm", evidence: "I found 12 wheat in the marked chest", source: "Opened chest and counted slot" })).toContain("r4 request confirmed");
    expect(gary.snapshot().collaborations).toHaveLength(0);
    expect(gary.show({ id: 1 })).toContain("Recipient confirmation (not machine-verified)");
    expect(() => margo.update({ id: 1, revision: 4, action: "counter", terms: "Different goods" })).toThrow("already confirmed");
  });

  test("public refusal is personal; volunteering binds only that actor; offer roles reverse", () => {
    const { gary, margo, neighbour } = household();
    gary.collaborate({ kind: "offer", terms: "I can smelt your iron at my furnace." });
    expect(margo.update({ id: 1, revision: 1, action: "decline" })).toContain("remains open to others");
    expect(margo.snapshot().collaborations).toHaveLength(0);
    expect(neighbour.snapshot().collaborations[0]?.recipient).toBeNull();
    gary.update({ id: 1, revision: 1, action: "counter", terms: "I can smelt your iron and provide fuel." });
    expect(margo.snapshot().collaborations).toHaveLength(1);
    margo.update({ id: 1, revision: 2, action: "counter", terms: "Please smelt my 8 raw iron; I will supply fuel." });
    expect(margo.snapshot().collaborations[0]?.recipient).toBe("Margo");
    expect(() => neighbour.update({ id: 1, revision: 3, action: "accept" })).toThrow("not yours");
    gary.update({ id: 1, revision: 3, action: "accept" });
    expect(() => margo.update({ id: 1, revision: 4, action: "report", evidence: "Smelted", source: "Furnace" })).toThrow("performer");
    gary.update({ id: 1, revision: 4, action: "report", evidence: "Eight ingots returned", source: "Output and chest slots" });
    expect(margo.update({ id: 1, revision: 5, action: "confirm", evidence: "Collected eight ingots", source: "My inventory" })).toContain("confirmed");
  });

  test("decline and withdraw end agreements without claiming success", () => {
    const { gary, margo } = household();
    gary.collaborate(request);
    expect(margo.update({ id: 1, revision: 1, action: "decline" })).toContain("request declined");
    gary.collaborate(request);
    margo.update({ id: 2, revision: 1, action: "accept" });
    expect(margo.update({ id: 2, revision: 2, action: "withdraw" })).toContain("request withdrawn");
    expect(gary.show({ closed: true })).not.toContain("confirmed");
    expect(gary.snapshot().collaborations).toHaveLength(0);
  });

  test("history retention and output pagination remain bounded without losing long terms", () => {
    const { db, gary, margo } = household();
    gary.collaborate(request);
    for (let revision = 1; revision <= 55; revision++) {
      (revision % 2 ? margo : gary).update({ id: 1, revision, action: "counter", terms: `Revision ${revision}: ${"w".repeat(360)}` });
    }
    expect(db.query<{ total: number }, []>("SELECT COUNT(*) total FROM collaboration_history").get()?.total).toBe(50);
    expect(gary.show({ id: 1, page: 1 }).length).toBeLessThan(1500);
    expect(gary.show({ id: 1, page: 2 })).toContain("page 2/");
    for (let index = 0; index < 5; index++) gary.collaborate({ ...request, terms: `Extra delivery ${index}` });
    expect(gary.show({})).toContain("Continue with page:2");
    expect(gary.show({ page: 2 })).toContain("#1");
  });
});

describe("observed facilities", () => {
  test("visitor observations cannot steal stewardship or change access rights", () => {
    const { gary, margo } = household();
    gary.register(pantry);
    margo.observe({ ...observation, stock: [{ item: "minecraft:bread", count: 12 }] });
    expect(() => margo.updateFacility({ id: 1, revision: 1, ...pantry, access_terms: "All mine" })).toThrow("steward");
    expect(societyDefinitions.facility_observe.schema.safeParse({ ...observation, steward: "Margo", access_terms: "Free" }).success).toBe(false);
    expect(margo.snapshot().facilities[0]).toMatchObject({ steward: "Gary", access_terms: pantry.access_terms, revision: 1 });
    gary.updateFacility({ id: 1, revision: 1, ...pantry, x: 30 });
    expect(margo.snapshot().facilities[0]?.observation?.freshness).toBe("uncertain");
    expect(() => gary.updateFacility({ id: 1, revision: 1, ...pantry })).toThrow("Revision conflict");
  });

  test("stock freshness is separate from condition; a new condition never fabricates new stock", () => {
    const { gary, margo, advance, current } = household();
    gary.register(pantry);
    gary.observe({ ...observation, stock: [{ item: "minecraft:bread", count: 12 }] });
    advance(31 * minute);
    margo.observe({ ...observation, condition: "Chest still intact; did not open it" });
    const f = margo.snapshot().facilities[0]!;
    expect(f.observation?.freshness).toBe("recent");
    expect(f.observation?.stock).toBeUndefined();
    expect(f.stockObservation?.stockFreshness).toBe("stale");
    expect(f.stockObservation?.observed_at).toBe(start);
    expect(margo.showFacility({ id: 1 })).toContain("not live");
    expect(() => margo.observe({ ...observation, observed_at: current() + 1 })).toThrow("future");
    margo.observe({ ...observation, observed_at: start - minute, condition: "Earlier condition, entered later" });
    expect(margo.snapshot().facilities[0]?.observation?.condition).toBe("Chest still intact; did not open it");
    advance(6 * 60 * minute + 1);
    expect(margo.snapshot().facilities[0]?.observation?.freshness).toBe("stale");
    margo.observe({ ...observation, certainty: "uncertain", source: "A neighbour mentioned it" });
    expect(margo.snapshot().facilities[0]?.observation?.freshness).toBe("uncertain");
  });

  test("freshness boundaries and observed-empty stock do not imply live inventory", () => {
    const { gary } = household();
    expect(observationFreshness(start, start + 30 * minute, "observed", true)).toBe("recent");
    expect(observationFreshness(start, start + 30 * minute + 1, "observed", true)).toBe("stale");
    expect(observationFreshness(start + 1, start, "observed")).toBe("uncertain");
    expect(observationFreshness(start, start, "uncertain")).toBe("uncertain");
    gary.register(pantry);
    gary.observe({ ...observation, stock: [{ item: "minecraft:bread", count: 12 }] });
    gary.observe({ ...observation, condition: "Chest now empty", stock: [] });
    expect(gary.snapshot().facilities[0]?.stockObservation?.stock).toEqual([]);
    expect(gary.showFacility({ id: 1 })).toContain("not a verified prerequisite");
  });

  test("observation histories stay bounded and preserve dated last stock", () => {
    const { db, gary, advance } = household();
    gary.register(pantry);
    gary.observe({ ...observation, stock: [{ item: "minecraft:bread", count: 12 }] });
    for (let index = 0; index < 55; index++) {
      advance(minute);
      gary.observe({ ...observation, condition: `Door check ${index}` });
    }
    expect(db.query<{ total: number }, []>("SELECT COUNT(*) total FROM facility_observations").get()?.total).toBe(50);
    expect(gary.snapshot().facilities[0]?.stockObservation?.observed_at).toBe(start);
    expect(gary.showFacility({ id: 1 }).length).toBeLessThan(1500);
    expect(gary.showFacility({ id: 1, page: 2 })).toContain("page 2/");
  });
});

test("ideas put focused action first, suggest relevant access/dependencies, and never certify facilities", () => {
  const { gary, margo, advance, current } = household();
  gary.register(pantry);
  gary.observe({ ...observation, stock: [{ item: "minecraft:bread", count: 12 }] });
  gary.collaborate(request);
  margo.update({ id: 1, revision: 1, action: "accept" });
  advance(7 * 60 * minute);
  const snapshot: Snapshot = {
    now: current(), health: 20, food: 20, pos: { x: 0, y: 70, z: 0 }, dimension: "minecraft:overworld",
    carried: [{ slot: 0, item: "minecraft:bread", count: 3, edible: true }], armour: [], places: [], deaths: [],
    plan: { name: "bread supply", goal: "Reliable access to bread", needs: "shared food storage", current: { number: 1, text: "Check the pantry" }, total: 2, done: 0, blocked: [], idleMs: 0 },
    society: gary.snapshot({ project: "bread supply", needs: "bread storage", dimension: "minecraft:overworld" }),
  };
  const reply = whatNext(snapshot);
  expect(reply.startsWith('Your plan "bread supply", step 1 of 2: Check the pantry.')).toBe(true);
  expect(reply.length).toBeLessThanOrEqual(1300);
  const found = suggestions(snapshot);
  expect(found.find(s => s.id === "collaboration")?.text).toContain("agreed, not completed");
  const facility = found.find(s => s.id === "facility")?.text;
  expect(facility).toContain("stale, not verified");
  expect(facility).toContain("facility_show for full access terms");
  expect(facility).toContain("counts are not live");
  expect(facility).not.toContain("12");
  margo.update({ id: 1, revision: 2, action: "report", evidence: "Wheat delivered", source: "Chest UI" });
  snapshot.society = gary.snapshot();
  expect(suggestions(snapshot).find(s => s.id === "collaboration")?.text).toContain("Inspect the result before confirming");
  snapshot.dimension = "minecraft:the_nether";
  expect(suggestions(snapshot).find(s => s.id === "facility")).toBeUndefined();
});
