import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp, type App, type Replies } from "../src/app.ts";
import { trail } from "../src/db.ts";
import { resolveToken } from "../src/server.ts";
import { fakeSynapse, fixture, png, rollout, tempHome, type FakeSynapse, type Home } from "./helpers.ts";

const TOKEN = "test-token-123";
let home: Home, app: App | undefined, fakes: FakeSynapse[];
let clock: number, logged: string[];

beforeEach(() => { home = tempHome(); fakes = []; logged = []; clock = Date.parse("2026-11-21T15:00:00Z"); });
afterEach(() => { app?.stop(); app = undefined; for (const fake of fakes) fake.stop(); home.remove(); });

const start = (env: Record<string, string> = {}) => app = createApp(home.config(env), TOKEN, () => clock, line => { logged.push(line); });
const get = (path: string) => app!.fetch(new Request(`http://commons.test${path}`));
const api = async <Route extends keyof Replies>(route: Route, query = "") =>
  (await get(`/${TOKEN}/api/${route}${query}`)).json() as Promise<Replies[Route]>;
const post = (path: string, body: unknown) => app!.fetch(new Request(`http://commons.test/${TOKEN}/api/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
/** Margo exists once she has an instance file and a notes directory. */
const addMargo = (synapseUrl = "http://127.0.0.1:9") => {
  home.put("instances/Margo.env", fixture("instances-Margo.env").replace(/^SYNAPSE_URL=.*$/m, `SYNAPSE_URL=${synapseUrl}`));
  home.put("resident/margo/memory.md", "# Margo\n");
};
const online = (options: Parameters<typeof fakeSynapse>[0] = {}) => {
  const fake = fakeSynapse({ token: "s3cret", ...options });
  fakes.push(fake);
  home.put("synapse-token", "s3cret\n");
  return fake;
};

function seed() {
  const db = app!.db, t = clock - 3_600_000;
  const skill = (name: string, author: string, status: string, expect: string | null = '{"gain":{"minecraft:stick":4}}') => Number(db.query(
    "INSERT INTO skills (name, author, description, code, params_json, expect_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?)")
    .run(name, author, `What ${name} does.`, "await tools.craft({item:'stick'});", '{"count":"how many"}', expect, status, t, t).lastInsertRowid);
  const run = (skillId: number, resident: string, version: number, ok: number, checkOk: number | null, at: number) => db.query(
    "INSERT INTO skill_runs (skill_id, version, resident, started_at, ms, ok, check_ok, error, args_json) VALUES (?, ?, ?, ?, 900, ?, ?, ?, '{}')")
    .run(skillId, version, resident, at, ok, checkOk, ok ? null : "timed out after 60 s");
  const note = (author: string, status: string) => Number(db.query(
    "INSERT INTO shared_notes (author, topic, text, status, created_at, updated_at) VALUES (?, 'food', 'Bread is in the cabin chest.', ?, ?, ?)")
    .run(author, status, t, t).lastInsertRowid);
  const ids = { sticks: skill("make_sticks", "Gary", "verified"), draft: skill("dig_down", "Margo", "draft", null), note: note("Margo", "proposed") };
  run(ids.sticks, "Gary", 1, 1, 0, t + 1);     // old version, check failed
  run(ids.sticks, "Gary", 2, 1, 1, t + 2);
  run(ids.sticks, "Gary", 2, 0, null, t + 3);  // errored
  run(ids.sticks, "Margo", 2, 1, 1, t + 4);
  run(ids.sticks, "margo", 2, 1, 1, t + 5);
  run(ids.draft, "Margo", 2, 1, null, t + 6);  // no expectation declared
  return ids;
}
const statusOf = (table: string, id: number) => app!.db.query<{ status: string }, [number]>(`SELECT status FROM ${table} WHERE id = ?`).get(id)!.status;
const reviewRows = () => app!.db.query<{ kind: string; target_id: number; reviewer: string; verdict: string; text: string; at: number }, []>(
  "SELECT kind, target_id, reviewer, verdict, text, at FROM reviews ORDER BY id").all();

test("nothing is served without the token; with it, the page and the API answer", async () => {
  start();
  for (const path of ["/", "/api/residents", "/wrong-token/", "/wrong-token/api/residents", `/${TOKEN}x/`, `/${TOKEN.slice(0, -1)}/`, "/app.js"]) {
    const response = await get(path);
    expect(`${path} ${response.status}`).toBe(`${path} 404`);
    expect(await response.text()).not.toContain("Gary");
  }
  const bare = await get(`/${TOKEN}`);
  expect(bare.status).toBe(308);
  expect(bare.headers.get("Location")).toBe(`/${TOKEN}/`);
  const page = await get(`/${TOKEN}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Type")).toStartWith("text/html");
  expect(await page.text()).toContain("<script");
  expect((await get(`/${TOKEN}/app.js`)).headers.get("Content-Type")).toStartWith("text/javascript");
  expect((await get(`/${TOKEN}/api/residents`)).status).toBe(200);
  // Only the page's own files are served; nothing else from disk.
  for (const path of ["schema.sql", "../schema.sql", "..%2Fschema.sql", "api/nothing", "index.html/x"]) {
    expect((await get(`/${TOKEN}/${path}`)).status).toBe(404);
  }
});

test("the same routing holds over a real socket", async () => {
  start();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app!.fetch(request) });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/nope/api/commons`)).status).toBe(404);
    const followed = await fetch(`http://127.0.0.1:${server.port}/${TOKEN}`);
    expect(followed.url).toBe(`http://127.0.0.1:${server.port}/${TOKEN}/`);
    expect(await followed.text()).toContain("<title>");
  } finally { await server.stop(true); }
});

test("a resident whose client is down is shown offline, and every panel still answers", async () => {
  addMargo();
  home.put("resident/gary/memory.md", fixture("memory.md"));
  start();
  await app!.watcher.sample();
  const data = await api("residents");
  expect(data.residents.map(resident => `${resident.name} ${resident.status}`)).toEqual(["Gary offline", "Margo offline"]);
  const gary = data.residents[0];
  expect(gary.state).toBeNull();
  expect(gary.detail).toBe("The client is not running (connection refused or no answer).");
  expect(gary.memoryBytes).toBe(Buffer.byteLength(fixture("memory.md")));
  expect(gary.lastOnlineAt).toBeNull();
  // No systemctl on this machine: unknown, not a crash.
  expect(gary.units).toEqual([{ unit: "gary-run", state: "unknown" }, { unit: "gary-client@Gary", state: "unknown" }]);
  expect(data.residents[1].units.map(unit => unit.unit)).toEqual(["margo-run", "gary-client@Margo"]);
  expect(data.sharedUnits).toEqual([{ unit: "overseer-run", state: "unknown" }]);
  expect(gary.tokens).toEqual({ day: { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }, daySessions: 0 });

  const picture = await get(`/${TOKEN}/api/picture?resident=Gary`);
  expect(picture.status).toBe(404);
  expect(await picture.json()).toEqual({ error: "No picture: Gary's client is not running." });
  // No sessions, no places, no caretaker notes, an empty database: empty answers, not errors.
  expect((await api("activity")).entries).toEqual([]);
  expect(await api("map", "?hours=6")).toMatchObject({ hours: 6, places: [], deaths: [], residents: [{ name: "Gary", online: false, trail: [], position: null }, { name: "Margo" }] });
  expect(await api("commons")).toMatchObject({ skills: [], notes: [], pending: 0, caretaker: [{ resident: "Gary", entries: [] }, { resident: "Margo", entries: [] }] });
  expect(await api("notes", "?resident=Margo")).toMatchObject({ name: "Margo", memory: { text: "# Margo\n" }, journal: null, files: [], places: { places: [], deaths: [] } });
  expect((await get(`/${TOKEN}/api/notes?resident=Nobody`)).status).toBe(404);
});

test("an instance file without a notes directory is a test client, not a resident", async () => {
  home.put("instances/gary_fc_test.env", "GAME_DIR=/tmp/x\nSYNAPSE_URL=http://127.0.0.1:25620\n");
  start();
  expect((await api("residents")).residents.map(resident => resident.name)).toEqual(["Gary"]);
});

test("an online resident's position is sampled into the commons and shown; the offline one is not", async () => {
  const fake = online();
  addMargo();
  start({ GARY_SYNAPSE_URL: fake.url });
  await app!.watcher.sample();
  clock += 10_000;
  fake.state = { ...fake.state, pos: { x: 118.4, y: 121, z: -200.2 }, dimension: "minecraft:the_nether" };
  await app!.watcher.sample();

  expect(fake.requests).toEqual(["/state?mode=full", "/state?mode=full"]);
  const rows = app!.db.query("SELECT resident, at, x, y, z, dimension, health, food FROM positions ORDER BY at").all();
  expect(rows).toEqual([
    { resident: "Gary", at: clock - 10_000, x: 110.5, y: 120, z: -207.6, dimension: "minecraft:overworld", health: 2.7, food: 14 },
    { resident: "Gary", at: clock, x: 118.4, y: 121, z: -200.2, dimension: "minecraft:the_nether", health: 2.7, food: 14 },
  ]);

  const data = await api("residents");
  const [gary, margo] = data.residents;
  expect(gary).toMatchObject({ status: "online", lastOnlineAt: clock, checkedAt: clock });
  expect(gary.state).toMatchObject({ pos: { x: 118.4, y: 121, z: -200.2 }, dimension: "the_nether", health: 2.7, food: 14, held: { item: "dirt", count: 46 }, screen: null });
  expect(margo).toMatchObject({ status: "offline", state: null, lastOnlineAt: null });

  // The map is overworld only: the nether sample is neither on the trail nor the current position.
  const map = await api("map", "?hours=1");
  expect(map.residents[0]).toMatchObject({ name: "Gary", online: true, trail: [[clock - 10_000, 111, -208]], position: null, dimension: "the_nether" });
  expect(map.residents[1].trail).toEqual([]);
});

test("a client that refuses the token is reported as such and nothing is recorded", async () => {
  const fake = online();
  home.put("synapse-token", "stale\n");
  start({ GARY_SYNAPSE_URL: fake.url });
  await app!.watcher.sample();
  expect((await api("residents")).residents[0]).toMatchObject({ status: "unauthorized", detail: "The client refused the Synapse token.", state: null });
  expect(app!.db.query("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
});

test("after the client stops, the resident goes offline but keeps the time it was last seen", async () => {
  const fake = online();
  start({ GARY_SYNAPSE_URL: fake.url });
  await app!.watcher.sample();
  const seenAt = clock;
  fake.stop();
  clock += 60_000;
  await app!.watcher.sample();
  expect((await api("residents")).residents[0]).toMatchObject({ status: "offline", state: null, lastOnlineAt: seenAt, checkedAt: clock });
});

test("the picture is the client's PNG, fetched at most every 15 seconds, and the last one outlives the client", async () => {
  const picture = png(32, 18);
  const fake = online({ picture });
  start({ GARY_SYNAPSE_URL: fake.url });
  const shots = () => fake.requests.filter(path => path.startsWith("/screenshot")).length;

  const first = await get(`/${TOKEN}/api/picture?resident=gary`);
  expect(first.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(picture);
  expect(first.headers.get("X-Picture-At")).toBe(String(clock));
  clock += 14_000;
  await get(`/${TOKEN}/api/picture?resident=Gary`);
  expect(shots()).toBe(1);
  await get(`/${TOKEN}/api/picture?resident=Gary&fresh=1`);
  expect(shots()).toBe(2);
  clock += 16_000;
  await get(`/${TOKEN}/api/picture?resident=Gary`);
  expect(shots()).toBe(3);
  expect((await api("residents")).residents[0].pictureAt).toBe(clock);

  fake.stop();
  clock += 60_000;
  const stale = await get(`/${TOKEN}/api/picture?resident=Gary`);
  expect(stale.status).toBe(200);
  expect(stale.headers.get("X-Picture-At")).toBe(String(clock - 60_000));
});

test("Keep curates a verified skill and writes the review; the two questions stay separate in the listing", async () => {
  start();
  const ids = seed();
  const before = (await api("commons")).skills.find(skill => skill.id === ids.sticks)!;
  expect(before).toMatchObject({ name: "make_sticks", author: "Gary", status: "verified", version: 2, expect: { gain: { "minecraft:stick": 4 } }, params: { count: "how many" } });
  // Did it work: this version 3 of 4 passed; counting the old version too, 3 of 5.
  expect(before.runs).toEqual({ current: { total: 4, passed: 3, unchecked: 0 }, all: { total: 5, passed: 3, unchecked: 0 } });
  // Is it worth having: Margo (under either spelling of her name in the runs) is one resident other than the author.
  expect(before.users.map(user => `${user.resident} ${user.isAuthor} ${user.total}`)).toEqual(["Margo false 2", "Gary true 3"]);
  expect(before.otherUsers).toBe(1);
  expect(before.recentRuns[0]).toMatchObject({ resident: "margo", ok: true, checkOk: true });
  expect(before.recentRuns.find(run => !run.ok)).toMatchObject({ error: "timed out after 60 s", checkOk: null });
  expect((await api("commons")).pending).toBe(2);
  expect((await api("residents")).pending).toBe(2);

  clock += 5000;
  const response = await post("review", { kind: "skill", id: ids.sticks, verdict: "keep", reviewer: "  Sam ", text: "", version: 2 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, status: "curated" });
  expect(statusOf("skills", ids.sticks)).toBe("curated");
  expect(reviewRows()).toEqual([{ kind: "skill", target_id: ids.sticks, reviewer: "Sam", verdict: "keep", text: "", at: clock }]);
  const after = (await api("commons")).skills.find(skill => skill.id === ids.sticks);
  expect(after).toMatchObject({ status: "curated", updatedAt: clock, reviews: [{ reviewer: "Sam", verdict: "keep" }] });
  expect((await api("commons")).pending).toBe(1);
});

test("Reject needs a reason; with one it rejects and the reason is stored as one plain line", async () => {
  start();
  const ids = seed();
  const refused = await post("review", { kind: "skill", id: ids.sticks, verdict: "reject", reviewer: "Sam", text: "   " });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "A rejection needs a reason, so its author learns something from it." });
  expect(statusOf("skills", ids.sticks)).toBe("verified");
  expect(reviewRows()).toEqual([]);

  const done = await post("review", { kind: "skill", id: ids.sticks, verdict: "reject", reviewer: "Sam", text: "Crafts planks\n  first, wasting logs." });
  expect(done.status).toBe(200);
  expect(statusOf("skills", ids.sticks)).toBe("rejected");
  expect(reviewRows()).toEqual([{ kind: "skill", target_id: ids.sticks, reviewer: "Sam", verdict: "reject", text: "Crafts planks first, wasting logs.", at: clock }]);
});

test("shared notes are reviewed the same way, and a comment changes no status", async () => {
  start();
  const ids = seed();
  expect((await api("commons")).notes).toMatchObject([{ id: ids.note, author: "Margo", topic: "food", text: "Bread is in the cabin chest.", status: "proposed", reviews: [] }]);
  expect((await post("review", { kind: "note", id: ids.note, verdict: "comment", reviewer: "Sam", text: "Which chest?" })).status).toBe(200);
  expect(statusOf("shared_notes", ids.note)).toBe("proposed");
  expect((await post("review", { kind: "note", id: ids.note, verdict: "keep", reviewer: "Sam" })).status).toBe(200);
  expect(statusOf("shared_notes", ids.note)).toBe("curated");
  expect(reviewRows().map(row => `${row.kind} ${row.verdict} ${row.text}`)).toEqual(["note comment Which chest?", "note keep "]);
  // A decision can be changed later; the history keeps both.
  expect((await post("review", { kind: "note", id: ids.note, verdict: "reject", reviewer: "Sam", text: "The chest is empty now." })).status).toBe(200);
  expect(statusOf("shared_notes", ids.note)).toBe("rejected");
  expect((await api("commons")).notes[0].reviews.map(row => row.verdict)).toEqual(["reject", "keep", "comment"]);
});

test("verdicts that must not go through are refused with the reason, and change nothing", async () => {
  start();
  const ids = seed();
  const refuse = async (body: object, status: number, error: string) => {
    const response = await post("review", body);
    expect([response.status, (await response.json() as { error: string }).error]).toEqual([status, error]);
  };
  await refuse({ kind: "skill", id: ids.draft, verdict: "keep", reviewer: "Sam" }, 409, "A draft cannot be kept: it has not passed its own check yet. Reject it or leave a comment.");
  // The author edited the skill (version 3) while the reviewer was reading version 2.
  app!.db.query("UPDATE skills SET version = 3, status = 'draft' WHERE id = ?").run(ids.sticks);
  await refuse({ kind: "skill", id: ids.sticks, verdict: "reject", reviewer: "Sam", text: "bad", version: 2 }, 409, "This skill changed while you were reading it (now version 3). Read the new code, then decide.");
  await refuse({ kind: "skill", id: 999, verdict: "reject", reviewer: "Sam", text: "bad" }, 404, "There is no skill with id 999.");
  await refuse({ kind: "note", id: ids.note, verdict: "keep", reviewer: "" }, 400, "Say who is reviewing: a name of 1 to 40 characters.");
  await refuse({ kind: "note", id: ids.note, verdict: "curated", reviewer: "Sam" }, 400, "verdict must be keep, reject or comment.");
  await refuse({ kind: "place", id: 1, verdict: "keep", reviewer: "Sam" }, 400, "kind must be skill or note.");
  await refuse({ kind: "note", id: ids.note, verdict: "reject", reviewer: "Sam", text: "x".repeat(601) }, 400, "The reason is 601 characters; the limit is 600.");
  const notJson = await app!.fetch(new Request(`http://commons.test/${TOKEN}/api/review`, { method: "POST", body: "keep it" }));
  expect(notJson.status).toBe(400);
  expect(reviewRows()).toEqual([]);
  expect([statusOf("skills", ids.draft), statusOf("skills", ids.sticks), statusOf("shared_notes", ids.note)]).toEqual(["draft", "draft", "proposed"]);
  // A draft can still be rejected.
  expect((await post("review", { kind: "skill", id: ids.draft, verdict: "reject", reviewer: "Sam", text: "Digging straight down kills." })).status).toBe(200);
  expect(statusOf("skills", ids.draft)).toBe("rejected");
});

test("a skill without an expectation reports its runs as unchecked rather than as passed checks", async () => {
  start();
  const ids = seed();
  const draft = (await api("commons")).skills.find(skill => skill.id === ids.draft)!;
  expect(draft.expect).toBeNull();
  expect(draft.runs.current).toEqual({ total: 1, passed: 1, unchecked: 1 });
  expect(draft.otherUsers).toBe(0);
});

test("residents' own verdicts are a third figure, apart from run results and reviews", async () => {
  start();
  const ids = seed();
  const feedback = app!.db.query("INSERT INTO feedback (kind, target_id, resident, worked, text, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  feedback.run("skill", ids.sticks, "Margo", 1, "saved me three calls", 2, clock - 3000);
  feedback.run("skill", ids.sticks, "Gary", 0, "needs planks in the inventory first", 2, clock - 2000);
  feedback.run("skill", ids.sticks, "Ada", 1, "", 1, clock - 1000);   // about the version before the last edit
  feedback.run("note", ids.note, "Gary", 0, "the chest was empty", null, clock - 500);
  const commons = await api("commons");
  const skill = commons.skills.find(entry => entry.id === ids.sticks)!;
  expect(skill.feedback).toEqual({
    worked: 1, notWorked: 1, outdated: 1,
    entries: [
      { resident: "Ada", worked: true, text: "", version: 1, at: clock - 1000, outdated: true },
      { resident: "Gary", worked: false, text: "needs planks in the inventory first", version: 2, at: clock - 2000, outdated: false },
      { resident: "Margo", worked: true, text: "saved me three calls", version: 2, at: clock - 3000, outdated: false },
    ],
  });
  // The other two figures are untouched by it.
  expect(skill.runs.current).toEqual({ total: 4, passed: 3, unchecked: 0 });
  expect(skill.reviews).toEqual([]);
  expect(commons.skills.find(entry => entry.id === ids.draft)!.feedback).toEqual({ worked: 0, notWorked: 0, outdated: 0, entries: [] });
  expect(commons.notes[0].feedback).toMatchObject({ worked: 0, notWorked: 1, outdated: 0, entries: [{ resident: "Gary", text: "the chest was empty", version: null }] });
});

test("the journal gets a line for verdicts and failures, never the token", async () => {
  start();
  const ids = seed();
  await post("review", { kind: "note", id: ids.note, verdict: "keep", reviewer: "Sam" });
  await get(`/${TOKEN}/api/nothing`);
  await get(`/${TOKEN}/api/residents`);
  await get("/guess/api/residents");
  expect(logged).toEqual(["POST /<token>/api/review -> 200", "GET /<token>/api/nothing -> 404", "GET without the token -> 404"]);
  expect(logged.join("\n")).not.toContain(TOKEN);
});

test("notes: memory, the end of the journal, topic files and places; nothing outside the resident's directory", async () => {
  addMargo();
  home.put("resident/gary/memory.md", fixture("memory.md"));
  home.put("resident/gary/journal.md", `# Journal\n${"old line\n".repeat(3000)}## 2026-11-21\nPlanted wheat by the stream.\n`);
  home.put("resident/gary/notes/farming.md", "# Farming\nWheat needs water within four blocks.\n");
  home.put("resident/gary/notes/deep/ores.md", "# Ores\n");
  home.put("resident/gary/AGENTS.md", "# Gary\npersona\n");
  home.put("resident/gary/.git/secret.md", "no");
  home.put("resident/gary/places.json", JSON.stringify({ places: [{ name: "Wheat patch", x: 104, y: 116, z: -201, dimension: "minecraft:overworld" }], deaths: [{ x: 60, y: 61, z: -100, dimension: "minecraft:overworld", at: clock - 1000 }] }));
  home.put("resident/shared/places.json", fixture("shared-places.json"));
  home.put("resident/margo/memory.md", "# Margo's private memory\n");
  start();

  const notes = await api("notes", "?resident=Gary");
  expect(notes.memory).toMatchObject({ path: "memory.md", bytes: Buffer.byteLength(fixture("memory.md")), truncated: false });
  expect(notes.memory!.text).toStartWith("# Gary\n");
  const journal = notes.journal!;
  expect(journal.truncated).toBe(true);
  expect(journal.text).toEndWith("## 2026-11-21\nPlanted wheat by the stream.\n");
  expect(journal.text).toStartWith("old line\n");
  expect(journal.text.length).toBeLessThan(12_001);
  expect(notes.files.map(file => file.path)).toEqual(["notes/deep/ores.md", "notes/farming.md", "AGENTS.md"]);
  expect(notes.places).toEqual({
    places: [{ name: "Wheat patch", x: 104, y: 116, z: -201, dimension: "minecraft:overworld" }],
    deaths: [{ x: 60, y: 61, z: -100, dimension: "minecraft:overworld", at: clock - 1000 }],
  });
  expect(notes.shared.places.map(place => `${place.name} by ${place.author}`)).toEqual(["Gary's cabin by Gary", "Cabin stream by Gary"]);

  expect(await api("file", "?resident=Gary&path=notes/farming.md")).toMatchObject({ path: "notes/farming.md", text: "# Farming\nWheat needs water within four blocks.\n" });
  for (const path of ["../margo/memory.md", "notes/../../margo/memory.md", "/etc/hostname", ".git/secret.md", "places.json", "notes/missing.md", ""]) {
    const response = await get(`/${TOKEN}/api/file?resident=Gary&path=${encodeURIComponent(path)}`);
    expect(`${path} ${response.status}`).toBe(`${path} 404`);
  }

  // The map shows the same places and the death, with who they belong to.
  const map = await api("map", "?hours=6");
  expect(map.places.map(place => `${place.name} (${place.owner})`)).toEqual(["Gary's cabin (shared)", "Cabin stream (shared)", "Wheat patch (Gary)"]);
  expect(map.deaths).toEqual([{ resident: "Gary", x: 60, y: 61, z: -100, at: clock - 1000 }]);
});

test("a places.json caught mid-write shows the last good reading instead of failing or going empty", async () => {
  const path = home.put("resident/gary/places.json", JSON.stringify({ places: [{ name: "Cabin", x: 1, y: 2, z: 3, dimension: "minecraft:overworld" }], deaths: [] }));
  start();
  expect((await api("notes", "?resident=Gary")).places.places.length).toBe(1);
  home.put("resident/gary/places.json", '{"places":[{"name":"Cabin","x":1,"y":2,"z":3,"dimension":"minecraft:overw');
  const notes = await api("notes", "?resident=Gary");
  expect(notes.places.places).toEqual([{ name: "Cabin", x: 1, y: 2, z: 3, dimension: "minecraft:overworld" }]);
  expect(notes.places.problem).toBe("places.json is not valid JSON right now; showing the last good reading.");
  expect(path).toEndWith("places.json");
  expect((await get(`/${TOKEN}/api/map`)).status).toBe(200);
});

test("deaths older than places.json remembers come from the session record, without doubling the recent one", async () => {
  const diedAt = clock - 30 * 60_000;
  home.put("resident/gary/places.json", JSON.stringify({ places: [], deaths: [{ x: 60, y: 61, z: -100, dimension: "minecraft:overworld", at: diedAt }] }));
  home.put("sessions/2026/11/21/gary.jsonl", [
    rollout.meta(clock - 3_600_000, join(home.dir, "resident", "gary")),
    ...rollout.call(clock - 50 * 60_000, "status", {}, "Health 0/20\n\nSince last time:\n3 died at=12,40,-7 dimension=minecraft:overworld text=what you carried dropped there"),
    ...rollout.call(diedAt + 20_000, "status", {}, "Health 0/20\n\nSince last time:\n9 died at=60,61,-100 dimension=minecraft:overworld text=what you carried dropped there"),
    ...rollout.call(clock - 10 * 60_000, "status", {}, "Health 0/20\n\nSince last time:\n12 died at=5,30,5 dimension=minecraft:the_nether text=x"),
  ].join("\n") + "\n");
  start({ CODEX_HOME: home.dir });
  const map = await api("map", "?hours=1");
  expect(map.deaths.map(death => `${death.x},${death.y},${death.z}`).sort()).toEqual(["12,40,-7", "60,61,-100"]);
});

test("activity reaches the page newest first, then only what is new, and starts over after a restart", async () => {
  const path = home.put("sessions/2026/11/21/gary.jsonl", [
    rollout.meta(clock - 60_000, join(home.dir, "resident", "gary")),
    rollout.model(clock - 60_000, "gpt-6-luna"),
    ...rollout.call(clock - 50_000, "go_to", { x: 1, z: 2 }, "Started #goto 1 2."),
    rollout.remark(clock - 40_000, "Walking to the stream."),
    rollout.tokens(clock - 40_000, 5000),
  ].join("\n") + "\n");
  start({ CODEX_HOME: home.dir });
  const first = await api("activity");
  expect(first.entries.map(entry => `${entry.resident} ${entry.kind} ${entry.tool ?? entry.text}`)).toEqual(["Gary remark Walking to the stream.", "Gary call go_to"]);
  expect(first.residents[0]).toMatchObject({ name: "Gary", indicators: { calls: 1 }, sessions: [{ model: "gpt-6-luna", tokens: { total: 5000 } }] });
  expect((await api("residents")).residents[0].tokens).toMatchObject({ session: { model: "gpt-6-luna", tokens: { total: 5000 } }, day: { total: 5000 }, daySessions: 1 });
  expect((await api("residents")).quota).toMatchObject({ usedPercent: 9 });

  await Bun.write(path, await Bun.file(path).text() + rollout.remark(clock, "At the stream.") + "\n");
  clock += 3000;
  const next = await api("activity", `?boot=${first.boot}&after=${first.entries[0].id}`);
  expect(next.entries.map(entry => entry.text)).toEqual(["At the stream."]);
  // A page that remembers ids from before a restart gets everything again, under the new boot marker.
  const restarted = await api("activity", `?boot=old&after=${first.entries[0].id}`);
  expect(restarted.entries.length).toBe(3);
});

test("caretaker notes are listed newest first with the note and the maintainers' line apart", async () => {
  home.put("overseer/Gary.md", [
    "", "## 2026-11-21 09:15 (last 60 min, gpt-6.2-astra, shadow)", "NOTE: none", "MAINTAINERS: none",
    "", "## 2026-11-21 10:15 (last 60 min, gpt-6.2-astra, shadow)",
    "NOTE: You tried go_to 133 82 -104 five times between 09:20 and 09:41 and each stopped short at the same spot.",
    "MAINTAINERS: stopped_short repeats five times with no attempts count in the event line.",
    "second line for maintainers",
    "", "## 2026-11-21 11:15 (last 60 min, gpt-6.2-astra, shadow)", "(no answer: codex exit 1; see last-Gary.log)", "",
  ].join("\n"));
  start();
  expect((await api("commons")).caretaker[0]).toEqual({
    resident: "Gary",
    entries: [
      { heading: "2026-11-21 11:15 (last 60 min, gpt-6.2-astra, shadow)", note: "", maintainers: "", other: "(no answer: codex exit 1; see last-Gary.log)" },
      {
        heading: "2026-11-21 10:15 (last 60 min, gpt-6.2-astra, shadow)",
        note: "You tried go_to 133 82 -104 five times between 09:20 and 09:41 and each stopped short at the same spot.",
        maintainers: "stopped_short repeats five times with no attempts count in the event line.\nsecond line for maintainers", other: "",
      },
      { heading: "2026-11-21 09:15 (last 60 min, gpt-6.2-astra, shadow)", note: "none", maintainers: "none", other: "" },
    ],
  });
});

test("unit states come from systemctl, one per unit in order", async () => {
  const script = home.put("fake-systemctl", '#!/bin/sh\n[ "$1" = --user ] && [ "$2" = is-active ] || exit 9\nshift 2\nfor unit in "$@"; do case $unit in gary-run) echo active;; gary-client@Gary) echo activating;; *) echo inactive;; esac; done\nexit 3\n');
  chmodSync(script, 0o755);
  start({ COMMONS_SYSTEMCTL: script, COMMONS_UNITS: "gary-run, overseer-run backup-timer" });
  const data = await api("residents");
  expect(data.residents[0].units).toEqual([{ unit: "gary-run", state: "active" }, { unit: "gary-client@Gary", state: "activating" }]);
  expect(data.sharedUnits).toEqual([{ unit: "overseer-run", state: "inactive" }, { unit: "backup-timer", state: "inactive" }]);
});

test("a trail drops standing still, keeps the time of leaving, and is thinned without losing its end", () => {
  start();
  const insert = app!.db.query("INSERT INTO positions (resident, at, x, y, z, dimension) VALUES ('Gary', ?, ?, 64, ?, 'minecraft:overworld')");
  insert.run(1000, 10.2, 5.1); insert.run(2000, 10.4, 4.9); insert.run(3000, 9.8, 5.3); insert.run(4000, 14, 5); insert.run(5000, 20, 9);
  expect(trail(app!.db, "Gary", 0)).toEqual([[3000, 10, 5], [4000, 14, 5], [5000, 20, 9]]);
  expect(trail(app!.db, "Gary", 4000)).toEqual([[4000, 14, 5], [5000, 20, 9]]);
  for (let index = 0; index < 500; index++) insert.run(6000 + index, 100 + index, 0);
  const thinned = trail(app!.db, "Gary", 0, 50);
  expect(thinned.length).toBe(50);
  expect(thinned[0]).toEqual([3000, 10, 5]);
  expect(thinned[49]).toEqual([6499, 599, 0]);
});

test("the access token is made once, saved for the owner only, and reused", () => {
  const config = home.config();
  const first = resolveToken(config);
  expect(first.created).toBe(true);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(config.tokenFile).toBe(join(home.dir, "commons", "token"));
  expect(statSync(config.tokenFile).mode & 0o777).toBe(0o600);
  expect(resolveToken(config)).toEqual({ token: first.token, created: false });
  expect(resolveToken(home.config({ COMMONS_TOKEN: "from-the-environment" }))).toEqual({ token: "from-the-environment", created: false });
  expect(() => home.config({ COMMONS_TOKEN: "has/slash" })).toThrow("COMMONS_TOKEN must be 8 to 128 letters");
});
