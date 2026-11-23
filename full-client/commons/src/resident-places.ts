import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";

const refuge = z.object({ access: z.string().optional(), hazards: z.string().optional(), checkedAt: z.number().finite().optional() }).strict();
export const sharedPlaceSchema = z.object({
  name: z.string(), note: z.string().optional(), x: z.number().int(), y: z.number().int(), z: z.number().int(),
  dimension: z.string(), author: z.string(), refuge: refuge.optional(),
}).strict();
export type SharedPlace = z.infer<typeof sharedPlaceSchema>;
const saveSchema = z.object({
  name: z.string().trim().min(1).max(40), note: z.string().max(240).optional(),
  x: z.number().int(), y: z.number().int(), z: z.number().int(), dimension: z.string().min(1).max(200),
  refuge: z.object({ access: z.string().trim().min(1).max(120).optional(), hazards: z.string().trim().min(1).max(120).optional(), checked: z.boolean().optional() }).strict().optional(),
}).strict();

export function sharedPlaces(db: Database): SharedPlace[] {
  return db.query<{ data: string }, []>("SELECT data FROM shared_places ORDER BY rowid").all().map(row => JSON.parse(row.data) as SharedPlace);
}

/** One atomic, non-destructive import. The marker prevents resurrection after the final deletion. */
export function importSharedPlaces(db: Database, path: string): void {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM resident_api_state WHERE key='places_imported'").get()) return;
    if (!db.query("SELECT 1 FROM shared_places LIMIT 1").get()) {
      let source: string;
      try { source = readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Shared places import failed: source is unreadable.");
        source = '{"places":[]}';
      }
      let places: SharedPlace[];
      try { places = z.object({ places: z.array(sharedPlaceSchema), deaths: z.array(z.unknown()).optional() }).strict().parse(JSON.parse(source)).places; }
      catch { throw new Error("Shared places import failed: invalid source; file left unchanged."); }
      const insert = db.query("INSERT INTO shared_places(name,author,data,updated_at) VALUES(?,?,?,?)");
      for (const place of places) insert.run(place.name, place.author, JSON.stringify(place), 0);
    }
    db.query("INSERT INTO resident_api_state(key,value) VALUES('places_imported',1)").run();
  }).immediate();
}

export function placesOperation(db: Database, resident: string, operation: string, input: unknown, now = Date.now()): unknown {
  if (operation === "list") { z.object({}).strict().parse(input); return sharedPlaces(db); }
  if (operation === "save") {
    const args = saveSchema.parse(input);
    return db.transaction(() => {
      const row = db.query<{ data: string }, [string]>("SELECT data FROM shared_places WHERE name=?").get(args.name);
      const previous = row ? JSON.parse(row.data) as SharedPlace : undefined;
      if (previous && previous.author.toLowerCase() !== resident.toLowerCase()) return { foreign: previous.author };
      const place: SharedPlace = { name: args.name, x: args.x, y: args.y, z: args.z, dimension: args.dimension, author: resident };
      if (args.note !== undefined) place.note = args.note;
      if (args.refuge) place.refuge = {
        ...(args.refuge.access === undefined ? {} : { access: args.refuge.access }),
        ...(args.refuge.hazards === undefined ? {} : { hazards: args.refuge.hazards }),
        ...(args.refuge.checked ? { checkedAt: now } : previous?.refuge?.checkedAt === undefined ? {} : { checkedAt: previous.refuge.checkedAt }),
      };
      db.query("INSERT INTO shared_places(name,author,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET author=excluded.author,data=excluded.data,updated_at=excluded.updated_at")
        .run(place.name, resident, JSON.stringify(place), now);
      return { place };
    }).immediate();
  }
  if (operation === "remove") {
    const { name } = z.object({ name: z.string().trim().min(1).max(40) }).strict().parse(input);
    return db.transaction(() => {
      const row = db.query<{ author: string }, [string]>("SELECT author FROM shared_places WHERE name=?").get(name);
      if (row && row.author.toLowerCase() !== resident.toLowerCase()) return { removed: 0, foreign: row.author };
      return { removed: db.query("DELETE FROM shared_places WHERE name=? AND author=? COLLATE NOCASE").run(name, resident).changes };
    }).immediate();
  }
  throw new Error("Unknown places operation.");
}
