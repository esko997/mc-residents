import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openCommons } from "../src/db.ts";
import { skillsOperation } from "../src/resident-skills.ts";
import { placesOperation } from "../src/resident-places.ts";
import { ResidentEvents } from "../src/resident-events.ts";
import { z } from "zod";

export interface SkillsHub {
  db: Database;
  url: string;
  tokenFile(resident: string): Promise<string>;
  close(): void;
}

/** Isolated HTTP transport with real hub storage and explicit test credentials. */
export function skillsHub(path: string): SkillsHub {
  const db = openCommons(path, new URL("../schema.sql", import.meta.url).pathname);
  const events = new ResidentEvents(db);
  const credentials = new Map<string, string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const resident = credentials.get(request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "");
    if (!resident) return Response.json({ error: { code: "unauthorized", message: "Unknown test credential." } }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/resident-api/v1/events") {
      const after = Number(url.searchParams.get("after") ?? 0), wait = Number(url.searchParams.get("wait") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0 || wait > 25)
        return Response.json({ error: { code: "invalid_request", message: "Invalid event cursor or wait." } }, { status: 400 });
      return Response.json({ result: await events.poll(resident, after, wait, request.signal) });
    }
    const match = /^\/resident-api\/v1\/(skills|places)\/([a-z_]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    try {
      const { args } = z.object({ args: z.unknown() }).strict().parse(await request.json());
      const result = match[1] === "skills" ? skillsOperation(db, resident, match[2]!, args) : placesOperation(db, resident, match[2]!, args);
      return Response.json({ result });
    } catch (error) {
      return Response.json({ error: { code: "invalid_request", message: error instanceof Error ? error.message : String(error) } }, { status: 400 });
    }
  } });
  return {
    db, url: server.url.toString(),
    async tokenFile(resident: string) {
      const token = randomUUID(), tokenPath = join(dirname(path), `token-${token}`);
      credentials.set(token, resident);
      await writeFile(tokenPath, token, { mode: 0o600 });
      return tokenPath;
    },
    close() { events.close(); server.stop(true); db.close(); },
  };
}
