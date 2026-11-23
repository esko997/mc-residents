import { mentions } from "./events.ts";

/** A speaker this close (blocks, as the body last sensed them) is within earshot. */
export const earshot = 48;
/** An exchange stays open this long after its last named line (ms, body clock). */
export const exchangeMs = 120_000;

/**
 * Which chat lines end a `wait`. With four residents each one hears 85-92 lines an hour and only 11-21% name
 * the listener, so a line wakes the body only when it is meant for it or comes from close by:
 * it names this resident (a whole word, any case); its speaker is not a resident (a person, or the caretaker,
 * who speaks to one resident at a time); its speaker is within `earshot`; or an exchange is under way (this
 * resident named the speaker, or the speaker named this resident, in the last `exchangeMs`). Every line is still
 * shown in the next tool result; one that wakes nothing is only not a reason to stop waiting.
 */
export class Hearing {
  private readonly residents: ReadonlySet<string>;
  /** Speaker (lower case) -> body clock of the last line in which they named this resident. */
  private namedBy = new Map<string, number>();
  /** This resident's own recent lines: when, and their words in lower case. */
  private spoken: { at: number; words: Set<string> }[] = [];
  constructor(private readonly own: string, residents: readonly string[], private readonly now: () => number) {
    this.residents = new Set(residents.map(name => name.toLowerCase()));
  }
  /** This resident said `text`: every name in it is now someone it is talking to. */
  said(text: string) {
    const at = this.now();
    this.spoken = [...this.spoken.filter(line => at - line.at <= exchangeMs), { at, words: new Set(text.toLowerCase().match(/\w+/g) ?? []) }];
  }
  /** Whether a line from `from` ends a wait. `distance` is how far the body last sensed that speaker, if it did. */
  wakes(from: string, text: string, distance?: number): boolean {
    const speaker = from.toLowerCase(), at = this.now();
    if (mentions(text, this.own)) { this.namedBy.set(speaker, at); return true; }
    if (!this.residents.has(speaker)) return true;
    if (distance !== undefined && distance <= earshot) return true;
    if (at - (this.namedBy.get(speaker) ?? -Infinity) <= exchangeMs) return true;
    return this.spoken.some(line => at - line.at <= exchangeMs && line.words.has(speaker));
  }
}
