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
      // Nothing listens on port 9 and no token file exists here unless a test says otherwise. Run records stay in
      // this home too: the host's own (~/.local/state/residents) must not reach a test's Activity.
      GARY_SYNAPSE_URL: "http://127.0.0.1:9", SYNAPSE_TOKEN_FILE: join(dir, "synapse-token"),
      COMMONS_SYSTEMCTL: join(dir, "no-systemctl"), RESIDENTS_STATE_DIR: join(dir, "resident-state"), ...env,
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
  /** The model's final answer when a turn ends: activity only, never a thought. */
  answer: (t: number, text: string) => line(t, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" }),
  /**
   * A reasoning item as the harness logs it: the response item, then the finished item with the same id.
   * `sections` is empty while summaries are off (only encrypted content then). `plain` writes the
   * response item's summary as bare strings instead of `{type: "summary_text", text}` parts.
   */
  reasoning(t: number, sections: string[], options: { id?: string; plain?: boolean } = {}): string[] {
    const id = options.id ?? `rs_${++serial}`;
    return [
      line(t, "response_item", { type: "reasoning", id, summary: options.plain ? sections : sections.map(text => ({ type: "summary_text", text })), encrypted_content: "gAAAAB" }),
      line(t + 1, "event_msg", { type: "item_completed", item: { type: "Reasoning", id, summary_text: sections, raw_content: [] } }),
    ];
  },
  /** One summary section as the event Codex emits while summaries stream. */
  agentReasoning: (t: number, text: string) => line(t, "event_msg", { type: "agent_reasoning", text }),
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
/**
 * The line a resident's tool server writes to its call log for the call `rollout.call` describes
 * with the same arguments: `t` is when the call started, the reply came back `ms` later.
 */
export const callLine = (t: number, tool: string, args: object | undefined, text: string, options: { isError?: boolean; ms?: number } = {}) =>
  JSON.stringify({ t: iso(t), ms: options.ms ?? 40, tool, args, error: options.isError === true, text });

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

export interface FakePhoneChat {
  /** The base address the app is given: ends in `/<token>/`. */
  url: string;
  requests: string[];
  /** Commands received, in order. */
  commands: string[];
  /** What a command answers; a string is its output, an Error's message is sent as a 502. Default: no output. */
  answers: Record<string, string | Error>;
  /** A line the server wrote to its log. */
  log(text: string): void;
  /** The service restarted: new boot, ids from 1, and it repeats the last `repeat` log lines. */
  restart(repeat: number): void;
  /** The server replaced its log: new boot, ids from 1, nothing repeated. */
  rotate(): void;
  stop(): void;
}
/** Stands in for phone_chat.py on the server machine: GET console?after= and POST command, on a random loopback port. */
export function fakePhoneChat(): FakePhoneChat {
  interface Line { id: number; text: string; mark?: string; t?: number }
  let lines: Line[] = [], boots = 0;
  const add = (text: string, mark?: string) => { lines.push({ id: (lines.at(-1)?.id ?? 0) + 1, text, ...(mark ? { mark, t: Date.now() / 1000 } : {}) }); };
  const fake: FakePhoneChat = {
    url: "", requests: [], commands: [], answers: {},
    log: text => add(text),
    restart(repeat) {
      const kept = lines.filter(line => !line.mark).slice(-repeat);
      boots++; lines = [];
      for (const line of kept) add(line.text);
    },
    rotate() { boots++; lines = []; },
    stop: () => { void server.stop(true); },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      fake.requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/chat-token/console") {
        const after = Number(url.searchParams.get("after")) || 0;
        return Response.json({ boot: `boot-${boots}`, lines: lines.filter(line => line.id > after) });
      }
      if (url.pathname === "/chat-token/command" && request.method === "POST") {
        const { command } = await request.json() as { command: string };
        fake.commands.push(command);
        add(`> ${command}`, "command");
        const answer = fake.answers[command] ?? "";
        const said = answer instanceof Error ? answer.message : answer;
        for (const line of (said || "(no output)").split("\n")) add(line, "output");
        return answer instanceof Error ? Response.json({ error: said }, { status: 502 }) : Response.json({ output: said });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/chat-token/`;
  return fake;
}

const two = (value: number) => String(value).padStart(2, "0");
/** A line as the Minecraft server writes it to latest.log: stamped in UTC. */
export function serverLogLine(t: number, message: string, level = "INFO", logger = "net.minecraft.server.MinecraftServer/", thread = "Server thread") {
  const date = new Date(t);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
  const stamp = `${two(date.getUTCDate())}${month}${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
  return `[${stamp}] [${thread}/${level}] [${logger}]: ${message}`;
}
/** A line as a client writes it to its log: local time, no date. */
export function clientLogLine(t: number, message: string) {
  const date = new Date(t);
  return `[${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}] [Render thread/INFO]: ${message}`;
}
