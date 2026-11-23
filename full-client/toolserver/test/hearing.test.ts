import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture, type Fixture } from "./fake-synapse.ts";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
/** Hears one line with nothing else pending, and says whether it would end a wait. */
async function wakes(f: Fixture, line: string) {
  f.body.events.consume();
  await appendFile(f.log, `[12:00:00] [Render thread/INFO]: [CHAT] ${line}\n`);
  await f.body.tail.read();
  return await f.body.events.wait(0.05) === "Waking event received.";
}

// Gary (the fixture's resident) with Margo, Wren and Tobin: residents' lines wake only when meant for him or close by.
test("a resident's chat from afar, naming nobody, ends no wait but still shows in the next result", async () => {
  const f = await fixture(); await f.body.tail.start();
  const waiting = f.tools.call("wait", { seconds: 1, for: ["chat"] });
  await appendFile(f.log, "[CHAT] <Margo> This east ledge dead-ends. Trying the southern slope.\n");
  const reply = text(await waiting);
  expect(reply).toStartWith("Time is up.");
  expect(reply).toContain("chat from=Margo text=This east ledge dead-ends. Trying the southern slope.");
});

test("(a) a line that names him wakes him, as a whole word in any case", async () => {
  const f = await fixture(); await f.body.tail.start();
  expect(await wakes(f, "<Margo> gary, the furnace is lit")).toBe(true);
  expect(await wakes(f, "<Wren> I'll meet Gary's group at the ridge")).toBe(true);
  expect(await wakes(f, "<Tobin> The Garyson farm is east")).toBe(false);
});

test("(b) a line from someone who is not a resident wakes him: a person, or the caretaker speaking to him", async () => {
  const f = await fixture(); await f.body.tail.start();
  expect(await wakes(f, "<spesk01> anyone near the rail?")).toBe(true);
  expect(await wakes(f, "<Caretaker> Gary: auto-eat is off and you carry no food.")).toBe(true);
  expect(await wakes(f, "<Tobin> anyone near the rail?")).toBe(false);
});

test("(c) a resident within 48 blocks, as the body last sensed them, wakes him; one beyond does not", async () => {
  const f = await fixture(); await f.body.tail.start();
  f.state.nearbyEntities = [
    { id: 5, type: "minecraft:player", player: true, name: "Wren", pos: [30, 64, 0], distance: 30 },
    { id: 6, type: "minecraft:player", player: true, name: "Tobin", pos: [60, 64, 0], distance: 60 },
  ];
  await f.body.poll();
  expect(await wakes(f, "<Wren> nice view up here")).toBe(true);
  expect(await wakes(f, "<Tobin> nice view up here")).toBe(false);
  expect(await wakes(f, "<Margo> nice view up here")).toBe(false); // Not sensed at all.
});

test("(d) an exchange wakes him for two minutes: after he named the speaker, or the speaker named him", async () => {
  const f = await fixture(); await f.body.tail.start();
  // He speaks to Margo; her answers wake him without his name in them.
  await f.tools.call("say", { text: "Margo, do you want the spare bread?" });
  expect(await wakes(f, "<Margo> Yes please, at the cabin")).toBe(true);
  expect(await wakes(f, "<Tobin> I'm heading back east")).toBe(false); // Not part of it.
  f.tick(120_001);
  expect(await wakes(f, "<Margo> Still there?")).toBe(false);
  // Wren names him; for the next two minutes her other lines are for him too.
  expect(await wakes(f, "<Wren> Gary, can you hold the gate?")).toBe(true);
  f.tick(119_000);
  expect(await wakes(f, "<Wren> Thanks, it is shut now")).toBe(true);
  f.tick(1001);
  expect(await wakes(f, "<Wren> Off to the ridge")).toBe(false);
});

test("wait refuses an argument it does not take, naming the ones it does; until is pointed at for", async () => {
  const f = await fixture();
  const result = await f.tools.call("wait", { seconds: 5, until: ["arrived"] });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("Error: until is not an argument of wait, which takes seconds, for; for until, use for to list the events that may end the wait.");
});

test.each([
  ["click_slot", { slot: 10, action: "QUICK_MOVE" }, "action is not an argument of click_slot, which takes slot, button, mode; for action, use mode"],
  ["eat", { slot: 4 }, "slot is not an argument of eat, which takes item"],
  ["use", { hand: "main" }, "hand is not an argument of use, which takes hold_ticks"],
  ["attack", { ticks: 20 }, "ticks is not an argument of attack, which takes hold_ticks; for ticks, use hold_ticks"],
] as const)("%s, which the logs show silently ignoring a key, now refuses it and does nothing", async (tool, args, message) => {
  const f = await fixture(); const before = f.requests.length;
  const result = await f.tools.call(tool, args);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(message);
  expect(f.requests.slice(before).some(r => r.path === "/player" || r.path === "/gui")).toBe(false);
});
