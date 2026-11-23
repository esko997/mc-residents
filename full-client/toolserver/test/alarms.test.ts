import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { alarmFromState, alarmPerception, automaticAlarmReasons, perceivedAlarmText } from "../src/alarms.ts";
import { CommonsClient } from "../src/commons.ts";
import { parseLogLine } from "../src/events.ts";
import type { AlarmEvent, AlarmRequest } from "../../commons/src/resident-contracts-alarm.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";
import { fixture } from "./fake-synapse.ts";

const event = (fields: Partial<AlarmEvent> = {}): AlarmEvent => ({
  sender: "Margo", kind: "manual", reason: "attacked by zombie", x: 24, y: 64, z: -24,
  dimension: "minecraft:overworld", health: 6, maxHealth: 20, at: Date.now(), ...fields,
});

describe("alarm perception", () => {
  test("heard within 48 blocks (height included); 49..96 needs sight; beyond, other dimensions and the dead perceive nothing", async () => {
    const { state } = await fixture();
    expect(alarmPerception(state, event({ x: 48, z: 0 }))).toBe("heard");
    expect(alarmPerception(state, event({ x: 49, z: 0 }))).toBe("sight");
    expect(alarmPerception(state, event({ x: 0, y: 112, z: 0 }))).toBe("heard");
    expect(alarmPerception(state, event({ x: 0, y: 113, z: 0 }))).toBe("sight");
    expect(alarmPerception(state, event({ x: 40, y: 104, z: 0 }))).toBe("sight");
    expect(alarmPerception(state, event({ x: 96, z: 0 }))).toBe("sight");
    expect(alarmPerception(state, event({ x: 97, z: 0 }))).toBeUndefined();
    expect(alarmPerception(state, event({ dimension: "minecraft:the_nether" }))).toBeUndefined();
    expect(alarmPerception({ ...state, health: 0 }, event())).toBeUndefined();
  });

  test("directions are from listener toward sender, with rounded distance and health", async () => {
    const { state } = await fixture();
    expect(perceivedAlarmText(state, event())).toBe("Margo 34 blocks north-east: attacked by zombie, health 6/20");
    const directions = [[0, -10, "north"], [10, -10, "north-east"], [10, 0, "east"], [10, 10, "south-east"],
      [0, 10, "south"], [-10, 10, "south-west"], [-10, 0, "west"], [-10, -10, "north-west"]] as const;
    for (const [x, z, name] of directions) expect(perceivedAlarmText(state, event({ x, z }))).toContain(`blocks ${name}:`);
    expect(perceivedAlarmText(state, event({ x: 0, z: 0, y: 65, health: undefined, maxHealth: undefined })))
      .toBe("Margo 1 block above: attacked by zombie");
  });

  test("fresh body position governs waking; reception issues no controls", async () => {
    const f = await fixture();
    await f.body.poll();
    f.state.pos = { x: 100, y: 64, z: 0 }; // stale cached body position is still at origin
    const before = f.body.events.latest;
    await f.body.hearAlarm(event({ x: 0, z: 0 }));
    await f.body.hearAlarm(event({ x: 100, z: 0, dimension: "minecraft:the_nether" }));
    expect(f.body.events.latest).toBe(before);
    const wake = f.body.events.wait(1, ["alarm"]);
    const requestCursor = f.requests.length;
    await f.body.hearAlarm(event({ x: 124, z: -24 }));
    expect(await wake).toBe("Waking event received.");
    expect(f.body.events.since(before)).toEqual([`${before + 1} alarm Margo 34 blocks north-east: attacked by zombie, health 6/20`]);
    expect(f.requests.slice(requestCursor).every(r => r.path.startsWith("/state"))).toBe(true);
  });

  test("unobservable or invalid alarms are silent, including global relay log echoes", async () => {
    const f = await fixture();
    await f.body.tail.read();
    await appendFile(f.log, "[12:00:00] [Render thread/INFO]: [CHAT] <Margo shouts for help: attacked by zombie>\n");
    await f.body.tail.read();
    expect(f.body.events.latest).toBe(0);
    expect(parseLogLine("[CHAT] <Margo> hello", "Gary")?.type).toBe("chat");
    await f.body.hearAlarm({ ...event(), x: "24" });
    f.setUnavailable();
    await f.body.hearAlarm(event());
    expect(f.body.events.latest).toBe(0);
  });
});

describe("alarms seen beyond earshot", () => {
  test("only a confirmed clear sight is perceived, and the line says so; heard alarms ask nothing", async () => {
    const f = await fixture();
    const asked: string[] = [];
    let answer: boolean | null = true;
    f.body.canSee = async sender => { asked.push(sender); return answer; };
    await f.body.hearAlarm(event({ x: 30, z: 0 }));
    expect(asked).toEqual([]);
    expect(f.body.events.since(0)).toEqual(["1 alarm Margo 30 blocks east: attacked by zombie, health 6/20"]);
    await (await f.body.hearAlarm(event({ x: 80, z: 0 }))).sight;
    expect(f.body.events.since(1)).toEqual(["2 alarm Margo 80 blocks east, in sight: attacked by zombie, health 6/20"]);
    // Blocked, or unknown to the bridge: silence, as out of earshot is.
    for (answer of [false, null]) await (await f.body.hearAlarm(event({ x: 80, z: 0 }))).sight;
    // Another dimension, or past 96 blocks: the hub is not even asked.
    expect((await f.body.hearAlarm(event({ x: 80, z: 0, dimension: "minecraft:the_nether" }))).sight).toBeUndefined();
    expect((await f.body.hearAlarm(event({ x: 97, z: 0 }))).sight).toBeUndefined();
    expect(asked).toEqual(["Margo", "Margo", "Margo"]);
    expect(f.body.events.latest).toBe(2);
  });

  test("a failing or slow hub perceives nothing and never holds up the events poller", async () => {
    const f = await fixture();
    f.body.canSee = () => Promise.reject(new Error("hub down"));
    await (await f.body.hearAlarm(event({ x: 80, z: 0 }))).sight;
    f.body.canSee = () => Promise.withResolvers<boolean | null>().promise; // never answers
    const started = performance.now();
    const pending = await f.body.hearAlarm(event({ x: 80, z: 0 }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(pending.sight).toBeDefined();
    expect(f.body.events.latest).toBe(0);
    // The real client bounds the question itself: a hub that does not answer is given up on.
    const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Promise.withResolvers<Response>().promise });
    try {
      const token = `${f.dir}/token`; await Bun.write(token, "test-token");
      const client = new CommonsClient(silent.url.toString(), token);
      const asked = performance.now();
      await expect(client.sight("Margo", 200)).rejects.toThrow(/unreachable/);
      expect(performance.now() - asked).toBeLessThan(1500);
    } finally { silent.stop(true); }
  });
});

describe("automatic alarms", () => {
  test("observable triggers and reason classes; unrelated damage does not identify a mob", async () => {
    const { state } = await fixture();
    const zombie = { id: 1, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0] as [number, number, number] };
    expect(automaticAlarmReasons(state, [zombie], false)).toEqual([]);
    expect(automaticAlarmReasons(state, [], true)).toEqual([]);
    expect(automaticAlarmReasons({ ...state, health: 5, inLava: true }, [zombie, { ...zombie, type: "minecraft:creeper", fuse: true }], true))
      .toEqual([{ kind: "attacked", reason: "attacked near zombie" }, { kind: "low health", reason: "low health" },
        { kind: "creeper close", reason: "creeper close" }, { kind: "in lava", reason: "in lava" }]);
    expect(automaticAlarmReasons({ ...state, health: 6 }, [], false)).toEqual([]);
    expect(automaticAlarmReasons({ ...state, health: 0, inLava: true }, [], true)).toEqual([]);
  });

  test("an unresolved send cannot block lava rescue; local reason cooldown bounds requests", async () => {
    const f = await fixture();
    const sent: AlarmRequest[] = [];
    const pending = Promise.withResolvers<void>();
    f.body.onAlarm = input => { sent.push(input); return pending.promise; };
    try {
      await f.body.poll();
      Object.assign(f.state, { health: 5, inLava: true, onFire: true, onGround: false });
      await f.body.poll();
      expect(f.body.rescuing).toBe("lava");
      expect(sent.map(a => a.reason)).toEqual(["low health", "in lava"]);
      await f.body.poll();
      expect(sent).toHaveLength(2);
      f.tick(30_000);
      await f.body.poll();
      expect(sent.map(a => a.reason)).toEqual(["low health", "in lava", "low health", "in lava"]);
    } finally { pending.resolve(); }
  }, 3000);

  test("reflex damage and creeper sensing reach the automatic hook", async () => {
    const f = await fixture();
    const sent: AlarmRequest[] = [];
    f.body.onAlarm = async input => { sent.push(input); };
    await f.body.poll();
    f.state.nearbyEntities = [{ id: 1, type: "minecraft:zombie", hostile: true, distance: 2, pos: [2, 64, 0] }];
    f.state.health = 18;
    await f.body.poll();
    expect(sent.some(a => a.reason === "attacked near zombie" && a.kind === "auto")).toBe(true);
    f.state.nearbyEntities = [{ id: 2, type: "minecraft:creeper", hostile: true, distance: 3, pos: [3, 64, 0] }];
    f.tick(1000);
    await f.body.poll();
    expect(sent.some(a => a.reason === "creeper close")).toBe(true);
  });

  test("hub unreachable leaves lava rescue and body tools working", async () => {
    const hub = residentHub();
    const identity = hub.identity();
    const f = await fixture(identity);
    try {
      hub.disconnect();
      await f.body.poll();
      Object.assign(f.state, { inLava: true, onFire: true, onGround: false });
      await f.body.poll();
      expect(f.body.rescuing).toBe("lava");
      const result = await f.tools.run("alarm", { reason: "help" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("unreachable");
      const status = await f.tools.call("status", {});
      expect(status.isError).not.toBe(true);
      expect(f.body.error).toBeUndefined();
      expect(f.body.events.since(0).join("\n")).not.toContain("Commons");
    } finally { f.tools.close(); hub.close(); }
  });
});

test("manual tool -> authenticated hub -> poller -> local waking alarm, never raw remote events", async () => {
  const hub = residentHub();
  const gary = hub.identity("Gary"), margo = hub.identity("Margo");
  const sender = await fixture({ ...margo, name: "Margo" });
  const listener = await fixture({ ...gary, name: "Gary" });
  try {
    // Real Synapse positions also carry `block`; the hub's strict alarm schema must still accept the call.
    sender.state.pos = { x: 24, y: 64, z: -24, block: [24, 64, -24] } as typeof sender.state.pos;
    sender.state.health = 6;
    // All other remote alarms must be consumed silently before the in-range one.
    hub.api.events.publish("Gary", "alarm", event({ x: 1000 }));
    hub.api.events.publish("Gary", "alarm", event({ dimension: "minecraft:the_nether" }));
    const wake = listener.body.events.wait(2, ["alarm"]);
    const result = await sender.tools.call("alarm", { reason: "attacked by zombie" });
    expect(result.isError).not.toBe(true);
    expect(await wake).toBe("Waking event received.");
    expect(listener.body.events.since(0)).toEqual(["1 alarm Margo 34 blocks north-east: attacked by zombie, health 6/20"]);
    const limited = await sender.tools.run("alarm", { reason: "help again" });
    expect(limited.isError).toBe(true);
    expect(limited.text).toMatch(/wait|limit|seconds/i);
    expect(alarmFromState("manual", "help", sender.state).x).toBe(24);
  } finally { sender.tools.close(); listener.tools.close(); hub.close(); }
});

test("seen through the hub: the listener asks about its own sight, and the bridge's answer decides", async () => {
  const paths: string[] = [];
  let visible: boolean | null = true;
  const hub = residentHub({ sight: { source: { url: "http://observer.invalid", tokenFile: "/nonexistent" }, timeoutMs: 500, get: async (_source, path) => {
    paths.push(path);
    return { ok: true, receivedAt: Date.now(), data: { schema: 1, source: "server-observer", servedAtMs: Date.now(), state: "ok", sight: { visible, distance: 80, reason: visible ? "clear" : "blocked" } } };
  } } });
  const gary = hub.identity("Gary"), margo = hub.identity("Margo");
  const sender = await fixture({ ...margo, name: "Margo" });
  const listener = await fixture({ ...gary, name: "Gary" });
  try {
    sender.state.pos = { x: 80, y: 64, z: 0 }; sender.state.health = 6;
    const wake = listener.body.events.wait(3, ["alarm"]);
    expect((await sender.tools.call("alarm", { reason: "attacked by zombie" })).isError).not.toBe(true);
    expect(await wake).toBe("Waking event received.");
    expect(listener.body.events.since(0)).toEqual(["1 alarm Margo 80 blocks east, in sight: attacked by zombie, health 6/20"]);
    expect(paths).toEqual(["/v1/sight?from=Gary&to=Margo"]);
    // Blocked: the same alarm a moment later reaches nobody.
    visible = false;
    const result = await listener.body.hearAlarm(event({ x: 80, z: 0 }));
    await result.sight;
    expect(paths).toHaveLength(2);
    expect(listener.body.events.latest).toBe(1);
  } finally { sender.tools.close(); listener.tools.close(); hub.close(); }
});
