import { describe, expect, test } from "bun:test";
import { describeVehicle, vehicleDefinitions, vehicleStatusLine, Vehicles, type Pause, type VehicleApi, type VehicleSnapshot, type VehicleState } from "../src/vehicles.ts";
import { vehicleGuides } from "../src/vehicle-guides.ts";

const boat = (over: Partial<VehicleSnapshot> = {}): VehicleSnapshot => ({
  type: "minecraft:boat", id: 34, family: "boat", controlling: true, seat: 0, passengers: 1,
  onGround: false, inWater: true, pos: { x: 10, y: 62, z: -5 }, velocity: { x: 0, y: 0, z: 0 }, speed: 0, yaw: 0,
  dropBelow: 0, dismount: "sneak", supported: true, ...over,
});
const biplane = (over: Partial<VehicleSnapshot> = {}): VehicleSnapshot => boat({
  type: "immersive_aircraft:biplane", id: 77, family: "airplane", inWater: false, dismount: "aircraft_key",
  aircraftVersion: "1.4.0+1.20.1", ...over,
});
const onFoot = (over: Partial<VehicleState> = {}): VehicleState => ({ pos: { x: 0, y: 64, z: 0 }, screen: "none", riding: false, ...over });

/** Scripted Synapse: each /player action answers from `replies`; every request is recorded. */
function fake(replies: Record<string, Record<string, unknown>>, states: VehicleState[] = []) {
  const calls: Record<string, unknown>[] = [];
  const api: VehicleApi = {
    async player(body) {
      calls.push(body as Record<string, unknown>);
      const action = "action" in body ? String(body.action) : "";
      const reply = replies[action];
      if (!reply) throw new Error(`Synapse: unexpected ${action}`);
      return reply;
    },
    async state() {
      const next = states.shift();
      if (!next) throw new Error("Synapse unreachable");
      return next;
    },
  };
  return { api, calls };
}
const instant: Pause = async () => {};

describe("boarding", () => {
  test("a confirmed boarding names the vehicle and how to steer it, from one bounded request", async () => {
    const { api, calls } = fake({ mount: { sent: true, mounted: true, interaction: "SUCCESS", target: { type: "minecraft:boat", id: 34, distance: 2.1, passengers: 0 }, riding: true, vehicle: boat(), waitedTicks: 3 } });
    const text = await new Vehicles(api, instant).run("mount", { entity_id: 34 });
    expect(calls).toEqual([{ action: "mount", entityId: 34, waitTicks: 40 }]);
    expect(text).toContain("Boarded minecraft:boat #34");
    expect(text).toContain("you steer it");
    expect(text).toContain("forward/backward/left/right");
  });

  test("an unconfirmed boarding is reported as not riding and is not retried", async () => {
    const { api, calls } = fake({ mount: { sent: true, mounted: false, interaction: "CONSUME", target: { type: "immersive_aircraft:biplane", id: 77, distance: 2, passengers: 0 }, riding: false, waitedTicks: 40, screen: "none" } });
    const text = await new Vehicles(api, instant).run("mount", { entity_id: 77 });
    expect(calls).toHaveLength(1);
    expect(text).toContain("not riding it after 40 ticks");
    expect(text).toContain("repaired by use");
    expect(text).toContain("Not repeated");
  });

  test("a vehicle out of reach is never used", async () => {
    const { api } = fake({ mount: { sent: false, mounted: false, reason: "not_in_reach", inSights: "minecraft:oak_log at 1,64,2", target: { type: "minecraft:minecart", id: 9, distance: 6.5, passengers: 0 } } });
    const text = await new Vehicles(api, instant).run("mount", { entity_id: 9 });
    expect(text).toContain("Did not use minecraft:minecart #9");
    expect(text).toContain("minecraft:oak_log");
  });
});

describe("leaving", () => {
  test("airborne aircraft exit is refused without confirmation, pressing nothing and naming the fall", async () => {
    const before = biplane({ onGround: false, dropBelow: 23.4 });
    const { api, calls } = fake({ dismount: { action: "dismount", method: "aircraft_key", pressed: 0, dismounted: false, refused: "airborne_unconfirmed", before } });
    const text = await new Vehicles(api, instant).run("dismount", {});
    expect(calls).toEqual([{ action: "dismount", confirmAirborne: false, waitTicks: 40 }]);
    expect(text).toContain("Nothing was pressed");
    expect(text).toContain("23.4 blocks");
    expect(text).toContain("fly on without a pilot");
    expect(text).toContain("confirm_airborne: true");
  });

  test("a confirmed airborne exit is passed through and reported by read-back, not by the press", async () => {
    const before = biplane({ onGround: false, dropBelow: 12 });
    const { api, calls } = fake({ dismount: { method: "aircraft_key", pressed: 2, dismounted: true, before, riding: false, pos: { x: 3, y: 70, z: 4 }, onGround: false, waitedTicks: 4 } });
    const text = await new Vehicles(api, instant).run("dismount", { confirm_airborne: true });
    expect(calls[0]).toMatchObject({ confirmAirborne: true });
    expect(text).toContain("Left immersive_aircraft:biplane #77 by its dismount key (pressed 2x)");
    expect(text).toContain("not yet on the ground");
  });

  test("a confirmed airborne exit whose second press was skipped reports why and claims no exit", async () => {
    const before = biplane({ onGround: false, dropBelow: 15 });
    const { api, calls } = fake({ dismount: { method: "aircraft_key", pressed: 1, secondPressSkipped: "screen_opened", dismounted: false, before, riding: true, vehicle: before, waitedTicks: 40 } });
    const text = await new Vehicles(api, instant).run("dismount", { confirm_airborne: true });
    expect(calls).toHaveLength(1);
    expect(text).toContain("pressed 1x");
    expect(text).toContain("second press was not sent because a screen opened");
    expect(text).not.toContain("Left ");
  });

  test("still riding after the attempt says so instead of claiming success", async () => {
    const { api } = fake({ dismount: { method: "sneak", pressed: 0, dismounted: false, before: boat(), riding: true, vehicle: boat(), waitedTicks: 40 } });
    const text = await new Vehicles(api, instant).run("dismount", {});
    expect(text).toContain("still ride it after 40 ticks");
    expect(text).not.toContain("Left ");
  });
});

describe("steering", () => {
  test("holds for hold_ticks, waits them out, and reports the observed movement", async () => {
    const start = biplane({ onGround: true, pos: { x: 0, y: 70, z: 0 } });
    const waits: number[] = [];
    const { api, calls } = fake(
      { vehicleControl: { holding: ["up", "push"], ticks: 60, mode: "keys", vehicle: start } },
      [onFoot({ riding: true, vehicle: biplane({ onGround: false, dropBelow: 4, speed: 18, pos: { x: 30, y: 74, z: 0 } }) })],
    );
    const text = await new Vehicles(api, async ms => { waits.push(ms); }).run("vehicle_control", { controls: ["up", "push"], hold_ticks: 60 });
    expect(calls).toEqual([{ action: "vehicleControl", controls: ["up", "push"], ticks: 60 }]);
    expect(waits[0]).toBeGreaterThanOrEqual(60 * 50);
    expect(text).toContain("moved 30.3 blocks (+4 up)");
    expect(text).toContain("airborne, 4 blocks above the surface");
  });

  test("an aborted hold is released at once", async () => {
    const { api, calls } = fake({ vehicleControl: { holding: ["forward"], ticks: 200, mode: "input", vehicle: boat() }, release: { released: ["move"] } });
    const abort: Pause = async () => { throw new Error("aborted"); };
    const text = await new Vehicles(api, abort).run("vehicle_control", { controls: ["forward"], hold_ticks: 200 });
    expect(calls.at(-1)).toEqual({ action: "release" });
    expect(text).toContain("released");
  });

  test("leaving the vehicle during a hold is reported, not described as movement", async () => {
    const { api } = fake({ vehicleControl: { holding: ["forward"], ticks: 20, mode: "input", vehicle: boat() } }, [onFoot()]);
    const text = await new Vehicles(api, instant).run("vehicle_control", { controls: ["forward"], hold_ticks: 20 });
    expect(text).toContain("no longer ride minecraft:boat #34");
  });

  test("schemas refuse sneak as a control, unbounded holds and loose confirmation values", () => {
    const control = vehicleDefinitions.vehicle_control.schema;
    expect(control.safeParse({ controls: ["sneak"], hold_ticks: 10 }).success).toBe(false);
    expect(control.safeParse({ controls: [], hold_ticks: 10 }).success).toBe(false);
    expect(control.safeParse({ controls: ["up"], hold_ticks: 0 }).success).toBe(false);
    expect(control.safeParse({ controls: ["up"], hold_ticks: 201 }).success).toBe(false);
    expect(control.safeParse({ controls: ["up"], hold_ticks: 20, ticks: 20 }).success).toBe(false);
    expect(vehicleDefinitions.dismount.schema.safeParse({ confirm_airborne: "yes" }).success).toBe(false);
    expect(vehicleDefinitions.mount.schema.safeParse({ entity_id: 3.5 }).success).toBe(false);
  });
});

describe("read-back", () => {
  test("vehicle lists only mountable entities near you and what you ride", async () => {
    const { api } = fake({}, [onFoot({
      riding: true, vehicle: boat(),
      nearbyEntities: [
        { id: 34, type: "minecraft:boat", pos: [10, 62, -5], distance: 0.5, mountable: true, passengers: 1 },
        { id: 35, type: "minecraft:minecart", pos: [12, 64, -5], distance: 2.25, mountable: true },
        { id: 36, type: "minecraft:chest_minecart", pos: [13, 64, -5], distance: 3 },
        { id: 37, type: "minecraft:cow", pos: [9, 64, -5], distance: 1, health: 10 },
      ],
    })]);
    const text = await new Vehicles(api, instant).run("vehicle", {});
    expect(text).toContain("Riding minecraft:boat #34 (boat)");
    expect(text).toContain("minecraft:minecart #35 at 12,64,-5 (2.25m, empty)");
    expect(text).not.toContain("#36");
    expect(text).not.toContain("#37");
    expect(text.match(/#34/g)).toHaveLength(1);
  });

  test("status line distinguishes on foot, passenger seats and unsupported exits", () => {
    expect(vehicleStatusLine(onFoot())).toBeUndefined();
    expect(describeVehicle(boat({ controlling: false, seat: 1, passengers: 2 }))).toContain("passenger (seat 2 of 2)");
    expect(describeVehicle(biplane({ onGround: false, dropBelow: null }))).toContain("ground not in sight");
    expect(describeVehicle(boat({ dismount: "unsupported", supported: false, unsupportedReason: "Immersive Aircraft 1.5.0 is installed" })))
      .toContain("no supported way to leave it: Immersive Aircraft 1.5.0");
  });
});

describe("vehicle guide", () => {
  test("names only vehicle tools that exist, so a renamed tool cannot leave stale instructions", () => {
    const text = vehicleGuides.flatMap(guide => guide.sections.flatMap(section => section.paragraphs)).join("\n");
    const named = text.match(/\bvehicle_[a-z]+\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(Object.keys(vehicleDefinitions)).toContain(tool);
  });

  test("sections have unique navigable ids and provenance", () => {
    for (const guide of vehicleGuides) {
      const ids = guide.sections.map(section => section.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const section of guide.sections) {
        expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(section.source ?? guide.source).toBeTruthy();
      }
    }
  });
});
