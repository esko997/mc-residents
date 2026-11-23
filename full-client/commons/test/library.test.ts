import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLibrary } from "../src/library.ts";
import type { ObserverReach } from "../src/observer.ts";
import { bookContentHash, bookTextKey, type BookContent } from "../src/resident-contracts-library.ts";
import { residentHub } from "./resident-api-fixture.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const start = Date.UTC(2026, 10, 23, 12);
function hub(get?: (path: string) => ObserverReach) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(join(import.meta.dir, "../schema.sql"), "utf8"));
  let clock = start;
  const deps = { now: () => clock, observer: get ? { url: "http://bridge.test", tokenFile: "/dev/null" } : null, get: get && (async (_source: unknown, path: string) => get(path)) };
  return {
    db, as: (name: string) => createLibrary(db, name, deps),
    advance: (ms: number) => { clock += ms; },
  };
}
const overworld = "minecraft:overworld";
const shelf = { x: 100, y: 64, z: -200, dimension: overworld };
const notes: BookContent = { kind: "written", title: "Furnace notes", author: "Tobin", generation: 0,
  pages: [`Smelting iron: eight ore per coal. ${"Keep the fuel dry and the furnace lit. ".repeat(6)}`, "Charcoal comes from logs in a furnace."] };
const register = { book: notes, read_from: "inventory" as const, at: shelf, holder: "minecraft:chiseled_bookshelf" };

test("the content hash is the server bridge's resident-book-v1 framing, byte for byte", () => {
  // Computed independently with Java's DataOutputStream (the framing BookText.java documents).
  expect(bookContentHash({ kind: "written", title: "Field Notes", author: "Gary", generation: 0, pages: ["héllo wörld", "page two 😀"] }))
    .toBe("7e09823d06f807c069677ca809877b723526516a1295473f2bfae71bbe477963");
  expect(bookTextKey(notes)).toBe(bookTextKey({ ...notes, generation: 1 } as BookContent));
  expect(bookContentHash(notes)).not.toBe(bookContentHash({ ...notes, generation: 1 }));
});

test("register, find by text, subject and author, nearest first, with an excerpt but never the whole text", async () => {
  const { as } = hub();
  const tobin = as("Tobin");
  expect(await tobin.register({ ...register, subjects: ["smelting"] })).toContain('Catalogued #1 "Furnace notes" by Tobin, 2 pages at 100,64,-200 minecraft:overworld, minecraft:chiseled_bookshelf');
  await tobin.register({ book: { ...notes, title: "Wheat", pages: ["Wheat needs water within four blocks."] }, read_from: "lectern", at: { ...shelf, x: 300 } });
  const piper = as("Piper");
  const found = await piper.find({ query: "charcoal", near: { x: 90, y: 64, z: -200, dimension: overworld } });
  expect(found).toContain("#1 \"Furnace notes\"");
  expect(found).toContain("10 blocks east of you");
  expect(found).toContain('"…');
  expect(found).toContain("Charcoal comes from logs");
  expect(found).not.toContain("#2");
  expect(await piper.find({ subject: "smelt" })).toContain("#1");
  expect(await piper.find({ author: "tobin", near: { x: 290, y: 64, z: -200, dimension: overworld } })).toMatch(/#2[\s\S]*#1/);
  expect(await piper.find({ query: "obsidian" })).toContain("No catalogued book matches \"obsidian\". The catalogue lists 2 books");
  const one = await piper.find({ id: 1 });
  expect(one).toContain("Opening: \"Smelting iron");
  expect(one).not.toContain("Charcoal comes from logs");
});

test("copies: the same text twice in one place needs another_copy; other generations group as one text", async () => {
  const { as } = hub();
  const tobin = as("Tobin");
  await tobin.register(register);
  await expect(tobin.register(register)).rejects.toThrow("Already catalogued as #1 at this place");
  expect(await tobin.register({ ...register, another_copy: true })).toContain("Copies of the same text: #1");
  await tobin.register({ ...register, book: { ...notes, generation: 1 }, at: { ...shelf, x: 140 } });
  const found = await as("Piper").find({ query: "furnace" });
  expect(found).toContain("1 catalogued text matches");
  expect(found).toMatch(/also: #\d at [\s\S]*; #\d at /);
  expect(await as("Piper").find({ id: 3 })).toContain("copy of original");
});

test("moves and missing books are dated reports; only the registrant edits or withdraws", async () => {
  const { as, advance, db } = hub();
  await as("Tobin").register(register);
  advance(60_000);
  const piper = as("Piper");
  expect(await piper.report({ id: 1, kind: "missing" })).toContain("you did not find #1");
  await expect(piper.report({ id: 1, kind: "found", at: { ...shelf, z: -150 }, checked: { content_hash: "0".repeat(64), read_from: "inventory" } })).rejects.toThrow("not #1");
  advance(60_000);
  expect(await piper.report({ id: 1, kind: "found", at: { ...shelf, z: -150 }, holder: "minecraft:lectern", checked: { content_hash: bookContentHash(notes), read_from: "lectern" } }))
    .toContain("now listed at 100,64,-150 minecraft:overworld, minecraft:lectern (found there by you, text checked (lectern))");
  const detail = await piper.find({ id: 1 });
  expect(detail).toContain("found there by Piper, text checked (lectern)");
  expect(detail).toMatch(/moved by Piper at 100,64,-150: from 100,64,-200[\s\S]*missing by Piper/);
  expect(() => piper.update({ id: 1, withdraw: true })).toThrow("Only Tobin");
  expect(as("Tobin").update({ id: 1, subjects: ["iron"], withdraw: true })).toContain("Withdrew #1");
  expect(await piper.find({ query: "furnace" })).toContain("No catalogued book matches");
  expect(db.query("SELECT status FROM library_books").get()).toEqual({ status: "withdrawn" });
  await expect(piper.report({ id: 1, kind: "missing" })).rejects.toThrow("withdrawn");
});

test("a registered library shelf read by the server confirms or fails to confirm a copy; an unread shelf changes nothing", async () => {
  const snapshot = (facilities: unknown[]): ObserverReach => ({ ok: true, receivedAt: start, data: {
    schema: 1, source: "server-observer", state: "ok", servedAtMs: start, snapshot: { seq: 1, builtAtMs: start, gameTime: 1, residents: [], facilities } } });
  let shelfStatus = "observed", slots: unknown[] = [];
  const get = (path: string): ObserverReach => {
    if (path === "/v1/snapshot") return snapshot([{ id: "facility-9", label: "Library shelf", dimension: overworld, pos: [100, 64, -200], side: null, status: "unsupported", detail: null, checkedAtMs: start, gameTime: 1 }]);
    if (path.startsWith("/v1/library/shelf?facility=facility-9")) return { ok: true, receivedAt: start, data: { schema: 1, source: "server-observer", state: "ok", servedAtMs: start, shelf: { facility: "facility-9", status: shelfStatus, reason: shelfStatus === "observed" ? null : "chunk not loaded", slots } } };
    return { ok: false, status: "error", detail: "unexpected", httpStatus: 404 };
  };
  const { as, advance } = hub(get);
  const tobin = as("Tobin");
  slots = [{ slot: 3, kind: "written", title: notes.title, author: notes.author, generation: 0, pageCount: 2, contentHash: bookContentHash(notes) }];
  expect(await tobin.register(register)).toContain("[server] seen on that shelf in slot 3 just now");
  await tobin.register({ ...register, another_copy: true });
  advance(5 * 60_000);
  const both = await tobin.find({ id: 2 });
  expect(both).toContain("[server] NOT on that shelf");
  expect(await tobin.find({ id: 1 })).toContain("seen on that shelf in slot 3");
  shelfStatus = "unloaded";
  advance(5 * 60_000);
  const unread = await tobin.find({ id: 1 });
  expect(unread).toContain("could not read the shelf at 100,64,-200 (unloaded: chunk not loaded); nothing recorded");
  expect(unread).toContain("seen on that shelf in slot 3 10 min ago");
  // A book listed anywhere else is never checked against that shelf.
  await tobin.register({ ...register, at: { ...shelf, x: 101 } });
  expect(await tobin.find({ id: 3 })).not.toContain("[server]");
});

test("over HTTP: a whole book fits the larger body bound; caretakers may search but not register; records are residents' only", async () => {
  const hub = residentHub();
  try {
    const tobin = hub.identity("Tobin").client, caretaker = hub.identity("caretaker", "caretaker").client;
    const long: BookContent = { ...notes, pages: Array.from({ length: 100 }, (_, i) => `${i} ${"word ".repeat(200)}`) };
    expect(await tobin.call("library", "register", { ...register, book: long })).toContain("100 pages");
    expect(await caretaker.call("library", "find", { query: "word" })).toContain("#1");
    await expect(caretaker.call("library", "register", register)).rejects.toThrow("read-only");
    await expect(caretaker.call("records", "query", { kind: "summary" })).rejects.toThrow("read-only");
    expect(await tobin.call("records", "query", { kind: "books" })).toContain("Tobin catalogued book #1");
    await expect(tobin.call("library", "register", { ...register, book: { ...notes, kind: "writable" } })).rejects.toThrow("Invalid request arguments");
  } finally { hub.close(); }
});
