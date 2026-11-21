import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture, type FakeOptions, type Fixture } from "./fake-synapse.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** The tool's own text, without the event tail every result carries. */
const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n").split("\n\nSince last time:")[0]!;
const mc = (name: string) => `minecraft:${name}`;
// Two planks, one above the other, make four sticks: the fake server crafts it like the game.
const stickRecipe = { shaped: [[[mc("oak_planks")]], [[mc("oak_planks")]]], output: { item: mc("stick"), count: 4 } };
/** Lays two planks from hotbar slot 0 in the 2x2 grid and takes the sticks: seven body calls, read back through state(). */
const makeSticks = `await body.open_inventory();
await body.click_slot({ slot: 36 });
await body.click_slot({ slot: 1, button: 1 });
await body.click_slot({ slot: 3, button: 1 });
await body.click_slot({ slot: 36 });
await body.click_slot({ slot: 0, mode: "QUICK_MOVE" });
await body.close_screen();
const now = await state();
log("sticks now " + now.inventory["minecraft:stick"]);
return now.inventory["minecraft:stick"];`;
const sticks = { name: "make_sticks", description: "Crafts 4 sticks from 2 oak planks in hotbar slot 0, no screen needed.", code: makeSticks, expect: { gain: { stick: 4 }, lose: { "minecraft:oak_planks": 2 }, screen: "none" } };

async function commons() {
  const dir = await mkdtemp(join(tmpdir(), "resident-commons-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "commons.sqlite");
}
async function resident(commonsDb: string, name = "Gary", options: FakeOptions = {}) {
  const f = await fixture({ recipes: [stickRecipe], ...options, name, commonsDb });
  give(f, mc("oak_planks"), 6);
  return f;
}
function give(f: Fixture, item: string, count: number) {
  f.state.inventory!.main = [{ slot: 0, item, count }];
  f.state.hotbar = [{ slot: 0, item, count }];
}
/** What a reviewer does through the management app, written straight to the commons. */
function review(path: string, table: "skills" | "shared_notes", key: string, status: string, reason = "") {
  const db = new Database(path);
  const column = table === "skills" ? "name" : "topic";
  const id = db.query<{ id: number }, [string]>(`SELECT id FROM ${table} WHERE ${column} = ?`).get(key)!.id;
  db.query(`UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
  if (status !== "verified") {
    db.query("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES (?, ?, 'caretaker', ?, ?, ?)")
      .run(table === "skills" ? "skill" : "note", id, status === "rejected" ? "reject" : "keep", reason, Date.now());
  }
  db.close();
}
function rows<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try { return db.query<T, []>(sql).all(); } finally { db.close(); }
}
/** Saves code as a draft and runs it once. */
async function runCode(f: Fixture, code: string, extra: Record<string, unknown> = {}, name = "probe") {
  const saved = await f.tools.call("skill_save", { name, description: "A probe used by the tests.", code });
  expect(saved.isError).toBe(false);
  const result = await f.tools.call("skill_run", { name, ...extra });
  return { result, reply: text(result) };
}
/**
 * Waits for something the fake client or the commons shows. Skill code runs in another thread and
 * reaches the fake over HTTP, so there is no promise to await; this polls the observable effect instead.
 */
async function until(condition: () => boolean, what: string) {
  for (let tries = 0; tries < 400; tries++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error(`Timed out waiting for ${what}.`);
}

describe("commons", () => {
  test("without a reachable commons the skill and note tools say so in one line and the body still answers", async () => {
    const unset = await fixture();
    for (const [tool, args] of [["skill_find", {}], ["skill_show", { name: "make_sticks" }], ["skill_run", { name: "make_sticks" }], ["skill_save", sticks], ["note_share", { topic: "furnace", text: "Eight cobblestone make a furnace." }], ["notes_shared", {}], ["feedback", { skill: "make_sticks", worked: true }]] as const) {
      const result = await unset.tools.call(tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Error: Skills and shared notes are unavailable: the commons database could not be opened (COMMONS_DB is not set). Your other tools work as before.");
    }
    expect(text(await unset.tools.call("status"))).toContain("Health 20/20");

    const blocked = await fixture({ commonsDb: "/dev/null/commons.sqlite" });
    const reply = text(await blocked.tools.call("skill_find", {}));
    expect(reply).toStartWith("Error: Skills and shared notes are unavailable: the commons database could not be opened (/dev/null/commons.sqlite: ");
    expect(reply).not.toContain("\n");
    expect(text(await blocked.tools.call("inventory"))).toBe("Inventory empty.");
  });
});

describe("skill_save", () => {
  test("reports a syntax error with its line and saves nothing", async () => {
    const f = await resident(await commons());
    const result = await f.tools.call("skill_save", { ...sticks, code: "const planks = 2;\nconst sticks = ;\nreturn sticks;" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: Syntax error in code at line 2: unexpected token in expression: ';'. Nothing was saved.");
    const unclosed = await f.tools.call("skill_save", { ...sticks, code: "const planks = 2;\nif (planks) {\n  log('two');" });
    expect(text(unclosed)).toBe("Error: Syntax error in code at the end, where a brace, bracket or quote is still open: unexpected token in expression: ')'. Nothing was saved.");
    expect(text(await f.tools.call("skill_find", {}))).toBe("No skills yet. Save a routine that worked with skill_save.");
  });

  test("a skill without a check is told it can never be shared, and running it leaves it a draft", async () => {
    const path = await commons();
    const f = await resident(path);
    const saved = text(await f.tools.call("skill_save", { name: "look_up", description: "Looks straight up at the sky.", code: "return await body.look({ pitch: -90 });" }));
    expect(saved).toContain("Saved look_up v1 as a draft; only you can see and run it.");
    expect(saved).toContain("It has no check, so it can never become verified or be seen by the other residents.");
    expect(saved).toContain("gain or lose for items it makes or uses up, near for the place it should end at, screen for a screen");
    const result = await f.tools.call("skill_run", { name: "look_up" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("Skill look_up v1 finished in ");
    expect(text(result)).toContain("No check declared, so this skill cannot become verified.");
    expect(text(result)).toContain("Returned: Looked.");
    expect(f.state.rotation.pitch).toBe(-90);
    expect(rows<{ status: string; check_ok: number | null }>(path, "SELECT s.status, r.check_ok FROM skills s JOIN skill_runs r ON r.skill_id = s.id")).toEqual([{ status: "draft", check_ok: null }]);
  });

  test("another resident can neither overwrite nor run a draft, and learns whose it is", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    await gary.tools.call("skill_save", sticks);
    const overwrite = await margo.tools.call("skill_save", { ...sticks, code: "return 1;" });
    expect(text(overwrite)).toBe("Error: The name make_sticks belongs to a skill by Gary; nothing was saved. Choose another name.");
    const run = await margo.tools.call("skill_run", { name: "make_sticks" });
    expect(text(run)).toBe("Error: make_sticks is a draft by Gary; only Gary can run it until a run passes its check.");
    expect(text(await margo.tools.call("skill_show", { name: "make_sticks" }))).toStartWith("Error: No skill named make_sticks that you can see.");
    expect(text(await margo.tools.call("skill_find", {}))).toBe("No skills yet. Save a routine that worked with skill_save.");
    expect(rows<{ author: string; code: string }>(path, "SELECT author, code FROM skills")).toEqual([{ author: "Gary", code: makeSticks }]);
    expect(margo.state.inventory!.main).toEqual([{ slot: 0, item: mc("oak_planks"), count: 6 }]);
  });
});

describe("skill_run", () => {
  test("a skill that passes its check becomes verified, and a second resident finds and reuses it", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    const saved = text(await gary.tools.call("skill_save", { ...sticks, params: { unused: "nothing yet" } }));
    expect(saved).toBe("Saved make_sticks v1 as a draft; only you can see and run it. Run it with skill_run make_sticks: the first run that passes its check makes it verified, and then the other residents can find it.");

    const result = await gary.tools.call("skill_run", { name: "make_sticks" });
    const reply = text(result);
    expect(result.isError).toBe(false);
    expect(reply).toMatch(/^Skill make_sticks v1 finished in \d+(\.\d)? s, 7 tool calls\.\n/);
    expect(reply).toContain("Check passed: minecraft:stick changed by +4, needs +4 or more; minecraft:oak_planks changed by -2, needs -2 or less; screen is none, needs none.");
    expect(reply).toContain("Inventory changes: +4 minecraft:stick, -2 minecraft:oak_planks.");
    expect(reply).toContain("Returned: 4");
    expect(reply).toContain("make_sticks is now verified: the other residents can find and run it. A caretaker will review it.");
    expect(reply).toContain("Log (last 1 of 1):\nsticks now 4");
    expect(reply.length).toBeLessThanOrEqual(1200);
    // The sticks are really in his inventory, made by the clicks the skill sent.
    expect(gary.state.inventory!.main.find(s => s.item === mc("stick"))?.count).toBe(4);

    const found = text(await margo.tools.call("skill_find", { query: "sticks planks" }));
    expect(found).toBe([
      'One skill for "sticks planks". skill_show gives details, skill_run runs one.',
      "make_sticks | verified, not yet reviewed | by Gary | Crafts 4 sticks from 2 oak planks in hotbar slot 0, no screen needed. | args: unused | check passed in 1 of 1 run | used by 0 other residents | no feedback yet",
    ].join("\n").replace("One skill", "1 skill"));

    const reuse = await margo.tools.call("skill_run", { name: "make_sticks" });
    expect(reuse.isError).toBe(false);
    expect(text(reuse)).toContain("Check passed: minecraft:stick changed by +4");
    expect(text(reuse)).not.toContain("now verified");
    // Only someone who used another's skill is asked whether it helped, as the last line.
    expect(text(reuse)).toEndWith("\nDid make_sticks do what you needed? Tell the others: feedback with skill make_sticks and worked true or false.");
    expect(reply).not.toContain("feedback");
    expect(margo.state.inventory!.main.find(s => s.item === mc("stick"))?.count).toBe(4);
    // Whether it worked and whether others use it stay two separate numbers.
    expect(text(await gary.tools.call("skill_find", {}))).toContain("| by you | Crafts 4 sticks from 2 oak planks in hotbar slot 0, no screen needed. | args: unused | check passed in 2 of 2 runs | used by 1 other resident | no feedback yet");
    expect(rows(path, "SELECT resident, version, ok, check_ok, error FROM skill_runs ORDER BY id")).toEqual([
      { resident: "Gary", version: 1, ok: 1, check_ok: 1, error: null },
      { resident: "Margo", version: 1, ok: 1, check_ok: 1, error: null },
    ]);
  });

  test("a failing check keeps the skill a draft and reports observed against expected", async () => {
    const path = await commons();
    // The server refuses the recipe, so the clicks happen and no sticks appear.
    const gary = await resident(path, "Gary", { resultWorks: false }), margo = await resident(path, "Margo");
    await gary.tools.call("skill_save", sticks);
    const result = await gary.tools.call("skill_run", { name: "make_sticks" });
    const reply = text(result);
    expect(result.isError).toBe(true);
    expect(reply).toContain("Skill make_sticks v1 finished in ");
    expect(reply).toContain("Check FAILED: minecraft:stick changed by +0, needs +4 or more; minecraft:oak_planks changed by +0, needs -2 or less. Passed: screen is none, needs none.");
    expect(reply).toContain("Inventory changes: none.");
    expect(reply).toContain("make_sticks is still a draft: it becomes verified when a run finishes and passes its check.");
    expect(text(await gary.tools.call("skill_find", {}))).toContain("make_sticks | draft (only you see it) | by you |");
    expect(text(await gary.tools.call("skill_find", {}))).toContain("check passed in 0 of 1 run | used by 0 other residents");
    expect(text(await margo.tools.call("skill_find", {}))).toBe("No skills yet. Save a routine that worked with skill_save.");
    expect(rows(path, "SELECT ok, check_ok FROM skill_runs")).toEqual([{ ok: 1, check_ok: 0 }]);
  });

  test("an endless loop is ended at the time limit while the body keeps working, and the next call is answered", async () => {
    const path = await commons();
    const f = await resident(path);
    await f.tools.call("skill_save", { name: "spin", description: "Never finishes; used to test the time limit.", code: "log('spinning');\nawait body.say({ text: 'spinning' });\nwhile (true) {}", expect: { screen: "none" } });
    const started = performance.now();
    const running = f.tools.call("skill_run", { name: "spin", max_seconds: 1 });
    await until(() => f.requests.some(r => r.body.text === "spinning"), "the loop to start");
    // The loop runs in the interpreter's own thread: the poller that drives rescues is not held up by it.
    const pollStarted = performance.now();
    await f.body.poll();
    expect(performance.now() - pollStarted).toBeLessThan(250);
    const result = await running;
    const reply = text(result);
    expect(result.isError).toBe(true);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(reply).toMatch(/^Skill spin v1 STOPPED after 1(\.\d)? s, 1 tool call: time limit of 1 s reached while the code was still running\.\n/);
    expect(reply).toContain("Log (last 1 of 1):\nspinning");
    expect(reply).toContain("spin is still a draft");
    expect(text(await f.tools.call("status"))).toContain("Position 0, 64, 0");
    expect(rows(path, "SELECT ok, check_ok, error FROM skill_runs")).toEqual([{ ok: 0, check_ok: 1, error: "time limit of 1 s reached while the code was still running" }]);
    expect(rows(path, "SELECT status FROM skills")).toEqual([{ status: "draft" }]);
  });

  test("a run is stopped at 300 tool calls", async () => {
    const f = await resident(await commons());
    const before = f.requests.length;
    const { result, reply } = await runCode(f, "for (let i = 0; i < 1000; i++) await body.select_hotbar({ slot: i % 9 });\nreturn 'never';");
    expect(result.isError).toBe(true);
    expect(reply).toStartWith("Skill probe v1 STOPPED after ");
    expect(reply).toContain("300 tool calls: tool-call limit of 300 reached.");
    expect(reply).not.toContain("Returned");
    expect(f.requests.slice(before).filter(r => r.path === "/player")).toHaveLength(300);
  });

  test("cancelling the call stops the run", async () => {
    const path = await commons();
    const f = await resident(path);
    const controller = new AbortController();
    await f.tools.call("skill_save", { name: "long_wait", description: "Waits a long time; used to test cancelling.", code: "await body.say({ text: 'waiting' });\nawait body.wait({ seconds: 100 });\nawait body.say({ text: 'after' });" });
    const running = f.tools.call("skill_run", { name: "long_wait" }, controller.signal);
    await until(() => f.requests.some(r => r.body.text === "waiting"), "the skill to start waiting");
    controller.abort();
    const reply = text(await running);
    // The cancel may land before or after the code has asked for its wait.
    expect(reply).toMatch(/^Skill long_wait v1 STOPPED after \d+(\.\d)? s, [12] tool calls?: the call was cancelled\.\n/);
    expect(f.requests.some(r => r.body.text === "after")).toBe(false);
    expect(rows(path, "SELECT ok, error FROM skill_runs")).toEqual([{ ok: 0, error: "the call was cancelled" }]);
  });

  test("dying during a run stops it and says where", async () => {
    const f = await resident(await commons());
    await f.tools.call("skill_save", { name: "long_wait", description: "Waits a long time; used to test dying.", code: "await body.say({ text: 'waiting' });\nawait sleep(60000);\nawait body.say({ text: 'after' });" });
    await f.body.poll();
    const running = f.tools.call("skill_run", { name: "long_wait" });
    await until(() => f.requests.some(r => r.body.text === "waiting"), "the skill to start");
    f.state.health = 0; f.state.inventory!.main = []; f.state.hotbar = [];
    await f.body.poll();
    const result = await running;
    expect(text(result)).toMatch(/^Skill long_wait v1 STOPPED after \d+(\.\d)? s, 1 tool call: you died at 0,64,0 in minecraft:overworld\.\n/);
    expect(text(result)).toContain("Inventory changes: -6 minecraft:oak_planks.");
    expect(f.requests.some(r => r.body.text === "after")).toBe(false);
    expect(text(await f.tools.call("skill_run", { name: "long_wait" }))).toBe("Error: You are dead; respawn before running a skill.");
  });

  test("a rescue that starts during a run stops it before the skill's next action can interrupt the rescue", async () => {
    const f = await resident(await commons());
    await f.tools.call("skill_save", { name: "clicker", description: "Selects hotbar slots forever; used to test rescues.", code: "await body.say({ text: 'started' });\nwhile (true) { await sleep(20); await body.select_hotbar({ slot: 3 }); }" });
    await f.body.poll();
    const running = f.tools.call("skill_run", { name: "clicker" });
    await until(() => f.requests.some(r => r.body.text === "started"), "the skill to start");
    f.state.inLava = true;
    await f.body.poll();
    const reply = text(await running);
    expect(reply).toMatch(/STOPPED after \d+(\.\d)? s, \d+ tool calls?: a reflex took over your body \(lava rescue started: in lava\)\.\n/);
    // The rescue is still the one moving him: no manual action of the skill ended it.
    expect(f.body.rescuing).toBe("lava");
    expect(text(await f.tools.call("skill_run", { name: "clicker" }))).toBe("Error: A lava rescue is moving your body; run the skill when it has ended.");
  });

  test("an uncaught body tool error stops the run and names the tool; a caught one does not", async () => {
    const f = await resident(await commons());
    f.setScreen({ screen: "CraftingScreen" });
    const uncaught = await runCode(f, "log('about to open');\nawait body.open_inventory();\nreturn 'opened';");
    expect(uncaught.result.isError).toBe(true);
    expect(uncaught.reply).toContain("1 tool call: open_inventory failed and the code did not catch it: Close CraftingScreen before opening your inventory.");
    expect(uncaught.reply).toContain("Screen open now: CraftingScreen.");
    const caught = await runCode(f, "try { await body.open_inventory(); } catch (error) { return 'caught ' + error.tool + ': ' + error.message; }", {}, "careful");
    expect(caught.result.isError).toBe(false);
    expect(caught.reply).toContain("Returned: caught open_inventory: Close CraftingScreen before opening your inventory.");
    const thrown = await runCode(f, "const plan = null;\n\nreturn plan.steps;", {}, "broken");
    expect(thrown.reply).toContain("0 tool calls: TypeError (line 3): cannot read property 'steps' of null.");
  });

  test("wait inside a skill returns the events since the run's last wait, so two trips in a row both wait", async () => {
    const f = await resident(await commons());
    await f.body.poll();
    const running = runCode(f, "await body.go_to({ x: 1, z: 1 });\nconst first = await body.wait({ seconds: 20, for: ['arrived'] });\nconst second = await body.wait({ seconds: 1, for: ['arrived'] });\nreturn first + ' / ' + second;");
    await until(() => f.requests.some(r => r.body.text === "#goto 1 1"), "the trip to start");
    f.tick(500);
    await f.body.poll();
    const { result, reply } = await running;
    expect(result.isError).toBe(false);
    expect(reply).toMatch(/Returned: Waking event received\. \d+ arrived goal=goto 1 1 \/ Time is up\./);
    // The resident still gets the event in the tail of the skill_run result.
    expect(result.content.at(-1)).toMatchObject({ text: expect.stringMatching(/Since last time:\n\d+ arrived goal=goto 1 1/) });
  });

  test("skills call other skills two levels deep, share one tool-call budget, and go no deeper", async () => {
    const path = await commons();
    const f = await resident(path);
    const nest = (name: string, inner: string) => f.tools.call("skill_save", { name, description: `Runs ${inner} and reports what it said.`, code: `return '${name}>' + (await body.skill_run({ name: '${inner}' })).split('\\n').find(line => line.startsWith('Returned')) ;` });
    await f.tools.call("skill_save", { name: "level_three", description: "The innermost skill: selects a hotbar slot.", code: "await body.select_hotbar({ slot: 4 });\nreturn 'bottom';" });
    await nest("level_two", "level_three"); await nest("level_one", "level_two"); await nest("level_zero", "level_one");
    const allowed = await f.tools.call("skill_run", { name: "level_one" });
    expect(text(allowed)).toContain("Skill level_one v1 finished in ");
    expect(text(allowed)).toContain("3 tool calls.");
    expect(text(allowed)).toContain("Returned: level_one>Returned: level_two>Returned: bottom");
    expect(f.state.selectedSlot).toBe(4);
    const tooDeep = await f.tools.call("skill_run", { name: "level_zero" });
    expect(tooDeep.isError).toBe(true);
    expect(text(tooDeep)).toStartWith("Skill level_zero v1 STOPPED after ");
    expect(text(tooDeep)).toContain("3 tool calls: level_one stopped: level_two stopped: Skills can call other skills only 2 levels deep; level_three was not run.\n");
    expect(rows(path, "SELECT s.name, COUNT(*) AS runs FROM skill_runs r JOIN skills s ON s.id = r.skill_id GROUP BY s.name ORDER BY s.name")).toEqual([
      { name: "level_one", runs: 2 }, { name: "level_three", runs: 1 }, { name: "level_two", runs: 2 }, { name: "level_zero", runs: 1 },
    ]);
  });

  test("a long log is cut from the old end and the reply stays within 1,200 characters", async () => {
    const f = await resident(await commons());
    const { reply } = await runCode(f, `for (let i = 1; i <= 60; i++) log('step ' + i + ' ${"x".repeat(150)}');\nreturn 'done';`);
    expect(reply.length).toBeLessThanOrEqual(1200);
    expect(reply).toContain("of 60):\n");
    expect(reply).toContain("step 60 x");
    expect(reply).not.toContain("step 1 x");

    // Everything long at once: the outcome, the check and what the code returned all survive; the log gives way.
    await f.tools.call("skill_save", {
      name: "wordy", description: "Fails a long check and returns a long answer.", code: `for (let i = 1; i <= 30; i++) log('step ' + i + ' ${"x".repeat(150)}');\nreturn '${"r".repeat(900)}';`,
      expect: { gain: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`mekanism:very_long_modded_material_stack_${i}`, 64])) },
    });
    const wordy = text(await f.tools.call("skill_run", { name: "wordy" }));
    expect(wordy.length).toBeLessThanOrEqual(1200);
    expect(wordy).toStartWith("Skill wordy v1 finished in ");
    expect(wordy).toContain("\nCheck FAILED: mekanism:very_long_modded_material_stack_0 changed by +0, needs +64 or more; ");
    expect(wordy).toMatch(/\nReturned: r{100,}…\n/);
    expect(wordy).toContain("wordy is still a draft");
  });
});

describe("what skill code can reach", () => {
  test("when the interpreter cannot start, saving and running are refused in one line and no code runs", async () => {
    const path = await commons();
    const f = await resident(path);
    await f.tools.call("skill_save", { name: "announce", description: "Says one line in chat.", code: "await body.say({ text: 'ran anyway' });" });
    f.tools.skills.interpreter = join(f.dir, "no-such-interpreter.ts");
    const run = await f.tools.call("skill_run", { name: "announce" });
    expect(run.isError).toBe(true);
    expect(text(run)).toMatch(/^Error: Skills cannot run: the isolated interpreter is unavailable \([^\n]+\)\. Nothing was run\.$/);
    const save = await f.tools.call("skill_save", { name: "second", description: "Says another line in chat.", code: "await body.say({ text: 'second' });" });
    expect(text(save)).toMatch(/^Error: Skills cannot be checked or run: the isolated interpreter is unavailable \([^\n]+\)\. Nothing was saved\.$/);
    expect(f.requests.filter(r => r.path === "/chat")).toEqual([]);
    expect(rows(path, "SELECT name FROM skills")).toEqual([{ name: "announce" }]);
    expect(rows(path, "SELECT * FROM skill_runs")).toEqual([]);
    expect(text(await f.tools.call("status"))).toContain("Health 20/20");
  });

  // Each attempt must end as a reported failure of that run, with the tool server answering afterwards.
  const attempts: [string, string, string][] = [
    ["require", "const fs = require('fs');\nreturn fs.readFileSync('/etc/passwd', 'utf8');", "ReferenceError (line 1): 'require' is not defined."],
    ["dynamic import", "const fs = await import('node:fs');\nreturn fs.readFileSync('/etc/passwd', 'utf8');", "ReferenceError: could not load module 'node:fs'."],
    ["fetch", "return await (await fetch('http://127.0.0.1')).text();", "ReferenceError (line 1): 'fetch' is not defined."],
    ["process.env", "return JSON.stringify(process.env);", "ReferenceError (line 1): 'process' is not defined."],
    ["Bun.file", "return await Bun.file('/etc/passwd').text();", "ReferenceError (line 1): 'Bun' is not defined."],
    ["the Function constructor", "return globalThis.constructor.constructor('return process')().env.HOME;", "ReferenceError (line 1): 'process' is not defined."],
    ["the bridge functions' constructors", "return body.status.constructor.constructor('return Bun')().env.HOME;", "ReferenceError (line 1): 'Bun' is not defined."],
    ["a 1 GB allocation", "const big = new Uint8Array(1024 * 1024 * 1024);\nreturn big.length;", "InternalError (line 1): out of memory; a skill may use 64 MB."],
    ["memory taken piece by piece", "const kept = [];\nwhile (true) kept.push(new Uint8Array(1024 * 1024));", "InternalError (line 2): out of memory; a skill may use 64 MB."],
  ];
  for (const [what, code, failure] of attempts) {
    test(`${what} fails inside the run and nothing else`, async () => {
      const path = await commons();
      const f = await resident(path);
      const { result, reply } = await runCode(f, code);
      expect(result.isError).toBe(true);
      expect(reply).toMatch(/^Skill probe v1 STOPPED after \d+(\.\d)? s, 0 tool calls: /);
      expect(reply).toContain(`0 tool calls: ${failure}\n`);
      expect(reply).not.toContain("root:");
      expect(text(await f.tools.call("status"))).toContain("Health 20/20");
      expect(rows(path, "SELECT ok FROM skill_runs")).toEqual([{ ok: 0 }]);
    });
  }

  test("an endless loop that also swallows errors is ended at the time limit", async () => {
    const f = await resident(await commons());
    const { reply } = await runCode(f, "while (true) { try { while (true) {} } catch (error) {} }", { max_seconds: 1 });
    expect(reply).toMatch(/^Skill probe v1 STOPPED after 1(\.\d)? s, 0 tool calls: time limit of 1 s reached while the code was still running\.\n/);
    expect(text(await f.tools.call("status"))).toContain("Health 20/20");
  });

  test("nothing of the host is reachable through the objects a skill is given", async () => {
    const f = await resident(await commons());
    // Every object handed to the skill, and everything on their prototype chains, belongs to the
    // interpreter: its Function constructor sees the interpreter's globals and none of the host's.
    const { result, reply } = await runCode(f, `
      const given = { body, state, args, log, sleep, tool: body.status, reply: body.status(), snapshot: await state() };
      const seen = new Set();
      for (const [name, value] of Object.entries(given)) {
        for (let link = value; link !== null && link !== undefined; link = Object.getPrototypeOf(link)) {
          const make = link.constructor && link.constructor.constructor;
          if (typeof make !== "function") continue;
          const scope = make("return this")();
          seen.add(scope === globalThis ? "own globals" : name + " leaked another scope");
          seen.add(make("return [typeof process, typeof Bun, typeof require, typeof fetch, typeof setTimeout, typeof postMessage].join()")());
        }
      }
      return [...seen].join(" | ") + " | " + Object.getOwnPropertyNames(globalThis).filter(name => /call|readState|logLine|sleepMs|done|bridge|host/i.test(name)).join();`, { args: { any: 1 } });
    expect(result.isError).toBe(false);
    expect(reply).toEndWith("Returned: own globals | undefined,undefined,undefined,undefined,undefined,undefined |");
  });

  test("skill code cannot save skills, speak for the resident to the others or read pictures, and may say only five lines", async () => {
    const path = await commons();
    const f = await resident(path);
    const { result, reply } = await runCode(f, `
      const refused = [];
      for (const tool of ["skill_save", "note_share", "feedback", "picture"]) {
        try { await body[tool]({ name: "probe", description: "Rewritten by itself.", code: "return 1;", topic: "self", text: "curated by myself", skill: "probe", worked: true }); refused.push(tool + " WORKED"); }
        catch (error) { refused.push(error.tool + ": " + error.message); }
      }
      let said = 0;
      try { for (let i = 0; i < 9; i++) { await body.say({ text: "line " + i }); said++; } } catch (error) { refused.push(said + " said, then: " + error.message); }
      return refused.join(" / ");`);
    expect(result.isError).toBe(false);
    expect(reply).toContain([
      "Returned: skill_save: skill_save cannot be called from skill code; save skills yourself.",
      "note_share: note_share cannot be called from skill code; share notes yourself.",
      "feedback: feedback cannot be called from skill code; give feedback yourself.",
      "picture: picture returns an image, which skill code cannot read; use state() or screen.",
      "5 said, then: A skill run may send at most 5 chat messages.",
    ].join(" / "));
    expect(f.requests.filter(r => r.path === "/chat")).toHaveLength(5);
    expect(rows(path, "SELECT name, code, status, version FROM skills")).toEqual([{ name: "probe", code: expect.stringContaining("const refused"), status: "draft", version: 1 }]);
    expect(rows(path, "SELECT * FROM shared_notes")).toEqual([]);
    expect(rows(path, "SELECT * FROM feedback")).toEqual([]);
  });

  test("skill code can branch on rich state and use the resident's notes, places and shared notes", async () => {
    const path = await commons();
    const f = await resident(path);
    await writeFile(join(f.dir, "memory.md"), "Coal is in the cliff north of home.\n");
    await f.tools.call("note_share", { topic: "cows", text: "Cows follow wheat held in the hand." });
    f.state.nearbyEntities = [
      { id: 2, type: mc("zombie"), pos: [10, 64, 0], distance: 10, hostile: true },
      { id: 1, type: mc("cow"), pos: [3, 64, 4], distance: 5 },
      { id: 3, type: mc("player"), name: "Margo", pos: [20, 64, 0], distance: 20, player: true },
    ];
    f.state.lookingAt = { type: "block", block: mc("crafting_table"), blockPos: [1, 64, 0] };
    const { result, reply } = await runCode(f, `
      const now = await state();
      const cow = now.nearby.find(entity => entity.type === "minecraft:cow");
      await body.place_save({ name: "cow field", x: cow.x, y: cow.y, z: cow.z });
      log(await body.place_find({ query: "cow" }));
      log(await body.recall({ query: "coal" }));
      log(await body.notes_shared({ query: "wheat" }));
      return JSON.stringify([now.held, now.selectedSlot, now.hotbar, now.inventory["minecraft:oak_planks"], now.pos, now.health, now.food, now.screen, now.lookingAt.block,
        now.nearby.map(e => [e.type, e.name ?? "unnamed", e.distance, e.hostile, e.player].join(" ")), now.inLava, now.navigation]);`);
    expect(result.isError).toBe(false);
    expect(JSON.parse(/Returned: (.*)/.exec(reply)![1]!)).toEqual([
      mc("oak_planks"), 0, [{ slot: 0, item: mc("oak_planks"), count: 6 }], 6, { x: 0, y: 64, z: 0 }, 20, 20, "none", mc("crafting_table"),
      ["minecraft:cow unnamed 5 false false", "minecraft:zombie unnamed 10 true false", "minecraft:player Margo 20 false true"], false, null,
    ]);
    expect(reply).toContain("cow field");
    expect(reply).toContain("memory.md:1 Coal is in the cliff north of home.");
    expect(reply).toContain("#1 [yours, waiting for review; others cannot see it] cows: Cows follow wheat held in the hand.");
    expect(text(await f.tools.call("place_find", { query: "cow" }))).toContain("cow field");
  });
});

describe("drafts, edits and reviews", () => {
  test("changing the code returns a verified skill to draft and hides it again; a new description alone does not", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    await gary.tools.call("skill_save", sticks);
    await gary.tools.call("skill_run", { name: "make_sticks" });
    expect(text(await margo.tools.call("skill_find", {}))).toContain("make_sticks | verified, not yet reviewed | by Gary");

    const described = text(await gary.tools.call("skill_save", { ...sticks, description: "Crafts 4 sticks from 2 oak planks held in hotbar slot 0." }));
    expect(described).toBe("Updated the description and args of make_sticks v1; code and check are unchanged, so it stays verified.");
    expect(text(await margo.tools.call("skill_find", {}))).toContain("| by Gary | Crafts 4 sticks from 2 oak planks held in hotbar slot 0. |");

    const edited = text(await gary.tools.call("skill_save", { ...sticks, code: `${makeSticks}\n// tidied` }));
    expect(edited).toBe("Saved make_sticks v2. Code or check changed, so it is a draft again (it was verified); only you can see and run it. Run it with skill_run make_sticks: a run that passes its check makes it verified.");
    expect(text(await margo.tools.call("skill_find", {}))).toBe("No skills yet. Save a routine that worked with skill_save.");
    expect(text(await margo.tools.call("skill_run", { name: "make_sticks" }))).toStartWith("Error: make_sticks is a draft by Gary");
    // The record shown is the new version's: the old runs do not vouch for the new code.
    expect(text(await gary.tools.call("skill_find", {}))).toContain("make_sticks | draft (only you see it) | by you | Crafts 4 sticks from 2 oak planks in hotbar slot 0, no screen needed. | args: none | check passed in 0 of 0 runs");
    give(gary, mc("oak_planks"), 6);
    expect(text(await gary.tools.call("skill_run", { name: "make_sticks" }))).toContain("Skill make_sticks v2 finished");
    expect(rows(path, "SELECT status, version FROM skills")).toEqual([{ status: "verified", version: 2 }]);

    const loosened = text(await gary.tools.call("skill_save", { ...sticks, code: `${makeSticks}\n// tidied`, expect: { screen: "none" } }));
    expect(loosened).toStartWith("Saved make_sticks v3. Code or check changed, so it is a draft again (it was verified)");
  });

  test("a rejected skill disappears for others and cannot be run; its author sees the reviewer's reason", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    await gary.tools.call("skill_save", sticks);
    await gary.tools.call("skill_run", { name: "make_sticks" });
    review(path, "skills", "make_sticks", "rejected", "Assumes planks in slot 0;\nuse craft instead.");
    expect(text(await margo.tools.call("skill_find", {}))).toBe("No skills yet. Save a routine that worked with skill_save.");
    expect(text(await margo.tools.call("skill_show", { name: "make_sticks" }))).toStartWith("Error: No skill named make_sticks that you can see.");
    expect(text(await margo.tools.call("skill_run", { name: "make_sticks" }))).toBe("Error: make_sticks was rejected by caretaker: Assumes planks in slot 0; use craft instead.; it cannot be run.");
    expect(text(await gary.tools.call("skill_find", {}))).toContain("make_sticks | rejected by caretaker: Assumes planks in slot 0; use craft instead. | by you |");
    expect(text(await gary.tools.call("skill_run", { name: "make_sticks" }))).toBe("Error: make_sticks was rejected by caretaker: Assumes planks in slot 0; use craft instead.; it cannot be run. Change its code with skill_save to make a new draft.");
    expect(text(await gary.tools.call("skill_show", { name: "make_sticks" }))).toContain("Review by caretaker: reject, Assumes planks in slot 0; use craft instead.");
  });

  test("skill_find puts curated skills first, then the ones more residents use", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    for (const name of ["alpha_look", "beta_look", "gamma_look"]) {
      await gary.tools.call("skill_save", { name, description: `Looks up (${name}).`, code: "await body.look({ pitch: -90 });", expect: { screen: "none" } });
      await gary.tools.call("skill_run", { name });
    }
    await margo.tools.call("skill_run", { name: "beta_look" });
    review(path, "skills", "gamma_look", "curated", "Useful.");
    await margo.tools.call("skill_save", { name: "delta_look", description: "Looks down (delta_look).", code: "await body.look({ pitch: 90 });" });
    const listed = text(await margo.tools.call("skill_find", { query: "look" })).split("\n");
    expect(listed[0]).toBe('4 skills for "look". skill_show gives details, skill_run runs one.');
    expect(listed.slice(1).map(line => line.split(" | ").slice(0, 3).join(" | "))).toEqual([
      "gamma_look | curated | by Gary",
      "beta_look | verified, not yet reviewed | by Gary",
      "alpha_look | verified, not yet reviewed | by Gary",
      "delta_look | draft (only you see it) | by you",
    ]);
    expect(listed[2]).toEndWith("check passed in 2 of 2 runs | used by 1 other resident | no feedback yet");
    expect(listed[4]).toEndWith("finished 0 of 0 runs, no check | used by 0 other residents | no feedback yet");
    const limited = text(await margo.tools.call("skill_find", { limit: 2 })).split("\n");
    expect(limited).toHaveLength(4);
    expect(limited[3]).toBe("2 more not shown; use a narrower query or a higher limit.");
    expect(text(await margo.tools.call("skill_find", { query: "furnace" }))).toBe('No skills match "furnace". 4 skills in all; skill_find without a query lists them.');
  });

  test("skill_show gives the check, the record and the code, and continues long code from a line", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    const long = Array.from({ length: 60 }, (_, i) => `log("step ${i + 1} of a long routine that says what it is doing");`).join("\n");
    await gary.tools.call("skill_save", { name: "long_routine", description: "Logs sixty steps.", code: long, params: { speed: "ticks to hold", target: "block id to find" }, expect: { gain: { "minecraft:stick": 4 }, near: { x: 10, y: 64, z: -5, within: 3 } } });
    await gary.tools.call("skill_run", { name: "long_routine" });
    const shown = text(await gary.tools.call("skill_show", { name: "long_routine" }));
    expect(shown).toStartWith([
      "long_routine v1 | draft (only you see it) | by you",
      "Logs sixty steps.",
      "Args: speed = ticks to hold; target = block id to find",
      "Check: gain 4 minecraft:stick; end within 3 blocks of 10,64,-5",
      "Record of v1: check passed in 0 of 1 run | used by 0 other residents | no feedback yet",
    ].join("\n"));
    expect(shown).toMatch(/Latest runs: Gary v1 check failed \d+(\.\d)? s\nCode, lines 1-(\d+) of 60:\nlog\("step 1 of/);
    const cut = Number(/Code cut after line (\d+); skill_show with from_line (\d+) continues\.$/.exec(shown)![1]);
    expect(cut).toBeGreaterThan(5);
    expect(shown.length).toBeLessThanOrEqual(1200);
    const rest = text(await gary.tools.call("skill_show", { name: "long_routine", from_line: cut + 1 }));
    expect(rest).toStartWith(`long_routine v1 | draft (only you see it) | by you\nCode, lines ${cut + 1}-`);
    expect(rest).toContain(`\nlog("step ${cut + 1} of a long routine`);
    expect(rest).not.toContain(`log("step ${cut} of`);
    expect(text(await margo.tools.call("skill_show", { name: "long_routine" }))).toStartWith("Error: No skill named long_routine that you can see.");
  });
});

describe("shared notes", () => {
  test("a proposed note reaches the other resident only once a reviewer has curated it", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    const note = { topic: "furnace fuel", text: "One coal smelts eight items; one plank smelts 1.5. Keep coal for torches when wood is near." };
    const proposed = text(await gary.tools.call("note_share", note));
    expect(proposed).toBe('Proposed note #1 "furnace fuel". The other residents see it once it is accepted, usually within a minute; a caretaker may later edit or remove it. notes_shared shows its status.');
    expect(text(await gary.tools.call("note_share", note))).toBe("You already proposed this note (#1, proposed); nothing was added.");
    expect(text(await gary.tools.call("notes_shared", { query: "coal" }))).toBe(`1 shared note for "coal".\n#1 [yours, waiting for review; others cannot see it] furnace fuel: ${note.text}`);
    expect(text(await margo.tools.call("notes_shared", {}))).toBe("No shared notes yet. note_share proposes one.");
    expect(text(await margo.tools.call("notes_shared", { query: "coal" }))).toBe("No shared notes yet. note_share proposes one.");

    review(path, "shared_notes", "furnace fuel", "curated");
    expect(text(await margo.tools.call("notes_shared", { query: "coal torches" }))).toBe(`1 shared note for "coal torches".\n#1 [curated, by Gary | no feedback yet] furnace fuel: ${note.text}`);
    expect(text(await gary.tools.call("notes_shared", {}))).toBe(`1 shared note.\n#1 [curated, by you | no feedback yet] furnace fuel: ${note.text}`);

    await margo.tools.call("note_share", { topic: "crafting tables", text: "Crafting tables are broken everywhere in this world." });
    review(path, "shared_notes", "crafting tables", "rejected", "Not true: look at the table, then use.");
    expect(text(await gary.tools.call("notes_shared", { query: "crafting" }))).toBe('No shared notes match "crafting". 1 note in all; notes_shared without a query lists the newest.');
    expect(text(await margo.tools.call("notes_shared", { query: "crafting" }))).toBe('1 shared note for "crafting".\n#2 [yours, rejected by caretaker: Not true: look at the table, then use.; others cannot see it] crafting tables: Crafting tables are broken everywhere in this world.');
    const tooLong = await gary.tools.call("note_share", { topic: "too long", text: "x".repeat(601) });
    expect(tooLong.isError).toBe(true);
    expect(text(tooLong)).toContain("text: String must contain at most 600 character(s)");
  });
});

describe("feedback", () => {
  test("a resident's verdict on another's skill is stored, replaced when it changes and shown to both; the author's own is not counted", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    await gary.tools.call("skill_save", sticks);
    await gary.tools.call("skill_run", { name: "make_sticks" });
    await margo.tools.call("skill_run", { name: "make_sticks" });

    const first = await margo.tools.call("feedback", { skill: "make_sticks", worked: false, text: "My planks were in slot 3, it clicked an empty slot." });
    expect(text(first)).toBe("Recorded: make_sticks v1 did not work for you.");
    expect(rows(path, "SELECT kind, resident, worked, text, version FROM feedback")).toEqual([{ kind: "skill", resident: "Margo", worked: 0, text: "My planks were in slot 3, it clicked an empty slot.", version: 1 }]);
    // A third figure beside the check record and the use count, the same for both residents.
    for (const f of [gary, margo]) expect(text(await f.tools.call("skill_find", {}))).toEndWith("check passed in 2 of 2 runs | used by 1 other resident | worked for 0, not for 1");
    expect(text(await gary.tools.call("skill_show", { name: "make_sticks" }))).toContain("\nMargo: did not work for me, My planks were in slot 3, it clicked an empty slot.\n");

    const changed = await margo.tools.call("feedback", { skill: "make_sticks", worked: true });
    expect(text(changed)).toBe("Recorded: make_sticks v1 worked for you. This replaces your earlier verdict (did not work).");
    expect(rows(path, "SELECT resident, worked, text FROM feedback")).toEqual([{ resident: "Margo", worked: 1, text: "" }]);

    const own = await gary.tools.call("feedback", { skill: "make_sticks", worked: false, text: "Mine." });
    expect(text(own)).toBe("Recorded: make_sticks v1 did not work for you. It is your own, so it is not counted in what the others see.");
    for (const f of [gary, margo]) {
      expect(text(await f.tools.call("skill_find", {}))).toEndWith("| worked for 1, not for 0");
      expect(text(await f.tools.call("skill_show", { name: "make_sticks" }))).toContain("Record of v1: check passed in 2 of 2 runs | used by 1 other resident | worked for 1, not for 0\n");
    }
    expect(text(await gary.tools.call("skill_show", { name: "make_sticks" }))).not.toContain("Gary: did not work");
  });

  test("feedback on a curated note shows beside it; a note or skill the resident cannot see takes none", async () => {
    const path = await commons();
    const gary = await resident(path), margo = await resident(path, "Margo");
    await gary.tools.call("note_share", { topic: "furnace fuel", text: "One coal smelts eight items." });
    await gary.tools.call("skill_save", sticks);
    const hiddenNote = await margo.tools.call("feedback", { note: 1, worked: true });
    expect(text(hiddenNote)).toBe("Error: No shared note #1 that you can see; no feedback was recorded. notes_shared gives the numbers.");
    expect(text(await margo.tools.call("feedback", { skill: "make_sticks", worked: true }))).toBe("Error: No skill named make_sticks that you can see; no feedback was recorded.");
    expect(text(await margo.tools.call("feedback", { skill: "make_sticks", note: 1, worked: true }))).toStartWith("Error: input: Give either skill (a name) or note (a number), not both.");
    expect(rows(path, "SELECT * FROM feedback")).toEqual([]);

    review(path, "shared_notes", "furnace fuel", "curated");
    expect(text(await margo.tools.call("feedback", { note: 1, worked: true, text: "Smelted a stack of iron with eight coal." }))).toBe('Recorded: note #1 "furnace fuel" worked for you.');
    await gary.tools.call("feedback", { note: 1, worked: true });
    for (const f of [gary, margo]) expect(text(await f.tools.call("notes_shared", {}))).toContain("| worked for 1, not for 0] furnace fuel: One coal smelts eight items.");
    expect(rows(path, "SELECT resident, worked, version FROM feedback ORDER BY resident")).toEqual([{ resident: "Gary", worked: 1, version: null }, { resident: "Margo", worked: 1, version: null }]);
  });
});
