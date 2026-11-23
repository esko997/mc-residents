import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, openSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { callsInScript, compactArgs, RolloutTail, splitResult, type Entry } from "../src/rollouts.ts";
import { callLine, fixture, reply, rollout, tempHome, type Home } from "./helpers.ts";

let home: Home;
const T = Date.parse("2026-11-21T15:00:00Z");
const residents = () => [{ name: "Gary", dir: join(home.dir, "resident", "gary") }, { name: "Margo", dir: join(home.dir, "resident", "margo") }];
const tailer = (now = T + 60_000, callsDir?: string) => new RolloutTail(join(home.dir, "sessions"), residents(), { now: () => now, callsDir });
const callsDir = () => join(home.dir, "calls");
/** What the page shows of an entry: all of it but its number and which file it was read from. */
const shown = (entries: Entry[]) => entries.map(({ id, session, ...rest }) => rest);
/** Each entry with where it was read from: a session, or (no session) a call log. */
const sources = (entries: Entry[]) => entries.map(entry => `${entry.session || "log"} ${entry.tool ?? entry.type ?? entry.kind}`);
const isBodyCall = (entry: Entry) => entry.kind === "event" || entry.kind === "said" || (entry.kind === "call" && entry.tool !== "shell");
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
    "thought: The stream is north.\n\nWheat needs water.",
  ]);
  expect(tail.thoughtSummary("Gary").summaries).toBe("on");
});

test("thoughts: both summary shapes and the streamed sections are recorded once each, newest first, apart from tool calls", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    // Streamed sections arrive first; the response item and finished item that repeat them add nothing.
    rollout.agentReasoning(T + 1000, "**Finding water**\n\nThe stream is north of the wheat."),
    ...rollout.reasoning(T + 1500, ["**Finding water**\n\nThe stream is north of the wheat."], { id: "rs_a" }),
    ...rollout.call(T + 2000, "go_to", { x: 1, z: -40 }, "Started #goto 1 -40."),
    // Plain strings in the response item; the finished item has the same id.
    ...rollout.reasoning(T + 3000, ["**Planting**", "Seeds go on the wet side."], { plain: true }),
    // The first item read again much later, as a harness replaying history would write it.
    ...rollout.reasoning(T + 400_000, ["**Finding water**\n\nThe stream is north of the wheat."], { id: "rs_a" }),
    rollout.remark(T + 4000, "Planting by the stream."),
  ]);
  const tail = new RolloutTail(join(home.dir, "sessions"), residents(), { now: () => T + 60_000, maxEntries: 2 });
  await tail.refresh();
  expect(tail.thoughts("Gary")).toEqual([
    { t: T + 4000, kind: "remark", text: "Planting by the stream." },
    { t: T + 3000, kind: "thought", text: "**Planting**\n\nSeeds go on the wet side." },
    { t: T + 1000, kind: "thought", text: "**Finding water**\n\nThe stream is north of the wheat." },
  ]);
  // The activity record keeps only its newest two lines here; thoughts are kept apart from it.
  expect(tail.recent({ resident: "Gary" }).length).toBeLessThanOrEqual(3);
  expect(tail.thoughtSummary("Gary")).toEqual({ summaries: "on", latest: { t: T + 4000, kind: "remark", text: "Planting by the stream." } });
  expect(tail.sessions("Gary")[0].summaries).toBe("on");
  expect(tail.thoughtSummary("Margo")).toEqual({ summaries: "unknown", latest: null });
});

test("thoughts: with summaries off a session shows its remarks only and says so", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    ...rollout.reasoning(T + 1000, []),
    rollout.remark(T + 2000, "I'll check the wheat first."),
    ...rollout.reasoning(T + 3000, []),
    ...rollout.call(T + 4000, "status", {}, "ok"),
    rollout.answer(T + 5000, "Stopping for now; my notes are up to date."),
  ]);
  const tail = tailer();
  await tail.refresh();
  // The turn's final answer is in the activity record, but it is not a thought or remark.
  expect(tail.thoughts("Gary").map(thought => `${thought.kind}: ${thought.text}`)).toEqual(["remark: I'll check the wheat first."]);
  expect(tail.thoughtSummary("Gary")).toMatchObject({ summaries: "off", latest: { kind: "remark" } });
  expect(tail.recent().map(entry => entry.kind)).toEqual(["answer", "call", "remark"]);
});

test("thoughts: at most maxThoughts per resident are kept, the newest, and a file read again replaces its own", async () => {
  const lines = [rollout.meta(T, join(home.dir, "resident", "gary"), "s1")];
  for (let i = 0; i < 12; i++) lines.push(...rollout.reasoning(T + i * 1000, [`Thought ${i}`]), ...rollout.call(T + i * 1000 + 500, "mine", { block: "stone" }, "Mined."));
  session("gary", lines);
  const tail = new RolloutTail(join(home.dir, "sessions"), residents(), { now: () => T + 60_000, maxThoughts: 4 });
  await tail.refresh();
  expect(tail.thoughts("Gary").map(thought => thought.text)).toEqual(["Thought 11", "Thought 10", "Thought 9", "Thought 8"]);
  // Rewritten shorter (a new file in the same place): what was read from the old one goes.
  home.put("sessions/2026/11/21/gary.jsonl", [rollout.meta(T, join(home.dir, "resident", "gary"), "s1"), ...rollout.reasoning(T + 500, ["Only this"])].join("\n") + "\n");
  await tail.refresh();
  expect(tail.thoughts("Gary").map(thought => thought.text)).toEqual(["Only this"]);
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

test("the sample session's calls show the same read from Margo's call log as read from the rollout: feed, counts, loop signs", async () => {
  home.put("sessions/2026/11/21/rollout-sample.jsonl", fixture("rollout-sample.jsonl"));
  const now = Date.parse("2026-11-21T15:15:00Z");
  const fromRollout = tailer(now);
  await fromRollout.refresh();
  // The same five calls as her tool server logged them; the rollout still holds its own copy of each.
  home.put("calls/Margo.jsonl", fixture("calls-sample.jsonl"));
  const fromLog = tailer(now, callsDir());
  await fromLog.refresh();

  const before = fromRollout.recent({ resident: "Margo", limit: 1000 }), after = fromLog.recent({ resident: "Margo", limit: 1000 });
  // The two really are read from different files.
  expect(before.every(entry => entry.session === "01a1feab-e506-7353-afda-8c05d5d35de6")).toBe(true);
  expect(after.filter(entry => entry.kind === "call").length).toBe(5);
  expect(after.filter(isBodyCall).every(entry => entry.session === "")).toBe(true);
  expect(after.filter(entry => !isBodyCall(entry)).map(entry => entry.kind)).toEqual(["remark", "remark", "prompt"]);

  expect(shown(after)).toEqual(shown(before));
  expect(fromLog.indicators("Margo")).toEqual(fromRollout.indicators("Margo"));
  expect(fromLog.indicators("Margo")).toMatchObject({ calls: 5, navigationStopped: 1, reflexes: 7, hurt: 2 });
  // Tokens and the model's name are the rollout's in both.
  expect(fromLog.tokenTotals("Margo")).toEqual(fromRollout.tokenTotals("Margo"));
  expect(fromLog.tokenTotals("Margo").session!.tokens!.total).toBe(244290);
});

test("what was said, errors, events and repeated actions count the same from either source", async () => {
  const stop = "Started #goto 9 9.\n\nSince last time:\n4 stopped_short distance=6.4";
  const calls: [at: number, tool: string, args: object, reply: string, options?: { isError?: boolean; ms?: number }][] = [
    [1000, "go_to", { x: 9, z: 9 }, stop],
    [2000, "status", {}, "Position 1, 64, 2\n\nSince last time:\n5 hurt from=18 to=16\n6 reflex text=fleeing from minecraft:zombie"],
    [3000, "go_to", { x: 9, z: 9 }, stop],
    [4000, "say", { text: "Margo, the path is blocked" }, "Sent.\n\nSince last time:\n7 chat from=Margo text=try the bridge\n8 arrived goal=goto 9 9"],
    [5000, "craft", { item: "torch", count: 4 }, "Error: no coal or charcoal in the inventory.", { isError: true, ms: 1500 }],
    [7000, "status", {}, "Health 0/20\n\nSince last time:\n9 died at=1,64,2 dimension=minecraft:overworld"],
  ];
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")), rollout.remark(T + 500, "Trying the east path."),
    ...calls.flatMap(([at, ...call]) => rollout.call(T + at, ...call)),
    rollout.remark(T + 9000, "I died on the east path."),
  ]);
  const fromRollout = tailer();
  await fromRollout.refresh();
  home.put("calls/Gary.jsonl", calls.map(([at, ...call]) => callLine(T + at, ...call)).join("\n") + "\n");
  const fromLog = tailer(undefined, callsDir());
  await fromLog.refresh();

  expect(fromLog.recent().filter(isBodyCall).every(entry => entry.session === "")).toBe(true);
  expect(shown(fromLog.recent())).toEqual(shown(fromRollout.recent()));
  const signs = fromLog.indicators("Gary");
  expect(signs).toEqual(fromRollout.indicators("Gary"));
  expect(signs).toMatchObject({ calls: 6, errors: 1, said: 1, chatHeard: 1, arrived: 1, stoppedShort: 2, deaths: 1, reflexes: 1, hurt: 1 });
  expect(signs.repeats.map(repeat => `${repeat.action} x${repeat.times}`)).toEqual(["go_to x=9 z=9 x2"]);
});

test("calls made through a helper of the model's own leave no call site in the rollout; the call log has them", async () => {
  // Gary on Sol: one script loads his helper and makes two body calls through it.
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary")),
    rollout.remark(T + 500, "Opening the chest by the door."),
    ...rollout.scriptCall(T + 1000, 'let b=eval(load("helper"));await b("look",{x:1,y:2,z:3});await b("use")', ["minecraft:chest at 1,2,3", "A screen opened: Chest."]),
    ...rollout.scriptCall(T + 2000, 'const r = await tools.exec_command({cmd:"cat memory.md"}); text(r.output);', ["# Gary\nFirst evening."]),
  ]);
  const feed = (tail: RolloutTail) => tail.recent().map(entry => `${entry.kind} ${entry.tool ?? entry.type ?? ""} ${entry.args ?? entry.text}`);
  const blind = tailer();
  await blind.refresh();
  expect(feed(blind)).toEqual(["call shell cat memory.md", "remark  Opening the chest by the door."]);
  expect(blind.indicators("Gary").calls).toBe(0);

  home.put("calls/Gary.jsonl", [
    callLine(T + 1010, "look", { x: 1, y: 2, z: 3 }, "minecraft:chest at 1,2,3, 2.1 blocks away.\n\nSince last time:\n3 chat from=Margo text=is that chest yours?", { ms: 15 }),
    callLine(T + 1030, "use", undefined, "Used minecraft:chest. A screen opened: Chest.\n\nSince last time:\nnone", { ms: 10 }),
  ].join("\n") + "\n");
  const tail = tailer(undefined, callsDir());
  await tail.refresh();
  expect(feed(tail)).toEqual([
    "call shell cat memory.md",
    "call use ",
    "event chat from=Margo text=is that chest yours?",
    "call look x=1 y=2 z=3",
    "remark  Opening the chest by the door.",
  ]);
  expect(tail.recent().find(entry => entry.tool === "use")).toMatchObject({ result: "Used minecraft:chest. A screen opened: Chest.", ms: 10, t: T + 1040, quiet: false });
  expect(tail.indicators("Gary")).toMatchObject({ calls: 2, chatHeard: 1, byTool: [{ tool: "look", count: 1 }, { tool: "use", count: 1 }] });
});

test("calls from before a resident's call log began are still read from the rollout, and every call appears once", async () => {
  session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary"), "s1"),
    ...rollout.call(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2."),
    ...rollout.call(T + 2000, "mine", { block: "oak_log" }, "Started mining.\n\nSince last time:\n1 arrived goal=goto 1 2"),
    // From here on his tool server keeps a log.
    ...rollout.call(T + 3000, "craft", { item: "stick" }, "Crafted 4 stick."),
    ...rollout.scriptCall(T + 3500, 'const r = await tools.exec_command({cmd:"cat memory.md"}); text(r.output);', ["# Gary"]),
    ...rollout.call(T + 4000, "eat", {}, "Ate bread.\n\nSince last time:\n2 hurt from=20 to=18"),
  ]);
  home.put("calls/Gary.jsonl", [
    callLine(T + 3000, "craft", { item: "stick" }, "Crafted 4 stick."),
    callLine(T + 4000, "eat", {}, "Ate bread.\n\nSince last time:\n2 hurt from=20 to=18"),
  ].join("\n") + "\n");
  // Margo has no log: her calls stay the rollout's, whenever they were made.
  session("margo", [rollout.meta(T, join(home.dir, "resident", "margo"), "s2"), ...rollout.call(T + 3200, "status", {}, "Health 20/20")]);
  const tail = tailer(undefined, callsDir());
  await tail.refresh();
  expect(sources(tail.recent({ resident: "Gary" }))).toEqual(["log hurt", "log eat", "s1 shell", "log craft", "s1 arrived", "s1 mine", "s1 go_to"]);
  expect(sources(tail.recent({ resident: "Margo" }))).toEqual(["s2 status"]);
  expect(tail.indicators("Gary")).toMatchObject({ calls: 4, arrived: 1, hurt: 1 });
});

test("a call log is read as it grows: half a last line waits for its end, a broken line is skipped, no call is read twice", async () => {
  session("gary", [rollout.meta(T, join(home.dir, "resident", "gary"))]);
  const whole = [
    callLine(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2.\n\nSince last time:\nnone"),
    '{"t":"2026-11-21T15:00:01.500Z","ms":3,"tool":"sta',
    callLine(T + 2000, "mine", { block: "oak_log", count: 4 }, "Started mining.\n\nSince last time:\n1 arrived goal=goto 1 2"),
  ].join("\n") + "\n";
  // Stop in the middle of the last line, as a reader racing the tool server would see it.
  const cut = whole.indexOf('"tool":"mine"') + 5;
  const path = home.put("calls/Gary.jsonl", whole.slice(0, cut));
  const tail = tailer(undefined, callsDir());
  await tail.refresh();
  expect(tail.recent().map(entry => entry.tool)).toEqual(["go_to"]);
  const boot = tail.boot;

  // Deface what was already read (same length, so nothing else moves), then let the writer finish.
  const file = openSync(path, "r+");
  writeSync(file, "XXXXX", whole.indexOf('"tool":"go_to"') + 8);
  closeSync(file);
  appendFileSync(path, whole.slice(cut));
  await tail.refresh();
  await tail.refresh();
  const entries = tail.recent();
  expect(entries.map(entry => entry.kind === "event" ? `event ${entry.type}` : entry.tool)).toEqual(["event arrived", "mine", "go_to"]);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
  expect(entries[1].args).toBe("block=oak_log count=4");
  // Nothing was taken back, so a page keeps the ids it has.
  expect(tail.boot).toBe(boot);
});

test("a call log that appears while the app runs takes over without doubling a call; removed or begun again, the rollout serves again", async () => {
  const mine = [T + 2000, "mine", { block: "stone" }, "Started mining."] as const, eat = [T + 3000, "eat", {}, "Ate bread."] as const;
  const rolloutPath = session("gary", [
    rollout.meta(T, join(home.dir, "resident", "gary"), "s1"),
    ...rollout.call(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2."), ...rollout.call(...mine),
  ]);
  const tail = tailer(undefined, callsDir());
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["s1 mine", "s1 go_to"]);
  const boot = tail.boot;

  // The log's first line is a call the rollout already gave.
  const log = home.put("calls/Gary.jsonl", callLine(...mine) + "\n");
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["log mine", "s1 go_to"]);
  // Entries were taken back: a page holding their ids has to start over.
  expect(tail.boot).not.toBe(boot);
  appendFileSync(rolloutPath, rollout.call(...eat).join("\n") + "\n");
  appendFileSync(log, callLine(...eat) + "\n");
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["log eat", "log mine", "s1 go_to"]);

  rmSync(log);
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["s1 eat", "s1 mine", "s1 go_to"]);
  // Begun again with the later call only: the rollout is the record of the earlier ones.
  home.put("calls/Gary.jsonl", callLine(...eat) + "\n");
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["log eat", "s1 mine", "s1 go_to"]);
  expect(tail.indicators("Gary").calls).toBe(3);
});

test("a log that reaches back before the window is the record only inside it: nothing is doubled or lost at the edge", async () => {
  const longAgo = T - 11 * 86_400_000;
  // A session file still being written is loaded whole, old lines too; old lines of the log are passed over.
  session("gary", [
    rollout.meta(longAgo, join(home.dir, "resident", "gary"), "s1"),
    ...rollout.call(longAgo, "eat", {}, "Ate bread."), ...rollout.call(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2."),
  ]);
  home.put("calls/Gary.jsonl", [callLine(longAgo, "eat", {}, "Ate bread."), callLine(T + 1000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2.")].join("\n") + "\n");
  const tail = tailer(undefined, callsDir());
  await tail.refresh();
  expect(sources(tail.recent())).toEqual(["log go_to", "s1 eat"]);
});
