// Written books (write_book, read_book), the book catalogue in the hub (book_register, book_find, book_report,
// book_update) and records for a historian (records). Books go through Synapse's /book endpoint, which does what
// the book-and-quill editor does with its own font and limits; the catalogue stores the text the body read from
// the real item, never text the model typed for it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Body } from "./body.ts";
import type { CommonsClient } from "./commons.ts";
import { nonempty, type BookRead, type Stack, type State } from "./synapse.ts";
import { bookContentHash, RECORD_KINDS, type BookContent, type Position } from "../../commons/src/resident-contracts-library.ts";

const coordinate = z.number().finite().transform(Math.floor);
const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), "Use one line.");
/** Which book: the one in your hand (default), the offhand, the open lectern, or an inventory slot (0..8 hotbar, 9..35). */
const from = z.union([z.enum(["held", "offhand", "lectern"]), z.number().int().min(0).max(35)]);
const at = z.union([z.literal("sights"), z.object({ x: coordinate, y: coordinate, z: coordinate }).strict()]);
const subjects = z.array(line(40)).max(6);

export const bookDefinitions = {
  write_book: {
    description: "Write a book and quill from your inventory in one call, as its editor would, and sign it with a title (or with draft: true leave it an unsigned book and quill). Give text (laid out into pages the way the editor fits them: about 14 short lines a page, at most 1023 characters, breaking between words; line breaks kept) or your own pages. Limits are the game's: at most 100 pages, a title of 1..15 characters, no section sign (§). Uses an empty book and quill; one that already has writing is replaced only with replace: true. Needs no screen open. Says what was written and where the book is now.",
    schema: z.object({
      title: z.string().trim().min(1).max(15, "A book title holds at most 15 characters.").optional(),
      text: z.string().min(1).max(110_000).optional(),
      pages: z.array(z.string().max(1023)).min(1).max(100).optional(),
      draft: z.boolean().optional(),
      replace: z.boolean().optional(),
    }).strict().refine(a => (a.text === undefined) !== (a.pages === undefined), "Give text or pages, not both.")
      .refine(a => a.draft === true || a.title !== undefined, "A signed book needs a title; use draft: true to keep it unsigned."),
  },
  read_book: {
    description: "Read a written book or a book and quill you can read now: in your hand (default), offhand, an inventory slot, or on a lectern whose screen is open (use the lectern first). A book in a chiseled bookshelf has to be taken out to be read: use the shelf where the book stands (its front is six slots, three across and two high) and it goes into your inventory; read it; use an empty slot holding it to put it back. Shows whole pages from page (default 1); a long book continues with page, and a page too long for one reply continues with at (a character offset); the reply gives the exact handle.",
    schema: z.object({ from: from.optional(), page: z.number().int().min(1).max(100).optional(), at: z.number().int().min(0).max(32_767).optional() }).strict(),
  },
  book_register: {
    description: "Put a written book in the shared book catalogue so neighbours can find it: your body reads its text from the book (in hand by default, or from: an inventory slot, offhand, or the open lectern), and at says where it is or will be (the block in your sights by default, such as the shelf or lectern, or x,y,z). Optional facility (a registered facility's name, such as your library), subjects and note. A book is for knowledge worth reading in full; a shared note (note_share) is a short tip. The same text in the same place twice is refused unless another_copy: true.",
    schema: z.object({ from: from.optional(), at: at.optional(), facility: line(60).optional(), subjects: subjects.optional(), note: line(200).optional(), another_copy: z.boolean().optional() }).strict(),
  },
  book_find: {
    description: "Search the book catalogue by words in the title, author, subjects or text, by author or subject; or show one book by id with its place history and copies. Says where each copy is (nearest first, with distance), whether the server saw it on a registered shelf, and a short excerpt; the full text is in the book itself. limit: default 5, at most 10.",
    schema: z.object({ query: line(120).optional(), author: line(64).optional(), subject: line(40).optional(), id: z.number().int().positive().optional(), limit: z.number().int().min(1).max(10).optional(), page: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  book_report: {
    description: "Say where a catalogued book really is: found (at the block in your sights, or x,y,z; if that is somewhere else the catalogue now lists it there, with your name) or missing (not where it is listed). check reads the book you hold or the open lectern first, so the catalogue knows it is the same text. Anyone may report; this never moves a book.",
    schema: z.object({ id: z.number().int().positive(), found: z.boolean().optional(), missing: z.boolean().optional(), at: at.optional(), check: from.optional(), note: line(200).optional() }).strict()
      .refine(a => (a.found === true) !== (a.missing === true), "Give found: true or missing: true."),
  },
  book_update: {
    description: "For a book you registered: replace its subjects or note, or withdraw it from the catalogue (withdraw: true; the book itself stays where it is).",
    schema: z.object({ id: z.number().int().positive(), subjects: subjects.optional(), note: z.string().trim().max(200).optional(), withdraw: z.boolean().optional() }).strict(),
  },
  records: {
    description: "What the shared records hold, dated, each line marked with its source: [server] the game server recorded it, [hub] the hub received it from a resident when it happened (their word), [chat] public game chat. kind: summary (counts), deaths, alarms, agreements (yours and public ones), facilities, places, books, sessions (who was online when), crossings (dimension changes), advancements (with when each criterion was met), stats, building (blocks placed and broken by area), flows (container counts at registered facilities), said (public chat residents could have seen), projects (your own finished plans). since/until: \"6h\", \"3d\" or a date/time (UTC), default the last 24 hours; resident narrows to one player; around: {radius, x?, z?} narrows to an area (default your position). Long replies continue with page.",
    schema: z.object({
      kind: z.enum([...RECORD_KINDS, "projects"]),
      resident: z.string().regex(/^\w{1,16}$/, "Use an in-game player name.").optional(),
      since: line(40).optional(), until: line(40).optional(),
      around: z.object({ radius: z.number().int().min(1).max(4096), x: coordinate.optional(), z: coordinate.optional() }).strict().optional(),
      page: z.number().int().min(1).max(1000).optional(),
    }).strict(),
  },
};
type Args<K extends keyof typeof bookDefinitions> = z.infer<(typeof bookDefinitions)[K]["schema"]>;
type From = z.infer<typeof from>;

const WRITABLE = "minecraft:writable_book", WRITTEN = "minecraft:written_book";
const REPLY_CHARS = 1150;
const isBook = (item: string) => item === WRITABLE || item === WRITTEN;
const slotName = (slot: number) => slot === 40 ? "your offhand" : slot < 9 ? `H${slot}` : `inventory slot ${slot}`;
const generationName = (generation = 0) => ["original", "copy of original", "copy of a copy", "tattered"][generation] ?? "copy";
const quote = (text: string, length = 40) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > length ? `${flat.slice(0, length - 1)}…` : flat}"`;
};

/** A Synapse built before /book answers that it does not know the endpoint; say what that means for the body. */
async function synapseBook<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown endpoint|not found|404/i.test(message)) throw new Error("This body's Synapse has no /book endpoint (an older build): books can only be written by hand, with use, type_text and click_button, and read with picture.");
    throw error;
  }
}

function heldStacks(state: State): Stack[] {
  const main = state.inventory?.main ?? state.hotbar;
  const offhand = state.inventory?.offhand;
  return [...main.filter(nonempty), ...(offhand && nonempty(offhand) ? [{ ...offhand, slot: 40 }] : [])];
}

export class Books {
  /** How long write_book waits for the server to put the signed book in the slot. */
  writeWaitMs = 3000;
  now: () => number = Date.now;
  constructor(private body: Body, private commons: CommonsClient) {}

  /** The book a resident means, read through Synapse, and where it was read from. */
  private async resolve(choice: From | undefined): Promise<{ book: BookRead; label: string; readFrom: "inventory" | "lectern"; slot?: number }> {
    const api = this.body.api;
    if (choice === "lectern") return { book: await synapseBook(() => api.book("lectern")), label: "the lectern", readFrom: "lectern" };
    const state = await api.state(true);
    let slot: number | undefined;
    if (typeof choice === "number") slot = choice;
    else if (choice === "offhand") slot = 40;
    else if (choice === "held") slot = state.selectedSlot;
    else {
      const held = state.hotbar.find(stack => stack.slot === state.selectedSlot && nonempty(stack));
      if (held && isBook(held.item)) slot = state.selectedSlot;
      else if (state.screen === "LecternScreen") return { book: await synapseBook(() => api.book("lectern")), label: "the lectern", readFrom: "lectern" };
      else {
        const books = heldStacks(state).filter(stack => isBook(stack.item));
        if (books.length === 1) slot = books[0]!.slot;
        else if (books.length > 1) throw new Error(`You carry ${books.length} books (${books.map(stack => `${slotName(stack.slot)}: ${stack.item === WRITTEN ? "written book" : "book and quill"}`).join(", ")}); say which with from.`);
        else {
          const shelf = state.lookingAt.block === "minecraft:chiseled_bookshelf";
          throw new Error(shelf
            ? "You carry no book. A book in a chiseled bookshelf cannot be read in place: use the shelf where the book stands to take it into your inventory, read it, then use an empty slot of the shelf holding it to put it back."
            : "You carry no written book or book and quill, and no lectern is open (use a lectern first to read its book).");
        }
      }
    }
    const book = await synapseBook(() => api.book(slot!));
    return { book, label: slotName(slot), readFrom: "inventory", slot };
  }

  /** Where at points: the block in the sights (with its id), or coordinates in the body's dimension. */
  private async place(target: z.infer<typeof at> | undefined): Promise<{ at: Position; holder?: string }> {
    const state = await this.body.api.state();
    if (target && target !== "sights") return { at: { ...target, dimension: state.dimension } };
    const sights = state.lookingAt;
    if (sights.type !== "block" || !sights.blockPos) throw new Error("Look at the shelf, lectern or chest where the book is (or will be), or give at: {x, y, z}.");
    const [x, y, z] = sights.blockPos as [number, number, number];
    return { at: { x, y, z, dimension: state.dimension }, holder: sights.block };
  }

  private written(read: { book: BookRead; label: string }): BookContent {
    const { book } = read;
    if (book.kind !== "written" || !book.title || !book.author) throw new Error(`The book in ${read.label} is ${book.kind === "writable" ? "a book and quill, not yet signed" : "not signed"}; only signed written books are catalogued (their text cannot change).`);
    return { kind: "written", title: book.title, author: book.author, generation: book.generation ?? 0, pages: book.pages };
  }

  async write(args: Args<"write_book">): Promise<string> {
    const api = this.body.api;
    const state = await api.state(true);
    if (state.health <= 0) throw new Error("You are dead.");
    if (state.screen !== "none") throw new Error(`${state.screen} is open; close it first. The book editor opens only with no screen open.`);
    const quills = heldStacks(state).filter(stack => stack.item === WRITABLE);
    if (!quills.length) throw new Error("No book and quill in your inventory. One is crafted from a book, an ink sac and a feather (recipes writable_book).");
    // Never write over someone's draft by accident: read each candidate first, the one in hand first.
    const order = [...quills].sort((a, b) => Number(b.slot === state.selectedSlot) - Number(a.slot === state.selectedSlot) || Number(a.slot === 40) - Number(b.slot === 40) || a.slot - b.slot);
    const drafts: string[] = [];
    let chosen: Stack | undefined;
    for (const stack of order.slice(0, 6)) {
      const read = await synapseBook(() => api.book(stack.slot));
      if (read.pages.every(page => !page) || args.replace) { chosen = stack; break; }
      drafts.push(`${slotName(stack.slot)} (${read.pages.length} page${read.pages.length === 1 ? "" : "s"}, begins ${quote(read.pages[0] ?? "")})`);
    }
    if (!chosen) throw new Error(`Every book and quill you carry already has writing: ${drafts.join("; ")}. read_book shows it; replace: true writes over the first one.`);
    const heldItem = state.hotbar.find(stack => stack.slot === state.selectedSlot && nonempty(stack))?.item;
    if (chosen.slot === 40 && heldItem === WRITABLE) throw new Error("Your hand holds a book and quill with writing, and the editor writes into the one in hand: select another hotbar slot first.");
    let pages: string[];
    if (args.text !== undefined) {
      const layout = await synapseBook(() => api.bookLayout(args.text!));
      if (!layout.fits) {
        const last = layout.pages.at(-1) ?? "";
        throw new Error(`Too long for one book: it fills all ${layout.maxPages} pages and more (page ${layout.maxPages} would end with ${quote(last.slice(-40))}). Shorten it, or write it as two books.`);
      }
      pages = layout.pages;
    } else pages = args.pages!;
    // The book has to be in hand: the selected hotbar slot, or the offhand.
    let slot = chosen.slot, moved = "";
    const before = state.selectedSlot;
    if (slot >= 9 && slot !== 40) {
      const target = Array.from({ length: 9 }, (_, i) => i).find(i => !state.hotbar.some(stack => stack.slot === i && nonempty(stack))) ?? state.selectedSlot;
      await this.body.openInventory();
      await api.gui({ action: "clickSlot", slot, button: target, mode: "SWAP" });
      const closed = await this.body.closeScreen();
      if (closed.after !== "none") throw new Error(`Moved the book and quill to H${target}, but ${closed.after} is still open; nothing was written.`);
      const check = (await api.state(true)).hotbar.find(stack => stack.slot === target);
      if (check?.item !== WRITABLE) throw new Error(`The book and quill did not arrive in H${target}; nothing was written.`);
      moved = ` (moved there from inventory slot ${slot})`;
      slot = target;
    }
    if (slot !== 40 && slot !== state.selectedSlot) await api.player({ action: "selectHotbar", slot });
    try {
      const sent = await synapseBook(() => api.bookWrite(pages, args.draft ? undefined : args.title));
      const deadline = Date.now() + this.writeWaitMs;
      let after: BookRead | undefined;
      do {
        await Bun.sleep(150);
        after = await api.book(sent.slot).catch(() => undefined);
      } while (Date.now() < deadline && !(after && (args.draft ? after.kind === "writable" && after.pages.length === pages.length && after.pages.every((page, i) => page === pages[i]) : after.kind === "written")));
      const where = `${slotName(sent.slot)}${moved}`;
      const characters = pages.reduce((sum, page) => sum + page.length, 0);
      const outline = `Pages: ${pages.slice(0, 4).map((page, i) => `${i + 1} ${quote(page, 28)}`).join(", ")}${pages.length > 4 ? `, … ${pages.length} ${quote(pages.at(-1)!, 28)}` : ""}.`;
      if (args.draft) {
        if (after?.kind === "writable" && after.pages.length === pages.length) return `Saved ${pages.length} page${pages.length === 1 ? "" : "s"} (${characters} characters) in the book and quill in ${where}; it is not signed and can still be changed. ${outline}`;
        return `Sent ${pages.length} pages to the server for the book and quill in ${where}, but it does not show them yet; read_book to see what it holds.`;
      }
      if (after?.kind !== "written") return `Sent "${args.title}" (${pages.length} pages) to the server to sign, but ${where} does not show a written book after ${this.writeWaitMs / 1000} s (${after ? `it holds ${after.item}` : "it could not be read"}). read_book or inventory shows what happened; nothing is retried.`;
      const differs = after.pages.findIndex((page, i) => page !== pages[i]);
      return [
        `Signed "${after.title}" by ${after.author}: ${after.pages.length} page${after.pages.length === 1 ? "" : "s"}, ${characters} characters, now a written book in ${where}.`,
        outline,
        ...(differs >= 0 || after.pages.length !== pages.length ? [`The server's copy differs from what was sent from page ${Math.max(differs, 0) + 1}: read_book shows the book as it is.`] : []),
        "Copies: at a crafting table, this book with one to eight books and quills makes that many copies and keeps the original (lay them out with click_slot; craft does not); copies of copies cannot be copied.",
      ].join("\n");
    } finally {
      if (slot !== 40 && slot !== before) await api.player({ action: "selectHotbar", slot: before }).catch(() => {});
    }
  }

  /** `budget`: characters the reply may use; the tool server gives what its event tail leaves (see Tools.call). */
  async read(args: Args<"read_book">, budget = REPLY_CHARS): Promise<string> {
    const read = await this.resolve(args.from);
    const { book } = read;
    const head = book.kind === "written"
      ? `"${book.title}" by ${book.author} (${generationName(book.generation)}), ${book.pageCount} page${book.pageCount === 1 ? "" : "s"}; from ${read.label}${book.source === "lectern" ? `, open at page ${(book.page ?? 0) + 1}` : ""}.`
      : `A book and quill (not signed), ${book.pageCount} page${book.pageCount === 1 ? "" : "s"}; from ${read.label}.`;
    if (!book.pages.length || book.pages.every(page => !page)) return `${head}\nIt is empty.`;
    const start = args.page ?? 1, offset = args.at ?? 0;
    if (start > book.pages.length) return `${head}\nThere is no page ${start}.`;
    const fromArg = typeof args.from === "number" ? args.from : args.from ? `"${args.from}"` : read.slot === 40 ? `"offhand"` : read.slot !== undefined ? read.slot : `"lectern"`;
    const handle = (page: number, at?: number) => `Continue: read_book {from: ${fromArg}, page: ${page}${at ? `, at: ${at}` : ""}}`;
    // A page written outside the editor (a command, an older item) can hold up to 32,767 characters: read it in
    // pieces. The handle carries the character offset, so pieces join exactly whatever each reply's room was.
    const room = Math.max(100, budget - head.length - 120);
    const first = book.pages[start - 1]!;
    if (first.length > room || offset > 0) {
      if (offset >= first.length) return `${head}\nPage ${start} has ${first.length} characters.`;
      const end = Math.min(first.length, offset + room);
      // The handle goes first: if a reply is ever cut, it is the text that is cut, not the way on.
      return [head, ...(end < first.length ? [handle(start, end)] : start < book.pages.length ? [handle(start + 1)] : []),
        `— page ${start}, characters ${offset + 1}-${end} of ${first.length} —`, first.slice(offset, end)].join("\n");
    }
    const out = [head];
    let size = head.length + 60, next = start;
    for (let index = start; index <= book.pages.length; index++) {
      const text = `— page ${index} —\n${book.pages[index - 1]}`;
      if (index > start && size + text.length > budget) break;
      out.push(text); size += text.length + 1; next = index + 1;
    }
    if (next <= book.pages.length) out.splice(1, 0, handle(next));
    return out.join("\n");
  }

  async register(args: Args<"book_register">): Promise<string> {
    const read = await this.resolve(args.from);
    const book = this.written(read);
    const where = await this.place(args.at);
    return this.commons.call<string>("library", "register", {
      book, read_from: read.readFrom, at: where.at, ...(where.holder ? { holder: where.holder } : {}),
      ...(args.facility ? { facility: args.facility } : {}), ...(args.subjects ? { subjects: args.subjects } : {}),
      ...(args.note ? { note: args.note } : {}), ...(args.another_copy ? { another_copy: true } : {}),
    });
  }

  async find(args: Args<"book_find">): Promise<string> {
    const state = await this.body.api.state().catch(() => undefined);
    const near = state ? { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z), dimension: state.dimension } : undefined;
    return this.commons.call<string>("library", "find", { ...args, ...(near ? { near } : {}) });
  }

  async report(args: Args<"book_report">): Promise<string> {
    let checked: { content_hash: string; read_from: "inventory" | "lectern" } | undefined;
    if (args.check !== undefined) {
      const read = await this.resolve(args.check);
      checked = { content_hash: bookContentHash(this.written(read)), read_from: read.readFrom };
    }
    const where = args.found ? await this.place(args.at) : undefined;
    return this.commons.call<string>("library", "report", {
      id: args.id, kind: args.found ? "found" : "missing",
      ...(where ? { at: where.at, ...(where.holder ? { holder: where.holder } : {}) } : {}),
      ...(checked ? { checked } : {}), ...(args.note ? { note: args.note } : {}),
    });
  }

  update(args: Args<"book_update">): Promise<string> {
    return this.commons.call<string>("library", "update", args);
  }

  async records(args: Args<"records">): Promise<string> {
    const now = this.now();
    const until = args.until ? when(args.until, now, "until") : undefined;
    const since = args.since ? when(args.since, until ?? now, "since") : undefined;
    let area: { x: number; z: number; radius: number; dimension?: string } | undefined;
    if (args.around) {
      const state = await this.body.api.state();
      area = { x: args.around.x ?? Math.floor(state.pos.x), z: args.around.z ?? Math.floor(state.pos.z), radius: args.around.radius, dimension: state.dimension };
    }
    if (args.kind === "projects") return this.projects(since ?? (until ?? now) - 86_400_000, until ?? now, args.page ?? 1);
    const text = await this.commons.call<string>("records", "query", {
      kind: args.kind, ...(args.resident ? { resident: args.resident } : {}), ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}), ...(area ? { area } : {}), ...(args.page ? { page: args.page } : {}),
    });
    // The hub leaves out players nobody perceives; so does the body, in case its list is longer.
    const unseen = (this.body.config.unseen ?? []).map(name => name.toLowerCase());
    return text.split("\n").filter(lineText => !(lineText.toLowerCase().match(/\w+/g) ?? []).some(word => unseen.includes(word))).join("\n");
  }

  /** The resident's own finished plans, from plan.json: their word, as plan_finish recorded it. */
  private async projects(since: number, until: number, page: number): Promise<string> {
    const ending = z.object({ name: z.string(), ended: z.number(), outcome: z.enum(["done", "dropped"]).optional(), evidence: z.string().optional(), unlocks: z.string().optional() });
    let history: z.infer<typeof ending>[] = [];
    try {
      const stored = z.object({ history: z.array(ending.passthrough()).optional() }).passthrough().parse(JSON.parse(await readFile(join(this.body.config.residentDir, "plan.json"), "utf8")));
      history = stored.history ?? [];
    } catch { history = []; }
    const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const lines = history.filter(plan => plan.ended >= since && plan.ended < until).sort((a, b) => a.ended - b.ended)
      .map(plan => `${stamp(plan.ended)} project "${plan.name}" ${plan.outcome ?? "ended"}${plan.evidence ? `: ${plan.evidence}` : ""}${plan.unlocks ? `; unlocks ${plan.unlocks}` : ""} [your own plan record; your word]`);
    const perPage = 8, shown = lines.slice((page - 1) * perPage, page * perPage);
    return [`Your own projects ended ${stamp(since)} to ${stamp(until)} (plan.json keeps the last ten endings; others' plans are theirs). Shared projects show in records kind agreements.`,
      ...(shown.length ? shown : ["None in this window."]), ...(lines.length > page * perPage ? [`Continue: records kind=projects page=${page + 1}`] : [])].join("\n");
  }
}

/** "6h", "30m", "2d" back from `reference`, or a date/time read as UTC unless it names a zone. */
export function when(text: string, reference: number, label: string): number {
  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(text.trim());
  if (relative) {
    const unit = relative[2]!.toLowerCase().startsWith("m") ? 60_000 : relative[2]!.toLowerCase().startsWith("h") ? 3_600_000 : 86_400_000;
    return Math.round(reference - Number(relative[1]) * unit);
  }
  const zoned = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text.trim()) || !/\d{1,2}:\d{2}/.test(text) ? text.trim() : `${text.trim().replace(" ", "T")}Z`;
  const at = Date.parse(zoned);
  if (!Number.isFinite(at)) throw new Error(`${label}: "${text}" is neither a span such as 6h or 2d nor a date such as 2026-11-23 or 2026-11-23 14:00.`);
  return at;
}
