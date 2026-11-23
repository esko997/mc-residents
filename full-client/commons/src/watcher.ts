// Looks at every resident's client on a timer: keeps the latest state for the
// page, writes each online resident's position into the commons (map trails),
// and captures nearby newly saved places; live pictures are fetched on demand.
import type { Database } from "bun:sqlite";
import type { Config, ResidentConfig } from "./config.ts";
import { recordPosition } from "./db.ts";
import { record } from "./json.ts";
import { autoAccept } from "./reviews.ts";
import { normalizeState, synapseGet, type ResidentState } from "./synapse.ts";
import { ObserverFeed } from "./observer.ts";
import { PlacePictures } from "./place-pictures.ts";

export interface Sighting {
  status: "online" | "offline" | "unauthorized" | "error" | "unchecked";
  detail?: string;
  checkedAt: number;
  state: ResidentState | null;
  /** The last time a position was recorded, from this run or an earlier one. */
  lastOnlineAt: number | null;
}
export interface Picture { png: Uint8Array<ArrayBuffer>; at: number }

export class Watcher {
  private sightings = new Map<string, Sighting>();
  private pictures = new Map<string, Picture>();
  private fetching = new Map<string, Promise<Picture | null>>();
  private timer?: Timer;
  private sampling?: Promise<void>;
  private capturingPlaces?: Promise<void>;
  readonly observer: ObserverFeed;
  readonly placePictures: PlacePictures;

  constructor(private config: Config, private db: Database, private now: () => number = Date.now) {
    this.observer = new ObserverFeed(config.role === "station" ? undefined : config.observer, { now });
    this.placePictures = new PlacePictures(config, now, undefined, config.role === "hub" ? db : undefined);
  }

  start() {
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, this.config.sampleMs);
  }
  stop() { clearInterval(this.timer); }

  /**
   * One look at every resident, and one pass of automatic acceptance when that policy is on.
   * A tick still running when the next is due is not doubled.
   */
  sample(): Promise<void> {
    this.capturingPlaces ??= this.placePictures.sample()
      .catch(() => {}).finally(() => { this.capturingPlaces = undefined; });
    this.sampling ??= Promise.all([
      this.observer.poll(),
      ...this.config.residents.map(resident => this.look(resident)),
    ])
      .then(() => this.accept()).finally(() => { this.sampling = undefined; });
    return this.sampling;
  }

  private accept() {
    if (this.config.role === "station" || !this.config.autoAccept) return;
    try { autoAccept(this.db, this.now()); }
    catch (error) {
      // A tool server held the database past the busy timeout: the notes are accepted on the next tick.
      console.error(`shared notes not accepted this time: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async look(resident: ResidentConfig) {
    const reach = await synapseGet(resident, "/state?mode=full");
    const at = this.now();
    const state = reach.ok ? normalizeState(reach.data) : null;
    if (!reach.ok || !state) {
      this.sightings.set(resident.name, {
        status: reach.ok ? "error" : reach.status, detail: reach.ok ? "The client's state has no position." : reach.detail,
        checkedAt: at, state: null, lastOnlineAt: this.lastRecorded(resident.name),
      });
      return;
    }
    // The raw reply carries the full dimension id, which is what the tool servers store too.
    const dimension = record(reach.data).dimension;
    try {
      recordPosition(this.db, resident.name, at, {
        ...state.pos, dimension: typeof dimension === "string" ? dimension : state.dimension, health: state.health, food: state.food,
      });
    } catch (error) {
      // Another writer held the database past the busy timeout: lose one sample, keep watching.
      console.error(`position of ${resident.name} not recorded: ${error instanceof Error ? error.message : error}`);
    }
    this.sightings.set(resident.name, { status: "online", checkedAt: at, state, lastOnlineAt: at });
  }

  private lastRecorded(name: string): number | null {
    try {
      return this.db.query<{ at: number | null }, [string]>("SELECT MAX(at) AS at FROM positions WHERE resident = ?").get(name)?.at ?? null;
    } catch { return null; }
  }

  sighting(name: string): Sighting {
    return this.sightings.get(name) ?? { status: "unchecked", checkedAt: 0, state: null, lastOnlineAt: null };
  }
  pictureAt(name: string): number | null { return this.pictures.get(name)?.at ?? null; }

  /**
   * What the resident sees, as PNG. A picture younger than the refresh interval is reused
   * (younger than 3 s when `fresh` is asked for); when the client is down, the last one taken is returned.
   */
  async picture(resident: ResidentConfig, fresh = false): Promise<Picture | null> {
    const cached = this.pictures.get(resident.name);
    if (cached && this.now() - cached.at < (fresh ? 3000 : this.config.pictureMs)) return cached;
    let fetching = this.fetching.get(resident.name);
    if (!fetching) {
      fetching = this.takePicture(resident).finally(() => { this.fetching.delete(resident.name); });
      this.fetching.set(resident.name, fetching);
    }
    return await fetching ?? cached ?? null;
  }

  private async takePicture(resident: ResidentConfig): Promise<Picture | null> {
    const reach = await synapseGet(resident, "/screenshot?format=base64", 10_000);
    if (!reach.ok) return null;
    const image = record(reach.data).image;
    if (typeof image !== "string") return null;
    const png = Buffer.from(image.replace(/^data:image\/png;base64,/, ""), "base64");
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return null;
    const picture = { png: new Uint8Array(png), at: this.now() };
    this.pictures.set(resident.name, picture);
    return picture;
  }
}
