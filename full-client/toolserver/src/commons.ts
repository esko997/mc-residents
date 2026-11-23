import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { Events } from "./events.ts";
import type { AlarmRequest } from "../../commons/src/resident-contracts-alarm.ts";

/** Only the hub holds shared data. Failed mutations are never automatically retried. */
export class CommonsClient {
  constructor(private url?: string, private tokenFile?: string) {}

  private async request<T>(path: string, body?: unknown, signal?: AbortSignal, timeout = 10_000): Promise<T> {
    if (!this.url || !this.tokenFile) throw new Error("Shared Knowledge unavailable: set COMMONS_URL and COMMONS_TOKEN_FILE. Your body tools still work.");
    let base: URL;
    try {
      base = new URL(this.url);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    } catch { throw new Error("Shared Knowledge unavailable: COMMONS_URL must be an HTTP(S) hub base URL without credentials."); }
    let token: string;
    try { token = await readFile(this.tokenFile, "utf8"); }
    catch { throw new Error("Shared Knowledge unavailable: cannot read COMMONS_TOKEN_FILE."); }
    if (!token || /[\r\n]/.test(token)) throw new Error("Shared Knowledge unavailable: token file must contain the exact token, without a newline.");
    let response: Response;
    try {
      response = await fetch(new URL(`/resident-api/v1/${path}`, base), {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch { throw new Error("Shared Knowledge hub unreachable (connection failed or timed out). Your body tools still work; no shared change was confirmed."); }
    let data: { result?: T; error?: { code: string; message: string } };
    try { data = await response.json() as typeof data; }
    catch { throw new Error("Shared Knowledge hub returned an invalid response."); }
    if (!response.ok) throw new Error(data.error?.message ?? `Shared Knowledge request failed (${response.status}).`);
    return data.result as T;
  }

  call<T>(group: string, operation: string, args: unknown): Promise<T> {
    return this.request<T>(`${encodeURIComponent(group)}/${encodeURIComponent(operation)}`, { args });
  }

  alarm(input: AlarmRequest): Promise<{ message: string }> {
    return this.request("alarm", input);
  }

  /** A single bounded long-poll; only reads retry, with cancellation on toolserver shutdown. */
  poll(events: Events, receiveAlarm?: (fields: unknown) => Promise<void>): () => void {
    const controller = new AbortController();
    void (async () => {
      let after = 0;
      while (!controller.signal.aborted) {
        try {
          const batch = await this.request<{ events: { seq: number; type: string; fields: Record<string, unknown> }[]; seq: number; gap: boolean }>(
            `events?after=${after}&wait=25`, undefined, controller.signal, 30_000);
          if (controller.signal.aborted) break;
          if (batch.gap) events.add("commons_gap", { text: "Shared event history has a gap; inspect shared records when useful." });
          for (const event of batch.events) {
            if (controller.signal.aborted) break;
            if (event.type === "alarm") await receiveAlarm?.(event.fields);
            else events.add(event.type, event.fields);
          }
          after = batch.seq;
        } catch {
          if (!controller.signal.aborted) await sleep(5000, undefined, { signal: controller.signal }).catch(() => {});
        }
      }
    })();
    return () => controller.abort();
  }
}
