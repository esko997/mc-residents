// Map panel: trails from the sampled positions, saved places and deaths. Overworld only.
import { join } from "node:path";
import { isOverworld, trail } from "../db.ts";
import { readPlaces, type Place } from "../notes.ts";
import type { PlacePicture } from "../place-pictures.ts";
import { refuse } from "./context.ts";
import type { Context, Routes } from "./context.ts";

const HOURS = [1, 6, 24, 72, 168];

export interface MapReply {
  now: number; hours: number; choices: number[];
  residents: {
    name: string; online: boolean;
    /** [unix ms, x, z] in the overworld. */
    trail: [number, number, number][];
    /** null when offline or in another dimension. */
    position: { x: number; y: number; z: number } | null;
    dimension: string | null;
  }[];
  places: (Place & { owner: string; picture: PlacePicture | null })[];
  deaths: { resident: string; x: number; y: number; z: number; at: number }[];
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
      const shared = await readPlaces(config.sharedPlaces);
      const pictures = await watcher.placePictures.mapPictures();
      const places = shared.places.filter(place => isOverworld(place.dimension)).map(place => ({
        ...place, owner: "shared", picture: watcher.placePictures.forPlace(pictures, "shared", place),
      }));
      const deaths: MapReply["deaths"] = [];
      const residents: MapReply["residents"] = [];
      for (const resident of config.residents) {
        const own = await readPlaces(join(resident.dir, "places.json"));
        places.push(...own.places.filter(place => isOverworld(place.dimension)).map(place => ({
          ...place, owner: resident.name, picture: watcher.placePictures.forPlace(pictures, resident.name, place),
        })));
        for (const death of own.deaths) {
          if (isOverworld(death.dimension) && death.at >= since) deaths.push({ resident: resident.name, x: death.x, y: death.y, z: death.z, at: death.at });
        }
        // places.json keeps only the five latest deaths; the session record has the others.
        for (const entry of tail.recent({ resident: resident.name, limit: 4000 })) {
          if (entry.kind !== "event" || entry.type !== "died" || entry.t < since) continue;
          const found = /\bat=(-?\d+),(-?\d+),(-?\d+)(?: dimension=(\S+))?/.exec(entry.text ?? "");
          if (!found || (found[4] && !isOverworld(found[4]))) continue;
          const death = { resident: resident.name, x: Number(found[1]), y: Number(found[2]), z: Number(found[3]), at: entry.t };
          // The event is read when the next tool result arrives, a little after the death itself.
          if (!deaths.some(known => known.resident === death.resident && known.x === death.x && known.z === death.z && Math.abs(known.at - death.at) < 600_000)) deaths.push(death);
        }
        const sighting = watcher.sighting(resident.name);
        residents.push({
          name: resident.name, online: sighting.status === "online", trail: trail(db, resident.name, since),
          position: sighting.state && isOverworld(sighting.state.dimension) ? sighting.state.pos : null,
          dimension: sighting.state?.dimension ?? null,
        });
      }
      return { now: now(), hours, choices: HOURS, residents, places, deaths };
    },
  };
}
