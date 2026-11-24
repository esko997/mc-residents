import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyNoShelf, applyShelf, catalogueBook, storeText } from "../src/library.ts";
import { libraryBook, libraryList } from "../src/library-view.ts";
import { bookContentHash, type HashedBook } from "../src/resident-contracts-library.ts";
import { LECTERN, OVERWORLD, quill, SHELF, written } from "./fake-bridge.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function hub() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(join(import.meta.dir, "../schema.sql"), "utf8"));
  return db;
}
const info = (book: HashedBook, slot = 0) => ({ slot, kind: book.kind, title: book.title, author: book.author, generation: book.generation,
  pageCount: book.pages.length, contentHash: bookContentHash(book) });
/** A book standing at a place, its pages read as the hub's scan reads them. */
function shelve(db: Database, pos: [number, number, number], block: string, books: HashedBook[], at: number) {
  applyShelf(db, { dimension: OVERWORLD, pos, block, slots: books.map((book, slot) => info(book, slot)) }, at, true);
  for (const book of books) storeText(db, catalogueBook(db, info(book), at), book.pages, "server", at);
}

test("the library lists one entry per text, newest first, and opens a book in full wherever its copies stand", () => {
  const db = hub();
  const original = written("Rail notes", "Tobin", ["Powered rails every 34 blocks.", "Gold comes from the nether."]);
  const copy = written("Rail notes", "Tobin", original.pages, 1);
  const herbs = written("Herbs", "Margo", ["Sweet berries by the river."]);
  shelve(db, [100, 64, -200], SHELF, [original, copy], 1000);
  shelve(db, [110, 64, -200], LECTERN, [herbs], 2000);

  const list = libraryList(db);
  expect(list.books.map(book => [book.title, book.author, book.editions, book.standing.length])).toEqual([["Herbs", "Margo", 1, 1], ["Rail notes", "Tobin", 2, 2]]);
  const rails = list.books[1]!;
  expect(rails.generation).toBe(0);

  // Either edition's id opens the same text, whole: the dashboard does not keep pages at the shelf.
  const opened = libraryBook(db, rails.id + 1)!;
  expect(opened.id).toBe(rails.id);
  expect(opened.pages).toEqual(original.pages);
  expect(opened.standing.map(place => [place.holder, place.x, place.slot]).sort()).toEqual([["chiseled bookshelf", 100, 0], ["chiseled bookshelf", 100, 1]]);
  expect(libraryBook(db, 999)).toBeNull();
});

test("a book whose pages are not read yet says so; a book no longer on any shelf stays, with where it was last", () => {
  const db = hub();
  const unread = written("Unread", "Wren", ["Later."]);
  applyShelf(db, { dimension: OVERWORLD, pos: [1, 64, 1], block: LECTERN, slots: [info(unread)] }, 1000, true);
  const book = libraryBook(db, libraryList(db).books[0]!.id)!;
  expect(book.pages).toBeNull();
  expect(book.pagesProblem).toContain("not been read yet");

  applyNoShelf(db, { dimension: OVERWORLD, pos: [1, 64, 1] }, "minecraft:air", 5000);
  const gone = libraryList(db).books[0]!;
  expect(gone.standing).toEqual([]);
  expect(gone.lastGone).toMatchObject({ holder: "lectern", x: 1, goneAt: 5000 });
});

test("an unsigned draft that was rewritten leaves the list; the current draft stays", () => {
  const db = hub();
  shelve(db, [5, 64, 5], SHELF, [quill(["Shopping: wool"])], 1000);
  shelve(db, [5, 64, 5], SHELF, [quill(["Shopping: wool, glass"])], 2000);
  const books = libraryList(db).books;
  expect(books).toHaveLength(1);
  expect(libraryBook(db, books[0]!.id)!.pages).toEqual(["Shopping: wool, glass"]);
});
