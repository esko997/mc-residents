import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { openCommons } from "../src/db.ts";
import type { ObserverReach, ObserverSource, observerGet } from "../src/observer.ts";
import { ObserverIngest } from "../src/observer-ingest.ts";
import { observerQuery, observerVocabulary, type BlockChange, type Flow } from "../src/observer-query.ts";
import { applyRetention, latestStats, statSeries } from "../src/observer-store.ts";
import { serverDataRoutes } from "../src/routes/server-data.ts";
import type { Context } from "../src/routes/context.ts";

const NOW = Date.parse("2026-11-23T15:30:00Z");
const HOUR = 3_600_000;
const SOURCE: ObserverSource = { url: "http://bridge.test", tokenFile: "/nonexistent" };
const db = (): Database => openCommons(":memory:", resolve(import.meta.dir, "..", "schema.sql"));

interface Bridge {
  old: boolean;
  limited: boolean;
  run: number;
  oldestBlock: number;
  changes: BlockChange[];
  flows: Flow[];
  stats: { savedAtMs: number; values: Record<string, number> };
  calls: string[];
}

const ok = (body: Record<string, unknown>): ObserverReach => ({
  ok: true, receivedAt: NOW,
  data: { schema: 1, source: "server-observer", consumer: "commons", scopes: ["residents", "facilities"], state: "ok", stateDetail: null,
    servedAtMs: NOW, heartbeatAtMs: NOW, ...body },
});

function ring<T extends { seq: number }>(entries: T[], oldest: number, params: URLSearchParams) {
  const after = Number(params.get("after") ?? 0), limit = Number(params.get("limit") ?? 500);
  const page = entries.filter(e => e.seq > after && e.seq >= oldest).slice(0, limit);
  const latest = entries.at(-1)?.seq ?? 0;
  return { oldestSeq: oldest, latestSeq: latest, gap: after < oldest - 1, nextAfter: page.length >= limit ? page.at(-1)!.seq : Math.max(after, latest), page };
}

function fakeBridge(state: Bridge): typeof observerGet {
  return async (_source, path) => {
    const url = new URL(path, "http://bridge.test");
    if (url.pathname === "/v1/queries") {
      if (state.old) return { ok: false, status: "error", detail: "Observer: Unknown observer endpoint.", httpStatus: 404, code: "not_found" };
      return ok({ queries: { vocabularyVersion: 1, kinds: ["stats", "advancements", "advancement_catalog", "blocks", "block_hours", "flows"].map(kind => ({ kind })),
        subjects: { residents: ["Gary"], facilities: ["pantry"] }, limits: {} } });
    }
    const kind = url.searchParams.get("kind")!;
    state.calls.push(`${kind}${url.search}`);
    if (state.limited) return { ok: false, status: "error", detail: "Observer: Query rate limit reached", httpStatus: 429, code: "rate_limited" };
    let result: Record<string, unknown>;
    if (kind === "blocks") {
      const { page, ...rest } = ring(state.changes, state.oldestBlock, url.searchParams);
      result = { ...rest, changes: page };
    } else if (kind === "flows") {
      const { page, ...rest } = ring(state.flows, 1, url.searchParams);
      result = { ...rest, dropped: 0, flows: page };
    } else if (kind === "block_hours") {
      result = {
        cells: [{ resident: "Gary", dimension: "minecraft:overworld", chunkX: 2, chunkZ: -1, hourMs: NOW - (NOW % HOUR), placed: state.changes.length, broken: 0,
          kinds: [{ block: "minecraft:oak_planks", placed: state.changes.length, broken: 0 }], otherPlaced: 0, otherBroken: 0, firstAtMs: NOW, lastAtMs: NOW }],
        overflow: [{ resident: "Gary", hourMs: NOW - (NOW % HOUR), placed: 3, broken: 0 }],
        offset: 0, total: 1, more: false, sinceHourMs: Number(url.searchParams.get("sinceHour")), retainedFromHourMs: 0, evictedThroughHourMs: 0,
      };
    } else if (kind === "stats") {
      result = { resident: "Gary", status: "observed", reason: null, savedAtMs: state.stats.savedAtMs, dataVersion: 3465, skipped: 0,
        types: [{ type: "minecraft:custom", total: Object.keys(state.stats.values).length, truncated: false, values: state.stats.values }] };
    } else if (kind === "advancements") {
      result = { resident: "Gary", status: "observed", reason: null, savedAtMs: NOW - 1000, total: 2, done: 1, matched: 2, offset: 0, more: false,
        advancements: [
          { id: "minecraft:story/mine_stone", done: true, criteriaDone: 1, criteriaTotal: 1, title: "Stone Age", frame: "task", criteriaTruncated: false,
            criteria: [{ name: "get_stone", atMs: NOW - 50_000 }] },
          { id: "minecraft:adventure/adventuring_time", done: false, criteriaDone: 2, criteriaTotal: 53, title: null, frame: null, criteriaTruncated: false,
            criteria: [{ name: "minecraft:plains", atMs: NOW - 90_000 }, { name: "minecraft:forest", atMs: null }] },
        ] };
    } else {
      result = { builtAtMs: NOW - HOUR, total: 1, offset: 0, more: false, problem: null,
        entries: [{ id: "minecraft:adventure/adventuring_time", title: "Adventuring Time", frame: "challenge", hidden: false, criteria: 53, requirements: 53, parent: null }] };
    }
    return ok({ query: { kind, vocabularyVersion: 1, runStartedAtMs: state.run, params: {}, clamped: [], result } });
  };
}

const change = (seq: number): BlockChange => ({ seq, resident: "Gary", action: "place", dimension: "minecraft:overworld", x: 40, y: 64, z: -3, block: "minecraft:oak_planks", atMs: NOW - 1000 + seq, gameTime: 100 + seq });
const flow = (seq: number): Flow => ({
  seq, facility: "pantry", dimension: "minecraft:overworld", atMs: NOW - 500, gameTime: 99, sinceMs: NOW - 1500, continuous: true,
  deltas: [{ item: "minecraft:bread", before: 20, after: 12, nbtBefore: 0, nbtAfter: 0 }], deltasTruncated: false, uncertain: [],
  attribution: "nearest_resident_within_reach", resident: "Margo", nearby: [{ resident: "Margo", distance: 2.6, when: "now" }],
});
function bridgeState(overrides: Partial<Bridge> = {}): Bridge {
  return { old: false, limited: false, run: NOW - 10 * HOUR, oldestBlock: 1, changes: [change(1), change(2)], flows: [flow(1)],
    stats: { savedAtMs: NOW - 60_000, values: { "minecraft:jump": 12, "minecraft:walk_one_cm": 5000 } }, calls: [], ...overrides };
}
const count = (d: Database, table: string) => d.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

test("an older bridge without queries is 'unsupported', re-checked later, and then ingested", async () => {
  const d = db(), state = bridgeState({ old: true });
  let clock = NOW;
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => clock, redetectMs: 600_000, log: () => {} });
  await ingest.pass();
  expect(ingest.health().status).toBe("unsupported");
  expect(state.calls).toEqual([]);
  state.old = false; // the jar was swapped and the server restarted
  clock += 60_000;
  await ingest.pass();
  expect(ingest.health().status).toBe("unsupported"); // not re-checked before redetectMs
  clock += 600_000;
  await ingest.pass();
  expect(ingest.health().status).toBe("ok");
  expect(count(d, "server_block_changes")).toBe(2);
});

test("one pass stores every data set; the next resumes from its cursors without duplicates", async () => {
  const d = db(), state = bridgeState();
  let clock = NOW;
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => clock, log: () => {} });
  clock += 3 * 60_000; // advancements start two minutes after statistics
  await ingest.pass();
  expect(ingest.health()).toMatchObject({ status: "ok", run: state.run });
  expect(count(d, "server_block_changes")).toBe(2);
  expect(count(d, "server_container_flows")).toBe(1);
  expect(count(d, "server_block_hours")).toBe(1);
  expect(count(d, "server_block_overflow")).toBe(1);
  expect(count(d, "server_advancements")).toBe(2);
  expect(count(d, "server_advancement_criteria")).toBe(3);
  expect(count(d, "server_advancement_catalog")).toBe(1);
  expect(latestStats(d, "Gary").map(s => [s.key, s.value])).toEqual([["minecraft:walk_one_cm", 5000], ["minecraft:jump", 12]]);

  state.changes.push(change(3));
  state.calls.length = 0;
  await ingest.pass();
  expect(state.calls.find(call => call.startsWith("blocks"))).toContain("after=2");
  expect(count(d, "server_block_changes")).toBe(3);
  expect(state.calls.some(call => call.startsWith("stats")), "stats wait for their own cadence").toBe(false);
  const hours = state.calls.find(call => call.startsWith("block_hours"))!;
  expect(new URLSearchParams(hours.slice("block_hours".length)).get("sinceHour")).toBe(String(NOW - (NOW % HOUR) - HOUR));
  expect(d.query<{ placed: number }, []>("SELECT placed FROM server_block_hours").get()!.placed).toBe(3);
});

test("ring overwrites and bridge restarts are recorded as gaps, and a new run is read from its start", async () => {
  const d = db(), state = bridgeState();
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => NOW, log: () => {} });
  await ingest.pass();
  state.changes.push(change(3), change(4), change(5), change(6));
  state.oldestBlock = 5; // 3 and 4 were overwritten before this read
  await ingest.pass();
  const gaps = () => d.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM server_ingest_gaps ORDER BY id").all();
  expect(gaps()).toEqual([{ kind: "blocks", detail: "ring overwritten before it was read: seq 3..4 lost" }]);
  expect(count(d, "server_block_changes")).toBe(4);

  state.run += 5 * HOUR; // the server restarted: seqs start again at 1
  state.changes = [change(1)];
  state.oldestBlock = 1;
  await ingest.pass();
  expect(gaps().map(g => g.kind)).toEqual(["blocks", "blocks", "flows", "block_hours"]);
  expect(d.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM server_block_changes WHERE run = ?").get(state.run)!.n).toBe(1);
});

test("a rate-limited pass stops early and says so; the data waits for the next pass", async () => {
  const d = db(), state = bridgeState({ limited: true });
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => NOW, log: () => {} });
  await ingest.pass();
  expect(ingest.health().status).toBe("partial");
  expect(state.calls).toEqual([expect.stringMatching(/^blocks/)]);
  expect(ingest.health().steps.blocks).toMatchObject({ ok: false });
  state.limited = false;
  await ingest.pass();
  expect(count(d, "server_block_changes")).toBe(2);
});

test("statistics are stored as changes per save, and retention keeps each statistic's baseline", async () => {
  const d = db(), state = bridgeState();
  let clock = NOW;
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => clock, statsEveryMs: 60_000, log: () => {} });
  await ingest.pass();
  clock += 60_000;
  await ingest.pass(); // same save: nothing new
  expect(count(d, "server_stat_snapshots")).toBe(1);
  state.stats = { savedAtMs: NOW + 240_000, values: { "minecraft:jump": 15, "minecraft:walk_one_cm": 5000 } };
  clock += 60_000;
  await ingest.pass();
  expect(count(d, "server_stat_snapshots")).toBe(2);
  expect(count(d, "server_stat_values")).toBe(3);
  expect(statSeries(d, "Gary", "minecraft:custom", "minecraft:jump", 0)).toEqual([
    { savedAt: NOW - 60_000, value: 12 }, { savedAt: NOW + 240_000, value: 15 },
  ]);
  // Long after: old changes fold into one baseline per statistic.
  applyRetention(d, NOW + 400 * 86_400_000);
  expect(statSeries(d, "Gary", "minecraft:custom", "minecraft:jump", NOW + 399 * 86_400_000)).toEqual([{ savedAt: NOW + 240_000, value: 15 }]);
  expect(statSeries(d, "Gary", "minecraft:custom", "minecraft:walk_one_cm", NOW + 399 * 86_400_000)).toEqual([{ savedAt: NOW - 60_000, value: 5000 }]);
  expect(count(d, "server_block_changes")).toBe(0);
});

test("the client refuses malformed replies whole and reads the vocabulary", async () => {
  const state = bridgeState();
  const vocabulary = await observerVocabulary(SOURCE, fakeBridge(state));
  expect(vocabulary).toMatchObject({ ok: true, vocabulary: { residents: ["Gary"], facilities: ["pantry"] } });
  expect(await observerVocabulary(SOURCE, fakeBridge({ ...state, old: true }))).toMatchObject({ ok: false, unsupported: true });
  state.changes = [{ ...change(1), action: "explode" as "place" }];
  expect(await observerQuery(SOURCE, "blocks", {}, fakeBridge(state))).toMatchObject({ ok: false, status: "error" });
  state.changes = [change(1)];
  const good = await observerQuery(SOURCE, "blocks", { after: 0 }, fakeBridge(state));
  expect(good.ok && good.data.query.result.changes[0].block).toBe("minecraft:oak_planks");
});

test("the read API serves bounded windows of what was stored", async () => {
  const d = db(), state = bridgeState();
  let clock = NOW;
  const ingest = new ObserverIngest(d, SOURCE, { get: fakeBridge(state), now: () => clock, log: () => {} });
  clock += 3 * 60_000;
  await ingest.pass();
  const routes = serverDataRoutes({ db: d, now: () => NOW } as unknown as Context, ingest);
  const ask = (query: string) => ({ query: new URLSearchParams(query), body: async () => ({}) });
  const summary = await routes["GET server-data"](ask("")) as Record<string, unknown>;
  expect(summary).toMatchObject({ flows24h: 1, residents: [{ resident: "Gary", advancementsDone: 1, advancementsStarted: 2, placed24h: 2 }] });
  const blocks = await routes["GET server-data/blocks"](ask("resident=Gary")) as { cells: unknown[]; overflow: unknown[] };
  expect(blocks.cells).toHaveLength(1);
  expect(blocks.overflow).toEqual([{ resident: "Gary", hour: NOW - (NOW % HOUR), placed: 3, broken: 0 }]);
  const flows = await routes["GET server-data/flows"](ask("facility=pantry")) as { flows: { resident: string; deltas: unknown[] }[] };
  expect(flows.flows[0]).toMatchObject({ resident: "Margo", attribution: "nearest_resident_within_reach" });
  const advancements = await routes["GET server-data/advancements"](ask("resident=Gary")) as { advancements: { id: string; criteriaTotal: number; title: string | null }[] };
  expect(advancements.advancements.find(a => a.id === "minecraft:adventure/adventuring_time")).toMatchObject({ criteriaTotal: 53, done: false });
  expect((await routes["GET server-data/stats"](ask("")) as Response).status).toBe(400);
  expect((await routes["GET server-data/blocks"](ask("limit=0")) as Response).status).toBe(400);
});
