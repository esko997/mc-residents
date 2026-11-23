import { open, stat, type FileHandle } from "node:fs/promises";

export interface ResidentEvent { seq: number; type: string; [key: string]: unknown }
const waking: Record<string, true> = { chat: true, hurt: true, died: true, player_near: true, arrived: true, stopped_short: true, navigation_stopped: true, reflex: true, alarm: true };
/** Lines that carry coordinates and a reason; the rest stay at 91 so eight of them fit a tool result.
 * navigation_stopped ends with how often it has happened, after a goal, a reason and two positions; for a mine
 * job kept near its start it carries what was collected, how far a count got and by which item, a reason that
 * names the block and the start, and two more positions (380).
 * A reflex line can name a screen closed for a meal and why that meal did not start, or say how a fight went:
 * why it ended, each mob and what became of it, swings, health and the walk (300).
 * `arrived` for a mine job that has its count names the block and up to three kinds of item collected (220).
 * A chat line is never cut: Minecraft sends at most 256 characters, after a sequence number and a sender
 * (a system line is chat too: a server announcement, a death message). */
const lineLimit: Record<string, number> = { chat: 320, system: 320, arrived: 220, stopped_short: 220, navigation_stopped: 380, died: 160, reflex: 300, alarm: 260 };
/** The most characters of a tool result (about 1,500 in all) the event tail may take, heading included. Three
 * full chat lines fit, which is the most one `say` sends; the tool's own text keeps about 500. */
const tailLimit = 1000;
export class Events {
  private sequence = 0;
  private seen = 0;
  private entries: ResidentEvent[] = [];
  private listeners = new Set<(event: ResidentEvent) => void>();
  /** Events of a waking type that end no wait: chat lines this resident only overhears (see `wakes`). Shown in the tail as any other. */
  private quiet = new Set<number>();
  /** Decides, as an event of a waking type is added, whether it may end a wait; unset, every one may. */
  wakes?: (event: ResidentEvent) => boolean;
  add(type: string, fields: Record<string, unknown> = {}) {
    const event = { ...fields, type, seq: ++this.sequence };
    this.entries.push(event);
    if (this.entries.length > 128) this.quiet.delete(this.entries.shift()!.seq);
    if (waking[type] && this.wakes?.(event) === false) this.quiet.add(event.seq);
    for (const listener of this.listeners) listener(event);
  }
  /** The newest event's number; with `wait` and `since`, a cursor for a reader other than the tool-result tail. */
  get latest() { return this.sequence; }
  /** Sees every event as it is added, until the returned function is called. */
  subscribe(listener: (event: ResidentEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** `after`: only events newer than this number count; by default those not yet shown in a tool result. */
  async wait(seconds: number, filter?: string[], signal?: AbortSignal, after = this.seen): Promise<string> {
    // A rescue can end a navigation without arrival or stall; a wait for either of those must not sleep through it.
    const matches = (e: ResidentEvent) => waking[e.type] === true && !this.quiet.has(e.seq) && (!filter?.length || filter.includes(e.type) ||
      (e.type === "navigation_stopped" && (filter.includes("arrived") || filter.includes("stopped_short"))));
    if (this.entries.some(e => e.seq > after && matches(e))) return "Waking event received.";
    if (signal?.aborted) return "Wait cancelled.";
    const { promise, resolve } = Promise.withResolvers<string>();
    const finish = (message: string) => {
      clearTimeout(timer); this.listeners.delete(listener);
      signal?.removeEventListener("abort", abort); resolve(message);
    };
    const listener = (e: ResidentEvent) => { if (matches(e)) finish("Waking event received."); };
    const abort = () => finish("Wait cancelled.");
    const timer = setTimeout(() => finish("Time is up."), seconds * 1000);
    this.listeners.add(listener); signal?.addEventListener("abort", abort, { once: true });
    return promise;
  }
  private line(event: ResidentEvent) {
    const { seq, type, ...fields } = event;
    const text = type === "alarm" ? String(fields.text ?? "").replace(/\s+/g, " ")
      : Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ")}`).join(" ");
    const line = `${seq} ${type}${text ? ` ${text}` : ""}`, limit = lineLimit[type] ?? 91;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  /** As many of the newest of these as fit: eight at most and `room` characters, counting line breaks. Older
   * ones are left out whole, never cut; the newest is shown even when it alone is longer. */
  private lines(events: ResidentEvent[], room: number): string[] {
    const lines: string[] = [];
    for (let index = events.length - 1; index >= 0 && lines.length < 8; index--) {
      const line = this.line(events[index]!);
      room -= line.length + 1;
      if (room < 0 && lines.length) break;
      lines.unshift(line);
    }
    return lines;
  }
  /** The newest events after `seq` that fit, as lines, without marking them shown. */
  since(seq: number): string[] {
    return this.lines(this.entries.filter(e => e.seq > seq), tailLimit);
  }
  consume(): string {
    const heading = "Since last time:";
    const lines = this.lines(this.entries.filter(e => e.seq > this.seen), tailLimit - heading.length - " (99999 older dropped)".length);
    const dropped = this.sequence - this.seen - lines.length;
    this.seen = this.sequence;
    return `${heading}${dropped > 0 ? ` (${dropped} older dropped)` : ""}\n${lines.length ? lines.join("\n") : "none"}`;
  }
}
/** Baritone's answers to `#pause` and `#resume`, which only the body's reflexes send. They are no news of a
 * trip and get no event line: the reflex that paused it has its own. */
export const pauseReply = /^(Paused|Resumed|Already paused|Not paused)\b/;
/** Baritone 1.10.1's answer to `#proc`, which only the body sends, to learn where a mine job is heading: the
 * five lines Class, Priority, Temporary, Display name and Last command, or one line when no process is in
 * control. Group 1 is the label, group 2 the value. */
export const procReply = /^(?:(Class|Priority|Temporary|Display name|Last command): (.*)|No process in control)$/;
/** Baritone 1.10.1's answer to `#set`, which only the body sends, to lift and restore avoidBreakingMultiplier
 * around a mine job: two lines after the echoed command. */
export const setReply = /^(Successfully set avoidBreakingMultiplier to |Old value: )/;
/** Whether `text` names `name` as a whole word, whatever the case: "gary," and "Gary!" do, "Garyson" does not.
 * Names are Minecraft player names (letters, digits, underscore), so they need no escaping. */
export const mentions = (text: string, name: string) => new RegExp(`(?<!\\w)${name}(?!\\w)`, "i").test(text);
/** `unseen`: players this body never perceives (see Config.unseen). What they say, and every system or Baritone
 * line that names them (joining, leaving, an advancement, a death, a whisper), is no line at all: no event, no number. */
export function parseLogLine(line: string, ownName: string, unseen: readonly string[] = []): { type: string; fields: Record<string, unknown> } | undefined {
  const marker = line.indexOf("[CHAT] ");
  if (marker < 0) return;
  const text = line.slice(marker + 7).trim();
  // The global relay is for humans. Residents perceive only distance-filtered hub events.
  if (/^<\w{1,40} shouts for help: [^<>]*>$/.test(text)) return;
  if (text.startsWith("[Baritone] ")) {
    const reply = text.slice(11);
    if (reply.startsWith("> ") || unseen.some(name => mentions(reply, name))) return;
    return { type: "baritone", fields: { text: reply } };
  }
  const chat = /^<([^>]+)>\s?(.*)$/.exec(text);
  if (chat) {
    const from = chat[1].toLowerCase();
    if (from === ownName.toLowerCase() || unseen.some(name => name.toLowerCase() === from)) return;
    return { type: "chat", fields: { from: chat[1], text: chat[2] } };
  }
  if (unseen.some(name => mentions(text, name))) return;
  return { type: "system", fields: { text } };
}
export class LogTail {
  private file?: FileHandle;
  private identity = "";
  private offset = 0;
  private partial = "";
  private anchor = Buffer.alloc(0);
  private decoder = new TextDecoder();
  private timer?: Timer;
  private reading?: Promise<void>;
  /** `onBaritone` returns true for a reply the body asked for and read itself; such a line is no event. */
  constructor(private path: string, private ownName: string, private events: Events, private onBaritone?: (reply: string) => boolean, private unseen: readonly string[] = []) {}
  async start() {
    // Old chat must not masquerade as a fresh wake-up on resident startup.
    await this.read(true);
    this.timer = setInterval(() => { void this.read(); }, 50);
  }
  async read(initial = false): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = this.readChunk(initial).finally(() => { this.reading = undefined; });
    return this.reading;
  }
  private async readChunk(initial: boolean) {
    try {
      const info = await stat(this.path);
      const identity = `${info.dev}:${info.ino}`;
      let reset = identity !== this.identity || info.size < this.offset;
      if (!reset && this.file && this.anchor.length) {
        const check = Buffer.alloc(this.anchor.length);
        await this.file.read(check, 0, check.length, this.offset - check.length);
        reset = !check.equals(this.anchor);
      }
      if (reset) {
        await this.file?.close(); this.file = await open(this.path, "r"); this.identity = identity;
        this.offset = initial ? info.size : 0; this.partial = ""; this.anchor = Buffer.alloc(0); this.decoder = new TextDecoder();
      }
      if (!this.file || info.size <= this.offset) return;
      const buffer = Buffer.alloc(Math.min(info.size - this.offset, 65536));
      const { bytesRead } = await this.file.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      this.anchor = Buffer.from(buffer.subarray(Math.max(0, bytesRead - 64), bytesRead));
      const lines = (this.partial + this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })).split(/\r?\n/);
      this.partial = lines.pop()!.slice(-16384);
      for (const line of lines) {
        const parsed = parseLogLine(line, this.ownName, this.unseen);
        if (parsed) {
          if (parsed.type === "baritone") {
            const reply = String(parsed.fields.text);
            if (this.onBaritone?.(reply) === true || pauseReply.test(reply)) continue;
          }
          this.events.add(parsed.type, parsed.fields);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.events.add("system", { text: "Client log unreadable." });
    }
  }
  async close() { clearInterval(this.timer); await this.reading; await this.file?.close(); }
}
