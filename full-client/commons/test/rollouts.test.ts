import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { callsInScript, compactArgs, RolloutTail, splitResult } from "../src/rollouts.ts";
import { fixture, reply, rollout, tempHome, type Home } from "./helpers.ts";

let home: Home;
const T = Date.parse("2026-11-21T15:00:00Z");
const residents = () => [{ name: "Gary", dir: join(home.dir, "resident", "gary") }, { name: "Margo", dir: join(home.dir, "resident", "margo") }];
const tailer = (now = T + 60_000) => new RolloutTail(join(home.dir, "sessions"), residents(), { now: () => now });
const session = (name: string, lines: string[]) => home.put(`sessions/2026/11/21/${name}.jsonl`, lines.join("\n") + "\n");

beforeEach(() => { home = tempHome(); });
afterEach(() => home.remove());

test("the real sample session is read as Margo's, each tool call once, with its events, remarks and tokens", async () => {
  home.put("sessions/2026/11/21/rollout-sample.jsonl", fixture("rollout-sample.jsonl"));
  const tail = tailer(Date.parse("2026-11-21T15:15:00Z"));
  await tail.refresh();

  expect(tail.recent({ resident: "Gary" })).toEqual([]);
  const entries = tail.recent({ resident: "Margo" });
  const calls = entries.filter(entry => entry.kind === "call").map(entry => `${entry.tool} ${entry.args}`.trim());
  // Newest first. The script, its MCP item and its output all describe the same call: it must appear once.
  expect(calls).toEqual([
    "wait seconds=45 for=[arrived,stopped_short,navigation_stopped,hurt,died,player_near]",
    "go_to x=60 y=66 z=-99", "place_find", "inventory", "status",
  ]);
  const goTo = entries.find(entry => entry.tool === "go_to")!;
  expect(goTo.result).toBe("Started #goto 60 66 -99.");
  // Timed by the finished MCP item, which also carries how long the call took.
  expect(goTo.t).toBe(Date.parse("2026-11-21T15:14:19.521Z"));
  expect(goTo.ms).toBeGreaterThan(0);
  expect(entries.find(entry => entry.tool === "status")!.quiet).toBe(true);

  const stopped = entries.find(entry => entry.type === "navigation_stopped")!;
  expect(stopped.text).toBe("goal=goto 60 66 -99 reason=the path led into deep water you=60,61,-100 remaining=4.4");
  expect(stopped.quiet).toBe(false);
  expect(entries.filter(entry => entry.type === "reflex").length).toBe(7);
  expect(entries.find(entry => entry.type === "baritone")!.quiet).toBe(true);

  const remarks = entries.filter(entry => entry.kind === "remark").map(entry => entry.text);
  expect(remarks[1]).toBe("I’ll read the notes and basics first, then check my status and see what the world is doing.");
  expect(remarks[0]).toStartWith("I’m at the water near the stone building");
  expect(entries.find(entry => entry.kind === "prompt")!.text).toStartWith("It is 10:14. Play until 11:14.");

  const totals = tail.tokenTotals("Margo");
  expect(totals.session!.tokens).toEqual({ input: 243576, cached: 204800, output: 714, reasoning: 163, total: 244290 });
  expect(totals.session!.model).toBe("gpt-6-luna");
  expect(totals.day.total).toBe(244290);
  expect(tail.quota).toMatchObject({ usedPercent: 9, windowMinutes: 10080, resetsAt: 1795617379000, plan: "pro" });

  const signs = tail.indicators("Margo");
  expect(signs).toMatchObject({ calls: 5, navigationStopped: 1, stoppedShort: 0, arrived: 0, deaths: 0, reflexes: 7, hurt: 2, errors: 0 });
  expect(signs.byTool[0]).toEqual({ tool: "go_to", count: 1 });
});

test("a growing file is read once: only new whole lines, never the bytes already read", async () => {
  const lines = [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    ...rollout.call(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2.\n\nSince last time:\nnone"),
    ...rollout.call(T + 2000, "mine", { block: "oak_log", count: 4 }, "Started mining.\n\nSince last time:\n1 arrived goal=goto 1 2"),
  ];
  const whole = lines.join("\n") + "\n";
  // Stop in the middle of the item line of the second call, as a reader racing the writer would see it.
  const cut = whole.indexOf('"tool":"mine"') + 5;
  const path = home.put("sessions/2026/11/21/a.jsonl", whole.slice(0, cut));
  const tail = tailer();
  await tail.refresh();
  expect(tail.recent().map(entry => entry.tool)).toEqual(["go_to"]);

  // Deface what was already read (same length, so nothing else moves), then let the writer finish.
  const file = openSync(path, "r+");
  writeSync(file, "XXXXX", whole.indexOf('"tool":"go_to"') + 8);
  closeSync(file);
  appendFileSync(path, whole.slice(cut));
  await tail.refresh();
  await tail.refresh();
  const entries = tail.recent();
  // An event reported by a call's result sorts just after that call, so newest-first shows it above.
  expect(entries.map(entry => entry.kind === "event" ? `event ${entry.type}` : entry.tool)).toEqual(["event arrived", "mine", "go_to"]);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
  expect(entries[1].args).toBe("block=oak_log count=4");
});

test("sessions are told apart by the directory they ran in; other sessions are ignored", async () => {
  session("gary", [rollout.meta(T, join(home.dir, "resident", "gary")), ...rollout.call(T + 1000, "eat", {}, "Ate bread.")]);
  // Copied from the game machine, the path differs but still ends in the resident's directory.
  session("margo", [rollout.meta(T, "/home/someone/gary-client/resident/margo/"), ...rollout.call(T + 2000, "craft", { item: "stick" }, "Crafted 4 stick.")]);
  session("caretaker", [rollout.meta(T, join(home.dir, "overseer", "empty")), ...rollout.call(T + 3000, "say", { text: "not a resident" }, "Sent.")]);
  session("garybaldi", [rollout.meta(T, join(home.dir, "resident", "garybaldi")), ...rollout.call(T + 3000, "say", { text: "nor me" }, "Sent.")]);
  const tail = tailer();
  await tail.refresh();
  expect(tail.recent({ resident: "Gary" }).map(entry => entry.tool)).toEqual(["eat"]);
  expect(tail.recent({ resident: "Margo" }).map(entry => entry.tool)).toEqual(["craft"]);
  expect(tail.recent().map(entry => `${entry.resident} ${entry.tool}`)).toEqual(["Margo craft", "Gary eat"]);
});

test("reasoning summaries become the resident's thoughts once they are switched on; empty ones leave nothing", async () => {
  const at = (t: number, type: string, payload: object) => JSON.stringify({ timestamp: new Date(t).toISOString(), type, payload });
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    // Today: summaries are off, the arrays are empty.
    at(T + 1000, "response_item", { type: "reasoning", summary: [], content: null, encrypted_content: "gAAAA" }),
    at(T + 1000, "event_msg", { type: "item_completed", item: { type: "Reasoning", id: "rs_1", summary_text: [], raw_content: [] } }),
    // Switched on: the same summary arrives as a response item and as a finished item.
    at(T + 2000, "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "The stream is north." }, { type: "summary_text", text: "Wheat needs water." }], encrypted_content: "gAAAA" }),
    at(T + 2001, "event_msg", { type: "item_completed", item: { type: "Reasoning", id: "rs_2", summary_text: ["The stream is north.", "Wheat needs water."], raw_content: [] } }),
    rollout.remark(T + 3000, "Heading to the stream."),
  ]);
  const tail = tailer();
  await tail.refresh();
  expect(tail.recent().map(entry => `${entry.kind}: ${entry.text}`)).toEqual([
    "remark: Heading to the stream.",
    "thought: The stream is north.\nWheat needs water.",
  ]);
});

test("a line that is not JSON is skipped and the lines after it still count", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    '{"timestamp":"2026-11-21T15:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_te',
    "not json at all",
    rollout.remark(T + 2000, "Still here."),
  ]);
  const tail = tailer();
  await tail.refresh();
  expect(tail.recent().map(entry => entry.text)).toEqual(["Still here."]);
});

test("what the resident said, tool errors, and events are separate, labelled entries", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    ...rollout.call(T + 1000, "say", { text: "hello Margo, are you near the cabin?" }, "Sent.\n\nSince last time:\n12 chat from=Margo text=hello\n13 died at=1,64,2 dimension=minecraft:overworld text=what you carried dropped there"),
    ...rollout.call(T + 2000, "status", {}, "Error: Synapse unreachable (client stopped or request timed out).", { isError: true }),
  ]);
  const tail = tailer();
  await tail.refresh();
  const [status, died, chat, said] = tail.recent();
  expect(said).toMatchObject({ kind: "said", tool: "say", text: "hello Margo, are you near the cabin?", quiet: false });
  expect(chat).toMatchObject({ kind: "event", type: "chat", text: "from=Margo text=hello", quiet: false });
  expect(died).toMatchObject({ kind: "event", type: "died", text: "at=1,64,2 dimension=minecraft:overworld text=what you carried dropped there" });
  // A failed status call is not routine.
  expect(status).toMatchObject({ kind: "call", tool: "status", error: true, quiet: false, result: "Error: Synapse unreachable (client stopped or request timed out)." });
  expect(tail.indicators("Gary")).toMatchObject({ calls: 2, errors: 1, said: 1, chatHeard: 1, deaths: 1 });
});

test("a harness that logs only scripts and their output still yields each call with its own result", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    ...rollout.scriptCall(T + 1000,
      'const rs = await Promise.all([tools.mcp__body__mine({block:"oak_log", count:4}), tools.mcp__body__say({text:"done :})"})]); rs.forEach(r => text(r));',
      [reply("Started mining oak_log.\n\nSince last time:\n3 arrived goal=goto 5 6"), reply("Sent.\n\nSince last time:\nnone")]),
    ...rollout.scriptCall(T + 2000, 'const r = await tools.exec_command({cmd:"cat memory.md"}); text(r.output);', ["# Gary\nFirst evening."]),
  ]);
  const tail = tailer();
  await tail.refresh();
  const entries = tail.recent();
  expect(entries.map(entry => `${entry.kind} ${entry.tool ?? entry.type} ${entry.args ?? entry.text}`)).toEqual([
    "call shell cat memory.md",
    'said say text="done :})"',
    "event arrived goal=goto 5 6",
    "call mine block=oak_log count=4",
  ]);
  expect(entries[3].result).toBe("Started mining oak_log.");
  expect(entries[1].text).toBe("done :})");
});

test("loop signs cover the last hour only: arrivals against stops, and the same action made back to back", async () => {
  const stop = "Started #goto 9 9.\n\nSince last time:\n4 stopped_short distance=6.4";
  session("gary", [
    rollout.meta(T - 3 * 3_600_000, join(home.dir, "resident", "gary")),
    // Two hours before "now": outside the window.
    ...rollout.call(T - 2 * 3_600_000, "go_to", { x: 9, z: 9 }, stop),
    ...rollout.call(T - 2 * 3_600_000 + 1000, "go_to", { x: 9, z: 9 }, stop),
    ...rollout.call(T + 1000, "go_to", { x: 9, z: 9 }, stop),
    ...rollout.call(T + 2000, "status", {}, "Position 1, 64, 2"),
    ...rollout.call(T + 3000, "go_to", { x: 9, z: 9 }, stop),
    ...rollout.call(T + 4000, "wait", { seconds: 20 }, "Time is up."),
    ...rollout.call(T + 5000, "go_to", { x: 9, z: 9 }, "Started #goto 9 9.\n\nSince last time:\n9 arrived goal=goto 9 9"),
    ...rollout.call(T + 6000, "mine", { block: "stone" }, "Started mining."),
    ...rollout.call(T + 7000, "mine", { block: "stone" }, "Started mining."),
    ...rollout.call(T + 8000, "go_to", { x: 9, z: 9 }, "Started #goto 9 9."),
  ]);
  const tail = tailer(T + 60_000);
  await tail.refresh();
  const signs = tail.indicators("Gary");
  expect(signs).toMatchObject({ calls: 8, arrived: 1, stoppedShort: 2, deaths: 0 });
  // status and wait between two identical actions do not break the run.
  expect(signs.repeats.map(repeat => `${repeat.action} x${repeat.times}`)).toEqual(["go_to x=9 z=9 x3", "mine block=stone x2"]);
  expect(signs.byTool).toEqual([{ tool: "go_to", count: 4 }, { tool: "mine", count: 2 }, { tool: "status", count: 1 }, { tool: "wait", count: 1 }]);
});

test("the page can ask only for what is new since the last id it saw", async () => {
  const path = session("gary", [rollout.meta(T, join(home.dir, "resident", "gary")), rollout.remark(T + 1000, "one")]);
  const tail = tailer();
  await tail.refresh();
  const seen = tail.recent()[0].id;
  appendFileSync(path, rollout.remark(T + 2000, "two") + "\n");
  await tail.refresh();
  expect(tail.recent({ after: seen }).map(entry => entry.text)).toEqual(["two"]);
  expect(tail.recent({ after: tail.recent()[0].id })).toEqual([]);
});

test("a session file that was replaced by a shorter one is read again from the start, without leftovers", async () => {
  const cwd = join(home.dir, "resident", "gary");
  session("gary", [rollout.meta(T, cwd, "s1"), rollout.remark(T + 1000, "a long first remark"), rollout.remark(T + 2000, "second")]);
  const tail = tailer();
  await tail.refresh();
  session("gary", [rollout.meta(T, cwd, "s1"), rollout.remark(T + 5000, "new")]);
  await tail.refresh();
  expect(tail.recent().map(entry => entry.text)).toEqual(["new"]);
});

test("sessions older than the window are not loaded", async () => {
  home.put("sessions/2026/11/10/old.jsonl", [rollout.meta(T - 11 * 86_400_000, join(home.dir, "resident", "gary")), rollout.remark(T - 11 * 86_400_000, "long ago")].join("\n") + "\n");
  const tail = tailer();
  await tail.refresh();
  expect(tail.recent()).toEqual([]);
});

test("arguments are compacted to one scannable line and long ones are cut", () => {
  expect(compactArgs({ x: 60, y: 66.5, z: -99 })).toBe("x=60 y=66.5 z=-99");
  expect(compactArgs({ text: "two words", for: ["arrived", "died"], deep: { a: 1 } })).toBe('text="two words" for=[arrived,died] deep={a=1}');
  expect(compactArgs({ block: "minecraft:oak_log" })).toBe("block=minecraft:oak_log");
  expect(compactArgs({})).toBe("");
  const long = compactArgs({ code: "x".repeat(500) });
  expect(long.length).toBe(160);
  expect(long.endsWith("…")).toBe(true);
});

test("a result splits into its own text and the numbered events after 'Since last time:'", () => {
  expect(splitResult("Health 14/20\nScreen: none\n\nSince last time: (2 older dropped)\n3 hurt from=18 to=16\n15 stopped_short distance=6.4 text=a b\n")).toEqual({
    body: "Health 14/20\nScreen: none",
    events: [{ seq: 3, type: "hurt", text: "from=18 to=16" }, { seq: 15, type: "stopped_short", text: "distance=6.4 text=a b" }],
  });
  expect(splitResult("Inventory empty.\n\nSince last time:\nnone")).toEqual({ body: "Inventory empty.", events: [] });
  // A numbered line in the tool's own text is not an event.
  expect(splitResult("3 oak_log\n2 stick").events).toEqual([]);
});

test("calls are found in a script even when their text holds brackets", () => {
  expect(callsInScript('await tools.mcp__body__say({text:"a) b} c"}); await tools.mcp__body__go_to({x:1,\n z:-2});')).toEqual([
    { tool: "say", args: { text: "a) b} c" }, raw: '{text:"a) b} c"}' },
    { tool: "go_to", args: { x: 1, z: -2 }, raw: "{x:1,\n z:-2}" },
  ]);
  expect(callsInScript("const names = ALL_TOOLS.map(x => x.name)")).toEqual([]);
});
