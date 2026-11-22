import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlaces } from "../src/ideas.ts";
import { createNotes, notesDefinitions, type NotesPosition } from "../src/notes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "resident-notes-"));
  cleanups.unshift(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function resident(dir: string, name: string, position: () => Promise<NotesPosition>, now?: () => number) {
  return createNotes({ residentDir: join(dir, name), residentName: name, sharedDir: join(dir, "shared"), position, now });
}

const at = (x: number, y: number, z: number, dimension = "minecraft:overworld") => async (): Promise<NotesPosition> => ({ x, y, z, dimension });

describe("recall", () => {
  test("all query words rank first, list items are units, and archive files are never searched", async () => {
    const dir = await tempDir();
    const notes = resident(dir, "A", at(0, 64, 0));
    await mkdir(join(dir, "A", "archive"), { recursive: true });
    await mkdir(join(dir, "A", "notes", "archive"), { recursive: true });
    await writeFile(join(dir, "A", "memory.md"), "alpha beta in the older paragraph\n\nalpha in a newer paragraph\n\n- alpha beta in a list item\n- alpha alone\n");
    await writeFile(join(dir, "A", "archive", "old.md"), "alpha beta archive secret");
    await writeFile(join(dir, "A", "notes", "archive", "old.md"), "alpha beta nested archive secret");
    await writeFile(join(dir, "A", "AGENTS.md"), "alpha beta instructions secret");

    const reply = await notes.recall({ query: "ALPHA beta", limit: 2 });
    const lines = reply.split("\n");
    expect(lines[0]).toStartWith("memory.md:5 - alpha beta in a list item");
    expect(lines[1]).toStartWith("memory.md:1 alpha beta in the older paragraph");
    expect(reply).toContain("2 more matches.");
    expect(reply).not.toContain("secret");
    expect(reply).not.toContain("archive");
  });

  test("falls back to any word only when no passage contains every word", async () => {
    const dir = await tempDir();
    const notes = resident(dir, "A", at(0, 64, 0));
    await mkdir(join(dir, "A"), { recursive: true });
    await writeFile(join(dir, "A", "journal.md"), "nothing relevant\n\nfirst only\n\nsecond only\n");
    const fallback = await notes.recall({ query: "first second" });
    expect(fallback).toContain("journal.md:5 second only");
    expect(fallback).toContain("journal.md:3 first only");
    expect(await notes.recall({ query: "missing" })).toBe('No matches for "missing". Searched: journal.md.');
  });

  test("caps a long reply at 1,200 characters without losing the match count", async () => {
    const dir = await tempDir();
    const notes = resident(dir, "A", at(0, 64, 0));
    await mkdir(join(dir, "A", "notes"), { recursive: true });
    await writeFile(join(dir, "A", "notebook.md"), `needle ${"x".repeat(3000)}\n\nneedle second\n`);
    await writeFile(join(dir, "A", "notes", "more.md"), "needle third\n");
    const reply = await notes.recall({ query: "needle", limit: 8 });
    expect(reply.length).toBeLessThanOrEqual(1200);
    expect(reply).toContain("notebook.md:1");
    expect(reply).toContain("1 more matches.");
  });
});

describe("places", () => {
  test("saves the current block position and reports distance and Minecraft compass direction", async () => {
    const dir = await tempDir();
    let position: NotesPosition = { x: 0.9, y: 64.9, z: -0.9, dimension: "minecraft:overworld" };
    const notes = resident(dir, "A", async () => position);
    expect(await notes.place_save({ name: "home", note: "bed and chests" })).toContain('Saved place "home" at (0,64,-1) in minecraft:overworld.');
    const here = await notes.place_find({});
    expect(here).toContain("home (0,64,-1) distance 0 blocks here; bed and chests");

    position = { x: 10, y: 64, z: -1, dimension: "minecraft:overworld" };
    const east = await notes.place_find({});
    expect(east).toContain("home (0,64,-1) distance 10 blocks west");
    position = { x: 0, y: 64, z: -11, dimension: "minecraft:overworld" };
    expect(await notes.place_find({ query: "bed chests" })).toContain("distance 10 blocks south");

    position = { x: 0, y: 64, z: -1, dimension: "minecraft:the_nether" };
    expect(await notes.place_find({})).toContain("home (0,64,-1) in minecraft:overworld; bed and chests");
  });

  test("shared places carry their author and another resident cannot overwrite or remove them", async () => {
    const dir = await tempDir();
    const a = resident(dir, "A", at(1, 64, 1));
    const b = resident(dir, "B", at(1, 64, 1));
    await a.place_save({ name: "mine", note: "shared ladder", shared: true });

    expect(await b.place_find({})).toContain("mine (1,64,1) distance 0 blocks here; shared ladder; by A");
    expect(await b.place_save({ name: "mine", x: 9, y: 9, z: 9, shared: true })).toBe('Shared place "mine" belongs to A; not overwritten.');
    expect(await b.place_remove({ name: "mine" })).toContain('Shared place "mine" belongs to A; not removed.');
    expect(await a.place_find({})).toContain("mine (1,64,1) distance 0 blocks here; shared ladder");
    expect(await a.place_find({})).not.toContain("by A");
  });

  test("interleaved shared writers merge instead of dropping each other's entries", async () => {
    const dir = await tempDir();
    const a = resident(dir, "A", at(0, 64, 0));
    const b = resident(dir, "B", at(0, 64, 0));
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const writer = index % 2 ? b : a;
      return writer.place_save({ name: `place-${index}`, x: index, y: 64, z: 0, shared: true });
    }));

    const data = JSON.parse(await readFile(join(dir, "shared", "places.json"), "utf8")) as { places: { name: string; author: string }[] };
    expect(data.places).toHaveLength(12);
    for (let index = 0; index < 12; index++) {
      expect(data.places.some(place => place.name === `place-${index}` && place.author === (index % 2 ? "B" : "A"))).toBe(true);
    }
  });

  test("recordDeath retains five timestamped deaths and ages expiry text", async () => {
    const dir = await tempDir();
    const start = Date.UTC(2026, 10, 21, 12);
    let time = start;
    const notes = resident(dir, "A", at(0, 64, 0), () => time);
    for (let index = 0; index < 6; index++) {
      time = start + index * 60_000;
      await notes.recordDeath({ x: index, y: 64, z: 0 }, "minecraft:overworld");
    }
    time = start + 8 * 60_000;
    const reply = await notes.place_find({ query: "death", limit: 10 });
    expect(reply.split("\n").filter(line => line.startsWith("death "))).toHaveLength(5);
    expect(reply).toContain("death 3 min ago (5,64,0)");
    expect(reply).toContain("death 7 min ago, items probably gone (1,64,0)");
    expect(reply).not.toContain("(0,64,0)");
    expect(reply).not.toContain("death 8 min ago");
  });

  test("read-only calls on a fresh resident create neither resident nor shared directories", async () => {
    const dir = await tempDir();
    const notes = createNotes({ residentDir: join(dir, "A"), residentName: "A", position: at(0, 64, 0) });
    expect(await notes.place_find({})).toBe("No places or deaths.");
    expect(await notes.recall({ query: "anything" })).toBe('No matches for "anything". Searched: memory.md, journal.md, notebook.md, notes/**/*.md.');
    expect(await readdir(dir)).toEqual([]);
  });

  test("corrupt stores are reported and corrupt JSON never crashes tools", async () => {
    const dir = await tempDir();
    const notes = resident(dir, "A", at(0, 64, 0));
    await mkdir(join(dir, "A"), { recursive: true });
    await mkdir(join(dir, "shared"), { recursive: true });
    await writeFile(join(dir, "A", "places.json"), "{not json");
    await writeFile(join(dir, "shared", "places.json"), '{"places":"wrong"}');
    const corrupt = await notes.place_find({});
    expect(corrupt).toContain("private places.json is corrupt; treated as empty");
    expect(corrupt).toContain("shared places.json is corrupt; treated as empty");
    expect(await notes.place_save({ name: "recovered" })).toContain("private places.json is corrupt; treated as empty");
    expect(await notes.place_find({})).toContain("recovered (0,64,0) distance 0 blocks here");
  });

  test("place_save requires all three coordinates when any coordinate is supplied", () => {
    expect(notesDefinitions.place_save.schema.safeParse({ name: "bad", x: 1 }).success).toBe(false);
    expect(notesDefinitions.place_save.schema.safeParse({ name: "good", x: 1.9, y: 64, z: -2.1 }).success).toBe(true);
  });

  test("refuge notes are shown as reported, with the age of the last check, and found by the word refuge", async () => {
    const dir = await tempDir();
    const start = Date.UTC(2026, 10, 22, 6);
    let time = start;
    const a = resident(dir, "A", at(0, 64, 0), () => time);
    const b = resident(dir, "B", at(0, 64, 0), () => time);
    expect(await a.place_save({ name: "hut", note: "stone hut", x: 10, y: 64, z: 0, shared: true, refuge: { access: "door on the west side", hazards: "dark inside", checked: true } }))
      .toBe('Saved shared place "hut" at (10,64,0) in minecraft:overworld with refuge notes (checked now).');
    await a.place_save({ name: "field", x: 3, y: 64, z: 0, shared: true });
    time = start + 3 * 3_600_000;
    expect(await b.place_find({ query: "refuge" })).toBe("hut (10,64,0) distance 10 blocks east; stone hut; refuge as reported: access: door on the west side; hazards: dark inside; checked 3 h ago; by A");
    expect(await b.place_find({ query: "dark" })).toContain("hut (10,64,0)");

    // Saved again without a fresh check: the report changes, the time of the last check does not.
    expect(await a.place_save({ name: "hut", x: 10, y: 64, z: 0, shared: true, refuge: { hazards: "creeper seen nearby" } })).toContain("with refuge notes (last checked 3 h ago)");
    time = start + 50 * 3_600_000;
    expect(await a.place_find({ query: "hut" })).toBe("hut (10,64,0) distance 10 blocks east; refuge as reported: hazards: creeper seen nearby; checked 2 days ago");

    expect(await a.place_save({ name: "cave", x: 0, y: 40, z: 0, refuge: {} })).toContain("with refuge notes (never checked)");
    expect(await a.place_find({ query: "cave" })).toContain("refuge as reported: never checked");
  });

  test("a place with refuge notes is still a saved place to readers that do not know them", async () => {
    const dir = await tempDir();
    const notes = resident(dir, "A", at(0, 64, 0), () => 1000);
    await notes.place_save({ name: "hut", x: 1, y: 64, z: 1, refuge: { access: "ladder", checked: true } });
    const stored = JSON.parse(await readFile(join(dir, "A", "places.json"), "utf8"));
    expect(stored.places[0].refuge).toEqual({ access: "ladder", checkedAt: 1000 });
    expect((await readPlaces(join(dir, "A"), join(dir, "shared"))).places.map(place => place.name)).toEqual(["hut"]);
    expect(await notes.place_find({})).toContain("hut (1,64,1)");
  });

  test("refuge notes take only access, hazards and checked, each kept short", () => {
    const schema = notesDefinitions.place_save.schema;
    expect(schema.safeParse({ name: "hut", refuge: { access: "door", hazards: "none known", checked: true } }).success).toBe(true);
    expect(schema.safeParse({ name: "hut", refuge: { safe: true } }).success).toBe(false);
    expect(schema.safeParse({ name: "hut", refuge: { access: "x".repeat(121) } }).success).toBe(false);
  });
});
