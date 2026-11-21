// Shared by the tests and scripts/demo.ts: a throwaway resident home on disk,
// rollout lines in the shapes Codex writes, and a stand-in for a client's Synapse API.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { loadConfig, type Config } from "../src/config.ts";

export const fixtures = resolve(import.meta.dir, "..", "fixtures");
export const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

export interface Home { dir: string; put(path: string, content: string | Uint8Array): string; config(env?: Record<string, string>): Config; remove(): void }
export function tempHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "commons-home-"));
  const put = (path: string, content: string | Uint8Array) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  mkdirSync(join(dir, "resident", "gary"), { recursive: true });
  return {
    dir, put,
    config: (env = {}) => loadConfig({
      GARY_CLIENT_HOME: dir, COMMONS_DB: join(dir, "commons", "commons.sqlite"),
      // Nothing listens on port 9 and no token file exists here unless a test says otherwise.
      GARY_SYNAPSE_URL: "http://127.0.0.1:9", SYNAPSE_TOKEN_FILE: join(dir, "synapse-token"),
      COMMONS_SYSTEMCTL: join(dir, "no-systemctl"), ...env,
    }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const iso = (t: number) => new Date(t).toISOString();
const line = (t: number, type: string, payload: object) => JSON.stringify({ timestamp: iso(t), type, payload });
let serial = 0;

export const rollout = {
  meta: (t: number, cwd: string, id = `session-${++serial}`) => line(t, "session_meta", { id, session_id: id, cwd, originator: "codex_exec" }),
  model: (t: number, model: string) => line(t, "event_msg", { type: "thread_settings_applied", thread_settings: { model } }),
  prompt: (t: number, text: string) => line(t, "event_msg", { type: "item_completed", item: { type: "UserMessage", id: `u${++serial}`, content: [{ type: "text", text }] } }),
  remark: (t: number, text: string) => line(t, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "commentary" }),
  tokens: (t: number, total: number, usedPercent = 9) => line(t, "event_msg", {
    type: "token_count",
    info: { total_token_usage: { input_tokens: total - 100, cached_input_tokens: Math.floor(total / 2), output_tokens: 100, reasoning_output_tokens: 10, total_tokens: total } },
    rate_limits: { primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1795617379 }, plan_type: "pro" },
  }),
  /** A body tool call as the current harness logs it: the script, the finished MCP item, the script's output. */
  call(t: number, tool: string, args: object, result: string, options: { isError?: boolean; ms?: number } = {}): string[] {
    const callId = `call_${++serial}`, ms = options.ms ?? 40;
    const reply = { content: [{ type: "text", text: result }], isError: options.isError === true };
    return [
      line(t, "response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input: `const r=await tools.mcp__body__${tool}(${JSON.stringify(args)});text(r);\n` }),
      line(t + ms, "event_msg", {
        type: "item_completed",
        item: { type: "McpToolCall", id: `exec-${serial}`, server: "body", tool, arguments: args, status: "completed", result: reply, duration: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 } },
      }),
      line(t + ms + 5, "response_item", {
        type: "custom_tool_call_output", call_id: callId,
        output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify(reply) }],
      }),
    ];
  },
  /** The same call from a harness that logs only the script and its output. */
  scriptCall(t: number, script: string, replies: string[]): string[] {
    const callId = `call_${++serial}`;
    return [
      line(t, "response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input: script }),
      line(t + 50, "response_item", {
        type: "custom_tool_call_output", call_id: callId,
        output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, ...replies.map(text => ({ type: "input_text", text }))],
      }),
    ];
  },
};
export const reply = (text: string, isError = false) => JSON.stringify({ content: [{ type: "text", text }], isError });

/** A PNG of plain bands, big enough to look like a picture on the page. */
export function png(width = 160, height = 90, tint = [90, 140, 90]): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    const sky = y < height * 0.45;
    for (let x = 0; x < width; x++) {
      const shade = sky ? [120, 170, 230] : tint.map(value => Math.max(0, value - ((x >> 3) + (y >> 3)) % 2 * 18));
      raw.set(shade, row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(Number(Bun.hash.crc32(body)), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

export interface FakeSynapse { url: string; requests: string[]; state: Record<string, unknown>; stop(): void }
/** Answers /state, /screenshot and /gui like a running client, on a random loopback port. */
export function fakeSynapse(options: { state?: Record<string, unknown>; token?: string; picture?: Uint8Array } = {}): FakeSynapse {
  const fake: FakeSynapse = {
    url: "", requests: [],
    state: options.state ?? JSON.parse(fixture("state-full.json")).data,
    stop: () => { void server.stop(true); },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      fake.requests.push(url.pathname + url.search);
      if (options.token && request.headers.get("X-Synapse-Token") !== options.token) {
        return Response.json({ ok: false, error: { code: "unauthorized", message: "bad token" } }, { status: 401 });
      }
      if (url.pathname === "/state") return Response.json({ ok: true, endpoint: "/state", data: fake.state, error: null });
      if (url.pathname === "/screenshot") return Response.json({ ok: true, data: { image: Buffer.from(options.picture ?? png()).toString("base64") } });
      if (url.pathname === "/gui") return Response.json(JSON.parse(fixture("gui.json")));
      return Response.json({ ok: false, error: "no such endpoint" }, { status: 404 });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  return fake;
}
