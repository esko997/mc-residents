import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Body } from "./body.ts";
import { configuration, Synapse } from "./synapse.ts";
import { definitions, Tools } from "./tools.ts";
import { openKnowledge } from "./knowledge/index.ts";
import type { Knowledge } from "./knowledge/types.ts";
import { withCallLog } from "./calllog.ts";

async function main() {
  const config = configuration();
  const api = await Synapse.connect(config);
  let knowledge: Knowledge | undefined;
  let knowledgeError = "KNOWLEDGE_DB is not configured.";
  if (config.knowledgeDb) {
    try { knowledge = openKnowledge(config.knowledgeDb); }
    catch (error) { knowledgeError = error instanceof Error ? error.message : "Database could not be opened."; }
  }
  if (!knowledge) console.error(`Knowledge unavailable: ${knowledgeError}`);
  const body = new Body(config, api);
  const tools = new Tools(body, knowledge, knowledgeError);
  const server = new Server({ name: "resident-full-client", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.registeredNames.map(name => ({
      name, description: definitions[name].description,
      inputSchema: { ...zodToJsonSchema(definitions[name].schema, { target: "jsonSchema7", $refStrategy: "none" }), type: "object" } as Tool["inputSchema"],
    })),
  }));
  const call = withCallLog(process.env.CALL_LOG, (name, args, signal) => tools.call(name, args, signal));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => call(request.params.name, request.params.arguments ?? {}, extra.signal));
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    await body.close(); tools.close(); knowledge?.close(); await server.close();
  }
  process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.stdin.on("end", () => { void shutdown(); });
  await body.start();
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(`Resident tools: ${error instanceof Error ? error.message : "startup failed"}`); process.exitCode = 1; });
