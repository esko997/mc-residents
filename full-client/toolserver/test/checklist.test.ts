import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "../src/body.ts";
import { Synapse, type State } from "../src/synapse.ts";
import { Tools } from "../src/tools.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
interface Fixture {
  body: Body;
  state: State;
  requests: { path: string; body: Record<string, unknown> }[];
}

// An HTTP fake, not a mocked Body: JSON read-backs are independent snapshots,
// so a meal's upward look remains in an old poll snapshot after release.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "resident-checklist-"));
  const log = join(dir, "latest.log"); await writeFile(log, "");
  let clock = 0;
  const state: State = {
    pos: { x: 0, y: 64, z: 0 }, eye: { x: 0, y: 65.62, z: 0 }, dimension: "minecraft:overworld",
    health: 20, food: 20, rotation: { yaw: 73, pitch: 10 }, selectedSlot: 4, hotbar: [],
    screen: "none", lookingAt: { type: "miss" }, nearbyEntities: [],
    inventory: { main: [], armor: [], offhand: { slot: 0, item: "minecraft:air", count: 0 } },
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() as Record<string, unknown> : {};
    requests.push({ path: url.pathname, body });
    if (req.headers.get("X-Synapse-Token") !== "checklist-token") return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    let data: unknown = {};
    switch (url.pathname) {
      case "/state": data = state; break;
      case "/gui": data = { screen: state.screen }; break;
      case "/player":
        if (body.action === "selectHotbar") state.selectedSlot = body.slot as number;
        if (body.action === "look") state.rotation = { yaw: body.yaw as number, pitch: body.pitch as number };
        if (body.action === "use" && body.ticks === 40) state.food = Math.min(20, state.food + 6);
        break;
      case "/chat": case "/wait": break;
      default: return new Response("Not found", { status: 404 });
    }
    return Response.json({ ok: true, data });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const body = new Body({ url, tokenFile: "", log, name: "Gary", residentDir: dir }, new Synapse(url, "checklist-token"), () => clock);
  cleanups.push(async () => { await body.close(); server.stop(true); await rm(dir, { recursive: true, force: true }); });
  return { body, tools: new Tools(body), state, requests, tick: (ms: number) => { clock += ms; } };
}

async function startFight(f: Fixture) {
  f.state.hotbar = [{ slot: 2, item: "minecraft:iron_sword", count: 1 }];
  await f.body.poll();
  f.state.health = 18;
  f.state.nearbyEntities = [{ id: 9, type: "minecraft:zombie", hostile: true, distance: 2, pos: [0, 64, 2], health: 20 }];
  f.state.lookingAt = { type: "entity", entity: "minecraft:zombie", entityId: 9 };
  await f.body.poll(); await f.body.poll();
  expect(f.requests.some(r => r.body.action === "attack")).toBe(true);
}

async function startMeal(f: Fixture, food = 8) {
  f.state.food = food;
  f.state.hotbar = [{ slot: 1, item: "minecraft:bread", count: 3 }];
  await f.body.poll();
  expect(f.state.rotation.pitch).toBe(-90);
  expect(f.state.selectedSlot).toBe(1);
}

test("A22 Reflex fight monopolizes the body indefinitely", async () => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 }); await startFight(f);
  f.tick(14999); await f.body.poll();
  expect(f.requests.some(r => r.body.text === "#resume")).toBe(false);
  const attacks = f.requests.filter(r => r.body.action === "attack").length;
  f.tick(1); await f.body.poll();
  const cleanup = f.requests.filter(r => r.path === "/player" || r.path === "/chat").slice(-3).map(r => r.body);
  expect(cleanup).toEqual([{ action: "release" }, { action: "selectHotbar", slot: 4 }, { text: "#resume" }]);
  expect(f.body.events.consume()).toContain("fight ended; navigation resumed");
  await f.body.poll();
  expect(f.requests.filter(r => r.body.action === "attack")).toHaveLength(attacks);
  expect(f.state.selectedSlot).toBe(4);
  expect(f.body.navigation?.description).toBe("goto 20 0");
});

test.each(["meal", "fight"] as const)("I05 Automatic controls fight a direct tool action (%s)", async kind => {
  const f = await fixture();
  if (kind === "meal") await startMeal(f); else await startFight(f);
  const start = f.requests.length;
  const result = await f.tools.call("look", { yaw: -31, pitch: 27 });
  expect(result.isError).toBe(false);
  const actions = f.requests.slice(start).filter(r => r.path === "/player").map(r => r.body);
  expect(actions[0]).toEqual({ action: "release" });
  expect(actions.at(-1)).toEqual({ action: "look", yaw: -31, pitch: 27 });
  expect(actions.find(r => r.action === "selectHotbar")).toEqual({ action: "selectHotbar", slot: 4 });
  f.body.reflexes.auto_eat = false;
  f.tick(20000); await f.body.poll();
  expect(f.state.rotation).toEqual({ yaw: -31, pitch: 27 });
  expect(f.state.selectedSlot).toBe(4);
  expect(f.requests.slice(start).some(r => r.body.action === "attack" || r.body.action === "use")).toBe(false);
});

test.each(["meal", "fight"] as const)("I06 Automatic controls remain held on death (%s)", async kind => {
  const f = await fixture();
  if (kind === "meal") await startMeal(f); else await startFight(f);
  const start = f.requests.length;
  f.state.health = 0; await f.body.poll();
  expect(f.requests.slice(start).some(r => r.body.action === "release")).toBe(true);
  expect(f.state.selectedSlot).toBe(4);
  expect(f.body.events.consume()).toContain("died");
  f.tick(20000); await f.body.poll();
  expect(f.requests.slice(start).some(r => r.body.action === "attack" || r.body.action === "use" || r.body.action === "move")).toBe(false);
});

test.each([1, 2])("I10 Automatic meal leaves aim or slot captured from the previous meal (%i meals)", async meals => {
  const f = await fixture(); await startMeal(f, meals === 1 ? 8 : 0);
  for (let i = 0; i < meals; i++) {
    f.tick(2200); await f.body.poll();
    expect(f.body.events.consume()).toContain(`ate minecraft:bread, food ${meals === 1 ? 8 : i * 6} -> ${meals === 1 ? 14 : (i + 1) * 6}`);
    if (i + 1 < meals) {
      // The next meal begins immediately, but release restored the original
      // orientation and slot before this new meal recorded its baseline.
      expect(f.state.rotation.pitch).toBe(-90);
      const actions = f.requests.filter(r => r.path === "/player").map(r => r.body);
      const release = actions.findIndex(r => r.action === "release");
      expect(actions.slice(release, release + 3)).toEqual([
        { action: "release" }, { action: "selectHotbar", slot: 4 }, { action: "look", yaw: 73, pitch: 10 },
      ]);
    }
  }
  expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
  expect(f.state.selectedSlot).toBe(4);
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(meals);
  const uses = f.requests.filter(r => r.body.action === "use").length;
  await f.body.poll();
  expect(f.state.rotation).toEqual({ yaw: 73, pitch: 10 });
  expect(f.requests.filter(r => r.body.action === "use")).toHaveLength(uses);
});

test.each(["abort", "timeout"] as const)("R04 Cancelled wait is mistaken for cancelled movement (%s)", async kind => {
  const f = await fixture(); await f.tools.call("go_to", { x: 20, z: 0 });
  const start = f.requests.length, controller = new AbortController();
  const waiting = f.tools.call("wait", { seconds: 1 }, controller.signal);
  if (kind === "abort") controller.abort();
  const result = await waiting;
  expect(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")).toContain(kind === "abort" ? "Wait cancelled." : "Time is up.");
  expect(f.body.navigation?.description).toBe("goto 20 0");
  expect(f.requests).toHaveLength(start);
  f.tick(4000); await f.body.poll();
  expect(f.body.events.consume()).toContain("stopped_short");
  expect(f.requests.some(r => r.body.text === "#stop")).toBe(false);
});
