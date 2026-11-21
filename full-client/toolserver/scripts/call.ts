/**
 * Call a resident's body tools by hand, in order, through one tool-server
 * process: the way to check a live body without spending a model session.
 *
 *   CLIENT_LOG=... RESIDENT_NAME=... bun scripts/call.ts status '{}' go_to '{"x":10,"z":20}' wait '{"seconds":20}'
 *
 * Environment is passed through to the server unchanged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const calls = process.argv.slice(2);
if (calls.length === 0 || calls.length % 2 !== 0) {
  console.error("usage: bun scripts/call.ts <tool> '<json arguments>' [<tool> '<json arguments>' ...]");
  process.exit(2);
}

const client = new Client({ name: "call", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);

for (let index = 0; index < calls.length; index += 2) {
  const name = calls[index]!;
  const started = Date.now();
  const result = await client.callTool({ name, arguments: JSON.parse(calls[index + 1]!) }, undefined, { timeout: 180_000 });
  console.log(`--- ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)${result.isError ? " ERROR" : ""}`);
  for (const part of result.content as { type: string; text?: string }[]) {
    console.log(part.type === "text" ? part.text : `[${part.type} content]`);
  }
}
await client.close();
