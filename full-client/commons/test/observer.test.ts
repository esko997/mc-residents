import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  choosePosition, normalizeObserverSnapshot, ObserverFeed, observerGet, observerSourceFromEnv,
  observerSight, observerShelf, observerBook, observerEvents,
  type BookInfo, type ClientSighting, type ObserverEventsArgs, type ObserverHealth, type ObserverSource,
} from "../src/observer.ts";

const TOKEN = "observer-test-token-0123456789";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function source(token: string | null = TOKEN): ObserverSource {
  const dir = mkdtempSync(join(tmpdir(), "observer-test-"));
  dirs.push(dir);
  const tokenFile = join(dir, "token");
  if (token !== null) writeFileSync(tokenFile, `${token}\n`);
  return { url: "http://127.0.0.1:25640", tokenFile };
}

const SERVED = 1_000_000;
function snapshotReply(overrides: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
  return {
    schema: 1, source: "server-observer", consumer: "commons", scopes: ["facilities", "residents", "status"],
    state: "ok", stateDetail: null, servedAtMs: SERVED, heartbeatAtMs: SERVED,
    snapshot: {
      seq: 7, builtAtMs: SERVED - 500, gameTime: 4242,
      residents: [
        {
          name: "Gary", uuid: "11111111-1111-1111-1111-111111111111", online: true, checkedAtMs: SERVED - 500,
          body: {
            atMs: SERVED - 500, gameTime: 4242, dimension: "minecraft:overworld", pos: { x: 10, y: 64, z: -3 },
            health: 18.5, maxHealth: 20, food: 17, air: 300, maxAir: 300, gameMode: "survival",
            dead: false, sleeping: false, vehicle: null, xpLevel: 4,
          },
          lastSeen: null,
        },
        {
          name: "Margo", uuid: "22222222-2222-2222-2222-222222222222", online: false, checkedAtMs: SERVED - 500, body: null,
          lastSeen: { atMs: SERVED - 90_000, gameTime: 2000, dimension: "minecraft:the_nether", pos: { x: 1, y: 2, z: 3 }, health: 20, maxHealth: 20, food: 20, air: 300, maxAir: 300, gameMode: "survival", dead: false, sleeping: false, vehicle: "minecraft:boat", xpLevel: 1 },
        },
      ],
      facilities: [
        {
          id: "commons-chest", label: "Shared chest", dimension: "minecraft:overworld", pos: [100, 64, -200], side: null,
          status: "observed", detail: null, checkedAtMs: SERVED - 500, gameTime: 4242,
          contents: { block: "minecraft:chest", slots: 27, usedSlots: 2, slotsTruncated: false, items: [{ item: "minecraft:wheat", count: 40, nbtStacks: 0 }], itemsTruncated: false, energy: null, fluids: [], readMicros: 9 },
          lastObservedAtMs: null, lastKnown: null,
        },
        {
          id: "mek-infuser", label: "Infuser", dimension: "minecraft:overworld", pos: [0, 70, 0], side: "north",
          status: "unloaded", detail: "its chunk 0,0 is not loaded", checkedAtMs: SERVED - 500, gameTime: 4242,
          // A misbehaving payload: contents on an unloaded facility must not be treated as current.
          contents: { block: "mekanism:metallurgic_infuser", slots: 1, usedSlots: 1, items: [], fluids: [] },
          lastObservedAtMs: SERVED - 60_000,
          lastKnown: { block: "mekanism:metallurgic_infuser", slots: 5, usedSlots: 1, slotsTruncated: false, items: [{ item: "mekanism:alloy_infused", count: 3, nbtStacks: 0 }], itemsTruncated: false, energy: { stored: 100, max: 5000 }, fluids: [], readMicros: 20 },
        },
      ],
      ...snapshot,
    },
    ...overrides,
  };
}

interface Seen { url: string; authorization: string | null }
function fakeFetch(routes: Record<string, () => Response>, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new TypeError("connection refused");
    return route();
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const events = (list: object[], extra: Record<string, unknown> = {}) =>
  json({ schema: 1, source: "server-observer", state: "ok", servedAtMs: SERVED, events: list, oldestSeq: 1, latestSeq: list.length, gap: false, ...extra });

test("the observer is configured by both variables or neither, and never with a secret in the URL", () => {
  expect(observerSourceFromEnv({})).toBeUndefined();
  expect(() => observerSourceFromEnv({ COMMONS_OBSERVER_URL: "http://127.0.0.1:25640" })).toThrow(/together/);
  expect(() => observerSourceFromEnv({ COMMONS_OBSERVER_TOKEN_FILE: "/x" })).toThrow(/together/);
  expect(() => observerSourceFromEnv({ COMMONS_OBSERVER_URL: "http://user:pw@127.0.0.1:25640", COMMONS_OBSERVER_TOKEN_FILE: "/x" })).toThrow(/credentials/);
  expect(() => observerSourceFromEnv({ COMMONS_OBSERVER_URL: "http://127.0.0.1:25640/?token=abc", COMMONS_OBSERVER_TOKEN_FILE: "/x" })).toThrow(/query/);
  expect(() => observerSourceFromEnv({ COMMONS_OBSERVER_URL: "ftp://127.0.0.1", COMMONS_OBSERVER_TOKEN_FILE: "/x" })).toThrow(/http/);
  expect(observerSourceFromEnv({ COMMONS_OBSERVER_URL: "http://127.0.0.1:15640/", COMMONS_OBSERVER_TOKEN_FILE: "~/observer.token" }))
    .toEqual({ url: "http://127.0.0.1:15640", tokenFile: join(homedir(), "observer.token") });
});

test("the token travels only as a bearer header and never appears in a failure", async () => {
  const seen: Seen[] = [];
  const ok = await observerGet(source(), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": json(snapshotReply()) }, seen));
  expect(ok.ok).toBe(true);
  expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
  expect(seen[0].url).not.toContain(TOKEN);

  const failures = await Promise.all([
    observerGet(source(), "/v1/snapshot", 1000, fakeFetch({})),
    observerGet(source(), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": json({ schema: 1, source: "server-observer", error: { code: "unauthorized", message: "Missing or unknown bearer token." } }, 401) })),
    observerGet(source(), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": json({ schema: 1, source: "server-observer", error: { code: "forbidden", message: "no scope" } }, 403) })),
    observerGet(source(), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": json({ ok: true, data: {} }) })),
    observerGet(source(), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": () => new Response("<html>", { status: 502 }) })),
    observerGet(source(null), "/v1/snapshot", 1000, fakeFetch({ "/v1/snapshot": json(snapshotReply()) })),
  ]);
  expect(failures.map(reach => reach.ok ? "ok" : reach.status)).toEqual(["offline", "unauthorized", "forbidden", "incompatible", "error", "unauthorized"]);
  for (const reach of failures) expect(JSON.stringify(reach)).not.toContain(TOKEN);
});

function endpointReply(value: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    schema: 1, source: "server-observer", consumer: "commons", scopes: ["sight", "library", "events"],
    state: "ok", stateDetail: null, servedAtMs: SERVED, heartbeatAtMs: SERVED - 50,
    ...value, ...overrides,
  };
}
const getWith = (fetchImpl: typeof fetch, now = () => SERVED + 5000): typeof observerGet =>
  (source, path, timeoutMs) => observerGet(source, path, timeoutMs, fetchImpl, now);
const bookMetadata: BookInfo = {
  slot: 2, kind: "written", title: "Our garden", author: "Margo", generation: 1, pageCount: 2, contentHash: "sha256:abc",
};

test("sight consumers distinguish unknown from false and retain server health, grant and encoded names", async () => {
  const seen: Seen[] = [], src = source();
  const from = "Gary & friends?", to = "Margo/西+#";
  for (const visible of [null, false, true]) {
    const sight = { visible, distance: visible === null ? null : 12.5, reason: visible === null ? "offline" : visible ? "visible" : "occluded" };
    const result = await observerSight(src, { from, to }, getWith(fakeFetch({
      "/v1/sight": json(endpointReply({ sight }, { state: "degraded", stateDetail: "slow sampling" })),
    }, seen)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.data.sight).toEqual(sight);
    expect(result.data.sight.visible).toBe(visible);
    expect(result.data).toMatchObject({
      schema: 1, source: "server-observer", consumer: "commons", scopes: ["sight", "library", "events"],
      state: "degraded", stateDetail: "slow sampling", servedAtMs: SERVED, heartbeatAtMs: SERVED - 50,
    });
    expect(result.receivedAt).toBe(SERVED + 5000);
  }
  for (const request of seen) {
    const url = new URL(request.url);
    expect([...url.searchParams]).toEqual([["from", from], ["to", to]]);
    expect(url.hash).toBe("");
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  }
});

test("library helpers expose selected metadata and plain page text without losing nulls or encoding", async () => {
  const seen: Seen[] = [], src = source(), facility = "Town library/&?雪#";
  const slots: BookInfo[] = [
    bookMetadata,
    { slot: 0, kind: "writable", title: null, author: null, generation: null, pageCount: 1, contentHash: "draft" },
    { slot: 1, kind: "enchanted", title: null, author: null, generation: null, pageCount: 0, contentHash: null },
    { slot: 5, kind: "plain", title: null, author: null, generation: null, pageCount: 0, contentHash: null },
  ];
  const pages = ["Plant wheat.\nLeave seed for neighbours.", "雪 & <text>, not HTML"];
  const get = getWith(fakeFetch({
    "/v1/library/shelf": json(endpointReply({ shelf: { facility, status: "observed", reason: null, slots } })),
    "/v1/library/book": json(endpointReply({ book: { facility, status: "observed", reason: null, book: bookMetadata, pages } })),
  }, seen));
  const shelf = await observerShelf(src, { facility }, get);
  const book = await observerBook(src, { facility, slot: 2 }, get);
  if (!shelf.ok || !book.ok) throw new Error("library read failed");
  expect(shelf.data.shelf).toEqual({ facility, status: "observed", reason: null, slots });
  expect(book.data.book).toEqual({ facility, status: "observed", reason: null, book: bookMetadata, pages });
  expect(new URL(seen[0].url).searchParams.get("facility")).toBe(facility);
  expect([...new URL(seen[1].url).searchParams]).toEqual([["facility", facility], ["slot", "2"]]);
  expect(new URL(seen[1].url).hash).toBe("");
});

test("library non-observations remain explicit status/reason outcomes, not invented books or failures", async () => {
  const src = source();
  for (const status of ["unloaded", "no_level", "no_block_entity", "unsupported", "empty", "not_readable", "too_large", "invalid", "error"] as const) {
    const reason = `${status}: no readable text`;
    const get = getWith(fakeFetch({
      "/v1/library/shelf": json(endpointReply({ shelf: { facility: "library", status, reason, slots: [] } })),
      "/v1/library/book": json(endpointReply({ book: { facility: "library", status, reason, book: null, pages: [] } })),
    }));
    const shelf = await observerShelf(src, { facility: "library" }, get);
    const book = await observerBook(src, { facility: "library", slot: 0 }, get);
    if (!shelf.ok || !book.ok) throw new Error(`lost library outcome ${status}`);
    expect(shelf.data.shelf).toEqual({ facility: "library", status, reason, slots: [] });
    expect(book.data.book).toEqual({ facility: "library", status, reason, book: null, pages: [] });
  }
});

test("helper argument validation refuses invalid bounds before any request", async () => {
  let calls = 0;
  const get: typeof observerGet = async () => { calls++; throw new Error("must not request"); };
  const src = source();
  const results: unknown[] = [
    await observerSight(src, { from: " ", to: "Margo" }, get),
    await observerSight(src, { from: "Gary", to: "" }, get),
    await observerShelf(src, { facility: "" }, get),
    await observerBook(src, { facility: " ", slot: 0 }, get),
  ];
  for (const slot of [-1, 6, 0.5, NaN, Infinity]) results.push(await observerBook(src, { facility: "library", slot }, get));
  const badEvents: ObserverEventsArgs[] = [
    { after: -1 }, { after: 0.5 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { after: NaN },
    { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: Infinity },
    { wait: -1 }, { wait: 26 }, { wait: 0.5 }, { wait: NaN },
    { timeoutMs: 0 }, { timeoutMs: Infinity },
  ];
  for (const args of badEvents) results.push(await observerEvents(src, args, get));
  for (const result of results) expect(result).toMatchObject({ ok: false, status: "error" });
  expect(calls).toBe(0);
  for (const eventWaitSeconds of [-1, 26, 0.5, NaN]) {
    expect(() => new ObserverFeed(src, { eventWaitSeconds })).toThrow(/eventWaitSeconds/);
  }
});

test("malformed endpoint data cannot manufacture negative sight, metadata or readable pages", async () => {
  const src = source();
  const sight = (value: unknown) => observerSight(src, { from: "Gary", to: "Margo" },
    getWith(fakeFetch({ "/v1/sight": json(endpointReply({ sight: value })) })));
  for (const value of [{ distance: null, reason: "unknown" }, { visible: "false", distance: 3, reason: "blocked" }, { visible: false, distance: -1, reason: "bad" }]) {
    expect(await sight(value)).toMatchObject({ ok: false, status: "error" });
  }
  for (const slots of [[{ ...bookMetadata, kind: "unknown" }], [bookMetadata, bookMetadata], [{ ...bookMetadata, slot: 6 }]]) {
    expect(await observerShelf(src, { facility: "library" }, getWith(fakeFetch({
      "/v1/library/shelf": json(endpointReply({ shelf: { facility: "library", status: "observed", reason: "read", slots } })),
    })))).toMatchObject({ ok: false, status: "error" });
  }
  for (const patch of [{ pages: [{ text: "not plain text" }] }, { book: { ...bookMetadata, pageCount: -1 } }, { status: "surprise" }]) {
    expect(await observerBook(src, { facility: "library", slot: 2 }, getWith(fakeFetch({
      "/v1/library/book": json(endpointReply({ book: { facility: "library", status: "observed", reason: "read", book: bookMetadata, pages: ["text"], ...patch } })),
    })))).toMatchObject({ ok: false, status: "error" });
  }
});

test("all helpers retain transport, token, scope, schema and tick-request failures", async () => {
  const src = source();
  const readers = [
    (get: typeof observerGet) => observerSight(src, { from: "Gary", to: "Margo" }, get),
    (get: typeof observerGet) => observerShelf(src, { facility: "library" }, get),
    (get: typeof observerGet) => observerBook(src, { facility: "library", slot: 0 }, get),
    (get: typeof observerGet) => observerEvents(src, {}, get),
  ];
  const failures = [
    { status: 401, code: "unauthorized", expected: "unauthorized" },
    { status: 403, code: "forbidden", expected: "forbidden" },
    { status: 503, code: "busy", expected: "error" },
    { status: 503, code: "paused", expected: "error" },
    { status: 503, code: "tripped", expected: "error" },
    { status: 504, code: "timeout", expected: "error" },
    { status: 200, code: "wrong_schema", expected: "incompatible" },
  ];
  for (const reader of readers) {
    for (const failure of failures) {
      const fetchImpl = (async () => json({ schema: 2, source: "server-observer", error: { code: failure.code, message: failure.code } }, failure.status)()) as unknown as typeof fetch;
      const result = await reader(getWith(fetchImpl));
      expect(result).toMatchObject({ ok: false, status: failure.expected });
      if (!result.ok && failure.status !== 200) expect(result.detail).toContain(failure.code);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(await reader(getWith(fakeFetch({})))).toMatchObject({ ok: false, status: "offline" });
  }
});

test("event helper validates boundaries, keeps the default URL, and adds wait to the timeout margin", async () => {
  const src = source(), seen: { path: string; timeoutMs: number | undefined }[] = [];
  const event = { seq: 1, type: "chat", atMs: SERVED + 1900, gameTime: 5, resident: "Gary", facility: null, detail: "hello" };
  const transport = getWith(fakeFetch({
    "/v1/events": events([event], { servedAtMs: SERVED + 2000 }),
  }), () => SERVED + 10_000);
  const get: typeof observerGet = (source, path, timeoutMs) => { seen.push({ path, timeoutMs }); return transport(source, path, timeoutMs); };
  const first = await observerEvents(src, {}, get);
  if (!first.ok) throw new Error(first.detail);
  expect(first.data.events[0]).toEqual({ seq: 1, type: "chat", at: SERVED + 9900, gameTime: 5, resident: "Gary", facility: null, detail: "hello" });
  expect(first.data).toMatchObject({ oldestSeq: 1, latestSeq: 1, gap: false, servedAtMs: SERVED + 2000 });
  await observerEvents(src, { after: Number.MAX_SAFE_INTEGER, limit: 1, wait: 25 }, get);
  await observerEvents(src, { after: 1, limit: 500, wait: 1, timeoutMs: 700 }, get);
  expect(seen).toEqual([
    { path: "/v1/events?after=0&limit=500", timeoutMs: 4000 },
    { path: `/v1/events?after=${Number.MAX_SAFE_INTEGER}&limit=1&wait=25`, timeoutMs: 29_000 },
    { path: "/v1/events?after=1&limit=500&wait=1", timeoutMs: 1700 },
  ]);
});

test("feed long polls use the event reply clock and extend only the event fetch deadline", async () => {
  const timeouts: number[] = [], seen: Seen[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return realTimeout(ms); });
  try {
    let now = SERVED + 5000;
    const feed = new ObserverFeed(source(), {
      eventWaitSeconds: 25, timeoutMs: 700, now: () => now,
      fetchImpl: fakeFetch({
        "/v1/snapshot": json(snapshotReply()),
        "/v1/events": () => {
          now += 26_000;
          return events([{ seq: 1, type: "chat", atMs: SERVED + 24_000, gameTime: 7 }], { servedAtMs: SERVED + 25_000 })();
        },
      }, seen),
    });
    await feed.poll();
    expect(timeouts).toEqual([700, 25_700]);
    expect(seen.map(entry => new URL(entry.url).pathname + new URL(entry.url).search))
      .toEqual(["/v1/snapshot", "/v1/events?after=0&limit=500&wait=25"]);
    expect(feed.events()[0].at).toBe(SERVED + 30_000);
    expect(feed.health()).toMatchObject({ status: "ok", okAt: SERVED + 5000 });
  } finally {
    timeout.mockRestore();
  }
});

test("a snapshot is normalized onto the local clock, and only observed facilities have current stock", () => {
  const receivedAt = SERVED + 3_600_000; // this machine's clock is an hour ahead of the server's
  const world = normalizeObserverSnapshot(snapshotReply(), receivedAt)!;
  expect(world.ageMs).toBe(500);
  expect(world.clockOffsetMs).toBe(3_600_000);
  expect(world.builtAt).toBe(receivedAt - 500);
  const [gary, margo] = world.residents;
  expect(gary).toMatchObject({ source: "server-observer", name: "Gary", online: true, receivedAt });
  expect(gary.body).toMatchObject({ at: receivedAt - 500, dimension: "minecraft:overworld", pos: { x: 10, y: 64, z: -3 }, health: 18.5, vehicle: null });
  expect(margo.online).toBe(false);
  expect(margo.body).toBeNull();
  expect(margo.lastSeen).toMatchObject({ at: receivedAt - 90_000, dimension: "minecraft:the_nether", vehicle: "minecraft:boat" });

  const [chest, infuser] = world.facilities;
  expect(chest.status).toBe("observed");
  expect(chest.contents!.items).toEqual([{ item: "minecraft:wheat", count: 40, nbtStacks: 0 }]);
  expect(infuser.status).toBe("unloaded");
  expect(infuser.contents).toBeNull();
  expect(infuser.lastKnown!.energy).toEqual({ stored: 100, max: 5000 });
  expect(infuser.lastObservedAt).toBe(receivedAt - 60_000);

  const odd = normalizeObserverSnapshot(snapshotReply({}, { facilities: [{ id: "x", pos: [0, 0, 0], status: "exploded" }] }), receivedAt)!;
  expect(odd.facilities[0]).toMatchObject({ status: "error", contents: null });
  expect(odd.facilities[0].detail).toContain("exploded");

  expect(normalizeObserverSnapshot({ ...snapshotReply(), snapshot: null }, receivedAt)).toBeNull();
  expect(normalizeObserverSnapshot({ ...snapshotReply(), schema: 2 }, receivedAt)).toBeNull();
});

test("an unconfigured feed does nothing and says so", async () => {
  const feed = new ObserverFeed(undefined);
  await feed.poll();
  expect(feed.configured).toBe(false);
  expect(feed.health()).toMatchObject({ status: "unconfigured", checkedAt: 0 });
  expect(feed.world()).toBeNull();
});

test("the feed keeps the last world through an outage but reports the outage, not the old health", async () => {
  let up = true, now = 5_000_000;
  const feed = new ObserverFeed(source(), {
    now: () => now,
    fetchImpl: fakeFetch({
      "/v1/snapshot": () => { if (!up) throw new TypeError("refused"); return json(snapshotReply())(); },
      "/v1/events": events([{ seq: 1, type: "observer_started", atMs: SERVED - 1000, gameTime: 0, resident: null, facility: null, detail: "2 residents" }]),
    }),
  });
  await feed.poll();
  expect(feed.health()).toMatchObject({ status: "ok", okAt: now, snapshotAgeMs: 500, missedEvents: false });
  expect(feed.resident("gary")!.body!.pos.x).toBe(10);
  expect(feed.events().map(event => event.type)).toEqual(["observer_started"]);

  up = false; now += 10_000;
  await feed.poll();
  expect(feed.health()).toMatchObject({ status: "offline", checkedAt: now, okAt: now - 10_000 });
  expect(feed.world()!.seq).toBe(7);
});

test("an old snapshot from a healthy-looking observer is stale, and its own bad states pass through", async () => {
  const reply: { current: Record<string, unknown> } = { current: snapshotReply({}, { builtAtMs: SERVED - 120_000 }) };
  const feed = new ObserverFeed(source(), { staleMs: 30_000, fetchImpl: fakeFetch({ "/v1/snapshot": () => json(reply.current)(), "/v1/events": events([]) }) });
  await feed.poll();
  expect(feed.health().status).toBe("stale");
  expect(feed.health().detail).toContain("120 s");

  reply.current = snapshotReply({ state: "tripped", stateDetail: "stopped after 5 consecutive failures" });
  await feed.poll();
  expect(feed.health()).toMatchObject({ status: "tripped", detail: "stopped after 5 consecutive failures" });

  reply.current = { ...snapshotReply({ state: "starting", stateDetail: "no snapshot yet" }), snapshot: null };
  await feed.poll();
  expect(feed.health()).toMatchObject({ status: "starting", detail: "no snapshot yet" });
});

test("events resume from the last sequence and a dropped range is flagged after the first page", async () => {
  const seen: Seen[] = [];
  const pages = [
    events([{ seq: 4, type: "resident_online", atMs: SERVED, gameTime: 1, resident: "Gary", facility: null, detail: null }], { oldestSeq: 2, latestSeq: 4, gap: true }),
    events([{ seq: 9, type: "resident_offline", atMs: SERVED, gameTime: 2, resident: "Gary", facility: null, detail: null }], { oldestSeq: 8, latestSeq: 9, gap: true }),
  ];
  const feed = new ObserverFeed(source(), { fetchImpl: fakeFetch({ "/v1/snapshot": json(snapshotReply()), "/v1/events": () => pages.shift()!() }, seen) });
  await feed.poll();
  expect(feed.health().missedEvents).toBe(false); // nothing was missed before we started listening
  await feed.poll();
  const eventUrls = seen.filter(entry => entry.url.includes("/v1/events")).map(entry => new URL(entry.url).searchParams.get("after"));
  expect(seen.filter(entry => entry.url.includes("/v1/events")).map(entry => new URL(entry.url).search))
    .toEqual(["?after=0&limit=500", "?after=4&limit=500"]);
  expect(eventUrls).toEqual(["0", "4"]);
  expect(feed.health().missedEvents).toBe(true);
  expect(feed.events().map(event => event.seq)).toEqual([4, 9]);
});

test("polls do not overlap", async () => {
  let calls = 0;
  const feed = new ObserverFeed(source(), { fetchImpl: fakeFetch({ "/v1/snapshot": () => { calls++; return json(snapshotReply())(); }, "/v1/events": events([]) }) });
  await Promise.all([feed.poll(), feed.poll(), feed.poll()]);
  expect(calls).toBe(1);
});

const health = (status: ObserverHealth["status"], detail: string | null = null): ObserverHealth =>
  ({ source: "server-observer", status, detail, checkedAt: 1, okAt: 1, snapshotAgeMs: 0, missedEvents: false });
const world = normalizeObserverSnapshot(snapshotReply(), SERVED)!;
const [garyObserved, margoObserved] = world.residents;
const clientOnline: ClientSighting = { status: "online", checkedAt: 42, state: { pos: { x: 10.2, y: 64, z: -3 }, dimension: "overworld" } };
const clientDown: ClientSighting = { status: "offline", detail: "The client is not running.", checkedAt: 42, state: null };

test("the client's own position wins; the observer fills in only while healthy, and every outage is named", () => {
  expect(choosePosition(clientOnline, health("ok"), garyObserved)).toMatchObject({ source: "client", at: 42, notes: [] });
  expect(choosePosition(clientOnline, health("unconfigured"))).toMatchObject({ source: "client", notes: [] });

  const fallback = choosePosition(clientDown, health("ok"), garyObserved);
  expect(fallback).toMatchObject({ source: "server-observer", pos: { x: 10, y: 64, z: -3 }, dimension: "minecraft:overworld", client: { status: "offline" } });
  expect(fallback.notes).toEqual(["Client offline: The client is not running."]);

  const neither = choosePosition(clientDown, health("stale", "The newest snapshot is 120 s old."), garyObserved);
  expect(neither).toMatchObject({ source: "none", pos: null });
  expect(neither.notes).toEqual(["Client offline: The client is not running.", "Server observer stale: The newest snapshot is 120 s old."]);

  const observerDown = choosePosition(clientOnline, health("offline", "tunnel down"), garyObserved);
  expect(observerDown).toMatchObject({ source: "client", observer: { status: "offline" } });
  expect(observerDown.notes).toEqual(["Server observer offline: tunnel down"]);

  const serverSaysOffline = choosePosition(clientDown, health("ok"), margoObserved);
  expect(serverSaysOffline.source).toBe("none");
  expect(serverSaysOffline.notes).toContain("The server does not see this resident online.");
});

test("client and server disagreeing about where a resident is gets said out loud", () => {
  const far: ClientSighting = { ...clientOnline, state: { pos: { x: 500, y: 64, z: -3 }, dimension: "overworld" } };
  const choice = choosePosition(far, health("ok"), garyObserved);
  expect(choice.source).toBe("client");
  expect(choice.notes[0]).toContain("disagree");
  const otherDimension: ClientSighting = { ...clientOnline, state: { pos: { x: 10, y: 64, z: -3 }, dimension: "the_nether" } };
  expect(choosePosition(otherDimension, health("ok"), garyObserved).notes[0]).toContain("disagree");
});
