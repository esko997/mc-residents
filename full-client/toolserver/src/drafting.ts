import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Body } from "./body.ts";
import { surveyDraftSite, renderDraftPreview, type DraftSite, type Point } from "./draft-site.ts";

const integer = z.number().int().safe();
const point = z.tuple([integer, integer, integer]);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use 1..40 lowercase letters, digits, _ or -; start with a letter or digit.");
const block = z.string().max(160).regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/).transform(id => {
  const full = id.includes(":") ? id : `minecraft:${id}`;
  return ["minecraft:cave_air", "minecraft:void_air"].includes(full) ? "minecraft:air" : full;
});
const region = { min: point, max: point };
const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("box"), ...region, block, mode: z.enum(["solid", "outline"]).default("solid") }).strict(),
  z.object({ op: z.literal("erase"), ...region }).strict(),
  z.object({ op: z.literal("repeat"), ...region, step: point, count: integer.min(1).max(32) }).strict(),
  z.object({ op: z.literal("mirror"), ...region, axis: z.enum(["x", "y", "z"]), about: integer }).strict(),
]);
const page = integer.min(1).optional();
export const draftingDefinitions = {
  draft_create: {
    description: "Survey a cropped client-loaded site and save a named LOCAL architecture draft; never builds, moves or loads chunks. origin is immutable WORLD [x,y,z]; inclusive min/max are LOCAL offsets. At most 48x64x48 blocks and 3x3 chunk columns. Unknown stays unknown. Example: {name:'hall-a',origin:[100,70,100],min:[-4,-2,-4],max:[4,8,4]}. Use draft_edit, draft_view, draft_compare and draft_preview next.",
    schema: z.object({ name, origin: point, ...region, notes: z.string().max(8000).optional() }).strict(),
  },
  draft_copy: { description: "Copy a saved draft to a new name for an alternative; retains its immutable world origin, dimension and original site survey. No world changes.", schema: z.object({ name, to: name }).strict() },
  draft_edit: {
    description: "Atomic LOCAL batch (1..64 operations), all coordinates local/inclusive and inside saved crop. box: block + min/max, mode solid or outline (six faces); air makes openings. erase removes intent (restores surveyed site, NOT air). repeat copies existing intent in region count times at step multiples; mirror copies intent across integer about on axis x/y/z. Sources are frozen per operation; later operations win. Max 500000 visited cells/batch; refuses, never clips. Optional notes replaces separate design prose (max8000). Never builds.",
    schema: z.object({ name, operations: z.array(operation).max(64).default([]), notes: z.string().max(8000).optional() }).strict().refine(a => a.operations.length > 0 || a.notes !== undefined, "Give operations or notes"),
  },
  draft_view: {
    description: "Read a LOCAL draft: summary, notes, plan (horizontal at local y), section_x (vertical at local x), section_z (vertical at local z), or legend. Two-character block symbols; ?? unknown, .. air. Planned cells replace surveyed cells; legend gives block ids. No physics/states simulated. at required for cuts. page starts at1; explicit next pages, no lost rows/text.",
    schema: z.object({ name, view: z.enum(["summary", "notes", "plan", "section_x", "section_z", "legend"]).default("summary"), at: integer.optional(), page }).strict(),
  },
  draft_compare: {
    description: "Compare planned intent only with original survey, or fresh:true with newly surveyed client-loaded as-built site (must be in saved dimension). Reports matched, unknown, excavation, replacement conflicts and block quantities, not items/recipes or structural safety. view materials, excavation or conflicts pages details. Unknown never counts as air or a match; fresh does not overwrite baseline. Never builds or certifies completion.",
    schema: z.object({ name, fresh: z.boolean().default(false), view: z.enum(["materials", "excavation", "conflicts"]).default("materials"), page }).strict(),
  },
  draft_preview: { description: "PNG schematic of saved terrain plus draft intent, not a Minecraft screenshot or physical simulation. facing looks in that compass direction from above/outside. Unknown cells remain unknown; no world changes.", schema: z.object({ name, facing: z.enum(["north", "east", "south", "west"]).default("north") }).strict() },
  draft_list: { description: "List your persistent local architecture drafts, including named alternatives. Explicit pages. Stored in RESIDENT_DIR/drafts; never shared or built automatically.", schema: z.object({ page }).strict() },
};
type DraftTool = keyof typeof draftingDefinitions;
type DraftCommand = { [K in DraftTool]: [K, z.infer<(typeof draftingDefinitions)[K]["schema"]>] }[DraftTool];
const savedSite = z.object({ origin: point, dimension: z.string().min(1).max(200), observedAt: z.string().datetime(), ...region, palette: z.array(block).max(4096), cells: z.array(integer.min(-1)).max(147456) }).strict();
const savedDraft = z.object({ version: z.literal(1), name, site: savedSite, overlay: z.array(z.tuple([integer.nonnegative(), block])).max(147456), notes: z.string().max(8000), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
type Draft = z.infer<typeof savedDraft>;
const air = "minecraft:air";
function extents(min: Point, max: Point) {
  const size = min.map((v, axis) => max[axis]! - v + 1);
  if (size.some(v => v <= 0) || size[0]! > 48 || size[1]! > 64 || size[2]! > 48) throw new Error("Crop must be ordered and at most 48x64x48 (x,y,z), inclusive.");
  return size as [number, number, number];
}
function validateBounds(site: Pick<DraftSite, "origin" | "min" | "max">) {
  const size = extents(site.min, site.max);
  for (const axis of [0, 2]) {
    const low = site.origin[axis]! + site.min[axis]!, high = site.origin[axis]! + site.max[axis]!;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || Math.abs(low) > 30_000_000 || Math.abs(high) > 30_000_000) throw new Error("World crop is outside safe Minecraft coordinates.");
    if (Math.floor(high / 16) - Math.floor(low / 16) + 1 > 3) throw new Error("World crop must fit within 3x3 chunk columns; reduce or shift local bounds.");
  }
  const lowY = site.origin[1] + site.min[1], highY = site.origin[1] + site.max[1];
  if (!Number.isSafeInteger(lowY) || !Number.isSafeInteger(highY)) throw new Error("Unsafe world y coordinate.");
  return size;
}
function validateSite(site: DraftSite) {
  const size = validateBounds(site);
  if (site.cells.length !== size[0] * size[1] * size[2] || site.cells.some(v => v < -1 || v >= site.palette.length)) throw new Error("Invalid site cell count or palette index; saved data was not changed.");
}
function index(site: DraftSite, p: Point) {
  if (p.some((v, axis) => v < site.min[axis]! || v > site.max[axis]!)) throw new Error(`Local coordinate [${p}] is outside the saved crop; nothing changed.`);
  const sx = site.max[0] - site.min[0] + 1, sz = site.max[2] - site.min[2] + 1;
  return p[0] - site.min[0] + sx * (p[2] - site.min[2] + sz * (p[1] - site.min[1]));
}
function coordinate(site: DraftSite, i: number): Point {
  const sx = site.max[0] - site.min[0] + 1, sz = site.max[2] - site.min[2] + 1;
  return [site.min[0] + i % sx, site.min[1] + Math.floor(i / (sx * sz)), site.min[2] + Math.floor(i / sx) % sz];
}
function actual(site: DraftSite, i: number) { const cell = site.cells[i]!; return cell === -1 ? undefined : site.palette[cell]!; }
function header(draft: Draft) { return `${draft.name}: ${draft.site.dimension} origin WORLD [${draft.site.origin}], crop LOCAL [${draft.site.min}]..[${draft.site.max}]\nSurvey ${draft.site.observedAt}; intent ${draft.overlay.length} cells. Local sandbox only.`; }
/** Whole-line paging, except prose (split explicitly into small chunks). Never relies on Tools' truncation. */
function paginate(title: string, lines: string[], requested = 1, budget = 1200) {
  // Stable page boundaries even when event tails differ between calls.
  const room = 1200 - title.length - 80;
  if (room < 180) throw new Error("Draft heading leaves too little room for a page.");
  const pages: string[][] = [[]]; let used = 0;
  for (const line of lines.length ? lines : ["none"]) {
    if (line.length + 1 > room) throw new Error("Draft row exceeds reply room; repeat without a long event tail.");
    if (used + line.length + 1 > room) { pages.push([]); used = 0; }
    pages.at(-1)!.push(line); used += line.length + 1;
  }
  if (requested > pages.length) throw new Error(`Only ${pages.length} pages; requested ${requested}.`);
  const result = `${title}\nPage ${requested}/${pages.length}${requested < pages.length ? `; next page:${requested + 1}` : "; end"}\n${pages[requested - 1]!.join("\n")}`;
  if (result.length > budget) throw new Error("Event tail leaves too little room for this draft page; repeat the same page without truncation.");
  return result;
}
function addCount(map: Map<string, number>, id: string) { map.set(id, (map.get(id) ?? 0) + 1); }
function counts(map: Map<string, number>) { return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${n} ${id}`); }

export class Drafts {
  private readonly directory: string;
  constructor(private readonly body: Body, private readonly helpers = { survey: surveyDraftSite, preview: renderDraftPreview }) { this.directory = join(body.config.residentDir, "drafts"); }
  private async read(name: string): Promise<Draft> {
    const path = join(this.directory, `${name}.json`);
    try {
      if ((await stat(path)).size > 32_000_000) throw new Error("Draft file exceeds 32MB.");
      const draft = savedDraft.parse(JSON.parse(await readFile(path, "utf8")));
      validateSite(draft.site);
      if (draft.name !== name || new Set(draft.overlay.map(([i]) => i)).size !== draft.overlay.length || draft.overlay.some(([i]) => i >= draft.site.cells.length)) throw new Error("Invalid draft identity or overlay indexes.");
      return draft;
    } catch (error) { throw new Error(`Cannot read draft ${name}: ${error instanceof Error ? error.message : error}. No data reset.`); }
  }
  private async save(draft: Draft) {
    const path = join(this.directory, `${draft.name}.json`), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(draft)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, ".write-lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Draft store busy (.write-lock). Retry after the other edit; after a crash ask the operator to remove the stale lock. No automatic lock stealing."); throw error; }
    try { await lock.writeFile(`pid=${process.pid}\n`); return await fn(); }
    finally { await lock.close(); await rm(lockPath); }
  }
  private async newName(name: string) {
    const files = (await readdir(this.directory)).filter(file => /^[a-z0-9][a-z0-9_-]{0,39}\.json$/.test(file));
    if (files.includes(`${name}.json`)) throw new Error(`Draft ${name} already exists; edit it or copy to a new name.`);
    if (files.length >= 32) throw new Error("At most 32 drafts per resident; archive unwanted draft files before creating more.");
  }
  async run(command: DraftCommand, budget = 1200): Promise<{ text: string; image?: string }> {
    const [tool, args] = command;
    if (tool === "draft_list") {
      let files: string[];
      try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw error; }
      return { text: paginate("Local architecture drafts (not built)", files.filter(f => /^[a-z0-9][a-z0-9_-]{0,39}\.json$/.test(f)).sort().map(f => f.slice(0, -5)), args.page, budget) };
    }
    if (tool === "draft_create") return this.locked(async () => {
      await this.newName(args.name);
      // Validate limits before any survey, including chunk-boundary alignment.
      validateBounds(args);
      const site = savedSite.parse(await this.helpers.survey(this.body, args.origin, args.min, args.max));
      validateSite(site);
      if (site.origin.some((v, i) => v !== args.origin[i]) || site.min.some((v, i) => v !== args.min[i]) || site.max.some((v, i) => v !== args.max[i])) throw new Error("Survey crop differs from requested crop; draft not saved.");
      const now = new Date().toISOString();
      const draft: Draft = { version: 1, name: args.name, site, overlay: [], notes: args.notes ?? "", createdAt: now, updatedAt: now };
      const text = paginate(header(draft), [`Saved. Unknown cells: ${site.cells.filter(v => v === -1).length}.`, "Next: draft_edit, draft_view plan/section_x/section_z, draft_compare, draft_preview."], 1, budget);
      await this.save(draft); return { text };
    });
    if (tool === "draft_copy") return this.locked(async () => {
      await this.newName(args.to); const draft = await this.read(args.name);
      draft.name = args.to; draft.createdAt = draft.updatedAt = new Date().toISOString();
      const text = paginate(header(draft), [`Copied ${args.name}; original survey and intent retained.`], 1, budget);
      await this.save(draft); return { text };
    });
    if (tool === "draft_edit") return this.locked(async () => {
      const draft = await this.read(args.name), overlay = new Map(draft.overlay); let visits = 0;
      const visit = (p: Point, apply: (i: number) => void) => { if (++visits > 500_000) throw new Error("Batch exceeds 500000 visited cells; nothing changed. Split the batch."); apply(index(draft.site, p)); };
      for (const op of args.operations) {
        extents(op.min, op.max); index(draft.site, op.min); index(draft.site, op.max);
        const source = op.op === "repeat" || op.op === "mirror" ? new Map(overlay) : undefined;
        for (let y = op.min[1]; y <= op.max[1]; y++) for (let z = op.min[2]; z <= op.max[2]; z++) for (let x = op.min[0]; x <= op.max[0]; x++) {
          const p: Point = [x, y, z];
          visit(p, i => {
            if (op.op === "box") { if (op.mode === "solid" || x === op.min[0] || x === op.max[0] || y === op.min[1] || y === op.max[1] || z === op.min[2] || z === op.max[2]) overlay.set(i, op.block); }
            else if (op.op === "erase") overlay.delete(i);
            else if (op.op === "repeat") {
              const value = source!.get(i);
              for (let n = 1; n <= op.count; n++) visit([x + n * op.step[0], y + n * op.step[1], z + n * op.step[2]], dest => { if (value !== undefined) overlay.set(dest, value); });
            } else {
              const axis = { x: 0, y: 1, z: 2 }[op.axis], target: [number, number, number] = [x, y, z];
              target[axis] = 2 * op.about - target[axis]!;
              visit(target, dest => { const value = source!.get(i); if (value !== undefined) overlay.set(dest, value); });
            }
          });
        }
      }
      draft.overlay = [...overlay].sort(([a], [b]) => a - b);
      if (args.notes !== undefined) draft.notes = args.notes;
      draft.updatedAt = new Date().toISOString();
      const text = paginate(header(draft), [`Saved atomic edit (${visits} visited cells). No world changes.`], 1, budget);
      await this.save(draft); return { text };
    });
    const draft = await this.read(args.name);
    if (tool === "draft_preview") return { text: paginate(header(draft), ["Schematic only; unknown terrain is not empty; block states/physics not simulated."], 1, budget), image: this.helpers.preview(draft.site, new Map(draft.overlay), args.facing).data };
    if (tool === "draft_view") {
      const site = draft.site, overlay = new Map(draft.overlay);
      if (args.view === "summary") return { text: paginate(header(draft), [`Updated ${draft.updatedAt}; notes ${draft.notes.length} characters.`, `Unknown site cells: ${site.cells.filter(v => v === -1).length}.`, "Cuts: plan at:y, section_x at:x, section_z at:z; symbols via legend. All coordinates LOCAL; north=-z, east=+x."], args.page, budget) };
      if (args.view === "notes") return { text: paginate(`${draft.name}: separate design prose`, draft.notes.match(/[\s\S]{1,160}/g) ?? [], args.page, budget) };
      const palette = [...new Set([...site.palette, ...overlay.values()])].filter(id => id !== air).sort();
      if (palette.length > 1296) throw new Error("More than 1296 non-air symbols; reduce palette before text cuts (preview/compare still available).");
      const symbols = new Map(palette.map((id, i) => [id, i.toString(36).padStart(2, "0")]));
      if (args.view === "legend") return { text: paginate(`${draft.name}: ??=unknown ..=air; block IDs only, no states`, palette.map(id => `${symbols.get(id)} ${id}`), args.page, budget) };
      if (args.at === undefined) throw new Error("Give at as a LOCAL coordinate for a plan or vertical section.");
      const axis = args.view === "plan" ? 1 : args.view === "section_x" ? 0 : 2;
      if (args.at < site.min[axis]! || args.at > site.max[axis]!) throw new Error("Cut at is outside saved local crop.");
      const lines: string[] = [], horizontal = axis === 0 ? 2 : 0, vertical = axis === 1 ? 2 : 1;
      for (let row = site.max[vertical]!; row >= site.min[vertical]!; row--) {
        let text = `${row}: `;
        for (let col = site.min[horizontal]!; col <= site.max[horizontal]!; col++) {
          const p: [number, number, number] = [0, 0, 0]; p[axis] = args.at; p[vertical] = row; p[horizontal] = col;
          const i = index(site, p), id = overlay.get(i) ?? actual(site, i);
          text += id === undefined ? "??" : id === air ? ".." : symbols.get(id)!;
        }
        lines.push(text);
      }
      return { text: paginate(`${draft.name} LOCAL ${args.view} at ${args.at}; columns ${"xyz"[horizontal]}=${site.min[horizontal]}..${site.max[horizontal]}, rows ${"xyz"[vertical]} descending; legend via draft_view`, lines, args.page, budget) };
    }
    // As-built is another read-only survey, never a rebase or implicit origin move.
    let site: DraftSite = draft.site;
    if (args.fresh) {
      const current = (await this.body.api.state()).dimension;
      if ((current.includes(":") ? current : `minecraft:${current}`) !== draft.site.dimension) throw new Error(`Draft belongs to ${draft.site.dimension}; fresh comparison refused in another dimension.`);
      site = savedSite.parse(await this.helpers.survey(this.body, draft.site.origin, draft.site.min, draft.site.max)); validateSite(site);
      if (site.dimension !== draft.site.dimension || site.origin.some((v, i) => v !== draft.site.origin[i]) || site.min.some((v, i) => v !== draft.site.min[i]) || site.max.some((v, i) => v !== draft.site.max[i])) throw new Error("Fresh survey dimension/crop changed; comparison refused.");
    }
    const materials = new Map<string, number>(), uncertain = new Map<string, number>(), excavation = new Map<string, number>();
    const conflicts: string[] = []; let matched = 0, unknown = 0, remove = 0, replace = 0;
    for (const [i, desired] of draft.overlay) {
      const existing = actual(site, i);
      if (existing === undefined) { unknown++; if (desired !== air) addCount(uncertain, desired); continue; }
      if (existing === desired) { matched++; continue; }
      if (desired !== air) addCount(materials, desired);
      if (existing !== air) { remove++; addCount(excavation, existing); if (desired !== air) { replace++; conflicts.push(`[${coordinate(site, i)}] ${existing} -> ${desired}`); } }
    }
    const title = `${draft.name}: ${args.fresh ? "FRESH as-built" : "original site"} ${site.observedAt}\nIntent ${draft.overlay.length}: matched ${matched}, unknown ${unknown}, excavate ${remove}, replacement conflicts ${replace}.`;
    const lines = args.view === "materials" ? ["Known placements (blocks, not item costs):", ...counts(materials), "Additional uncertain placements on unknown terrain:", ...counts(uncertain)] : args.view === "excavation" ? ["Known removals (not predicted drops):", ...counts(excavation)] : ["Known occupied replacement cells, LOCAL:", ...conflicts];
    return { text: paginate(title, lines, args.page, budget) };
  }
}
