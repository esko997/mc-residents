// The console: one stream of what the Minecraft server logged and what only the
// players' clients were shown.
//
//   Source A  the server's own log, read over HTTP from the phone-chat service on
//             the server machine (it tails latest.log; this machine cannot reach the file).
//             The same service runs commands, and echoes them into its stream.
//   Source B  `[CHAT]` lines in each resident's client log: system messages, tellraw,
//             advancements and deaths as players see them. The server does not log all of
//             these, so a line the server log does not have is kept, marked "seen in game".
//
// Lines are kept in time order in a ring. A line can still change after it was handed
// out (a second resident saw it too) or disappear (the server log turned out to have
// it), so readers follow a revision counter, not line ids.
import { open, stat } from "node:fs/promises";
import type { Config } from "./config.ts";
import { clip, finite, record } from "./json.ts";

export type LineKind = "chat" | "players" | "warn" | "command" | "other";
export interface ConsoleLine {
  id: number;
  /** Grows whenever this line is added or changed. */
  rev: number;
  /** Unix ms: the log's own stamp, not when it was read. */
  t: number;
  source: "server" | "game";
  /** What the filters go by. */
  kind: LineKind;
  /** A command typed into a console, or what the server answered. */
  mark?: "command" | "output";
  text: string;
  /** Server lines that are not plain server-thread INFO: "WARN ServerGamePacketListenerImpl". */
  tag?: string;
  /** Game lines: whose clients showed it. */
  seenBy?: string[];
  /**
   * Plumbing nobody reads: the RCON connections of whatever polls the server, a mod's
   * banner at every join. Hidden unless asked for; the kind is unchanged.
   */
  noise?: true;
}
export interface ServerState {
  /** unset: no address configured. unknown: not asked yet. */
  state: "unset" | "unknown" | "ok" | "unreachable";
  detail?: string;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// [21Nov2026 16:11:23.456] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: <Gary> hello
const SERVER_LINE = /^\[(\d{2})([A-Z][a-z]{2})(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\] \[([^\]]*)\/([A-Z]+)\] \[([^\]]*)\]: (.*)$/s;
// [10:15:37] [Render thread/INFO]: [System] [CHAT] Margo joined the game
const CLIENT_CHAT = /^\[(\d{2}):(\d{2}):(\d{2})\] \[[^\]]*\/[A-Z]+\]: (?:\[(?:System|Not Secure)\] )*\[CHAT\] (.*)$/s;

export interface ServerLine { t: number; thread: string; level: string; logger: string; message: string }
/** A line of the server's latest.log. Its stamps are UTC. null: not the start of a log record (a stack trace line, say). */
export function parseServerLine(raw: string): ServerLine | null {
  const found = SERVER_LINE.exec(raw);
  if (!found || !(found[2] in MONTHS)) return null;
  const t = Date.UTC(Number(found[3]), MONTHS[found[2]], Number(found[1]), Number(found[4]), Number(found[5]), Number(found[6]), Number(found[7]));
  return { t, thread: found[8], level: found[9], logger: found[10], message: found[11] };
}

/** A `[CHAT]` line of a client log: what was shown in that player's chat window. Its stamp is local wall-clock time, no date. */
export function parseClientChat(raw: string): { hours: number; minutes: number; seconds: number; message: string } | null {
  const found = CLIENT_CHAT.exec(raw);
  return found && { hours: Number(found[1]), minutes: Number(found[2]), seconds: Number(found[3]), message: found[4] };
}

/** The latest moment with this local wall-clock time that is not after `reference` (a minute of slack for clocks). */
export function clockTime(hours: number, minutes: number, seconds: number, reference: number): number {
  const date = new Date(reference);
  date.setHours(hours, minutes, seconds, 0);
  if (date.getTime() > reference + 60_000) date.setDate(date.getDate() - 1);
  return date.getTime();
}

const CHAT = /^(?:\[Not Secure\] )?(?:<[^>]{1,40}> |\[(?:Server|Rcon)\] |\* \w{1,16} )/;
const DEATH = "was (?:slain|shot|killed|blown up|pummeled|fireballed|impaled|squashed|skewered|struck by lightning|burnt|burned|roasted|doomed|poked|stung|pricked|squished|frozen|obliterated)|died|drowned|blew up|burned to death|went up in flames|tried to swim in lava|fell (?:from|off|out|while|too far|into)|hit the ground too hard|starved to death|suffocated in a wall|froze to death|withered away|experienced kinetic energy|walked into|went off with a bang|discovered the floor was lava|didn't want to live|left the confines of this world";
const PLAYERS = new RegExp(`^\\w{1,16}(?: (?:joined|left) the game$| has (?:made the advancement|completed the challenge|reached the goal) \\[| lost connection: |\\[/[^\\]]*\\] logged in with entity id | (?:${DEATH})\\b)`);
/** The caretaker model speaks in game through tellraw; its lines count as chat wherever they turn up. */
export const CARETAKER = "<Caretaker>";

/** What a message is, for the filters: something said, something that happened to a player, or neither. */
export function classify(message: string): "chat" | "players" | "other" {
  if (message.includes(CARETAKER) || CHAT.test(message)) return "chat";
  return PLAYERS.test(message.replace(/^\[Not Secure\] /, "")) ? "players" : "other";
}

/** The same message reads the same in the server log and in a client log once this is applied. */
const messageKey = (message: string) => message.replace(/^\[Not Secure\] /, "").replace(/\s+/g, " ").trim();

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Text without terminal colour codes (rcon-cli colours its output) and without trailing space. */
export const plain = (text: string) => text.replace(ANSI, "").trimEnd();

// Server INFO lines that only say the machinery ran. Kept narrow on purpose: when in doubt a line is not noise.
const SERVER_NOISE = /^(?:Thread RCON Client \S+ (?:started|shutting down)|Rcon connection from: \S+|Saving chunks for level '.*|ThreadedAnvilChunkStorage(?: \([^)]*\))?: All (?:chunks|dimensions) are saved)$/;
/** A line of the server log that is plumbing: every RCON command opens and closes a connection, and each end is logged. */
export function serverNoise(level: string, message: string): boolean {
  return level === "INFO" && SERVER_NOISE.test(message);
}
/**
 * A client-only line that is a mod talking to nobody in particular: it starts with a
 * `[ModName]` tag, is not chat, and names no player we know (`names` in lower case).
 */
export function gameNoise(message: string, names: ReadonlySet<string>): boolean {
  if (!/^\[[^\]]{1,40}\] /.test(message) || classify(message) !== "other") return false;
  return !(message.toLowerCase().match(/\w+/g) ?? []).some(word => names.has(word));
}

interface Stored extends ConsoleLine { key: string; raw?: string }
interface Pending { resident: string; t: number; message: string; key: string; queuedAt: number }
export interface ConsoleOptions {
  capacity?: number;
  /** Noise lines kept at most: they arrive every few seconds and must not push what people said out of the ring. */
  noiseCapacity?: number;
  /** Two lines with the same words this close in time are the same message. */
  windowMs?: number;
  /** How long a client's line waits for the server log to show the same message. */
  graceMs?: number;
  now?: () => number;
  /** Players whose names make a line worth showing: the residents and the owner. More are learned from joins and chat. */
  names?: string[];
}

export class Console {
  readonly boot = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  server: ServerState;
  private lines: Stored[] = [];
  private pending: Pending[] = [];
  private gone: { id: number; rev: number }[] = [];
  private nextId = 1;
  private rev = 0;
  private lastServer?: { t: number; kind: LineKind };
  private capacity: number;
  private noiseCapacity: number;
  private windowMs: number;
  private graceMs: number;
  private now: () => number;
  private names: Set<string>;

  constructor(serverConfigured: boolean, options: ConsoleOptions = {}) {
    this.server = { state: serverConfigured ? "unknown" : "unset" };
    this.capacity = options.capacity ?? 5000;
    this.noiseCapacity = options.noiseCapacity ?? 500;
    this.windowMs = options.windowMs ?? 10_000;
    this.graceMs = options.graceMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.names = new Set((options.names ?? []).map(name => name.toLowerCase()));
  }

  /**
   * One line from the server's stream. A raw log line carries its own stamp; a line the
   * phone-chat service made up (a command, its output, something said through it) comes
   * with a mark and the time it happened.
   */
  addServer(text: string, made?: { mark?: string; t?: number }) {
    const raw = plain(text);
    // Nothing to show: an empty log line, or the colour reset rcon-cli ends its output with.
    if (!raw.trim()) return;
    let line: Omit<Stored, "id" | "rev">;
    const parsed = made?.mark ? null : parseServerLine(raw);
    if (made?.mark) {
      const mark = made.mark === "command" || made.mark === "output" ? made.mark : undefined;
      const said = classify(raw);
      line = { t: made.t ?? this.now(), source: "server", kind: mark && said !== "chat" ? "command" : said, ...(mark ? { mark } : {}), text: raw, key: messageKey(raw) };
    } else if (parsed) {
      const serious = parsed.level === "WARN" || parsed.level === "ERROR" || parsed.level === "FATAL";
      const logger = parsed.logger.replace(/\/.*$/, "").split(".").pop() ?? "";
      const tag = [parsed.level === "INFO" ? "" : parsed.level, logger === "MinecraftServer" ? "" : logger].filter(Boolean).join(" ");
      line = {
        t: parsed.t, source: "server", kind: serious ? "warn" : classify(parsed.message), text: parsed.message,
        ...(tag ? { tag } : {}), ...(serverNoise(parsed.level, parsed.message) ? { noise: true } : {}), key: messageKey(parsed.message), raw: text,
      };
      // Whoever joins or speaks is a player; a mod's line that names one is not noise.
      const player = /^(?:\[Not Secure\] )?<(\w{1,16})> |^(\w{1,16}) joined the game$/.exec(parsed.message);
      if (player && !serious) this.names.add((player[1] ?? player[2]).toLowerCase());
    } else {
      // No stamp of its own: the rest of the record above it (a stack trace), filed with it.
      line = { t: this.lastServer?.t ?? this.now(), source: "server", kind: this.lastServer?.kind === "warn" ? "warn" : "other", text: raw, key: "", raw: text };
    }
    if (!made?.mark) this.lastServer = { t: line.t, kind: line.kind };
    this.insert(line);
    if (!line.key) return;
    // The server has it, so what a client showed of it is a repeat.
    this.pending = this.pending.filter(waiting => waiting.key !== line.key || Math.abs(waiting.t - line.t) > this.windowMs);
    for (const twin of this.near(line.t, line.key, "game")) {
      this.lines.splice(this.lines.indexOf(twin), 1);
      this.gone.push({ id: twin.id, rev: ++this.rev });
      if (this.gone.length > 1000) this.gone.shift();
    }
  }

  /** One `[CHAT]` message a resident's client showed. It is held back briefly so the server log can claim it. */
  addGame(resident: string, t: number, message: string) {
    this.pending.push({ resident, t, message, key: messageKey(message), queuedAt: this.now() });
  }

  /** Publish the client lines that have waited long enough. */
  flush() {
    const now = this.now(), state = this.server.state;
    const still: Pending[] = [];
    for (const waiting of this.pending) {
      if (state === "unknown" || (state === "ok" && now - waiting.queuedAt < this.graceMs)) { still.push(waiting); continue; }
      if (this.near(waiting.t, waiting.key, "server").length) continue;
      const [twin] = this.near(waiting.t, waiting.key, "game");
      if (twin) {
        if (!twin.seenBy?.includes(waiting.resident)) { twin.seenBy = [...(twin.seenBy ?? []), waiting.resident].sort(); twin.rev = ++this.rev; }
        continue;
      }
      const said = classify(waiting.message);
      // Everything here was shown in a chat window; what is not about a player counts as chat.
      this.insert({
        t: waiting.t, source: "game", kind: said === "players" ? "players" : "chat", text: waiting.message, seenBy: [waiting.resident],
        ...(gameNoise(waiting.message, this.names) ? { noise: true } : {}), key: waiting.key,
      });
    }
    this.pending = still;
  }

  private near(t: number, key: string, source: "server" | "game"): Stored[] {
    const found: Stored[] = [];
    for (let index = this.lines.length - 1; index >= 0 && this.lines[index].t >= t - this.windowMs; index--) {
      const line = this.lines[index];
      if (line.source === source && line.key === key && line.t <= t + this.windowMs) found.push(line);
    }
    return found;
  }

  private insert(line: Omit<Stored, "id" | "rev">) {
    let index = this.lines.length;
    while (index > 0 && this.lines[index - 1].t > line.t) index--;
    this.lines.splice(index, 0, { ...line, text: clip(line.text, 2000), id: this.nextId++, rev: ++this.rev });
    if (line.noise) {
      const noisy = this.lines.filter(kept => kept.noise);
      if (noisy.length > this.noiseCapacity) this.lines.splice(this.lines.indexOf(noisy[0]), 1);
    }
    if (this.lines.length > this.capacity) this.lines.shift();
  }

  /** The raw server lines held now: after the service restarts it sends its recent lines again. */
  knownRaw(): Set<string> {
    return new Set(this.lines.flatMap(line => line.raw === undefined ? [] : [line.raw]));
  }

  /** Lines added or changed after revision `after`, in time order, and the ids of lines withdrawn since. */
  since(after = 0): { rev: number; lines: ConsoleLine[]; gone: number[] } {
    return {
      rev: this.rev,
      lines: this.lines.filter(line => line.rev > after).map(({ key: _key, raw: _raw, ...line }) => line),
      gone: this.gone.filter(entry => entry.rev > after).map(entry => entry.id),
    };
  }
}

/** New whole lines of a log file that another process appends to and now and then replaces. */
class LineTail {
  private identity = "";
  private offset = 0;
  private carry = Buffer.alloc(0);
  constructor(private path: string, private needle: string) {}

  /**
   * Calls `onLine` for each new line holding `needle`. `history` is true while reading a file
   * for the first time (at start, or after it was replaced): those lines were written before now.
   */
  async read(onLine: (line: string, history: boolean, modifiedAt: number) => void) {
    let info;
    try { info = await stat(this.path); }
    catch { this.identity = ""; return; }
    const identity = `${info.dev}:${info.ino}`;
    const history = identity !== this.identity || info.size < this.offset;
    if (history) { this.identity = identity; this.offset = 0; this.carry = Buffer.alloc(0); }
    if (info.size <= this.offset) return;
    const file = await open(this.path, "r");
    try {
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(info.size - this.offset, 4 << 20));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const data = this.carry.length ? Buffer.concat([this.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let start = 0;
        for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
          const line = data.subarray(start, end);
          if (line.includes(this.needle)) onLine(line.toString("utf8").replace(/\r$/, ""), history, info.mtimeMs);
          start = end + 1;
        }
        this.carry = Buffer.from(data.subarray(start));
      }
    } finally { await file.close(); }
  }
}

export type CommandResult = { ok: true; output: string } | { ok: false; code: 400 | 502 | 503; error: string };

/** Keeps a Console fed from both sources, and passes commands to the server machine. */
export class ConsoleFeed {
  private serverBoot?: string;
  private after = 0;
  private polling?: Promise<void>;
  private reading?: Promise<void>;
  private tails: { resident: string; tail: LineTail }[];
  private timers: Timer[] = [];

  constructor(private stream: Console, private config: Config, private now: () => number = Date.now) {
    this.tails = config.residents.map(resident => ({ resident: resident.name, tail: new LineTail(resident.clientLog, "[CHAT] ") }));
  }

  start() {
    void this.readClients();
    this.timers.push(setInterval(() => { void this.readClients(); }, 1000));
    if (!this.config.consoleUrl) return;
    void this.pollServer();
    this.timers.push(setInterval(() => { void this.pollServer(); }, 2000));
  }
  stop() { for (const timer of this.timers) clearInterval(timer); }

  /** Read what the residents' client logs gained. */
  readClients(): Promise<void> {
    this.reading ??= (async () => {
      for (const { resident, tail } of this.tails) {
        try {
          await tail.read((line, history, modifiedAt) => {
            const chat = parseClientChat(line);
            // Baritone's replies are that client's own navigation mod talking to it; nobody else sees them (Activity has them).
            if (!chat || chat.message.startsWith("[Baritone] ")) return;
            this.stream.addGame(resident, clockTime(chat.hours, chat.minutes, chat.seconds, history ? modifiedAt : this.now()), chat.message);
          });
        } catch { /* a log that cannot be read now is read on the next pass */ }
      }
      this.stream.flush();
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** Ask the phone-chat service for the server log lines after the last one seen. */
  pollServer(): Promise<void> {
    this.polling ??= this.fetchServer().finally(() => { this.polling = undefined; this.stream.flush(); });
    return this.polling;
  }

  private async fetchServer() {
    const base = this.config.consoleUrl;
    if (!base) return;
    try {
      let reply = await this.fetchLines(base, this.after);
      let known: Set<string> | undefined;
      if (this.serverBoot !== undefined && reply.boot !== this.serverBoot) {
        // The service restarted or the log was rotated: its ids start over, and it may repeat lines already here.
        known = this.stream.knownRaw();
        reply = await this.fetchLines(base, 0);
        this.after = 0;
      }
      this.serverBoot = reply.boot;
      for (const value of reply.lines) {
        const line = record(value), id = finite(line.id);
        if (id === undefined || typeof line.text !== "string") continue;
        this.after = Math.max(this.after, id);
        const mark = typeof line.mark === "string" ? line.mark : undefined, seconds = finite(line.t);
        if (!mark && known?.has(line.text)) continue;
        this.stream.addServer(line.text, mark ? { mark, t: seconds === undefined ? undefined : Math.round(seconds * 1000) } : undefined);
      }
      this.stream.server = { state: "ok" };
    } catch (error) {
      this.stream.server = { state: "unreachable", detail: error instanceof Error ? error.message : "no answer" };
    }
  }

  private async fetchLines(base: string, after: number): Promise<{ boot: string; lines: unknown[] }> {
    let response: Response;
    try { response = await fetch(`${base}console?after=${after}`, { signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error("The phone-chat service on the server machine does not answer."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404
        ? "The phone-chat service answered 404: its token is wrong in CONSOLE_URL, or it is an older version without the console."
        : `The phone-chat service answered HTTP ${response.status}.`);
    }
    const reply = record(await response.json().catch(() => null));
    if (typeof reply.boot !== "string" || !Array.isArray(reply.lines)) throw new Error("The phone-chat service sent something that is not a console reply.");
    return { boot: reply.boot, lines: reply.lines };
  }

  /** Why commands cannot be sent, or undefined when they can. */
  get commandsOff(): string | undefined {
    return this.config.consoleUrl ? undefined : "Commands are off: neither CONSOLE_URL nor CHAT_URL is set, so this app has no way to the server.";
  }

  /** Run one server command through the phone-chat service (rcon). Its echo and output arrive in the stream. */
  async command(typed: unknown): Promise<CommandResult> {
    const command = typeof typed === "string" ? typed.trim().replace(/^\/+/, "").trim() : "";
    if (!command) return { ok: false, code: 400, error: "Type a command first." };
    if (/[\r\n]/.test(command) || command.length > 1000) return { ok: false, code: 400, error: "A command is one line of at most 1000 characters." };
    const base = this.config.consoleUrl;
    if (!base) return { ok: false, code: 503, error: this.commandsOff ?? "" };
    let response: Response;
    try {
      response = await fetch(`${base}command`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }), signal: AbortSignal.timeout(20_000),
      });
    } catch { return { ok: false, code: 502, error: "The phone-chat service on the server machine did not answer. The command may not have run." }; }
    const reply = record(await response.json().catch(() => null));
    // An older phone-chat service passes rcon-cli's colour codes through.
    const said = (value: unknown) => typeof value === "string" ? plain(value).split("\n").filter(line => line.trim()).join("\n") : undefined;
    // Bring the echo in now rather than at the next poll (a poll already under way may have asked too early).
    await this.polling;
    await this.pollServer();
    if (!response.ok) return { ok: false, code: 502, error: said(reply.error) ?? `The phone-chat service answered HTTP ${response.status}.` };
    return { ok: true, output: said(reply.output) ?? "" };
  }
}
