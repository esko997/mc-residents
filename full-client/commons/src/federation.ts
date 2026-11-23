// Hub-only fan-in. Aggregate reads never await a station: stale snapshots are
// useful evidence, while an unavailable host must not stall local residents.
import { constants, closeSync, fstatSync, openSync, readFileSync, statSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import type { Place } from "./notes.ts";
import type { ActivityReply } from "./routes/activity.ts";
import type { CommonsReply } from "./routes/commons.ts";
import { refuse, type Ask, type Routes } from "./routes/context.ts";
import type { MapReply } from "./routes/map.ts";
import { dimensionKey } from "./positions.ts";
import type { NotesReply } from "./routes/notes.ts";
import type { ResidentsReply } from "./routes/residents.ts";

interface Station {
  host: string; url: string;
  residents?: ResidentsReply["residents"]; lastSeen: number | null; unreachable: boolean;
  cache: Map<string, Cached>; pending: Map<string, Promise<Cached | undefined>>;
}
interface Cached { at: number; status: number; headers: Record<string, string>; bytes: Uint8Array<ArrayBuffer> }
/** Where a resident's Live signaling goes; `url` is the station's secret URL and stays server-side. */
export type LiveTarget =
  | { kind: "local" } | { kind: "duplicate" }
  | { kind: "remote"; host: string; url: string; unreachable: boolean; liveAvailable: boolean };
const TTL = 5000;
const MAX_REPLY = 4 * 1024 * 1024;
// A station resident's thoughts come from its own host, through the same five-second cache as its notes.
const SCOPED: Record<string, true> = { notes: true, file: true, picture: true, "map-picture": true, thoughts: true };
const nameKey = (name: string) => name.toLowerCase();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const parse = <T>(cached?: Cached): T | undefined => {
  if (!cached || !cached.bytes.length) return undefined;
  try { return JSON.parse(new TextDecoder().decode(cached.bytes)) as T; } catch { return undefined; }
};

export class Federation {
  private stations: Station[] = [];
  private fingerprint = "";
  private configError?: string;
  private rosterError?: string;
  private timer?: Timer;
  private stopped = false;
  private controllers = new Set<AbortController>();
  private activityBoot = "";
  private activityIds = new Map<string, number>();
  private nextId = 0;

  constructor(private config: Config, private now: () => number = Date.now,
    private options: { fetch?: typeof fetch; timeoutMs?: number; ttlMs?: number; sharedPlaces?: () => Place[] } = {}) {}

  start() {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.options.ttlMs ?? TTL);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
  }

  private restoreRoster(station: Station): Station {
    if (this.config.dbPath === ":memory:") return station;
    try {
      const fd = openSync(`${this.config.dbPath}.station-roster.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let rows: unknown;
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 256 * 1024) throw new Error();
        rows = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!Array.isArray(rows)) throw new Error();
      const key = createHash("sha256").update(station.url).digest("hex");
      const row = rows.find(r => object(r) && r.host === station.host && r.key === key);
      if (!row) return station;
      if (!Number.isFinite(row.lastSeen) || !Array.isArray(row.names) || row.names.length > 64
        || !row.names.every((name: unknown) => typeof name === "string" && /^[\w-]{1,64}$/.test(name))) throw new Error();
      station.lastSeen = row.lastSeen;
      station.unreachable = true;
      station.residents = row.names.map((name: string) => ({
        name, host: station.host, hostUnreachable: true, hostLastSeen: row.lastSeen, liveAvailable: false, audioAvailable: false,
        status: "unchecked", checkedAt: 0, state: null, lastOnlineAt: null, memoryBytes: null,
        units: [], tokens: { day: { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }, daySessions: 0 },
        pictureAt: null, sessionHealth: null, serverObservation: null, thoughts: { summaries: "unknown", latest: null },
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.rosterError = "Cannot read the saved station roster; offline names may be unavailable after restart.";
    }
    return station;
  }

  private saveRoster() {
    if (this.config.dbPath === ":memory:") return;
    const path = `${this.config.dbPath}.station-roster.json`, temporary = `${path}.${randomUUID()}`;
    try {
      const rows = this.stations.filter(s => s.residents).map(s => ({
        host: s.host, key: createHash("sha256").update(s.url).digest("hex"),
        lastSeen: s.lastSeen, names: s.residents!.map(r => r.name),
      }));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      this.rosterError = undefined;
    } catch {
      this.rosterError = "Cannot save the station roster; offline names may be unavailable after restart.";
    } finally { try { unlinkSync(temporary); } catch { /* Already renamed, or never created. */ } }
  }

  private reload() {
    if (this.config.role !== "hub") return;
    try {
      const info = statSync(this.config.stationsFile);
      const fingerprint = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.mode}`;
      if (fingerprint === this.fingerprint) return;
      const fd = openSync(this.config.stationsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let values: unknown;
      try {
        const held = fstatSync(fd);
        if (!held.isFile() || (held.mode & 0o777) !== 0o600 || held.size > 64 * 1024) throw new Error();
        values = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!Array.isArray(values) || values.length > 16) throw new Error();
      const hosts = new Set([nameKey(this.config.hostName)]), urls = new Set<string>();
      const next = values.map(value => {
        if (!object(value) || typeof value.host !== "string" || !/^[\w.-]{1,80}$/.test(value.host)
          || typeof value.url !== "string") throw new Error();
        const url = new URL(value.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || !/^\/[A-Za-z0-9_-]{8,128}\/$/.test(url.pathname)) throw new Error();
        if (hosts.has(nameKey(value.host)) || urls.has(url.href)) throw new Error();
        hosts.add(nameKey(value.host)); urls.add(url.href);
        return this.stations.find(s => s.host === value.host && s.url === url.href)
          ?? this.restoreRoster({ host: value.host, url: url.href, lastSeen: null, unreachable: false, cache: new Map(), pending: new Map() });
      });
      this.stations = next;
      this.fingerprint = fingerprint;
      this.configError = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.stations = []; this.fingerprint = ""; this.configError = undefined;
      } else {
        // Never include the exception or the config contents: both can contain URL secrets.
        this.configError = "Invalid stations configuration: expected a mode-600 JSON array of unique host names and secret station URLs (at most 16).";
      }
    }
  }

  private async fetchStation(station: Station, path: string): Promise<Cached | undefined> {
    if (this.stopped) return undefined;
    const old = station.cache.get(path);
    if (old && this.now() - old.at < (this.options.ttlMs ?? TTL)) return old;
    const existing = station.pending.get(path);
    if (existing) return existing;
    if (station.pending.size >= 16) return undefined;
    const work = (async () => {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 2500);
      let result: Cached;
      let failureStatus = 502;
      try {
        const response = await (this.options.fetch ?? fetch)(new URL(`api/${path}`, station.url), {
          signal: controller.signal, redirect: "error", headers: { Accept: "application/json, image/png" },
        });
        if (!response.ok) {
          if (path !== "residents" && response.status >= 400 && response.status < 500) failureStatus = response.status;
          await response.body?.cancel();
          throw new Error();
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > MAX_REPLY) { await reader.cancel(); throw new Error(); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        result = { at: this.now(), status: 200, bytes, headers: {
          "Content-Type": response.headers.get("Content-Type") ?? "application/json",
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          ...(response.headers.has("X-Picture-At") ? { "X-Picture-At": response.headers.get("X-Picture-At")! } : {}),
        } };
        if (path === "residents") {
          const data = parse<ResidentsReply>(result);
          if (!data || data.role !== "station" || !Array.isArray(data.residents)
            || data.residents.length > 64 || !data.residents.every(r => typeof r.name === "string" && /^[\w-]{1,64}$/.test(r.name))) throw new Error();
          station.residents = data.residents; station.lastSeen = this.now(); station.unreachable = false;
          this.saveRoster();
        }
      } catch {
        if (path === "residents") station.unreachable = true;
        // Cache failures too; concurrent dashboard polls must not create retry storms.
        result = { at: this.now(), status: failureStatus, bytes: old?.bytes ?? new Uint8Array(), headers: old?.headers ?? {} };
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
      station.cache.delete(path);
      station.cache.set(path, result);
      let cachedBytes = [...station.cache.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
      while (station.cache.size > 64 || cachedBytes > 16 * 1024 * 1024) {
        const oldest = station.cache.keys().next().value!;
        cachedBytes -= station.cache.get(oldest)!.bytes.byteLength;
        station.cache.delete(oldest);
      }
      return result;
    })().finally(() => { station.pending.delete(path); });
    station.pending.set(path, work);
    return work;
  }

  /** Also used by fixture tests to await discovery without sleeping or polling. */
  async refresh(): Promise<void> {
    this.reload();
    await Promise.all(this.stations.map(station => this.fetchStation(station, "residents")));
    await Promise.all(this.stations.flatMap(station => [...station.pending.values()]));
  }

  private owners(name: string): (Station | "local")[] {
    const key = nameKey(name);
    const local = this.config.residents.filter(r => nameKey(r.name) === key).map(() => "local" as const);
    return [...local, ...this.stations.flatMap(s => (s.residents ?? []).filter(r => nameKey(r.name) === key).map(() => s))];
  }
  private errors(): string[] {
    const errors = [this.configError, this.rosterError].filter((error): error is string => !!error);
    const names = new Set([...this.config.residents.map(r => r.name), ...this.stations.flatMap(s => s.residents?.map(r => r.name) ?? [])].map(nameKey));
    for (const name of names) {
      const owners = this.owners(name);
      if (owners.length > 1) errors.push(`Duplicate resident name "${name}" across hosts: ${owners.map(s => s === "local" ? this.config.hostName : s.host).join(", ")}. Fix the station configuration; resident-scoped reads are disabled for this name.`);
    }
    for (const station of this.stations) if (station.unreachable) errors.push(`${station.host}: host unreachable; ${station.lastSeen === null ? "no successful discovery yet" : `last seen ${new Date(station.lastSeen).toISOString()}`}.`);
    return errors;
  }

  private cached<T>(station: Station, path: string): T | undefined {
    // Return the last good body while refreshing. A failed refresh must not erase trails/activity.
    const value = parse<T>(station.cache.get(path));
    void this.fetchStation(station, path);
    return value;
  }

  private async forward(route: string, ask: Ask): Promise<Response | undefined> {
    let query = new URLSearchParams();
    let owners: (Station | "local")[];
    if (route === "map-picture") {
      const id = ask.query.get("id") ?? "";
      // Remote picture IDs are namespaced in map replies; callers need no secret URL or extra host parameter.
      const match = /^station:([^:]+):([a-f0-9]{64})$/.exec(id);
      if (!match) return undefined;
      owners = this.stations.filter(s => s.host === match[1]);
      query.set("id", match[2]);
    } else {
      const name = ask.query.get("resident") ?? "";
      owners = this.owners(name);
      query.set("resident", name);
      if (route === "file") query.set("path", ask.query.get("path") ?? "");
      if (route === "picture" && ask.query.get("fresh") === "1") query.set("fresh", "1");
    }
    if (owners.length > 1) return refuse(409, "Duplicate resident name across hosts; fix station configuration.");
    const owner = owners[0];
    if (!owner || owner === "local") return undefined;
    const result = await this.fetchStation(owner, `${route}?${query}`);
    if (!result || result.status !== 200) return refuse(result?.status ?? 502, `${owner.host}: host unreachable or station data unavailable.`);
    return new Response(result.bytes, { status: result.status, headers: result.headers });
  }

  wrap(routes: Routes): Routes {
    const wrapped = { ...routes };
    for (const [key, handler] of Object.entries(routes)) {
      const route = key.slice(4);
      if (!key.startsWith("GET ")) continue;
      wrapped[key] = async ask => {
        this.reload();
        void this.refresh();
        if (Object.hasOwn(SCOPED, route)) {
          const forwarded = await this.forward(route, ask);
          if (forwarded) {
            if (route !== "notes" || !forwarded.ok) return forwarded;
            const notes = await forwarded.json() as NotesReply;
            return { ...notes, shared: { places: this.options.sharedPlaces?.() ?? [], deaths: [] } };
          }
        }
        // Always get the full local activity snapshot for remapping cross-host cursors.
        const localAsk = route === "activity" && this.stations.length
          ? { ...ask, query: new URLSearchParams("limit=1000") } : ask;
        const answer = await handler(localAsk);
        if (answer instanceof Response) return answer;
        if (route === "residents") {
          const data = answer as ResidentsReply;
          // A station reports its own Live/audio settings; an unreachable one cannot serve them.
          const remote = this.stations.flatMap(s => (s.residents ?? []).map(r => ({
            ...r, host: s.host, hostUnreachable: s.unreachable, hostLastSeen: s.lastSeen,
            liveAvailable: !s.unreachable && r.liveAvailable === true,
            audioAvailable: !s.unreachable && r.liveAvailable === true && r.audioAvailable === true,
            ...(s.unreachable ? { status: "error" as const, detail: "host unreachable", state: null } : {}),
          })));
          return { ...data, federationErrors: this.errors(), residents: [...data.residents, ...remote].map(r =>
            this.owners(r.name).length > 1 ? { ...r, liveAvailable: false, audioAvailable: false } : r) };
        }
        if (route === "activity" && this.stations.length) return this.activity(answer as ActivityReply, ask);
        if (route === "map") return this.map(answer as MapReply);
        if (route === "commons") {
          const data = answer as CommonsReply;
          const caretaker = [...data.caretaker];
          for (const station of this.stations) for (const resident of station.residents ?? []) {
            if (this.owners(resident.name).length !== 1) continue;
            const notes = this.cached<NotesReply>(station, `notes?${new URLSearchParams({ resident: resident.name })}`);
            if (notes?.caretaker) caretaker.push({ resident: resident.name, entries: notes.caretaker });
          }
          return { ...data, caretaker };
        }
        return answer;
      };
    }
    return wrapped;
  }

  /** Server-side only: where a resident's Live signaling goes. The URL never reaches a browser. */
  liveTarget(name: string): LiveTarget {
    this.reload();
    const owners = this.owners(name);
    if (owners.length > 1) return { kind: "duplicate" };
    const owner = owners[0];
    if (!owner || owner === "local") return { kind: "local" };
    const resident = owner.residents?.find(r => nameKey(r.name) === nameKey(name));
    return { kind: "remote", host: owner.host, url: owner.url, unreachable: owner.unreachable,
      liveAvailable: !owner.unreachable && resident?.liveAvailable === true };
  }

  /** Server-side only, for run control: each station's secret URL and discovered resident names. */
  controlStations(): { host: string; url: string; unreachable: boolean; names: string[] }[] {
    this.reload();
    return this.stations.map(s => ({ host: s.host, url: s.url, unreachable: s.unreachable, names: (s.residents ?? []).map(r => r.name) }));
  }

  /** Every discovered remote resident (possibly from the saved roster), never awaiting a station. */
  remoteResidents(): { name: string; host: string; unreachable: boolean; liveAvailable: boolean; state: ResidentsReply["residents"][number]["state"] }[] {
    this.reload();
    return this.stations.flatMap(s => (s.residents ?? []).map(r => {
      const unique = this.owners(r.name).length === 1;
      return { name: r.name, host: s.host, unreachable: s.unreachable,
        liveAvailable: unique && !s.unreachable && r.liveAvailable === true, state: unique && !s.unreachable ? r.state : null };
    }));
  }

  /** The station's last overlay source for one of its residents; refreshed in the background. */
  overlaySource(name: string): { value: unknown; current: boolean } | undefined {
    const owners = this.owners(name), owner = owners[0];
    if (owners.length !== 1 || !owner || owner === "local") return undefined;
    const path = `overlay/source?${new URLSearchParams({ resident: name })}`, entry = owner.cache.get(path);
    void this.fetchStation(owner, path);
    return { value: parse<unknown>(entry), current: !owner.unreachable && entry?.status === 200 };
  }

  private map(local: MapReply): MapReply {
    const residents = local.residents.map(r => ({ ...r, host: this.config.hostName }));
    const places = [...local.places], deaths = [...local.deaths];
    for (const station of this.stations) {
      const remote = this.cached<MapReply>(station, `map?hours=${local.hours}`);
      if (!remote || !Array.isArray(remote.residents) || !Array.isArray(remote.places) || !Array.isArray(remote.deaths)) continue;
      const own = (name: string) => this.owners(name).length === 1 && this.owners(name)[0] === station;
      // A station running older Commons sends overworld-only `trail`s without heights: show none
      // of it rather than guessing, and read missing dimensions as the overworld it was limited to.
      residents.push(...remote.residents.filter(r => own(r.name)).map(r => ({ ...r, host: station.host,
        legs: Array.isArray(r.legs) ? r.legs : [], crossings: Array.isArray(r.crossings) ? r.crossings : [],
        samples: typeof r.samples === "number" ? r.samples : 0, dimension: r.dimension === null ? null : dimensionKey(r.dimension),
        ...(station.unreachable ? { online: false, position: null } : {}),
      })));
      places.push(...remote.places.filter(p => own(p.owner)).map(p => ({ ...p, dimension: dimensionKey(p.dimension),
        picture: p.picture ? { ...p.picture, id: `station:${station.host}:${p.picture.id}` } : null,
      })));
      deaths.push(...remote.deaths.filter(d => own(d.resident)).map(d => ({ ...d, dimension: dimensionKey(d.dimension) })));
    }
    return { ...local, residents, places, deaths };
  }

  private activity(local: ActivityReply, ask: Ask): ActivityReply {
    const sources = [{ host: this.config.hostName, data: local }, ...this.stations.flatMap(station => {
      const data = this.cached<ActivityReply>(station, "activity?limit=1000");
      return data && Array.isArray(data.entries) && Array.isArray(data.residents) ? [{ host: station.host, data }] : [];
    })];
    const boot = JSON.stringify(sources.map(s => [s.host, s.data.boot]));
    if (boot !== this.activityBoot) { this.activityBoot = boot; this.activityIds.clear(); this.nextId = 0; }
    const keys = new Set<string>();
    const entries = sources.flatMap(source => source.data.entries.filter(e =>
      this.owners(e.resident).length === 1 ||
      (source.host === this.config.hostName && e.kind === "event" && e.session === "hub" && e.type === "alarm"))
      .map(entry => ({ entry, host: source.host, key: JSON.stringify([source.host, source.data.boot, entry.id]) })))
      .sort((a, b) => a.entry.t - b.entry.t).map(({ entry, host, key }) => {
        keys.add(key);
        if (!this.activityIds.has(key)) this.activityIds.set(key, ++this.nextId);
        return { ...entry, host, id: this.activityIds.get(key)! };
      });
    for (const key of this.activityIds.keys()) if (!keys.has(key)) this.activityIds.delete(key);
    const after = ask.query.get("boot") === boot ? Number(ask.query.get("after")) || 0 : 0;
    const limit = Math.min(Math.max(Number(ask.query.get("limit")) || 300, 1), 1000);
    return { ...local, boot, entries: entries.filter(e => e.id > after).sort((a, b) => b.t - a.t).slice(0, limit),
      residents: sources.flatMap(source => source.data.residents.filter(r => this.owners(r.name).length === 1).map(r => ({ ...r, host: source.host }))),
    };
  }
}
