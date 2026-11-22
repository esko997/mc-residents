import { expect, test } from "bun:test";
import { createApp, type App, type Replies } from "../src/app.ts";
import { tempHome } from "./helpers.ts";

test("server presence does not mask a failed client; unavailable inventories retain labelled historical stock", async () => {
  const home = tempHome(), clock = Date.parse("2026-11-22T15:00:00Z");
  let app: App | undefined, unavailable = false, unloaded = false;
  const stock = {
    block: "minecraft:chest", slots: 27, usedSlots: 1, slotsTruncated: false,
    items: [{ item: "minecraft:bread", count: 20, nbtStacks: 0 }], itemsTruncated: false,
    energy: null, fluids: [], readMicros: 30,
  };
  const observer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("Authorization") !== "Bearer observer-test-secret") return new Response(null, { status: 401 });
    if (unavailable) return new Response(null, { status: 503 });
    if (new URL(request.url).pathname === "/v1/events") return Response.json({
      schema: 1, source: "server-observer", state: "ok", servedAtMs: clock,
      events: [], oldestSeq: 0, latestSeq: 0, gap: false,
    });
    return Response.json({
      schema: 1, source: "server-observer", consumer: "management", scopes: ["residents", "facilities"],
      state: "ok", stateDetail: null, servedAtMs: clock, heartbeatAtMs: clock,
      snapshot: { seq: 1, builtAtMs: clock, gameTime: 1200, residents: [{
        name: "Gary", uuid: "00000000-0000-0000-0000-000000000001", online: true, checkedAtMs: clock,
        body: { atMs: clock, gameTime: 1200, dimension: "minecraft:overworld", pos: { x: 10, y: 64, z: 20 },
          health: 20, maxHealth: 20, food: 18, air: 300, maxAir: 300, gameMode: "survival", dead: false,
          sleeping: false, vehicle: null, xpLevel: 3 }, lastSeen: null,
      }], facilities: [{ id: "pantry", label: "Village pantry", dimension: "minecraft:overworld", pos: [10, 64, 21],
        side: null, status: unloaded ? "unloaded" : "observed", detail: null, checkedAtMs: clock, gameTime: 1200,
        contents: unloaded ? null : stock, lastKnown: unloaded ? stock : null, lastObservedAtMs: clock,
      }] },
    });
  } });
  try {
    app = createApp(home.config({
      COMMONS_OBSERVER_URL: `http://127.0.0.1:${observer.port}`,
      COMMONS_OBSERVER_TOKEN_FILE: home.put("observer-token", "observer-test-secret\n"),
    }), "management-test-token", () => clock, () => {});
    const get = async <Route extends keyof Replies>(route: Route) =>
      (await app!.fetch(new Request(`http://commons.test/management-test-token/api/${route}`))).json() as Promise<Replies[Route]>;
    await app.watcher.sample();
    let residents = await get("residents");
    expect(residents.observer.status).toBe("ok");
    expect(residents.residents[0].status).toBe("offline");
    expect(residents.residents[0].state).toBeNull();
    expect(residents.residents[0].serverObservation?.body?.pos).toEqual({ x: 10, y: 64, z: 20 });
    let commons = await get("commons");
    expect(commons.observer.world?.facilities[0].contents?.items).toEqual(stock.items);

    unloaded = true;
    await app.watcher.sample();
    commons = await get("commons");
    expect(commons.observer.world?.facilities[0].status).toBe("unloaded");
    expect(commons.observer.world?.facilities[0].contents).toBeNull();
    expect(commons.observer.world?.facilities[0].lastKnown?.items).toEqual(stock.items);

    unavailable = true;
    await app.watcher.sample();
    residents = await get("residents");
    expect(residents.observer.status).toBe("error");
    expect(residents.residents[0].status).toBe("offline");
    expect(residents.residents[0].state).toBeNull();
    commons = await get("commons");
    expect(commons.observer.health.status).toBe("error");
    expect(commons.observer.world?.facilities[0].contents).toBeNull();
    expect(commons.observer.world?.facilities[0].lastKnown?.items[0].count).toBe(20);
  } finally {
    app?.stop();
    await observer.stop(true);
    home.remove();
  }
});
