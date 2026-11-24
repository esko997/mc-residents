import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Body } from "../src/body.ts";
import { Drafts, draftingDefinitions } from "../src/drafting.ts";
import type { DraftSite, Point } from "../src/draft-site.ts";
import { definitions, Tools } from "../src/tools.ts";
import { fixture } from "./fake-synapse.ts";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function workbench() {
  const directory = await mkdtemp(join(tmpdir(), "draft-workbench-")); directories.push(directory);
  let dimension = "overworld", reads = 0, mode: "baseline" | "built" | "wrong-dimension" = "baseline";
  const body = { config: { residentDir: directory }, api: { state: async () => ({ dimension }) } } as Body;
  const previewCalls: { site: DraftSite; overlay: Map<number, string>; facing: string }[] = [];
  const helpers = {
    survey: async (_body: Body, origin: Point, min: Point, max: Point): Promise<DraftSite> => {
      reads++;
      const length = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
      const cells = new Array<number>(length).fill(mode === "built" ? 2 : 0);
      if (mode === "baseline") { cells[0] = 1; if (length > 1) cells[1] = -1; }
      return { origin, min, max, dimension: mode === "wrong-dimension" ? "minecraft:the_nether" : "minecraft:overworld", observedAt: "2026-11-24T12:00:00.000Z", palette: ["minecraft:air", "minecraft:stone", "minecraft:oak_planks"], cells };
    },
    preview: (site: DraftSite, overlay: ReadonlyMap<number, string>, facing: "north" | "east" | "south" | "west") => {
      previewCalls.push({ site, overlay: new Map(overlay), facing });
      return { type: "image" as const, mimeType: "image/png" as const, data: "fixture-png-base64" };
    },
  };
  const drafts = new Drafts(body, helpers);
  const call = (tool: keyof typeof draftingDefinitions, args: unknown, budget?: number) => drafts.run([tool, draftingDefinitions[tool].schema.parse(args)] as Parameters<Drafts["run"]>[0], budget);
  const saved = async (name = "hall-a") => JSON.parse(await readFile(join(directory, "drafts", `${name}.json`), "utf8")) as { name: string; site: DraftSite; overlay: [number, string][]; notes: string };
  const create = (extra = {}) => call("draft_create", { name: "hall-a", origin: [100, 70, 100], min: [0, 0, 0], max: [4, 4, 4], ...extra });
  return { directory, call, saved, create, body, previewCalls, reads: () => reads, dimension: (value: string) => { dimension = value; }, mode: (value: typeof mode) => { mode = value; } };
}

describe("local architecture workbench", () => {
  test("persists baseline and immutable frame; named copies are independent after restart", async () => {
    const w = await workbench(); await w.create({ notes: "Fit the ridge first." });
    await w.call("draft_copy", { name: "hall-a", to: "hall-b" });
    await w.call("draft_edit", { name: "hall-b", operations: [{ op: "box", min: [0, 0, 0], max: [0, 0, 0], block: "oak_planks" }] });
    expect((await w.saved()).overlay).toEqual([]);
    const copy = await w.saved("hall-b"), original = await w.saved();
    expect(copy.site).toEqual(original.site); expect(copy.notes).toBe("Fit the ridge first.");
    const restarted = new Drafts(w.body);
    expect((await restarted.run(["draft_view", { name: "hall-b", view: "summary" }])).text).toContain("origin WORLD [100,70,100]");
    expect((await restarted.run(["draft_list", {}])).text).toContain("hall-b");
    expect(() => draftingDefinitions.draft_edit.schema.parse({ name: "hall-a", origin: [0, 0, 0], operations: [] })).toThrow();
    await expect(w.create()).rejects.toThrow("already exists");
  });
  test("outline has six faces, air makes an opening, erase removes intent rather than clearing terrain", async () => {
    const w = await workbench(); await w.create();
    await w.call("draft_edit", { name: "hall-a", operations: [
      { op: "box", min: [0, 0, 0], max: [2, 2, 2], block: "stone_bricks", mode: "outline" },
      { op: "box", min: [1, 0, 0], max: [1, 1, 0], block: "cave_air" },
      { op: "erase", min: [0, 0, 0], max: [0, 0, 0] },
    ] });
    const cells = new Map((await w.saved()).overlay);
    expect(cells.size).toBe(25); expect(cells.has(31)).toBe(false); // centre [1,1,1]
    expect(cells.get(1)).toBe("minecraft:air"); expect(cells.has(0)).toBe(false);
    expect((await w.saved()).site.cells[0]).toBe(1);
  });
  test("repeats and mirrors frozen intent with later operations winning", async () => {
    const w = await workbench(); await w.create();
    await w.call("draft_edit", { name: "hall-a", operations: [
      { op: "box", min: [0, 0, 0], max: [0, 0, 0], block: "oak_planks" },
      { op: "repeat", min: [0, 0, 0], max: [1, 0, 0], step: [1, 0, 0], count: 1 },
      { op: "mirror", min: [0, 0, 0], max: [1, 0, 0], axis: "x", about: 2 },
      { op: "box", min: [4, 0, 0], max: [4, 0, 0], block: "air" },
    ] });
    const cells = new Map((await w.saved()).overlay);
    expect(cells.get(1)).toBe("minecraft:oak_planks"); expect(cells.has(2)).toBe(false);
    expect(cells.get(3)).toBe("minecraft:oak_planks"); expect(cells.get(4)).toBe("minecraft:air");
  });
  test("refuses out-of-crop batches atomically, without silent clipping or partial notes", async () => {
    const w = await workbench(); await w.create(); const before = await w.saved();
    await expect(w.call("draft_edit", { name: "hall-a", notes: "must not save", operations: [
      { op: "box", min: [0, 0, 0], max: [1, 1, 1], block: "oak_planks" },
      { op: "repeat", min: [0, 0, 0], max: [1, 1, 1], step: [4, 0, 0], count: 1 },
    ] })).rejects.toThrow("outside the saved crop");
    expect(await w.saved()).toEqual(before);
    expect((await readdir(join(w.directory, "drafts"))).some(f => f.endsWith(".tmp") || f === ".write-lock")).toBe(false);
  });
  test("bounds dimensions and actual chunk span before surveying, including negative world coords", async () => {
    const w = await workbench();
    await expect(w.create({ max: [48, 0, 0] })).rejects.toThrow("48x64x48");
    await expect(w.create({ origin: [-1, 70, -1], max: [47, 0, 0] })).rejects.toThrow("3x3");
    expect(w.reads()).toBe(0);
    await w.create({ origin: [-16, 70, -16], max: [47, 63, 47] });
    expect((await w.saved()).site.cells).toHaveLength(147456);
  });
  test("bounded batch work is refused without partial persistence", async () => {
    const w = await workbench(); await w.create({ max: [47, 63, 47], origin: [96, 70, 96] });
    await expect(w.call("draft_edit", { name: "hall-a", operations: Array.from({ length: 4 }, () => ({ op: "box", min: [0, 0, 0], max: [47, 63, 47], block: "stone" })) })).rejects.toThrow("500000");
    expect((await w.saved()).overlay).toEqual([]);
  });
  test("horizontal plans, vertical sections, unknown/air legend and design notes stay distinct", async () => {
    const w = await workbench(); await w.create({ notes: "An airy ridge hall, not a production box." });
    await w.call("draft_edit", { name: "hall-a", operations: [{ op: "box", min: [2, 0, 0], max: [2, 0, 0], block: "oak_planks" }] });
    expect((await w.call("draft_view", { name: "hall-a", view: "plan", at: 0 })).text).toContain("??");
    expect((await w.call("draft_view", { name: "hall-a", view: "section_x", at: 0 })).text).toContain("rows y descending");
    expect((await w.call("draft_view", { name: "hall-a", view: "section_z", at: 0 })).text).toContain("columns x=0..4");
    expect((await w.call("draft_view", { name: "hall-a", view: "legend" })).text).toContain("minecraft:oak_planks");
    expect((await w.call("draft_view", { name: "hall-a", view: "notes" })).text).toContain("An airy ridge hall");
    await expect(w.call("draft_view", { name: "hall-a", view: "plan", at: 7 })).rejects.toThrow("outside");
    await expect(w.call("draft_view", { name: "hall-a", view: "plan" })).rejects.toThrow("Give at");
  });
  test("site comparison separates unknown from air, known materials, excavation and occupied conflicts", async () => {
    const w = await workbench(); await w.create();
    await w.call("draft_edit", { name: "hall-a", operations: [{ op: "box", min: [0, 0, 0], max: [2, 0, 0], block: "oak_planks" }] });
    const materials = (await w.call("draft_compare", { name: "hall-a" })).text;
    expect(materials).toContain("matched 0, unknown 1, excavate 1, replacement conflicts 1");
    expect(materials).toContain("2 minecraft:oak_planks"); expect(materials).toContain("1 minecraft:oak_planks");
    expect((await w.call("draft_compare", { name: "hall-a", view: "excavation" })).text).toContain("1 minecraft:stone");
    expect((await w.call("draft_compare", { name: "hall-a", view: "conflicts" })).text).toContain("[0,0,0] minecraft:stone -> minecraft:oak_planks");
    const baseline = (await w.saved()).site; w.mode("built");
    expect((await w.call("draft_compare", { name: "hall-a", fresh: true })).text).toContain("matched 3, unknown 0");
    expect((await w.saved()).site).toEqual(baseline);
  });
  test("fresh comparison refuses cross-dimension state and survey races", async () => {
    const w = await workbench(); await w.create(); w.dimension("the_nether");
    await expect(w.call("draft_compare", { name: "hall-a", fresh: true })).rejects.toThrow("another dimension");
    expect(w.reads()).toBe(1); w.dimension("minecraft:overworld"); w.mode("wrong-dimension");
    await expect(w.call("draft_compare", { name: "hall-a", fresh: true })).rejects.toThrow("dimension/crop changed");
  });
  test("preview delegates the exact immutable site, overlay and facing, without surveying", async () => {
    const w = await workbench(); await w.create();
    const result = await w.call("draft_preview", { name: "hall-a", facing: "east" });
    expect(result.image).toBe("fixture-png-base64"); expect(w.previewCalls[0]!.facing).toBe("east");
    expect(w.previewCalls[0]!.site).toEqual((await w.saved()).site); expect(w.reads()).toBe(1);
  });
  test("corrupt persisted data and active lock fail explicitly without reset or lock stealing", async () => {
    const w = await workbench(); await w.create();
    const path = join(w.directory, "drafts", "hall-a.json"); await writeFile(path, "{broken");
    await expect(w.call("draft_view", { name: "hall-a" })).rejects.toThrow("No data reset");
    expect(await readFile(path, "utf8")).toBe("{broken");
    await writeFile(join(w.directory, "drafts", ".write-lock"), "other process");
    await expect(w.call("draft_copy", { name: "hall-a", to: "hall-b" })).rejects.toThrow("busy");
    expect(await readFile(join(w.directory, "drafts", ".write-lock"), "utf8")).toBe("other process");
  });
  test("long prose pages explicitly and page boundaries do not shift with event budget", async () => {
    const w = await workbench(); await w.create({ notes: "a".repeat(4000) + "END-OF-DESIGN" });
    const first = (await w.call("draft_view", { name: "hall-a", view: "notes" }, 1200)).text;
    expect(first).toContain("next page:2");
    expect((await w.call("draft_view", { name: "hall-a", view: "notes" }, 1400)).text).toBe(first);
    await expect(w.call("draft_view", { name: "hall-a", view: "notes" }, 100)).rejects.toThrow("repeat the same page");
    const total = Number(first.match(/Page 1\/(\d+)/)![1]);
    expect((await w.call("draft_view", { name: "hall-a", view: "notes", page: total })).text).toContain("END-OF-DESIGN");
    await expect(w.call("draft_view", { name: "hall-a", view: "notes", page: total + 1 })).rejects.toThrow("Only");
  });
  test("Tools discovers workbench without knowledge DB and preserves paged text through event wrapper", async () => {
    const f = await fixture();
    expect(f.tools.registeredNames).toContain("draft_create"); expect(definitions.draft_edit.schema).toBe(draftingDefinitions.draft_edit.schema);
    const w = await workbench(); await w.create({ notes: "z".repeat(4000) });
    // Share only saved files with the real Tools path; no world transport is needed to read a draft.
    await mkdir(join(f.body.config.residentDir, "drafts"), { recursive: true });
    await writeFile(join(f.body.config.residentDir, "drafts", "hall-a.json"), await readFile(join(w.directory, "drafts", "hall-a.json")));
    const tools = new Tools(f.body); const result = await tools.call("draft_view", { name: "hall-a", view: "notes" }); tools.close();
    expect(result.isError).toBe(false);
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    expect(text).toContain("next page:2"); expect(text).not.toContain("remaining output omitted"); expect(text.length).toBeLessThan(1500);
  });
});
