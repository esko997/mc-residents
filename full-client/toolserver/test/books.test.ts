import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, type FakeOptions } from "./fake-synapse.ts";
import { schemaFile, sharedHttp } from "./shared-http.ts";
import type { Stack } from "../src/synapse.ts";
import { when } from "../src/books.ts";

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

test("read_book reads whole pages from hand or lectern, continues long books, and explains a chiseled bookshelf", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => `${"x".repeat(380)} end of page ${i + 1}`);
  const f = await body([written(0)], { books: { 0: { kind: "written", title: "Long", author: "Tobin", generation: 1, pages } } });
  const first = text(await f.tools.call("read_book", {}));
  expect(first).toContain('"Long" by Tobin (copy of original), 5 pages; from H0.');
  expect(first).toContain("end of page 2");
  expect(first).not.toContain("end of page 3");
  expect(first).toContain("Continue: read_book {from: 0, page: 3}");
  expect(text(await f.tools.call("read_book", { from: 0, page: 5 }))).toContain("— page 5 —");
  const lectern = await body([], { lectern: { kind: "written", title: "Rules", author: "Wren", generation: 0, pages: ["Shut the gate."] } });
  lectern.setScreen({ screen: "LecternScreen" });
  expect(text(await lectern.tools.call("read_book", {}))).toContain('"Rules" by Wren (original), 1 page; from the lectern, open at page 1.\n— page 1 —\nShut the gate.');
  const shelf = await body([]);
  shelf.state.lookingAt = { type: "block", block: "minecraft:chiseled_bookshelf", blockPos: [5, 64, 5] };
  expect(text(await shelf.tools.call("read_book", {}))).toContain("cannot be read in place: use the shelf where the book stands");
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
    const next = /Continue: read_book \{from: 4, page: (\d+)(?:, part: (\d+))?\}/.exec(reply);
    if (!next) break;
    args = { from: 4, page: Number(next[1]), ...(next[2] ? { part: Number(next[2]) } : {}) };
  }
  expect(replies[0]).toMatch(/— page 1, part 1 of \d+ —/);
  for (const reply of replies) expect(reply.length).toBeLessThan(1499);
  expect(replies.at(-1)).toContain("short tail");
  const parts = replies.slice(0, -1).map(reply => reply.split(/— page 1, part \d+ of \d+ —\n/)[1]!.split("\n\nSince last time")[0]!);
  expect(parts.join("")).toBe(long);
});

test("the catalogue through the body: text read from the item, place from the sights, reports by a neighbour", async () => {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(readFileSync(schemaFile, "utf8"));
  const hub = sharedHttp(db); hubs.push(hub);
  const tobin = await body([written(0), quill(1)], { name: "Tobin", ...hub.identity("Tobin"), books: { 0: { kind: "written", title: "The Mill", author: "Tobin", generation: 0, pages: [story] } } });
  expect(text(await tobin.tools.call("book_register", {}))).toContain("Look at the shelf, lectern or chest");
  tobin.state.lookingAt = { type: "block", block: "minecraft:chiseled_bookshelf", blockPos: [100, 64, -200] };
  expect(text(await tobin.tools.call("book_register", { subjects: ["mill"] }))).toContain('Catalogued #1 "The Mill" by Tobin, 1 page at 100,64,-200 minecraft:overworld, minecraft:chiseled_bookshelf.');
  expect(text(await tobin.tools.call("book_register", { from: 1 }))).toContain("a book and quill, not yet signed");
  const piper = await body([written(3)], { name: "Piper", ...hub.identity("Piper"), books: { 3: { kind: "written", title: "The Mill", author: "Tobin", generation: 0, pages: [story] } } });
  piper.state.pos = { x: 100, y: 64, z: -180 };
  const found = text(await piper.tools.call("book_find", { query: "flour" }));
  expect(found).toContain("20 blocks north of you");
  expect(found).toContain("flour");
  piper.state.lookingAt = { type: "block", block: "minecraft:lectern", blockPos: [90, 64, -190] };
  expect(text(await piper.tools.call("book_report", { id: 1, found: true, check: 3 }))).toContain("now listed at 90,64,-190 minecraft:overworld, minecraft:lectern (found there by you, text checked (inventory))");
  expect(text(await piper.tools.call("book_update", { id: 1, withdraw: true }))).toContain("Only Tobin");
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
