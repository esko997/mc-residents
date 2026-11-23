import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { residentHub } from "./resident-api-fixture.ts";
import { importSharedPlaces, sharedPlaces } from "../src/resident-places.ts";
import { ResidentEvents } from "../src/resident-events.ts";
import { createApp } from "../src/app.ts";
import { tempHome } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function hub() { const h = residentHub(); cleanup.push(() => h.close()); return h; }
const place = { name: "hut", x: 1, y: 64, z: 2, dimension: "minecraft:overworld" };

test("bearer auth, browser refusal, roles, strict attribution, mtime reload and revocation", async () => {
  const h = hub(), gary = h.identity(), caretaker = h.identity("Caretaker", "caretaker");
  const request = (token: string, path = "places/save", args: unknown = place, headers: Record<string, string> = {}) => fetch(`${h.url}resident-api/v1/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ args }),
  });
  expect((await request("unknown")).status).toBe(401);
  expect((await request(gary.token, "places/save", place, { Origin: "http://localhost" })).status).toBe(403);
  expect((await request(gary.token, "places/save", place, { "Sec-Fetch-Site": "none" })).status).toBe(403);
  expect((await request(caretaker.token)).status).toBe(403);
  expect((await request(gary.token, "places/save", { ...place, author: "Margo" })).status).toBe(400);
  expect((await request(gary.token)).status).toBe(200);
  expect(sharedPlaces(h.db)[0]?.author).toBe("Gary");
  const margo = h.identity("Margo"); // Changed credential file is used without restarting the API.
  expect((await request(margo.token, "places/list", {})).status).toBe(200);
  expect(await margo.client.call("places", "remove", { name: "hut" })).toEqual({ removed: 0, foreign: "Gary" });
  writeFileSync(h.credentialsFile, JSON.stringify([{ name: "Margo", role: "resident", sha256: createHash("sha256").update(margo.token).digest("hex") }]));
  expect((await request(gary.token)).status).toBe(401);
  expect((await request(margo.token, "places/list", {})).status).toBe(200);
  chmodSync(h.credentialsFile, 0o644);
  expect((await request(margo.token, "places/list", {})).status).toBe(401);
});

test("collaboration acceptance cannot impersonate the invited resident; conflicts survive HTTP", async () => {
  const h = hub(), gary = h.identity(), margo = h.identity("Margo"), wren = h.identity("Wren");
  await gary.client.call("society", "collaborate", { kind: "request", recipient: "Margo", terms: "Bring bread" });
  await expect(wren.client.call("society", "update", { id: 1, revision: 1, action: "accept" })).rejects.toThrow("not yours");
  await expect(gary.client.call("society", "update", { id: 1, revision: 1, action: "accept", resident: "Margo" })).rejects.toThrow();
  await margo.client.call("society", "update", { id: 1, revision: 1, action: "accept" });
  const conflict = await fetch(`${h.url}resident-api/v1/society/update`, { method: "POST", headers: { Authorization: `Bearer ${gary.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ args: { id: 1, revision: 1, action: "withdraw" } }) });
  expect(conflict.status).toBe(409);
  expect(h.db.query("SELECT status,revision FROM collaborations WHERE id=1").get()).toEqual({ status: "accepted", revision: 2 });
});

test("bounded JSON bodies reject both declared and streamed oversized requests", async () => {
  const h = hub(), { token } = h.identity();
  for (const declared of [false, true]) {
    const req = new Request(`${h.url}resident-api/v1/places/save`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(declared ? { "Content-Length": "70000" } : {}) }, body: JSON.stringify({ args: { ...place, note: "x".repeat(70000) } }) });
    expect((await h.api.fetch(req)).status).toBe(413);
  }
  expect(sharedPlaces(h.db)).toEqual([]);
});

test("notes auto-accept and caretaker digest are attributed and read-only", async () => {
  const h = hub(), gary = h.identity(), caretaker = h.identity("Caretaker", "caretaker");
  await gary.client.call("skills", "note_share", { topic: "Food", text: "Bread is in the shared chest." });
  expect(h.db.query("SELECT author,status FROM shared_notes").get()).toEqual({ author: "Gary", status: "curated" });
  expect(h.db.query("SELECT reviewer FROM reviews").get()).toEqual({ reviewer: "auto" });
  await gary.client.call("places", "save", place);
  const digest = await fetch(`${h.url}resident-api/v1/caretaker/digest?resident=Gary`, { headers: { Authorization: `Bearer ${caretaker.token}` } });
  expect(digest.status).toBe(200);
  const data = await digest.json() as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual(["collaborations", "facilities", "knowledge_requests", "places", "skills"]);
  expect(data.places).toEqual([{ ...place, author: "Gary" }]);
  expect((await fetch(`${h.url}resident-api/v1/caretaker/digest?resident=Gary`, { headers: { Authorization: `Bearer ${gary.token}` } })).status).toBe(403);
  await expect(caretaker.client.call("knowledge", "updates", {})).rejects.toThrow("read-only");
});

test("events are addressed, long-poll wakes for its resident, ring overflow and restart report gaps", async () => {
  const h = hub(), events = new ResidentEvents(h.db, 2);
  const waiting = events.poll("Gary", 0, 1);
  events.publish("Margo", "collaboration", { id: 1 });
  events.publish("Gary", "collaboration", { id: 2 });
  const batch = await waiting;
  expect(batch.events.map(e => e.fields.id)).toEqual([2]);
  expect(batch.seq).toBe(2);
  events.publish("Margo", "collaboration", { id: 3 });
  expect((await events.poll("Gary", 0, 0)).gap).toBe(true);
  events.close();
  const restarted = new ResidentEvents(h.db);
  expect((await restarted.poll("Gary", 1, 0)).gap).toBe(true);
  expect(restarted.publish("Gary", "collaboration", { id: 4 })).toBe(4);
  const controller = new AbortController();
  const aborted = restarted.poll("Gary", 4, 25, controller.signal); controller.abort();
  expect((await aborted).events).toEqual([]);
  restarted.close();
});

test("shared places import is transactional, preserves source, and never resurrects deletions", async () => {
  const h = hub(), path = join(h.directory, "places.json");
  const bytes = JSON.stringify({ places: [{ ...place, author: "Gary", refuge: { checkedAt: 123, hazards: "dark" } }], deaths: [] });
  writeFileSync(path, bytes);
  importSharedPlaces(h.db, path);
  expect(sharedPlaces(h.db)[0]?.refuge).toEqual({ checkedAt: 123, hazards: "dark" });
  expect(readFileSync(path, "utf8")).toBe(bytes);
  await h.identity().client.call("places", "remove", { name: "hut" });
  importSharedPlaces(h.db, path);
  expect(sharedPlaces(h.db)).toEqual([]);
  const other = hub(), broken = join(other.directory, "places.json");
  writeFileSync(broken, '{"places":[{"name":"bad"}]}');
  expect(() => importSharedPlaces(other.db, broken)).toThrow("invalid source");
  expect(other.db.query("SELECT * FROM resident_api_state WHERE key='places_imported'").get()).toBeNull();
});

test("app dispatch precedes URL-token auth and map reads hub places, never the retired file", async () => {
  const home = tempHome(), config = home.config();
  const token = "resident-test";
  home.put("commons-data/credentials.json", JSON.stringify([{ name: "Gary", role: "resident", sha256: createHash("sha256").update(token).digest("hex") }]));
  chmodSync(config.credentialsFile, 0o600);
  const app = createApp(config, "dashboard-test", Date.now, () => {});
  cleanup.push(() => { app.stop(); home.remove(); });
  const saved = await app.fetch(new Request("http://local/resident-api/v1/places/save", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ args: place }) }));
  expect(saved.status).toBe(200);
  home.put("resident/shared/places.json", '{"places":[]}');
  const map = await app.fetch(new Request("http://local/dashboard-test/api/map"));
  expect((await map.json() as { places: { name: string }[] }).places.map(p => p.name)).toEqual(["hut"]);
});
