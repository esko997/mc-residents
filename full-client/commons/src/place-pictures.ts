// Dashboard-owned, best-effort views near newly saved places. Never controls a client.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Config, ResidentConfig } from "./config.ts";
import { record } from "./json.ts";
import type { Place } from "./notes.ts";
import { synapseGet, type Reach } from "./synapse.ts";

export interface PlacePicture { id: string; at: number; resident: string }
interface Saved { key: string; revision: string; owner: string; place: Place }
interface Source { path: string; owner: string }
interface Snapshot { saved: Saved[]; at: number }
interface Stored extends PlacePicture { key: string; revision: string; bytes: number }
interface Payload { key: string; revision: string; at: number; resident: string; image: string }

const MAX_PNG = 2 * 1024 * 1024;
const MAX_FILE = 3 * 1024 * 1024;
const MAX_DISK = 64 * 1024 * 1024;
const MAX_COUNT = 128;
const MAX_AGE = 30 * 86_400_000;
const SAVE_WINDOW = 30_000;
const HASH = /^[a-f0-9]{64}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const keyOf = (owner: string, place: Place) => hash(JSON.stringify([owner, place.author ?? "", place.name]));
const viewOf = (place: Place) => [place.name, place.x, place.y, place.z, place.dimension, place.note ?? null, place.author ?? null];

/** No symlink, FIFO, device, oversized file or hard-linked credential reads. */
async function regular(path: string, max: number): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max) throw new Error("Not a bounded regular file");
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function bounded(file: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.alloc(max + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
    if (!bytesRead) break;
    size += bytesRead;
  }
  if (size > max) throw new Error("File grew beyond limit");
  return buffer.subarray(0, size);
}

function imageBytes(image: unknown): Buffer | null {
  if (typeof image !== "string" || image.length > Math.ceil(MAX_PNG / 3) * 4 + 22) return null;
  const text = image.replace(/^data:image\/png;base64,/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const png = Buffer.from(text, "base64");
  // Require PNG signature and IHDR, not just the four-byte magic prefix.
  if (png.length < 33 || png.length > MAX_PNG || !png.subarray(0, 8).equals(PNG)
    || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  return width > 0 && height > 0 && width * height <= 16_777_216 ? png : null;
}

function near(data: unknown, saved: Saved): boolean {
  const raw = record(data), pos = record(raw.pos), p = saved.place;
  return raw.inWorld !== false && raw.dead !== true && typeof raw.health === "number" && raw.health > 0
    && raw.dimension === p.dimension && (raw.screen === undefined || raw.screen === null || raw.screen === "none")
    && [pos.x, pos.y, pos.z].every(value => typeof value === "number" && Number.isFinite(value))
    && Math.hypot(Number(pos.x) - p.x, Number(pos.y) - p.y, Number(pos.z) - p.z) <= 12;
}

export class PlacePictures {
  private entries = new Map<string, Stored>();
  private baselines = new Map<string, Map<string, string>>();
  private initialized?: Promise<void>;
  private readonly sources: Source[];
  private readonly directory: string;

  constructor(private config: Config, private now: () => number = Date.now,
    private get: (resident: ResidentConfig, path: string, timeout?: number) => Promise<Reach> = synapseGet) {
    this.directory = `${config.dbPath}.place-pictures`;
    this.sources = [{ path: config.sharedPlaces, owner: "shared" }, ...config.residents.map(resident => ({
      path: join(resident.dir, "places.json"), owner: resident.name,
    }))];
  }

  // Anchor every store operation to an opened directory inode. In particular a replaced
  // directory or a symlink at <hash>.json cannot redirect reads into credentials.
  private async withDirectory<T>(action: (root: string) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return await action(`/proc/self/fd/${dir.fd}`); }
    finally { await dir.close(); }
  }

  private async source(source: Source): Promise<Snapshot | null> {
    let file: FileHandle;
    try { file = await regular(source.path, MAX_FILE); }
    catch (error) { return record(error).code === "ENOENT" ? { saved: [], at: 0 } : null; }
    try {
      const before = await file.stat();
      const raw = record(JSON.parse((await bounded(file, MAX_FILE)).toString("utf8")));
      const after = await file.stat();
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || !Array.isArray(raw.places)) return null;
      const saved: Saved[] = [];
      const keys = new Set<string>();
      for (const value of raw.places) {
        const p = record(value);
        if (typeof p.name !== "string" || typeof p.dimension !== "string"
          || ![p.x, p.y, p.z].every(n => typeof n === "number" && Number.isFinite(n))) continue;
        const place: Place = { name: p.name, x: Number(p.x), y: Number(p.y), z: Number(p.z), dimension: p.dimension,
          ...(typeof p.author === "string" ? { author: p.author } : {}), ...(typeof p.note === "string" ? { note: p.note } : {}) };
        const key = keyOf(source.owner, place), refuge = record(p.refuge);
        const revision = hash(JSON.stringify([...viewOf(place), refuge.access ?? null, refuge.hazards ?? null, refuge.checkedAt ?? null]));
        if (keys.has(key)) return null;
        keys.add(key);
        saved.push({ key, revision, owner: source.owner, place });
      }
      return { saved, at: after.mtimeMs };
    } catch { return null; }
    finally { await file.close(); }
  }

  private recent(at: number) { const age = this.now() - at; return age >= 0 && age <= SAVE_WINDOW; }
  private retained(at: number) { const age = this.now() - at; return age >= 0 && age <= MAX_AGE; }

  private async load(root: string, id: string): Promise<{ meta: Stored; png: Buffer } | null> {
    if (!HASH.test(id)) return null;
    let file: FileHandle;
    try { file = await regular(join(root, `${id}.json`), MAX_FILE); } catch { return null; }
    try {
      const bytes = await bounded(file, MAX_FILE), text = bytes.toString("utf8");
      if (hash(text) !== id) return null;
      const p = record(JSON.parse(text));
      if (typeof p.key !== "string" || !HASH.test(p.key) || typeof p.revision !== "string" || !HASH.test(p.revision)
        || typeof p.at !== "number" || !Number.isFinite(p.at) || !this.retained(p.at)
        || typeof p.resident !== "string" || !this.config.residents.some(r => r.name === p.resident)) return null;
      const png = imageBytes(p.image);
      if (!png) return null;
      return { meta: { id, key: p.key, revision: p.revision, at: p.at, resident: p.resident, bytes: bytes.length }, png };
    } catch { return null; }
    finally { await file.close(); }
  }

  private initialize(): Promise<void> {
    return this.initialized ??= this.withDirectory(async root => {
      // Only this module's hash filenames are touched; unrelated files are never read.
      for (const name of await readdir(root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const result = await this.load(root, name.slice(0, -5));
        if (result) this.entries.set(result.meta.id, result.meta);
        else await unlink(join(root, name)).catch(() => {});
      }
      await this.prune(root);
    });
  }

  private async prune(root: string, reserve = 0) {
    let bytes = reserve, count = reserve ? 1 : 0;
    for (const entry of [...this.entries.values()].sort((a, b) => b.at - a.at)) {
      if (!this.retained(entry.at) || count >= MAX_COUNT || bytes + entry.bytes > MAX_DISK) {
        await this.discard(root, entry);
      } else { bytes += entry.bytes; count++; }
    }
  }

  private async discard(root: string, entry: Stored) {
    try { await unlink(join(root, `${entry.id}.json`)); }
    catch (error) { if (record(error).code !== "ENOENT") throw error; }
    this.entries.delete(entry.id);
  }

  /** Runs once per Watcher tick; no retry queue and no live-picture cache fallback. */
  async sample(): Promise<void> {
    try {
      await this.initialize();
      const candidates: { saved: Saved; source: Source; at: number }[] = [];
      await this.withDirectory(async root => {
        for (const source of this.sources) {
          const snapshot = await this.source(source);
          if (!snapshot) continue; // Partial writes are not deletions or new saves.
          const previous = this.baselines.get(source.path);
          const current = new Map(snapshot.saved.map(saved => [saved.key, saved.revision]));
          this.baselines.set(source.path, current);
          for (const entry of this.entries.values()) {
            // Owner is encoded in the key; only prune records known to belong to this source.
            if ((previous?.has(entry.key) || snapshot.saved.some(saved => saved.key === entry.key))
              && current.get(entry.key) !== entry.revision) {
              await this.discard(root, entry);
            }
          }
          if (!previous || !this.recent(snapshot.at)) continue;
          for (const saved of snapshot.saved) {
            if (previous.get(saved.key) !== saved.revision) candidates.push({ saved, source, at: snapshot.at });
          }
        }
        // A persisted picture whose place was removed while the dashboard was down is obsolete.
        const known = new Map([...this.baselines.values()].flatMap(items => [...items]));
        if (this.baselines.size === this.sources.length) {
          for (const entry of this.entries.values()) {
            if (known.get(entry.key) === entry.revision) continue;
            await this.discard(root, entry);
          }
        }
        await this.prune(root);
      });
      for (const resident of this.config.residents) {
        const eligible = candidates.filter(({ saved, at }) => this.recent(at)
          && (saved.place.author ? saved.place.author === resident.name : saved.owner === resident.name));
        if (!eligible.length) continue;
        const before = await this.get(resident, "/state?mode=full");
        const nearby = eligible.filter(({ saved, at }) => before.ok && this.recent(at) && near(before.data, saved));
        if (!nearby.length) continue;
        const image = await this.get(resident, "/screenshot?format=base64", 5000);
        const at = this.now();
        const png = image.ok ? imageBytes(record(image.data).image) : null;
        if (!png) continue;
        const after = await this.get(resident, "/state?mode=full");
        if (!after.ok) continue;
        for (const candidate of nearby) {
          if (!this.recent(candidate.at) || !near(after.data, candidate.saved)) continue;
          const latest = await this.source(candidate.source);
          if (!latest?.saved.some(saved => saved.key === candidate.saved.key && saved.revision === candidate.saved.revision)) continue;
          if (!this.recent(candidate.at)) continue;
          const payload: Payload = { key: candidate.saved.key, revision: candidate.saved.revision, resident: resident.name, at,
            image: png.toString("base64") };
          const text = JSON.stringify(payload), id = hash(text);
          await this.withDirectory(async root => {
            // Reserve disk before writing. The index publishes only after close; a crash's
            // incomplete file is rejected and removed by the next startup scan.
            const bytes = Buffer.byteLength(text);
            await this.prune(root, bytes);
            const path = join(root, `${id}.json`);
            const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(text); }
            catch (error) { await unlink(path).catch(() => {}); throw error; }
            finally { await file.close(); }
            this.entries.set(id, { id, key: payload.key, revision: payload.revision, at, resident: resident.name, bytes });
          });
        }
      }
    } catch { /* Pictures must never break resident sampling; do not log paths or Synapse credentials. */ }
  }

  /** Re-read revisions for each map request, so edits never display a superseded picture. */
  async mapPictures(): Promise<Map<string, PlacePicture>> {
    const pictures = new Map<string, PlacePicture>();
    try {
      await this.initialize();
      await this.withDirectory(async root => {
        for (const source of this.sources) {
          const snapshot = await this.source(source);
          for (const saved of snapshot?.saved ?? []) {
            const entry = [...this.entries.values()].find(entry => entry.key === saved.key && entry.revision === saved.revision && this.retained(entry.at));
            if (!entry) continue;
            try {
              const file = await regular(join(root, `${entry.id}.json`), MAX_FILE);
              await file.close();
              pictures.set(hash(JSON.stringify([saved.key, viewOf(saved.place)])), { id: entry.id, at: entry.at, resident: entry.resident });
            } catch { /* Missing or unsafe image stays null. */ }
          }
        }
      });
    } catch { /* Optional store unavailable. */ }
    return pictures;
  }

  forPlace(pictures: Map<string, PlacePicture>, owner: string, place: Place): PlacePicture | null {
    return pictures.get(hash(JSON.stringify([keyOf(owner, place), viewOf(place)]))) ?? null;
  }

  async read(id: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!HASH.test(id)) return null;
    try {
      await this.initialize();
      const entry = this.entries.get(id);
      if (!entry || !this.retained(entry.at)) return null;
      let current = false;
      for (const source of this.sources) {
        const snapshot = await this.source(source);
        if (snapshot?.saved.some(saved => saved.key === entry.key && saved.revision === entry.revision)) { current = true; break; }
      }
      if (!current) return null;
      return await this.withDirectory(async root => {
        const result = await this.load(root, id);
        return result ? new Uint8Array(result.png) : null;
      });
    } catch { return null; }
  }
}
