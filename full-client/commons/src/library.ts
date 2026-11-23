// The book catalogue (hub only): every book standing on a chiseled bookshelf or lectern the server bridge has seen,
// plus books residents described or keep elsewhere, so a neighbour can find one and walk to it.
//
// A book is one edition, keyed by the bridge's content hash (kind, title, author, generation, pages); a copy is that
// book at one place. The bridge's discovery list (library-scan.ts) adds and confirms copies; only the bridge's read of
// a copy's own position marks it gone (the shelf read without it, or no shelf there any more). A position the bridge
// could not read, or one missing from the discovery list, changes nothing: unknown is not gone.
//
// Reading: `read` returns a book's pages only while the bridge places the caller within READING_RADIUS blocks of a
// shelf or lectern on which it sees that book at that moment. The caller's position is the bridge's, never the
// caller's own client's, and no older than POSITION_MAX_AGE_MS. Elsewhere the reply says where the nearest copy is.
import type { Database } from "bun:sqlite";
import {
  normalizeObserverSnapshot, observerBook, observerGet, observerShelf, type BookInfo, type ObserverSource, type ShelfPlace,
} from "./observer.ts";
import {
  bookContentHash, bookTextKey, libraryArgs, POSITION_MAX_AGE_MS, READING_RADIUS,
  type BookContent, type LibraryArgs, type Position, type ShelfReading,
} from "./resident-contracts-library.ts";

export interface LibraryDeps {
  observer?: ObserverSource | null;
  get?: typeof observerGet;
  now?: () => number;
  /** Players nobody perceives (the owner's spectator): their books, and lines naming them, are left out. */
  unseen?: readonly string[];
}

export interface BookRow {
  id: number; content_hash: string; kind: "written" | "writable"; title: string | null; author: string | null; generation: number | null;
  page_count: number; text_key: string | null; pages_json: string | null; text: string | null; text_by: string | null; text_failed_at: number | null;
  subjects_json: string; note: string; registrant: string | null; created_at: number; updated_at: number;
}
export interface CopyRow {
  id: number; book_id: number; source: "server" | "resident"; dimension: string; x: number; y: number; z: number; slot: number | null;
  holder: string | null; state: "here" | "gone"; seen_at: number; seen_by: string; checked_at: number | null; check_status: string | null;
  gone_at: number | null; gone_reason: string | null; created_at: number;
}
interface ObservationRow {
  id: number; book_id: number; kind: string; observer: string; x: number | null; y: number | null; z: number | null;
  dimension: string | null; slot: number | null; note: string; at: number;
}
/** What the bridge saw at one position: a chiseled bookshelf's or lectern's books. */
export interface ShelfSeen extends ShelfPlace { block: string | null; slots: BookInfo[] }

const SHELF = "minecraft:chiseled_bookshelf", LECTERN = "minecraft:lectern";
const OBSERVATIONS_KEPT = 60;
const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** How each observation kind reads in a book's history; %s is the observer. */
const HISTORY: Record<string, string> = {
  registered: "described by %s", edited: "edited by %s", found: "reported there by %s", missing: "reported missing by %s",
  server_seen: "[server] seen", server_gone: "[server] not there", shelf_gone: "[server] its shelf gone",
};
function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** "; 37 blocks north-east of you" from a whole-block position (book_find, from the resident's client). */
function distanceFrom(near: Position | undefined, at: { x: number; y: number; z: number; dimension: string }): string {
  if (!near) return "";
  if (near.dimension !== at.dimension) return `; in ${at.dimension}, not your dimension`;
  const dx = at.x - near.x, dz = at.z - near.z, distance = Math.round(Math.hypot(dx, at.y - near.y, dz));
  if (distance < 2) return "; where you stand";
  // North is -z, east is +x.
  const heading = compass[Math.round((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360 / 45) % 8];
  return `; ${distance} blocks ${heading} of you`;
}
/** From the centre of the block to a body's position. */
const reach = (place: { x: number; y: number; z: number }, body: { x: number; y: number; z: number }) =>
  Math.hypot(place.x + 0.5 - body.x, place.y + 0.5 - body.y, place.z + 0.5 - body.z);
const holderName = (block: string | null) => block === SHELF ? "chiseled bookshelf" : block === LECTERN ? "lectern" : block ? block.replace(/^minecraft:/, "") : "place";
const coords = (at: { x: number; y: number; z: number }) => `${at.x},${at.y},${at.z}`;
const readable = (slot: BookInfo): slot is BookInfo & { kind: "written" | "writable"; contentHash: string } =>
  (slot.kind === "written" || slot.kind === "writable") && slot.contentHash !== null;
const placeOf = (copy: CopyRow): ShelfPlace => ({ dimension: copy.dimension, pos: [copy.x, copy.y, copy.z] });

// === the store, shared with library-scan.ts ===

/** The catalogue's book for this edition, created from what the bridge (or a body) read of it. */
export function catalogueBook(db: Database, info: Pick<BookInfo, "kind" | "title" | "author" | "generation" | "pageCount"> & { contentHash: string }, at: number): BookRow {
  db.query(`INSERT INTO library_books (content_hash, kind, title, author, generation, page_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING`)
    .run(info.contentHash, info.kind, info.title, info.author, info.generation, info.pageCount, at, at);
  return db.query<BookRow, [string]>("SELECT * FROM library_books WHERE content_hash = ?").get(info.contentHash)!;
}

/** Keeps the pages of a book once they are read, only when they hash to the book's own content hash. */
export function storeText(db: Database, book: BookRow, pages: string[], by: string, at: number): boolean {
  const content = { kind: book.kind, title: book.title, author: book.author, generation: book.generation, pages };
  if (bookContentHash(content) !== book.content_hash) return false;
  if (book.pages_json !== null) return true;
  db.query("UPDATE library_books SET pages_json = ?, text = ?, text_key = ?, page_count = ?, text_by = ?, text_failed_at = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(pages), pages.join("\n"), bookTextKey(content), pages.length, by, at, book.id);
  return true;
}

export function observe(db: Database, book: number, kind: string, observer: string, at: number, extra: { place?: { x: number; y: number; z: number; dimension: string }; slot?: number | null; note?: string } = {}) {
  db.query("INSERT INTO library_observations (book_id, kind, observer, x, y, z, dimension, slot, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(book, kind, observer, extra.place?.x ?? null, extra.place?.y ?? null, extra.place?.z ?? null, extra.place?.dimension ?? null, extra.slot ?? null, extra.note ?? "", at);
  db.query(`DELETE FROM library_observations WHERE book_id = ?1 AND id NOT IN
    (SELECT id FROM library_observations WHERE book_id = ?1 ORDER BY at DESC, id DESC LIMIT ${OBSERVATIONS_KEPT})`).run(book);
}

const copiesAt = (db: Database, place: ShelfPlace) => db.query<CopyRow, [string, number, number, number]>(
  "SELECT * FROM library_copies WHERE dimension = ? AND x = ? AND y = ? AND z = ? ORDER BY id").all(place.dimension, ...place.pos);

/**
 * What the bridge saw at one position, applied to the copies listed there; returns the copies it confirmed.
 * Each book in a slot is matched to a listed copy of the same book (same slot first, then another slot of that
 * shelf, then a resident's copy at that place, which the server takes over, then one it saw leave), else a new copy.
 * `authoritative`: a read of exactly this position, at `at`; the server's copies listed here that it did not see
 * are then gone. The discovery list is not authoritative (absence there means nothing), and may be up to 30 s old:
 * it never revives a copy marked gone after it was scanned.
 */
export function applyShelf(db: Database, shelf: ShelfSeen, at: number, authoritative: boolean): number[] {
  return db.transaction(() => {
    const place = { dimension: shelf.dimension, x: shelf.pos[0], y: shelf.pos[1], z: shelf.pos[2] };
    const listed = copiesAt(db, shelf), claimed = new Set<number>(), confirmed: number[] = [];
    const where = holderName(shelf.block);
    for (const slot of shelf.slots.filter(readable)) {
      const book = catalogueBook(db, slot, at);
      const mine = listed.filter(copy => copy.book_id === book.id && !claimed.has(copy.id));
      const pick = mine.find(c => c.source === "server" && c.state === "here" && c.slot === slot.slot)
        ?? mine.find(c => c.source === "server" && c.state === "here")
        ?? mine.find(c => c.source === "resident" && c.state === "here")
        ?? mine.find(c => c.state === "gone");
      if (pick) {
        claimed.add(pick.id);
        if (pick.state === "gone" && (pick.gone_at ?? 0) > at) continue;
        const appears = pick.state === "gone" || pick.source === "resident";
        db.query(`UPDATE library_copies SET source = 'server', slot = ?, holder = ?, state = 'here', seen_at = MAX(seen_at, ?), seen_by = 'server',
            gone_at = NULL, gone_reason = NULL, checked_at = CASE WHEN ? THEN ? ELSE checked_at END, check_status = NULL WHERE id = ?`)
          .run(slot.slot, shelf.block, at, authoritative ? 1 : 0, at, pick.id);
        if (appears) observe(db, book.id, "server_seen", "server", at, { place, slot: slot.slot, note: pick.state === "gone" ? `on the ${where} again` : `on the ${where}, where ${pick.seen_by} said it was` });
        confirmed.push(pick.id);
        continue;
      }
      const id = Number(db.query(`INSERT INTO library_copies (book_id, source, dimension, x, y, z, slot, holder, state, seen_at, seen_by, checked_at, created_at)
        VALUES (?, 'server', ?, ?, ?, ?, ?, ?, 'here', ?, 'server', ?, ?)`).run(book.id, place.dimension, place.x, place.y, place.z, slot.slot, shelf.block, at, authoritative ? at : null, at).lastInsertRowid);
      observe(db, book.id, "server_seen", "server", at, { place, slot: slot.slot, note: `on the ${where}` });
      confirmed.push(id);
    }
    if (authoritative) {
      for (const copy of listed) {
        if (copy.source !== "server" || copy.state !== "here" || claimed.has(copy.id)) continue;
        db.query("UPDATE library_copies SET state = 'gone', gone_at = ?, gone_reason = ?, checked_at = ?, check_status = NULL WHERE id = ?")
          .run(at, `the server saw the ${where} without it`, at, copy.id);
        observe(db, copy.book_id, "server_gone", "server", at, { place, slot: copy.slot, note: `the ${where} was read without it` });
      }
    }
    return confirmed;
  }).immediate();
}

/** The bridge read this position and no chiseled bookshelf or lectern stands there: every copy it listed there is gone. */
export function applyNoShelf(db: Database, place: ShelfPlace, block: string | null, at: number) {
  db.transaction(() => {
    const now = block ? `${block} is there now` : "nothing is there now";
    for (const copy of copiesAt(db, place)) {
      if (copy.source !== "server" || copy.state !== "here") continue;
      db.query("UPDATE library_copies SET state = 'gone', gone_at = ?, gone_reason = ?, checked_at = ?, check_status = NULL WHERE id = ?")
        .run(at, `its ${holderName(copy.holder)} is gone (${now})`, at, copy.id);
      observe(db, copy.book_id, "shelf_gone", "server", at, { place: { dimension: copy.dimension, x: copy.x, y: copy.y, z: copy.z }, slot: copy.slot, note: `the ${holderName(copy.holder)} is gone; ${now}` });
    }
  }).immediate();
}

/** The bridge could not tell what stands at this position (unloaded, no level, error): nothing changes but the date asked. */
export function applyUnknown(db: Database, place: ShelfPlace, status: string, at: number) {
  db.query("UPDATE library_copies SET checked_at = ?, check_status = ? WHERE dimension = ? AND x = ? AND y = ? AND z = ? AND source = 'server' AND state = 'here'")
    .run(at, status, place.dimension, ...place.pos);
}

// === migration from the first shape (one row per copy, registered shelves) ===

/** Before the schema is applied: moves a first-shape catalogue aside so the schema can create the new tables. */
export function setAsideLegacyLibrary(db: Database) {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('library_books')").all().map(c => c.name));
  if (!columns.has("read_from")) return;
  db.transaction(() => {
    for (const index of ["library_books_text", "library_books_place", "library_observations_book"]) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec("ALTER TABLE library_books RENAME TO library_books_v1");
    db.exec("ALTER TABLE library_observations RENAME TO library_observations_v1");
  }).immediate();
}

/** After the schema: copies a set-aside first-shape catalogue into books, copies and observations, then drops it. */
export function migrateLegacyLibrary(db: Database) {
  const legacy = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'library_books_v1'").get()!.n > 0;
  if (!legacy) return;
  interface Old {
    id: number; content_hash: string; text_key: string; title: string; author: string; generation: number; pages_json: string; page_count: number;
    text: string; subjects_json: string; note: string; registrant: string; x: number; y: number; z: number; dimension: string; holder: string | null;
    location_by: string; location_at: number; status: string; created_at: number; updated_at: number;
  }
  const kinds: Record<string, string> = { registered: "registered", found: "found", moved: "found", missing: "missing", edited: "edited", withdrawn: "missing", server_seen: "server_seen", server_not_seen: "server_gone" };
  db.transaction(() => {
    for (const row of db.query<Old, []>("SELECT * FROM library_books_v1 ORDER BY id").all()) {
      db.query(`INSERT INTO library_books (content_hash, kind, title, author, generation, page_count, text_key, pages_json, text, text_by, subjects_json, note, registrant, created_at, updated_at)
        VALUES (?, 'written', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING`)
        .run(row.content_hash, row.title, row.author, row.generation, row.page_count, row.text_key, row.pages_json, row.text, row.registrant, row.subjects_json, row.note, row.registrant, row.created_at, row.updated_at);
      const book = db.query<{ id: number }, [string]>("SELECT id FROM library_books WHERE content_hash = ?").get(row.content_hash)!.id;
      const withdrawn = row.status === "withdrawn";
      db.query(`INSERT INTO library_copies (book_id, source, dimension, x, y, z, slot, holder, state, seen_at, seen_by, gone_at, gone_reason, created_at)
        VALUES (?, 'resident', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .run(book, row.dimension, row.x, row.y, row.z, row.holder, withdrawn ? "gone" : "here", row.location_at, row.location_by,
          withdrawn ? row.updated_at : null, withdrawn ? `withdrawn from the catalogue by ${row.registrant}` : null, row.created_at);
      db.query(`INSERT INTO library_observations (book_id, kind, observer, x, y, z, dimension, slot, note, at)
        SELECT ?, CASE kind ${Object.entries(kinds).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(" ")} END, observer, x, y, z, dimension, slot,
          CASE kind WHEN 'moved' THEN 'moved here: ' || note WHEN 'withdrawn' THEN 'withdrawn by its registrant' ELSE note END, at
        FROM library_observations_v1 WHERE book_id = ? ORDER BY at, id`).run(book, row.id);
    }
    db.exec("DROP TABLE library_observations_v1");
    db.exec("DROP TABLE library_books_v1");
  }).immediate();
}

// === what a resident asks ===

/** Where the server bridge has a resident now (`at`: when it saw that, on this hub's clock), or the sentence saying why it cannot tell. */
type Standing = { dimension: string; x: number; y: number; z: number; at: number } | { text: string };

export function createLibrary(db: Database, resident: string, deps: LibraryDeps = {}) {
  const now = deps.now ?? Date.now;
  const get = deps.get ?? observerGet;
  const unseen = (deps.unseen ?? []).map(name => name.toLowerCase());
  const mentionsUnseen = (text: string) => unseen.length > 0 && (text.toLowerCase().match(/\w+/g) ?? []).some(word => unseen.includes(word));
  const hidden = (book: BookRow) => book.author !== null && unseen.includes(book.author.toLowerCase());
  const facilities = db.query<{ id: number; name: string; x: number; y: number; z: number; dimension: string }, []>("SELECT id, name, x, y, z, dimension FROM facilities").all();

  const getBook = (id: number) => {
    const row = db.query<BookRow, [number]>("SELECT * FROM library_books WHERE id = ?").get(id);
    if (!row || hidden(row)) throw new Error(`No book #${id} in the catalogue.`);
    return row;
  };
  /** Every edition of the same text (an original and its copies); a book whose pages are not read yet is alone. */
  const editions = (book: BookRow) => book.text_key === null ? [book]
    : db.query<BookRow, [string]>("SELECT * FROM library_books WHERE text_key = ? ORDER BY id").all(book.text_key).filter(row => !hidden(row));
  const copiesOf = (books: BookRow[]) => books.length ? db.query<CopyRow, number[]>(
    `SELECT * FROM library_copies WHERE book_id IN (${books.map(() => "?").join(",")}) ORDER BY id`).all(...books.map(book => book.id)) : [];
  const title = (book: BookRow) => book.kind === "written" ? `"${book.title}" by ${book.author}` : "an unsigned book and quill";
  const generation = (book: BookRow) => book.kind === "written" ? ` (${["original", "copy of original", "copy of a copy", "tattered"][book.generation ?? 0]})` : "";
  const heading = (book: BookRow) => `#${book.id} ${title(book)}${generation(book)}, ${book.page_count} page${book.page_count === 1 ? "" : "s"}`;
  /** e.g. `the chiseled bookshelf at 100,64,-200 (slot 3), by facility "Mill library" (#7)` */
  const placeText = (copy: CopyRow) => {
    const near = facilities.filter(f => f.dimension === copy.dimension && Math.hypot(f.x - copy.x, f.y - copy.y, f.z - copy.z) <= 16)
      .sort((a, b) => Math.hypot(a.x - copy.x, a.z - copy.z) - Math.hypot(b.x - copy.x, b.z - copy.z))[0];
    return `the ${holderName(copy.holder)} at ${coords(copy)}${copy.dimension === "minecraft:overworld" ? "" : ` ${copy.dimension}`}`
      + `${copy.holder === SHELF && copy.slot !== null ? ` (slot ${copy.slot})` : ""}${near ? `, by facility "${near.name}" (#${near.id})` : ""}`;
  };
  /** How sure the catalogue is that this copy is there, and on whose word. */
  const copyState = (copy: CopyRow, at: number) => {
    if (copy.state === "gone") return `not there since ${stamp(copy.gone_at!)}: ${copy.gone_reason}`;
    if (copy.source === "resident") return `${copy.seen_by} said it is there ${ago(copy.seen_at, at)} (their word)`;
    const unknown = copy.checked_at !== null && copy.check_status !== null && copy.checked_at > copy.seen_at;
    const why: Record<string, string> = { unloaded: "its chunk is not loaded", no_level: "its dimension is not loaded", invalid: "a book there could not be read", too_large: "a book there could not be read" };
    return `seen there by the server ${ago(copy.seen_at, at)}${unknown ? `; it could not look since (${why[copy.check_status!] ?? copy.check_status}), so that is the latest known` : ""}`;
  };
  const excerpt = (book: BookRow): string => {
    if (book.text === null) return "(its pages have not been read yet)";
    const prose = book.text.replace(/\s+/g, " ").trim();
    // A fixed opening leaves some text at the shelf, even for short books or repeated searches.
    let end = Math.min(150, Math.floor(prose.length / 2));
    if (end > 0 && /[\uD800-\uDBFF]/.test(prose[end - 1]!)) end--;
    return end > 0 ? `"${prose.slice(0, end).trimEnd()}…"` : "(no excerpt)";
  };
  const subjectsOf = (book: BookRow) => JSON.parse(book.subjects_json) as string[];
  const toRead = (id: number) => `To read it, stand within ${READING_RADIUS} blocks of a copy on a shelf or lectern and use read_book {id: ${id}}.`;

  /** The caller's position as the bridge reports it now; anything less than a fresh, healthy answer refuses. */
  const standing = async (): Promise<Standing> => {
    const takeOut = "or take the book out (use its shelf slot, or the lectern) and read it from your hand";
    if (!deps.observer) return { text: `Reading a book where it stands needs the server bridge, and this hub has none: take the book out (use its shelf slot, or the lectern) and read it from your hand.` };
    const reply = await get(deps.observer, "/v1/snapshot");
    if (!reply.ok) return { text: `The server bridge did not answer (${reply.status}), so the hub cannot tell where you stand; nothing was read. Try again shortly, ${takeOut}.` };
    const world = normalizeObserverSnapshot(reply.data, reply.receivedAt);
    if (!world) return { text: `The server bridge has no view of the world yet (it is starting), so the hub cannot tell where you stand; nothing was read. Try again shortly, ${takeOut}.` };
    if (world.state !== "ok" && world.state !== "degraded") return { text: `The server bridge is ${world.state}${world.stateDetail ? ` (${world.stateDetail})` : ""}, so the hub cannot tell where you stand; nothing was read. Try again later, ${takeOut}.` };
    const me = world.residents.find(entry => entry.name.toLowerCase() === resident.toLowerCase());
    if (!me) return { text: "The server bridge does not list you yet (the hub sends it every resident's name within a minute of either restarting), so it cannot tell where you stand; nothing was read. Try again shortly." };
    if (!me.online || !me.body) return { text: "The server does not see you online, so it cannot tell where you stand; nothing was read." };
    const age = now() - me.body.at;
    if (age > POSITION_MAX_AGE_MS) return { text: `The server's latest sight of where you stand is ${Math.round(age / 1000)} s old (at most ${POSITION_MAX_AGE_MS / 1000} s counts), so nothing was read. Try again in a moment.` };
    return { dimension: me.body.dimension, ...me.body.pos, at: me.body.at };
  };

  /**
   * Reads the shelf or lectern at `place` through the bridge now (updating the catalogue with what it sees) and then
   * the chosen slot's pages. `wanted`: content hashes of the book asked for by id; null when no slot holds one of them.
   */
  const readAt = async (place: ShelfPlace, me: { x: number; y: number; z: number; at: number }, slot: number | undefined, wanted?: Set<string>): Promise<ShelfReading | null> => {
    const at = { x: place.pos[0], y: place.pos[1], z: place.pos[2] };
    const shelfReply = await observerShelf(deps.observer!, place, get);
    if (!shelfReply.ok) return { text: `The server bridge could not read ${coords(at)} (${shelfReply.status}: ${shelfReply.detail}); nothing was read.` };
    if (shelfReply.data.state !== "ok") return { text: `The server bridge is ${shelfReply.data.state}, so it could not read ${coords(at)}; nothing was read. Try again later.` };
    const shelf = shelfReply.data.shelf, time = now();
    if (shelf.status === "no_shelf") {
      applyNoShelf(db, place, shelf.block, time);
      return wanted ? null : { text: `There is no chiseled bookshelf or lectern at ${coords(at)}${shelf.block ? ` (the server sees ${shelf.block} there)` : ""}.` };
    }
    if (shelf.status !== "observed") {
      applyUnknown(db, place, shelf.status, time);
      return { text: `The server could not look at ${coords(at)} (${shelf.status}${shelf.reason ? `: ${shelf.reason}` : ""}); nothing was read.` };
    }
    applyShelf(db, shelf, time, true);
    const where = holderName(shelf.block);
    const books = new Map(shelf.slots.filter(readable).map(s => [s.slot, db.query<BookRow, [string]>("SELECT * FROM library_books WHERE content_hash = ?").get(s.contentHash)!]));
    const visible = [...books].filter(([, book]) => !hidden(book));
    const listing = () => visible.map(([n, book]) => `slot ${n}: ${title(book)}, ${book.page_count} page${book.page_count === 1 ? "" : "s"} (#${book.id})`).join("; ");
    if (wanted) {
      const found = visible.find(([, book]) => wanted.has(book.content_hash));
      if (!found) return null;
      slot = found[0];
    } else if (slot === undefined) {
      if (!visible.length) return { text: `The ${where} at ${coords(at)} holds ${shelf.slots.length ? "no book that can be read here (only books or items without text)" : "no books"}.` };
      if (visible.length > 1) return { text: `The ${where} at ${coords(at)} holds ${visible.length} books: ${listing()}. Read one: read_book {shelf: {x: ${at.x}, y: ${at.y}, z: ${at.z}}, slot: n}.` };
      slot = visible[0]![0];
    } else if (!books.has(slot) || hidden(books.get(slot)!)) {
      const there = shelf.slots.find(s => s.slot === slot);
      const kind = there && (there.kind === "enchanted" ? "an enchanted book" : there.kind === "plain" ? "a plain book" : there.item ?? "an item");
      const what = !there ? "is empty" : !readable(there) ? `holds ${kind}, which has no text` : "holds nothing that can be read here";
      return { text: `Slot ${slot} of the ${where} at ${coords(at)} ${what}.${visible.length ? ` The ${where} holds: ${listing()}.` : ""}` };
    }
    const book = books.get(slot)!;
    const pagesReply = await observerBook(deps.observer!, { ...place, slot }, get);
    if (!pagesReply.ok) return { text: `The server bridge could not read slot ${slot} at ${coords(at)} (${pagesReply.status}: ${pagesReply.detail}); nothing was read.` };
    if (pagesReply.data.state !== "ok") return { text: `The server bridge is ${pagesReply.data.state}, so it could not read slot ${slot} at ${coords(at)}; nothing was read. Try again later.` };
    const read = pagesReply.data.book;
    if (read.status !== "observed" || !read.book) return { text: `The server could not read the book in slot ${slot} at ${coords(at)} (${read.status}${read.reason ? `: ${read.reason}` : ""}).` };
    if (read.book.contentHash !== book.content_hash) return { text: `The book in slot ${slot} at ${coords(at)} changed while it was being read; read again.` };
    if (!storeText(db, book, read.pages, "server", now())) return { text: `The pages the server sent for slot ${slot} at ${coords(at)} do not match that book; nothing was read.` };
    // The shelf and book reads take time: the position the gate used must still count as where the caller stands.
    const age = now() - me.at;
    if (age > POSITION_MAX_AGE_MS) return { text: `The server's sight of where you stand was ${Math.round(age / 1000)} s old by the time the shelf was read (at most ${POSITION_MAX_AGE_MS / 1000} s counts), so nothing was read. Try again.` };
    const distance = reach(at, me);
    return {
      book: { id: book.id, kind: book.kind, title: book.title, author: book.author, generation: book.generation },
      where: `${where === "lectern" ? "the lectern" : `slot ${slot} of the ${where}`} at ${coords(at)}, ${distance < 1.5 ? "where you stand" : `${Math.round(distance)} blocks from you`}`,
      shelf: at, slot, pages: read.pages,
    };
  };

  /** Where the nearest copy of these editions is, as seen from the bridge's position of the caller. */
  const elsewhere = (book: BookRow, me: { dimension: string; x: number; y: number; z: number }, lead: string): string => {
    const copies = copiesOf(editions(book)), at = now();
    const standingCopies = copies.filter(copy => copy.state === "here");
    const server = standingCopies.filter(copy => copy.source === "server").map(copy => ({ copy, distance: copy.dimension === me.dimension ? reach(copy, me) : Infinity }))
      .sort((a, b) => a.distance - b.distance);
    const near = server[0];
    if (near && near.distance !== Infinity) {
      const heading = compass[Math.round((Math.atan2(near.copy.x + 0.5 - me.x, -(near.copy.z + 0.5 - me.z)) * 180 / Math.PI + 360) % 360 / 45) % 8];
      return `${lead}Nearest copy: ${placeText(near.copy)}, ${Math.round(near.distance)} blocks ${heading} of you; ${copyState(near.copy, at)}. Go there and read_book {id: ${book.id}} again.`;
    }
    if (near) return `${lead}Its nearest copy is ${placeText(near.copy)} in ${near.copy.dimension}; you are in ${me.dimension}.`;
    const kept = standingCopies[0];
    if (kept) return `${lead}No copy stands on a shelf or lectern the server sees. ${kept.seen_by} said one is at ${placeText(kept)} ${ago(kept.seen_at, at)} (their word): take it out there and read it from your hand.`;
    const last = copies.filter(copy => copy.state === "gone").sort((a, b) => b.gone_at! - a.gone_at!)[0];
    return `${lead}No copy of #${book.id} is known to stand anywhere now${last ? `; the last was ${placeText(last)}, not there since ${stamp(last.gone_at!)} (${last.gone_reason})` : ""}. book_find {id: ${book.id}} shows its history.`;
  };

  return {
    async read(input: LibraryArgs<"read">): Promise<ShelfReading> {
      const a = libraryArgs.read.parse(input);
      const book = a.id === undefined ? undefined : getBook(a.id);
      const me = await standing();
      if ("text" in me) return me;
      if (a.shelf) {
        const distance = reach(a.shelf, me);
        if (distance > READING_RADIUS) {
          return { text: `${coords(a.shelf)} is ${Math.round(distance)} blocks from where the server has you (${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)}); a book is read from ${READING_RADIUS} blocks or less. Go closer and read again.` };
        }
        return (await readAt({ dimension: me.dimension, pos: [a.shelf.x, a.shelf.y, a.shelf.z] }, me, a.slot))!;
      }
      const group = editions(book!), wanted = new Set(group.map(edition => edition.content_hash));
      const within = copiesOf(group).filter(copy => copy.source === "server" && copy.state === "here" && copy.dimension === me.dimension && reach(copy, me) <= READING_RADIUS)
        .sort((x, y) => reach(x, me) - reach(y, me));
      const tried = new Set<string>();
      for (const copy of within) {
        const key = coords(copy);
        if (tried.has(key) || tried.size >= 3) continue;
        tried.add(key);
        const result = await readAt(placeOf(copy), me, undefined, wanted);
        if (result) return result;
      }
      const lead = tried.size
        ? `#${book!.id} is not on the ${[...tried].length === 1 ? "shelf" : "shelves"} at ${[...tried].join(" or ")} any more: the server just looked. `
        : `${heading(book!)} is not within ${READING_RADIUS} blocks of you. `;
      return { text: elsewhere(book!, me, lead) };
    },

    register(input: LibraryArgs<"register">): string {
      const a = libraryArgs.register.parse(input), at = now();
      const content: BookContent = a.book;
      if (!content.title.trim() || !content.author.trim()) throw new Error("This book has no title or author; only signed written books are catalogued by hand.");
      const lines = db.transaction(() => {
        const book = catalogueBook(db, { ...content, pageCount: content.pages.length, contentHash: bookContentHash(content) }, at);
        storeText(db, book, content.pages, resident, at);
        const out: string[] = [];
        const describing = a.subjects !== undefined || a.note !== undefined;
        if (describing && book.registrant !== null && !same(book.registrant, resident)) {
          out.push(`Its subjects and note are ${book.registrant}'s to change (book_update); yours were not saved.`);
        } else if (describing || book.registrant === null) {
          db.query("UPDATE library_books SET registrant = ?, subjects_json = COALESCE(?, subjects_json), note = COALESCE(?, note), updated_at = ? WHERE id = ?")
            .run(resident, a.subjects === undefined ? null : JSON.stringify(a.subjects), a.note ?? null, at, book.id);
          observe(db, book.id, book.registrant === null ? "registered" : "edited", resident, at, { note: [a.subjects ? `subjects: ${a.subjects.join(", ")}` : "", a.note ? `note: ${a.note}` : ""].filter(Boolean).join("; ") });
        }
        const there = copiesAt(db, { dimension: a.at.dimension, pos: [a.at.x, a.at.y, a.at.z] }).find(copy => copy.book_id === book.id && copy.state === "here");
        if (there) out.push(there.source === "server" ? `The server already sees it at ${placeText(there)}; ${copyState(there, at)}.` : `Already listed at ${placeText(there)}.`);
        else {
          db.query(`INSERT INTO library_copies (book_id, source, dimension, x, y, z, slot, holder, state, seen_at, seen_by, created_at)
            VALUES (?, 'resident', ?, ?, ?, ?, NULL, ?, 'here', ?, ?, ?)`).run(book.id, a.at.dimension, a.at.x, a.at.y, a.at.z, a.holder ?? null, at, resident, at);
          observe(db, book.id, "found", resident, at, { place: a.at, note: `catalogued there by ${resident}` });
          out.push(`Listed at ${coords(a.at)}${a.holder ? `, ${holderName(a.holder)}` : ""} on your word${a.holder === SHELF || a.holder === LECTERN ? "; the server will see it there by itself once it stands on the shelf or lectern" : ""}.`);
        }
        return [book.id, out] as const;
      }).immediate();
      const book = getBook(lines[0]), subjects = subjectsOf(book);
      return [`Catalogued ${heading(book)}${subjects.length ? `; subjects: ${subjects.join(", ")}` : ""}${book.note ? `; note: ${book.note}` : ""}.`, ...lines[1]].join("\n");
    },

    find(input: LibraryArgs<"find">): string {
      const a = libraryArgs.find.parse(input), at = now();
      const near = a.near;
      const distance = (copy: CopyRow) => !near ? 0 : copy.dimension !== near.dimension ? Infinity : Math.hypot(copy.x - near.x, copy.y - near.y, copy.z - near.z);
      const copyLine = (copy: CopyRow) => `${placeText(copy)}${distanceFrom(near, copy)}; ${copyState(copy, at)}`;
      if (a.id !== undefined) {
        const book = getBook(a.id);
        const copies = copiesOf([book]), here = copies.filter(copy => copy.state === "here").sort((x, y) => distance(x) - distance(y));
        const gone = copies.filter(copy => copy.state === "gone").sort((x, y) => y.gone_at! - x.gone_at!);
        const others = editions(book).filter(edition => edition.id !== book.id);
        const history = db.query<ObservationRow, [number]>("SELECT * FROM library_observations WHERE book_id = ? ORDER BY at DESC, id DESC LIMIT 8").all(book.id);
        const subjects = subjectsOf(book);
        return [
          heading(book),
          book.registrant ? `Described by ${book.registrant}${subjects.length ? `; subjects: ${subjects.join(", ")}` : ""}${book.note ? `; note: ${book.note}` : ""}.` : "Nobody has given it subjects or a note.",
          ...(here.length ? [`Copies (${here.length}):`, ...here.slice(0, 6).map(copy => `  ${copyLine(copy)}`), ...(here.length > 6 ? [`  ${here.length - 6} more`] : [])]
            : ["No copy is known to stand anywhere now."]),
          ...gone.slice(0, 3).map(copy => `  was at ${placeText(copy)}; ${copyState(copy, at)}`),
          ...(others.length ? [`Other editions of the same text: ${others.slice(0, 4).map(edition => `#${edition.id}${generation(edition)}`).join(", ")}.`] : []),
          `Opening: ${excerpt(book)}`,
          toRead(book.id),
          "History (newest first):",
          ...history.map(o => `${stamp(o.at)} ${HISTORY[o.kind]?.replace("%s", o.observer) ?? o.kind}${o.x === null ? "" : ` at ${o.x},${o.y},${o.z}`}${o.slot === null ? "" : ` slot ${o.slot}`}${o.note ? `: ${o.note}` : ""}`),
        ].filter(line => !mentionsUnseen(line)).join("\n");
      }
      const words = [...new Set((a.query ?? "").toLowerCase().split(/\s+/).filter(word => word.length > 1))].slice(0, 8);
      const where: string[] = [], values: string[] = [];
      for (const word of words) {
        where.push("(lower(COALESCE(title, '')) LIKE ? OR lower(COALESCE(author, '')) LIKE ? OR lower(subjects_json) LIKE ? OR lower(COALESCE(text, '')) LIKE ?)");
        values.push(...Array(4).fill(`%${word}%`));
      }
      if (a.author) { where.push("author LIKE ?"); values.push(`%${a.author}%`); }
      if (a.subject) { where.push("lower(subjects_json) LIKE ?"); values.push(`%${a.subject.toLowerCase()}%`); }
      const books = db.query<BookRow, string[]>(`SELECT * FROM library_books ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT 500`)
        .all(...values).filter(book => !hidden(book));
      const copies = new Map<number, CopyRow[]>();
      for (const copy of copiesOf(books)) copies.set(copy.book_id, [...(copies.get(copy.book_id) ?? []), copy]);
      // One result per text: its editions' standing copies, nearest first.
      const groups = new Map<string, { books: BookRow[]; here: CopyRow[]; gone: CopyRow[] }>();
      for (const book of books) {
        const key = book.text_key ?? book.content_hash, group = groups.get(key) ?? { books: [], here: [], gone: [] };
        group.books.push(book);
        for (const copy of copies.get(book.id) ?? []) (copy.state === "here" ? group.here : group.gone).push(copy);
        groups.set(key, group);
      }
      for (const group of groups.values()) group.here.sort((x, y) => distance(x) - distance(y));
      // An unsigned book and quill that stands nowhere is an old draft, not a book.
      const texts = [...groups.values()].filter(group => group.here.length || group.books.some(book => book.kind === "written"))
        .sort((x, y) => (x.here.length ? distance(x.here[0]!) : Infinity) - (y.here.length ? distance(y.here[0]!) : Infinity));
      const limit = a.limit ?? 5, number = a.page ?? 1, shown = texts.slice((number - 1) * limit, number * limit);
      if (!shown.length) {
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM library_books").get()?.n ?? 0;
        return number > 1 ? `No more matches (page ${number}).` : `No catalogued book matches${a.query ? ` "${a.query}"` : ""}${a.author ? ` by ${a.author}` : ""}${a.subject ? ` about ${a.subject}` : ""}. The catalogue holds ${total} book${total === 1 ? "" : "s"}: every book the server has seen on a chiseled bookshelf or lectern, and those residents described.`;
      }
      const lines = [`${texts.length} text${texts.length === 1 ? "" : "s"} match${texts.length === 1 ? "es" : ""}; showing ${(number - 1) * limit + 1}-${(number - 1) * limit + shown.length}. Excerpts only: read the book at its shelf.`];
      for (const group of shown) {
        const first = group.here[0], book = first ? group.books.find(b => b.id === first.book_id)! : group.books[0]!;
        const subjects = subjectsOf(book);
        lines.push(`${heading(book)}${subjects.length ? `; subjects: ${subjects.join(", ")}` : ""}`);
        if (first) lines.push(`  at ${copyLine(first)}`);
        else {
          const last = group.gone.sort((x, y) => y.gone_at! - x.gone_at!)[0];
          lines.push(`  no copy known to stand anywhere now${last ? `; the last was at ${placeText(last)}, ${copyState(last, at)}` : ""}`);
        }
        const rest = group.here.slice(1);
        if (rest.length) lines.push(`  also: ${rest.slice(0, 3).map(copy => `#${copy.book_id} at ${coords(copy)}${near ? distanceFrom(near, copy) : copy.dimension === "minecraft:overworld" ? "" : ` ${copy.dimension}`}`).join("; ")}${rest.length > 3 ? `; ${rest.length - 3} more` : ""}`);
        lines.push(`  ${excerpt(book)}`);
      }
      if (texts.length > number * limit) lines.push(`More: page ${number + 1}.`);
      lines.push(`To read one, stand within ${READING_RADIUS} blocks of a copy and use read_book {id}; book_find {id} shows a book's copies and history.`);
      return lines.filter(line => !mentionsUnseen(line)).join("\n");
    },

    report(input: LibraryArgs<"report">): string {
      const a = libraryArgs.report.parse(input), at = now();
      const book = getBook(a.id);
      if (a.checked && a.checked.content_hash !== book.content_hash) {
        throw new Error(`The book your body read is not #${book.id} ${title(book)}: its text, title, author or generation differs. Search book_find for it, or register it.`);
      }
      const checked = a.checked ? `, text checked (${a.checked.read_from})` : "";
      const place = { dimension: a.at.dimension, pos: [a.at.x, a.at.y, a.at.z] as [number, number, number] };
      const there = copiesAt(db, place).filter(copy => copy.book_id === book.id && copy.state === "here");
      return db.transaction(() => {
        if (a.kind === "missing") {
          if (!there.length) throw new Error(`#${book.id} is not listed at ${coords(a.at)}; book_find {id: ${book.id}} says where it is.`);
          observe(db, book.id, "missing", resident, at, { place: a.at, note: a.note });
          const server = there.find(copy => copy.source === "server");
          if (server) return `Noted. The server saw #${book.id} at ${placeText(server)} ${ago(server.seen_at, at)}; it marks a copy gone only when it reads that shelf without it, which it does by itself. Your report is kept in the book's history.`;
          for (const copy of there) {
            db.query("UPDATE library_copies SET state = 'gone', gone_at = ?, gone_reason = ? WHERE id = ?").run(at, `${resident} reported it missing${a.note ? `: ${a.note}` : ""}`, copy.id);
          }
          return `Recorded: #${book.id} ${title(book)} is no longer listed at ${coords(a.at)} (your report).`;
        }
        observe(db, book.id, "found", resident, at, { place: a.at, note: `${a.note ?? ""}${checked}` });
        if (there.length) return `Recorded: #${book.id} ${title(book)} is at ${placeText(there[0]!)}, as listed (your report${checked}).`;
        db.query(`INSERT INTO library_copies (book_id, source, dimension, x, y, z, slot, holder, state, seen_at, seen_by, created_at)
          VALUES (?, 'resident', ?, ?, ?, ?, NULL, ?, 'here', ?, ?, ?)`).run(book.id, a.at.dimension, a.at.x, a.at.y, a.at.z, a.holder ?? null, at, resident, at);
        return `Recorded: #${book.id} ${title(book)} is now also listed at ${coords(a.at)}${a.holder ? `, ${holderName(a.holder)}` : ""} (found there by you${checked}).`;
      }).immediate();
    },

    update(input: LibraryArgs<"update">): string {
      const a = libraryArgs.update.parse(input), at = now();
      const book = getBook(a.id);
      if (book.registrant === null) throw new Error(`Nobody has described #${book.id} yet: hold it (or open its lectern) and use book_register with subjects or a note.`);
      if (!same(book.registrant, resident)) throw new Error(`Only ${book.registrant}, who described #${book.id}, can change its subjects or note. Where a copy is can be reported by anyone with book_report.`);
      if (a.subjects === undefined && a.note === undefined) throw new Error("Give subjects or note.");
      db.transaction(() => {
        db.query("UPDATE library_books SET subjects_json = COALESCE(?, subjects_json), note = COALESCE(?, note), updated_at = ? WHERE id = ?")
          .run(a.subjects === undefined ? null : JSON.stringify(a.subjects), a.note ?? null, at, book.id);
        observe(db, book.id, "edited", resident, at, { note: [a.subjects ? `subjects: ${a.subjects.join(", ")}` : "", a.note !== undefined ? `note: ${a.note}` : ""].filter(Boolean).join("; ") });
      }).immediate();
      return `Updated #${book.id} ${title(book)}.`;
    },
  };
}

/** The authenticated caller is the only identity used by the store. */
export async function libraryOperation(db: Database, resident: string, operation: string, args: unknown, deps: LibraryDeps = {}): Promise<unknown> {
  const library = createLibrary(db, resident, deps);
  switch (operation) {
    case "register": return library.register(libraryArgs.register.parse(args));
    case "find": return library.find(libraryArgs.find.parse(args));
    case "read": return library.read(libraryArgs.read.parse(args));
    case "report": return library.report(libraryArgs.report.parse(args));
    case "update": return library.update(libraryArgs.update.parse(args));
    default: throw new Error("Unknown library operation.");
  }
}
