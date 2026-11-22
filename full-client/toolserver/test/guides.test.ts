import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupGuide } from "../src/guides.ts";
import { referenceGuides } from "../src/guides-data.ts";
import { openKnowledge } from "../src/knowledge/index.ts";
import type { Knowledge } from "../src/knowledge/types.ts";

const fixtures: { directory: string; knowledge: Knowledge }[] = [];
afterEach(() => {
  for (const { directory, knowledge } of fixtures.splice(0)) {
    knowledge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function books(entries: { book: string; title: string; text: string }[]): Knowledge {
  const directory = mkdtempSync(join(tmpdir(), "resident-guides-"));
  const path = join(directory, "knowledge.sqlite");
  const db = new Database(path);
  db.exec("CREATE VIRTUAL TABLE guides USING fts5(book UNINDEXED, title, text, tokenize='unicode61')");
  const insert = db.query("INSERT INTO guides(book,title,text) VALUES (?,?,?)");
  for (const entry of entries) insert.run(entry.book, entry.title, entry.text);
  db.close();
  const knowledge = openKnowledge(path);
  fixtures.push({ directory, knowledge });
  return knowledge;
}

function readAll(query: string, section: string, knowledge?: Knowledge) {
  const responses: string[] = [];
  const payloads: string[] = [];
  const visited = new Set<string>();
  let handle: string | undefined = section;
  while (handle) {
    expect(visited.has(handle)).toBe(false);
    visited.add(handle);
    const response = lookupGuide({ query, section: handle }, knowledge);
    // A missing navigation link would lose instructions at the tool's outer cap.
    expect(response.length).toBeLessThanOrEqual(1250);
    expect(response).toContain("Scope:");
    expect(response).toContain("Source");
    const start = response.indexOf("\n\n");
    const end = response.lastIndexOf("\n\nPage ");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    payloads.push(response.slice(start + 2, end));
    responses.push(response);
    handle = response.match(/next section=([a-z0-9-]+:[0-9]+)/)?.[1];
  }
  return { responses, payloads };
}

const whitespace = (text: string) => text.replace(/\s+/g, " ").trim();

describe("offline practical guide routing", () => {
  test("natural questions select a topic and the relevant species/branch without filler AND matching", () => {
    expect(lookupGuide({ query: "How to start mekanism" })).toContain("query=mekanism;");
    expect(lookupGuide({ query: "how do I breed cows?" })).toContain("Section: cows");
    expect(lookupGuide({ query: "how do I breed cows?" })).toContain("minecraft");
    expect(lookupGuide({ query: "refined storage tech tree" })).toContain("Section: automation");
    expect(lookupGuide({ query: "why won't my sheep regrow wool?" })).toContain("Section: sheep");
  });

  test("explicit sections override inferred ones; canonical topics return an overview", () => {
    expect(lookupGuide({ query: "how to breed cows", section: "feeding" })).toContain("Section: feeding");
    expect(lookupGuide({ query: "husbandry" })).toContain("Section: overview");
    expect(lookupGuide({ query: "refined-storage" })).toContain("Section: overview");
    expect(lookupGuide({ query: "How to start refined storage" })).toContain("Section: overview");
    expect(lookupGuide({ query: "refined-storage", section: "power" })).toContain("Section: power");
    expect(lookupGuide({ query: "mekanism", section: "missing" })).toContain("Unknown section");
  });

  test("matching is token bounded and ambiguous species do not silently choose one", () => {
    expect(lookupGuide({ query: "cowardice" })).toContain("No curated match");
    expect(lookupGuide({ query: "breeding cows and sheep" })).toContain("Section: overview");
    expect(lookupGuide({ query: "How do I" })).not.toContain("Section:");
  });

  test("cross-topic questions offer reference choices instead of an unrelated book recipe", () => {
    const kb = books([{ book: "naturesaura:book", title: "Altar of Birthing", text: "Wool determines a summoned sheep's colour." }]);
    const choice = lookupGuide({ query: "wool for a bed" }, kb);
    expect(choice).toContain("husbandry, shelter");
    expect(choice).not.toContain("Altar of Birthing");
    expect(lookupGuide({ query: "how do I breed cows with wheat" }, kb)).toContain("Section: cows");
    expect(lookupGuide({ query: "wool for a bed", section: "books" }, kb)).toContain("Altar of Birthing");
  });

  test("settlement place questions reach their section without capturing home or machine topics", () => {
    expect(lookupGuide({ query: "how should we lay out the village?" })).toContain("Section: layout");
    expect(lookupGuide({ query: "settlement maintenance room" })).toContain("Section: layout");
    expect(lookupGuide({ query: "a path between our homes" })).toContain("Section: routes");
    expect(lookupGuide({ query: "where should I put signs" })).toContain("Section: names");
    expect(lookupGuide({ query: "invite Margo to visit my workshop" })).toContain("Section: visits");
    expect(lookupGuide({ query: "renovate a cramped workshop" })).toContain("Section: renovation");
    expect(lookupGuide({ query: "settlement" })).toContain("Section: overview");
    expect(lookupGuide({ query: "how do I build a house" })).toContain("query=shelter;");
    expect(lookupGuide({ query: "how to start mekanism" })).toContain("query=mekanism;");
  });

  test("all curated sections survive pagination with provenance and recoverable next handles", () => {
    let continuations = 0;
    for (const guide of referenceGuides) {
      for (const section of guide.sections) {
        const { responses, payloads } = readAll(guide.id, section.id);
        expect(whitespace(payloads.join(" "))).toBe(whitespace(section.paragraphs.join(" ")));
        for (const response of responses) {
          expect(response).toContain(section.source ?? guide.source);
          expect(response).toContain(guide.scope);
          expect(response).toContain(`query=${guide.id};`);
        }
        continuations += responses.length - 1;
      }
    }
    expect(continuations).toBeGreaterThan(0);
  });

  test("bad continuation handles do not silently restart at page one", () => {
    for (const section of ["overview:0", "overview:-1", "overview:1.5", "overview:NaN", "overview:9999999"]) {
      expect(lookupGuide({ query: "mekanism", section })).toContain("Invalid section handle");
    }
    expect(lookupGuide({ query: "mekanism", section: "overview:999999" })).toContain("No such page");
  });

  test("curated content needs neither the database nor a functioning book reader", () => {
    const unavailable = { searchGuides(): never { throw new Error("database unavailable"); } };
    expect(lookupGuide({ query: "breed cows" }, unavailable)).toContain("Section: cows");
    expect(lookupGuide({ query: "foliot" })).toContain("installed-book index unavailable");
    expect(lookupGuide({ query: "foliot" }, unavailable)).toContain("index could not be read");
  });
});

describe("installed-book fallback", () => {
  test("natural language searches real FTS after filler removal", () => {
    const knowledge = books([{ book: "occultism:dictionary", title: "Foliot ritual", text: "Summon a foliot with the prepared ritual." }]);
    expect(lookupGuide({ query: "How do I get a foliot ritual?" }, knowledge)).toContain("occultism:dictionary / Foliot ritual");
    expect(lookupGuide({ query: '"() OR * foliot' }, knowledge)).toContain("Foliot ritual");
  });

  test("relaxed retrieval ranks overlapping terms first without duplicating snippets", () => {
    const knowledge = books([
      { book: "occultism:dictionary", title: "Foliot ritual", text: "A foliot ritual needs preparation." },
      { book: "occultism:dictionary", title: "Ritual chalk", text: "Chalk draws a ritual circle." },
    ]);
    const { responses, payloads } = readAll("foliot ritual unfamiliar", "books", knowledge);
    expect(responses[0]).toContain("Source 1: occultism:dictionary / Foliot ritual");
    expect(responses).toHaveLength(2);
    expect(payloads.join(" ")).toContain("Chalk");
  });

  test("books remains an escape hatch for curated topic matches", () => {
    const knowledge = books([{ book: "immersiveengineering:manual", title: "Coke Oven", text: "The oven creates coke and creosote." }]);
    expect(lookupGuide({ query: "coke" }, knowledge)).toContain("query=immersive-engineering;");
    const response = lookupGuide({ query: "coke", section: "books" }, knowledge);
    expect(response).toContain("Installed-book excerpts");
    expect(response).toContain("immersiveengineering:manual / Coke Oven");
    expect(response).toContain("not full procedures");
  });

  test("book continuation keeps source identity and reports unavailable pages", () => {
    const knowledge = books(Array.from({ length: 4 }, (_, index) => ({
      book: "naturesaura:book", title: `Ancient tree ${index}`, text: `Ancient tree instruction ${index}.`,
    })));
    const { responses } = readAll("ancient tree", "books", knowledge);
    expect(responses).toHaveLength(4);
    for (const response of responses) expect(response).toContain("naturesaura:book / Ancient tree");
    expect(lookupGuide({ query: "ancient tree", section: "books:5" }, knowledge)).toContain("No such page");
  });
});
