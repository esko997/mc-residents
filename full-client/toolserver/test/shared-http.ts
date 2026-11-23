import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommonsClient } from "../src/commons.ts";
import { societyOperation } from "../../commons/src/resident-society.ts";
import { knowledgeOperation } from "../../commons/src/resident-knowledge.ts";

export const schemaFile = fileURLToPath(new URL("../../commons/schema.sql", import.meta.url));

/** Real HTTP transport around the hub stores, with a fixed test-only credential map. */
export function sharedHttp(db: Database) {
  const directory = mkdtempSync(join(tmpdir(), "resident-shared-http-"));
  const credentials = new Map<string, string>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const resident = credentials.get(request.headers.get("authorization") ?? "");
      if (!resident) return Response.json({ error: { code: "unauthorized", message: "Unknown credential" } }, { status: 401 });
      const match = new URL(request.url).pathname.match(/^\/resident-api\/v1\/(society|knowledge)\/([A-Za-z]+)$/);
      if (request.method !== "POST" || !match) return new Response(null, { status: 404 });
      try {
        const body = await request.json() as { args: unknown };
        if (!body || typeof body !== "object" || Object.keys(body).join() !== "args") throw new Error("Expected args envelope");
        const result = match[1] === "society"
          ? societyOperation(db, resident, match[2]!, body.args)
          : knowledgeOperation(db, resident, match[2]!, body.args);
        return Response.json({ result });
      } catch (error) {
        return Response.json({ error: { code: "invalid_request", message: error instanceof Error ? error.message : "Failed" } }, { status: 400 });
      }
    },
  });
  return {
    client(resident = "Gary") {
      const token = `test-token-${resident}`;
      const tokenFile = join(directory, resident);
      writeFileSync(tokenFile, token, { mode: 0o600 });
      credentials.set(`Bearer ${token}`, resident);
      return new CommonsClient(server.url.toString(), tokenFile);
    },
    close() { server.stop(true); rmSync(directory, { recursive: true, force: true }); },
  };
}
