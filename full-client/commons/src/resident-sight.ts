// A resident's own line of sight to another resident, as the server observer reports it. Only the hub can reach
// the observer; a resident's tool server asks here when an alarm is too far to hear but close enough to see.
// Unknown stays null (no observer, observer down, other dimension, unloaded ray): never guessed either way.
import { observerGet, observerSight, observerSourceFromEnv, type ObserverSource } from "./observer.ts";

export interface SightAnswer { visible: boolean | null; distance: number | null; reason: string }
export interface ResidentSightOptions {
  /** The observer. Undefined: from COMMONS_OBSERVER_URL/COMMONS_OBSERVER_TOKEN_FILE, as the hub's config reads it; null: none. */
  source?: ObserverSource | null;
  get?: typeof observerGet;
  /** The most one question may take, observer round trip included. */
  timeoutMs?: number;
}

const unknown = (reason: string): SightAnswer => ({ visible: null, distance: null, reason });

export class ResidentSight {
  private source: ObserverSource | undefined;
  private get: typeof observerGet;
  private timeoutMs: number;
  constructor(options: ResidentSightOptions = {}) {
    let source = options.source ?? undefined;
    if (options.source === undefined) {
      try { source = observerSourceFromEnv(process.env); } catch { source = undefined; }
    }
    this.source = source;
    this.get = options.get ?? observerGet;
    this.timeoutMs = options.timeoutMs ?? 1500;
  }

  /** Whether `from` can see `to` now. Both are canonical credential names; `from` is always the caller. */
  async between(from: string, to: string): Promise<SightAnswer> {
    const source = this.source;
    if (!source) return unknown("Server sight is not configured on this hub.");
    const { promise: late, resolve } = Promise.withResolvers<undefined>();
    const timer = setTimeout(resolve, this.timeoutMs, undefined);
    try {
      const result = await Promise.race([observerSight(source, { from, to }, (s, path) => this.get(s, path, this.timeoutMs)), late]);
      if (!result) return unknown("The server observer did not answer in time.");
      if (!result.ok) return unknown(`Server sight unavailable (${result.status}).`);
      return { ...result.data.sight };
    } finally { clearTimeout(timer); }
  }
}
