// Stations never initialize the hub schema or open shared tables.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openStation(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS positions (
      resident TEXT NOT NULL, at INTEGER NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
      dimension TEXT NOT NULL, health REAL, food INTEGER,
      PRIMARY KEY (resident, at)
    ) WITHOUT ROWID;`);
  return db;
}
