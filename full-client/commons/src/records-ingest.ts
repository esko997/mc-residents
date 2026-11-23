// Keeps the server bridge's resident events (online, offline, dimension change, death) in the hub database
// (history_server_events), so records can say who was online when and who died when after the bridge's own
// small ring has moved on. One bounded read per interval from a saved cursor; losses are recorded as gaps.
import type { Database } from "bun:sqlite";
import { observerEvents, observerGet, type ObserverSource } from "./observer.ts";
import { ingestState, recordGap, setIngestState } from "./observer-store.ts";

const KEPT: Record<string, true> = { resident_online: true, resident_offline: true, resident_dimension: true, resident_died: true };
const CURSOR = "history_events_cursor";

export class RecordsIngest {
  private timer?: Timer;
  private running?: Promise<void>;
  constructor(private readonly db: Database, private readonly source: ObserverSource | undefined,
    private readonly options: { intervalMs?: number; now?: () => number; get?: typeof observerGet } = {}) {}

  start() {
    if (!this.source) return;
    this.timer = setInterval(() => void this.pass(), this.options.intervalMs ?? 30_000);
    void this.pass();
  }
  stop() { clearInterval(this.timer); }

  /** One read of up to five pages; a pass still running is not doubled. */
  pass(): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.running ??= this.passOnce(this.source).catch(() => {}).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async passOnce(source: ObserverSource) {
    const now = this.options.now ?? Date.now;
    for (let pages = 0; pages < 5; pages++) {
      const stored = ingestState(this.db, CURSOR);
      let after = stored === null ? 0 : Number(stored);
      const read = await observerEvents(source, { after, limit: 500 }, this.options.get ?? observerGet);
      if (!read.ok) return;
      const page = read.data;
      // The bridge restarted: its sequence numbers began again below our cursor.
      if (after > page.latestSeq) {
        recordGap(this.db, "server_events", 0, `bridge sequence restarted (cursor ${after}, now ${page.latestSeq}); events between were not read`, now());
        after = 0;
        setIngestState(this.db, CURSOR, "0");
        continue;
      }
      if (page.gap && stored !== null) recordGap(this.db, "server_events", 0, `events after ${after} were overwritten before the hub read them`, now());
      const insert = this.db.query("INSERT OR IGNORE INTO history_server_events (at, seq, type, resident, detail) VALUES (?, ?, ?, ?, ?)");
      this.db.transaction(() => {
        for (const event of page.events) {
          if (Object.hasOwn(KEPT, event.type) && event.resident) insert.run(Math.round(event.at), event.seq, event.type, event.resident, event.detail);
        }
        const last = page.events.at(-1)?.seq;
        setIngestState(this.db, CURSOR, String(page.events.length >= 500 && last !== undefined ? last : Math.max(after, page.latestSeq)));
      })();
      if (page.events.length < 500) return;
    }
  }
}
