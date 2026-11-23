import { describe, expect, test } from "bun:test";
import type { FluidHit, State } from "../src/synapse.ts";
import { fixture } from "./fake-synapse.ts";

const stone = (face = "up"): State["lookingAt"] => ({ type: "block", block: "minecraft:stone", blockPos: [3, 63, 0], face });
const sign = { slot: 0, count: 3, item: "minecraft:birch_sign" };
const water = (blockPos: number[], source = true): FluidHit => ({ fluid: "minecraft:water", source, blockPos, face: "up" });

describe("write_sign", () => {
  test("crouches before the click and aims again at the same face from the lowered eye", async () => {
    const f = await fixture(); f.state.hotbar = [{ ...sign }]; f.state.lookingAt = stone("north");
    const reply = await f.tools.run("write_sign", { lines: ["WEST PASTURE"] });
    expect(reply.text).toBe("Placed the sign at 3,63,-1 on the north face of minecraft:stone at 3,63,0; entered 1 line; editor closed (Done). Text persistence is server-controlled.");
    const actions = f.requests.filter(r => r.path === "/player").map(r => r.body.action);
    expect(actions.indexOf("move")).toBeLessThan(actions.indexOf("use"));
    expect(actions.lastIndexOf("look")).toBeLessThan(actions.indexOf("use"));
    expect(actions.lastIndexOf("release")).toBeGreaterThan(actions.indexOf("use"));
    expect(f.requests.find(r => r.body.action === "move")?.body).toEqual({ action: "move", sneak: true, ticks: 40 });
    // The face centre, not the block centre: just inside the north face, at the crouched eye's new height.
    const look = f.requests.filter(r => r.body.action === "look").at(-1)!.body;
    expect(look.pitch as number).toBeGreaterThan(0);
  });

  test("a barrel or chest takes the sign instead of opening (Gary's 'ContainerScreen' failures)", async () => {
    const f = await fixture(); f.state.hotbar = [{ ...sign }];
    f.state.lookingAt = { type: "block", block: "minecraft:barrel", blockPos: [109, 121, -208], face: "east" };
    expect((await f.tools.run("write_sign", { lines: ["Shared iron"] })).text).toStartWith("Placed the sign at 110,121,-208 on the east face of minecraft:barrel at 109,121,-208");
    expect(f.state.screen).toBe("none");
  });

  test("nothing placed says which face and space, and that the sign stayed in hand", async () => {
    const f = await fixture({ signPlacement: "nothing" }); f.tools.signWaitMs = 200;
    f.state.hotbar = [{ ...sign }]; f.state.lookingAt = { type: "block", block: "minecraft:grass_block", blockPos: [122, 116, -206], face: "south" };
    const reply = await f.tools.run("write_sign", { lines: ["Wind bread"] });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("Nothing was placed on the south face of minecraft:grass_block at 122,116,-206: the sign stayed in your hand. The space at 122,116,-205 must be free");
    expect(f.state.hotbar[0]?.count).toBe(3);
  });

  test("a sign used up without an editor is reported as a blank sign, with where it probably is", async () => {
    const f = await fixture({ signPlacement: "blank" }); f.tools.signWaitMs = 200;
    f.state.hotbar = [{ ...sign }]; f.state.lookingAt = stone();
    const reply = await f.tools.run("write_sign", { lines: ["WIND BREAD"] });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("A sign left your hand but no editor opened, so it is blank, probably at 3,64,0.");
  });

  test("an existing sign, a vehicle seat, or no block in reach is refused before anything is pressed", async () => {
    const f = await fixture(); f.state.hotbar = [{ ...sign }];
    f.state.lookingAt = { type: "block", block: "minecraft:birch_wall_sign", blockPos: [1, 64, 0], face: "west" };
    expect((await f.tools.run("write_sign", { lines: ["x"] })).text).toContain("minecraft:birch_wall_sign at 1,64,0 is a sign already");
    f.state.lookingAt = { type: "miss" };
    expect((await f.tools.run("write_sign", { lines: ["x"] })).text).toContain("nothing is in reach");
    f.state.lookingAt = stone(); f.state.riding = true;
    expect((await f.tools.run("write_sign", { lines: ["x"] })).text).toContain("Get off the vehicle first");
    expect(f.requests.some(r => r.path === "/player" && (r.body.action === "use" || r.body.action === "move"))).toBe(false);
  });
});

describe("look sees fluids", () => {
  test("a water source under the crosshair is named, with what lies behind it (Wren's spill)", async () => {
    const f = await fixture();
    f.state.lookingAt = { ...stone(), block: "minecraft:dirt", blockPos: [49, 113, -185], fluidsChecked: true, fluid: water([49, 114, -185]), fluidSource: water([49, 114, -185]) };
    expect((await f.tools.run("look", { x: 49, y: 114, z: -185 })).text).toBe("Looking at minecraft:water at 49,114,-185 (a source block: an empty bucket takes it); behind it minecraft:dirt at 49,113,-185.");
  });

  test("flowing water is not a bucketful; a source behind it is named", async () => {
    const f = await fixture();
    f.state.lookingAt = { type: "miss", fluidsChecked: true, fluid: water([49, 114, -186], false) };
    expect((await f.tools.run("look", { x: 49, y: 114, z: -186 })).text).toBe("Looking at minecraft:water at 49,114,-186 (flowing, not a source block: a bucket cannot take it).");
    f.state.lookingAt = { type: "miss", fluidsChecked: true, fluid: water([49, 114, -186], false), fluidSource: water([49, 114, -185]) };
    expect((await f.tools.run("look", { x: 49, y: 114, z: -185 })).text).toBe("Looking at minecraft:water at 49,114,-185 (a source block: an empty bucket takes it); minecraft:water (flowing) at 49,114,-186 is in front of it.");
  });

  test("a block seen through water says the fluid comes first; a build without fluid reports says it is blind to them", async () => {
    const f = await fixture();
    f.state.lookingAt = { ...stone(), fluidsChecked: true, fluid: water([3, 64, 0]) };
    expect((await f.tools.run("look", { x: 3, y: 63, z: 0 })).text).toBe("Looking at minecraft:stone at 3,63,0. minecraft:water source at 3,64,0 is in front of it, and a bucket acts on the fluid first.");
    f.state.lookingAt = { type: "miss" };
    expect((await f.tools.run("look", { x: 49, y: 114, z: -185 })).text).toContain("This body does not report fluids under the crosshair");
  });
});

describe("use with a bucket", () => {
  test("an empty bucket says which source it took", async () => {
    const f = await fixture({ onUse: state => { if (state.lookingAt.fluidSource) state.hotbar = [{ slot: 4, count: 1, item: "minecraft:water_bucket" }]; } });
    f.state.selectedSlot = 4; f.state.hotbar = [{ slot: 4, count: 1, item: "minecraft:bucket" }];
    f.state.lookingAt = { ...stone(), fluidsChecked: true, fluid: water([49, 114, -185]), fluidSource: water([49, 114, -185]) };
    expect((await f.tools.run("use", {})).text).toBe("Picked up minecraft:water from 49,114,-185, the first source block on your line; your hand now holds minecraft:water_bucket.");
  });

  test("an empty bucket aimed at flowing water takes nothing and says why", async () => {
    const f = await fixture();
    f.state.selectedSlot = 4; f.state.hotbar = [{ slot: 4, count: 1, item: "minecraft:bucket" }];
    f.state.lookingAt = { ...stone(), block: "minecraft:dirt", blockPos: [49, 113, -185], fluidsChecked: true, fluid: water([49, 114, -186], false) };
    expect((await f.tools.run("use", {})).text).toBe("Nothing was picked up: no source block of a fluid lies on your line within reach; minecraft:water (flowing) at 49,114,-186 is not one, and a bucket only takes a source block. Look at a source block first (look x,y,z says whether it is one).");
  });

  test("a full bucket says where the water went, or that it stayed full", async () => {
    const f = await fixture({ onUse: state => { state.hotbar = [{ slot: 4, count: 1, item: "minecraft:bucket" }]; } });
    f.state.selectedSlot = 4; f.state.hotbar = [{ slot: 4, count: 1, item: "minecraft:water_bucket" }];
    f.state.lookingAt = { type: "block", block: "minecraft:grass_block", blockPos: [49, 113, -185], face: "up", fluidsChecked: true };
    expect((await f.tools.run("use", {})).text).toBe("Poured minecraft:water at 49,114,-185 against the up face of minecraft:grass_block at 49,113,-185 (or into that block itself if it holds water, like a slab or stairs); your hand now holds minecraft:bucket.");
    const kept = await fixture();
    kept.state.selectedSlot = 4; kept.state.hotbar = [{ slot: 4, count: 1, item: "minecraft:water_bucket" }];
    kept.state.lookingAt = { type: "miss", fluidsChecked: true };
    expect((await kept.tools.run("use", {})).text).toStartWith("The bucket stayed full: nothing is in reach to pour against");
  });

  test("a boat in the sights is refused rather than boarded (Wren's chest boat); a cow is still milked", async () => {
    const f = await fixture();
    f.state.selectedSlot = 4; f.state.hotbar = [{ slot: 4, count: 1, item: "minecraft:bucket" }];
    f.state.nearbyEntities = [{ id: 7, type: "minecraft:chest_boat", pos: [21, 62, -121], distance: 2, mountable: true }, { id: 8, type: "minecraft:cow", pos: [20, 62, -121], distance: 2 }];
    f.state.lookingAt = { type: "entity", entity: "minecraft:chest_boat", entityId: 7 };
    const refused = await f.tools.run("use", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("minecraft:chest_boat is in your sights, so use would act on it (board it or interact), not on the fluid. Nothing was used.");
    expect(f.requests.some(r => r.body.action === "use")).toBe(false);
    f.state.lookingAt = { type: "entity", entity: "minecraft:cow", entityId: 8 };
    expect((await f.tools.run("use", {})).isError).toBe(false);
    expect(f.requests.some(r => r.body.action === "use")).toBe(true);
  });
});
