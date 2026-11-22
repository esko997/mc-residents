import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { Place } from "../src/notes.ts";
import { PlacePictures } from "../src/place-pictures.ts";
import type { Reach } from "../src/synapse.ts";
import { fakeSynapse, png, tempHome } from "./helpers.ts";

const place: Place = { name: "orchard", author: "Gary", x: 10, y: 64, z: 20, dimension: "minecraft:overworld" };
const world = () => ({ pos: { x: 10, y: 64, z: 20 }, dimension: "minecraft:overworld", health: 20, screen: "none" });

function setup() {
  const home = tempHome(), config = home.config();
  const runtime = { now: Date.parse("2026-11-22T20:00:00Z"), state: world(), shots: 0,
    fail: false, image: Buffer.from(png()).toString("base64"), onImage: () => {} };
  const get = async (_resident: unknown, path: string): Promise<Reach> => {
    if (path.startsWith("/state")) return { ok: true, data: runtime.state };
    runtime.shots++;
    runtime.onImage();
    return runtime.fail ? { ok: false, status: "offline", detail: "offline" } : { ok: true, data: { image: runtime.image } };
  };
  const store = new PlacePictures(config, () => runtime.now, get);
  const save = (places: Place[], at = runtime.now, shared = false) => {
    const path = home.put(shared ? "resident/shared/places.json" : "resident/gary/places.json", JSON.stringify({ places, deaths: [] }));
    utimesSync(path, at / 1000, at / 1000);
  };
  return { home, config, runtime, get, store, save };
}

test("startup baselines old points; a new save captures and survives restart without recapturing", async () => {
  const h = setup();
  try {
    h.save([place]);
    await h.store.sample();
    expect(h.runtime.shots).toBe(0);
    expect(h.store.forPlace(await h.store.mapPictures(), "Gary", place)).toBeNull();
    h.runtime.now += 1000;
    const changed = { ...place, note: "planted today" };
    h.save([changed]);
    await h.store.sample();
    const picture = h.store.forPlace(await h.store.mapPictures(), "Gary", changed)!;
    expect(picture).toMatchObject({ resident: "Gary", at: h.runtime.now });
    expect(picture.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await h.store.read(picture.id)).toEqual(png());
    const restarted = new PlacePictures(h.config, () => h.runtime.now, h.get);
    await restarted.sample();
    expect(h.runtime.shots).toBe(1);
    expect(restarted.forPlace(await restarted.mapPictures(), "Gary", changed)).toEqual(picture);
    expect(restarted.forPlace(await restarted.mapPictures(), "Gary", place)).toBeNull();
    h.save([]);
    await restarted.sample();
    expect(await restarted.read(picture.id)).toBeNull();
    expect(readdirSync(`${h.config.dbPath}.place-pictures`)).toEqual([]);
  } finally { h.home.remove(); }
});

test("restart baselines saves made while stopped; it does not invent a historical picture", async () => {
  const h = setup();
  try {
    h.save([]);
    await h.store.sample();
    h.save([place]);
    const restarted = new PlacePictures(h.config, () => h.runtime.now, h.get);
    await restarted.sample();
    expect(h.runtime.shots).toBe(0);
    expect(restarted.forPlace(await restarted.mapPictures(), "Gary", place)).toBeNull();
  } finally { h.home.remove(); }
});

for (const [label, delta, captures] of [["30 seconds old", -30_000, 1], ["too old", -30_001, 0], ["future dated", 1000, 0]] as const) {
  test(`save timing: ${label}`, async () => {
    const h = setup();
    try {
      h.save([]);
      await h.store.sample();
      h.save([place], h.runtime.now + delta);
      await h.store.sample();
      expect(h.runtime.shots).toBe(captures);
      expect(h.store.forPlace(await h.store.mapPictures(), "Gary", place) !== null).toBe(captures === 1);
    } finally { h.home.remove(); }
  });
}

for (const reason of ["moved", "dimension", "gui", "dead", "disconnected", "delayed", "resaved", "failed", "oversized", "bad png"] as const) {
  test(`capture discarded when ${reason} during image read`, async () => {
    const h = setup();
    try {
      h.save([]);
      await h.store.sample();
      h.save([place]);
      h.runtime.onImage = () => {
        if (reason === "moved") h.runtime.state.pos.x += 13;
        if (reason === "dimension") h.runtime.state.dimension = "minecraft:the_nether";
        if (reason === "gui") h.runtime.state.screen = "InventoryScreen";
        if (reason === "dead") h.runtime.state.health = 0;
        if (reason === "disconnected") Object.assign(h.runtime.state, { inWorld: false });
        if (reason === "delayed") h.runtime.now += 30_001;
        if (reason === "resaved") h.save([{ ...place, note: "changed during capture" }]);
        if (reason === "failed") h.runtime.fail = true;
        if (reason === "oversized") h.runtime.image = "A".repeat(3 * 1024 * 1024);
        if (reason === "bad png") h.runtime.image = Buffer.from("not an image").toString("base64");
      };
      await h.store.sample();
      expect(h.runtime.shots).toBe(1);
      expect(h.store.forPlace(await h.store.mapPictures(), "Gary", place)).toBeNull();
      expect(readdirSync(`${h.config.dbPath}.place-pictures`)).toEqual([]);
    } finally { h.home.remove(); }
  });
}

test("remote saves and unknown shared authors do not trigger screenshots", async () => {
  const h = setup();
  try {
    h.save([]);
    h.save([], h.runtime.now, true);
    await h.store.sample();
    h.save([{ ...place, x: 100 }]);
    h.save([{ ...place, author: "visitor" }], h.runtime.now, true);
    await h.store.sample();
    expect(h.runtime.shots).toBe(0);
  } finally { h.home.remove(); }
});

test("superseded pictures disappear immediately; capture failure never falls back to them", async () => {
  const h = setup();
  try {
    h.save([]);
    await h.store.sample();
    h.save([place]);
    await h.store.sample();
    const picture = h.store.forPlace(await h.store.mapPictures(), "Gary", place)!;
    const changed = { ...place, note: "new note" };
    h.save([changed]);
    expect(await h.store.read(picture.id)).toBeNull();
    expect(h.store.forPlace(await h.store.mapPictures(), "Gary", changed)).toBeNull();
    h.runtime.fail = true;
    await h.store.sample();
    expect(h.store.forPlace(await h.store.mapPictures(), "Gary", changed)).toBeNull();
    expect(readdirSync(`${h.config.dbPath}.place-pictures`)).toEqual([]);
  } finally { h.home.remove(); }
});

test("shared saves use their configured author; unchanged rewrites are not new saves", async () => {
  const h = setup();
  try {
    h.save([], h.runtime.now, true);
    await h.store.sample();
    h.save([place], h.runtime.now, true);
    await h.store.sample();
    expect(h.store.forPlace(await h.store.mapPictures(), "shared", place)?.resident).toBe("Gary");
    h.runtime.now += 1000;
    h.save([place], h.runtime.now, true);
    await h.store.sample();
    expect(h.runtime.shots).toBe(1);
  } finally { h.home.remove(); }
});

test("missing files, traversal, symlinks and a symlinked picture directory never serve bytes", async () => {
  const h = setup();
  try {
    h.save([]);
    await h.store.sample();
    h.save([place]);
    await h.store.sample();
    const picture = h.store.forPlace(await h.store.mapPictures(), "Gary", place)!;
    const directory = `${h.config.dbPath}.place-pictures`, path = join(directory, `${picture.id}.json`);
    expect(await h.store.read("../../synapse-token")).toBeNull();
    const outside = join(h.home.dir, "outside");
    mkdirSync(outside);
    renameSync(path, join(outside, `${picture.id}.json`));
    expect(h.store.forPlace(await h.store.mapPictures(), "Gary", place)).toBeNull();
    symlinkSync(join(outside, `${picture.id}.json`), path);
    expect(await h.store.read(picture.id)).toBeNull();
    expect(h.store.forPlace(await h.store.mapPictures(), "Gary", place)).toBeNull();
    unlinkSync(path);
    renameSync(directory, `${directory}.old`);
    symlinkSync(outside, directory);
    expect(await h.store.read(picture.id)).toBeNull();
    const restarted = new PlacePictures(h.config, () => h.runtime.now, h.get);
    await restarted.sample();
    expect(await restarted.read(picture.id)).toBeNull();
  } finally { h.home.remove(); }
});

test("retention expires pictures and removes saves deleted while the dashboard was stopped", async () => {
  const h = setup();
  try {
    h.save([]);
    await h.store.sample();
    h.save([place]);
    await h.store.sample();
    const picture = h.store.forPlace(await h.store.mapPictures(), "Gary", place)!;
    h.runtime.now += 30 * 86_400_000 + 1;
    expect(await h.store.read(picture.id)).toBeNull();
    await h.store.sample();
    expect(readdirSync(`${h.config.dbPath}.place-pictures`)).toEqual([]);
    h.save([{ ...place, note: "checked again" }]);
    await h.store.sample();
    h.save([]);
    const restarted = new PlacePictures(h.config, () => h.runtime.now, h.get);
    await restarted.sample();
    expect(readdirSync(`${h.config.dbPath}.place-pictures`)).toEqual([]);
  } finally { h.home.remove(); }
});

test("map pictures require the dashboard token and return PNG, never an arbitrary file", async () => {
  const home = tempHome(), clock = Date.parse("2026-11-22T20:00:00Z");
  const fake = fakeSynapse({ state: world() });
  const config = home.config({ GARY_SYNAPSE_URL: fake.url });
  const app = createApp(config, "picture-test-token", () => clock, () => {});
  const request = (path: string, token = "picture-test-token") => app.fetch(new Request(`http://commons.test/${token}/api/${path}`));
  try {
    await app.watcher.placePictures.sample();
    const path = home.put("resident/gary/places.json", JSON.stringify({ places: [place], deaths: [] }));
    utimesSync(path, clock / 1000, clock / 1000);
    await app.watcher.placePictures.sample();
    const map = await (await request("map")).json();
    const picture = map.places[0].picture;
    expect(picture.resident).toBe("Gary");
    expect((await request(`map-picture?id=${picture.id}`, "incorrect-token")).status).toBe(404);
    expect((await request(`map-picture?id=${picture.id}`, "")).status).toBe(404);
    expect((await request("map-picture?id=..%2F..%2Ftoken")).status).toBe(404);
    const response = await request(`map-picture?id=${picture.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());
    unlinkSync(join(`${config.dbPath}.place-pictures`, `${picture.id}.json`));
    expect((await request(`map-picture?id=${picture.id}`)).status).toBe(404);
    expect((await (await request("map")).json()).places[0].picture).toBeNull();
  } finally { app.stop(); fake.stop(); home.remove(); }
});

test("pending place capture is single-flight without delaying fresh resident observations", async () => {
  const home = tempHome(), fake = fakeSynapse({ state: world() });
  let clock = Date.parse("2026-11-22T20:00:00Z"), captures = 0;
  const app = createApp(home.config({ GARY_SYNAPSE_URL: fake.url }), "picture-test-token", () => clock, () => {});
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  app.watcher.placePictures.sample = () => { captures++; return pending; };
  try {
    await app.watcher.sample();
    expect(app.watcher.sighting("Gary")).toMatchObject({ status: "online", checkedAt: clock });
    clock += 1000;
    fake.state.pos = { x: 15, y: 64, z: 20 };
    await app.watcher.sample();
    expect(app.watcher.sighting("Gary")).toMatchObject({
      status: "online", checkedAt: clock, state: { pos: { x: 15, y: 64, z: 20 } },
    });
    expect(captures).toBe(1);
    release();
    await pending;
    await Promise.resolve();
    await app.watcher.sample();
    expect(captures).toBe(2);
  } finally {
    release();
    app.stop();
    fake.stop();
    home.remove();
  }
});
