import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonsClient } from "../src/commons.ts";
import { schemaFile, sharedHttp } from "./shared-http.ts";
import { KnowledgeGaps, registerResidentTools } from "../src/knowledge-gaps.ts";
import { KNOWLEDGE_SCOPE, NEVER_RETRY } from "../../commons/src/resident-contracts-knowledge.ts";
import { capabilityOverview, knowledgeOverview, registerResidentToolsStore } from "../../commons/src/resident-knowledge.ts";
import { lookupGuide, lookupGuideResult } from "../src/guides.ts";

const databases: Database[] = [];
const hubs: { close(): void }[] = [];
function client(db: Database, resident: string) {
  const hub = sharedHttp(db); hubs.push(hub); return hub.client(resident);
}
const directories: string[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.close(); for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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

test("only real misses queue; explicit metadata distinguishes navigation, ambiguity, and a broken index", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  for (const args of [{ query: "topics" }, { query: "cows sheep" }, { query: "mekanism refined storage" }, { query: "unmapped", section: "books" }, { query: "unmapped", section: "bad:0" }]) {
    expect((await lookupGuideResult(args, emptyBooks, gaps)).kind).not.toBe("miss");
  }
  expect((await lookupGuideResult({ query: "quantum widgets" }, { searchGuides: () => { throw Error("offline"); } }, gaps)).kind).toBe("unavailable");
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 0 });
  expect((await lookupGuideResult({ query: "quantum widgets" }, emptyBooks, gaps)).queuedId).toBe(1);
});

test("normalized recurrence is shared across connections while resident/project requests survive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-gap-")); directories.push(directory);
  const first = database(join(directory, "commons.sqlite")); const second = database(join(directory, "commons.sqlite"));
  const gary = new KnowledgeGaps(client(first, "Gary"), "Gary", () => "workshop");
  const margo = new KnowledgeGaps(client(second, "Margo"), "Margo", () => "factory");
  expect((await gary.recordMiss("Quantum widgets?!"))).toBe((await margo.recordMiss("QUANTUM   widgets")));
  (await gary.recordMiss("Quantum widgets"));
  expect(first.query("SELECT occurrences,revision FROM knowledge_gaps").get()).toEqual({ occurrences: 3, revision: 1 });
  expect(first.query("SELECT resident,project,occurrences FROM knowledge_requests ORDER BY resident").all()).toEqual([
    { resident: "Gary", project: "workshop", occurrences: 2 }, { resident: "Margo", project: "factory", occurrences: 1 },
  ]);
});

test("queue write failure never suppresses valid curated or installed-book output", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  db.exec("DROP TABLE knowledge_requests");
  expect((await lookupGuide({ query: "shelter" }, undefined, gaps))).toBe((await lookupGuide({ query: "shelter" })));
  const books = { searchGuides: () => [{ where: "manual", excerpt: "Quantum widget source" }] };
  expect((await lookupGuide({ query: "quantum widgets" }, books, gaps))).toContain("Quantum widget source");
  const result = (await lookupGuideResult({ query: "unmapped widgets" }, emptyBooks, gaps));
  expect(result.kind).toBe("miss"); expect(result.queuedId).toBeUndefined();
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 0 });
});

test("generated references are retrievable without the book index and paginate all source text", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary"); const id = (await gaps.recordMiss("Quantum widgets")); publish(db, id);
  expect((await lookupGuide({ query: "quantum widgets" }, undefined, gaps))).toContain("UNTESTED REFERENCE");
  let section: string | undefined; const output: string[] = [];
  do {
    const text = (await lookupGuide({ query: `ref-${id}`, section }, undefined, gaps));
    expect(text.length).toBeLessThanOrEqual(1250);
    expect(text).toContain("UNTESTED REFERENCE");
    output.push(text);
    section = text.match(/next section=(\S+)/)?.[1];
  } while (section);
  expect(output.join("\n")).toContain("https://minecraft.wiki/w/Stone");
  expect((await lookupGuide({ query: `ref-${id}`, section: "reference:999" }, undefined, gaps))).toContain("No such page");
  expect((await lookupGuide({ query: "references" }, undefined, gaps))).toContain(`ref-${id}`);
});

test("explicit correction invalidates a lease, versions the same handle, labels old content, and preserves requesters", async () => {
  const db = database(); const gary = new KnowledgeGaps(client(db, "Gary"), "Gary"); const margo = new KnowledgeGaps(client(db, "Margo"), "Margo");
  const id = (await gary.recordMiss("Quantum widgets")); publish(db, id);
  db.query("UPDATE knowledge_gaps SET status='researching',lease_token='old',lease_until=9999999999999 WHERE id=?").run(id);
  expect((await margo.feedback({ target: `ref-${id}`, query: "Quantum widgets", verdict: "inaccurate", detail: "That machine is absent in this version" }))).toContain("revision 2");
  expect(db.query("SELECT revision,status,lease_token,attempts,published_revision FROM knowledge_gaps").get()).toEqual({ revision: 2, status: "pending", lease_token: null, attempts: 0, published_revision: 1 });
  expect((await lookupGuide({ query: `ref-${id}` }, undefined, gary))).toContain("OUTDATED");
  expect(db.query("SELECT count(*) AS n FROM knowledge_requests").get()).toEqual({ n: 2 });
});

test("results are read once on request; pending lookup does not consume eventual publication", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary"); const id = (await gaps.recordMiss("Quantum widgets"));
  expect((await gaps.updates())).toContain("pending"); publish(db, id);
  expect((await gaps.updates())).toContain("published");
  expect((await gaps.updates())).toContain("No new");
  expect((await gaps.updates({ all: true }))).toContain(`ref-${id}`);
});

test("reference catalogue pagination retains stable handles", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  for (let i = 0; i < 8; i++) publish(db, (await gaps.recordMiss(`Quantum widgets ${i}`)), "Read version documentation.");
  expect((await lookupGuide({ query: "references" }, emptyBooks, gaps))).toContain("section=references:2");
  const next = (await lookupGuide({ query: "references", section: "references:2" }, emptyBooks, gaps));
  expect(next).toContain("ref-7"); expect(next).toContain("ref-8"); expect(next).not.toContain("ref-1 ");
});

test("an absent Commons connection leaves guides and book lookup usable", async () => {
  const gaps = new KnowledgeGaps(new CommonsClient(), "Gary");
  expect((await lookupGuide({ query: "shelter" }, undefined, gaps))).toBe((await lookupGuide({ query: "shelter" })));
  expect((await lookupGuideResult({ query: "quantum widgets" }, emptyBooks, gaps)).queuedId).toBeUndefined();
  await expect(gaps.feedback({ target: "shelter", query: "shelter", verdict: "unhelpful", detail: "Need a different roof" })).rejects.toThrow("Shared Knowledge unavailable");
  await expect(gaps.updates()).rejects.toThrow("Shared Knowledge unavailable");
});

test("a researched correction to a curated question is found by that same question without breaking explicit curated sections", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  (await gaps.feedback({ target: "shelter", query: "shelter", verdict: "unhelpful", detail: "Need a different roof" }));
  // Publish the current revision, as the researcher would.
  publish(db, 1, "A researched correction.");
  db.exec("UPDATE knowledge_references SET revision=2 WHERE gap_id=1; UPDATE knowledge_gaps SET published_revision=2 WHERE id=1");
  expect((await lookupGuide({ query: "shelter" }, undefined, gaps))).toContain("A researched correction.");
  expect((await lookupGuide({ query: "shelter", section: "books" }, emptyBooks, gaps))).not.toContain("A researched correction.");
});

test("new-result cursor does not skip requests when earlier results are consumed", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  for (let i = 0; i < 8; i++) publish(db, (await gaps.recordMiss(`Quantum widgets ${i}`)), "Read documentation.");
  expect((await gaps.updates())).toContain("{after:5}");
  const next = (await gaps.updates({ after: 5 }));
  expect(next).toContain("ref-6"); expect(next).toContain("ref-8");
  expect((await gaps.updates())).toContain("No new");
});

function park(db: Database, gapId: number, capability: string) {
  // As knowledge-research.py block() leaves a revision whose researcher reported a missing body capability.
  db.query("INSERT INTO capability_gaps(normalized_capability,capability,first_at,last_at) VALUES(?,?,1,1)").run(capability, capability);
  const { id } = db.query<{ id: number }, [string]>("SELECT id FROM capability_gaps WHERE normalized_capability=?").get(capability)!;
  db.query("INSERT INTO capability_reports(capability_id,gap_id,revision,reporter,blocking,at) SELECT ?,id,revision,'caretaker',1,1 FROM knowledge_gaps WHERE id=?").run(id, gapId);
  db.query("UPDATE knowledge_gaps SET status='unavailable',reason='Needs body capability: x',next_attempt_at=? WHERE id=?").run(NEVER_RETRY, gapId);
  return id;
}

test("missing_control feedback reaches the maintainers' queue without re-researching or revising the reference", async () => {
  const db = database(); const gary = new KnowledgeGaps(client(db, "Gary"), "Gary"); const margo = new KnowledgeGaps(client(db, "Margo"), "Margo");
  const id = (await gary.recordMiss("Quantum widgets")); publish(db, id);
  expect((await gary.feedback({ target: `ref-${id}`, query: "Quantum widgets", verdict: "missing_control", detail: "Guide says hold the boost key" }))).toContain("missing_control give capability");
  expect((await gary.feedback({ target: `ref-${id}`, query: "Quantum widgets", verdict: "missing_control", detail: "Guide says hold the boost key", capability: "Hold a mod keybinding" }))).toContain("cap-1");
  expect((await margo.feedback({ target: "aircraft", query: "fly up", verdict: "missing_control", detail: "No key for ascend", capability: "hold a MOD keybinding!" }))).toContain("cap-1");
  expect(db.query("SELECT revision,status,published_revision,next_attempt_at FROM knowledge_gaps WHERE id=?").get(id)).toEqual({ revision: 1, status: "published", published_revision: 1, next_attempt_at: 0 });
  expect(db.query("SELECT count(*) AS n FROM knowledge_feedback").get()).toEqual({ n: 0 });
  // A missing control reported outside a ref must not open a research request either.
  expect(db.query("SELECT count(*) AS n FROM knowledge_gaps").get()).toEqual({ n: 1 });
  expect(db.query("SELECT occurrences,status FROM capability_gaps").all()).toEqual([{ occurrences: 2, status: "open" }]);
  expect(db.query("SELECT gap_id,reporter,blocking FROM capability_reports ORDER BY reporter").all()).toEqual([
    { gap_id: id, reporter: "Gary", blocking: 0 }, { gap_id: 0, reporter: "Margo", blocking: 0 },
  ]);
  db.exec("UPDATE capability_gaps SET status='declined',resolution='not planned'");
  expect((await gary.feedback({ target: `ref-${id}`, query: "Quantum widgets", verdict: "missing_control", detail: "Still no key", capability: "hold a mod keybinding" }))).toContain("declined cap-1 (not planned)");
});

test("a revision parked on a missing body capability stays parked on repeat misses and reopens only on an explicit correction", async () => {
  const db = database(); const gaps = new KnowledgeGaps(client(db, "Gary"), "Gary");
  const id = (await gaps.recordMiss("Steer a boat"));
  const cap = park(db, id, "steer a vehicle");
  let [row] = knowledgeOverview(db);
  expect(row).toMatchObject({ gap_kind: "capability", parked: 1, blocked_by: `cap-${cap} steer a vehicle [open]` });
  (await gaps.recordMiss("steer a BOAT"));
  expect(db.query("SELECT status,next_attempt_at FROM knowledge_gaps").get()).toEqual({ status: "unavailable", next_attempt_at: NEVER_RETRY });
  expect(capabilityOverview(db)[0]).toMatchObject({ handle: `cap-${cap}`, status: "open", refs: `ref-${id}`, parked_requests: 1 });
  (await gaps.feedback({ target: `ref-${id}`, query: "Steer a boat", verdict: "unhelpful", detail: "use while facing the boat mounts it" }));
  [row] = knowledgeOverview(db);
  expect(row).toMatchObject({ gap_kind: "knowledge", parked: 0, revision: 2, status: "pending", blocked_by: null });
  expect(capabilityOverview(db)[0]!.parked_requests).toBe(0);
});

test("registered resident tools replace the previous list and ignore invalid names", async () => {
  const db = database();
  expect(registerResidentToolsStore(db, "Gary", ["go_to", "use", "use", "Bad-Name", "x".repeat(60)], 5)).toBe(2);
  expect(registerResidentToolsStore(db, "Gary", ["go_to", "mount"], 6)).toBe(2);
  registerResidentToolsStore(db, "Margo", ["use"], 7);
  expect(db.query("SELECT name,resident,seen_at FROM resident_tools ORDER BY resident,name").all()).toEqual([
    { name: "go_to", resident: "Gary", seen_at: 6 }, { name: "mount", resident: "Gary", seen_at: 6 }, { name: "use", resident: "Margo", seen_at: 7 },
  ]);
  expect(registerResidentToolsStore(undefined, "Gary", ["use"])).toBe(0);
});

test("HTTP knowledge identity is credential-only, registration replaces centrally, and outages reject writes", async () => {
  const db = database(), transport = client(db, "Gary");
  const gaps = new KnowledgeGaps(transport, "Margo", () => { throw new Error("No active project"); });
  const id = await gaps.recordMiss("Quantum widgets");
  expect(db.query("SELECT resident,project FROM knowledge_requests").all()).toEqual([{ resident: "Gary", project: "" }]);
  publish(db, id);
  expect(await gaps.get(id)).toMatchObject({ gap_id: id, stale: 0 });
  expect(await gaps.exact("QUANTUM widgets")).toMatchObject({ gap_id: id });
  expect(await gaps.search("widgets")).toHaveLength(1);
  expect(await gaps.list()).toHaveLength(1);
  expect(await registerResidentTools(transport, "Margo", ["use", "use", "Bad-Name"])).toBe(1);
  expect(await registerResidentTools(transport, "Margo", ["go_to"])).toBe(1);
  expect(db.query("SELECT name,resident FROM resident_tools").all()).toEqual([{ name: "go_to", resident: "Gary" }]);
  expect(await transport.call("knowledge", "overview", {})).toMatchObject([{ id }]);
  expect(await transport.call("knowledge", "capabilityOverview", {})).toEqual([]);
  for (const operation of ["recordMiss", "feedback", "get", "list", "exact", "search", "updates", "registerResidentTools", "overview", "capabilityOverview"]) {
    await expect(transport.call("knowledge", operation, { resident: "Margo", actor: "Margo" })).rejects.toThrow();
  }
  await expect(registerResidentTools(new CommonsClient(), "Gary", ["use"])).rejects.toThrow("Shared Knowledge unavailable");
});
