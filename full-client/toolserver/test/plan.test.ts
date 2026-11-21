import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Tools } from "../src/tools.ts";
import { fixture, type Fixture } from "./fake-synapse.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** The reply without the event tail every tool result ends with. */
const reply = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n").split("\n\nSince last time:")[0]!;
const minute = 60_000;
const wheatSteps = ["make a hoe", "till 24 blocks by the stream", "plant the seeds", "fence the field", "bake bread"];
const projectDetails = { why: "Build a self-sustaining base that supplies neighbours", done_when: "The outcome is in place and I have observed it working" };
const noPlanHint = "No plan is written. plan_set keeps a project outcome, why, done_when and rolling steps; status shows the next action or verification.";

/** A resident whose plan clock the test moves by hand. */
async function resident() {
  const f = await fixture();
  let clock = Date.UTC(2026, 10, 21, 12);
  f.tools.now = () => clock;
  const call = async (tool: string, args: object = {}) => reply(await f.tools.call(tool, tool === "plan_set" ? { ...projectDetails, ...args } : args));
  const planLines = async (tools = f.tools) => reply(await tools.call("status")).split("\n").filter(line => /plan/i.test(line));
  return { f, call, planLines, pass: (minutes: number) => { clock += minutes * minute; }, now: () => clock };
}
/** The tool server started again over the same resident directory. */
function restart(f: Fixture, now: () => number) {
  const tools = new Tools(f.body);
  tools.now = now;
  cleanups.push(() => tools.close());
  return tools;
}
interface SavedPlan {
  name: string; goal: string; why?: string; done_when?: string; needs?: string; with?: string[];
  evidence?: string; unlocks?: string; outcome?: "done" | "dropped"; created: number; moved: number; ended?: number;
  steps: { text: string; state: string; note?: string }[];
}
const stored = async (f: Fixture) => JSON.parse(await readFile(join(f.dir, "plan.json"), "utf8")) as { focus?: string; plans: SavedPlan[]; history: SavedPlan[] };

describe("plans", () => {
  test("status shows the current step and the goal, and a restarted tool server shows the same", async () => {
    const r = await resident();
    expect(await r.call("plan_set", { name: "wheat field", goal: "bread from my own field", why: "food keeps running out", steps: wheatSteps }))
      .toBe('Plan "wheat field" written with 5 steps. It is the plan in focus. Current step 1 of 5: make a hoe.');
    expect(await r.call("plan_step", { step: 1, state: "done" })).toBe('Plan "wheat field": step 1 of 5 is now done (was todo). Current step 2 of 5: till 24 blocks by the stream.');
    const expected = ['Plan "wheat field": step 2 of 5: till 24 blocks by the stream.', "Plan goal: bread from my own field."];
    expect(await r.planLines()).toEqual(expected);

    const restarted = restart(r.f, r.now);
    expect(await r.planLines(restarted)).toEqual(expected);
    expect(reply(await restarted.call("plan_show", { name: "wheat field" }))).toBe([
      `Plan "wheat field" (in focus). Goal: bread from my own field. Why: food keeps running out. Done when: ${projectDetails.done_when}.`,
      "1. done: make a hoe", "2. todo: till 24 blocks by the stream", "3. todo: plant the seeds", "4. todo: fence the field", "5. todo: bake bread",
      "Last step change 0 min ago.",
    ].join("\n"));
  });

  test("a step being done comes before earlier steps still to do", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "wheat field", goal: "bread", steps: wheatSteps });
    await r.call("plan_step", { step: 3, state: "doing" });
    expect((await r.planLines())[0]).toBe('Plan "wheat field": step 3 of 5: plant the seeds.');
    await r.call("plan_step", { step: 3, state: "done" });
    expect((await r.planLines())[0]).toBe('Plan "wheat field": step 1 of 5: make a hoe.');
  });

  test("status says how long no step has moved once that passes 20 minutes, and a step change resets it", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "wheat field", goal: "bread", steps: wheatSteps });
    await r.call("plan_step", { step: 1, state: "done" });
    r.pass(20);
    expect((await r.planLines())[0]).toBe('Plan "wheat field": step 2 of 5: till 24 blocks by the stream.');
    r.pass(18);
    expect((await r.planLines())[0]).toBe('Plan "wheat field": step 2 of 5: till 24 blocks by the stream. No step has moved for 38 min.');
    // Writing the same steps again is not progress; neither is repeating a state.
    await r.call("plan_set", { name: "wheat field", goal: "bread", steps: wheatSteps });
    expect(await r.call("plan_step", { step: 1, state: "done" })).toBe('Plan "wheat field": step 1 of 5 was already done; nothing changed. Current step 2 of 5: till 24 blocks by the stream.');
    expect((await r.planLines())[0]).toEndWith("No step has moved for 38 min.");
    // The time survives a restart, because it is kept in the file.
    r.pass(100);
    expect((await r.planLines(restart(r.f, r.now)))[0]).toEndWith("No step has moved for 2 h.");
    await r.call("plan_step", { step: 2, state: "doing" });
    expect((await r.planLines())[0]).toBe('Plan "wheat field": step 2 of 5: till 24 blocks by the stream.');
  });

  test("blocked steps are shown with their note, also when nothing else is left to do", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "house", goal: "a roof before night", steps: ["collect 40 planks", "find wool", "place the bed"] });
    expect(await r.call("plan_step", { step: 2, state: "blocked", note: "no sheep within 200 blocks" }))
      .toBe('Plan "house": step 2 of 3 is now blocked (was todo). Current step 1 of 3: collect 40 planks.');
    expect((await r.planLines())[0]).toBe('Plan "house": step 1 of 3: collect 40 planks. Step 2 is blocked: no sheep within 200 blocks.');
    await r.call("plan_step", { step: 1, state: "done" });
    await r.call("plan_step", { step: 3, state: "blocked" });
    expect((await r.planLines())[0]).toBe('Plan "house": no step is todo or doing. Step 2 is blocked: no sheep within 200 blocks. Step 3 is blocked (no note).');
    // A note explains one state: unblocking the step drops it.
    await r.call("plan_step", { step: 2, state: "todo" });
    expect((await stored(r.f)).plans[0]!.steps[1]).toEqual({ text: "find wool", state: "todo" });
  });

  test("checked steps retain the project awaiting verification; explicit evidence closes it", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "tools", goal: "stone tools", done_when: "A stone pickaxe is in my inventory", steps: ["mine 3 logs", "craft a pickaxe"] });
    await r.call("plan_step", { step: 1, state: "dropped" });
    expect(await r.call("plan_step", { step: 2, state: "done" })).toContain("Awaiting verification: verify done_when: A stone pickaxe is in my inventory.");
    expect((await r.planLines())[0]).toContain("Awaiting verification");
    expect(await r.f.tools.plans.focused()).toMatchObject({ name: "tools", done: 1, total: 2, awaitingVerification: true, verification: expect.stringContaining("verify done_when") });
    const awaiting = await stored(r.f);
    expect(awaiting.plans).toHaveLength(1);
    expect(awaiting.history).toEqual([]);
    expect(awaiting.focus).toBe("tools");
    expect(await r.call("plan_finish", { outcome: "done" })).toContain("needs nonempty evidence");
    expect(await r.call("plan_finish", { outcome: "done", evidence: "   " })).toStartWith("Error:");
    expect(await stored(r.f)).toEqual(awaiting);
    const completed = await r.call("plan_finish", { outcome: "done", evidence: "inventory shows one stone pickaxe", unlocks: "can mine iron ore" });
    expect(completed).toContain("done (resident-reported, not machine-verified)");
    expect(completed).toContain("Capability unlocked (resident-reported): can mine iron ore.");
    expect(await r.planLines()).toEqual([noPlanHint]);
    expect(await r.planLines()).toEqual([]);
    const saved = await stored(r.f);
    expect(saved.plans).toEqual([]);
    expect(saved.focus).toBeUndefined();
    expect(saved.history[0]).toMatchObject({ name: "tools", outcome: "done", evidence: "inventory shows one stone pickaxe", unlocks: "can mine iron ore" });
    r.pass(125);
    expect(await r.call("plan_show")).toContain('"tools" done (resident-reported, not machine-verified) 2 h ago');
    expect(await r.call("plan_show", { name: "tools" })).toContain("Observed-result report (resident-reported, not machine-verified): inventory shows one stone pickaxe.");
  });

  test("replacing a plan keeps the state of steps whose text is unchanged", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "wheat field", goal: "bread", steps: ["make a hoe", "till the field", "plant the seeds", "till the field"] });
    await r.call("plan_step", { step: 1, state: "done" });
    await r.call("plan_step", { step: 2, state: "blocked", note: "no water" });
    await r.call("plan_step", { step: 4, state: "doing" });
    expect(await r.call("plan_set", { name: "Wheat Field", goal: "bread before night", steps: ["make a hoe", "dig a channel from the stream", "till the field", "till the field", "plant seeds"] }))
      .toBe('Plan "Wheat Field" replaced: 5 steps, 3 kept their state. It is the plan in focus. Current step 4 of 5: till the field.');
    const saved = await stored(r.f);
    expect(saved.plans).toHaveLength(1);
    expect(saved.plans[0]!.steps).toEqual([
      { text: "make a hoe", state: "done" }, { text: "dig a channel from the stream", state: "todo" },
      { text: "till the field", state: "blocked", note: "no water" }, { text: "till the field", state: "doing" }, { text: "plant seeds", state: "todo" },
    ]);
    expect(saved.focus).toBe("Wheat Field");
  });

  test("one plan is in focus: a new plan takes it unless told not to, plan_focus moves it, an ended plan passes it on", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "food", goal: "bread every day", steps: ["plant wheat", "bake bread"] });
    expect(await r.call("plan_set", { name: "house", goal: "a roof", steps: ["collect planks", "build walls"], focus: false }))
      .toBe('Plan "house" written with 2 steps. The plan in focus is still "food". Current step 1 of 2: collect planks.');
    expect(await r.planLines()).toEqual(['Plan "food": step 1 of 2: plant wheat.', 'Plan goal: bread every day. Other plans: "house" (0 of 2 steps done).']);
    expect(await r.call("plan_set", { name: "armour", goal: "iron armour", steps: ["mine iron"] })).toContain("It is the plan in focus.");
    expect(await r.call("plan_focus", { name: "HOUSE" })).toBe('The plan in focus is now "house". Step 1 of 2: collect planks.');
    expect((await r.planLines())[0]).toBe('Plan "house": step 1 of 2: collect planks.');
    // A step of another plan is reached by name, and the focus stays where it is.
    expect(await r.call("plan_step", { name: "food", step: 1, state: "done" })).toBe('Plan "food": step 1 of 2 is now done (was todo). Current step 2 of 2: bake bread.');
    expect(await r.call("plan_show")).toBe([
      '"food" (1 of 2 steps done): bread every day. Step 2 of 2: bake bread.',
      'In focus: "house" (0 of 2 steps done): a roof. Step 1 of 2: collect planks.',
      '"armour" (0 of 1 steps done): iron armour. Step 1 of 1: mine iron.',
    ].join("\n"));
    expect(await r.call("plan_step", { all: true, state: "dropped" })).toContain("Awaiting verification");
    expect((await stored(r.f)).focus).toBe("house");
    expect(await r.call("plan_finish", { outcome: "dropped", evidence: "I will share the existing shelter instead" }))
      .toContain('dropped (not success): 0 of 2 steps done, 2 dropped. It moved to history.');
    expect((await stored(r.f)).history[0]!.outcome).toBe("dropped");
    expect((await r.planLines())[0]).toBe('Plan "food": step 2 of 2: bake bread.');
  });

  test("three plans at most, with a way out named; history keeps the last ten", async () => {
    const r = await resident();
    for (const name of ["a", "b", "c"]) await r.call("plan_set", { name, goal: "g", steps: ["one"] });
    const refused = await r.f.tools.call("plan_set", { ...projectDetails, name: "d", goal: "g", steps: ["one"] });
    expect(refused.isError).toBe(true);
    expect(reply(refused)).toBe('Error: Three plans exist already: "a", "b", "c". plan_set with one of these names updates it; plan_finish with outcome dropped abandons one.');
    expect((await stored(r.f)).plans.map(plan => plan.name)).toEqual(["a", "b", "c"]);
    // Replacing one of the three is not a fourth.
    expect((await r.f.tools.call("plan_set", { ...projectDetails, name: "b", goal: "g2", steps: ["one", "two"] })).isError).toBe(false);
    for (const name of ["a", "b", "c"]) await r.call("plan_finish", { name, outcome: "dropped" });
    for (let i = 0; i < 12; i++) {
      await r.call("plan_set", { name: `job ${i}`, goal: "g", steps: ["one"] });
      await r.call("plan_step", { step: 1, state: "done" });
      await r.call("plan_finish", { outcome: "done", evidence: "I observed the intended result in the world" });
    }
    expect((await stored(r.f)).history.map(plan => plan.name)).toEqual(Array.from({ length: 10 }, (_, i) => `job ${11 - i}`));
  });

  test("the hint that plan_set exists is given once per tool-server start", async () => {
    const r = await resident();
    expect(await r.planLines()).toEqual([noPlanHint]);
    expect(await r.planLines()).toEqual([]);
    const restarted = restart(r.f, r.now);
    expect(await r.planLines(restarted)).toHaveLength(1);
    expect(await r.planLines(restarted)).toEqual([]);
  });

  test("mistakes are answered with what exists", async () => {
    const r = await resident();
    expect(await r.call("plan_step", { step: 1, state: "done" })).toBe("Error: No plan is written. plan_set writes one.");
    await r.call("plan_set", { name: "food", goal: "bread", steps: ["plant wheat", "bake bread"] });
    expect(await r.call("plan_step", { step: 3, state: "done" })).toBe('Error: Plan "food" has 2 steps; step 3 does not exist.');
    expect(await r.call("plan_focus", { name: "fod" })).toBe('Error: No plan named "fod". Plans: "food".');
    expect(await r.call("plan_show", { name: "fod" })).toBe('Error: No plan named "fod". Plans: "food".');
    const long = await r.call("plan_set", { name: "food", goal: "bread", steps: ["x".repeat(121)] });
    expect(long).toStartWith("Error: steps.0: String must contain at most 120 character(s)");
    expect(await r.call("plan_set", { name: "food", goal: "bread", steps: Array.from({ length: 13 }, (_, i) => `step ${i}`) })).toStartWith("Error: steps: Array must contain at most 12 element(s)");
    // Exactly one of step and all: true; all: false beside a step number is still that step.
    const which = "Error: input: Give either step (a step number, counting from 1) or all: true; not both and not neither. plan_step: Set the state of a step";
    expect(await r.call("plan_step", { state: "done" })).toStartWith(which);
    expect(await r.call("plan_step", { step: 1, all: true, state: "done" })).toStartWith(which);
    expect(await r.call("plan_step", { all: false, state: "done" })).toStartWith(which);
    // A refused call changed nothing.
    expect((await stored(r.f)).plans[0]!.steps).toEqual([{ text: "plant wheat", state: "todo" }, { text: "bake bread", state: "todo" }]);
    expect(await r.call("plan_step", { step: 1, all: false, state: "doing" })).toBe('Plan "food": step 1 of 2 is now doing (was todo). Current step 1 of 2: plant wheat.');
  });

  test("long project actions and notes remain readable across bounded pages", async () => {
    const r = await resident();
    const steps = Array.from({ length: 12 }, (_, i) => `${i + 1} ${"s".repeat(117)}`.slice(0, 120));
    const note = "b".repeat(200);
    await r.call("plan_set", { name: "n".repeat(40), goal: "g".repeat(140), why: "w".repeat(140), steps });
    await r.call("plan_step", { all: true, state: "blocked", note });
    await r.call("plan_step", { step: 1, state: "done" });
    const first = await r.call("plan_show", { name: "n".repeat(40) });
    const pages = Number(first.match(/Page 1\/(\d+)/)?.[1]);
    expect(pages).toBeGreaterThan(1);
    const shown = [first];
    for (let page = 2; page <= pages; page++) shown.push(await r.call("plan_show", { name: "n".repeat(40), page }));
    for (const page of shown) expect(page.length).toBeLessThanOrEqual(1250);
    const all = shown.join("\n");
    expect(all).toContain(`1. done: ${steps[0]}`);
    for (let i = 2; i <= 12; i++) expect(all).toContain(`${i}. blocked: ${steps[i - 1]} (note: ${note})`);
    expect(all).toContain(projectDetails.done_when);
    expect(all).toContain("Last step change");
  });

  test("calls sent at the same time all land", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "food", goal: "bread", steps: wheatSteps });
    await Promise.all([1, 2, 3, 4].map(step => r.f.tools.call("plan_step", { step, state: "done" })));
    expect((await stored(r.f)).plans[0]!.steps.map(step => step.state)).toEqual(["done", "done", "done", "done", "todo"]);
  });

  test("an unreadable plan.json is set aside and reported once, not silently overwritten", async () => {
    const r = await resident();
    await writeFile(join(r.f.dir, "plan.json"), "{ not json");
    expect(await r.planLines()).toEqual(["plan.json could not be read and was set aside as plan.json.corrupt; no plans are loaded."]);
    expect(await readFile(join(r.f.dir, "plan.json.corrupt"), "utf8")).toBe("{ not json");
    expect(await r.call("plan_set", { name: "food", goal: "bread", steps: ["plant wheat"] })).toBe('Plan "food" written with 1 step. It is the plan in focus. Current step 1 of 1: plant wheat.');
    expect((await r.planLines())[0]).toBe('Plan "food": step 1 of 1: plant wheat.');
  });

  test("old stores load intact, retain timestamps and history, and ask for missing criteria", async () => {
    const r = await resident();
    const legacy = {
      focus: "old farm",
      plans: [{ name: "old farm", goal: "lasting food", steps: [{ text: "plant wheat", state: "done", note: "24 crops planted" }], created: r.now() - minute * 60, moved: r.now() - minute * 30 }],
      history: [{ name: "old shelter", goal: "shelter", why: "survive", steps: [{ text: "build walls", state: "done" }], created: 1, moved: 2, ended: 3 }],
    };
    const source = JSON.stringify(legacy);
    await writeFile(join(r.f.dir, "plan.json"), source);
    expect((await r.planLines()).join(" ")).toContain("Completion criteria need specification");
    expect(await r.call("plan_show", { name: "old farm" })).toContain("Why: needs specification. Done when: needs specification.");
    expect(await r.call("plan_show", { name: "old shelter" })).toContain("legacy ending (completion unverified)");
    expect(await readFile(join(r.f.dir, "plan.json"), "utf8")).toBe(source);
    expect(await r.call("plan_finish", { outcome: "done", evidence: "I can see the crops" })).toContain("needs done_when completion criteria");
    expect(await stored(r.f)).toEqual(legacy);
    await r.call("plan_set", { name: "old farm", goal: "lasting food", done_when: "24 planted crops survive and a harvest is stored", steps: ["plant wheat", "harvest and store food"] });
    const updated = await stored(r.f);
    expect(updated.plans[0]).toMatchObject({ created: legacy.plans[0]!.created, moved: legacy.plans[0]!.moved, steps: [{ text: "plant wheat", state: "done", note: "24 crops planted" }, { text: "harvest and store food", state: "todo" }] });
    expect(updated.history).toEqual(legacy.history);
  });

  test("new and updated projects require why and observable completion criteria", async () => {
    const r = await resident();
    for (const details of [{}, { why: projectDetails.why }, { done_when: projectDetails.done_when }, { why: " ", done_when: projectDetails.done_when }]) {
      expect((await r.f.tools.call("plan_set", { name: "farm", goal: "lasting food", steps: ["plant wheat"], ...details })).isError).toBe(true);
    }
    await r.call("plan_set", { name: "farm", goal: "lasting food", steps: ["plant wheat"] });
    const before = await stored(r.f);
    expect((await r.f.tools.call("plan_set", { name: "farm", goal: "food for two", steps: ["plant wheat"] })).isError).toBe(true);
    expect(await stored(r.f)).toEqual(before);
  });

  test("blocked projects cannot finish successfully, but may be explicitly abandoned", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "farm", goal: "lasting food", needs: "water beside the field", with: ["Margo"], steps: ["plant wheat"] });
    await r.call("plan_step", { step: 1, state: "blocked", note: "water source is inaccessible" });
    expect(await r.call("plan_finish", { outcome: "done", evidence: "I marked the action" })).toContain("still has open or blocked actions");
    expect(await r.f.tools.plans.focused()).toMatchObject({ awaitingVerification: false, needs: "water beside the field", with: ["Margo"], blocked: [{ number: 1, text: "plant wheat", note: "water source is inaccessible" }] });
    expect((await r.planLines())[0]).toContain("Needs: water beside the field.");
    expect((await stored(r.f)).history).toEqual([]);
    expect(await r.call("plan_finish", { outcome: "dropped", evidence: "Use Margo's existing field instead", unlocks: "a path to Margo's field was cleared" })).toContain("dropped (not success)");
    expect((await stored(r.f)).history[0]).toMatchObject({ outcome: "dropped", unlocks: "a path to Margo's field was cleared", steps: [{ text: "plant wheat", state: "blocked", note: "water source is inaccessible" }] });
  });

  test("verification and completion reports survive restart and a rolling plan resumes", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "farm", goal: "lasting food", needs: "seed stock", with: ["Gary", "Margo"], steps: ["plant wheat"] });
    await r.call("plan_step", { all: true, state: "done" });
    r.pass(30);
    const restarted = restart(r.f, r.now);
    expect(await r.planLines(restarted)).toEqual(await r.planLines());
    expect(await restarted.plans.focused()).toMatchObject({ awaitingVerification: true, idleMs: 30 * minute, with: ["Gary", "Margo"] });
    await restarted.call("plan_set", { ...projectDetails, name: "farm", goal: "lasting food", steps: ["plant wheat", "store the harvest"] });
    expect(await restarted.plans.focused()).toMatchObject({ awaitingVerification: false, current: { number: 2, text: "store the harvest" }, needs: "seed stock", with: ["Gary", "Margo"], idleMs: 30 * minute });
    await restarted.call("plan_set", { ...projectDetails, name: "farm", goal: "lasting food", needs: "", with: [], steps: ["plant wheat", "store the harvest"] });
    expect(await restarted.plans.focused()).toMatchObject({ needs: "", with: [], idleMs: 30 * minute });
    await restarted.call("plan_step", { step: 2, state: "done" });
    await restarted.call("plan_finish", { outcome: "done", evidence: "Harvest stored in the shared chest", unlocks: "bread for neighbours" });
    expect(reply(await restart(r.f, r.now).call("plan_show", { name: "farm" }))).toContain("Harvest stored in the shared chest.");
  });

  test("text and note edits are not progress; changed criteria invalidate completion evidence", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "farm", goal: "lasting food", steps: ["plant wheat"] });
    await r.call("plan_step", { step: 1, state: "blocked", note: "need seeds" });
    const originalMoved = (await stored(r.f)).plans[0]!.moved;
    r.pass(40);
    await r.call("plan_step", { step: 1, state: "blocked", note: "ask Margo about seeds" });
    await r.call("plan_step", { all: true, state: "blocked", note: "waiting for seeds" });
    await r.call("plan_set", { name: "farm", goal: "shared lasting food", why: "Help the settlement feed newcomers", steps: ["plant wheat", "build storage"] });
    expect((await stored(r.f)).plans[0]!.moved).toBe(originalMoved);
    expect((await r.planLines())[0]).toContain("No step has moved for 40 min.");
    const seeded = await stored(r.f);
    seeded.plans[0]!.evidence = "Earlier observation under previous criteria";
    seeded.plans[0]!.unlocks = "Old capability claim";
    await writeFile(join(r.f.dir, "plan.json"), JSON.stringify(seeded));
    await r.call("plan_set", { name: "farm", goal: "shared lasting food", why: "Help the settlement feed newcomers", done_when: "A harvest for two neighbours is stored", steps: ["plant wheat", "build storage"] });
    const revised = (await stored(r.f)).plans[0]!;
    expect(revised.evidence).toBeUndefined();
    expect(revised.unlocks).toBeUndefined();
    expect(revised.moved).toBe(originalMoved);
    expect(revised.steps[0]).toMatchObject({ state: "blocked", note: "waiting for seeds" });
  });
});
