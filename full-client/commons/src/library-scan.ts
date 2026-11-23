// Keeps the book catalogue (library.ts) in step with the server, hub only. One pass per interval, never overlapping,
// and only while the server bridge answers `ok`:
//   1. discovery: page the bridge's list of chiseled bookshelves and lecterns holding books in loaded chunks; every
//      book there enters the catalogue by its content hash, and every copy there is confirmed. The list is loaded
//      chunks only and may be cut, so a position missing from it means nothing;
//   2. re-reads: the positions where the catalogue believes the server's copies stand that this pass did not confirm,
//      least recently checked first, a few per pass. Only these reads mark a copy gone (the shelf read without it, or
//      no shelf there); unloaded, no level, an error or a failed request change nothing;
//   3. pages: a few books whose pages the hub has not read yet are read once, by content hash, so search and
//      excerpts work.
// Any failed request or an unhealthy bridge ends the pass at once: what was not read is unknown, never gone.
import type { Database } from "bun:sqlite";
import {
  observerBook, observerGet, observerShelf, observerShelves, type ObserverEnvelope, type ObserverResult, type ObserverSource,
} from "./observer.ts";
import { applyNoShelf, applyShelf, applyUnknown, storeText, type BookRow, type CopyRow } from "./library.ts";

export interface LibraryScanOptions {
  /** Default 60 s. */
  intervalMs?: number;
  /** Discovery pages of 200 per pass; a longer list continues from its cursor next pass. Default 10. */
  maxPages?: number;
  /** Positions re-read per pass. Default 8. */
  rereads?: number;
  /** Books whose pages are read per pass. Default 3. */
  textReads?: number;
  /** A book whose pages could not be read is tried again after this. Default 10 min. */
  textRetryMs?: number;
  /** The bridge answers 503 `scanning` while its shelf scan runs: asked once more after this. Default 2 s (its Retry-After). */
  scanWaitMs?: number;
  now?: () => number;
  get?: typeof observerGet;
  log?: (line: string) => void;
}

export interface LibraryScanHealth {
  status: "unconfigured" | "unchecked" | "ok" | "stopped";
  /** Why the last pass stopped early: the bridge down, unhealthy, refusing, or an older bridge. */
  detail: string | null;
  checkedAt: number;
  okAt: number | null;
  /** Last complete pass: shelves listed, copies confirmed, positions re-read, page sets read. */
  last: { shelves: number; confirmed: number; reread: number; texts: number; truncated: boolean } | null;
}

class Stop extends Error {}

export class LibraryScan {
  private readonly o: Required<LibraryScanOptions>;
  private cursor: string | null = null;
  private running?: Promise<void>;
  private timers: Timer[] = [];
  private state: LibraryScanHealth;

  constructor(private readonly db: Database, private readonly source: ObserverSource | undefined, options: LibraryScanOptions = {}) {
    this.o = {
      intervalMs: options.intervalMs ?? 60_000, maxPages: options.maxPages ?? 10, rereads: options.rereads ?? 8,
      textReads: options.textReads ?? 3, textRetryMs: options.textRetryMs ?? 10 * 60_000, scanWaitMs: options.scanWaitMs ?? 2000,
      now: options.now ?? Date.now, get: options.get ?? observerGet, log: options.log ?? (line => console.error(line)),
    };
    this.state = { status: source ? "unchecked" : "unconfigured", detail: null, checkedAt: 0, okAt: null, last: null };
  }

  start() {
    if (!this.source) return;
    this.timers.push(setTimeout(() => void this.pass(), 15_000), setInterval(() => void this.pass(), this.o.intervalMs));
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
  health(): LibraryScanHealth { return this.state; }

  /** One pass; a pass still running is not doubled. */
  pass(): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.running ??= this.passOnce(this.source).catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!(error instanceof Stop)) this.o.log(`library scan failed: ${detail}`);
      if (this.state.detail !== detail && error instanceof Stop) this.o.log(`library scan stopped: ${detail}`);
      this.state = { ...this.state, status: "stopped", detail, checkedAt: this.o.now() };
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Throws Stop when the bridge did not answer, or answered while not `ok`: nothing more is read this pass. */
  private healthy<T>(reply: ObserverResult<T>, what: string): ObserverEnvelope & T {
    if (!reply.ok) throw new Stop(`${what}: ${reply.status}: ${reply.detail}`);
    if (reply.data.state !== "ok") throw new Stop(`${what}: the bridge is ${reply.data.state}${reply.data.stateDetail ? ` (${reply.data.stateDetail})` : ""}`);
    return reply.data;
  }

  private async passOnce(source: ObserverSource) {
    const confirmed = new Set<number>();
    let shelves = 0, truncated = false, after = this.cursor;
    for (let page = 0; page < this.o.maxPages; page++) {
      let reply = await observerShelves(source, { after, limit: 200 }, this.o.get);
      if (!reply.ok && reply.httpStatus === 503 && reply.code === "scanning") {
        await Bun.sleep(this.o.scanWaitMs);
        reply = await observerShelves(source, { after, limit: 200 }, this.o.get);
      }
      const list = this.healthy(reply, "shelf list").shelves;
      // A shelf the bridge could not list completely (a malformed or oversized book) is unknown: its copies wait for a re-read.
      for (const item of list.items) if (item.status === "observed") for (const id of applyShelf(this.db, item, list.scannedAt, false)) confirmed.add(id);
      shelves += list.items.length;
      truncated ||= list.truncated;
      after = list.next;
      if (!after) break;
    }
    // A list longer than this pass reads continues from here next pass; its end starts again from the beginning.
    this.cursor = after;

    const standing = this.db.query<CopyRow, []>("SELECT * FROM library_copies WHERE source = 'server' AND state = 'here'").all();
    const places = new Map<string, { dimension: string; pos: [number, number, number]; last: number }>();
    for (const copy of standing) {
      if (confirmed.has(copy.id)) continue;
      const key = `${copy.dimension} ${copy.x} ${copy.y} ${copy.z}`, last = Math.max(copy.seen_at, copy.checked_at ?? 0);
      const known = places.get(key);
      if (!known) places.set(key, { dimension: copy.dimension, pos: [copy.x, copy.y, copy.z], last });
      else known.last = Math.min(known.last, last);
    }
    const due = [...places.values()].sort((a, b) => a.last - b.last).slice(0, this.o.rereads);
    for (const place of due) {
      const shelf = this.healthy(await observerShelf(source, place, this.o.get), `read of ${place.pos.join(",")}`).shelf, at = this.o.now();
      if (shelf.status === "observed") applyShelf(this.db, shelf, at, true);
      else if (shelf.status === "no_shelf") applyNoShelf(this.db, place, shelf.block, at);
      else applyUnknown(this.db, place, shelf.status, at);
    }

    const books = this.db.query<BookRow & { copy: number }, [number, number]>(`SELECT b.*, (SELECT c.id FROM library_copies c WHERE c.book_id = b.id AND c.source = 'server'
        AND c.state = 'here' ORDER BY c.seen_at DESC LIMIT 1) AS copy FROM library_books b
      WHERE b.pages_json IS NULL AND (b.text_failed_at IS NULL OR b.text_failed_at < ?) AND copy IS NOT NULL ORDER BY b.id LIMIT ?`)
      .all(this.o.now() - this.o.textRetryMs, this.o.textReads);
    let texts = 0;
    for (const book of books) {
      const copy = this.db.query<CopyRow, [number]>("SELECT * FROM library_copies WHERE id = ?").get(book.copy)!;
      const read = this.healthy(await observerBook(source, { dimension: copy.dimension, pos: [copy.x, copy.y, copy.z], slot: copy.slot ?? 0 }, this.o.get), `pages of #${book.id}`).book;
      const at = this.o.now();
      // Another book in that slot now, or none: the re-reads will settle where it is; only its pages are wanted here.
      if (read.status === "observed" && read.book?.contentHash === book.content_hash && storeText(this.db, book, read.pages, "server", at)) texts++;
      else this.db.query("UPDATE library_books SET text_failed_at = ? WHERE id = ?").run(at, book.id);
    }
    const at = this.o.now();
    this.state = { status: "ok", detail: null, checkedAt: at, okAt: at, last: { shelves, confirmed: confirmed.size, reread: due.length, texts, truncated } };
  }
}
