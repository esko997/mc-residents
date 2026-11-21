import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * A resident's medium-term projects and short rolling action plans, kept in
 * RESIDENT_DIR/plan.json across context summaries and restarts. Checked steps
 * are not proof that a project's outcome has been reached.
 */
export interface PlanOptions {
  residentDir: string;
  now?: () => number;
}

const maxPlans = 3, maxHistory = 10, stallMinutes = 20, replyLimit = 1250;
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine(text => !/[\r\n]/.test(text), "One line, no line breaks.");
const planName = z.string().trim().min(1).max(40).refine(text => !/[\r\n"]/.test(text), "A few words on one line, without double quotes.");
const stepState = z.enum(["todo", "doing", "done", "blocked", "dropped"]);

export const planDefinitions = {
  plan_set: {
    description: "Write or update a medium-term project. goal is its outcome; why links it to your enduring vision; done_when says what you will observe when it is complete. Keep a short rolling action plan (usually 3..7 steps, 1..12 allowed); unchanged step text keeps its state. needs gives prerequisites/blockers (empty string clears it); with names collaborators (empty list clears it). Omitted needs/with are retained. Up to three open projects, one in focus. Editing text is not progress. New projects take focus unless focus:false. After actions, verify done_when and use plan_finish with observed evidence.",
    schema: z.object({ name: planName, goal: oneLine(140), why: oneLine(140), done_when: oneLine(240), needs: z.string().trim().max(200).refine(text => !/[\r\n]/.test(text), "One line, no line breaks.").optional(), with: z.array(oneLine(40)).max(6).optional(), steps: z.array(oneLine(120)).min(1).max(12), focus: z.boolean().optional() }).strict(),
  },
  plan_step: {
    description: "Set the state of a step of a plan: todo, doing, done, blocked or dropped. Give either step (a step number, counting from 1) or all:true for every still-open step. name defaults to focus. note explains the state (at most 200 characters). Checked or dropped steps do NOT finish the project: verify done_when, then plan_finish with observed evidence. Blocked is not done. Changing only a note is not progress.",
    schema: z.object({ name: planName.optional(), step: z.number().int().min(1).max(12).optional(), all: z.boolean().optional(), state: stepState, note: oneLine(200).optional() }).strict()
      // No full stop: the tool server adds one when it reports a schema error.
      .refine(args => (args.step !== undefined) !== (args.all === true), { message: "Give either step (a step number, counting from 1) or all: true; not both and not neither" }),
  },
  plan_finish: {
    description: "Close a project explicitly. outcome:done requires every action done or dropped, defined done_when criteria, and evidence describing the observed result against those criteria. Evidence is resident-reported, not machine-verified. Optional unlocks records a useful capability now available. outcome:dropped abandons the project without claiming success; evidence may explain why. name defaults to focus. Keeps bounded project history.",
    schema: z.object({ name: planName.optional(), outcome: z.enum(["done", "dropped"]), evidence: oneLine(400).optional(), unlocks: oneLine(200).optional() }).strict(),
  },
  plan_show: {
    description: "Without name: open projects and recent endings. With name: outcome, criteria, dependencies, actions and reported evidence. Long replies give numbered pages; repeat with page to continue without losing steps or notes.",
    schema: z.object({ name: planName.optional(), page: z.number().int().min(1).optional() }).strict(),
  },
  plan_focus: {
    description: "Choose which plan is in focus: the one whose current step status shows.",
    schema: z.object({ name: planName }).strict(),
  },
};
export type PlanSetArgs = z.infer<typeof planDefinitions.plan_set.schema>;
export type PlanStepArgs = z.infer<typeof planDefinitions.plan_step.schema>;
export type PlanShowArgs = z.infer<typeof planDefinitions.plan_show.schema>;
export type PlanFocusArgs = z.infer<typeof planDefinitions.plan_focus.schema>;
export type PlanFinishArgs = z.infer<typeof planDefinitions.plan_finish.schema>;

/** The plan in focus as other parts of the body read it. */
export interface PlanFocus {
  name: string;
  goal: string;
  why?: string;
  done_when?: string;
  needs?: string;
  with?: string[];
  awaitingVerification?: boolean;
  /** The next task when actions are closed, without inventing a numbered action. */
  verification?: string;
  total: number;
  done: number;
  /** The first step being done, otherwise the first still to do. */
  current?: { number: number; text: string };
  blocked: { number: number; text: string; note?: string }[];
  /** Milliseconds since an action state changed; text/note edits do not reset it. */
  idleMs: number;
}

export interface Plans {
  set(args: PlanSetArgs): Promise<string>;
  step(args: PlanStepArgs): Promise<string>;
  show(args: PlanShowArgs): Promise<string>;
  focus(args: PlanFocusArgs): Promise<string>;
  finish(args: PlanFinishArgs): Promise<string>;
  focused(): Promise<PlanFocus | undefined>;
  /** What `status` adds: nothing, one line or two. The hint for a resident without a plan is given once per tool-server start. */
  statusLines(): Promise<string[]>;
}

type StepState = z.infer<typeof stepState>;
interface Step { text: string; state: StepState; note?: string }
interface Plan { name: string; goal: string; why?: string; done_when?: string; needs?: string; with?: string[]; evidence?: string; unlocks?: string; steps: Step[]; created: number; moved: number }
interface Ended extends Plan { ended: number; outcome?: "done" | "dropped" }
interface Store { focus?: string; plans: Plan[]; history: Ended[] }

const storedStep = z.object({ text: z.string(), state: stepState, note: z.string().optional() });
// New fields stay optional on disk: pre-project plan.json files retain their state.
const storedPlan = z.object({ name: z.string(), goal: z.string(), why: z.string().optional(), done_when: z.string().optional(), needs: z.string().optional(), with: z.array(z.string()).optional(), evidence: z.string().optional(), unlocks: z.string().optional(), steps: z.array(storedStep).min(1), created: z.number().finite(), moved: z.number().finite() });
const storedData = z.object({ focus: z.string().optional(), plans: z.array(storedPlan), history: z.array(storedPlan.extend({ ended: z.number().finite(), outcome: z.enum(["done", "dropped"]).optional() })).optional() });

const open = (step: Step) => step.state === "todo" || step.state === "doing" || step.state === "blocked";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const count = (plan: Plan, state: StepState) => plan.steps.filter(step => step.state === state).length;
const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
const quoted = (plans: Plan[]) => plans.map(plan => `"${plan.name}"`).join(", ");
const criteria = (plan: Plan) => plan.done_when?.trim();
const verification = (plan: Plan) => criteria(plan)
  ? `Awaiting verification: verify done_when: ${sentence(criteria(plan)!)} Then plan_finish with observed evidence (resident-reported, not machine-verified).`
  : "Completion criteria need specification: use plan_set with why and done_when before verifying the project.";
const endedLabel = (plan: Ended) => plan.outcome === "done" ? "done (resident-reported, not machine-verified)" : plan.outcome === "dropped" ? "dropped (not success)" : "legacy ending (completion unverified)";

/** "38 min", "3 h", "2 d": whole units, rounded down. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  return minutes < 2880 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
}

function currentOf(plan: Plan): { number: number; text: string } | undefined {
  let index = plan.steps.findIndex(step => step.state === "doing");
  if (index < 0) index = plan.steps.findIndex(step => step.state === "todo");
  return index < 0 ? undefined : { number: index + 1, text: plan.steps[index]!.text };
}

function blockedOf(plan: Plan) {
  return plan.steps.flatMap((step, index) => step.state === "blocked" ? [{ number: index + 1, text: step.text, ...(step.note ? { note: step.note } : {}) }] : []);
}

/** "Step 2 of 5: till the field." or what stands in its place when no step is todo or doing. */
function currentText(plan: Plan, lead = "Step"): string {
  const current = currentOf(plan);
  if (current) return `${lead} ${current.number} of ${plan.steps.length}: ${sentence(current.text)}`;
  const blocked = count(plan, "blocked");
  return blocked ? `No step is todo or doing; ${blocked} of ${plan.steps.length} ${blocked === 1 ? "is" : "are"} blocked.` : verification(plan);
}

function tally(plan: Plan): string {
  const dropped = count(plan, "dropped");
  return `${count(plan, "done")} of ${plan.steps.length} steps done${dropped ? `, ${dropped} dropped` : ""}`;
}

export function createPlans(options: PlanOptions): Plans {
  const path = join(options.residentDir, "plan.json");
  const now = options.now ?? Date.now;
  let hinted = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** One read-change-write at a time: a client may send tool calls in parallel. */
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<{ store: Store; notice?: string }> => {
    let source: string;
    try { source = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: { plans: [], history: [] } };
      throw error;
    }
    let data: z.infer<typeof storedData> | undefined;
    try {
      const parsed = storedData.safeParse(JSON.parse(source));
      if (parsed.success) data = parsed.data;
    } catch {}
    if (!data) {
      // Kept beside it for whoever looks after the resident; the next write would otherwise erase it.
      await rename(path, `${path}.corrupt`).catch(() => undefined);
      return { store: { plans: [], history: [] }, notice: "plan.json could not be read and was set aside as plan.json.corrupt; no plans are loaded." };
    }
    const store: Store = { focus: data.focus, plans: data.plans, history: data.history ?? [] };
    if (!store.plans.some(plan => plan.name === store.focus)) store.focus = store.plans[0]?.name;
    return { store };
  };

  const save = async (store: Store): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.plan.json.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  };

  const change = (operation: (store: Store) => string): Promise<string> => exclusive(async () => {
    const { store, notice } = await load();
    const reply = operation(store);
    await save(store);
    return notice ? `${reply}\n${notice}` : reply;
  });

  const find = (store: Store, name: string | undefined): Plan => {
    if (!store.plans.length) throw new Error("No plan is written. plan_set writes one.");
    const plan = name === undefined ? store.plans.find(plan => plan.name === store.focus) : store.plans.find(plan => same(plan.name, name));
    if (!plan) throw new Error(`No plan named "${name}". Plans: ${quoted(store.plans)}.`);
    return plan;
  };

  const finish = (args: PlanFinishArgs) => change(store => {
    const plan = find(store, args.name);
    if (args.outcome === "done") {
      if (plan.steps.some(open)) throw new Error(`Plan "${plan.name}" still has open or blocked actions. Finish or drop those steps before verifying completion.`);
      if (!criteria(plan)) throw new Error(`Plan "${plan.name}" needs done_when completion criteria specified with plan_set before it can finish.`);
      if (!args.evidence?.trim()) throw new Error(`Plan "${plan.name}" needs nonempty evidence of the observed result against done_when; checked steps alone are not success.`);
    }
    const ended: Ended = { ...plan, ended: now(), outcome: args.outcome };
    delete ended.evidence;
    delete ended.unlocks;
    if (args.evidence) ended.evidence = args.evidence.trim();
    if (args.unlocks) ended.unlocks = args.unlocks;
    store.plans = store.plans.filter(other => other !== plan);
    store.history = [ended, ...store.history].slice(0, maxHistory);
    const wasFocus = store.focus === plan.name;
    if (wasFocus) store.focus = store.plans[0]?.name;
    const next = !store.plans.length ? "No plan is left." : wasFocus ? `The plan in focus is now "${store.focus}".` : `The plan in focus is still "${store.focus}".`;
    return `Plan "${plan.name}" ${endedLabel(ended)}: ${tally(plan)}. It moved to history.${ended.evidence ? ` Observed-result report (resident-reported): ${sentence(ended.evidence)}` : ""}${ended.unlocks ? ` Capability unlocked (resident-reported): ${sentence(ended.unlocks)}` : ""} ${next}`;
  });

  const set = (args: PlanSetArgs) => change(store => {
    const existing = store.plans.find(plan => same(plan.name, args.name));
    if (!existing && store.plans.length >= maxPlans) {
      throw new Error(`Three plans exist already: ${quoted(store.plans)}. plan_set with one of these names updates it; plan_finish with outcome dropped abandons one.`);
    }
    // Earlier states go to the steps with the same text, in order, so a repeated step text keeps the right one.
    const earlier = existing ? [...existing.steps] : [];
    let kept = 0;
    const steps = args.steps.map((text): Step => {
      const index = earlier.findIndex(step => step.text === text);
      if (index < 0) return { text, state: "todo" };
      kept++;
      return earlier.splice(index, 1)[0]!;
    });
    const plan: Plan = {
      ...existing, name: args.name, goal: args.goal, why: args.why, done_when: args.done_when, steps,
      ...(args.needs === undefined ? {} : { needs: args.needs }),
      ...(args.with === undefined ? {} : { with: args.with }),
      created: existing?.created ?? now(), moved: existing?.moved ?? now(),
    };
    if (existing && (existing.goal !== plan.goal || existing.why !== plan.why || existing.done_when !== plan.done_when)) {
      delete plan.evidence;
      delete plan.unlocks;
    }
    if (existing) store.plans[store.plans.indexOf(existing)] = plan; else store.plans.push(plan);
    const hadFocus = existing !== undefined && store.focus === existing.name;
    if (hadFocus || store.plans.length === 1 || args.focus === true || (!existing && args.focus !== false)) store.focus = plan.name;
    const wrote = existing
      ? `Plan "${plan.name}" replaced: ${steps.length} step${steps.length === 1 ? "" : "s"}, ${kept} kept ${kept === 1 ? "its" : "their"} state.`
      : `Plan "${plan.name}" written with ${steps.length} step${steps.length === 1 ? "" : "s"}.`;
    const progress = currentText(plan, "Current step");
    return `${wrote} ${store.focus === plan.name ? "It is the plan in focus." : `The plan in focus is still "${store.focus}".`} ${progress}`;
  });

  const step = (args: PlanStepArgs) => change(store => {
    const plan = find(store, args.name);
    const total = plan.steps.length;
    let stateChanged = false;
    const apply = (target: Step) => {
      stateChanged ||= target.state !== args.state;
      target.state = args.state;
      // A note explains one state; it does not outlive it.
      if (args.note === undefined) delete target.note; else target.note = args.note;
    };
    let told: string;
    // The schema lets exactly one of step and all: true through.
    if (args.step === undefined) {
      const numbers = plan.steps.flatMap((target, index) => open(target) && (target.state !== args.state || args.note !== undefined) ? [index + 1] : []);
      if (!numbers.length) return `Plan "${plan.name}": no open step to change. ${currentText(plan, "Current step")}`;
      for (const number of numbers) apply(plan.steps[number - 1]!);
      told = `Plan "${plan.name}": ${numbers.length === 1 ? "step" : "steps"} ${numbers.join(", ")} of ${total} ${numbers.length === 1 ? "is" : "are"} now ${args.state}.`;
    } else {
      const target = plan.steps[args.step - 1];
      if (!target) throw new Error(`Plan "${plan.name}" has ${total} step${total === 1 ? "" : "s"}; step ${args.step} does not exist.`);
      const was = target.state;
      if (was === args.state && (args.note === undefined || args.note === target.note)) {
        return `Plan "${plan.name}": step ${args.step} of ${total} was already ${was}; nothing changed. ${currentText(plan, "Current step")}`;
      }
      apply(target);
      told = was === args.state
        ? `Plan "${plan.name}": step ${args.step} of ${total} stays ${was}; note updated.`
        : `Plan "${plan.name}": step ${args.step} of ${total} is now ${args.state} (was ${was}).`;
    }
    if (stateChanged) plan.moved = now();
    return `${told} ${currentText(plan, "Current step")}`;
  });

  const focus = (args: PlanFocusArgs) => change(store => {
    const plan = find(store, args.name);
    const already = store.focus === plan.name;
    store.focus = plan.name;
    return `${already ? `"${plan.name}" was already the plan in focus.` : `The plan in focus is now "${plan.name}".`} ${currentText(plan)}`;
  });

  const full = (plan: Plan, heading: string, footer: string): string => {
    const head = `${heading} Goal: ${sentence(plan.goal)} Why: ${plan.why ? sentence(plan.why) : "needs specification."} Done when: ${criteria(plan) ? sentence(criteria(plan)!) : "needs specification."}${plan.needs ? ` Needs: ${sentence(plan.needs)}` : ""}${plan.with?.length ? ` With: ${plan.with.join(", ")}.` : ""}${plan.evidence ? ` Observed-result report (resident-reported, not machine-verified): ${sentence(plan.evidence)}` : ""}${plan.unlocks ? ` Capability unlocked (resident-reported): ${sentence(plan.unlocks)}` : ""}`;
    const lines = plan.steps.map((step, index) => `${index + 1}. ${step.state}: ${step.text}${step.note ? ` (note: ${step.note})` : ""}`);
    return [head, ...lines, footer].join("\n");
  };

  const paginated = (text: string, args: PlanShowArgs): string => {
    if (text.length <= replyLimit) return !args.page || args.page === 1 ? text : `No page ${args.page}; this result has 1 page.`;
    const pages: string[] = [];
    let remaining = text;
    const chunkLimit = 1080;
    while (remaining.length > chunkLimit) {
      let end = remaining.lastIndexOf("\n", chunkLimit);
      if (end <= 0) end = remaining.lastIndexOf(" ", chunkLimit);
      if (end <= 0) end = chunkLimit;
      pages.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    pages.push(remaining);
    const page = args.page ?? 1;
    if (page > pages.length) return `No page ${page}; this result has ${pages.length} pages.`;
    const next = page < pages.length ? ` Next: plan_show ${JSON.stringify({ ...args, page: page + 1 })}` : "";
    return `${pages[page - 1]}\nPage ${page}/${pages.length}.${next}`;
  };

  const show = async (args: PlanShowArgs): Promise<string> => {
    const { store, notice } = await exclusive(load);
    const tail = notice ? `\n${notice}` : "";
    if (args.name !== undefined) {
      const name = args.name;
      const plan = store.plans.find(plan => same(plan.name, name));
      if (plan) return paginated(full(plan, `Plan "${plan.name}"${store.focus === plan.name ? " (in focus)" : ""}.`, `${!plan.steps.some(open) ? `${verification(plan)} ` : ""}Last step change ${span(now() - plan.moved)} ago.`) + tail, args);
      const ended = store.history.find(plan => same(plan.name, name));
      if (ended) return paginated(full(ended, `Plan "${ended.name}" ${endedLabel(ended)} ${span(now() - ended.ended)} ago: ${tally(ended)}.`, "It is in history; plan_set writes a new project with that name.") + tail, args);
      throw new Error(store.plans.length ? `No plan named "${name}". Plans: ${quoted(store.plans)}.` : `No plan named "${name}", and no plan is written. plan_set writes one.`);
    }
    const lines = store.plans.map(plan => `${store.focus === plan.name ? "In focus: " : ""}"${plan.name}" (${tally(plan)}): ${sentence(plan.goal)} ${currentText(plan)}${!criteria(plan) && plan.steps.some(open) ? " Completion criteria need specification." : ""}${plan.needs ? ` Needs: ${sentence(plan.needs)}` : ""}`);
    if (!lines.length) lines.push("No plan is written. plan_set { name, goal, why, done_when, steps } writes one.");
    const ended = store.history.slice(0, 3).map(plan => `"${plan.name}" ${endedLabel(plan)} ${span(now() - plan.ended)} ago (${tally(plan)})`);
    if (ended.length) lines.push(`Ended: ${ended.join("; ")}.`);
    return paginated(lines.join("\n") + tail, args);
  };

  const view = (plan: Plan): PlanFocus => ({
    name: plan.name, goal: plan.goal, total: plan.steps.length, done: count(plan, "done"),
    why: plan.why, done_when: plan.done_when, needs: plan.needs, with: plan.with,
    awaitingVerification: !plan.steps.some(open), ...(!plan.steps.some(open) ? { verification: verification(plan) } : {}),
    current: currentOf(plan), blocked: blockedOf(plan), idleMs: Math.max(0, now() - plan.moved),
  });

  const focused = async (): Promise<PlanFocus | undefined> => {
    const { store } = await exclusive(load);
    const plan = store.plans.find(plan => plan.name === store.focus);
    return plan && view(plan);
  };

  const statusLines = async (): Promise<string[]> => {
    const { store, notice } = await exclusive(load);
    const plan = store.plans.find(plan => plan.name === store.focus);
    if (!plan) {
      if (notice) return [notice];
      if (hinted) return [];
      hinted = true;
      return ["No plan is written. plan_set keeps a project outcome, why, done_when and rolling steps; status shows the next action or verification."];
    }
    const seen = view(plan);
    const parts = [seen.current ? `step ${seen.current.number} of ${seen.total}: ${sentence(seen.current.text)}` : seen.verification ?? "no step is todo or doing."];
    for (const blocked of seen.blocked.slice(0, 2)) parts.push(`Step ${blocked.number} is blocked${blocked.note ? `: ${sentence(blocked.note)}` : " (no note)."}`);
    if (seen.blocked.length > 2) parts.push(`${seen.blocked.length - 2} more blocked.`);
    if (!criteria(plan) && !seen.awaitingVerification) parts.push("Completion criteria need specification (plan_set done_when).");
    if (!plan.why?.trim()) parts.push("Why needs specification: link the project to your enduring vision.");
    if (plan.needs) parts.push(`Needs: ${sentence(plan.needs)}`);
    if (seen.idleMs > stallMinutes * 60_000) parts.push(`No step has moved for ${span(seen.idleMs)}.`);
    const others = store.plans.filter(other => other !== plan).map(other => `"${other.name}" (${tally(other)})`);
    return [
      `Plan "${plan.name}": ${parts.join(" ")}`,
      `Plan goal: ${sentence(plan.goal)}${others.length ? ` Other plans: ${others.join(", ")}.` : ""}`,
    ];
  };

  return { set, step, finish, show, focus, focused, statusLines };
}
