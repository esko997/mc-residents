import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCommons } from "../src/db.ts";
import { ResidentApi } from "../src/resident-api.ts";
import type { ResidentSightOptions } from "../src/resident-sight.ts";
import type { FrontierOptions } from "../src/resident-advancements.ts";
import { CommonsClient } from "../../toolserver/src/commons.ts";
import type { Database } from "bun:sqlite";

export interface HubIdentity { client: CommonsClient; commonsUrl: string; commonsTokenFile: string; token: string }
export interface TestResidentHub {
  db: Database; api: ResidentApi; directory: string; credentialsFile: string; url: string;
  identity(name?: string, role?: "resident" | "caretaker"): HubIdentity;
  disconnect(): void;
  close(): void;
}

/** Real loopback hub, real bearer authentication and disposable DB for both packages. Server sight is off unless
 * `sight` supplies an observer (tests pass a fake `get`); advancement data is off unless `advancements` supplies an
 * ingest health; the process environment is never consulted. */
export function residentHub(options: { sight?: ResidentSightOptions; advancements?: FrontierOptions } = {}): TestResidentHub {
  const directory = mkdtempSync(join(tmpdir(), "resident-api-"));
  const credentialsFile = join(directory, "credentials.json");
  const entries: { name: string; role: "resident" | "caretaker"; sha256: string }[] = [];
  writeFileSync(credentialsFile, "[]", { mode: 0o600 });
  const db = openCommons(join(directory, "commons.sqlite"), join(import.meta.dir, "../schema.sql"));
  const api = new ResidentApi(db, credentialsFile, true, {}, options.sight ?? { source: null }, options.advancements ?? {});
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => api.fetch(request) });
  const identities = new Map<string, HubIdentity>();
  return {
    db, api, directory, credentialsFile, url: server.url.toString(),
    identity(name = "Gary", role: "resident" | "caretaker" = "resident") {
      const existing = identities.get(name); if (existing) return existing;
      const token = `test-${name}-${role}`, commonsTokenFile = join(directory, `${name}.token`), commonsUrl = server.url.toString();
      writeFileSync(commonsTokenFile, token, { mode: 0o600 });
      entries.push({ name, role, sha256: createHash("sha256").update(token).digest("hex") });
      writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
      const result = { client: new CommonsClient(commonsUrl, commonsTokenFile), commonsUrl, commonsTokenFile, token };
      identities.set(name, result); return result;
    },
    disconnect() { server.stop(true); },
    close() { api.close(); server.stop(true); db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
