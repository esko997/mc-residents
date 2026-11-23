// A stand-in for the server bridge's library, snapshot and watch endpoints (bridge 0.3 shapes), as an injectable
// `get`: a small world of shelves, lecterns and resident bodies that tests change between calls.
import type { ObserverReach } from "../src/observer.ts";
import { bookContentHash, type HashedBook } from "../src/resident-contracts-library.ts";

export const OVERWORLD = "minecraft:overworld", NETHER = "minecraft:the_nether";
export const SHELF = "minecraft:chiseled_bookshelf", LECTERN = "minecraft:lectern";
export type FakeBook = HashedBook | { kind: "enchanted" | "plain" } | { kind: "other"; item: string };
export interface FakeShelf { block: string; slots: (FakeBook | null)[] }
export interface FakeBody { x: number; y: number; z: number; dimension?: string; online?: boolean; atMs?: number }

export const written = (title: string, author: string, pages: string[], generation = 0): HashedBook => ({ kind: "written", title, author, generation, pages });
export const quill = (pages: string[]): HashedBook => ({ kind: "writable", title: null, author: null, generation: null, pages });
const key = (dimension: string, x: number, y: number, z: number) => `${dimension} ${x} ${y} ${z}`;

export function fakeBridge(clock: () => number) {
  const world = {
    /** The bridge's own health in every reply. */
    state: "ok",
    /** Every request fails as if the server or tunnel were down. */
    down: false,
    /** Fail every request after this many more (null: never): the bridge going down in the middle of a pass. */
    failAfter: null as number | null,
    shelves: new Map<string, FakeShelf>(),
    /** Positions whose chunk is not loaded: in no list, and unreadable. */
    unloaded: new Set<string>(),
    /** What stands at a position that holds no shelf (default air). */
    blocks: new Map<string, string>(),
    bodies: new Map<string, FakeBody>(),
    /** The list says it was cut after this many items (null: complete). */
    cutAfter: null as number | null,
    /** How old the discovery list is, ms. */
    listAge: 0,
    /** Shelves that stand but cannot be listed completely (a malformed book): status `invalid`, no slots. */
    invalid: new Set<string>(),
    /** The shelf list answers 503 `scanning` this many more times. */
    scanning: 0,
    requests: [] as string[],
    /** Runs as each request arrives, before it is answered: the world changing between two reads. */
    onRequest: undefined as ((path: string) => void) | undefined,
  };
  const put = (dimension: string, x: number, y: number, z: number, shelf: FakeShelf) => world.shelves.set(key(dimension, x, y, z), shelf);
  const envelope = (body: Record<string, unknown>): ObserverReach => ({
    ok: true, receivedAt: clock(),
    data: { schema: 1, source: "server-observer", consumer: "commons", scopes: ["residents", "facilities", "library", "status"], state: world.state, stateDetail: null, servedAtMs: clock(), heartbeatAtMs: clock(), ...body },
  });
  const ITEMS = { written: "minecraft:written_book", writable: "minecraft:writable_book", enchanted: "minecraft:enchanted_book", plain: "minecraft:book" };
  const info = (slot: number, book: FakeBook) => book.kind === "written" || book.kind === "writable"
    ? { slot, kind: book.kind, item: ITEMS[book.kind], title: book.title, author: book.author, generation: book.generation, pageCount: book.pages.length, contentHash: bookContentHash(book) }
    : { slot, kind: book.kind, item: book.kind === "other" ? book.item : ITEMS[book.kind], title: null, author: null, generation: null, pageCount: 0, contentHash: book.kind === "other" ? `other ${book.item}` : null };
  const slots = (shelf: FakeShelf) => shelf.slots.flatMap((book, slot) => book ? [info(slot, book)] : []);
  const shelfAt = (dimension: string, pos: number[]) => {
    const k = key(dimension, pos[0]!, pos[1]!, pos[2]!);
    if (world.unloaded.has(k)) return { dimension, pos, block: null, status: "unloaded", reason: "its chunk is not loaded", slots: [] };
    if (world.invalid.has(k)) return { dimension, pos, block: world.shelves.get(k)!.block, status: "invalid", reason: "slot 2: malformed book", slots: [] };
    const shelf = world.shelves.get(k);
    if (!shelf) return { dimension, pos, block: world.blocks.get(k) ?? "minecraft:air", status: "no_shelf", reason: "no chiseled bookshelf or lectern here", slots: [] };
    return { dimension, pos, block: shelf.block, status: "observed", reason: null, slots: slots(shelf) };
  };
  async function get(_source: unknown, path: string): Promise<ObserverReach> {
    world.requests.push(path);
    world.onRequest?.(path);
    if (world.failAfter !== null && world.failAfter-- <= 0) world.down = true;
    if (world.down) return { ok: false, status: "offline", detail: "The server observer did not answer (server down, tunnel down, or mod not loaded)." };
    const url = new URL(path, "http://bridge.test"), q = url.searchParams;
    const pos = (q.get("pos") ?? "").split(",").map(Number), dimension = q.get("dimension") ?? "";
    switch (url.pathname) {
      case "/v1/snapshot": return envelope({ snapshot: { seq: 1, builtAtMs: clock(), gameTime: 1, facilities: [], residents: [...world.bodies].map(([name, body]) => ({
        name, uuid: "00000000-0000-0000-0000-000000000000", online: body.online !== false, checkedAtMs: clock(), lastSeen: null,
        body: body.online === false ? null : { atMs: body.atMs ?? clock(), gameTime: 1, dimension: body.dimension ?? OVERWORLD, pos: { x: body.x, y: body.y, z: body.z }, health: 20, maxHealth: 20, food: 20, air: 300, maxAir: 300, gameMode: "survival", dead: false, sleeping: false, vehicle: null, xpLevel: 0 },
      })) } });
      case "/v1/library/shelf": return envelope({ shelf: shelfAt(dimension, pos) });
      case "/v1/library/book": {
        const read = shelfAt(dimension, pos), slot = Number(q.get("slot"));
        if (read.status !== "observed") return envelope({ book: { dimension, pos, block: read.block, status: read.status, reason: read.reason, book: null, pages: [] } });
        const book = world.shelves.get(key(dimension, pos[0]!, pos[1]!, pos[2]!))!.slots[slot];
        if (!book) return envelope({ book: { dimension, pos, block: read.block, status: "empty", reason: "no book in that slot", book: null, pages: [] } });
        if (book.kind !== "written" && book.kind !== "writable") return envelope({ book: { dimension, pos, block: read.block, status: "not_readable", reason: "no text", book: info(slot, book), pages: [] } });
        return envelope({ book: { dimension, pos, block: read.block, status: "observed", reason: null, book: info(slot, book), pages: book.pages } });
      }
      case "/v1/library/shelves": {
        if (world.scanning > 0) { world.scanning--; return { ok: false, status: "error", detail: "Observer: scanning", httpStatus: 503, code: "scanning" }; }
        const all = [...world.shelves].filter(([k, shelf]) => !world.unloaded.has(k) && (shelf.block === SHELF || shelf.slots.some(Boolean))).sort(([a], [b]) => a.localeCompare(b));
        const listed = world.cutAfter === null ? all : all.slice(0, world.cutAfter);
        const from = Number(q.get("after") ?? 0), limit = Number(q.get("limit"));
        const items = listed.slice(from, from + limit).map(([k]) => {
          const [dim, x, y, z] = k.split(" ");
          const { block, status, reason, slots: books } = shelfAt(dim!, [Number(x), Number(y), Number(z)]);
          return { dimension: dim, pos: [Number(x), Number(y), Number(z)], block, status, reason, slots: books, observedAtMs: clock() - world.listAge };
        });
        return envelope({ shelves: { items, next: from + limit < listed.length ? String(from + limit) : null, loadedOnly: true, scannedAtMs: clock() - world.listAge, completedAtMs: clock(), truncated: world.cutAfter !== null, total: all.length } });
      }
      default: return { ok: false, status: "error", detail: `Observer: no ${url.pathname}`, httpStatus: 404 };
    }
  }
  return { world, get, put, key, source: { url: "http://bridge.test", tokenFile: "/dev/null" } };
}
