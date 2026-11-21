import { afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "../src/body.ts";
import { Synapse, type Screen, type State } from "../src/synapse.ts";
import { Tools } from "../src/tools.ts";

export interface Request { path: string; body: Record<string, unknown> }
export interface FakeOptions {
  closeFailures?: number; escapeBlocked?: boolean; eatWorks?: boolean; openWorks?: boolean;
  swapWorks?: boolean; interactable?: boolean; forceMealScreen?: boolean;
  rotation?: State["rotation"]; selectedSlot?: number;
}
export interface Fixture {
  dir: string; log: string; state: State; requests: Request[]; body: Body; tools: Tools; options: FakeOptions;
  tick(ms: number): void; setScreen(value: Screen): void; setUnavailable(): void;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// One HTTP fake for every Body test. State read-backs are independent snapshots,
// and commands arrive through the real Synapse client rather than mocked methods.
export async function fixture(options: FakeOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "resident-body-"));
  const log = join(dir, "latest.log"); await writeFile(log, "");
  let clock = 0;
  const state: State = {
    pos: { x: 0, y: 64, z: 0 }, eye: { x: 0, y: 65.62, z: 0 }, dimension: "minecraft:overworld",
    health: 20, food: 20, rotation: { ...(options.rotation ?? { yaw: 0, pitch: 0 }) },
    hotbar: [], selectedSlot: options.selectedSlot ?? 0,
    screen: "none", lookingAt: { type: "miss" }, nearbyEntities: [],
    inventory: { main: [], armor: [], offhand: { slot: 0, item: "minecraft:air", count: 0 } },
    air: 300, maxAir: 300, underwater: false, inWater: false, inLava: false, onFire: false,
    onGround: true, fallDistance: 0, velocity: { x: 0, y: 0, z: 0 },
  };
  let screen: Screen = { screen: "none" };
  let unavailable = false;
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() as Record<string, unknown> : {};
    requests.push({ path: url.pathname, body });
    if (req.headers.get("X-Synapse-Token") !== "test-token") return Response.json({ ok: false, error: { message: "Unauthorized" } }, { status: 401 });
    if (unavailable) return Response.json({ ok: false, error: { message: "No player in world." } }, { status: 409 });
    let data: unknown = {};
    if (url.pathname === "/state") data = state;
    else if (url.pathname === "/screenshot") data = { image: "aGVsbG8=" };
    else if (url.pathname === "/gui") {
      if (body.action === "open" && options.openWorks !== false) {
        screen = { screen: "InventoryScreen", container: { slots: state.inventory!.main.map(s => ({ ...s, slot: s.slot < 9 ? s.slot + 36 : s.slot })), carried: "minecraft:air" } };
        state.screen = screen.screen;
      }
      if (body.action === "clickSlot" && body.mode === "SWAP" && options.swapWorks !== false) {
        const source = state.inventory!.main.find(s => s.slot === body.slot);
        if (source) {
          const slot = body.button as number;
          const displaced = state.hotbar.find(s => s.slot === slot);
          state.hotbar = [...state.hotbar.filter(s => s.slot !== slot), { ...source, slot }];
          state.inventory!.main = [...state.inventory!.main.filter(s => s.slot !== source.slot && s.slot !== slot), { ...source, slot }, ...(displaced ? [{ ...displaced, slot: source.slot }] : [])];
        }
      }
      const close = body.action === "close" && !(options.closeFailures && options.closeFailures-- > 0);
      if (close || body.action === "clickButton" || (body.key === "ESCAPE" && !options.escapeBlocked)) { screen = { screen: "none" }; state.screen = "none"; }
      data = screen;
    } else if (url.pathname === "/player") {
      if (body.action === "use" && !body.ticks && state.hotbar.some(s => s.item.endsWith("_sign"))) {
        screen = { screen: "SignEditScreen", widgets: [{ index: 0, label: "Done", button: true, active: true, visible: true }] }; state.screen = screen.screen;
      }
      if (body.action === "use" && !body.ticks && state.lookingAt.block === "minecraft:crafting_table") {
        screen = { screen: "CraftingScreen" }; state.screen = screen.screen;
      }
      if (body.action === "selectHotbar") state.selectedSlot = body.slot as number;
      if (body.action === "look") state.rotation = { yaw: body.yaw as number, pitch: body.pitch as number };
      if (body.action === "use" && body.ticks === 40) {
        if (options.forceMealScreen || (options.interactable && state.rotation.pitch !== -90)) {
          screen = { screen: "CraftingScreen" }; state.screen = screen.screen;
        } else if (options.eatWorks !== false) state.food = Math.min(20, state.food + 6);
      }
    } else if (url.pathname !== "/chat" && url.pathname !== "/wait") return new Response("not found", { status: 404 });
    return Response.json({ ok: true, data });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const api = new Synapse(url, "test-token");
  const body = new Body({ url, tokenFile: "", log, name: "Gary", residentDir: dir }, api, () => clock);
  const tools = new Tools(body);
  cleanups.push(async () => { await body.close(); server.stop(true); await rm(dir, { recursive: true, force: true }); });
  return { dir, log, state, requests, body, tools, options, tick: (ms: number) => { clock += ms; }, setScreen: (value: Screen) => { screen = value; state.screen = value.screen; }, setUnavailable: () => { unavailable = true; } };
}
