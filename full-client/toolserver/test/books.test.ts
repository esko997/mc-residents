import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, type FakeOptions } from "./fake-synapse.ts";
import { schemaFile, sharedHttp } from "./shared-http.ts";
import type { Stack } from "../src/synapse.ts";
import { when } from "../src/books.ts";
import { LibraryScan } from "../../commons/src/library-scan.ts";
import { fakeBridge, LECTERN, OVERWORLD, SHELF, written as bookOf } from "../../commons/test/fake-bridge.ts";

const hubs: { close(): void }[] = [];
const databases: Database[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.close(); for (const db of databases.splice(0)) db.close(); });
const quill = (slot: number): Stack => ({ slot, item: "minecraft:writable_book", count: 1 });
const written = (slot: number): Stack => ({ slot, item: "minecraft:written_book", count: 1 });
/** The body, with these stacks in its inventory (0..8 are the hotbar). */
async function body(stacks: Stack[], options: FakeOptions = {}) {
  const f = await fixture({ pageChars: 40, ...options });
  f.state.inventory!.main = stacks.map(stack => ({ ...stack }));
  f.state.hotbar = f.state.inventory!.main.filter(stack => stack.slot < 9);
  f.tools.books.writeWaitMs = 600;
  return f;
}
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(part => part.text ?? "").join("\n");
const story = "The mill stands where the river bends. Wheat goes in at the top door and flour comes out below. Ask Margo first.";

test("write_book lays text out as the editor does, signs it in hand, says where it is, and puts the old slot back", async () => {
  const f = await body([{ slot: 0, item: "minecraft:bread", count: 3 }, quill(12)]);
  const reply = text(await f.tools.call("write_book", { title: "The Mill", text: story }));
  expect(reply).toContain('Signed "The Mill" by Gary: 3 pages, ');
  expect(reply).toContain('Pages: 1 "The mill stands where the r…", 2 "Wheat goes in at the top do…"');
  expect(reply).toContain("now a written book in H1 (moved there from inventory slot 12)");
  expect(f.options.books?.[1]?.pages).toEqual(["The mill stands where the river bends.", "Wheat goes in at the top door and flour", "comes out below. Ask Margo first."]);
  expect(f.state.selectedSlot).toBe(0);
  expect(f.requests.filter(r => r.path === "/book" && r.body.action === "sign")).toHaveLength(1);
});

test("write_book refuses plainly: no book and quill, a screen, a draft it would overwrite, a long text, an old Synapse", async () => {
  expect(text(await (await body([written(0)])).tools.call("write_book", { title: "X", text: "hi" }))).toContain("No book and quill in your inventory");
  const screen = await body([quill(0)]);
  screen.setScreen({ screen: "ChestScreen" });
  expect(text(await screen.tools.call("write_book", { title: "X", text: "hi" }))).toContain("ChestScreen is open; close it first");
  const draft = await body([quill(0)], { books: { 0: { kind: "writable", pages: ["My own plans"] } } });
  expect(text(await draft.tools.call("write_book", { title: "X", text: "hi" }))).toContain('H0 (1 page, begins "My own plans")');
  expect(draft.options.books?.[0]?.pages).toEqual(["My own plans"]);
  expect(text(await draft.tools.call("write_book", { title: "X", text: "hi", replace: true }))).toContain('Signed "X"');
  expect(text(await (await body([quill(0)])).tools.call("write_book", { title: "Sixteen letters!", text: "hi" }))).toContain("at most 15 characters");
  const long = await body([quill(0)], { pageChars: 5 });
  expect(text(await long.tools.call("write_book", { title: "Epic", text: "word ".repeat(200) }))).toContain("Too long for one book: it fills all 100 pages and more");
  expect(long.requests.some(r => r.body.action === "sign")).toBe(false);
  expect(text(await (await body([quill(0)], { bookEndpoint: false })).tools.call("write_book", { title: "X", text: "hi" }))).toContain("no /book endpoint");
  const silent = await body([quill(0)], { signWorks: false });
  expect(text(await silent.tools.call("write_book", { title: "X", text: "hi" }))).toContain("does not show a written book");
});

test("write_book with draft keeps a book and quill unsigned", async () => {
  const f = await body([quill(0)]);
  expect(text(await f.tools.call("write_book", { pages: ["one", "two"], draft: true }))).toContain("Saved 2 pages (6 characters) in the book and quill in H0; it is not signed");
  expect(f.options.books?.[0]).toEqual({ kind: "writable", pages: ["one", "two"] });
});

test("read_book reads whole pages from hand or lectern, and continues long books", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => `${"x".repeat(380)} end of page ${i + 1}`);
  const f = await body([written(0)], { books: { 0: { kind: "written", title: "Long", author: "Tobin", generation: 1, pages } } });
  const first = text(await f.tools.call("read_book", {}));
  expect(first).toContain('"Long" by Tobin (copy of original), 5 pages; from H0.');
  expect(first).toContain("end of page 3");
  expect(first).not.toContain("end of page 4");
  expect(first).toContain("Continue: read_book {from: 0, page: 4}");
  expect(text(await f.tools.call("read_book", { from: 0, page: 5 }))).toContain("— page 5 —");
  const lectern = await body([], { lectern: { kind: "written", title: "Rules", author: "Wren", generation: 0, pages: ["Shut the gate."] } });
  lectern.setScreen({ screen: "LecternScreen" });
  expect(text(await lectern.tools.call("read_book", {}))).toContain('"Rules" by Wren (original), 1 page; from the lectern, open at page 1.\n— page 1 —\nShut the gate.');
  const empty = await body([]);
  expect(text(await empty.tools.call("read_book", {}))).toContain("You carry no written book or book and quill, and no lectern is open.");
});

test("read_book reads a page longer than one reply in parts, each bounded, with a handle to the next", async () => {
  // Written by a command, not the editor: a page can hold 32,767 characters.
  const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ").padEnd(5000, " x");
  const f = await body([written(4)], { books: { 4: { kind: "written", title: "Ledger", author: "Server", generation: 0, pages: [long, "short tail"] } } });
  const replies: string[] = [];
  let args: Record<string, unknown> = { from: 4 };
  for (let guard = 0; guard < 12; guard++) {
    const reply = text(await f.tools.call("read_book", args));
    replies.push(reply);
    const next = /Continue: read_book \{from: 4, page: (\d+)(?:, at: (\d+))?\}/.exec(reply);
    if (!next) break;
    args = { from: 4, page: Number(next[1]), ...(next[2] ? { at: Number(next[2]) } : {}) };
  }
  expect(replies[0]).toMatch(/— page 1, characters 1-\d+ of 5000 —/);
  for (const reply of replies) expect(reply.length).toBeLessThan(1499);
  expect(replies.at(-1)).toContain("short tail");
  const parts = replies.slice(0, -1).map(reply => reply.split(/— page 1, characters \d+-\d+ of \d+ —\n/)[1]!.split("\n\nSince last time")[0]!);
  expect(parts.join("")).toBe(long);
});

test("read_book loses no text when a full event tail shares the reply: following the handles rebuilds the book", async () => {
  // Pages as the editor holds them (about 260 characters) and one long page written by a command.
  const pages = [...Array.from({ length: 9 }, (_, i) => `${i + 1}: ${"river mill wheel flour ".repeat(11)}`.trim()), "z".repeat(3000), "the end"];
  const f = await body([written(0)], { books: { 0: { kind: "written", title: "Ledger", author: "Server", generation: 0, pages } } });
  const read: Record<number, string> = {};
  let args: Record<string, unknown> = { from: 0 };
  for (let guard = 0; guard < 60; guard++) {
    // Before every call: more news than the tail can hold (eight long chat lines).
    for (let i = 0; i < 12; i++) f.body.events.add("chat", { text: `<Piper> ${"so much to say about the weather today ".repeat(7)}${guard}.${i}` });
    const reply = text(await f.tools.call("read_book", args));
    expect(reply.length).toBeLessThanOrEqual(1499);
    expect(reply).not.toContain("remaining output omitted");
    expect(reply).toContain("Since last time:");
    const body = reply.split("\n\nSince last time:")[0]!;
    for (const [, page, from, content] of body.matchAll(/— page (\d+)(?:, characters (\d+)-\d+ of \d+)? —\n([\s\S]*?)(?=\n— page |$)/g)) {
      // A piece must start exactly where the text read so far ends: nothing skipped, nothing repeated.
      if (from) expect(Number(from) - 1).toBe((read[Number(page)] ?? "").length);
      read[Number(page)] = (from && Number(from) > 1 ? read[Number(page)] ?? "" : "") + content;
    }
    const next = /Continue: read_book \{from: 0, page: (\d+)(?:, at: (\d+))?\}/.exec(body);
    if (!next) break;
    args = { from: 0, page: Number(next[1]), ...(next[2] ? { at: Number(next[2]) } : {}) };
  }
  expect(Object.keys(read).map(Number)).toEqual(pages.map((_, i) => i + 1));
  pages.forEach((page, i) => expect(read[i + 1]).toBe(page));
});

test("use says where a book taken from a chiseled bookshelf went when the hand stays empty", async () => {
  // Live on 2026-11-23: the book went to H0 while H1 was selected, and use said nothing changed.
  const f = await body([written(2)], { onUse: state => { state.inventory!.main.push(written(0)); state.hotbar = state.inventory!.main.filter(stack => stack.slot < 9); } });
  f.state.selectedSlot = 1;
  f.state.lookingAt = { type: "block", block: "minecraft:chiseled_bookshelf", blockPos: [5, 64, 5] };
  expect(text(await f.tools.call("use", {}))).toContain("no screen opened. H0 now holds 1 x minecraft:written_book.");
  const hand = await body([], { onUse: state => { state.inventory!.main.push(written(0)); state.hotbar = state.inventory!.main.filter(stack => stack.slot < 9); } });
  hand.state.lookingAt = { type: "block", block: "minecraft:chiseled_bookshelf", blockPos: [5, 64, 5] };
  expect(text(await hand.tools.call("use", {}))).toContain("no screen opened. Your hand now holds 1 x minecraft:written_book.");
});

/** A hub over HTTP whose library sees a fake server bridge, a scan to fill the catalogue, and a resident body near or far. */
async function library(pages: string[]) {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(readFileSync(schemaFile, "utf8"));
  const bridge = fakeBridge(Date.now);
  bridge.put(OVERWORLD, 100, 64, -200, { block: SHELF, slots: [null, null, bookOf("Ledger", "Tobin", pages)] });
  bridge.put(OVERWORLD, 300, 64, -200, { block: LECTERN, slots: [bookOf("Mill rules", "Margo", ["Shut the gate."])] });
  await new LibraryScan(db, bridge.source, { get: bridge.get, log: () => {} }).pass();
  const hub = sharedHttp(db, { observer: bridge.source, get: bridge.get }); hubs.push(hub);
  const piper = await body([], { name: "Piper", ...hub.identity("Piper") });
  piper.state.pos = { x: 101, y: 64, z: -198 };
  piper.state.lookingAt = { type: "block", block: SHELF, blockPos: [100, 64, -200] };
  bridge.world.bodies.set("Piper", { x: 101, y: 64, z: -198 });
  return { db, bridge, piper, hub };
}

test("read_book reads a book where it stands: from the shelf in the sights, by id, and says where to go when too far", async () => {
  const { bridge, piper } = await library(["The wheel turns.", "Flour below."]);
  // Nothing in hand, a chiseled bookshelf in the sights: its one book is read in place.
  const inSights = text(await piper.tools.call("read_book", {}));
  expect(inSights).toContain('"Ledger" by Tobin (original), 2 pages, catalogue #1; on slot 2 of the chiseled bookshelf at 100,64,-200, 2 blocks from you.\n— page 1 —\nThe wheel turns.\n— page 2 —\nFlour below.');
  expect(text(await piper.tools.call("read_book", { id: 2 })))
    .toContain('#2 "Mill rules" by Margo (original), 1 page is not within 4 blocks of you. Nearest copy: the lectern at 300,64,-200, 200 blocks east of you; seen there by the server just now. Go there and read_book {id: 2} again.');
  bridge.world.bodies.set("Piper", { x: 299, y: 64, z: -199 });
  expect(text(await piper.tools.call("read_book", { id: 2 }))).toContain('"Mill rules" by Margo (original), 1 page, catalogue #2; on the lectern at 300,64,-200, 2 blocks from you.\n— page 1 —\nShut the gate.');
  // The body's own client says it stands at the shelf; the server does not see it online: nothing is read.
  bridge.world.bodies.set("Piper", { x: 101, y: 64, z: -198, online: false });
  expect(text(await piper.tools.call("read_book", { shelf: "sights", slot: 2 }))).toContain("The server does not see you online, so it cannot tell where you stand; nothing was read.");
  piper.state.lookingAt = { type: "block", block: "minecraft:chest", blockPos: [99, 64, -200] };
  expect(text(await piper.tools.call("read_book", { shelf: "sights" }))).toContain("No chiseled bookshelf or lectern in your sights (you look at minecraft:chest)");
  expect(text(await piper.tools.call("read_book", { id: 1, from: 0 }))).toContain("Give at most one of from, id and shelf.");
});

test("a long book read at its shelf pages exactly with the event tail: following the handles rebuilds it", async () => {
  const pages = [...Array.from({ length: 6 }, (_, i) => `${i + 1}: ${"river mill wheel flour ".repeat(11)}`.trim()), "z".repeat(3000), "the end"];
  const { piper } = await library(pages);
  const read: Record<number, string> = {};
  let args: Record<string, unknown> = { id: 1 };
  for (let guard = 0; guard < 60; guard++) {
    for (let i = 0; i < 12; i++) piper.body.events.add("chat", { text: `<Margo> ${"so much to say about the weather today ".repeat(7)}${guard}.${i}` });
    const reply = text(await piper.tools.call("read_book", args));
    expect(reply.length).toBeLessThanOrEqual(1499);
    expect(reply).not.toContain("remaining output omitted");
    const content = reply.split("\n\nSince last time:")[0]!;
    for (const [, page, from, piece] of content.matchAll(/— page (\d+)(?:, characters (\d+)-\d+ of \d+)? —\n([\s\S]*?)(?=\n— page |$)/g)) {
      if (from) expect(Number(from) - 1).toBe((read[Number(page)] ?? "").length);
      read[Number(page)] = (from && Number(from) > 1 ? read[Number(page)] ?? "" : "") + piece;
    }
    const next = /Continue: read_book \{shelf: \{x: 100, y: 64, z: -200\}, slot: 2, page: (\d+)(?:, at: (\d+))?\}/.exec(content);
    if (!next) break;
    args = { shelf: { x: 100, y: 64, z: -200 }, slot: 2, page: Number(next[1]), ...(next[2] ? { at: Number(next[2]) } : {}) };
  }
  expect(Object.keys(read).map(Number)).toEqual(pages.map((_, i) => i + 1));
  pages.forEach((page, i) => expect(read[i + 1]).toBe(page));
});

test("the catalogue through the body: books on shelves are in it by themselves; a description and a chest report are residents' word", async () => {
  const { piper, hub } = await library(["The wheel turns.", "Flour below."]);
  piper.state.pos = { x: 100, y: 64, z: -180 };
  const found = text(await piper.tools.call("book_find", { query: "flour" }));
  expect(found).toContain("at the chiseled bookshelf at 100,64,-200 (slot 2); 20 blocks north of you; seen there by the server");
  expect(found).toContain("To read one, stand within 4 blocks of a copy and use read_book {id}");
  const tobin = await body([written(0), quill(1)], { name: "Tobin", ...hub.identity("Tobin"), books: { 0: { kind: "written", title: "Ledger", author: "Tobin", generation: 0, pages: ["The wheel turns.", "Flour below."] } } });
  expect(text(await tobin.tools.call("book_register", {}))).toContain("Look at the shelf, lectern or chest");
  tobin.state.lookingAt = { type: "block", block: "minecraft:chest", blockPos: [90, 64, -190] };
  expect(text(await tobin.tools.call("book_register", { subjects: ["mill"] })))
    .toContain('Catalogued #1 "Ledger" by Tobin (original), 2 pages; subjects: mill.\nListed at 90,64,-190, chest on your word.');
  expect(text(await tobin.tools.call("book_register", { from: 1 }))).toContain("a book and quill, not yet signed");
  expect(text(await piper.tools.call("book_find", { id: 1 }))).toMatch(/the chest at 90,64,-190; 14 blocks north-west of you; Tobin said it is there just now \(their word\)/);
  piper.state.lookingAt = { type: "block", block: "minecraft:chest", blockPos: [90, 64, -190] };
  expect(text(await piper.tools.call("book_report", { id: 1, missing: true }))).toContain('Recorded: #1 "Ledger" by Tobin is no longer listed at 90,64,-190 (your report).');
  expect(text(await piper.tools.call("book_update", { id: 1, note: "mine" }))).toContain("Only Tobin");
});

test("records: windows in words, the unseen spectator left out, and one's own finished projects", async () => {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(readFileSync(schemaFile, "utf8"));
  const now = Date.UTC(2026, 10, 23, 12);
  db.query("INSERT INTO history_server_events (at, seq, type, resident, detail) VALUES (?, 1, 'resident_died', 'Gary', 'minecraft:overworld')").run(now - 3 * 3_600_000);
  const hub = sharedHttp(db, { now: () => now }); hubs.push(hub);
  const f = await body([], { name: "Tobin", ...hub.identity("Tobin") });
  f.tools.books.now = () => now;
  expect(text(await f.tools.call("records", { kind: "deaths", since: "2h" }))).toContain("Nothing recorded in this window.");
  expect(text(await f.tools.call("records", { kind: "deaths", since: "2026-11-23 08:00" }))).toContain("09:00 UTC Gary died in minecraft:overworld [server]");
  writeFileSync(join(f.dir, "plan.json"), JSON.stringify({ plans: [], history: [{ name: "Library shelf", goal: "g", steps: [{ text: "s", state: "done" }], created: 0, moved: 0, ended: now - 3_600_000, outcome: "done", evidence: "Six books on the shelf at the mill" }] }));
  expect(text(await f.tools.call("records", { kind: "projects" }))).toContain('project "Library shelf" done: Six books on the shelf at the mill [your own plan record; your word]');
  expect(when("2026-11-23", now, "since")).toBe(Date.UTC(2026, 10, 23));
  expect(() => when("yesterday-ish", now, "since")).toThrow("neither a span");
});
