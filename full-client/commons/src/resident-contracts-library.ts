// What a resident's tool server sends the hub about books and records (library.ts, records.ts), and the book
// hashes both sides compute. Book text in the catalogue is what the server bridge or a resident's body read from
// the real item; the model never types the catalogue's copy of a book.
import { createHash } from "node:crypto";
import { z } from "zod";

/** A book standing on a chiseled bookshelf or lectern can be read through the catalogue from at most this far:
 * blocks from the centre of the shelf's block to the resident's position, as the server bridge reports it. */
export const READING_RADIUS = 4;
/** The oldest server position of a resident that counts as where it stands now (see library.ts `standing`). */
export const POSITION_MAX_AGE_MS = 5000;

const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), "Use one line.");
const id = z.number().int().positive();
const page = z.number().int().min(1).max(10_000).optional();
const block = z.number().int().min(-30_000_000).max(30_000_000);
const height = z.number().int().min(-2048).max(4096);
export const position = z.object({ x: block, y: height, z: block, dimension: line(80) }).strict();
export type Position = z.infer<typeof position>;
const subjects = z.array(line(40)).max(6);

/** A written book as the body read it from the item: plain-text pages, as the book screen shows them. */
export const bookContent = z.object({
  kind: z.literal("written"),
  title: z.string().max(128), author: z.string().max(64), generation: z.number().int().min(0).max(3),
  pages: z.array(z.string().max(32_767)).min(1).max(100),
}).strict();
export type BookContent = z.infer<typeof bookContent>;

export const libraryArgs = {
  /** Subjects and a note for a book the body holds, and where it is when that is somewhere the server does not look. */
  register: z.object({
    book: bookContent,
    read_from: z.enum(["inventory", "lectern"]),
    at: position,
    /** The block at `at` as the body saw it in its sights, when it was looking at it. */
    holder: line(80).optional(),
    subjects: subjects.optional(),
    note: line(200).optional(),
  }).strict(),
  find: z.object({
    id: id.optional(),
    query: line(120).optional(), author: line(64).optional(), subject: line(40).optional(),
    near: position.optional(),
    limit: z.number().int().min(1).max(10).optional(),
    page,
  }).strict(),
  /** A book standing on a shelf or lectern near the caller: by catalogue id, or by the shelf's block (in the
   * caller's dimension) and slot. The caller's position is the server bridge's, never sent by the caller. */
  read: z.object({
    id: id.optional(),
    shelf: z.object({ x: block, y: height, z: block }).strict().optional(),
    slot: z.number().int().min(0).max(5).optional(),
  }).strict().refine(a => (a.id === undefined) !== (a.shelf === undefined), "Give id or shelf.")
    .refine(a => a.slot === undefined || a.shelf !== undefined, "slot goes with shelf."),
  report: z.object({
    id,
    kind: z.enum(["found", "missing"]),
    at: position,
    holder: line(80).optional(),
    /** The content hash of the book the reporter's body read where it found it, when it read it. */
    checked: z.object({ content_hash: z.string().regex(/^[a-f0-9]{64}$/), read_from: z.enum(["inventory", "lectern"]) }).strict().optional(),
    note: line(200).optional(),
  }).strict(),
  update: z.object({ id, subjects: subjects.optional(), note: z.string().trim().max(200).refine(v => !/[\r\n]/.test(v), "Use one line.").optional() }).strict(),
};
export type LibraryArgs<K extends keyof typeof libraryArgs> = z.infer<(typeof libraryArgs)[K]>;

/** What `library/read` answers: the pages of a book read where it stands, or a sentence saying why not. */
export type ShelfReading =
  | { text: string }
  | {
    book: { id: number; kind: "written" | "writable"; title: string | null; author: string | null; generation: number | null };
    /** e.g. `slot 3 of the chiseled bookshelf at 100,64,-200, 2 blocks from you` */
    where: string;
    shelf: { x: number; y: number; z: number };
    slot: number;
    pages: string[];
  };

export const RECORD_KINDS = ["summary", "deaths", "alarms", "agreements", "facilities", "places", "books", "sessions", "crossings",
  "advancements", "stats", "building", "flows", "said"] as const;
export type RecordKind = typeof RECORD_KINDS[number];
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
export const recordsArgs = z.object({
  kind: z.enum(RECORD_KINDS),
  resident: z.string().regex(/^\w{1,16}$/).optional(),
  since: timestamp.optional(),
  until: timestamp.optional(),
  area: z.object({ x: block, z: block, radius: z.number().int().min(1).max(4096), dimension: line(80).optional() }).strict().optional(),
  page,
}).strict();
export type RecordsArgs = z.infer<typeof recordsArgs>;

/** SHA-256 of length-prefixed UTF-8 fields (signed big-endian byte length, -1 for null), then the page count and each page. */
function framed(fields: (string | null)[], pages: string[]): string {
  const hash = createHash("sha256");
  const int = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); hash.update(bytes); };
  const field = (value: string | null) => {
    if (value === null) { int(-1); return; }
    const bytes = Buffer.from(value, "utf8"); int(bytes.length); hash.update(bytes);
  };
  for (const value of fields) field(value);
  int(pages.length);
  for (const value of pages) field(value);
  return hash.digest("hex");
}

/** A book's selected content as the server bridge hashes it: a book and quill has no title, author or generation. */
export interface HashedBook { kind: "written" | "writable"; title: string | null; author: string | null; generation: number | null; pages: string[] }

/**
 * The server bridge's `resident-book-v1` content hash (server-observer BookText.java): length-prefixed UTF-8 of
 * "resident-book-v1", kind, title, author, generation (null for a book and quill), then the page count and each
 * plain-text page. A shelf read's `contentHash` equals this for the same book, so the catalogue keys books by it.
 */
export function bookContentHash(book: HashedBook): string {
  return framed(["resident-book-v1", book.kind, book.title, book.author, book.generation === null ? null : String(book.generation)], book.pages);
}

/** The text alone (title, author, pages): every copy of a book shares it, whatever its generation. */
export function bookTextKey(book: Pick<HashedBook, "title" | "author" | "pages">): string {
  return framed(["resident-book-text-v1", book.title, book.author], book.pages);
}
