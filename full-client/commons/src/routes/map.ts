// Map panel: trails from the sampled positions in every dimension (with height), saved places,
// deaths, alarms and dimension crossings. The page draws one dimension at a time.
import { join } from "node:path";
import { classifyCrossings, dimensionKey, mapTrail, type DimensionCrossing, type TrailLeg } from "../positions.ts";
import { readPlaces, type Place } from "../notes.ts";
import { recentAlarms } from "../resident-alarms.ts";
import { sharedPlaces } from "../resident-places.ts";
import type { PlacePicture } from "../place-pictures.ts";
import { refuse } from "./context.ts";
import type { Context, Routes } from "./context.ts";

const HOURS = [1, 6, 24, 72, 168];

export interface MapReply {
  now: number; hours: number; choices: number[];
  residents: {
    name: string; online: boolean;
    /** Joined runs of samples, each in one dimension, decimated per resident (see positions.ts). */
    legs: TrailLeg[];
    crossings: DimensionCrossing[];
    /** Raw samples in the window, before standing-still merging and decimation. */
    samples: number;
    /** null when offline. sky: sky light at the feet, null when the client did not say. */
    position: { x: number; y: number; z: number; sky: number | null } | null;
    /** Dimension key (`overworld`, `the_nether`, `the_end`, or a mod's full id). */
    dimension: string | null;
  }[];
  /** `dimension` is a dimension key. */
  places: (Place & { owner: string; picture: PlacePicture | null })[];
  deaths: { resident: string; x: number; y: number; z: number; dimension: string; at: number }[];
  /** Hub only: alarms are shared records; a station has none of its own. */
  alarms: { resident: string; x: number; y: number; z: number; dimension: string; at: number; reason: string; kind: "auto" | "manual" }[];
}

export function mapRoutes({ config, db, watcher, tail, now, readSessions }: Context): Routes {
  return {
    async "GET map-picture"({ query }): Promise<Response> {
      const png = await watcher.placePictures.read(query.get("id") ?? "");
      return png ? new Response(png, { headers: {
        "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } }) : refuse(404, "Not found.");
    },
    async "GET map"({ query }): Promise<MapReply> {
      await readSessions();
      const asked = Number(query.get("hours"));
      const hours = HOURS.includes(asked) ? asked : 6;
      const since = now() - hours * 3_600_000;
      const shared = config.role === "hub" ? sharedPlaces(db) : [];
      const pictures = await watcher.placePictures.mapPictures();
      const places: MapReply["places"] = shared.map(place => ({
        ...place, dimension: dimensionKey(place.dimension), owner: "shared", picture: watcher.placePictures.forPlace(pictures, "shared", place),
      }));
      const deaths: MapReply["deaths"] = [];
      const residents: MapReply["residents"] = [];
      for (const resident of config.residents) {
        const own = await readPlaces(join(resident.dir, "places.json"));
        places.push(...own.places.map(place => ({
          ...place, dimension: dimensionKey(place.dimension), owner: resident.name, picture: watcher.placePictures.forPlace(pictures, resident.name, place),
        })));
        const mine: MapReply["deaths"] = [];
        for (const death of own.deaths) {
          if (death.at >= since) mine.push({ resident: resident.name, x: death.x, y: death.y, z: death.z, dimension: dimensionKey(death.dimension), at: death.at });
        }
        // places.json keeps only the five latest deaths; the session record has the others.
        for (const entry of tail.recent({ resident: resident.name, limit: 4000 })) {
          if (entry.kind !== "event" || entry.type !== "died" || entry.t < since) continue;
          const found = /\bat=(-?\d+),(-?\d+),(-?\d+)(?: dimension=(\S+))?/.exec(entry.text ?? "");
          if (!found) continue;
          const death = { resident: resident.name, x: Number(found[1]), y: Number(found[2]), z: Number(found[3]), dimension: dimensionKey(found[4]), at: entry.t };
          // The event is read when the next tool result arrives, a little after the death itself.
          if (!mine.some(known => known.dimension === death.dimension && known.x === death.x && known.z === death.z && Math.abs(known.at - death.at) < 600_000)) mine.push(death);
        }
        deaths.push(...mine);
        const sighting = watcher.sighting(resident.name), state = sighting.state;
        const trail = mapTrail(db, resident.name, since);
        residents.push({
          name: resident.name, online: sighting.status === "online",
          legs: trail.legs, crossings: classifyCrossings(trail.crossings, mine), samples: trail.samples,
          position: state ? { ...state.pos, sky: state.world?.skyLight ?? null } : null,
          dimension: state ? dimensionKey(state.dimension) : null,
        });
      }
      const alarms: MapReply["alarms"] = config.role === "hub" ? recentAlarms(db, since).map(alarm => ({
        resident: alarm.sender, x: Math.round(alarm.x), y: Math.round(alarm.y), z: Math.round(alarm.z),
        dimension: dimensionKey(alarm.dimension), at: alarm.at, reason: alarm.reason, kind: alarm.kind,
      })) : [];
      return { now: now(), hours, choices: HOURS, residents, places, deaths, alarms };
    },
  };
}
