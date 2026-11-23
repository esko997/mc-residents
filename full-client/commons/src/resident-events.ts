import type { Database } from "bun:sqlite";

export interface HubEvent { seq: number; type: string; fields: Record<string, unknown> }
/** In-memory bounded payloads; durable sequence watermark makes restart gaps detectable. */
export class ResidentEvents {
  private sequence: number;
  private readonly boot: number;
  private entries: (HubEvent & { resident: string })[] = [];
  private waiters = new Set<() => void>();
  private closed = false;
  constructor(private db: Database, private capacity = 512) {
    const row = db.query<{ value: number }, []>("SELECT value FROM resident_api_state WHERE key='event_seq'").get();
    this.boot = this.sequence = row?.value ?? 0;
  }
  publish(resident: string, type: string, fields: Record<string, unknown>): number {
    const seq = ++this.sequence;
    this.db.query("INSERT INTO resident_api_state(key,value) VALUES('event_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(seq);
    this.entries.push({ resident: resident.toLowerCase(), seq, type, fields });
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const wake of this.waiters) wake();
    return seq;
  }
  private batch(resident: string, after: number) {
    const floor = this.entries[0]?.seq ?? this.boot + 1;
    return {
      events: this.entries.filter(e => e.resident === resident.toLowerCase() && e.seq > after).map(({ resident: _, ...event }) => event),
      seq: this.sequence, gap: after > this.sequence || after < floor - 1,
    };
  }
  async poll(resident: string, after: number, wait: number, signal?: AbortSignal) {
    let batch = this.batch(resident, after);
    if (batch.events.length || batch.gap || !wait || signal?.aborted) return batch;
    const deadline = Date.now() + wait * 1000;
    while (!this.closed && !signal?.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      batch = this.batch(resident, after);
      if (batch.events.length || batch.gap) break;
    }
    return batch;
  }
  close() { this.closed = true; for (const wake of this.waiters) wake(); }
}
