import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export interface NotesPosition { x: number; y: number; z: number; dimension: string }
export interface NotesOptions {
  residentDir: string;
  residentName: string;
  sharedDir?: string;
  position: () => Promise<NotesPosition>;
  now?: () => number;
}

const block = z.number().finite().transform(Math.floor);
const placeSaveSchema = z.object({
  name: z.string().trim().min(1).max(40),
  note: z.string().max(240).optional(),
  x: block.optional(), y: block.optional(), z: block.optional(),
  shared: z.boolean().optional(),
  /** What the resident reports about a place to shelter in. Nothing here is checked by the body. */
  refuge: z.object({
    access: z.string().trim().min(1).max(120).optional(),
    hazards: z.string().trim().min(1).max(120).optional(),
    checked: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(args => [args.x, args.y, args.z].every(value => value === undefined) || [args.x, args.y, args.z].every(value => value !== undefined), {
  message: "Give x, y and z together, or omit all three to use the current position.",
});

export const notesDefinitions = {
  recall: {
    description: "Search your own Markdown notes by keywords. Returns short matching passages with file and line; use it instead of reading whole notes files.",
    schema: z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(8).optional() }).strict(),
  },
  place_save: {
    description: "Save an exact named block position. Places are cheap to keep and easier to reuse than prose coordinates. note: one short sentence on what is there (at most 240 characters). Omit x,y,z to use where you stand; shared:true lets the other residents see it. refuge (optional), for a place to shelter in: access (how to get in), hazards (what to watch for there), checked:true when you have just looked it over yourself; place_find shows these as your report and how long ago it was checked, never as a promise that it is safe. Saving a place again without checked keeps the last check time.",
    schema: placeSaveSchema,
  },
  place_find: {
    description: "List your saved places, shared places from the other residents, and recent deaths, nearest first with exact distance and direction. Optionally filter by name, note or refuge words; refuge lists the places saved with refuge notes.",
    schema: z.object({ query: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(10).optional() }).strict(),
  },
  place_remove: {
    description: "Remove your own private or shared place by exact name. You cannot remove another resident's shared place.",
    schema: z.object({ name: z.string().trim().min(1).max(40) }).strict(),
  },
};

export type RecallArgs = z.infer<typeof notesDefinitions.recall.schema>;
export type PlaceSaveArgs = z.infer<typeof notesDefinitions.place_save.schema>;
export type PlaceFindArgs = z.infer<typeof notesDefinitions.place_find.schema>;
export type PlaceRemoveArgs = z.infer<typeof notesDefinitions.place_remove.schema>;
/** A resident's keyword recall over its own notes, and its private and shared places. */
export interface Notes {
  recall(args: RecallArgs): Promise<string>;
  place_save(args: PlaceSaveArgs): Promise<string>;
  place_find(args: PlaceFindArgs): Promise<string>;
  place_remove(args: PlaceRemoveArgs): Promise<string>;
  /** Keeps the five most recent deaths, shown by place_find with their age. */
  recordDeath(pos: { x: number; y: number; z: number }, dimension: string): Promise<void>;
}

interface Place {
  name: string;
  note?: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  author: string;
  refuge?: Refuge;
}
/** A refuge as its author reported it; `checkedAt` is when they last said they had looked it over (ms since epoch). */
interface Refuge { access?: string; hazards?: string; checkedAt?: number }
interface Death { x: number; y: number; z: number; dimension: string; at: number }
interface Store { places: Place[]; deaths: Death[] }
interface LoadedStore { store: Store; notice?: string }

const storedPlace = z.object({
  name: z.string(), note: z.string().optional(),
  x: z.number().int(), y: z.number().int(), z: z.number().int(),
  dimension: z.string(), author: z.string(),
  refuge: z.object({ access: z.string().optional(), hazards: z.string().optional(), checkedAt: z.number().finite().optional() }).strict().optional(),
}).strict();
const storedDeath = z.object({
  x: z.number().int(), y: z.number().int(), z: z.number().int(),
  dimension: z.string(), at: z.number().finite(),
}).strict();
const storedData = z.object({
  places: z.array(storedPlace),
  deaths: z.array(storedDeath).optional(),
}).strict();
const emptyStore = (): Store => ({ places: [], deaths: [] });

async function readStore(path: string, label: string): Promise<LoadedStore> {
  try {
    const parsed = storedData.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return { store: emptyStore(), notice: `${label} places.json is corrupt; treated as empty` };
    return { store: { places: parsed.data.places, deaths: parsed.data.deaths ?? [] } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: emptyStore() };
    if (error instanceof SyntaxError) return { store: emptyStore(), notice: `${label} places.json is corrupt; treated as empty` };
    throw error;
  }
}

async function writeStore(path: string, store: Store): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.places.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function withStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt % 50 === 49) {
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await rm(lockPath, { force: true });
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
      }
      await sleep(10);
    }
  }
  if (!handle) throw new Error(`Timed out waiting for ${path}.lock`);
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

interface Passage { file: string; line: number; text: string; matched: number }
const excludedNames = new Set(["AGENTS.md", "CLAUDE.md", "basics.md", "difficulties.md"]);
const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/;
const heading = /^\s{0,3}#{1,6}(?:\s|$)/;

function passages(file: string, source: string, words: string[]): Passage[] {
  const result: Passage[] = [];
  let lines: string[] = [];
  let start = 1;
  let kind: "paragraph" | "list" | undefined;
  const flush = () => {
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      const lower = text.toLowerCase();
      const matched = words.filter(word => lower.includes(word)).length;
      if (matched) result.push({ file, line: start, text, matched });
    }
    lines = [];
    kind = undefined;
  };
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) { flush(); continue; }
    if (listItem.test(line) || heading.test(line)) {
      flush();
      start = index + 1;
      lines = [line];
      kind = listItem.test(line) ? "list" : "paragraph";
      if (heading.test(line)) flush();
      continue;
    }
    if (kind === "list" && !/^\s+\S/.test(line)) flush();
    if (!lines.length) { start = index + 1; kind = "paragraph"; }
    lines.push(line);
  }
  flush();
  return result;
}

async function noteFiles(residentDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of ["memory.md", "journal.md", "notebook.md"]) {
    try {
      await stat(join(residentDir, name));
      files.push(join(residentDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "archive") await walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".md") && !excludedNames.has(entry.name)) files.push(join(dir, entry.name));
    }
  };
  await walk(join(residentDir, "notes"));
  return files;
}

function fitRecall(matches: Passage[], limit: number): string {
  const selected = matches.slice(0, limit);
  const output: string[] = [];
  for (const match of selected) {
    const prefix = `${match.file}:${match.line} `;
    const remainingAfter = matches.length - output.length - 1;
    const footer = remainingAfter > 0 ? `\n${remainingAfter} more matches.` : "";
    const separator = output.length ? "\n" : "";
    const available = 1200 - separator.length - footer.length - output.join("\n").length - prefix.length;
    if (available < 1) break;
    const passage = match.text.length <= available ? match.text : `${match.text.slice(0, Math.max(0, available - 3)).trimEnd()}...`;
    output.push(`${prefix}${passage}`);
  }
  const remaining = matches.length - output.length;
  return output.join("\n") + (remaining > 0 ? `\n${remaining} more matches.` : "");
}

function distanceText(distance: number): string {
  return (Math.round(distance * 10) / 10).toString();
}

function compass(dx: number, dy: number, dz: number): string {
  if (Math.hypot(dx, dz) < 1e-9) return dy > 0 ? "above" : dy < 0 ? "below" : "here";
  const directions = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const degrees = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  return directions[Math.round(degrees / 45) % 8]!;
}

function coordinates(entry: { x: number; y: number; z: number }): string {
  return `(${entry.x},${entry.y},${entry.z})`;
}

/** "12 min ago", "5 h ago", "3 days ago". */
function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

/** A refuge as its author reported it, never as a promise: what they said and when they last looked it over. */
function refugeText(refuge: Refuge, at: number): string {
  const parts = [
    ...(refuge.access ? [`access: ${refuge.access}`] : []),
    ...(refuge.hazards ? [`hazards: ${refuge.hazards}`] : []),
    refuge.checkedAt === undefined ? "never checked" : `checked ${ago(at - refuge.checkedAt)}`,
  ];
  return `; refuge as reported: ${parts.join("; ")}`;
}

function appendNotices(reply: string, notices: string[]): string {
  return reply + (notices.length ? `\n${notices.join("\n")}` : "");
}

export function createNotes(options: NotesOptions): Notes {
  const sharedDir = options.sharedDir ?? join(dirname(options.residentDir), "shared");
  const privatePath = join(options.residentDir, "places.json");
  const sharedPath = join(sharedDir, "places.json");
  const now = options.now ?? Date.now;

  const recall = async (args: RecallArgs): Promise<string> => {
    const words = [...new Set(args.query.toLowerCase().split(/\s+/).filter(Boolean))];
    const matches: Passage[] = [];
    const files = await noteFiles(options.residentDir);
    for (const path of files) {
      const file = relative(options.residentDir, path);
      matches.push(...passages(file, await readFile(path, "utf8"), words));
    }
    const ranked = matches.sort((a, b) => b.matched - a.matched || b.line - a.line || a.file.localeCompare(b.file));
    if (!ranked.length) {
      const searched = files.map(path => relative(options.residentDir, path));
      const names = searched.length ? searched.join(", ") : "memory.md, journal.md, notebook.md, notes/**/*.md";
      return `No matches for "${args.query}". Searched: ${names}.`.slice(0, 1200);
    }
    return fitRecall(ranked, args.limit ?? 4);
  };

  const place_save = async (args: PlaceSaveArgs): Promise<string> => {
    const position = await options.position();
    const entry: Place = {
      name: args.name,
      x: args.x ?? Math.floor(position.x),
      y: args.y ?? Math.floor(position.y),
      z: args.z ?? Math.floor(position.z),
      dimension: position.dimension,
      author: options.residentName,
    };
    if (args.note !== undefined) entry.note = args.note;
    if (args.refuge) {
      entry.refuge = {};
      if (args.refuge.access !== undefined) entry.refuge.access = args.refuge.access;
      if (args.refuge.hazards !== undefined) entry.refuge.hazards = args.refuge.hazards;
      if (args.refuge.checked) entry.refuge.checkedAt = now();
    }
    const path = args.shared ? sharedPath : privatePath;
    const label = args.shared ? "shared" : "private";
    return withStoreLock(path, async () => {
      const loaded = await readStore(path, label);
      const existing = loaded.store.places.find(place => place.name === args.name);
      if (args.shared && existing && existing.author !== options.residentName) {
        return appendNotices(`Shared place "${args.name}" belongs to ${existing.author}; not overwritten.`, loaded.notice ? [loaded.notice] : []);
      }
      const previous = loaded.store.places.find(place => place.name === args.name && place.author === options.residentName);
      // A report saved again without a fresh check keeps the time of the last one.
      if (entry.refuge && entry.refuge.checkedAt === undefined && previous?.refuge?.checkedAt !== undefined) entry.refuge.checkedAt = previous.refuge.checkedAt;
      loaded.store.places = loaded.store.places.filter(place => !(place.name === args.name && place.author === options.residentName));
      loaded.store.places.push(entry);
      await writeStore(path, loaded.store);
      const refuge = entry.refuge ? ` with refuge notes (${args.refuge?.checked ? "checked now" : entry.refuge.checkedAt === undefined ? "never checked" : `last checked ${ago(now() - entry.refuge.checkedAt)}`})` : "";
      return appendNotices(`Saved ${args.shared ? "shared " : ""}place "${args.name}" at ${coordinates(entry)} in ${entry.dimension}${refuge}.`, loaded.notice ? [loaded.notice] : []);
    });
  };

  const place_find = async (args: PlaceFindArgs): Promise<string> => {
    const position = await options.position();
    const [privateStore, sharedStore] = await Promise.all([
      readStore(privatePath, "private"),
      readStore(sharedPath, "shared"),
    ]);
    const words = args.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const matchesQuery = (text: string) => words.every(word => text.toLowerCase().includes(word));
    const places = [...privateStore.store.places, ...sharedStore.store.places]
      .filter(place => matchesQuery([place.name, place.note, ...(place.refuge ? ["refuge", place.refuge.access, place.refuge.hazards] : [])].filter(Boolean).join(" ")))
      .map(place => ({ ...place, kind: "place" as const }));
    const deaths = privateStore.store.deaths
      .filter(() => matchesQuery("death"))
      .map(death => ({ ...death, name: "death", kind: "death" as const }));
    const current: { distance: number; text: string }[] = [];
    const elsewhere: string[] = [];
    for (const entry of [...places, ...deaths]) {
      const age = entry.kind === "death" ? Math.max(0, Math.floor((now() - entry.at) / 60_000)) : 0;
      const label = entry.kind === "death" ? `death ${age} min ago${age >= 5 ? ", items probably gone" : ""}` : entry.name;
      const note = entry.kind === "place" ? `${entry.note ? `; ${entry.note}` : ""}${entry.refuge ? refugeText(entry.refuge, now()) : ""}` : "";
      const by = entry.kind === "place" && "author" in entry && entry.author !== options.residentName ? `; by ${entry.author}` : "";
      if (entry.dimension === position.dimension) {
        const dx = entry.x - Math.floor(position.x), dy = entry.y - Math.floor(position.y), dz = entry.z - Math.floor(position.z);
        const distance = Math.hypot(dx, dy, dz);
        current.push({ distance, text: `${label} ${coordinates(entry)} distance ${distanceText(distance)} blocks ${compass(dx, dy, dz)}${note}${by}` });
      } else {
        elsewhere.push(`${label} ${coordinates(entry)} in ${entry.dimension}${note}${by}`);
      }
    }
    const ordered = current.sort((a, b) => a.distance - b.distance).map(line => line.text).concat(elsewhere);
    const notices = [privateStore.notice, sharedStore.notice].filter((notice): notice is string => !!notice);
    if (!ordered.length) return appendNotices(args.query ? `No places or deaths match "${args.query}".` : "No places or deaths.", notices).slice(0, 1200);
    const suffix = notices.length ? `\n${notices.join("\n")}` : "";
    const selected = ordered.slice(0, args.limit ?? 10);
    const output: string[] = [];
    for (const line of selected) {
      const remainingAfter = ordered.length - output.length - 1;
      const footer = remainingAfter > 0 ? `\n${remainingAfter} more not shown.` : "";
      const candidate = [...output, line].join("\n") + footer + suffix;
      if (candidate.length > 1200) break;
      output.push(line);
    }
    const remaining = ordered.length - output.length;
    return output.join("\n") + (remaining > 0 ? `\n${remaining} more not shown.` : "") + suffix;
  };

  const place_remove = async (args: PlaceRemoveArgs): Promise<string> => {
    return withStoreLock(sharedPath, async () => withStoreLock(privatePath, async () => {
      const [privateStore, sharedStore] = await Promise.all([
        readStore(privatePath, "private"),
        readStore(sharedPath, "shared"),
      ]);
      const privateOwn = privateStore.store.places.filter(place => place.name === args.name && place.author === options.residentName);
      const sharedOwn = sharedStore.store.places.filter(place => place.name === args.name && place.author === options.residentName);
      const foreign = sharedStore.store.places.find(place => place.name === args.name && place.author !== options.residentName);
      const notices = [privateStore.notice, sharedStore.notice].filter((notice): notice is string => !!notice);
      if (!privateOwn.length && !sharedOwn.length) {
        return appendNotices(foreign ? `Shared place "${args.name}" belongs to ${foreign.author}; not removed.` : `No own place named "${args.name}".`, notices);
      }
      privateStore.store.places = privateStore.store.places.filter(place => !(place.name === args.name && place.author === options.residentName));
      sharedStore.store.places = sharedStore.store.places.filter(place => !(place.name === args.name && place.author === options.residentName));
      if (privateOwn.length) await writeStore(privatePath, privateStore.store);
      if (sharedOwn.length) await writeStore(sharedPath, sharedStore.store);
      const removed = privateOwn.length + sharedOwn.length;
      const left = foreign ? ` Shared place "${args.name}" belongs to ${foreign.author}; left unchanged.` : "";
      return appendNotices(`Removed ${removed} own place${removed === 1 ? "" : "s"} named "${args.name}".${left}`, notices);
    }));
  };

  const recordDeath = async (pos: { x: number; y: number; z: number }, dimension: string): Promise<void> => {
    await withStoreLock(privatePath, async () => {
      const loaded = await readStore(privatePath, "private");
      loaded.store.deaths.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension, at: now() });
      loaded.store.deaths = loaded.store.deaths.sort((a, b) => b.at - a.at).slice(0, 5);
      await writeStore(privatePath, loaded.store);
    });
  };

  return { recall, place_save, place_find, place_remove, recordDeath };
}
