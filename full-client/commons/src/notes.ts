// Read-only access to what residents and their caretaker write: memory.md,
// journal.md, topic files, places.json and overseer/<Name>.md. The writers are
// other processes, so any file may be missing, huge, or half-written right now.
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { finite, record } from "./json.ts";

export interface Place { name: string; x: number; y: number; z: number; dimension: string; note?: string; author?: string }
export interface Death { x: number; y: number; z: number; dimension: string; at: number }
export interface Places { places: Place[]; deaths: Death[]; problem?: string }

const lastGood = new Map<string, Places>();

/** A places.json file. While its writer is mid-write the last good reading is returned, flagged. */
export async function readPlaces(path: string): Promise<Places> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return { places: [], deaths: [] }; }
  let parsed: Record<string, unknown>;
  try { parsed = record(JSON.parse(text)); }
  catch { return { ...(lastGood.get(path) ?? { places: [], deaths: [] }), problem: "places.json is not valid JSON right now; showing the last good reading." }; }
  const coordinates = (value: Record<string, unknown>) => {
    const x = finite(value.x), y = finite(value.y), z = finite(value.z);
    return x === undefined || y === undefined || z === undefined ? undefined
      : { x, y, z, dimension: typeof value.dimension === "string" ? value.dimension : "minecraft:overworld" };
  };
  const places: Place[] = [], deaths: Death[] = [];
  for (const value of Array.isArray(parsed.places) ? parsed.places : []) {
    const raw = record(value), at = coordinates(raw);
    if (!at || typeof raw.name !== "string") continue;
    places.push({
      name: raw.name, ...at,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}), ...(typeof raw.author === "string" ? { author: raw.author } : {}),
    });
  }
  for (const value of Array.isArray(parsed.deaths) ? parsed.deaths : []) {
    const raw = record(value), at = coordinates(raw);
    if (at) deaths.push({ ...at, at: finite(raw.at) ?? 0 });
  }
  const good = { places, deaths };
  lastGood.set(path, good);
  return good;
}

export interface FileInfo { path: string; bytes: number; modifiedAt: number }
export interface TextFile extends FileInfo { text: string; truncated: boolean }

/** The end of a text file: at most `limit` bytes, starting at a line break when cut. */
async function tail(path: string, limit: number): Promise<TextFile | null> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      const start = Math.max(0, info.size - limit);
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return { path, bytes: info.size, modifiedAt: info.mtimeMs, text, truncated: start > 0 };
    } finally { await file.close(); }
  } catch { return null; }
}
/** The start of a text file: at most `limit` bytes. */
async function head(path: string, limit: number): Promise<TextFile | null> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return { path, bytes: info.size, modifiedAt: info.mtimeMs, text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: info.size > limit };
    } finally { await file.close(); }
  } catch { return null; }
}

export async function fileSize(path: string): Promise<number | null> {
  try { return (await stat(path)).size; } catch { return null; }
}

async function markdownFiles(root: string, dir = root, found: FileInfo[] = [], depth = 0): Promise<FileInfo[]> {
  let names: string[];
  try { names = (await readdir(dir)).sort(); } catch { return found; }
  for (const name of names) {
    if (name.startsWith(".") || found.length >= 300) continue;
    const path = join(dir, name);
    let info;
    try { info = await stat(path); } catch { continue; }
    if (info.isDirectory()) { if (depth < 4) await markdownFiles(root, path, found, depth + 1); }
    else if (name.endsWith(".md")) found.push({ path: relative(root, path), bytes: info.size, modifiedAt: info.mtimeMs });
  }
  return found;
}

export interface NotesView {
  memory: TextFile | null;
  /** The end of journal.md; the start is old news. */
  journal: TextFile | null;
  /** Every other Markdown file in the resident's directory, notes/ first. */
  files: FileInfo[];
  places: Places;
  shared: Places;
}
export async function residentNotes(dir: string, sharedPlaces: string): Promise<NotesView> {
  const [memory, journal, files, places, shared] = await Promise.all([
    head(join(dir, "memory.md"), 200_000), tail(join(dir, "journal.md"), 12_000), markdownFiles(dir),
    readPlaces(join(dir, "places.json")), readPlaces(sharedPlaces),
  ]);
  const rank = (file: FileInfo) => file.path.startsWith(`notes${sep}`) ? 0 : file.path.includes(sep) ? 2 : 1;
  return {
    memory: memory && { ...memory, path: "memory.md" }, journal: journal && { ...journal, path: "journal.md" },
    files: files.filter(file => file.path !== "memory.md" && file.path !== "journal.md")
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)),
    places, shared,
  };
}

/** One Markdown file from inside a resident's directory. Anything that resolves outside it does not exist. */
export async function residentFile(dir: string, path: string): Promise<TextFile | null> {
  if (!path.endsWith(".md") || path.split(/[\\/]/).some(part => part.startsWith("."))) return null;
  try {
    const root = await realpath(dir), target = await realpath(resolve(root, path));
    if (!target.startsWith(root + sep)) return null;
    const file = await head(target, 200_000);
    return file && { ...file, path: relative(root, target) };
  } catch { return null; }
}

export interface CaretakerEntry { heading: string; note: string; maintainers: string; other: string }
/** overseer/<Name>.md: appended blocks of `## <date time> (...)`, `NOTE: ...`, `MAINTAINERS: ...`. Newest first. */
export async function caretakerNotes(path: string, limit = 30): Promise<CaretakerEntry[]> {
  const file = await tail(path, 64_000);
  if (!file) return [];
  const entries: CaretakerEntry[] = [];
  let current: CaretakerEntry | undefined, field: "note" | "maintainers" | "other" = "other";
  for (const line of file.text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), note: "", maintainers: "", other: "" };
      entries.push(current); field = "other";
      continue;
    }
    if (!current) continue;
    const labelled = /^(NOTE|MAINTAINERS):\s*(.*)$/.exec(line);
    if (labelled) { field = labelled[1] === "NOTE" ? "note" : "maintainers"; current[field] = labelled[2]; }
    else if (line.trim()) current[field] += `${current[field] ? "\n" : ""}${line.trim()}`;
  }
  return entries.reverse().slice(0, limit);
}
