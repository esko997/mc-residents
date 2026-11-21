import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The one schema, shared with the management app: full-client/commons/schema.sql, a sibling of this package. */
export const schemaFile = join(import.meta.dir, "..", "..", "commons", "schema.sql");

/**
 * Opens the commons, the SQLite file every resident's tool server and the
 * management app write to, creating it and its tables when missing. Throws
 * with a reason a resident can pass on; the caller reports and carries on.
 */
export function openCommons(path: string): Database {
  let schema: string;
  try { schema = readFileSync(schemaFile, "utf8"); }
  catch { throw new Error(`schema file missing at ${schemaFile}`); }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    // Before anything else: another process may hold the write lock while this one starts.
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(schema);
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) { db.close(); throw error; }
  return db;
}
