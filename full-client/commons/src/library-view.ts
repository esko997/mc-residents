// The Library panel's read model (hub only): the book catalogue for a person, who may read every book in full.
// Residents read a book only standing at its shelf (library.ts); the dashboard has no body and no such rule.
//
// One entry per text: an original and its copies (same text_key) are one entry, shown as the earliest generation
// whose pages were read. An unsigned book and quill that stands nowhere any more is an old draft and is left out,
// as book_find leaves it out.
import type { Database } from "bun:sqlite";
import { holderName, type BookRow, type CopyRow } from "./library.ts";

export interface LibraryPlace {
  holder: string; dimension: string; x: number; y: number; z: number; slot: number | null;
  /** The nearest facility within 16 blocks, if any: "Mill library". */
  near: string | null;
  /** "server": seen there by the server bridge; otherwise the resident who reported it (their word). */
  seenBy: string; seenAt: number;
}
export interface LibraryEntry {
  id: number; kind: "written" | "writable"; title: string | null; author: string | null; generation: number | null;
  pageCount: number; pagesRead: boolean; subjects: string[]; note: string; describedBy: string | null;
  firstSeen: number; editions: number; standing: LibraryPlace[];
  /** The latest place a copy left, when none stands anywhere now. */
  lastGone: (LibraryPlace & { goneAt: number; reason: string }) | null;
}
export interface LibraryList { books: LibraryEntry[]; total: number }
export interface LibraryBook extends LibraryEntry {
  pages: string[] | null;
  /** Why the pages are missing: not read yet, or the last read failed (when). */
  pagesProblem: string | null;
  history: { at: number; kind: string; observer: string; note: string }[];
}

const GENERATIONS = ["original", "copy of original", "copy of a copy", "tattered"];
export const generationName = (generation: number | null) => GENERATIONS[generation ?? 0] ?? "copy";

interface Facility { name: string; x: number; y: number; z: number; dimension: string }

function placeOf(copy: CopyRow, facilities: Facility[]): LibraryPlace {
  const near = facilities.filter(f => f.dimension === copy.dimension && Math.hypot(f.x - copy.x, f.y - copy.y, f.z - copy.z) <= 16)
    .sort((a, b) => Math.hypot(a.x - copy.x, a.z - copy.z) - Math.hypot(b.x - copy.x, b.z - copy.z))[0];
  return {
    holder: holderName(copy.holder), dimension: copy.dimension, x: copy.x, y: copy.y, z: copy.z, slot: copy.slot,
    near: near?.name ?? null, seenBy: copy.source === "server" ? "server" : copy.seen_by, seenAt: copy.seen_at,
  };
}

function entries(db: Database): { entry: LibraryEntry; book: BookRow }[] {
  const facilities = db.query<Facility, []>("SELECT name, x, y, z, dimension FROM facilities").all();
  const books = db.query<BookRow, []>("SELECT * FROM library_books ORDER BY id").all();
  const copies = new Map<number, CopyRow[]>();
  for (const copy of db.query<CopyRow, []>("SELECT * FROM library_copies ORDER BY seen_at DESC, id DESC").all()) {
    copies.set(copy.book_id, [...(copies.get(copy.book_id) ?? []), copy]);
  }
  const groups = new Map<string, BookRow[]>();
  for (const book of books) {
    const key = book.text_key ?? book.content_hash;
    groups.set(key, [...(groups.get(key) ?? []), book]);
  }
  const out: { entry: LibraryEntry; book: BookRow }[] = [];
  for (const editions of groups.values()) {
    const all = editions.flatMap(edition => copies.get(edition.id) ?? []);
    const here = all.filter(copy => copy.state === "here");
    if (!here.length && !editions.some(edition => edition.kind === "written")) continue;
    // The earliest generation with its pages read represents the text; otherwise the earliest one.
    const book = [...editions].sort((a, b) => Number(a.pages_json === null) - Number(b.pages_json === null)
      || (a.generation ?? 0) - (b.generation ?? 0) || a.id - b.id)[0]!;
    const described = editions.find(edition => edition.registrant !== null) ?? book;
    const gone = all.filter(copy => copy.state === "gone").sort((a, b) => b.gone_at! - a.gone_at!)[0];
    out.push({ book, entry: {
      id: book.id, kind: book.kind, title: book.title, author: book.author, generation: book.generation,
      pageCount: book.page_count, pagesRead: book.pages_json !== null,
      subjects: JSON.parse(described.subjects_json) as string[], note: described.note, describedBy: described.registrant,
      firstSeen: Math.min(...editions.map(edition => edition.created_at)), editions: editions.length,
      standing: here.map(copy => placeOf(copy, facilities)),
      lastGone: here.length || !gone ? null : { ...placeOf(gone, facilities), goneAt: gone.gone_at!, reason: gone.gone_reason ?? "" },
    } });
  }
  return out.sort((a, b) => b.entry.firstSeen - a.entry.firstSeen || b.entry.id - a.entry.id);
}

/** Every text in the catalogue, newest first. */
export function libraryList(db: Database): LibraryList {
  const books = entries(db).map(({ entry }) => entry);
  return { books, total: books.length };
}

/** One text with its pages, by the id of any of its editions. */
export function libraryBook(db: Database, id: number): LibraryBook | null {
  const asked = db.query<BookRow, [number]>("SELECT * FROM library_books WHERE id = ?").get(id);
  if (!asked) return null;
  const key = asked.text_key ?? asked.content_hash;
  const found = entries(db).find(({ book }) => (book.text_key ?? book.content_hash) === key);
  if (!found) return null;
  const { entry, book } = found;
  const ids = db.query<{ id: number }, [string, string]>("SELECT id FROM library_books WHERE COALESCE(text_key, content_hash) = ? OR content_hash = ?")
    .all(key, key).map(row => row.id);
  const history = db.query<{ at: number; kind: string; observer: string; note: string }, number[]>(
    `SELECT at, kind, observer, note FROM library_observations WHERE book_id IN (${ids.map(() => "?").join(",")}) ORDER BY at DESC, id DESC LIMIT 20`).all(...ids);
  return {
    ...entry,
    pages: book.pages_json === null ? null : JSON.parse(book.pages_json) as string[],
    pagesProblem: book.pages_json !== null ? null
      : book.text_failed_at !== null ? "The server could not read its pages the last time it tried; it tries again every ten minutes while a copy stands on a shelf or lectern."
      : "Its pages have not been read yet: the hub reads a few new books a minute.",
    history,
  };
}
