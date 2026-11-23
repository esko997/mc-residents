import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";
import { definitions } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";

const hubs: (() => void)[] = [];
afterEach(() => { for (const close of hubs.splice(0)) close(); });

test("a limit above a tool's cap is lowered to the cap and said, not refused", async () => {
  const hub = residentHub(); hubs.push(() => hub.close());
  const stones = Array.from({ length: 20 }, (_, i): [number, number, number] => [i + 1, 64, 0]);
  const f = await fixture({ ...hub.identity(), blocks: { "minecraft:stone": stones } });
  await writeFile(join(f.dir, "memory.md"), Array.from({ length: 10 }, (_, i) => `- bread note ${i}`).join("\n"));
  for (let i = 0; i < 12; i++) expect((await f.tools.run("place_save", { name: `spot ${i}`, x: i, y: 64, z: 0 })).isError).toBe(false);
  const places = await f.tools.run("place_find", { limit: 20 });
  expect(places.isError).toBe(false);
  expect(places.text).toStartWith("Asked for 20; showing at most 10, the most place_find lists.\nspot 0 (0,64,0)");
  expect(places.text).toEndWith("\n2 more not shown.");
  const notes = await f.tools.run("recall", { query: "bread", limit: 12 });
  expect(notes.text).toStartWith("Asked for 12; showing at most 8, the most recall lists.\n");
  expect(notes.text).toEndWith("\n2 more matches.");
  const found = await f.tools.run("find_block", { block: "stone", limit: 20 });
  expect(found.text).toStartWith("Asked for 20; showing at most 16, the most find_block lists.\nminecraft:stone: the 16 nearest");
  expect(f.requests.find(r => r.path === "/blocks")).toBeDefined();
  // The shared contracts' schemas are lowered the same way.
  expect((await f.tools.run("skill_find", { limit: 50 })).text).toStartWith("Asked for 50; showing at most 10, the most skill_find lists.");
  expect((await f.tools.run("notes_shared", { limit: 50 })).text).toStartWith("Asked for 50; showing at most 8, the most notes_shared lists.");
});

test("only an over-cap limit is lowered: other validation still refuses", async () => {
  const f = await fixture();
  const refused = [["recall", { query: "x", limit: 0 }], ["recall", { limit: 3 }], ["find_block", { block: "stone", radius: 97, limit: 30 }],
    ["recall", { query: "x", limit: "12" }], ["recall", { query: "x", limit: 10.5 }], ["place_find", { limit: 12.5 }], ["find_block", { block: "stone", limit: Infinity }]] as const;
  for (const [tool, args] of refused) {
    const reply = await f.tools.run(tool, args);
    expect(reply.isError).toBe(true);
    expect(reply.text).not.toContain("Asked for");
  }
  for (const tool of ["place_find", "recall", "find_block", "skill_find", "notes_shared"] as const) {
    expect(definitions[tool].description).toMatch(/at most \d+|max \d+|most it lists/);
  }
});
