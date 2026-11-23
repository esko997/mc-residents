// The book catalogue (hub only): where written books are, so a neighbour can find one and walk to it.
// A row is one physical copy. Its text is what the registrant's body read from the real item (the tool server
// sends it; the model does not type it), so the catalogue can be searched by text; where the copy is comes from
// residents' reports, kept as dated observations. When a copy is listed on a chiseled bookshelf that the server
// bridge has registered as a library shelf, the bridge's read of that shelf confirms or fails to confirm it by
// content hash. Nothing here moves, removes or invents a book.
import type { Database } from "bun:sqlite";
import { normalizeObserverSnapshot, observerGet, observerShelf, type ObservedFacility, type ObserverSource } from "./observer.ts";
import { bookContentHash, bookTextKey, libraryArgs, type LibraryArgs, type Position } from "./resident-contracts-library.ts";

export interface LibraryDeps {
  observer?: ObserverSource | null;
  get?: typeof observerGet;
  now?: () => number;
}

interface BookRow {
  id: number; content_hash: string; text_key: string; title: string; author: string; generation: number;
  pages_json: string; page_count: number; text: string; subjects_json: string; note: string; registrant: string;
  read_from: string; x: number; y: number; z: number; dimension: string; holder: string | null; facility_id: number | null;
  location_by: string; location_source: string; location_at: number; status: "listed" | "withdrawn"; created_at: number; updated_at: number;
}
interface ObservationRow {
  id: number; book_id: number; kind: string; observer: string; source: string; x: number | null; y: number | null; z: number | null;
  dimension: string | null; slot: number | null; note: string; at: number;
}

const HOUR = 3_600_000;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
function distanceFrom(near: Position | undefined, row: Pick<BookRow, "x" | "y" | "z" | "dimension">): string {
  if (!near) return "";
  if (near.dimension !== row.dimension) return `; in ${row.dimension}, not your dimension`;
  const dx = row.x - near.x, dz = row.z - near.z, distance = Math.round(Math.hypot(dx, row.y - near.y, dz));
  if (distance < 2) return "; where you stand";
  // North is -z, east is +x.
  const heading = compass[Math.round((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360 / 45) % 8];
  return `; ${distance} blocks ${heading} of you`;
}

export function createLibrary(db: Database, resident: string, deps: LibraryDeps = {}) {
  const now = deps.now ?? Date.now;
  const facilityName = (id: number | null) => id === null ? undefined
    : db.query<{ name: string }, [number]>("SELECT name FROM facilities WHERE id = ?").get(id)?.name;
  const place = (row: BookRow) => {
    const facility = facilityName(row.facility_id);
    return `${row.x},${row.y},${row.z} ${row.dimension}${row.holder ? `, ${row.holder}` : ""}${facility ? `, facility "${facility}" (#${row.facility_id})` : ""}`;
  };
  const getBook = (id: number) => {
    const row = db.query<BookRow, [number]>("SELECT * FROM library_books WHERE id = ?").get(id);
    if (!row) throw new Error(`No book #${id} in the catalogue.`);
    return row;
  };
  const observe = (book: number, kind: string, observer: string, source: string, at: number, extra: { pos?: Position; slot?: number; note?: string } = {}) => {
    db.query("INSERT INTO library_observations (book_id,kind,observer,source,x,y,z,dimension,slot,note,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(book, kind, observer, source, extra.pos?.x ?? null, extra.pos?.y ?? null, extra.pos?.z ?? null, extra.pos?.dimension ?? null, extra.slot ?? null, extra.note ?? "", at);
    db.query("DELETE FROM library_observations WHERE book_id = ? AND id NOT IN (SELECT id FROM library_observations WHERE book_id = ? ORDER BY at DESC, id DESC LIMIT 60)").run(book, book);
  };
  const latest = (book: number, kinds: string[]) => db.query<ObservationRow, (string | number)[]>(
    `SELECT * FROM library_observations WHERE book_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY at DESC, id DESC LIMIT 1`).get(book, ...kinds);

  /** What is known now of where the copy is: the latest server shelf read and the latest resident report. */
  const standing = (row: BookRow, at: number): string[] => {
    const lines: string[] = [];
    const server = latest(row.id, ["server_seen", "server_not_seen"]);
    if (server && server.at >= row.location_at) {
      lines.push(server.kind === "server_seen"
        ? `[server] seen on that shelf${server.slot === null ? "" : ` in slot ${server.slot}`} ${ago(server.at, at)}`
        : `[server] NOT on that shelf when it was read ${ago(server.at, at)}`);
    }
    const report = latest(row.id, ["found", "missing", "moved"]);
    if (report && report.at >= row.location_at - 1) {
      lines.push(report.kind === "missing" ? `[reported by ${report.observer}] not found there ${ago(report.at, at)}${report.note ? `: ${report.note}` : ""}`
        : `[reported by ${report.observer}] found there ${ago(report.at, at)}${report.note ? `: ${report.note}` : ""}`);
    }
    return lines;
  };

  /** Bridge library shelves (id and position), cached briefly: the snapshot also lists other facilities. */
  const shelves = async (): Promise<ObservedFacility[] | string> => {
    if (!deps.observer) return "no server bridge is configured on the hub";
    const cached = shelfCache.get(deps.observer.url);
    if (cached && now() - cached.at < 5 * 60_000) return cached.facilities;
    const reach = await (deps.get ?? observerGet)(deps.observer, "/v1/snapshot");
    if (!reach.ok) return `the server bridge did not answer (${reach.status})`;
    const world = normalizeObserverSnapshot(reach.data, reach.receivedAt);
    if (!world) return "the server bridge has no snapshot yet";
    shelfCache.set(deps.observer.url, { at: now(), facilities: world.facilities });
    return world.facilities;
  };

  /**
   * Reads the bridge's registered chiseled bookshelves at the places of these copies (at most three places per
   * call) and records, for every listed copy there, whether a slot holds a book with its content hash. Copies
   * with the same hash on one shelf are matched oldest entry first. Returns a sentence per place that could not
   * be checked. A shelf that could not be read changes nothing.
   */
  const check = async (rows: BookRow[]): Promise<string[]> => {
    const places = [...new Map(rows.filter(row => row.status === "listed").map(row => [`${row.dimension} ${row.x} ${row.y} ${row.z}`, row])).values()];
    if (!places.length) return [];
    const known = await shelves();
    if (typeof known === "string") return [];
    const problems: string[] = [];
    for (const row of places.slice(0, 3)) {
      const shelf = known.find(f => f.dimension === row.dimension && f.pos[0] === row.x && f.pos[1] === row.y && f.pos[2] === row.z);
      if (!shelf) continue;
      const read = await observerShelf(deps.observer!, { facility: shelf.id }, deps.get ?? observerGet);
      if (!read.ok) {
        // An ordinary (non-library) facility at that place answers 404: there is nothing to check there.
        if (read.httpStatus !== 404) problems.push(`[server] could not read the shelf at ${row.x},${row.y},${row.z}: ${read.detail}`);
        continue;
      }
      const reply = read.data.shelf;
      if (reply.status !== "observed") {
        problems.push(`[server] could not read the shelf at ${row.x},${row.y},${row.z} (${reply.status}${reply.reason ? `: ${reply.reason}` : ""}); nothing recorded`);
        continue;
      }
      const at = now();
      const there = db.query<BookRow, [string, number, number, number]>(
        "SELECT * FROM library_books WHERE status = 'listed' AND dimension = ? AND x = ? AND y = ? AND z = ? ORDER BY id").all(row.dimension, row.x, row.y, row.z);
      const free = [...reply.slots];
      for (const book of there) {
        const index = free.findIndex(slot => slot.contentHash === book.content_hash);
        const slot = index >= 0 ? free.splice(index, 1)[0]!.slot : undefined;
        const kind = slot === undefined ? "server_not_seen" : "server_seen";
        const last = latest(book.id, ["server_seen", "server_not_seen"]);
        // A changed answer is recorded at once; the same answer again at most hourly.
        if (!last || last.kind !== kind || last.slot !== (slot ?? null) || at - last.at >= HOUR || last.at < book.location_at) {
          observe(book.id, kind, "server", `server bridge read of library shelf ${shelf.id}`, at, { pos: row, slot });
        }
      }
    }
    return problems;
  };

  const excerpt = (row: BookRow, words: string[]): string => {
    const lower = row.text.toLowerCase();
    const hit = words.map(word => lower.indexOf(word)).filter(index => index >= 0).sort((a, b) => a - b)[0];
    let start = hit === undefined ? 0 : Math.max(0, hit - 60);
    // Begin at a word: the first space after the cut, when it comes before the match.
    const space = row.text.slice(start, hit).search(/\s/);
    if (start > 0 && space >= 0) start += space + 1;
    const piece = row.text.slice(start, start + 150).replace(/\s+/g, " ").trim();
    return `"${start > 0 ? "…" : ""}${piece}${start + 150 < row.text.length ? "…" : ""}"`;
  };
  const subjectsOf = (row: BookRow) => JSON.parse(row.subjects_json) as string[];
  const heading = (row: BookRow) => `#${row.id} "${row.title}" by ${row.author}, ${row.page_count} page${row.page_count === 1 ? "" : "s"}${row.generation ? ` (${["original", "copy of original", "copy of a copy", "tattered"][row.generation]})` : ""}`;
  const copies = (row: BookRow) => db.query<BookRow, [string, number]>(
    "SELECT * FROM library_books WHERE text_key = ? AND id != ? AND status = 'listed' ORDER BY id").all(row.text_key, row.id);

  return {
    async register(input: LibraryArgs<"register">): Promise<string> {
      const a = libraryArgs.register.parse(input), at = now();
      const book = a.book;
      if (!book.title.trim() || !book.author.trim()) throw new Error("This book has no title or author; only signed written books are catalogued.");
      const facility = a.facility === undefined ? undefined
        : db.query<{ id: number }, [string]>("SELECT id FROM facilities WHERE name = ? COLLATE NOCASE").get(a.facility);
      if (a.facility !== undefined && !facility) throw new Error(`No facility named "${a.facility}". Leave facility out, or register the library with facility_register first.`);
      const contentHash = bookContentHash(book), textKey = bookTextKey(book);
      const id = db.transaction(() => {
        const twin = db.query<BookRow, [string, string, number, number, number]>(
          "SELECT * FROM library_books WHERE status = 'listed' AND content_hash = ? AND dimension = ? AND x = ? AND y = ? AND z = ? ORDER BY id LIMIT 1")
          .get(contentHash, a.at.dimension, a.at.x, a.at.y, a.at.z);
        if (twin && !a.another_copy) {
          throw new Error(`Already catalogued as #${twin.id} at this place (registered by ${twin.registrant}). If this is a second copy of the same book in the same place, register it again with another_copy: true.`);
        }
        const result = db.query(`INSERT INTO library_books (content_hash,text_key,title,author,generation,pages_json,page_count,text,subjects_json,note,registrant,read_from,
            x,y,z,dimension,holder,facility_id,location_by,location_source,location_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(contentHash, textKey, book.title, book.author, book.generation, JSON.stringify(book.pages), book.pages.length, book.pages.join("\n"),
            JSON.stringify(a.subjects ?? []), a.note ?? "", resident, a.read_from, a.at.x, a.at.y, a.at.z, a.at.dimension, a.holder ?? null,
            facility?.id ?? null, resident, "registered there by its registrant", at, at, at);
        const id = Number(result.lastInsertRowid);
        observe(id, "registered", resident, `text read from the item (${a.read_from}) by ${resident}'s body; place reported by ${resident}`, at, { pos: a.at });
        return id;
      }).immediate();
      const row = getBook(id);
      const problems = await check([row]);
      const others = copies(row);
      return [
        `Catalogued ${heading(row)} at ${place(row)}.`,
        "The text in the catalogue is what your body read from the book; where it is, is your report until someone else finds it there.",
        ...standing(row, now()), ...problems,
        others.length ? `Copies of the same text: ${others.slice(0, 4).map(other => `#${other.id} at ${place(other)}`).join("; ")}${others.length > 4 ? `; ${others.length - 4} more` : ""}.` : "",
      ].filter(Boolean).join("\n");
    },

    async find(input: LibraryArgs<"find">): Promise<string> {
      const a = libraryArgs.find.parse(input), at = now();
      if (a.id !== undefined) {
        const row = getBook(a.id);
        const problems = await check([row]);
        const history = db.query<ObservationRow, [number]>("SELECT * FROM library_observations WHERE book_id = ? ORDER BY at DESC, id DESC LIMIT 8").all(row.id);
        const others = copies(row), subjects = subjectsOf(row);
        return [
          `${heading(row)}${row.status === "withdrawn" ? " — WITHDRAWN by its registrant" : ""}`,
          `Where: ${place(row)}${distanceFrom(a.near, row)} (since ${stamp(row.location_at)}, ${row.location_source}${same(row.location_by, row.registrant) ? "" : `: ${row.location_by}`})`,
          ...standing(row, at), ...problems,
          `Registered by ${row.registrant} ${stamp(row.created_at)}; text read from the item (${row.read_from}).${subjects.length ? ` Subjects: ${subjects.join(", ")}.` : ""}${row.note ? ` Note: ${row.note}` : ""}`,
          `Opening: ${excerpt(row, [])}`,
          "The whole text is in the book itself: go there and read it (a book on a chiseled bookshelf has to be taken out to be read).",
          others.length ? `Same text elsewhere: ${others.slice(0, 4).map(other => `#${other.id} at ${place(other)}`).join("; ")}${others.length > 4 ? `; ${others.length - 4} more` : ""}.` : "No other catalogued copy of this text.",
          "History (newest first):",
          ...history.map(o => `${stamp(o.at)} ${o.kind.replace("_", " ")} by ${o.observer}${o.slot === null ? "" : ` (slot ${o.slot})`}${o.x === null ? "" : ` at ${o.x},${o.y},${o.z}`}${o.note ? `: ${o.note}` : ""} [${o.source}]`),
        ].join("\n");
      }
      const words = [...new Set((a.query ?? "").toLowerCase().split(/\s+/).filter(word => word.length > 1))].slice(0, 8);
      const where = ["status = 'listed'"], values: string[] = [];
      for (const word of words) {
        where.push("(lower(title) LIKE ? OR lower(author) LIKE ? OR lower(subjects_json) LIKE ? OR lower(text) LIKE ?)");
        values.push(...Array(4).fill(`%${word}%`));
      }
      if (a.author) { where.push("author LIKE ?"); values.push(`%${a.author}%`); }
      if (a.subject) { where.push("lower(subjects_json) LIKE ?"); values.push(`%${a.subject.toLowerCase()}%`); }
      const rows = db.query<BookRow, string[]>(`SELECT * FROM library_books WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT 500`).all(...values);
      const near = a.near;
      const distance = (row: BookRow) => !near ? 0 : row.dimension !== near.dimension ? Infinity : Math.hypot(row.x - near.x, row.y - near.y, row.z - near.z);
      if (near) rows.sort((x, y) => distance(x) - distance(y) || y.updated_at - x.updated_at);
      // One result per text; its nearest (or newest) copy first, the others named after it.
      const groups = new Map<string, BookRow[]>();
      for (const row of rows) groups.set(row.text_key, [...(groups.get(row.text_key) ?? []), row]);
      const texts = [...groups.values()];
      const limit = a.limit ?? 5, number = a.page ?? 1, shown = texts.slice((number - 1) * limit, number * limit);
      if (!shown.length) {
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM library_books WHERE status = 'listed'").get()?.n ?? 0;
        return number > 1 ? `No more matches (page ${number}).` : `No catalogued book matches${a.query ? ` "${a.query}"` : ""}${a.author ? ` by ${a.author}` : ""}${a.subject ? ` about ${a.subject}` : ""}. The catalogue lists ${total} book${total === 1 ? "" : "s"}; a book nobody registered is not in it.`;
      }
      const problems = await check(shown.map(group => group[0]!));
      const lines = [`${texts.length} catalogued text${texts.length === 1 ? "" : "s"} match${texts.length === 1 ? "es" : ""}; showing ${(number - 1) * limit + 1}-${(number - 1) * limit + shown.length}. Excerpts only: the text is in the book.`];
      for (const group of shown) {
        const [first, ...rest] = group as [BookRow, ...BookRow[]];
        const subjects = subjectsOf(first);
        lines.push(`${heading(first)}${subjects.length ? `; subjects: ${subjects.join(", ")}` : ""}`);
        lines.push(`  at ${place(first)}${distanceFrom(near, first)}; ${first.location_source}${same(first.location_by, first.registrant) ? "" : ` (${first.location_by})`}`);
        for (const known of standing(first, at)) lines.push(`  ${known}`);
        if (rest.length) lines.push(`  also: ${rest.slice(0, 3).map(other => `#${other.id} at ${other.x},${other.y},${other.z}${distanceFrom(near, other)}`).join("; ")}${rest.length > 3 ? `; ${rest.length - 3} more` : ""}`);
        lines.push(`  ${excerpt(first, words)}`);
      }
      lines.push(...problems);
      if (texts.length > number * limit) lines.push(`More: page ${number + 1}.`);
      lines.push("book_find with id shows one book's place history and copies.");
      return lines.join("\n");
    },

    async report(input: LibraryArgs<"report">): Promise<string> {
      const a = libraryArgs.report.parse(input), at = now();
      const row = getBook(a.id);
      if (row.status === "withdrawn") throw new Error(`#${row.id} was withdrawn by ${row.registrant}. To list it again, register it again.`);
      if (a.checked && a.checked.content_hash !== row.content_hash) {
        throw new Error(`The book your body read is not #${row.id} "${row.title}": its text, title, author or generation differs. Search book_find for it, or register it.`);
      }
      const checked = a.checked ? `, text checked (${a.checked.read_from})` : "";
      if (a.kind === "missing") {
        observe(row.id, "missing", resident, `reported by ${resident}`, at, { pos: row, note: a.note });
        return `Recorded: you did not find #${row.id} "${row.title}" at ${place(row)}. The catalogue keeps that place and your report beside it; whoever finds the book elsewhere can say where.`;
      }
      if (!a.at) throw new Error("Say where you found it: at, or the block in your sights.");
      const moved = a.at.dimension !== row.dimension || a.at.x !== row.x || a.at.y !== row.y || a.at.z !== row.z;
      if (!moved) {
        observe(row.id, "found", resident, `reported by ${resident}${checked}`, at, { pos: a.at, note: a.note });
        return `Recorded: #${row.id} "${row.title}" is at ${place(row)}, as listed (your report${checked}).`;
      }
      const facility = row.facility_id === null ? undefined : db.query<{ x: number; z: number; dimension: string }, [number]>("SELECT x, z, dimension FROM facilities WHERE id = ?").get(row.facility_id);
      // A move within the library keeps its facility; anywhere else it is no longer that facility's book.
      const keep = facility && facility.dimension === a.at.dimension && Math.hypot(facility.x - a.at.x, facility.z - a.at.z) <= 32;
      const before = place(row);
      db.transaction(() => {
        db.query("UPDATE library_books SET x=?,y=?,z=?,dimension=?,holder=?,facility_id=?,location_by=?,location_source=?,location_at=?,updated_at=? WHERE id=?")
          .run(a.at!.x, a.at!.y, a.at!.z, a.at!.dimension, a.holder ?? null, keep ? row.facility_id : null, resident, `found there by ${resident}${checked}`, at, at, row.id);
        observe(row.id, "moved", resident, `reported by ${resident}${checked}`, at, { pos: a.at, note: `from ${before}${a.note ? `; ${a.note}` : ""}` });
      }).immediate();
      return `Recorded: #${row.id} "${row.title}" is now listed at ${place(getBook(row.id))} (found there by you${checked}); it was listed at ${before}.${facility && !keep ? " It is no longer listed as part of its facility." : ""}`;
    },

    update(input: LibraryArgs<"update">): string {
      const a = libraryArgs.update.parse(input), at = now();
      const row = getBook(a.id);
      if (!same(row.registrant, resident)) throw new Error(`Only ${row.registrant}, who registered #${row.id}, can change its subjects or note or withdraw it. Where it is can be reported by anyone with book_report.`);
      if (a.subjects === undefined && a.note === undefined && !a.withdraw) throw new Error("Give subjects, note or withdraw.");
      db.transaction(() => {
        db.query("UPDATE library_books SET subjects_json=COALESCE(?,subjects_json), note=COALESCE(?,note), status=?, updated_at=? WHERE id=?")
          .run(a.subjects === undefined ? null : JSON.stringify(a.subjects), a.note ?? null, a.withdraw ? "withdrawn" : row.status, at, row.id);
        if (a.subjects !== undefined || a.note !== undefined) observe(row.id, "edited", resident, `by its registrant`, at, { note: [a.subjects ? `subjects: ${a.subjects.join(", ")}` : "", a.note !== undefined ? `note: ${a.note}` : ""].filter(Boolean).join("; ") });
        if (a.withdraw) observe(row.id, "withdrawn", resident, `by its registrant`, at);
      }).immediate();
      return a.withdraw ? `Withdrew #${row.id} "${row.title}": it no longer shows in book_find searches. The book itself is wherever it is.` : `Updated #${row.id} "${row.title}".`;
    },
  };
}

const shelfCache = new Map<string, { at: number; facilities: ObservedFacility[] }>();

/** The authenticated caller is the only identity used by the store. */
export async function libraryOperation(db: Database, resident: string, operation: string, args: unknown, deps: LibraryDeps = {}): Promise<string> {
  const library = createLibrary(db, resident, deps);
  switch (operation) {
    case "register": return library.register(libraryArgs.register.parse(args));
    case "find": return library.find(libraryArgs.find.parse(args));
    case "report": return library.report(libraryArgs.report.parse(args));
    case "update": return library.update(libraryArgs.update.parse(args));
    default: throw new Error("Unknown library operation.");
  }
}
