import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaFile } from "../src/commons.ts";
import { KnowledgeGaps, KNOWLEDGE_SCOPE } from "../src/knowledge-gaps.ts";
import { lookupGuide, lookupGuideResult } from "../src/guides.ts";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(path = ":memory:") {
  const db = new Database(path);
  db.exec(readFileSync(schemaFile, "utf8"));
  databases.push(db);
  return db;
}
const emptyBooks = { searchGuides: () => [] };
function publish(db: Database, id: number, answer = "Observed documentation. ".repeat(120)) {
  db.query(`INSERT INTO knowledge_references(gap_id,revision,title,scope,answer,prerequisites_json,controls_json,sources_json,caveats,evidence_json,model,published_at)
    VALUES(?,1,'Quantum widgets',?,?,'["Inspect recipe"]','["Use screen before selecting a slot"]',?,'Not tested in game','{}','test',1)`)
    .run(id, KNOWLEDGE_SCOPE, answer, JSON.stringify([{ url: "https://minecraft.wiki/w/Stone", title: "Stone", supports: "Example provenance" }]));
  db.query("UPDATE knowledge_gaps SET status='published',published_revision=1 WHERE id=?").run(id);
}

test("only real misses queue; explicit metadata distinguishes navigation, ambiguity, and a broken index", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary");
  for (const args of [{ query: "topics" }, { query: "cows sheep" }, { query: "mekanism refined storage" }, { query: "unmapped", section: "books" }, { query: "unmapped", section: "bad:0" }]) {
    expect(lookupGuideResult(args, emptyBooks, gaps).kind).not.toBe("miss");
  }
  expect(lookupGuideResult({ query: "quantum widgets" }, { searchGuides: () => { throw Error("offline"); } }, gaps).kind).toBe("unavailable");
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 0 });
  expect(lookupGuideResult({ query: "quantum widgets" }, emptyBooks, gaps).queuedId).toBe(1);
});

test("normalized recurrence is shared across connections while resident/project requests survive", () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-gap-")); directories.push(directory);
  const first = database(join(directory, "commons.sqlite")); const second = database(join(directory, "commons.sqlite"));
  const gary = new KnowledgeGaps(first, "Gary", () => "workshop");
  const margo = new KnowledgeGaps(second, "Margo", () => "factory");
  expect(gary.recordMiss("Quantum widgets?!")).toBe(margo.recordMiss("QUANTUM   widgets"));
  gary.recordMiss("Quantum widgets");
  expect(first.query("SELECT occurrences,revision FROM knowledge_gaps").get()).toEqual({ occurrences: 3, revision: 1 });
  expect(first.query("SELECT resident,project,occurrences FROM knowledge_requests ORDER BY resident").all()).toEqual([
    { resident: "Gary", project: "workshop", occurrences: 2 }, { resident: "Margo", project: "factory", occurrences: 1 },
  ]);
});

test("queue write failure never suppresses valid curated or installed-book output", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary");
  db.exec("DROP TABLE knowledge_requests");
  expect(lookupGuide({ query: "shelter" }, undefined, gaps)).toBe(lookupGuide({ query: "shelter" }));
  const books = { searchGuides: () => [{ where: "manual", excerpt: "Quantum widget source" }] };
  expect(lookupGuide({ query: "quantum widgets" }, books, gaps)).toContain("Quantum widget source");
  const result = lookupGuideResult({ query: "unmapped widgets" }, emptyBooks, gaps);
  expect(result.kind).toBe("miss"); expect(result.queuedId).toBeUndefined();
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 0 });
});

test("generated references are retrievable without the book index and paginate all source text", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary"); const id = gaps.recordMiss("Quantum widgets"); publish(db, id);
  expect(lookupGuide({ query: "quantum widgets" }, undefined, gaps)).toContain("UNTESTED REFERENCE");
  let section: string | undefined; const output: string[] = [];
  do {
    const text = lookupGuide({ query: `ref-${id}`, section }, undefined, gaps);
    expect(text.length).toBeLessThanOrEqual(1250);
    expect(text).toContain("UNTESTED REFERENCE");
    output.push(text);
    section = text.match(/next section=(\S+)/)?.[1];
  } while (section);
  expect(output.join("\n")).toContain("https://minecraft.wiki/w/Stone");
  expect(lookupGuide({ query: `ref-${id}`, section: "reference:999" }, undefined, gaps)).toContain("No such page");
  expect(lookupGuide({ query: "references" }, undefined, gaps)).toContain(`ref-${id}`);
});

test("explicit correction invalidates a lease, versions the same handle, labels old content, and preserves requesters", () => {
  const db = database(); const gary = new KnowledgeGaps(db, "Gary"); const margo = new KnowledgeGaps(db, "Margo");
  const id = gary.recordMiss("Quantum widgets"); publish(db, id);
  db.query("UPDATE knowledge_gaps SET status='researching',lease_token='old',lease_until=9999999999999 WHERE id=?").run(id);
  expect(margo.feedback({ target: `ref-${id}`, query: "Quantum widgets", verdict: "inaccurate", detail: "That machine is absent in this version" })).toContain("revision 2");
  expect(db.query("SELECT revision,status,lease_token,attempts,published_revision FROM knowledge_gaps").get()).toEqual({ revision: 2, status: "pending", lease_token: null, attempts: 0, published_revision: 1 });
  expect(lookupGuide({ query: `ref-${id}` }, undefined, gary)).toContain("OUTDATED");
  expect(db.query("SELECT count(*) AS n FROM knowledge_requests").get()).toEqual({ n: 2 });
});

test("results are read once on request; pending lookup does not consume eventual publication", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary"); const id = gaps.recordMiss("Quantum widgets");
  expect(gaps.updates()).toContain("pending"); publish(db, id);
  expect(gaps.updates()).toContain("published");
  expect(gaps.updates()).toContain("No new");
  expect(gaps.updates({ all: true })).toContain(`ref-${id}`);
});

test("reference catalogue pagination retains stable handles", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary");
  for (let i = 0; i < 8; i++) publish(db, gaps.recordMiss(`Quantum widgets ${i}`), "Read version documentation.");
  expect(lookupGuide({ query: "references" }, emptyBooks, gaps)).toContain("section=references:2");
  const next = lookupGuide({ query: "references", section: "references:2" }, emptyBooks, gaps);
  expect(next).toContain("ref-7"); expect(next).toContain("ref-8"); expect(next).not.toContain("ref-1 ");
});

test("an absent Commons connection leaves guides and book lookup usable", () => {
  const gaps = new KnowledgeGaps(undefined, "Gary");
  expect(lookupGuide({ query: "shelter" }, undefined, gaps)).toBe(lookupGuide({ query: "shelter" }));
  expect(lookupGuideResult({ query: "quantum widgets" }, emptyBooks, gaps).queuedId).toBeUndefined();
  expect(gaps.feedback({ target: "shelter", query: "shelter", verdict: "unhelpful", detail: "Need a different roof" })).toContain("Could not save");
  expect(gaps.updates()).toContain("unavailable");
});

test("a researched correction to a curated question is found by that same question without breaking explicit curated sections", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary");
  gaps.feedback({ target: "shelter", query: "shelter", verdict: "unhelpful", detail: "Need a different roof" });
  // Publish the current revision, as the researcher would.
  publish(db, 1, "A researched correction.");
  db.exec("UPDATE knowledge_references SET revision=2 WHERE gap_id=1; UPDATE knowledge_gaps SET published_revision=2 WHERE id=1");
  expect(lookupGuide({ query: "shelter" }, undefined, gaps)).toContain("A researched correction.");
  expect(lookupGuide({ query: "shelter", section: "books" }, emptyBooks, gaps)).not.toContain("A researched correction.");
});

test("new-result cursor does not skip requests when earlier results are consumed", () => {
  const db = database(); const gaps = new KnowledgeGaps(db, "Gary");
  for (let i = 0; i < 8; i++) publish(db, gaps.recordMiss(`Quantum widgets ${i}`), "Read documentation.");
  expect(gaps.updates()).toContain("{after:5}");
  const next = gaps.updates({ after: 5 });
  expect(next).toContain("ref-6"); expect(next).toContain("ref-8");
  expect(gaps.updates()).toContain("No new");
});
