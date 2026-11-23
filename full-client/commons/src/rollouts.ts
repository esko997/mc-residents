// Keeps a short, readable record of what each resident did, from two kinds of file
// (one JSON object per line in both). The residents' Codex rollouts have the model's
// own words, its reasoning summaries, token counts and shell calls. The call logs
// their tool servers write have every body call with its reply. Before a resident
// had a call log, its body calls are read from the rollouts too. Files grow while a
// session runs and reach several MB, so each is read once and then only its new bytes.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { clip, finite, record } from "./json.ts";

export type EntryKind = "call" | "event" | "said" | "remark" | "thought" | "prompt";
export interface Entry {
  id: number;
  /** Unix ms. For an event: when the tool result that reported it came back. */
  t: number;
  resident: string;
  /** The Codex session it was read from; empty for a body call or event read from a call log. */
  session: string;
  kind: EntryKind;
  /** call, said: tool name without the mcp__body__ prefix. */
  tool?: string;
  args?: string;
  result?: string;
  error?: boolean;
  ms?: number;
  /** event: died, stopped_short, chat, ... */
  type?: string;
  /** event: the rest of its line. said, remark, thought, prompt: the words. */
  text?: string;
  /** Routine lines (status, wait, arrivals, Baritone chatter) a reader usually skips. */
  quiet: boolean;
}
export interface Tokens { input: number; cached: number; output: number; reasoning: number; total: number }
export interface SessionInfo {
  id: string; resident: string; model?: string; startedAt: number; lastAt: number; tokens?: Tokens;
}
export interface Quota { usedPercent: number; windowMinutes?: number; resetsAt?: number; plan?: string; at: number }
/** `session` is the one written to most recently; `day` adds up every session active in the last 24 hours. */
export interface TokenTotals { session?: SessionInfo; day: Tokens; daySessions: number }
export interface Indicators {
  windowMinutes: number;
  calls: number;
  byTool: { tool: string; count: number }[];
  errors: number;
  arrived: number; stoppedShort: number; navigationStopped: number; deaths: number; reflexes: number; hurt: number;
  chatHeard: number; said: number;
  /** The same action (tool and arguments) made back to back, longest runs first. */
  repeats: { action: string; times: number; lastAt: number }[];
}

export const QUIET_TOOLS: Record<string, true> = { status: true, wait: true, picture: true, screen: true, inventory: true, shell: true };
export const NOTABLE_EVENTS: Record<string, true> = { died: true, stopped_short: true, navigation_stopped: true, reflex: true, chat: true };

function compactValue(value: unknown): string {
  if (typeof value === "string") return /^[\w:.\-/#]+$/.test(value) ? value : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(compactValue).join(",")}]`;
  if (value && typeof value === "object") return `{${compactArgs(value, Infinity)}}`;
  return String(value);
}
/** `{x:60,y:66,z:-99}` as `x=60 y=66 z=-99`: one short line a person can scan. */
export function compactArgs(args: unknown, limit = 160): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object" || Array.isArray(args)) return clip(compactValue(args), limit);
  return clip(Object.entries(args).map(([key, value]) => `${key}=${compactValue(value)}`).join(" "), limit);
}

/** A tool result is its own text, then `Since last time:` and numbered event lines. */
export function splitResult(text: string): { body: string; events: { seq: number; type: string; text: string }[] } {
  const body: string[] = [];
  const events: { seq: number; type: string; text: string }[] = [];
  let inEvents = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("Since last time:")) { inEvents = true; continue; }
    if (inEvents) {
      const found = /^(\d+) ([a-z_]+)(?: (.*))?$/.exec(line);
      if (found) { events.push({ seq: Number(found[1]), type: found[2], text: found[3] ?? "" }); continue; }
      if (line === "none" || line === "") continue;
      inEvents = false;
    }
    body.push(line);
  }
  return { body: body.join("\n").trim(), events };
}

/** The text of a tool result or message, whatever shape the harness logged it in. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(part => { const text = record(part).text; return typeof text === "string" ? text : ""; }).filter(Boolean).join("\n");
  }
  return "content" in record(value) ? textOf(record(value).content) : "";
}

/** Body and shell calls written inside the JavaScript of a `custom_tool_call`. */
export function callsInScript(script: string): { tool: string; args: unknown; raw: string }[] {
  const found: { tool: string; args: unknown; raw: string }[] = [];
  const opener = /tools\.(mcp__body__(\w+)|exec_command)\s*\(/g;
  for (let match = opener.exec(script); match; match = opener.exec(script)) {
    // Walk to the matching bracket; quotes may hold brackets of their own.
    let depth = 1, quote = "", index = opener.lastIndex;
    for (; index < script.length && depth > 0; index++) {
      const char = script[index];
      if (quote) { if (char === "\\") index++; else if (char === quote) quote = ""; }
      else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(" || char === "{" || char === "[") depth++;
      else if (char === ")" || char === "}" || char === "]") depth--;
    }
    if (depth > 0) break;
    const raw = script.slice(opener.lastIndex, index - 1).trim();
    let args: unknown = raw;
    try { args = JSON.parse(raw.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')); } catch { /* keep the source text */ }
    found.push({ tool: match[2] ?? "shell", args, raw });
    opener.lastIndex = index;
  }
  return found;
}

type NewEntry = Omit<Entry, "id" | "resident" | "session">;
/** The `session` of entries read from a call log, which does not say which session made a call. */
const LOGGED = "";

/** The entries one body call leaves: the call itself (or what was said), then the events its reply reported. */
function callEntries(t: number, tool: string, args: unknown, reply: string, failed: boolean, ms?: number): NewEntry[] {
  const { body, events } = splitResult(reply);
  const error = failed || /^Error\b/.test(body);
  const words = tool === "say" ? record(args).text : undefined;
  const said = typeof words === "string";
  return [
    {
      t, kind: said ? "said" : "call", tool, args: compactArgs(args), result: clip(body, 400), ms,
      ...(error ? { error: true } : {}), ...(said ? { text: clip(words, 400) } : {}),
      quiet: QUIET_TOOLS[tool] === true && !error,
    },
    ...events.map((event): NewEntry => ({ t, kind: "event", type: event.type, text: clip(event.text, 300), quiet: NOTABLE_EVENTS[event.type] !== true })),
  ];
}

/** A file another program appends to: how far it was read, and the start of a line still being written. */
interface Tail { path: string; offset: number; carry: Buffer }
/** Hands over each whole line appended since the last time. `line` answers whether the rest of the file is wanted. */
async function readAppended(tail: Tail, size: number, line: (data: Buffer, start: number, end: number) => boolean) {
  const file = await open(tail.path, "r");
  try {
    while (tail.offset < size) {
      const buffer = Buffer.alloc(Math.min(size - tail.offset, 4 << 20));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, tail.offset);
      if (bytesRead === 0) break;
      tail.offset += bytesRead;
      const data = tail.carry.length ? Buffer.concat([tail.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      // Only whole lines are read; the writer may be halfway through the last one.
      let start = 0, wanted = true;
      for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
        if (wanted && end > start) wanted = line(data, start, end);
        start = end + 1;
      }
      // Do not hoard the bytes of a file that is skipped wholesale.
      if (!wanted) { tail.carry = Buffer.alloc(0); tail.offset = size; break; }
      tail.carry = Buffer.from(data.subarray(start));
    }
  } finally { await file.close(); }
}

interface Pending { t: number; script: string; itemsSeen: number }
interface FileState extends Tail {
  /** undefined: first line not read yet. null: not a resident's session. */
  resident: string | null | undefined;
  info: SessionInfo;
  pending: Map<string, Pending>;
  /** The harness logs a reasoning summary twice (response item and finished item); it is recorded once. */
  lastThought: string;
}
interface CallLog extends Tail {
  /** Device and inode: a log that was moved away and begun again is another file, whatever its size. */
  identity: string;
  /**
   * From this time on the log, not the rollouts, is the record of the resident's body calls:
   * when its first call started, or the start of the window when the log reaches further back.
   * Unset until a call was read from it.
   */
  from?: number;
}
interface ResidentDir { name: string; dir: string }

/** Outer type and payload type of the lines this record is built from. */
const NEEDED: Record<string, true> = {
  "response_item:custom_tool_call": true, "response_item:custom_tool_call_output": true,
  "response_item:message": true, "response_item:reasoning": true, "event_msg:token_count": true, "event_msg:item_completed": true,
  "event_msg:thread_settings_applied": true,
};
// Most bytes of a rollout are lines this record never uses (usage records, turn context,
// events of other kinds). Their kind is readable from the first few bytes without parsing
// megabytes of JSON. A line is skipped only when its kind was positively read and is not needed;
// anything that does not look as expected is parsed in full.
const KIND = /^\{\s*"timestamp":\s*"[^"]*",\s*(?:"ordinal":\s*\d+,\s*)?"type":\s*"(\w+)",\s*"payload":\s*\{\s*"type":\s*"(\w+)"/;
// A call-log line opens with when the call started and how long it took, readable without parsing the reply.
const CALL_TIMES = /^\{"t":"([^"]+)","ms":(\d+)[,}]/;

export class RolloutTail {
  private started = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private rereads = 0;
  private files = new Map<string, FileState>();
  private callLogs = new Map<string, CallLog>();
  private entries = new Map<string, Entry[]>();
  private unsorted = new Set<string>();
  private nextId = 1;
  private running?: Promise<void>;
  quota?: Quota;

  constructor(
    private sessionsDir: string, private residents: ResidentDir[],
    private options: { days?: number; maxEntries?: number; now?: () => number; callsDir?: string } = {},
  ) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  /** Changes when ids handed out before no longer name the same entries: at a restart, and when a file was dropped to be read again. */
  get boot() { return `${this.started}-${this.rereads}`; }

  /** Hub records share the same ids and pagination as file-backed Activity. */
  recordEvent(resident: string, t: number, type: string, text: string): void {
    this.push(resident, "hub", { t, kind: "event", type, text, quiet: false });
  }

  /** Read whatever was appended since the last call. Concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.running ??= this.pass().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass() {
    const cutoff = this.now() - (this.options.days ?? 2) * 86_400_000;
    // Call logs first: a rollout is read knowing from when its resident's body calls are on record there.
    // A tool server writes a call to its log before the harness can write the result to the rollout,
    // so a call the rollout has and the log was not yet read to turns up on the next pass.
    const { callsDir } = this.options;
    if (callsDir) for (const resident of this.residents) await this.readCalls(join(callsDir, `${resident.name}.jsonl`), resident.name, cutoff);
    for (const path of await this.rolloutFiles(cutoff)) {
      try {
        const info = await stat(path);
        let state = this.files.get(path);
        if (!state && info.mtimeMs < cutoff) continue;
        if (state && info.size < state.offset) { this.forget(state); state = undefined; }
        if (!state) {
          state = { path, offset: 0, carry: Buffer.alloc(0), resident: undefined, pending: new Map(), lastThought: "", info: { id: path, resident: "", startedAt: 0, lastAt: 0 } };
          this.files.set(path, state);
        }
        const reading = state;
        // A session that is not a resident's is skipped wholesale.
        if (info.size > state.offset) await readAppended(state, info.size, (data, start, end) => { this.line(reading, data, start, end); return reading.resident !== null; });
      } catch { /* a file that vanished or cannot be read is tried again on the next pass */ }
    }
  }

  private async rolloutFiles(cutoff: number): Promise<string[]> {
    const names = async (dir: string) => { try { return (await readdir(dir)).sort(); } catch { return []; } };
    // Directories are sessions/YYYY/MM/DD; a day older than the window cannot hold a session inside it
    // unless the session ran over midnight, hence one day of slack.
    const oldest = new Date(cutoff - 86_400_000).toISOString().slice(0, 10).replaceAll("-", "/");
    const found: string[] = [];
    for (const year of await names(this.sessionsDir)) {
      for (const month of await names(join(this.sessionsDir, year))) {
        for (const day of await names(join(this.sessionsDir, year, month))) {
          if (`${year}/${month}/${day}` < oldest) continue;
          const dir = join(this.sessionsDir, year, month, day);
          for (const file of await names(dir)) if (file.endsWith(".jsonl")) found.push(join(dir, file));
        }
      }
    }
    return found;
  }

  /** Takes back what was read from one file, so that it can be read again. */
  private drop(resident: string, session: string) {
    this.entries.set(resident, (this.entries.get(resident) ?? []).filter(entry => entry.session !== session));
    this.rereads++;
  }

  private forget(state: FileState) {
    this.files.delete(state.path);
    if (state.resident) this.drop(state.resident, state.info.id);
  }

  /** A resident's call log: `<Name>.jsonl`, absent until its tool server made a call with the log switched on. */
  private async readCalls(path: string, resident: string, cutoff: number) {
    let log = this.callLogs.get(resident);
    const before = log?.from;
    try {
      const info = await stat(path).catch(() => undefined);
      const identity = info ? `${info.dev}:${info.ino}` : "";
      if (log && (!info || identity !== log.identity || info.size < log.offset)) {
        // Removed or begun again: what was read from the old one is no longer on record.
        this.callLogs.delete(resident);
        this.drop(resident, LOGGED);
        log = undefined;
      }
      if (info) {
        if (!log) this.callLogs.set(resident, log = { path, identity, offset: 0, carry: Buffer.alloc(0) });
        const reading = log;
        if (info.size > log.offset) await readAppended(log, info.size, (data, start, end) => { this.loggedCall(resident, reading, data, start, end, cutoff); return true; });
      }
    } catch { /* a log that cannot be read is tried again on the next pass */ }
    // Which calls the rollouts supply depends on where the log begins: they are read again under the new rule.
    if (log?.from !== before) for (const state of [...this.files.values()]) if (state.resident === resident) this.forget(state);
  }

  /** One line of a call log: `{t: when the call started, ms, tool, args, error, text: the whole reply}`. */
  private loggedCall(resident: string, log: CallLog, data: Buffer, start: number, end: number, cutoff: number) {
    // A log is never trimmed; calls from before the window are passed over without parsing their replies.
    const times = CALL_TIMES.exec(data.toString("latin1", start, Math.min(end, start + 64)));
    if (times && log.from !== undefined && Date.parse(times[1]) + Number(times[2]) < log.from) return;
    let item: Record<string, unknown>;
    try { item = record(JSON.parse(data.toString("utf8", start, end))); } catch { return; }
    const started = Date.parse(typeof item.t === "string" ? item.t : ""), ms = finite(item.ms);
    if (!Number.isFinite(started) || typeof item.tool !== "string") return;
    log.from ??= Math.max(started, cutoff);
    // As in a rollout, a call is timed by when its reply came back.
    const t = started + (ms ?? 0);
    if (t < log.from) return;
    const reply = typeof item.text === "string" ? item.text : "";
    for (const entry of callEntries(t, item.tool, item.args, reply, item.error === true, ms)) this.push(resident, LOGGED, entry);
  }

  private line(state: FileState, data: Buffer, start: number, end: number) {
    const kind = KIND.exec(data.toString("latin1", start, Math.min(end, start + 240)));
    if (kind && !NEEDED[`${kind[1]}:${kind[2]}`] && state.resident !== undefined) return;
    let item: Record<string, unknown>;
    try { item = record(JSON.parse(data.toString("utf8", start, end))); } catch { return; }
    const payload = record(item.payload);
    if (state.resident === undefined) {
      // The first line says whose session this is, by the directory it ran in.
      const cwd = item.type === "session_meta" && typeof payload.cwd === "string" ? payload.cwd.replace(/\/+$/, "") : "";
      const owner = this.residents.find(r => r.dir === cwd) ?? this.residents.find(r => cwd.endsWith(`/resident/${r.name.toLowerCase()}`));
      state.resident = owner?.name ?? null;
      if (!owner) return;
      state.info.resident = owner.name;
      state.info.id = typeof payload.id === "string" ? payload.id : state.path;
    }
    const t = Date.parse(typeof item.timestamp === "string" ? item.timestamp : "");
    if (!Number.isFinite(t)) return;
    state.info.startedAt ||= t;
    state.info.lastAt = Math.max(state.info.lastAt, t);
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "token_count") this.tokens(state, payload, t);
    else if (type === "thread_settings_applied") {
      const model = record(payload.thread_settings).model;
      if (typeof model === "string") state.info.model = model;
    } else if (type === "item_completed") this.item(state, record(payload.item), t);
    else if (type === "message" && payload.role === "assistant") {
      const words = textOf(payload.content).trim();
      if (words) this.add(state, { t, kind: "remark", text: clip(words, 600), quiet: false });
    } else if (type === "reasoning") this.thought(state, payload.summary, t);
    else if (type === "custom_tool_call") {
      if (typeof payload.call_id === "string") state.pending.set(payload.call_id, { t, script: String(payload.input ?? ""), itemsSeen: 0 });
    } else if (type === "custom_tool_call_output") this.scriptOutput(state, payload, t);
  }

  private tokens(state: FileState, payload: Record<string, unknown>, t: number) {
    const info = record(payload.info);
    if ("total_token_usage" in info) {
      const usage = record(info.total_token_usage);
      const number = (key: string) => Number(usage[key]) || 0;
      state.info.tokens = {
        input: number("input_tokens"), cached: number("cached_input_tokens"), output: number("output_tokens"),
        reasoning: number("reasoning_output_tokens"), total: number("total_tokens"),
      };
    }
    const limits = record(payload.rate_limits), primary = record(limits.primary);
    const used = finite(primary.used_percent);
    if (used !== undefined && (!this.quota || t >= this.quota.at)) {
      this.quota = {
        usedPercent: used, at: t, windowMinutes: finite(primary.window_minutes),
        resetsAt: finite(primary.resets_at) === undefined ? undefined : Number(primary.resets_at) * 1000,
        plan: typeof limits.plan_type === "string" ? limits.plan_type : undefined,
      };
    }
  }

  /**
   * The model's reasoning summary: a list of short texts, empty unless summaries are switched on
   * in the resident's Codex config. Nothing is recorded for an empty one.
   */
  private thought(state: FileState, summary: unknown, t: number) {
    const words = (Array.isArray(summary) ? summary : []).map(part => typeof part === "string" ? part : textOf([part]))
      .filter(Boolean).join("\n").trim();
    if (!words || words === state.lastThought) return;
    state.lastThought = words;
    this.add(state, { t, kind: "thought", text: clip(words, 600), quiet: false });
  }

  /** The harness's own record of a finished item: exact tool name, arguments and result. */
  private item(state: FileState, item: Record<string, unknown>, t: number) {
    if (item.type === "Reasoning") return this.thought(state, item.summary_text, t);
    if (item.type === "UserMessage") {
      const words = textOf(item.content).trim();
      if (words) this.add(state, { t, kind: "prompt", text: clip(words, 600), quiet: true });
      return;
    }
    if (item.type !== "McpToolCall" || item.server !== "body" || typeof item.tool !== "string") return;
    for (const pending of state.pending.values()) pending.itemsSeen++;
    const result = record(item.result), duration = record(item.duration);
    const ms = "secs" in duration ? Math.round(Number(duration.secs) * 1000 + Number(duration.nanos) / 1e6) : undefined;
    const failure = typeof item.error === "string" ? item.error : textOf(record(item.error).message);
    this.toolCall(state, t, item.tool, item.arguments, textOf(result) || failure, result.isError === true || item.status === "failed", Number.isFinite(ms) ? ms : undefined);
  }

  /** A body call found in a rollout. From where the resident's call log begins, it is left to the log. */
  private toolCall(state: FileState, t: number, tool: string, args: unknown, resultText: string, failed: boolean, ms?: number) {
    const from = this.callLogs.get(state.info.resident)?.from;
    if (from !== undefined && t >= from) return;
    for (const entry of callEntries(t, tool, args, resultText, failed, ms)) this.add(state, entry);
  }

  /** The script's own output. Body calls were already recorded from their items when the harness logs those. */
  private scriptOutput(state: FileState, payload: Record<string, unknown>, t: number) {
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    const pending = state.pending.get(callId);
    if (!pending) return;
    state.pending.delete(callId);
    const parts = Array.isArray(payload.output) ? payload.output.map(part => textOf([part])) : [textOf(payload.output)];
    const header = parts[0] ?? "";
    const outputs = /^Script \w+\nWall time/.test(header) ? parts.slice(1) : parts;
    const calls = callsInScript(pending.script);
    const body = calls.filter(call => call.tool !== "shell");
    if (pending.itemsSeen === 0 && body.length) {
      // An older harness: pair each call with its result, which is the MCP reply as JSON text.
      const replies = outputs.flatMap(text => {
        let parsed: Record<string, unknown>;
        try { parsed = record(JSON.parse(text)); } catch { return []; }
        return Array.isArray(parsed.content) ? [{ text: textOf(parsed.content), failed: parsed.isError === true }] : [];
      });
      const paired = replies.length === body.length;
      body.forEach((call, index) => {
        const last = index === body.length - 1;
        const reply = paired ? replies[index] : last ? { text: (replies.length ? replies.map(r => r.text) : outputs).join("\n"), failed: replies.some(r => r.failed) } : { text: "", failed: false };
        this.toolCall(state, t, call.tool, call.args, reply.text, reply.failed);
      });
    }
    for (const call of calls.filter(call => call.tool === "shell")) {
      const command = record(call.args).cmd;
      this.add(state, { t, kind: "call", tool: "shell", args: clip(typeof command === "string" ? command : call.raw, 200), result: clip(outputs.join("\n").trim(), 200), quiet: true });
    }
    if (/^Script failed/.test(header) || (!calls.length && /^Script (?!completed)/.test(header))) {
      this.add(state, { t, kind: "call", tool: "script", args: clip(pending.script.replace(/\s+/g, " ").trim(), 160), result: clip(parts.join("\n").trim(), 400), error: true, quiet: false });
    }
  }

  private add(state: FileState, entry: NewEntry) { this.push(state.info.resident, state.info.id, entry); }

  private push(resident: string, session: string, entry: NewEntry) {
    let list = this.entries.get(resident);
    if (!list) this.entries.set(resident, list = []);
    if (list.length && entry.t < list[list.length - 1].t) this.unsorted.add(resident);
    list.push({ id: this.nextId++, resident, session, ...entry });
    const limit = this.options.maxEntries ?? 4000;
    if (list.length > limit * 1.25) {
      this.sorted(resident);
      list.splice(0, list.length - limit);
    }
  }

  private sorted(resident: string): Entry[] {
    const list = this.entries.get(resident) ?? [];
    if (this.unsorted.delete(resident)) list.sort((a, b) => a.t - b.t || a.id - b.id);
    return list;
  }

  /** Newest first. `after` returns only entries recorded since that id (ids grow as lines are read). */
  recent(options: { resident?: string; after?: number; limit?: number } = {}): Entry[] {
    const names = options.resident ? [options.resident] : [...this.entries.keys()];
    const limit = options.limit ?? 300;
    const picked: Entry[] = [];
    for (const name of names) {
      const list = this.sorted(name);
      const fresh = options.after ? list.filter(entry => entry.id > options.after!) : list;
      picked.push(...fresh.slice(-limit));
    }
    return picked.sort((a, b) => b.t - a.t || b.id - a.id).slice(0, limit);
  }

  sessions(resident: string): SessionInfo[] {
    return [...this.files.values()].filter(state => state.resident === resident && state.info.lastAt > 0)
      .map(state => ({ ...state.info })).sort((a, b) => b.lastAt - a.lastAt);
  }

  /** Tokens of the session written to most recently, and of every session active in the last 24 hours. */
  tokenTotals(resident: string): TokenTotals {
    const sessions = this.sessions(resident);
    const day: Tokens = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
    let daySessions = 0;
    for (const session of sessions) {
      if (!session.tokens || session.lastAt < this.now() - 86_400_000) continue;
      daySessions++;
      for (const key of Object.keys(day) as (keyof Tokens)[]) day[key] += session.tokens[key];
    }
    return { session: sessions[0], day, daySessions };
  }

  indicators(resident: string, windowMinutes = 60): Indicators {
    const since = this.now() - windowMinutes * 60_000;
    const out: Indicators = {
      windowMinutes, calls: 0, byTool: [], errors: 0, arrived: 0, stoppedShort: 0, navigationStopped: 0,
      deaths: 0, reflexes: 0, hurt: 0, chatHeard: 0, said: 0, repeats: [],
    };
    const byTool = new Map<string, number>();
    const eventKeys: Record<string, keyof Indicators> = {
      arrived: "arrived", stopped_short: "stoppedShort", navigation_stopped: "navigationStopped", died: "deaths",
      reflex: "reflexes", hurt: "hurt", chat: "chatHeard",
    };
    let previous = "", run = 0;
    const closeRun = (lastAt: number) => { if (run >= 2) out.repeats.push({ action: previous, times: run, lastAt }); };
    let lastActionAt = 0;
    for (const entry of this.sorted(resident)) {
      if (entry.t < since) continue;
      if (entry.kind === "event") {
        const key = eventKeys[entry.type ?? ""];
        if (key) (out[key] as number)++;
        continue;
      }
      if (entry.kind !== "call" && entry.kind !== "said") continue;
      const tool = entry.tool ?? "";
      if (tool === "shell" || tool === "script") continue;
      out.calls++;
      byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
      if (entry.error) out.errors++;
      if (entry.kind === "said") out.said++;
      // Looking around between two identical actions does not make them different actions.
      if (QUIET_TOOLS[tool]) continue;
      const action = `${tool}${entry.args ? ` ${entry.args}` : ""}`;
      if (action === previous) run++;
      else { closeRun(lastActionAt); previous = action; run = 1; }
      lastActionAt = entry.t;
    }
    closeRun(lastActionAt);
    out.repeats.sort((a, b) => b.times - a.times || b.lastAt - a.lastAt).splice(6);
    out.byTool = [...byTool].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
    return out;
  }
}
