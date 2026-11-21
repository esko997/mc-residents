import { open, stat, type FileHandle } from "node:fs/promises";

export interface ResidentEvent { seq: number; type: string; [key: string]: unknown }
const waking: Record<string, true> = { chat: true, hurt: true, died: true, player_near: true, arrived: true, stopped_short: true };
export class Events {
  private sequence = 0;
  private seen = 0;
  private entries: ResidentEvent[] = [];
  private listeners = new Set<(event: ResidentEvent) => void>();
  add(type: string, fields: Record<string, unknown> = {}) {
    const event = { ...fields, type, seq: ++this.sequence };
    this.entries.push(event);
    if (this.entries.length > 128) this.entries.shift();
    for (const listener of this.listeners) listener(event);
  }
  async wait(seconds: number, filter?: string[], signal?: AbortSignal): Promise<string> {
    const matches = (e: ResidentEvent) => waking[e.type] === true && (!filter?.length || filter.includes(e.type));
    if (this.entries.some(e => e.seq > this.seen && matches(e))) return "Waking event received.";
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
  consume(): string {
    const unseen = this.entries.filter(e => e.seq > this.seen).slice(-8);
    const dropped = this.sequence - this.seen - unseen.length;
    this.seen = this.sequence;
    const lines = unseen.map(event => {
      const { seq, type, ...fields } = event;
      const text = Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ")}`).join(" ");
      return `${seq} ${type}${text ? ` ${text}` : ""}`.slice(0, 91);
    });
    return `Since last time:${dropped > 0 ? ` (${dropped} older dropped)` : ""}\n${lines.length ? lines.join("\n") : "none"}`;
  }
}
export function parseLogLine(line: string, ownName: string): { type: string; fields: Record<string, unknown> } | undefined {
  const marker = line.indexOf("[CHAT] ");
  if (marker < 0) return;
  const text = line.slice(marker + 7).trim();
  if (text.startsWith("[Baritone] ")) {
    const reply = text.slice(11);
    if (reply.startsWith("> ")) return;
    return { type: "baritone", fields: { text: reply } };
  }
  const chat = /^<([^>]+)>\s?(.*)$/.exec(text);
  if (chat) {
    if (chat[1].toLowerCase() === ownName.toLowerCase()) return;
    return { type: "chat", fields: { from: chat[1], text: chat[2] } };
  }
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
  constructor(private path: string, private ownName: string, private events: Events) {}
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
        const parsed = parseLogLine(line, this.ownName);
        if (parsed) this.events.add(parsed.type, parsed.fields);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.events.add("system", { text: "Client log unreadable." });
    }
  }
  async close() { clearInterval(this.timer); await this.reading; await this.file?.close(); }
}
