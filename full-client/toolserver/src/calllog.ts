import { appendFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Call = (name: string, args: unknown, signal?: AbortSignal) => Promise<CallToolResult>;

/**
 * Every call the mind makes, one JSON line each, for the caretaker and the
 * maintainers. The rollouts cannot serve: under Codex's code mode a model calls
 * tools from JavaScript it writes itself (Sol wrapped them in its own helper),
 * so the call sites in a rollout follow no fixed pattern. Writing must never
 * fail a call.
 */
export function withCallLog(path: string | undefined, call: Call): Call {
  if (!path) return call;
  return async (name, args, signal) => {
    const started = new Date();
    const result = await call(name, args, signal);
    try {
      const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      appendFileSync(path, JSON.stringify({
        t: started.toISOString(), ms: Date.now() - started.getTime(), tool: name, args, error: result.isError === true, text,
      }) + "\n");
    } catch { /* the log is a record, not a dependency */ }
    return result;
  };
}
