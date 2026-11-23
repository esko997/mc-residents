import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { societyOperation } from "../src/resident-society.ts";
import { knowledgeOperation } from "../src/resident-knowledge.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  databases.push(db);
  return db;
}
const facility = { name: "Pantry", purpose: "Food storage", capabilities: ["food"], x: 1, y: 70, z: 2, dimension: "minecraft:overworld", access_terms: "Ask the steward" };
const societyInputs: Record<string, object> = {
  collaborate: { kind: "request", recipient: "Margo", terms: "Deliver bread" },
  update: { id: 1, revision: 1, action: "accept" }, show: {}, register: facility,
  updateFacility: { id: 1, revision: 1, ...facility },
  observe: { id: 1, condition: "Intact", certainty: "observed", source: "Seen in person" },
  showFacility: {}, snapshot: {},
};
const knowledgeInputs: Record<string, object> = {
  recordMiss: { query: "Quantum widgets" },
  feedback: { target: "shelter", query: "shelter", verdict: "inaccurate", detail: "Incorrect roof" },
  get: { id: 1 }, list: {}, exact: { query: "Quantum widgets" }, search: { query: "widgets" },
  updates: {}, registerResidentTools: { names: ["use"] }, overview: {}, capabilityOverview: {},
};

test("every society and knowledge operation rejects unknown identity keys before touching storage", () => {
  const db = database();
  for (const [dispatch, inputs] of [[societyOperation, societyInputs], [knowledgeOperation, knowledgeInputs]] as const) {
    for (const [operation, args] of Object.entries(inputs)) {
      for (const field of ["actor", "resident", "author", "unexpected"]) {
        expect(() => dispatch(db, "Gary", operation, { ...args, [field]: "Margo" })).toThrow();
      }
      for (const malformed of [null, [], "args", 1]) expect(() => dispatch(db, "Gary", operation, malformed)).toThrow();
    }
    expect(() => dispatch(db, "Gary", "constructor", {})).toThrow("Unknown");
    expect(() => dispatch(db, "Gary", "__proto__", {})).toThrow("Unknown");
  }
  expect(db.query("SELECT count(*) AS n FROM collaborations").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM resident_tools").get()).toEqual({ n: 0 });
});

test("hub bounds nested stock, references, context, and tool-registration inputs", () => {
  const db = database();
  expect(() => societyOperation(db, "Gary", "register", { ...facility, capabilities: ["food"], x: Infinity })).toThrow();
  expect(() => societyOperation(db, "Gary", "snapshot", { needs: "x".repeat(2001) })).toThrow();
  expect(() => societyOperation(db, "Gary", "observe", { ...societyInputs.observe, stock: [{ item: "bread", count: 1, actor: "Margo" }] })).toThrow();
  expect(() => knowledgeOperation(db, "Gary", "recordMiss", { query: "x".repeat(201) })).toThrow();
  expect(() => knowledgeOperation(db, "Gary", "recordMiss", { query: "Widgets", project: "x".repeat(201) })).toThrow();
  expect(() => knowledgeOperation(db, "Gary", "registerResidentTools", { names: Array(1001).fill("use") })).toThrow();
  expect(() => knowledgeOperation(db, "Gary", "list", { page: 0 })).toThrow();
  expect(() => knowledgeOperation(db, "Gary", "overview", { limit: 101 })).toThrow();
});
