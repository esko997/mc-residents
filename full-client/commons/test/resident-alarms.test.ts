import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { ResidentApi } from "../src/resident-api.ts";
import type { ResidentAlarmOptions } from "../src/resident-alarms.ts";
import type { AlarmEvent, AlarmRequest } from "../src/resident-contracts-alarm.ts";
import { residentHub } from "./resident-api-fixture.ts";
import { tempHome } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const alarm: AlarmRequest = { kind: "auto", reason: "attacked near zombie", x: 1, y: 64, z: -2, dimension: "minecraft:overworld", health: 6, maxHealth: 20 };
function fixture(options: ResidentAlarmOptions = {}) {
  const hub = residentHub(); cleanup.push(() => hub.close());
  const api = new ResidentApi(hub.db, hub.credentialsFile, true, options);
  cleanup.push(() => api.close());
  const request = (token: string, body: unknown = alarm, headers: Record<string, string> = {}) => api.fetch(new Request(`${hub.url}resident-api/v1/alarm`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { ...hub, api, request };
}

test("alarm uses authenticated identity, fans out to every other credential resident, never caretaker or sender", async () => {
  const commands: string[] = [], activity: AlarmEvent[] = [];
  const h = fixture({ now: () => 50_000, command: command => { commands.push(command); }, activity: event => { activity.push(event); } });
  const gary = h.identity("Gary"); h.identity("Margo"); h.identity("Wren"); h.identity("Tobin"); h.identity("Caretaker", "caretaker");
  const reply = await h.request(gary.token);
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ result: { message: "Alarm sent to the other residents." } });
  const expected = { ...alarm, sender: "Gary", at: 50_000 };
  for (const name of ["Margo", "Wren", "Tobin"]) {
    const batch = await h.api.events.poll(name, 0, 0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ type: "alarm", fields: expected });
  }
  expect((await h.api.events.poll("gArY", 0, 0)).events).toEqual([]);
  expect((await h.api.events.poll("Caretaker", 0, 0)).events).toEqual([]);
  expect(activity).toEqual([expected]);
  // Humans only: no resident's chat overlay may carry the alarm past earshot.
  expect(commands).toEqual(['tellraw @a[name=!Gary,name=!Margo,name=!Wren,name=!Tobin] {"text":"<Gary shouts for help: attacked near zombie>"}']);
});

test("raw JSON contract rejects identity overrides, wrappers, malformed values, caretakers and browsers", async () => {
  const h = fixture(), gary = h.identity(), caretaker = h.identity("Caretaker", "caretaker");
  expect((await h.request("unknown")).status).toBe(401);
  expect((await h.request(caretaker.token)).status).toBe(403);
  for (const header of ["Origin", "Sec-Fetch-Site"]) {
    expect((await h.request(gary.token, alarm, { [header]: "none" })).status).toBe(403);
  }
  for (const extra of [{ sender: "Margo" }, { resident: "Margo" }, { name: "Margo" }, { at: 1 }, { author: "Margo" }]) {
    expect((await h.request(gary.token, { ...alarm, ...extra })).status).toBe(400);
  }
  for (const invalid of [{ args: alarm }, { ...alarm, reason: "a".repeat(121) }, { ...alarm, reason: " " }, { ...alarm, x: null }, { ...alarm, health: -1 }, { ...alarm, dimension: "" }]) {
    expect((await h.request(gary.token, invalid)).status).toBe(400);
  }
  expect((await h.request(gary.token, alarm, { "Content-Type": "text/plain" })).status).toBe(400);
  expect(h.db.query("SELECT * FROM resident_alarms").all()).toEqual([]);
});

test("persisted auto reason classes and manual sender limits use injected time and survive API restart", async () => {
  let now = 100_000;
  const h = fixture({ now: () => now }), gary = h.identity(), margo = h.identity("Margo");
  const send = (reason: string, kind: "auto" | "manual" = "auto", token = gary.token) => h.request(token, { ...alarm, reason, kind });
  expect((await send("attacked near zombie")).status).toBe(200);
  expect((await send("attacked near skeleton")).status).toBe(429);
  expect((await send("low health")).status).toBe(200);
  expect((await send("creeper close")).status).toBe(200);
  expect((await send("in lava")).status).toBe(200);
  expect((await send("arbitrary first text")).status).toBe(200);
  expect((await send("arbitrary second text")).status).toBe(429);
  expect((await send("attacked near zombie", "auto", margo.token)).status).toBe(200);
  expect((await send("help", "manual")).status).toBe(200);
  const denied = await send("different help", "manual");
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({ error: { code: "rate_limited", message: expect.stringContaining("10s") } });
  h.api.close();
  const restarted = new ResidentApi(h.db, h.credentialsFile, true, { now: () => now });
  cleanup.push(() => restarted.close());
  const again = (body: AlarmRequest) => restarted.fetch(new Request(`${h.url}resident-api/v1/alarm`, {
    method: "POST", headers: { Authorization: `Bearer ${gary.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  now += 9_999;
  expect((await again({ ...alarm, kind: "manual" })).status).toBe(429);
  now++;
  expect((await again({ ...alarm, kind: "manual" })).status).toBe(200);
  expect((await again(alarm)).status).toBe(429);
  now += 20_000;
  expect((await again(alarm)).status).toBe(200);
});

test("sender comparison is case insensitive across credential casing changes", async () => {
  let now = 100_000;
  const h = fixture({ now: () => now }), gary = h.identity("Gary"); h.identity("Margo");
  expect((await h.request(gary.token)).status).toBe(200);
  // Identity is supplied by credentials, not a caller's spelling of the name.
  const entries = JSON.parse(readFileSync(h.credentialsFile, "utf8"));
  entries[0].name = "gArY";
  writeFileSync(h.credentialsFile, JSON.stringify(entries));
  now++;
  expect((await h.request(gary.token)).status).toBe(429);
  expect((await h.api.events.poll("Gary", 0, 0)).events).toEqual([]);
});

test("unavailable or pending console bridge never delays fanout; chat is sanitized and attempted only once", async () => {
  for (const unavailable of [() => Promise.reject(new Error("bridge offline")), () => new Promise(() => {})]) {
    const commands: string[] = [];
    const h = fixture({ command: command => { commands.push(command); return unavailable(); } });
    const gary = h.identity(); h.identity("Margo");
    const reply = await h.request(gary.token, { ...alarm, reason: "attacked\n§cnear <zombie>\u202e" });
    expect(reply.status).toBe(200);
    const events = (await h.api.events.poll("Margo", 0, 0)).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.fields.reason).toBe("attacked near zombie");
    expect(commands).toEqual(['tellraw @a[name=!Gary,name=!Margo] {"text":"<Gary shouts for help: attacked near zombie>"}']);
    expect((await h.request(gary.token, { ...alarm, reason: "attacked near skeleton" })).status).toBe(429);
    expect(commands).toHaveLength(1);
  }
  const h = fixture(), gary = h.identity(); h.identity("Margo");
  expect((await h.request(gary.token)).status).toBe(200); // no command hook configured
  expect((await h.api.events.poll("Margo", 0, 0)).events).toHaveLength(1);
});

test.each([false, true])("hub Activity restores remote alarms and preserves cursors (unavailable station: %s)", async federation => {
  const h = residentHub(); cleanup.push(() => h.close());
  const home = tempHome(); cleanup.push(() => home.remove());
  const wren = h.identity("Wren"); h.identity("Gary");
  const config = home.config({ COMMONS_ROLE: "hub" });
  config.credentialsFile = h.credentialsFile;
  config.dbPath = join(h.directory, "commons.sqlite");
  if (federation) {
    config.stationsFile = home.put("commons-data/stations.json", JSON.stringify([
      { host: "unavailable-station", url: "http://127.0.0.1:9/station-secret/" },
    ]));
    chmodSync(config.stationsFile, 0o600);
  }
  let now = 100_000;
  let app = createApp(config, "dashboard-secret", () => now, () => {});
  cleanup.push(() => app.stop());
  // The exemption is only hub-authored alarms, not other unowned resident events.
  if (federation) app.tail.recordEvent("Wren", now, "reflex", "not an authenticated hub alarm");
  const raise = () => app.fetch(new Request("http://hub/resident-api/v1/alarm", {
    method: "POST", headers: { Authorization: `Bearer ${wren.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...alarm, kind: "manual" }),
  }));
  expect((await raise()).status).toBe(200);
  const activity = await (await app.fetch(new Request("http://hub/dashboard-secret/api/activity"))).json();
  expect(activity.entries).toHaveLength(1);
  expect(activity.entries[0]).toMatchObject({ resident: "Wren", type: "alarm", kind: "event", quiet: false, text: expect.stringContaining("Wren shouts for help") });
  const cursor = `boot=${encodeURIComponent(activity.boot)}&after=${activity.entries[0].id}`;
  expect((await (await app.fetch(new Request(`http://hub/dashboard-secret/api/activity?${cursor}`))).json()).entries).toEqual([]);
  now += 10_000;
  expect((await raise()).status).toBe(200);
  expect((await (await app.fetch(new Request(`http://hub/dashboard-secret/api/activity?${cursor}`))).json()).entries).toHaveLength(1);
  app.stop();
  app = createApp(config, "dashboard-secret", () => now, () => {});
  const restored = await (await app.fetch(new Request("http://hub/dashboard-secret/api/activity"))).json();
  expect(restored.entries).toHaveLength(2);
  expect(restored.boot).not.toBe(activity.boot);
  expect((await app.fetch(new Request("http://hub/wrong-token/api/activity"))).status).toBe(404);
});

test("station Activity never reads the hub alarm table and the resident alarm endpoint is unavailable", async () => {
  const home = tempHome(); cleanup.push(() => home.remove());
  const app = createApp(home.config({ COMMONS_ROLE: "station" }), "station-secret", () => 100_000, () => {});
  cleanup.push(() => app.stop());
  expect(app.db.query("SELECT name FROM sqlite_master WHERE name='resident_alarms'").all()).toEqual([]);
  expect((await app.fetch(new Request("http://station/resident-api/v1/alarm", { method: "POST" }))).status).toBe(404);
  const reply = await app.fetch(new Request("http://station/station-secret/api/activity"));
  expect(reply.status).toBe(200);
  expect((await reply.json()).entries).toEqual([]);
});
