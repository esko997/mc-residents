import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCommons } from "../src/db.ts";
import { createLibrary, type LibraryDeps } from "../src/library.ts";
import { LibraryScan } from "../src/library-scan.ts";
import { bookContentHash, bookTextKey, type BookContent, type ShelfReading } from "../src/resident-contracts-library.ts";
import { fakeBridge, LECTERN, NETHER, OVERWORLD, quill, SHELF, written } from "./fake-bridge.ts";
import { residentHub } from "./resident-api-fixture.ts";

const databases: Database[] = [], dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const start = Date.UTC(2026, 10, 23, 12), minute = 60_000;
const schema = join(import.meta.dir, "../schema.sql");

/** A hub database, a fake bridge on the same clock, the library as any resident, and one scan pass. */
function hub(options: { maxPages?: number; rereads?: number; unseen?: string[]; bridge?: boolean } = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(schema, "utf8"));
  let clock = start;
  const bridge = fakeBridge(() => clock);
  const deps: LibraryDeps = { now: () => clock, observer: options.bridge === false ? null : bridge.source, get: bridge.get, unseen: options.unseen };
  const scan = new LibraryScan(db, bridge.source, { now: () => clock, get: bridge.get, maxPages: options.maxPages, rereads: options.rereads, scanWaitMs: 0, log: () => {} });
  return {
    db, bridge, world: bridge.world, scan,
    as: (name: string) => createLibrary(db, name, deps),
    advance: (ms: number) => { clock += ms; },
    copies: () => db.query<{ book_id: number; x: number; y: number; z: number; slot: number | null; state: string; source: string }, []>(
      "SELECT book_id, x, y, z, slot, state, source FROM library_copies ORDER BY id").all(),
  };
}
const text = (reading: ShelfReading) => "text" in reading ? reading.text : `PAGES ${reading.where}: ${reading.pages.join(" | ")}`;

const furnace = written("Furnace notes", "Tobin", [`Smelting iron: eight ore per coal. ${"Keep the fuel dry and the furnace lit. ".repeat(6)}`, "Charcoal comes from logs in a furnace."]);
const wheat = written("Wheat", "Margo", ["Wheat needs water within four blocks."]);

test("the content hash is the server bridge's resident-book-v1 framing, byte for byte", () => {
  // Computed independently with Java's DataOutputStream (the framing BookText.java documents).
  expect(bookContentHash({ kind: "written", title: "Field Notes", author: "Gary", generation: 0, pages: ["héllo wörld", "page two 😀"] }))
    .toBe("7e09823d06f807c069677ca809877b723526516a1295473f2bfae71bbe477963");
  const copy = { ...furnace, generation: 1 };
  expect(bookTextKey(furnace)).toBe(bookTextKey(copy));
  expect(bookContentHash(furnace)).not.toBe(bookContentHash({ ...furnace, generation: 1 }));
  expect(bookContentHash(quill(["a"]))).not.toBe(bookContentHash(quill(["b"])));
});

test("every book on a shelf or lectern enters the catalogue by itself; pages are read once per content hash", async () => {
  const { bridge, world, scan, as } = hub();
  bridge.put(OVERWORLD, 100, 64, -200, { block: SHELF, slots: [null, null, null, furnace, null, { kind: "enchanted" }] });
  bridge.put(OVERWORLD, 140, 64, -200, { block: SHELF, slots: [furnace, wheat] });
  bridge.put(NETHER, 5, 70, 9, { block: LECTERN, slots: [wheat] });
  await scan.pass();
  expect(scan.health()).toMatchObject({ status: "ok", last: { shelves: 3, confirmed: 4, texts: 2 } });
  const reads = () => world.requests.filter(path => path.startsWith("/v1/library/book")).length;
  expect(reads()).toBe(2);
  await scan.pass();
  expect(reads()).toBe(2);
  const piper = as("Piper");
  const found = piper.find({ query: "charcoal", near: { x: 90, y: 64, z: -200, dimension: OVERWORLD } });
  expect(found).toContain('#1 "Furnace notes" by Tobin (original), 2 pages');
  expect(found).toContain("at the chiseled bookshelf at 100,64,-200 (slot 3); 10 blocks east of you; seen there by the server just now");
  expect(found).toContain("also: #1 at 140,64,-200; 50 blocks east of you");
  expect(found).toContain("Charcoal comes from logs");
  expect(found).not.toContain("Wheat needs water");
  expect(piper.find({ query: "water" })).toContain("at the chiseled bookshelf at 140,64,-200 (slot 1); seen there by the server just now\n  also: #2 at 5,70,9 minecraft:the_nether\n");
  expect(piper.find({ query: "obsidian" })).toContain("No catalogued book matches \"obsidian\". The catalogue holds 2 books: every book the server has seen on a chiseled bookshelf or lectern");
});

test("a lectern's only book taken: the read of that lectern marks it gone; book_find says so, unlike an unknown place", async () => {
  const { bridge, world, scan, as, copies } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: LECTERN, slots: [wheat] });
  await scan.pass();
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [];
  await scan.pass();
  expect(copies()).toEqual([{ book_id: 1, x: 10, y: 64, z: 10, slot: 0, state: "gone", source: "server" }]);
  const found = as("Piper").find({ query: "wheat" });
  expect(found).toContain("no copy known to stand anywhere now; the last was at the lectern at 10,64,10, not there since 2026-11-23 12:00 UTC: the server saw the lectern without it");
  expect(as("Piper").find({ id: 1 })).toMatch(/\[server\] not there at 10,64,10 slot 0: the lectern was read without it\n.*\[server\] seen at 10,64,10 slot 0: on the lectern/);
});

test("a shelf holding books is broken: every copy listed there is gone, and the reply says the shelf is gone", async () => {
  const { bridge, world, scan, as, copies } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat, furnace] });
  await scan.pass();
  world.shelves.delete(bridge.key(OVERWORLD, 10, 64, 10));
  world.blocks.set(bridge.key(OVERWORLD, 10, 64, 10), "minecraft:oak_planks");
  await scan.pass();
  expect(copies().map(copy => copy.state)).toEqual(["gone", "gone"]);
  expect(as("Piper").find({ id: 2 })).toContain("its chiseled bookshelf is gone (minecraft:oak_planks is there now)");
});

test("an emptied shelf that still stands: its copies are gone, the shelf is not", async () => {
  const { bridge, world, scan, as } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat, furnace] });
  await scan.pass();
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [];
  await scan.pass();
  const one = as("Piper").find({ id: 1 });
  expect(one).toContain("No copy is known to stand anywhere now.");
  expect(one).toContain("the server saw the chiseled bookshelf without it");
});

test("an unloaded position is unknown, not gone: nothing changes, and book_find says the server cannot look", async () => {
  const { bridge, world, scan, as, advance, copies } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat] });
  await scan.pass();
  world.unloaded.add(bridge.key(OVERWORLD, 10, 64, 10));
  advance(3 * 60 * minute);
  await scan.pass();
  await scan.pass();
  expect(copies()).toEqual([{ book_id: 1, x: 10, y: 64, z: 10, slot: 0, state: "here", source: "server" }]);
  expect(as("Piper").find({ query: "wheat" })).toContain("seen there by the server 3 h ago; it could not look since (its chunk is not loaded), so that is the latest known");
  expect(world.requests.filter(path => path.startsWith("/v1/library/shelf?")).length).toBe(2);
});

test("a discovery list cut short or only partly paged marks nothing missing", async () => {
  const { db, bridge, world, scan, copies } = hub({ maxPages: 1, rereads: 0 });
  for (let i = 0; i < 250; i++) bridge.put(OVERWORLD, i, 64, 0, { block: SHELF, slots: [written(`Book ${i}`, "Tobin", [`page ${i}`])] });
  await scan.pass(); // the first 200
  await scan.pass(); // the last 50, from the cursor
  expect(copies().filter(copy => copy.state === "here")).toHaveLength(250);
  world.cutAfter = 10;
  await scan.pass();
  await scan.pass();
  expect(copies().filter(copy => copy.state === "here")).toHaveLength(250);
  // With re-reads on, the positions the cut list left out are read one by one: still there, still here.
  const reread = new LibraryScan(db, bridge.source, { now: () => start, get: bridge.get, rereads: 8, log: () => {} });
  await reread.pass();
  expect(reread.health().last).toMatchObject({ reread: 8 });
  expect(copies().filter(copy => copy.state === "here")).toHaveLength(250);
});

test("a shelf the bridge cannot list completely is unknown, not empty; a list still being scanned is asked again", async () => {
  const { bridge, world, scan, as, copies, advance } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat, { kind: "other", item: "patchouli:guide_book" }] });
  world.scanning = 1;
  await scan.pass();
  expect(scan.health()).toMatchObject({ status: "ok", last: { confirmed: 1 } });
  world.invalid.add(bridge.key(OVERWORLD, 10, 64, 10));
  advance(minute);
  await scan.pass();
  expect(copies()).toEqual([{ book_id: 1, x: 10, y: 64, z: 10, slot: 0, state: "here", source: "server" }]);
  expect(as("Piper").find({ query: "wheat" })).toContain("seen there by the server 1 min ago; it could not look since (a book there could not be read), so that is the latest known");
});

test("the bridge going down or unhealthy mid-poll marks nothing missing", async () => {
  const { bridge, world, scan, copies } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat] });
  bridge.put(OVERWORLD, 20, 64, 10, { block: LECTERN, slots: [furnace] });
  await scan.pass();
  // Both books leave; the discovery page answers, then the bridge stops answering before the re-reads.
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [];
  world.shelves.get(bridge.key(OVERWORLD, 20, 64, 10))!.slots = [];
  world.failAfter = 1;
  await scan.pass();
  expect(scan.health()).toMatchObject({ status: "stopped" });
  expect(copies().map(copy => copy.state)).toEqual(["here", "here"]);
  world.down = false; world.failAfter = null; world.state = "paused";
  await scan.pass();
  expect(copies().map(copy => copy.state)).toEqual(["here", "here"]);
  world.state = "ok";
  await scan.pass();
  expect(copies().map(copy => copy.state)).toEqual(["gone", "gone"]);
});

test("a book moved to another shelf keeps its number; seen again later, it is simply there, with both facts in its history", async () => {
  const { bridge, world, scan, as, advance } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [wheat] });
  bridge.put(OVERWORLD, 30, 64, 10, { block: SHELF, slots: [] });
  await scan.pass();
  advance(minute);
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [];
  world.shelves.get(bridge.key(OVERWORLD, 30, 64, 10))!.slots = [null, null, wheat];
  await scan.pass();
  const moved = as("Piper").find({ id: 1 });
  expect(moved).toContain("Copies (1):\n  the chiseled bookshelf at 30,64,10 (slot 2); seen there by the server just now");
  expect(moved).toContain("was at the chiseled bookshelf at 10,64,10 (slot 0); not there since 2026-11-23 12:01 UTC");
  advance(minute);
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [null, wheat];
  await scan.pass();
  const back = as("Piper").find({ id: 1 });
  expect(back).toContain("Copies (2):");
  expect(back).toContain("[server] seen at 10,64,10 slot 1: on the chiseled bookshelf again");
  expect(back).toContain("[server] not there at 10,64,10 slot 0");
});

test("a discovery list older than a read that marked a copy gone does not bring it back", async () => {
  const { bridge, world, scan, copies, advance } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: LECTERN, slots: [wheat] });
  await scan.pass();
  advance(minute);
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [];
  await scan.pass();
  expect(copies()[0]!.state).toBe("gone");
  // A cached list scanned before that read still shows the book.
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [wheat];
  world.listAge = 2 * minute;
  advance(10_000);
  await scan.pass();
  expect(copies()[0]!.state).toBe("gone");
});

test("a book and quill edited on its shelf is a new version; the old draft leaves the search", async () => {
  const { bridge, world, scan, as } = hub();
  bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [quill(["Shopping: wool, coal"])] });
  await scan.pass();
  expect(as("Piper").find({ query: "shopping" })).toContain("#1 an unsigned book and quill, 1 page");
  world.shelves.get(bridge.key(OVERWORLD, 10, 64, 10))!.slots = [quill(["Shopping: wool, coal, glass"])];
  await scan.pass();
  await scan.pass(); // the new version's pages
  const found = as("Piper").find({ query: "shopping" });
  expect(found).toContain("1 text matches");
  expect(found).toContain("#2 an unsigned book and quill");
  expect(found).toContain("wool, coal, glass");
  expect(found).not.toContain("#1 ");
});

/** A shelf with the long book at 100,64,-200 and a resident body placed by the bridge. */
function library(body: { x: number; y: number; z: number; dimension?: string; online?: boolean; atMs?: number } | null, options: Parameters<typeof hub>[0] = {}) {
  const h = hub(options);
  h.bridge.put(OVERWORLD, 100, 64, -200, { block: SHELF, slots: [null, { kind: "other", item: "patchouli:guide_book" }, null, furnace, null, wheat] });
  h.bridge.put(OVERWORLD, 160, 64, -150, { block: LECTERN, slots: [furnace] });
  if (body) h.world.bodies.set("Piper", body);
  return h;
}

test("reading at the shelf: pages only within 4 blocks, by the bridge's position, of a shelf where it sees the book now", async () => {
  const h = library({ x: 102.5, y: 64, z: -199.5 });
  await h.scan.pass();
  const piper = h.as("Piper");
  const inside = await piper.read({ id: 1 });
  expect(text(inside)).toStartWith("PAGES slot 3 of the chiseled bookshelf at 100,64,-200, 2 blocks from you: Smelting iron");
  expect(inside).toMatchObject({ book: { id: 1, title: "Furnace notes" }, shelf: { x: 100, y: 64, z: -200 }, slot: 3 });
  // By the shelf in the sights: several books are listed; a slot reads one.
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 } })))
    .toBe('The chiseled bookshelf at 100,64,-200 holds 2 books: slot 3: "Furnace notes" by Tobin, 2 pages (#1); slot 5: "Wheat" by Margo, 1 page (#2). Read one: read_book {shelf: {x: 100, y: 64, z: -200}, slot: n}.');
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 }, slot: 5 }))).toContain("Wheat needs water");
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 }, slot: 0 }))).toContain("Slot 0 of the chiseled bookshelf at 100,64,-200 is empty. The chiseled bookshelf holds: slot 3:");
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 }, slot: 1 }))).toContain("Slot 1 of the chiseled bookshelf at 100,64,-200 holds patchouli:guide_book, which has no text.");
  // 4.5 blocks away from the shelf's centre: too far.
  h.world.bodies.set("Piper", { x: 105, y: 64.5, z: -199.5 });
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 }, slot: 3 }))).toContain("100,64,-200 is 5 blocks from where the server has you (105,64,-200); a book is read from 4 blocks or less.");
  h.world.bodies.set("Piper", { x: 100.5, y: 64, z: -229.9 });
  expect(text(await piper.read({ id: 1 })))
    .toBe('#1 "Furnace notes" by Tobin (original), 2 pages is not within 4 blocks of you. Nearest copy: the chiseled bookshelf at 100,64,-200 (slot 3), 30 blocks south of you; seen there by the server just now. Go there and read_book {id: 1} again.');
  h.world.bodies.set("Piper", { x: 100.5, y: 64, z: -198, dimension: NETHER });
  expect(text(await piper.read({ id: 1 }))).toContain("Its nearest copy is the chiseled bookshelf at 100,64,-200 (slot 3) in minecraft:overworld; you are in minecraft:the_nether.");
});

test("reading at the shelf refuses, and says why, when the bridge cannot place the resident now", async () => {
  const h = library({ x: 101, y: 64, z: -199, atMs: start - 6000 });
  await h.scan.pass();
  const piper = h.as("Piper");
  expect(text(await piper.read({ id: 1 }))).toBe("The server's latest sight of where you stand is 6 s old (at most 5 s counts), so nothing was read. Try again in a moment.");
  h.world.bodies.set("Piper", { x: 101, y: 64, z: -199, online: false });
  expect(text(await piper.read({ id: 1 }))).toBe("The server does not see you online, so it cannot tell where you stand; nothing was read.");
  h.world.bodies.delete("Piper");
  expect(text(await piper.read({ id: 1 }))).toContain("The server bridge does not list you yet");
  h.world.bodies.set("Piper", { x: 101, y: 64, z: -199 });
  h.world.state = "paused";
  expect(text(await piper.read({ id: 1 }))).toContain("The server bridge is paused, so the hub cannot tell where you stand; nothing was read.");
  h.world.state = "ok"; h.world.down = true;
  expect(text(await piper.read({ id: 1 }))).toContain("The server bridge did not answer (offline), so the hub cannot tell where you stand; nothing was read.");
  h.world.down = false;
  expect(text(await piper.read({ id: 1 }))).toStartWith("PAGES");
  const none = library({ x: 101, y: 64, z: -199 }, { bridge: false });
  expect(text(await none.as("Piper").read({ shelf: { x: 100, y: 64, z: -200 } }))).toContain("needs the server bridge, and this hub has none");
});

test("reading by id when the book has just left the nearby shelf: the catalogue learns it, the reply names the next copy", async () => {
  const h = library({ x: 101, y: 64, z: -199 });
  await h.scan.pass();
  h.world.shelves.get(h.bridge.key(OVERWORLD, 100, 64, -200))!.slots = [];
  expect(text(await h.as("Piper").read({ id: 1 })))
    .toBe("#1 is not on the shelf at 100,64,-200 any more: the server just looked. Nearest copy: the lectern at 160,64,-150, 77 blocks south-east of you; seen there by the server just now. Go there and read_book {id: 1} again.");
  expect(h.copies().filter(copy => copy.x === 100).map(copy => copy.state)).toEqual(["gone", "gone"]);
});

test("books by a player nobody perceives are not in the catalogue's replies", async () => {
  const h = library({ x: 101, y: 64, z: -199 }, { unseen: ["Lantern_"] });
  await h.scan.pass();
  h.world.shelves.get(h.bridge.key(OVERWORLD, 100, 64, -200))!.slots[0] = written("Watching", "Lantern_", ["From above."]);
  await h.scan.pass();
  const piper = h.as("Piper");
  expect(piper.find({})).not.toContain("Lantern_");
  expect(piper.find({ query: "above" })).toContain("No catalogued book matches");
  expect(() => piper.find({ id: 3 })).toThrow("No book #3");
  const listing = text(await piper.read({ shelf: { x: 100, y: 64, z: -200 } }));
  expect(listing).toContain("holds 2 books");
  expect(listing).not.toContain("Lantern_");
  expect(text(await piper.read({ shelf: { x: 100, y: 64, z: -200 }, slot: 0 }))).toContain("holds nothing that can be read here");
});

test("residents describe books and report ones kept where the server does not look; the server takes over a copy it finds", async () => {
  const h = hub();
  const tobin = h.as("Tobin"), piper = h.as("Piper");
  const notes: BookContent = { kind: "written", title: "Furnace notes", author: "Tobin", generation: 0, pages: furnace.pages };
  const chest = { x: 50, y: 64, z: 50, dimension: OVERWORLD };
  expect(tobin.register({ book: notes, read_from: "inventory", at: chest, holder: "minecraft:chest", subjects: ["smelting"] }))
    .toBe('Catalogued #1 "Furnace notes" by Tobin (original), 2 pages; subjects: smelting.\nListed at 50,64,50, chest on your word.');
  expect(piper.register({ book: notes, read_from: "inventory", at: chest, note: "mine now" })).toContain("Its subjects and note are Tobin's to change (book_update); yours were not saved.");
  expect(() => piper.update({ id: 1, note: "x" })).toThrow("Only Tobin");
  expect(piper.find({ subject: "smelt" })).toContain("at the chest at 50,64,50; Tobin said it is there just now (their word)");
  expect(piper.report({ id: 1, kind: "missing", at: chest })).toBe('Recorded: #1 "Furnace notes" by Tobin is no longer listed at 50,64,50 (your report).');
  expect(() => piper.report({ id: 1, kind: "found", at: chest, checked: { content_hash: "0".repeat(64), read_from: "inventory" } })).toThrow("not #1");
  // Registered at a shelf before it is placed there; the server's first sight takes the copy over.
  const shelf = { x: 10, y: 64, z: 10, dimension: OVERWORLD };
  tobin.register({ book: notes, read_from: "inventory", at: shelf, holder: SHELF });
  h.bridge.put(OVERWORLD, 10, 64, 10, { block: SHELF, slots: [null, notes] });
  await h.scan.pass();
  expect(h.copies().filter(copy => copy.x === 10)).toEqual([{ book_id: 1, x: 10, y: 64, z: 10, slot: 1, state: "here", source: "server" }]);
  expect(piper.find({ id: 1 })).toContain("[server] seen at 10,64,10 slot 1: on the chiseled bookshelf, where Tobin said it was");
  expect(piper.report({ id: 1, kind: "missing", at: shelf })).toContain("it marks a copy gone only when it reads that shelf without it");
});

test("a first-shape catalogue (one row per copy) is migrated on start; other tables are untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "library-migrate-")); dirs.push(dir);
  const path = join(dir, "commons.sqlite");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE facilities (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, purpose TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, dimension TEXT NOT NULL, steward TEXT NOT NULL COLLATE NOCASE, access_terms TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE library_books (id INTEGER PRIMARY KEY, content_hash TEXT NOT NULL, text_key TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL,
      generation INTEGER NOT NULL, pages_json TEXT NOT NULL, page_count INTEGER NOT NULL, text TEXT NOT NULL, subjects_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '', registrant TEXT NOT NULL COLLATE NOCASE, read_from TEXT NOT NULL CHECK (read_from IN ('inventory', 'lectern')),
      x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, dimension TEXT NOT NULL, holder TEXT,
      facility_id INTEGER REFERENCES facilities(id) ON DELETE SET NULL, location_by TEXT NOT NULL, location_source TEXT NOT NULL, location_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'withdrawn')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX library_books_text ON library_books(text_key);
    CREATE INDEX library_books_place ON library_books(dimension, x, y, z);
    CREATE TABLE library_observations (id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('registered', 'found', 'missing', 'moved', 'edited', 'withdrawn', 'server_seen', 'server_not_seen')),
      observer TEXT NOT NULL, source TEXT NOT NULL, x INTEGER, y INTEGER, z INTEGER, dimension TEXT, slot INTEGER, note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
    CREATE INDEX library_observations_book ON library_observations(book_id, at DESC, id DESC);`);
  old.query("INSERT INTO facilities (name, purpose, capabilities_json, x, y, z, dimension, steward, access_terms, created_at, updated_at) VALUES ('Mill library', 'books', '[]', 12, 64, 20, 'minecraft:overworld', 'Tobin', 'open', 1, 1)").run();
  const content = { kind: "written" as const, title: "Mill Notes", author: "Tobin", generation: 0, pages: ["The wheel turns."] };
  const insert = old.query(`INSERT INTO library_books (content_hash, text_key, title, author, generation, pages_json, page_count, text, subjects_json, registrant, read_from,
    x, y, z, dimension, holder, location_by, location_source, location_at, status, created_at, updated_at) VALUES (?, ?, 'Mill Notes', 'Tobin', 0, ?, 1, 'The wheel turns.', '["mill"]', 'Tobin', 'lectern',
    ?, 64, 20, 'minecraft:overworld', 'minecraft:lectern', 'Tobin', 'registered', ?, ?, ?, ?)`);
  insert.run(bookContentHash(content), bookTextKey(content), JSON.stringify(content.pages), 10, start, "listed", start, start);
  insert.run(bookContentHash(content), bookTextKey(content), JSON.stringify(content.pages), 30, start, "withdrawn", start, start + minute);
  old.query("INSERT INTO library_observations (book_id, kind, observer, source, x, y, z, dimension, note, at) VALUES (1, 'registered', 'Tobin', 'x', 10, 64, 20, 'minecraft:overworld', '', ?)").run(start);
  old.query("INSERT INTO library_observations (book_id, kind, observer, source, slot, note, at) VALUES (1, 'server_not_seen', 'server', 'x', 2, '', ?)").run(start + 1);
  old.close();

  for (let open = 0; open < 2; open++) {
    const db = openCommons(path, schema);
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%_v1'").all()).toEqual([]);
      expect(db.query("SELECT id, kind, title, registrant, subjects_json, page_count FROM library_books").all())
        .toEqual([{ id: 1, kind: "written", title: "Mill Notes", registrant: "Tobin", subjects_json: '["mill"]', page_count: 1 }]);
      expect(db.query("SELECT book_id, source, x, state, seen_by FROM library_copies ORDER BY id").all())
        .toEqual([{ book_id: 1, source: "resident", x: 10, state: "here", seen_by: "Tobin" }, { book_id: 1, source: "resident", x: 30, state: "gone", seen_by: "Tobin" }]);
      expect(db.query("SELECT kind, observer, slot FROM library_observations ORDER BY at").all())
        .toEqual([{ kind: "registered", observer: "Tobin", slot: null }, { kind: "server_gone", observer: "server", slot: 2 }]);
      expect(db.query("SELECT name FROM facilities").all()).toEqual([{ name: "Mill library" }]);
      expect(createLibrary(db, "Piper").find({ query: "wheel" })).toContain("at the lectern at 10,64,20, by facility \"Mill library\" (#1); Tobin said it is there");
    } finally { db.close(); }
  }
});

test("over HTTP: a whole book fits the larger body bound; caretakers may search but not read at a shelf or register", async () => {
  const hubApi = residentHub();
  try {
    const tobin = hubApi.identity("Tobin").client, caretaker = hubApi.identity("caretaker", "caretaker").client;
    const long: BookContent = { kind: "written", title: "Long", author: "Tobin", generation: 0, pages: Array.from({ length: 100 }, (_, i) => `${i} ${"word ".repeat(200)}`) };
    const at = { x: 1, y: 64, z: 1, dimension: OVERWORLD };
    expect(await tobin.call("library", "register", { book: long, read_from: "inventory", at })).toContain("100 pages");
    expect(await caretaker.call("library", "find", { query: "word" })).toContain("#1");
    await expect(caretaker.call("library", "read", { id: 1 })).rejects.toThrow("read-only");
    await expect(caretaker.call("library", "register", { book: long, read_from: "inventory", at })).rejects.toThrow("read-only");
    expect(await tobin.call("library", "read", { id: 1 })).toEqual({ text: "Reading a book where it stands needs the server bridge, and this hub has none: take the book out (use its shelf slot, or the lectern) and read it from your hand." });
    expect(await tobin.call("records", "query", { kind: "books" })).toContain("Tobin described book #1 \"Long\" by Tobin [hub]");
    await expect(tobin.call("library", "register", { book: { ...long, kind: "writable" }, read_from: "inventory", at })).rejects.toThrow("Invalid request arguments");
  } finally { hubApi.close(); }
});
