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

/** A resident whose plan clock the test moves by hand. */
async function resident() {
  const f = await fixture();
  let clock = Date.UTC(2026, 10, 21, 12);
  f.tools.now = () => clock;
  const call = async (tool: string, args: object = {}) => reply(await f.tools.call(tool, args));
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
const stored = async (f: Fixture) => JSON.parse(await readFile(join(f.dir, "plan.json"), "utf8")) as { focus?: string; plans: { name: string; steps: { text: string; state: string; note?: string }[] }[]; history: { name: string }[] };

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
      'Plan "wheat field" (in focus). Goal: bread from my own field. Why: food keeps running out.',
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

  test("marking the last open step done finishes the plan, says so and moves it to history", async () => {
    const r = await resident();
    await r.call("plan_set", { name: "tools", goal: "stone tools", steps: ["mine 3 logs", "craft a pickaxe"] });
    await r.call("plan_step", { step: 1, state: "dropped" });
    expect(await r.call("plan_step", { step: 2, state: "done" }))
      .toBe('Plan "tools": step 2 of 2 is now done (was todo). Plan "tools" has ended: 1 of 2 steps done, 1 dropped. It moved to history. No plan is left.');
    // With no plan left, status has the one-time hint and then nothing about plans.
    expect(await r.planLines()).toEqual(["No plan is written. plan_set keeps a goal and its steps; status then shows the current step."]);
    expect(await r.planLines()).toEqual([]);
    const saved = await stored(r.f);
    expect(saved.plans).toEqual([]); expect(saved.focus).toBeUndefined(); expect(saved.history.map(plan => plan.name)).toEqual(["tools"]);
    r.pass(125);
    expect(await r.call("plan_show")).toBe('No plan is written. plan_set { name, goal, steps } writes one.\nEnded: "tools" 2 h ago (1 of 2 steps done, 1 dropped).');
    expect(await r.call("plan_show", { name: "tools" })).toStartWith('Plan "tools" ended 2 h ago: 1 of 2 steps done, 1 dropped. Goal: stone tools.\n1. dropped: mine 3 logs\n2. done: craft a pickaxe');
    // With every step done the word is "finished".
    await r.call("plan_set", { name: "bed", goal: "a bed", steps: ["craft a bed"] });
    expect(await r.call("plan_step", { step: 1, state: "done" })).toContain('Plan "bed" is finished: 1 of 1 steps done. It moved to history.');
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
    expect(await r.call("plan_step", { all: true, state: "dropped" }))
      .toBe('Plan "house": steps 1, 2 of 2 are now dropped. Plan "house" has ended: 0 of 2 steps done, 2 dropped. It moved to history. The plan in focus is now "food".');
    expect((await r.planLines())[0]).toBe('Plan "food": step 2 of 2: bake bread.');
  });

  test("three plans at most, with a way out named; history keeps the last ten", async () => {
    const r = await resident();
    for (const name of ["a", "b", "c"]) await r.call("plan_set", { name, goal: "g", steps: ["one"] });
    const refused = await r.f.tools.call("plan_set", { name: "d", goal: "g", steps: ["one"] });
    expect(refused.isError).toBe(true);
    expect(reply(refused)).toBe('Error: Three plans exist already: "a", "b", "c". plan_set with one of these names replaces it; plan_step with all: true and state dropped ends one.');
    expect((await stored(r.f)).plans.map(plan => plan.name)).toEqual(["a", "b", "c"]);
    // Replacing one of the three is not a fourth.
    expect((await r.f.tools.call("plan_set", { name: "b", goal: "g2", steps: ["one", "two"] })).isError).toBe(false);
    for (const name of ["a", "b", "c"]) await r.call("plan_step", { name, all: true, state: "done" });
    for (let i = 0; i < 12; i++) {
      await r.call("plan_set", { name: `job ${i}`, goal: "g", steps: ["one"] });
      await r.call("plan_step", { step: 1, state: "done" });
    }
    expect((await stored(r.f)).history.map(plan => plan.name)).toEqual(Array.from({ length: 10 }, (_, i) => `job ${11 - i}`));
  });

  test("the hint that plan_set exists is given once per tool-server start", async () => {
    const r = await resident();
    expect(await r.planLines()).toEqual(["No plan is written. plan_set keeps a goal and its steps; status then shows the current step."]);
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

  test("twelve long steps with notes still fit one reply, each with its number and state", async () => {
    const r = await resident();
    const steps = Array.from({ length: 12 }, (_, i) => `${i + 1} ${"s".repeat(117)}`.slice(0, 120));
    await r.call("plan_set", { name: "n".repeat(40), goal: "g".repeat(140), why: "w".repeat(140), steps });
    await r.call("plan_step", { all: true, state: "blocked", note: "b".repeat(100) });
    await r.call("plan_step", { step: 1, state: "done" });
    const shown = await r.call("plan_show", { name: "n".repeat(40) });
    expect(shown.length).toBeLessThanOrEqual(1200);
    const lines = shown.split("\n");
    expect(lines).toHaveLength(14);
    expect(lines[1]).toStartWith("1. done: 1 sss");
    for (let i = 2; i <= 12; i++) expect(lines[i]).toStartWith(`${i}. blocked: ${i} sss`);
    expect(lines[13]).toBe("Last step change 0 min ago.");
    const status = await r.f.tools.call("status");
    expect(status.content.filter(c => c.type === "text").map(c => c.text).join("\n").length).toBeLessThan(1500);
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
});
