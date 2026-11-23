import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { configuration } from "../src/synapse.ts";
import { fixture } from "./fake-synapse.ts";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

// The owner watches through a spectator account. A person cannot see a spectator, and neither may a resident.
test("an unseen player nearby and speaking is in no tool reply, event or wake; a normal player still is", async () => {
  // Configured in another case than the game spells it: names match whatever the case.
  const f = await fixture({ unseen: ["lantern_"] }); await f.body.tail.start();
  f.state.nearbyEntities = [
    { id: 50, type: "minecraft:player", player: true, name: "Lantern_", pos: [3, 64, 0], distance: 3 },
    { id: 51, type: "minecraft:player", player: true, name: "Piper", pos: [0, 64, 6], distance: 6 },
  ];
  f.state.lookingAt = { type: "entity", entity: "minecraft:player", entityId: 50 };
  await f.body.poll();
  const arrived = f.body.events.consume();
  expect(arrived).toContain("player_near name=Piper distance=6");
  // Everything the game says of it, with nothing else in between, wakes no wait and leaves no trace.
  const waiting = f.tools.call("wait", { seconds: 1 });
  await appendFile(f.log, [
    "[CHAT] <Lantern_> can anyone see me",
    "[System] [CHAT] Lantern_ joined the game",
    "[CHAT] Lantern_ has made the advancement [Stone Age]",
    "[CHAT] Lantern_ whispers to you: psst",
    "[CHAT] [Baritone] RemotePlayer['Lantern_'/50, l='ClientLevel', x=3.00, y=64.00, z=0.00]",
    "[CHAT] Lantern_ left the game",
  ].map(line => `[12:00:00] [Render thread/INFO]: ${line}\n`).join(""));
  const waited = text(await waiting);
  expect(waited).toBe("Time is up.\n\nSince last time:\nnone");
  await appendFile(f.log, "[CHAT] <Piper> hello Gary\n[CHAT] Piper left the game\n");
  await f.body.tail.read();
  const replies = [
    arrived,
    text(await f.tools.call("status", {})),
    text(await f.tools.call("look", { player: "Lantern_" })),
    text(await f.tools.call("follow", { player: "Lantern_" })),
    text(await f.tools.call("attack", {})),
  ];
  const all = replies.join("\n");
  expect(all.match(/lantern/gi)?.length).toBe(2); // Only the two errors that echo the name the caller gave.
  expect(replies[2]).toContain("Error: Player Lantern_ is not nearby.");
  expect(replies[3]).toContain("Error: Player Lantern_ is not nearby.");
  expect(f.requests.some(r => String(r.body.text).startsWith("#follow"))).toBe(false);
  // The crosshair on it reads as nothing there, and attack sends no click that would hit it. Piper and his lines remain.
  expect(replies[1]).toContain("Players: Piper 6m");
  expect(replies[1]).toContain("Looking miss");
  expect(replies[4]).toContain("Nothing in your sights was in reach; nothing was hit.");
  expect(f.requests.some(r => r.body.action === "attack")).toBe(false);
  expect(replies[1]).toContain("chat from=Piper text=hello Gary");
  expect(replies[1]).toContain("system text=Piper left the game");
  // The event numbers run on without a gap where its lines were.
  const numbers = [...all.matchAll(/^(\d+) /gm)].map(match => Number(match[1]));
  expect(numbers).toEqual(numbers.map((_, index) => numbers[0]! + index));
  // Every reader of the body's state, skills and suggestions included, gets the same filtered list.
  const full = await f.body.api.state(true);
  expect(full.nearbyEntities?.map(entity => entity.name)).toEqual(["Piper"]);
});

test("RESIDENT_UNSEEN_PLAYERS: Lantern_ by default, a comma-separated list, empty for none, a bad name refused", () => {
  const env = { CLIENT_LOG: "/tmp/log", RESIDENT_NAME: "Gary" };
  expect(configuration(env).unseen).toEqual(["Lantern_"]);
  expect(configuration({ ...env, RESIDENT_UNSEEN_PLAYERS: " Lantern_, Watcher2 " }).unseen).toEqual(["Lantern_", "Watcher2"]);
  expect(configuration({ ...env, RESIDENT_UNSEEN_PLAYERS: "" }).unseen).toEqual([]);
  expect(() => configuration({ ...env, RESIDENT_UNSEEN_PLAYERS: "@a" })).toThrow('RESIDENT_UNSEEN_PLAYERS: "@a" is not a Minecraft player name.');
  expect(configuration(env).residents).toEqual(["Gary", "Margo", "Wren", "Tobin"]);
});
