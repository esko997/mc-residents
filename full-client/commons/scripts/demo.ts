// A look at the app without the game machine:  bun scripts/demo.ts
// Builds a throwaway resident home from the fixtures plus made-up sessions,
// trails and commons entries, runs a stand-in client for Gary (Margo stays
// offline), and serves the app. Everything is deleted on Ctrl-C.
import { join } from "node:path";
import { serve } from "../src/server.ts";
import { fakeSynapse, fixture, png, rollout, tempHome } from "../test/helpers.ts";

const now = Date.now(), minute = 60_000;
const home = tempHome();
const gary = join(home.dir, "resident", "gary"), margo = join(home.dir, "resident", "margo");

home.put("resident/gary/memory.md", fixture("memory.md"));
home.put("resident/gary/journal.md", `# Journal\n\n${Array.from({ length: 40 }, (_, i) => `## 2026-11-${10 + (i >> 2)} evening ${i % 4 + 1}\nWalked the lit road. Checked the wheat. Nothing chased me.\n`).join("\n")}\n## Today\nPlanted wheat by the stream. Margo came by for bread.\n`);
home.put("resident/gary/notes/farming.md", "# Farming\nWheat needs water within four blocks and light 9 or more.\nSeeds: break tall grass.\n");
home.put("resident/gary/notes/people.md", "# People\nspesk01: base at 113,78,-80. Friendly.\nMargo: tinkerer, arrived 2026-11-21.\n");
home.put("resident/gary/AGENTS.md", "# Gary\nYou are an AI model living in a Minecraft world as a player named Gary.\n");
home.put("resident/gary/places.json", JSON.stringify({
  places: [{ name: "Wheat patch", x: 104, y: 116, z: -201, dimension: "minecraft:overworld", note: "Six seeds planted 2026-11-21." }, { name: "Copper vein", x: 152, y: 71, z: -168, dimension: "minecraft:overworld" }],
  deaths: [{ x: 133, y: 82, z: -104, dimension: "minecraft:overworld", at: now - 95 * minute }],
}));
home.put("resident/margo/memory.md", "# Margo\n\nI am an AI playing as Margo. I like finding out how machines work.\n\n## Safety\nThe water by the stone building is deep. Walk around it.\n");
home.put("resident/margo/journal.md", "# Journal\n\n## 2026-11-21\nFell in the water twice. Gary gave me bread.\n");
home.put("resident/margo/places.json", JSON.stringify({ places: [{ name: "Stone building", x: 58, y: 64, z: -96, dimension: "minecraft:overworld", note: "Machines inside, not mine." }], deaths: [{ x: 60, y: 58, z: -101, dimension: "minecraft:overworld", at: now - 170 * minute }] }));
home.put("resident/shared/places.json", fixture("shared-places.json"));
home.put("instances/Margo.env", fixture("instances-Margo.env").replace(/^GAME_DIR=.*$/m, `GAME_DIR=${home.dir}/game-Margo`).replace(/^SYNAPSE_URL=.*$/m, "SYNAPSE_URL=http://127.0.0.1:9"));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
home.put("overseer/Gary.md", [
  `\n## ${new Date(now - 125 * minute).toISOString().slice(0, 10)} ${hhmm(now - 125 * minute)} (last 60 min, gpt-6.2-astra, shadow)`, "NOTE: none", "MAINTAINERS: none",
  `\n## ${new Date(now - 65 * minute).toISOString().slice(0, 10)} ${hhmm(now - 65 * minute)} (last 60 min, gpt-6.2-astra, shadow)`,
  "NOTE: You sent go_to 133 82 -104 three times in a row and each stopped short about 6 blocks away. What is in the way there?",
  "MAINTAINERS: stopped_short gives the distance but not what blocked the path; three identical retries followed.", "",
].join("\n"));

// Margo's real sample session, moved so that it ended 25 minutes ago.
const sample = fixture("rollout-sample.jsonl").trim().split("\n").map(line => JSON.parse(line) as { timestamp: string });
const shift = now - 25 * minute - Date.parse(sample[sample.length - 1].timestamp);
const today = `codex-home/sessions/${new Date(now).toISOString().slice(0, 10).replaceAll("-", "/")}`;
home.put(`${today}/rollout-margo.jsonl`, sample.map(item => JSON.stringify({ ...item, timestamp: new Date(Date.parse(item.timestamp) + shift).toISOString() })).join("\n") + "\n");

const t0 = now - 48 * minute;
const stopped = (n: number) => `Started #goto 133 82 -104.\n\nSince last time:\n${n} stopped_short distance=6.4 text=Baritone: could not find a path`;
home.put(`${today}/rollout-gary.jsonl`, [
  rollout.meta(t0, gary), rollout.model(t0, "gpt-6-luna"),
  rollout.prompt(t0, `It is ${hhmm(t0)}. Play until ${hhmm(t0 + 60 * minute)}.`),
  rollout.remark(t0 + 5_000, "I'll check the wheat first, then try the road to spesk01's base again."),
  ...rollout.call(t0 + 10_000, "status", {}, "Position 110.5, 120, -207.6 | minecraft:overworld\nHealth 20/20 | food 17/20\n\nSince last time:\nnone"),
  ...rollout.call(t0 + 1 * minute, "go_to", { x: 104, y: 116, z: -201 }, "Started #goto 104 116 -201.\n\nSince last time:\nnone"),
  ...rollout.call(t0 + 2 * minute, "wait", { seconds: 30, for: ["arrived", "stopped_short"] }, "Waking event received.\n\nSince last time:\n3 arrived goal=goto 104 116 -201"),
  ...rollout.call(t0 + 3 * minute, "say", { text: "Margo, the wheat is in. Bread in a few days." }, "Sent.\n\nSince last time:\n4 chat from=Margo text=thank you! I am by the stone building, the water here is deeper than it looks"),
  ...rollout.call(t0 + 8 * minute, "go_to", { x: 133, y: 82, z: -104 }, stopped(7)),
  ...rollout.call(t0 + 9 * minute, "status", {}, "Position 131.2, 84, -110.4 | minecraft:overworld\n\nSince last time:\nnone"),
  ...rollout.call(t0 + 10 * minute, "go_to", { x: 133, y: 82, z: -104 }, stopped(9)),
  ...rollout.call(t0 + 12 * minute, "go_to", { x: 133, y: 82, z: -104 }, "Started #goto 133 82 -104.\n\nSince last time:\n11 stopped_short distance=6.4 attempts=3 text=same destination has stopped short 3 times from about here"),
  rollout.remark(t0 + 13 * minute, "Three tries, same spot. Something is in the way; I'll look instead of walking."),
  ...rollout.call(t0 + 14 * minute, "craft", { item: "torch", count: 4 }, "Error: no coal or charcoal in the inventory; a torch needs one of them and a stick.", { isError: true }),
  ...rollout.call(t0 + 20 * minute, "mine", { block: "coal_ore", count: 2 }, "Started mining coal_ore.\n\nSince last time:\n14 reflex text=fleeing from minecraft:zombie (health 6.5); sprint 3s\n15 hurt from=9 to=6.5\n16 died at=133,82,-104 dimension=minecraft:overworld text=what you carried dropped there; items last about five minutes", { ms: 4200 }),
  rollout.remark(t0 + 21 * minute, "I died at the blocked spot. Going back for my things along the lit road."),
  ...rollout.call(t0 + 22 * minute, "go_to", { x: 133, y: 82, z: -104 }, "Started #goto 133 82 -104.\n\nSince last time:\nnone"),
  ...rollout.call(t0 + 26 * minute, "wait", { seconds: 60 }, "Waking event received.\n\nSince last time:\n19 arrived goal=goto 133 82 -104"),
  ...rollout.call(t0 + 40 * minute, "go_to", { x: 110, y: 120, z: -208 }, "Started #goto 110 120 -208.\n\nSince last time:\n22 arrived goal=goto 110 120 -208", { ms: 1500 }),
  rollout.tokens(t0 + 40 * minute, 1_284_530, 12),
].join("\n") + "\n");

const client = fakeSynapse({ picture: png(427, 240) });
const base = client.state;
// The same start-up path as `bun src/server.ts`, on loopback only.
const running = serve(home.config({
  GARY_SYNAPSE_URL: client.url, CODEX_HOME: join(home.dir, "codex-home"), COMMONS_SYSTEMCTL: "systemctl",
  COMMONS_BIND: "127.0.0.1", PORT: process.env.PORT ?? "0", COMMONS_TOKEN: process.env.COMMONS_TOKEN ?? "demo-token",
  ...(process.env.CHAT_URL ? { CHAT_URL: process.env.CHAT_URL } : {}),
}));
const app = running.app;
// Gary strolls around his cabin so the map has something to add while you watch.
setInterval(() => {
  const angle = Date.now() / 20_000;
  client.state = { ...base, pos: { x: 110.5 + Math.cos(angle) * 9, y: 120, z: -207.6 + Math.sin(angle) * 6 } };
}, 1000);

const position = app.db.query("INSERT OR REPLACE INTO positions (resident, at, x, y, z, dimension, health, food) VALUES (?, ?, ?, ?, ?, 'minecraft:overworld', 20, 18)");
const walk = (resident: string, from: number, legs: [number, number, number][]) => {
  // legs: [x, z, minutes to get there]; a sample every 10 s, with a little wander.
  let [x, z] = [legs[0][0], legs[0][1]], t = from;
  for (const [toX, toZ, minutes] of legs.slice(1)) {
    const steps = minutes * 6;
    for (let step = 1; step <= steps; step++) {
      t += 10_000;
      position.run(resident, t, x + (toX - x) * step / steps + Math.sin(t / 37_000) * 1.5, 70, z + (toZ - z) * step / steps + Math.cos(t / 41_000) * 1.5);
    }
    [x, z] = [toX, toZ];
  }
};
walk("Gary", now - 5 * 60 * minute, [[110, -208, 0], [104, -201, 12], [140, -150, 40], [133, -104, 30], [113, -80, 35], [133, -104, 30]]);
walk("Gary", now - 94 * minute, [[110, -208, 0], [133, -104, 50], [110, -208, 40]]);   // respawned at the cabin after the death
walk("Margo", now - 4 * 60 * minute, [[20, -60, 0], [58, -96, 45], [60, -101, 10], [75, -130, 30], [108, -205, 55], [60, -99, 60]]);

const insertSkill = app.db.query("INSERT INTO skills (name, author, description, code, params_json, expect_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const skill = (name: string, author: string, status: string, version: number, description: string, code: string, params: object, expect: object | null, age: number) =>
  Number(insertSkill.run(name, author, description, code, JSON.stringify(params), expect && JSON.stringify(expect), status, version, now - age * minute, now - age * minute).lastInsertRowid);
const insertRun = app.db.query("INSERT INTO skill_runs (skill_id, version, resident, started_at, ms, ok, check_ok, error, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const sticks = skill("make_sticks", "Gary", "verified", 2, "Turn logs from the inventory into sticks. Use when a recipe needs sticks and you carry any log.",
  "const logs = (await tools.inventory({})).match(/(\\d+) \\w+_log/);\nif (!logs) throw new Error('no logs to use');\nawait tools.craft({ item: 'oak_planks', count: 2 });\nawait tools.craft({ item: 'stick', count: args.count ?? 4 });\nreturn 'made sticks';",
  { count: "how many sticks, default 4" }, { gain: { "minecraft:stick": 4 } }, 300);
const home_ = skill("walk_home", "Margo", "verified", 1, "Walk to the place saved as home and wait until arrived.", "await tools.go_to(await tools.place_find({ query: 'home' }));\nawait tools.wait({ seconds: 120, for: ['arrived', 'stopped_short'] });", {}, null, 200);
skill("dig_down", "Margo", "draft", 3, "Dig straight down to y 12 for diamonds.", "while (true) await tools.attack({ hold: 20 });", { depth: "target y" }, { gain: { "minecraft:diamond": 1 } }, 30);
const eat = skill("eat_when_hungry", "Gary", "curated", 1, "Eat the best food carried when food is below 14.", "const s = await tools.status({});\nif (/food (\\d+)/.exec(s)[1] < 14) await tools.eat({});", {}, null, 900);
const runs: [number, number, string, number, number, number | null, string | null][] = [
  [sticks, 1, "Gary", 290, 1, 0, null], [sticks, 2, "Gary", 250, 1, 1, null], [sticks, 2, "Gary", 180, 0, null, "Error: no logs to use"], [sticks, 2, "Gary", 120, 1, 1, null],
  [sticks, 2, "Margo", 100, 1, 1, null], [sticks, 2, "Margo", 40, 1, 1, null], [home_, 1, "Margo", 150, 1, null, null], [home_, 1, "Margo", 90, 0, null, "timed out after 120 s"],
  [eat, 1, "Gary", 800, 1, null, null], [eat, 1, "Margo", 300, 1, null, null], [eat, 1, "Margo", 60, 1, null, null],
];
for (const [id, version, resident, age, ok, check, error] of runs) insertRun.run(id, version, resident, now - age * minute, 2400, ok, check, error, id === sticks ? '{"count":4}' : "{}");
const insertNote = app.db.query("INSERT INTO shared_notes (author, topic, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
insertNote.run("Margo", "water", "The pool beside the stone building at 58,64,-96 is three blocks deep. go_to across it stops with navigation_stopped. Walk around the north side.", "proposed", now - 70 * minute, now - 70 * minute);
const bread = Number(insertNote.run("Gary", "food", "Bread: three wheat in a row on a crafting table. Wheat grows from seeds in about two days near water.", "curated", now - 600 * minute, now - 500 * minute).lastInsertRowid);
const insertReview = app.db.query("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)");
insertReview.run("skill", eat, "Sam", "keep", "Simple and it works for both.", now - 700 * minute);
insertReview.run("note", bread, "caretaker", "keep", "", now - 500 * minute);
const insertFeedback = app.db.query("INSERT INTO feedback (kind, target_id, resident, worked, text, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
insertFeedback.run("skill", sticks, "Margo", 1, "saved me three calls", 2, now - 38 * minute);
insertFeedback.run("skill", sticks, "Gary", 0, "fails with birch logs only", 1, now - 280 * minute);
insertFeedback.run("skill", home_, "Margo", 0, "stopped short at the water again", 1, now - 85 * minute);
insertFeedback.run("note", bread, "Margo", 1, "", null, now - 200 * minute);

console.log(`demo: http://127.0.0.1:${running.port}/${running.token}/   (home ${home.dir}; Ctrl-C removes it)`);
const stop = () => { running.stop(); client.stop(); home.remove(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
