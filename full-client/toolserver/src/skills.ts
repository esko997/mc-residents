/**
 * The skill library and shared notes: what a resident worked out once and can
 * use again, kept in the commons so the other residents and their caretakers
 * see it too.
 *
 * A skill is JavaScript the resident wrote. It runs in an isolated interpreter
 * (sandbox.ts) whose only powers are the bridge built in `run` below:
 * `body.<tool>` for every body tool but the few in `closed`, `state`, `args`,
 * `log` and `sleep`. This file decides policy and keeps three records apart:
 * whether a run worked (skill_runs, from the declared check), whether the skill
 * is used (runs by residents other than its author) and whether it helped them
 * (their feedback); reviews are the caretaker's word on top.
 *
 * How a run sits beside the body's reflexes: skill_run itself is not a manual
 * action. Each body tool the code calls goes through the same path as a call
 * from the resident, so a look or click still takes over from a fight or meal
 * for just that call and reflexes work between calls. A rescue or fight that
 * starts during a run ends the run at once, before the code's next action could
 * take the body away from it.
 */
import { skillDefinitions, type SkillArgs as Args, type Expect, type SkillStart } from "../../commons/src/resident-contracts-skills.ts";
export { skillDefinitions };
import type { Body } from "./body.ts";
import type { CommonsClient } from "./commons.ts";
import type { ResidentEvent } from "./events.ts";
import { memoryBytes, runInSandbox, type Bridge, type Outcome } from "./sandbox.ts";
import { hostileEntity, nonempty, playerEntity, type State } from "./synapse.ts";

const maxCalls = 300, maxDepth = 2, maxSays = 5, replyLength = 1200;
/**
 * Skill code may call every body tool but these. Saving skills is the resident's
 * own act, as are the things it tells the others in its own name; a picture is
 * an image, which code cannot read.
 */
const closed: Record<string, string> = {
  skill_save: "skill_save cannot be called from skill code; save skills yourself.",
  note_share: "note_share cannot be called from skill code; share notes yourself.",
  feedback: "feedback cannot be called from skill code; give feedback yourself.",
  picture: "picture returns an image, which skill code cannot read; use state() or screen.",
};


/** What one top-level skill_run and the skills it calls share: one clock, one tool-call count, one reason to stop. */
class Budget {
  readonly controller = new AbortController();
  calls = 0; says = 0;
  /** Why the run is ending early; set once. */
  stopped?: string;
  /** Events up to this number have been returned by a `wait` inside the run. */
  eventCursor: number;
  readonly deadline: number;
  constructor(readonly seconds: number, eventCursor: number) { this.deadline = Date.now() + seconds * 1000; this.eventCursor = eventCursor; }
  stop(reason: string) {
    if (this.stopped !== undefined) return;
    this.stopped = reason; this.controller.abort();
  }
}
/** Passed to the body tools a skill calls, so they know they run inside one. */
export interface SkillRun { depth: number; shared: Budget }
export interface ToolReply { text: string; isError: boolean }

/** What `state()` gives skill code; the check after a run reads the same thing. */
interface Snapshot {
  pos: State["pos"]; dimension: string; health: number; food: number; air?: number; screen: string;
  lookingAt: State["lookingAt"];
  /** Item id in the selected hotbar slot, or null for an empty hand. */
  held: string | null; selectedSlot: number; hotbar: { slot: number; item: string; count: number }[];
  /** Item id -> total count over inventory, armour and offhand. */
  inventory: Record<string, number>;
  /** The 24 nearest entities. */
  nearby: { type: string; name?: string; distance: number; hostile: boolean; player: boolean; x: number; y: number; z: number }[];
  onGround?: boolean; inWater?: boolean; inLava?: boolean; onFire?: boolean;
  /** The Baritone command still running, or null. */
  navigation: string | null;
}

const oneLine = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
const secondsText = (ms: number) => `${Math.round(ms / 100) / 10} s`;
/** The declared check against what was observed. Every part states the observed value and what was needed. */
function evaluate(expect: Expect, before: Snapshot, after: Snapshot | undefined): { ok: boolean; text: string } {
  if (!after) return { ok: false, text: "Check FAILED: your state could not be read after the run." };
  const parts: { ok: boolean; text: string }[] = [];
  for (const [item, least] of Object.entries(expect.gain ?? {})) {
    const change = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
    parts.push({ ok: change >= least, text: `${item} changed by ${signed(change)}, needs +${least} or more` });
  }
  for (const [item, least] of Object.entries(expect.lose ?? {})) {
    const change = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
    parts.push({ ok: change <= -least, text: `${item} changed by ${signed(change)}, needs -${least} or less` });
  }
  if (expect.near) {
    const { x, y, z, within } = expect.near;
    const away = Math.hypot(after.pos.x - x, y === undefined ? 0 : after.pos.y - y, after.pos.z - z);
    parts.push({ ok: away <= within, text: `you are ${Math.round(away * 10) / 10} blocks from ${x},${y ?? "any y"},${z}, needs ${within} or less` });
  }
  if (expect.screen) parts.push({ ok: after.screen.toLowerCase() === expect.screen.toLowerCase(), text: `screen is ${after.screen}, needs ${expect.screen}` });
  const failed = parts.filter(p => !p.ok), passed = parts.filter(p => p.ok);
  if (!failed.length) return { ok: true, text: `Check passed: ${passed.map(p => p.text).join("; ")}.` };
  return { ok: false, text: `Check FAILED: ${failed.map(p => p.text).join("; ")}.${passed.length ? ` Passed: ${passed.map(p => p.text).join("; ")}.` : ""}` };
}
function inventoryChanges(before: Snapshot, after: Snapshot | undefined) {
  if (!after) return "Inventory changes: unknown.";
  const changes = [...new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])]
    .map(item => ({ item, change: (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0) }))
    .filter(c => c.change !== 0).sort((a, b) => b.change - a.change);
  if (!changes.length) return "Inventory changes: none.";
  return `Inventory changes: ${changes.slice(0, 8).map(c => `${signed(c.change)} ${c.item}`).join(", ")}${changes.length > 8 ? ` and ${changes.length - 8} more` : ""}.`;
}
/**
 * Events after which the body is no longer the skill's to drive: death, and the
 * reflexes that move it (rescues, fleeing, fighting), as body.ts words them.
 */
function takeover(event: ResidentEvent): string | undefined {
  if (event.type === "died") return `you died at ${event.at} in ${event.dimension}`;
  if (event.type === "reflex" && /^(\w+ rescue started|fleeing from|defending against)/.test(String(event.text))) return `a reflex took over your body (${oneLine(String(event.text), 100)})`;
  return undefined;
}
function stopReason(outcome: Exclude<Outcome, { kind: "finished" } | { kind: "unavailable" }>, seconds: number): string {
  switch (outcome.kind) {
    case "time": return `time limit of ${seconds} s reached while the code was still running`;
    case "cancelled": return "the call was cancelled";
    case "stalled": return "the code waits on a promise that nothing will ever resolve";
    case "syntax": return `syntax error${outcome.line ? ` at line ${outcome.line}` : ""}: ${outcome.message}`;
    case "error": {
      const where = outcome.line ? ` (line ${outcome.line})` : "";
      // A skill it called has already said which skill stopped and why.
      if (outcome.tool === "skill_run") return oneLine(outcome.message, 300);
      if (outcome.tool) return `${outcome.tool} failed and the code did not catch it${where}: ${oneLine(outcome.message, 300)}`;
      const memory = outcome.message === "out of memory" ? `; a skill may use ${memoryBytes / 1024 / 1024} MB` : "";
      return `${outcome.name}${where}: ${oneLine(outcome.message, 300)}${memory}`;
    }
  }
}

export class Skills {
  /** Default wall time of a run, seconds. */
  defaultSeconds = 120;
  /** The interpreter's worker file. If it cannot start, skills are neither checked nor run. */
  interpreter?: string;
  /** The top-level skill running now; one body cannot follow two routines. */
  private active?: string;
  private readonly resident: string;
  constructor(
    private body: Body, private commons: CommonsClient,
    private invoke: (tool: string, args: unknown, signal: AbortSignal, run: SkillRun) => Promise<ToolReply>,
  ) { this.resident = body.config.name; }
  async save(args: Args<"skill_save">): Promise<string> {
    const checked = (await runInSandbox({ code: args.code, check: true, deadline: Date.now() + 5000, entry: this.interpreter })).outcome;
    if (checked.kind === "syntax") {
      // Past the last line the parser has met the function's own closing brace: something in the code is still open.
      const where = !checked.line ? "" : checked.line > args.code.split("\n").length ? " at the end, where a brace, bracket or quote is still open" : ` at line ${checked.line}`;
      throw new Error(`Syntax error in code${where}: ${checked.message}. Nothing was saved.`);
    }
    if (checked.kind !== "finished") throw new Error(`Skills cannot be checked or run: the isolated interpreter is unavailable (${checked.kind === "unavailable" ? checked.message : checked.kind}). Nothing was saved.`);
    return this.commons.call<string>("skills", "save", args);
  }

  async find(args: Args<"skill_find">): Promise<string> {
    return this.commons.call<string>("skills", "find", args);
  }

  async show(args: Args<"skill_show">): Promise<string> {
    return this.commons.call<string>("skills", "show", args);
  }

  private async snapshot(): Promise<Snapshot> {
    const state = await this.body.api.state(true);
    const inventory: Record<string, number> = {};
    const carried = state.inventory ? [...state.inventory.main, ...state.inventory.armor, state.inventory.offhand] : state.hotbar;
    for (const stack of carried) if (nonempty(stack)) inventory[stack.item] = (inventory[stack.item] ?? 0) + stack.count;
    const hotbar = state.hotbar.filter(nonempty).map(({ slot, item, count }) => ({ slot, item, count }));
    const navigation = this.body.navigation;
    return {
      pos: state.pos, dimension: state.dimension, health: state.health, food: state.food, air: state.air, screen: state.screen,
      lookingAt: state.lookingAt, held: hotbar.find(s => s.slot === state.selectedSlot)?.item ?? null, selectedSlot: state.selectedSlot, hotbar, inventory,
      nearby: [...(state.nearbyEntities ?? [])].sort((a, b) => a.distance - b.distance).slice(0, 24).map(e => ({
        type: e.type, name: e.name, distance: e.distance, hostile: hostileEntity(e), player: playerEntity(e), x: e.pos[0], y: e.pos[1], z: e.pos[2],
      })),
      onGround: state.onGround, inWater: state.inWater, inLava: state.inLava, onFire: state.onFire,
      navigation: navigation && !navigation.reported ? navigation.description : null,
    };
  }

  async run(args: Args<"skill_run">, signal?: AbortSignal, parent?: SkillRun): Promise<ToolReply> {
    if (parent) return this.executeRun(args, signal, parent);
    if (this.active) throw new Error(`Skill ${this.active} is still running; wait for it to finish.`);
    this.active = args.name;
    try { return await this.executeRun(args, signal); }
    finally { this.active = undefined; }
  }

  private async executeRun(args: Args<"skill_run">, signal?: AbortSignal, parent?: SkillRun): Promise<ToolReply> {
    const { skill, ticket } = await this.commons.call<SkillStart>("skills", "start_run", args);
    const mine = skill.author === this.resident;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > maxDepth) throw new Error(`Skills can call other skills only ${maxDepth} levels deep; ${skill.name} was not run.`);
    const argsJson = JSON.stringify(args.args ?? {});
    if (argsJson.length > 2000) throw new Error("args is too large: 2,000 characters of JSON at most.");
    const before = await this.snapshot();
    if (!parent && before.health <= 0) throw new Error("You are dead; respawn before running a skill.");
    if (!parent && this.body.rescuing) throw new Error(`A ${this.body.rescuing} rescue is moving your body; run the skill when it has ended.`);

    const shared = parent?.shared ?? new Budget(args.max_seconds ?? this.defaultSeconds, this.body.events.latest);
    const run: SkillRun = { depth, shared };
    const callsBefore = shared.calls;
    let inFlight: Promise<unknown> = Promise.resolve(), lastRead = -Infinity;
    const bridge: Bridge = {
      call: (tool, input) => {
        lastRead = -Infinity;
        const reply = this.bridgeCall(run, tool, input);
        inFlight = reply.catch(() => {});
        return reply;
      },
      state: async () => {
        // A loop polling state with nothing in between reads at most five times a second.
        const early = lastRead + 200 - performance.now();
        if (early > 0) await Bun.sleep(early);
        lastRead = performance.now();
        return JSON.stringify(await this.snapshot());
      },
    };
    const cancelled = () => shared.stop("the call was cancelled");
    let unsubscribe: (() => void) | undefined;
    if (!parent) {
      unsubscribe = this.body.events.subscribe(event => { const reason = takeover(event); if (reason) shared.stop(reason); });
      if (signal?.aborted) cancelled(); else signal?.addEventListener("abort", cancelled, { once: true });
    }
    const clock = performance.now();
    let why: string | undefined, value = "", logs: string[] = [], logCount = 0;
    try {
      const result = await runInSandbox({ code: skill.code, argsJson, bridge, deadline: shared.deadline, signal: shared.controller.signal, entry: this.interpreter });
      const outcome = result.outcome;
      ({ logs, logCount } = result);
      // Fail closed: code that cannot be isolated is not run at all.
      if (outcome.kind === "unavailable") throw new Error(`Skills cannot run: the isolated interpreter is unavailable (${outcome.message}). Nothing was run.`);
      if (outcome.kind === "finished") value = outcome.value;
      else {
        // A reason set from outside (death, reflex, limit, cancel) is the cause; the code's last error is its effect.
        why = (shared.stopped ?? stopReason(outcome, shared.seconds)).replace(/[.\s]+$/, "");
        if (outcome.kind === "time" || !parent) shared.stop(why);
      }
      // A tool call the code had started is not left running behind the reply; waits and crafts end on the stop above.
      const patience = Promise.withResolvers<void>(), timer = setTimeout(patience.resolve, 5000);
      await Promise.race([inFlight, patience.promise]);
      clearTimeout(timer);
    } finally {
      if (!parent) {
        unsubscribe?.();
        signal?.removeEventListener("abort", cancelled);
      }
    }
    const ms = Math.round(performance.now() - clock);
    const after = await this.snapshot().catch(() => undefined);
    const expect = skill.expect_json ? JSON.parse(skill.expect_json) as Expect : undefined;
    const check = expect && evaluate(expect, before, after);
    const ok = why === undefined;
    const lines: string[] = [];
    let promoted = false;
    try {
      ({ promoted } = await this.commons.call<{ promoted: boolean }>("skills", "record_run", {
        ticket, ms, ok, checkOk: check ? check.ok : null, ...(why ? { error: oneLine(why, 300) } : {}),
      }));
    } catch (error) { lines.push(`This run was not recorded: ${oneLine(error instanceof Error ? error.message : "commons write failed", 120)}.`); }

    // To the skill that called this one a failure is an error to catch, so it gets the reason alone.
    if (parent && !ok) return { text: `${skill.name} stopped: ${oneLine(why!, 300)}`, isError: true };
    if (parent && check?.ok === false) return { text: `${skill.name} finished, but: ${oneLine(check.text, 300)}`, isError: true };
    const calls = plural(shared.calls - callsBefore, "tool call");
    const head = ok ? `Skill ${skill.name} v${skill.version} finished in ${secondsText(ms)}, ${calls}.` : `Skill ${skill.name} v${skill.version} STOPPED after ${secondsText(ms)}, ${calls}: ${oneLine(why!, 300)}.`;
    lines.unshift(head, check ? oneLine(check.text, 420) : "No check declared, so this skill cannot become verified.", inventoryChanges(before, after));
    if (after && after.screen !== "none") lines.push(`Screen open now: ${after.screen}.`);
    if (after?.navigation) lines.push(`Navigation still running: ${after.navigation}.`);
    if (promoted) lines.push(`${skill.name} is now verified: the other residents can find and run it. A caretaker will review it.`);
    else if (skill.status === "draft" && check) lines.push(`${skill.name} is still a draft: it becomes verified when a run finishes and passes its check.`);
    // The author's check says it ran as the author meant; only the one who used it knows whether that helped.
    const invitation = !parent && !mine ? `\nDid ${skill.name} do what you needed? Tell the others: feedback with skill ${skill.name} and worked true or false.` : "";
    // What the code returned is its answer to the resident: it gets the room the facts leave, ahead of the log.
    const room = replyLength - invitation.length - lines.join("\n").length - 12;
    if (value && room >= 40) lines.splice(3, 0, `Returned: ${oneLine(value, Math.min(room, 400))}`);
    let text = lines.join("\n");
    const tail: string[] = [];
    for (const line of [...logs].reverse()) {
      if (text.length + tail.reduce((sum, l) => sum + l.length + 1, 0) + line.length + 40 + invitation.length > replyLength) break;
      tail.unshift(line);
    }
    if (tail.length) text += `\nLog (last ${tail.length} of ${logCount}):\n${tail.join("\n")}`;
    if (text.length + invitation.length > replyLength) text = `${text.slice(0, replyLength - invitation.length - 1)}…`;
    return { text: text + invitation, isError: !ok || check?.ok === false };
  }

  /** One body tool call from skill code. A thrown error reaches the code, which may catch it. */
  private async bridgeCall(run: SkillRun, tool: string, input: unknown): Promise<string> {
    const shared = run.shared;
    if (shared.stopped !== undefined) throw new Error(`The run is stopping: ${shared.stopped}.`);
    if (Object.hasOwn(closed, tool)) throw new Error(closed[tool]);
    if (++shared.calls > maxCalls) {
      shared.calls = maxCalls;
      shared.stop(`tool-call limit of ${maxCalls} reached`);
      throw new Error(`The run is stopping: ${shared.stopped}.`);
    }
    if (tool === "say" && ++shared.says > maxSays) throw new Error(`A skill run may send at most ${maxSays} chat messages.`);
    const reply = await this.invoke(tool, input, shared.controller.signal, run);
    if (reply.isError) throw new Error(reply.text.replace(/^Error: /, ""));
    return reply.text;
  }

  async noteShare(args: Args<"note_share">): Promise<string> {
    return this.commons.call<string>("skills", "note_share", args);
  }

  async notesShared(args: Args<"notes_shared">): Promise<string> {
    return this.commons.call<string>("skills", "notes_shared", args);
  }

  async feedback(args: Args<"feedback">): Promise<string> {
    return this.commons.call<string>("skills", "feedback", args);
  }
}
