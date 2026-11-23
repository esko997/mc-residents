import type { Database } from "bun:sqlite";
import type { AlarmEvent, AlarmRequest } from "./resident-contracts-alarm.ts";
import { alarmEventSchema } from "./resident-contracts-alarm.ts";
import type { ResidentEvents } from "./resident-events.ts";

export interface ResidentAlarmOptions {
  now?: () => number;
  command?: (command: string) => unknown | Promise<unknown>;
  activity?: (event: AlarmEvent) => void;
}
export class AlarmRateLimitError extends Error {}

/** Unknown auto text shares one bucket: changing prose must not evade throttling. */
function reasonClass(reason: string): string {
  const normalized = reason.toLowerCase().replace(/\s+/g, " ");
  return ["attacked", "low health", "creeper close", "in lava"].find(prefix =>
    normalized === prefix || normalized.startsWith(`${prefix} `)) ?? "generic";
}
const chatText = (text: string) => text.replace(/§./g, "").replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/g, " ").trim();
export const alarmActivityText = (event: AlarmEvent) =>
  `${event.sender} shouts for help: ${event.reason} (${event.kind}; ${event.dimension} ${event.x}, ${event.y}, ${event.z})`;

/** Persisted history is also the rate-limit authority, including after a restart. */
export function recentAlarms(db: Database, since: number): AlarmEvent[] {
  return db.query<{ event_json: string }, [number]>(
    "SELECT event_json FROM resident_alarms WHERE at>=? ORDER BY id").all(since)
    .map(row => alarmEventSchema.parse(JSON.parse(row.event_json)));
}

export class ResidentAlarms {
  constructor(private db: Database, private events: ResidentEvents, private options: ResidentAlarmOptions = {}) {}

  raise(sender: string, request: AlarmRequest, recipients: readonly string[]): { message: string } {
    const at = (this.options.now ?? Date.now)();
    const event: AlarmEvent = { ...request, sender, at };
    const bucket = request.kind === "manual" ? "manual" : `auto:${reasonClass(request.reason)}`;
    const interval = request.kind === "manual" ? 10_000 : 30_000;
    this.db.transaction(() => {
      const previous = this.db.query<{ at: number }, [string, string]>(
        "SELECT at FROM resident_alarms WHERE sender=? COLLATE NOCASE AND bucket=? ORDER BY at DESC,id DESC LIMIT 1").get(sender, bucket);
      if (previous && at - previous.at < interval) {
        const seconds = Math.ceil((interval - (at - previous.at)) / 1000);
        throw new AlarmRateLimitError(`Alarm refused: wait ${seconds}s before another ${request.kind === "manual" ? "manual alarm" : "automatic alarm of this reason class"}.`);
      }
      this.db.query("INSERT INTO resident_alarms(sender,bucket,at,event_json) VALUES(?,?,?,?)")
        .run(sender, bucket, at, JSON.stringify(event));
    }).immediate();
    for (const recipient of recipients) if (recipient.toLowerCase() !== sender.toLowerCase()) {
      this.events.publish(recipient, "alarm", { ...event });
    }
    this.options.activity?.(event);
    // One best-effort command, after fanout. Never await the bridge or retry an
    // unacknowledged world command; humans missing chat cannot block the bodies.
    if (this.options.command) {
      const line = `<${chatText(sender)} shouts for help: ${chatText(request.reason)}>`;
      // Humans only: a resident's chat overlay (and so its pictures) must not carry an
      // alarm past earshot; residents get it solely through the distance-filtered feed.
      const residents = [sender, ...recipients].filter(name => /^\w{1,16}$/.test(name));
      const target = residents.length ? `@a[${[...new Set(residents)].map(name => `name=!${name}`).join(",")}]` : "@a";
      void Promise.resolve().then(() => this.options.command!(`tellraw ${target} ${JSON.stringify({ text: line })}`)).catch(() => {});
    }
    return { message: "Alarm sent to the other residents." };
  }
}
