// What a resident's tool server sends the hub about books and records (library.ts, records.ts), and the book
// hashes both sides compute. The tool server reads a book from the real item through Synapse and sends that
// text; the model never types the catalogue's copy of a book.
import { createHash } from "node:crypto";
import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), "Use one line.");
const id = z.number().int().positive();
const page = z.number().int().min(1).max(10_000).optional();
const block = z.number().int().min(-30_000_000).max(30_000_000);
export const position = z.object({ x: block, y: z.number().int().min(-2048).max(4096), z: block, dimension: line(80) }).strict();
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
  register: z.object({
    book: bookContent,
    read_from: z.enum(["inventory", "lectern"]),
    at: position,
    /** The block at `at` as the body saw it in its sights, when it was looking at it. */
    holder: line(80).optional(),
    facility: line(60).optional(),
    subjects: subjects.optional(),
    note: line(200).optional(),
    another_copy: z.boolean().optional(),
  }).strict(),
  find: z.object({
    id: id.optional(),
    query: line(120).optional(), author: line(64).optional(), subject: line(40).optional(),
    near: position.optional(),
    limit: z.number().int().min(1).max(10).optional(),
    page,
  }).strict(),
  report: z.object({
    id,
    kind: z.enum(["found", "missing"]),
    at: position.optional(),
    holder: line(80).optional(),
    /** The content hash of the book the reporter's body read where it found it, when it read it. */
    checked: z.object({ content_hash: z.string().regex(/^[a-f0-9]{64}$/), read_from: z.enum(["inventory", "lectern"]) }).strict().optional(),
    note: line(200).optional(),
  }).strict(),
  update: z.object({ id, subjects: subjects.optional(), note: z.string().trim().max(200).refine(v => !/[\r\n]/.test(v), "Use one line.").optional(), withdraw: z.boolean().optional() }).strict(),
};
export type LibraryArgs<K extends keyof typeof libraryArgs> = z.infer<(typeof libraryArgs)[K]>;

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

/**
 * The server bridge's `resident-book-v1` content hash (server-observer BookText.java): length-prefixed UTF-8 of
 * "resident-book-v1", kind, title, author, generation, then the page count and each plain-text page. A shelf
 * read's `contentHash` equals this for the same written book, so a catalogue entry can be matched to a slot.
 */
export function bookContentHash(book: BookContent): string {
  return framed(["resident-book-v1", book.kind, book.title, book.author, String(book.generation)], book.pages);
}

/** The text alone (title, author, pages): every copy of a book shares it, whatever its generation. */
export function bookTextKey(book: Pick<BookContent, "title" | "author" | "pages">): string {
  return framed(["resident-book-text-v1", book.title, book.author], book.pages);
}
