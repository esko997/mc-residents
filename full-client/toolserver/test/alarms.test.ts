import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { alarmFromState, automaticAlarmReasons, canPerceiveAlarm, perceivedAlarmText } from "../src/alarms.ts";
import { parseLogLine } from "../src/events.ts";
import type { AlarmEvent, AlarmRequest } from "../../commons/src/resident-contracts-alarm.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";
import { fixture } from "./fake-synapse.ts";

const event = (fields: Partial<AlarmEvent> = {}): AlarmEvent => ({
  sender: "Margo", kind: "manual", reason: "attacked by zombie", x: 24, y: 64, z: -24,
  dimension: "minecraft:overworld", health: 6, maxHealth: 20, at: Date.now(), ...fields,
});

describe("alarm perception", () => {
  test("48-block sphere includes height, excludes other dimensions and dead listeners", async () => {
    const { state } = await fixture();
    expect(canPerceiveAlarm(state, event({ x: 48, z: 0 }))).toBe(true);
    expect(canPerceiveAlarm(state, event({ x: 49, z: 0 }))).toBe(false);
    expect(canPerceiveAlarm(state, event({ x: 0, y: 112, z: 0 }))).toBe(true);
    expect(canPerceiveAlarm(state, event({ x: 0, y: 113, z: 0 }))).toBe(false);
    expect(canPerceiveAlarm(state, event({ x: 40, y: 104, z: 0 }))).toBe(false);
    expect(canPerceiveAlarm(state, event({ dimension: "minecraft:the_nether" }))).toBe(false);
    expect(canPerceiveAlarm({ ...state, health: 0 }, event())).toBe(false);
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
    sender.state.pos = { x: 24, y: 64, z: -24 };
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
