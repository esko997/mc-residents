import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Body, mineCounted } from "./body.ts";
import { hostileEntity, nonempty, playerEntity, unseenSights, type Stack } from "./synapse.ts";
import type { Knowledge, RecipeSummary } from "./knowledge/types.ts";
import { craft } from "./craft.ts";
import { createNotes, notesDefinitions, type Notes } from "./notes.ts";
import { Skills, skillDefinitions, type SkillRun, type ToolReply } from "./skills.ts";
import { createPlans, planDefinitions, type Plans } from "./plan.ts";
import { readPlaces, snapshotOf, whatNext } from "./ideas.ts";
import { guideDefinition, lookupGuide } from "./guides.ts";
import { fromMod, modsDefinition, modsReply, packKinds } from "./mods.ts";
import { CommonsClient } from "./commons.ts";
import { createSociety, societyDefinitions, type Society } from "./society.ts";
import { KnowledgeGaps, guideFeedbackDefinition, guideUpdatesDefinition, registerResidentTools } from "./knowledge-gaps.ts";
import { machineDefinitions, machineToolNames, Machines } from "./machines.ts";
import { executeNavigation, navigationDefinitions, navigationStatus } from "./navigation.ts";
import { vehicleDefinitions, Vehicles, vehicleStatusLine } from "./vehicles.ts";
import { alarmDefinition, alarmFromState } from "./alarms.ts";
import { attackReport, bucketGuard, bucketKind, bucketReport, holdReport, lookReport, sightsText, writeSign } from "./aim.ts";

const finite = z.number().finite();
// Block coordinates use the containing block, including at negative positions.
const blockCoordinate = finite.transform(Math.floor);
const name = z.string().regex(/^\w{1,16}$/, "Use an in-game player name.");
const itemId = z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Use an item or block registry id.").transform(id => id.includes(":") ? id : `minecraft:${id}`);
const hold = { hold_ticks: z.number().int().min(1).max(200).optional() };
const key = z.enum(["ENTER", "ESCAPE", "BACKSPACE", "TAB", "UP", "DOWN", "LEFT", "RIGHT", "DELETE"]);
export const definitions = {
  wait: { description: "Wait 1..120 seconds until something happens: chat, damage, death, a reflex, an audible alarm, a player arriving, or news of your trip; for lists which of these may end it (default: all). A chat line ends it only if it names you, comes from someone who is not a resident (a person or the caretaker), comes from within 48 blocks, or continues an exchange (you named them, or they named you, in the last 2 minutes); every other line still shows in the next result.", schema: z.object({ seconds: z.number().min(1).max(120), for: z.array(z.enum(["chat", "hurt", "died", "player_near", "arrived", "stopped_short", "navigation_stopped", "reflex", "alarm"])).optional() }).strict() },
  alarm: alarmDefinition,
  ...navigationDefinitions,
  mine: { description: "Start Baritone mining of blocks near you: it walks to the nearest blocks of this kind within radius blocks (default 32, max 96) of where you stand now and breaks them to collect them. With count it stops when that many have come into your inventory (an arrived event says what was collected); without it, or when none is left that near, it stops with a navigation_stopped event that says what was collected and the nearest one Baritone knows farther off. To see where they are first, without moving: find_block (same radius). To look farther: a larger radius, or go there first. It breaks ANY matching block, including ones players placed (chests, doors, machines), so use it for natural blocks such as logs, stone and ores, never for things someone built. With the tree-chopping mod a log takes several chops; mining a log handles that. Bare block names mean minecraft:.", schema: z.object({ block: itemId, count: z.number().int().positive().optional(), radius: z.number().int().min(1).max(96).optional() }).strict() },
  find_block: { description: "Where the nearest blocks of a kind are, without moving, loading or breaking anything: up to limit (default 8, max 16) within radius blocks of you (default 32, max 96; a sphere around the block you stand in), nearest first, each with distance and direction. Any block can be asked for, natural ones too (ores, logs, crops, water), by its block id: diamond_ore, not the item diamond; an id that is no block is an error. Bare names mean minecraft:. It reads the chunks your client has loaded in this dimension as they are now, and says when part of the radius is not loaded: that part was not searched, so none found there means not looked at. It does not check that you can get to a block.", schema: z.object({ block: itemId, radius: z.number().int().min(1).max(96).optional(), limit: z.number().int().min(1).max(16).optional() }).strict() },
  status: { description: "Brief body, surroundings, navigation and screen status, and the current step of the plan in focus.", schema: z.object({}) },
  inventory: { description: "Non-empty inventory stacks; H marks hotbar (slots 0..8).", schema: z.object({}) },
  say: { description: "Speak plain chat, independently of walking; not commands. Text longer than one chat line (256 characters) is sent as up to three lines.", schema: z.object({ text: z.string().min(1).max(768) }) },
  look: { description: "Look by yaw and/or pitch (an omitted one stays as it is), at a world block (floats use the containing block; aims at its centre and says what is actually in your sights, water and lava included, and whether a fluid is a source a bucket can take), or at a nearby player by name.", schema: z.union([z.object({ yaw: finite.optional(), pitch: finite.min(-90).max(90).optional() }).strict().refine(a => a.yaw !== undefined || a.pitch !== undefined, "give yaw, pitch or both"), z.object({ x: blockCoordinate, y: blockCoordinate, z: blockCoordinate }).strict(), z.object({ player: name }).strict()]) },
  use: { description: "Right-click; optionally hold use 1..200 ticks (20 ticks/s). With a bucket it acts on the fluid along your line of sight and says what it did: an empty bucket takes the first source block of water or lava in reach (look at it first: look x,y,z), a full one pours against the block face in your sights. A boat, cart or player in your sights is refused rather than boarded.", schema: z.object(hold).strict() },
  attack: { description: "Left-click what is in your sights and say what it hit. hold_ticks holds attack to break a block by hand, then says whether it broke (the reply comes when the hold is over); a held attack hits a creature only once. Your body fights back on its own when attacked (set_reflexes).", schema: z.object(hold).strict() },
  select_hotbar: { description: "Select hotbar slot 0..8.", schema: z.object({ slot: z.number().int().min(0).max(8) }) },
  eat: { description: "Eat inventory food, moving it to the hotbar if needed; refuses open screens and reports observed food change.", schema: z.object({ item: itemId.optional() }).strict() },
  open_inventory: { description: "Open your own inventory to inspect or move stacks; refuses to replace another screen.", schema: z.object({}) },
  screen: { description: "Read screen title, indexed stacks, empty slot indexes, buttons and text boxes. Slot indexes belong to this menu, not your inventory. For modded machines consult guide or picture for slot roles; empty does not mean it accepts every item.", schema: z.object({}) },
  click_slot: { description: "Click a container menu slot; indexes come from screen, not inventory. Mode THROW throws the stack (button 1) or one item (button 0) the way you face; after two seconds anyone can pick it up, you included, so throw toward the receiver and step back.", schema: z.object({ slot: z.number().int().min(-999), button: z.number().int().min(0).max(8).optional(), mode: z.enum(["PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "QUICK_CRAFT", "PICKUP_ALL"]).optional() }).strict() },
  click_button: { description: "Press a screen button by label or widget index.", schema: z.union([z.object({ label: z.string().min(1) }).strict(), z.object({ index: z.number().int().nonnegative() }).strict()]) },
  type_text: { description: "Type characters into the open screen (including sign/book editors).", schema: z.object({ text: z.string().max(8192) }) },
  press_key: { description: "Press a named key once and report the screen open afterwards.", schema: z.object({ key }) },
  close_screen: { description: "Close the current screen, verify, and try ESCAPE if still open; report the actual result.", schema: z.object({}) },
  picture: { description: "See the client framebuffer as an image.", schema: z.object({}) },
  write_sign: { description: "Put the selected sign on the face of the block you look at (crouching, so a chest, barrel or door there is not opened), write up to four lines, finish. Says where it went, or why nothing was placed.", schema: z.object({ lines: z.array(z.string().max(90).refine(s => !/[\r\n]/.test(s), "One line per entry.")).min(1).max(4) }) },
  find_item: { description: "Search modpack item ids and display names.", schema: z.object({ query: z.string().min(1).max(200) }) },
  recipes: { description: "Recipes producing an item id, including shaped grids.", schema: z.object({ item: itemId }) },
  craft: { description: "Craft an item in one call: looks up the recipe, lays it out in the grid and takes the result into your inventory; prefer it to click_slot. Works at an open crafting table (3x3); recipes that fit 2x2 also work with no screen open, because it opens your own inventory itself. count is the number of crafting operations, not items (one craft of sticks gives 4); default 1. The screen stays open afterwards.", schema: z.object({ item: itemId, count: z.number().int().min(1).max(16).optional() }).strict() },
  uses: { description: "Recipes consuming an item id (including matching tags).", schema: z.object({ item: itemId }) },
  mods: modsDefinition,
  guide: guideDefinition,
  guide_feedback: guideFeedbackDefinition,
  guide_updates: guideUpdatesDefinition,
  ...societyDefinitions,
  ...machineDefinitions,
  ...vehicleDefinitions,
  note_difficulty: { description: "Tell body maintainers what is hard; append dated position and last error to difficulties.md.", schema: z.object({ text: z.string().min(1).max(4000) }) },
  set_reflexes: { description: "Configure eating, attack response and survival rescues. when_attacked: auto (default) fights back with the best sword or axe in your hotbar when a hostile mob hurts you or comes within reach, at 8 health or more, and otherwise flees; fight fights back even bare-handed; flee always flees; nothing does neither. A fight never chases, never aims at players, animals or creepers, and breaks off to flee at 6 health. Rescues: surface (drowning), escape_fire (fire/lava), avoid_creepers, water_bucket (douse fire with a hotbar water bucket; off by default because the water can push you and is left flowing).", schema: z.object({ auto_eat: z.boolean().optional(), eat_below: z.number().int().min(0).max(20).optional(), when_attacked: z.enum(["auto", "fight", "flee", "nothing"]).optional(), surface: z.boolean().optional(), escape_fire: z.boolean().optional(), avoid_creepers: z.boolean().optional(), water_bucket: z.boolean().optional() }) },
  ...notesDefinitions,
  ...skillDefinitions,
  // The shared contracts leave the cap out of these two descriptions; a larger limit is shown as the cap.
  skill_find: { ...skillDefinitions.skill_find, description: `${skillDefinitions.skill_find.description} limit: default 5, at most 10.` },
  notes_shared: { ...skillDefinitions.notes_shared, description: `${skillDefinitions.notes_shared.description} limit: default 3, at most 8.` },
  ...planDefinitions,
  what_next: { description: "For when you are unsure what to do: at most five suggestions worked out from what your body can see (what you carry and wear, health and food, saved places, recent deaths, your plan), each with the numbers it rests on. They name things that are missing or unused; they are not orders. The current step of your plan in focus comes first.", schema: z.object({}).strict() },
};
export type ToolName = keyof typeof definitions;
/**
 * The most a tool's `limit` argument accepts, read from its schema (zod 3; the shared contracts' own zod copy
 * too, so by shape). A larger limit is lowered to it, and the reply says so, rather than refused: residents kept
 * asking place_find for 12 to 20 places and losing the call.
 */
function limitCap(schema: unknown): number | undefined {
  type Node = { _def?: { schema?: Node; innerType?: Node; checks?: { kind: string; value?: unknown }[] }; shape?: Record<string, Node> };
  let object = schema as Node | undefined;
  while (object?._def?.schema) object = object._def.schema;
  let field = object?.shape?.limit;
  while (field?._def?.innerType) field = field._def.innerType;
  const max = field?._def?.checks?.find(check => check.kind === "max")?.value;
  return typeof max === "number" ? max : undefined;
}
const limitCaps: Partial<Record<string, number>> = Object.fromEntries(Object.entries(definitions)
  .map(([tool, definition]): [string, number | undefined] => [tool, limitCap(definition.schema)]).filter(([, cap]) => cap !== undefined));
/** The argument names a tool takes, read from its schema by shape (an object, or each form of a union such as look's). */
function argumentNames(schema: unknown): string[] {
  type Node = { _def?: { schema?: Node; innerType?: Node; options?: Node[] }; shape?: Record<string, Node> };
  let node = schema as Node | undefined;
  for (let inner = node?._def?.schema ?? node?._def?.innerType; inner; inner = node?._def?.schema ?? node?._def?.innerType) node = inner;
  if (node?._def?.options) return [...new Set(node._def.options.flatMap(argumentNames))];
  return Object.keys(node?.shape ?? {});
}
/** What to say about an argument a tool does not take, when a likely meaning is known. Margo's `until` (201 waits in
 * one hour, 2026-11-23) was dropped without a word while wait was lenient, and chat she meant to ignore woke her. */
const argumentHints: Partial<Record<string, Record<string, string>>> = {
  wait: { until: "use for to list the events that may end the wait" },
  attack: { ticks: "use hold_ticks" }, use: { ticks: "use hold_ticks" },
  click_slot: { action: "use mode for QUICK_MOVE, THROW and the rest" },
};
const knowledgeNames = ["find_item", "recipes", "craft", "uses", "mods"];
// attack takes the body itself, for the click only: see execute().
const takeoverTools = ["look", "use", "select_hotbar", "eat", "open_inventory", "close_screen", "click_slot", "craft", "click_button", "type_text", "press_key", "write_sign", "mount", "dismount", "vehicle_control", "vehicle_boost", "vehicle_inventory", ...machineToolNames];
/** The resident's own actions on a screen. While one of these was called in the last 30 s, auto-eat leaves an open screen alone. */
const screenTools = ["use", "open_inventory", "screen", "click_slot", "click_button", "craft", "type_text", "press_key", "close_screen", "write_sign", "vehicle_inventory", ...machineToolNames];
const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const livestock: Record<string, true> = { "minecraft:cow": true, "minecraft:sheep": true, "minecraft:pig": true, "minecraft:chicken": true };
/** "9 blocks north-east, 3 up": north is -z, east is +x. */
function bearing(dx: number, dy: number, dz: number) {
  const blocks = Math.round(Math.hypot(dx, dy, dz)), count = `${blocks} block${blocks === 1 ? "" : "s"}`;
  if (!dx && !dz) return dy ? `${count} straight ${dy > 0 ? "up" : "down"}` : "where you stand";
  const across = compass[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8]!;
  return `${count} ${across}${dy ? `, ${Math.abs(dy)} ${dy > 0 ? "up" : "down"}` : ""}`;
}
function stackText(stack: Stack, mark = "") {
  const durability = stack.durability === undefined ? "" : ` (${stack.durability}/${stack.maxDurability})`;
  return `${mark}${stack.slot}: ${stack.count} x ${stack.item}${durability}`;
}
function recipeText(recipe: RecipeSummary) {
  const stacks = (list: RecipeSummary["inputs"]) => list.map(i => `${i.count}x ${i.what}`).join(" + ");
  let text = `${recipe.type}: ${stacks(recipe.inputs)} -> ${stacks(recipe.outputs)}`;
  if (recipe.pattern) {
    const symbols: Record<string, string> = {};
    const grid = recipe.pattern.map(row => row.map(cell => {
      if (!cell) return ".";
      symbols[cell] ??= String.fromCharCode(65 + Object.keys(symbols).length);
      return symbols[cell];
    }).join("")).join("/");
    text += `\ngrid ${grid} ${Object.entries(symbols).map(([id, symbol]) => `${symbol}=${id}`).join(" ")}`;
  } else if (recipe.note) text += ` (${recipe.note})`;
  return text;
}
type Command = { [K in ToolName]: [K, z.infer<(typeof definitions)[K]["schema"]>] }[ToolName];
export class Tools {
  lastError?: string;
  /** How long craft waits for the server to show a crafting result or deliver it. */
  craftWaitMs = 2000;
  /** How long write_sign waits for the sign editor after the click. */
  signWaitMs = 2000;
  /** Wall clock for plans and suggestions: their times are kept on disk and outlive the tool server. */
  now: () => number = Date.now;
  /** His own notes and places. Deaths are recorded as places so he can judge whether to go back. */
  readonly notes: Notes;
  /** His saved routines and what residents share, in the commons. */
  readonly skills: Skills;
  /** His jobs of several steps, written down so the current step survives a summarised context and a restart. */
  readonly plans: Plans;
  private readonly commons: CommonsClient;
  private readonly society: Society;
  private stopPolling?: () => void;
  readonly gaps: KnowledgeGaps;
  private readonly machines: Machines;
  private readonly vehicles: Vehicles;
  constructor(readonly body: Body, readonly knowledge?: Knowledge, private knowledgeError = "KNOWLEDGE_DB is not configured.") {
    const { residentDir, name } = body.config;
    this.machines = new Machines(body.api);
    this.vehicles = new Vehicles(body.api);
    this.commons = new CommonsClient(body.config.commonsUrl, body.config.commonsTokenFile);
    this.notes = createNotes({
      residentDir, residentName: name, commons: this.commons,
      position: async () => { const state = await body.api.state(); return { ...state.pos, dimension: state.dimension }; },
    });
    body.onDeath = death => this.notes.recordDeath(death.pos, death.dimension);
    this.skills = new Skills(body, this.commons, (tool, args, signal, run) => this.run(tool, args, signal, run));
    this.plans = createPlans({ residentDir, now: () => this.now() });
    this.society = createSociety({ client: this.commons, resident: name });
    if (body.config.commonsUrl && body.config.commonsTokenFile) {
      void registerResidentTools(this.commons, name, this.registeredNames).catch(() => {});
      body.onAlarm = alarm => this.commons.alarm(alarm);
      // Only alarms beyond earshot ask; a failed or slow hub answers null, which perceives nothing.
      body.canSee = sender => this.commons.sight(sender).then(answer => answer.visible, () => null);
      this.stopPolling = this.commons.poll(body.events, alarm => body.hearAlarm(alarm));
    }
    this.gaps = new KnowledgeGaps(this.commons, name, () => {
      try {
        const focus = JSON.parse(readFileSync(join(residentDir, "plan.json"), "utf8")).focus;
        return typeof focus === "string" ? focus : "";
      } catch { return ""; }
    });
  }
  close() { this.stopPolling?.(); this.body.onAlarm = undefined; this.body.canSee = undefined; }
  private social(): Society { return this.society; }
  get registeredNames(): ToolName[] {
    return (Object.keys(definitions) as ToolName[]).filter(n => this.knowledge || !knowledgeNames.includes(n));
  }
  async call(name: string, args: unknown = {}, signal?: AbortSignal): Promise<CallToolResult> {
    const reply = await this.run(name, args, signal);
    let text = reply.text;
    const events = this.body.events.consume();
    const budget = 1499 - events.length - 2;
    if (text.length > budget) text = text.slice(0, budget - 28) + "\n… remaining output omitted.";
    return { isError: reply.isError, content: [...(reply.image ? [{ type: "image" as const, data: reply.image, mimeType: "image/png" }] : []), { type: "text", text: `${text}\n\n${events}` }] };
  }
  /** One tool call without the event tail; errors come back as text. `skill` is set when skill code makes the call. */
  async run(name: string, args: unknown, signal?: AbortSignal, skill?: SkillRun): Promise<ToolReply & { image?: string }> {
    let text: string;
    let image: string | undefined;
    let isError = false;
    try {
      if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown tool: ${name}`);
      const cap = limitCaps[name];
      let lowered: string | undefined;
      // Only a whole number over the cap is lowered; fractions, Infinity and NaN still fail the schema's own checks.
      if (cap !== undefined && args !== null && typeof args === "object" && "limit" in args && typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > cap) {
        lowered = `Asked for ${args.limit}; showing at most ${cap}, the most ${name} lists.`;
        args = { ...args, limit: cap };
      }
      const parsed = definitions[name as ToolName].schema.parse(args);
      // The runtime-selected schema and its tool name are a correlated pair.
      const command = [name, parsed] as Command;
      const run = () => this.execute(command, signal, skill);
      const onScreen = screenTools.includes(name);
      if (onScreen) this.body.screenTouched();
      const value = await (takeoverTools.includes(name) ? this.body.manualAction(run) : run()).finally(() => { if (onScreen) this.body.screenTouched(); });
      if (typeof value === "string") text = value;
      else { text = value.text; image = value.image; isError = value.isError === true; }
      if (lowered && !isError) text = `${lowered}\n${text}`;
    } catch (error) {
      // A bare "Invalid input" (from a union such as look's three forms) tells
      // the model nothing; the description says which shapes are accepted.
      // Shared contracts parse with Commons' own zod copy, so match by shape, not class.
      const issues = error instanceof Error && error.name === "ZodError" && Array.isArray((error as z.ZodError).issues)
        ? (error as z.ZodError).issues : undefined;
      // An argument the tool does not take is named, with the ones it does take, rather than dropped.
      const issueText = (i: z.ZodIssue) => {
        if (i.code !== "unrecognized_keys") return `${i.path.join(".") || "input"}: ${i.message}`;
        const hints = i.keys.flatMap(key => argumentHints[name]?.[key] ? [`for ${key}, ${argumentHints[name]![key]}`] : []);
        const taken = argumentNames(definitions[name as ToolName]?.schema);
        return `${i.keys.join(", ")} ${i.keys.length === 1 ? "is not an argument" : "are not arguments"} of ${name}, which takes ${taken.join(", ") || "none"}${hints.length ? `; ${hints.join("; ")}` : ""}`;
      };
      const message = issues
        ? `${issues.map(issueText).join("; ")}. ${name}: ${definitions[name as ToolName]?.description ?? ""}`
        : error instanceof Error ? error.message : "Tool failed.";
      this.lastError = message.replace(/\s+/g, " ").slice(0, 400);
      text = `Error: ${this.lastError}`; isError = true;
    }
    return { text, image, isError };
  }
  private async execute(command: Command, signal?: AbortSignal, skill?: SkillRun): Promise<string | { text: string; image?: string; isError?: boolean }> {
    const [tool, args] = command;
    const body = this.body, api = body.api;
    switch (tool) {
      case "alarm": {
        const state = await api.state();
        if (state.health <= 0) throw new Error("You cannot raise an alarm while dead.");
        return (await this.commons.alarm(alarmFromState("manual", args.reason, state))).message;
      }
      case "wait": {
        if (!skill) return body.events.wait(args.seconds, args.for, signal);
        // Nothing shows events to skill code between its calls, so a wait there
        // counts only what happened since the run's last wait and returns those lines.
        const cursor = skill.shared.eventCursor;
        const outcome = await body.events.wait(args.seconds, args.for, signal, cursor);
        skill.shared.eventCursor = body.events.latest;
        return [outcome, ...body.events.since(cursor)].join("\n");
      }
      case "go_to": case "follow": case "explore": case "stop":
        // Following an unseen player would show where they are; to the body they are not there.
        if (tool === "follow" && body.config.unseen?.some(player => player.toLowerCase() === args.player.toLowerCase())) throw new Error(`Player ${args.player} is not nearby.`);
        return executeNavigation(body, command);
      case "storage_grid": case "storage_grid_take": case "machine_sides": case "machine_sides_set":
        return this.machines.run(command);
      case "vehicle": case "mount": case "dismount": case "vehicle_control": case "vehicle_boost": case "vehicle_inventory":
        if (tool !== "vehicle" && body.navigation) await body.stopNavigation();
        return this.vehicles.run(tool, args, signal);
      case "mine": {
        const command = `#mine ${args.count === undefined ? "" : `${args.count} `}${args.block}`, radius = args.radius ?? 32;
        // Gary's `mine 12 denseores:dense_iron_ore` ran on past 13 raw iron: the count was kept in the dense ore alone.
        const lootDrops = this.knowledge?.blockDrops?.(args.block);
        await body.navigate(command, { mode: "excavate", mine: { block: args.block, radius, count: args.count, lootDrops } });
        const started = `Started ${command}, kept within ${radius} blocks of here.`;
        if (args.count === undefined) return started;
        const { counted, known } = mineCounted(args.block, lootDrops);
        if (!known) return `${started} The count is kept in ${args.block} itself only: what it drops is not known, so the count may not finish; watch your inventory and stop when you have enough.`;
        return `${started} The count is kept in ${counted.join(" and ")}${known === "vanilla" ? "" : ` (drop known from ${known})`}: what came into your inventory, not blocks broken.`;
      }
      case "find_block": {
        const radius = args.radius ?? 32;
        const found = await api.blocks(args.block, radius, args.limit ?? 8);
        const [x, y, z] = found.origin, loaded = found.chunksLoaded, chunks = found.chunksInRadius;
        const around = `within ${radius} block${radius === 1 ? "" : "s"} of you (${x},${y},${z})`;
        if (!loaded) return `Nothing was searched: no chunk ${around} is loaded in your client (${chunks} in that radius).`;
        // Chunks the client does not hold were not read: say so before the list, which a long reply cuts from the end.
        const searched = loaded < chunks
          ? `only ${loaded} of the ${chunks} chunks in that radius ${loaded === 1 ? "is" : "are"} loaded in your client; the rest was not searched`
          : `every chunk in that radius was searched (${chunks})`;
        if (!found.positions.length) {
          if (loaded < chunks) return `No ${found.block} in the loaded chunks ${around}, but ${searched}.`;
          return `No ${found.block} ${around}; ${searched}. ${radius < 96 ? "A larger radius (max 96) looks farther." : "96 is the largest radius: to look farther, go there first."}`;
        }
        const count = found.truncated ? `the ${found.positions.length} nearest ${around}, there are more` : `${found.positions.length} ${around}, nearest first`;
        return [
          `${found.block}: ${count}; ${searched}:`,
          ...found.positions.map(([bx, by, bz]) => `${bx},${by},${bz}, ${bearing(bx - x, by - y, bz - z)}`),
          "This is where the blocks are as your client sees them now; whether you can get to one is not checked.",
        ].join("\n");
      }
      case "say": {
        if (/^[#/]/.test(args.text.trimStart()) || /[\r\n]/.test(args.text)) throw new Error("Plain chat only; use movement tools for # commands. Slash commands are not a resident tool.");
        // Minecraft refuses chat lines over 256 characters; break between words.
        const lines: string[] = [];
        let rest = args.text.trim();
        while (rest.length > 256) {
          const cut = rest.lastIndexOf(" ", 256);
          const at = cut > 128 ? cut : 256;
          lines.push(rest.slice(0, at).trimEnd());
          rest = rest.slice(at).trimStart();
        }
        if (rest) lines.push(rest);
        for (const line of lines) await api.chat(line);
        // Whoever it names is someone this resident is now talking to: their replies wake its waits (see Hearing).
        body.hearing.said(args.text);
        return lines.length === 1 ? "Said." : `Said, in ${lines.length} lines.`;
      }
      case "status": {
        const state = await api.state(true);
        const nearby = state.nearbyEntities ?? [];
        const held = state.hotbar.find(s => s.slot === state.selectedSlot);
        const survivalWarning = body.survivalStatus(state);
        const mounted = vehicleStatusLine(state);
        return [
          `Position ${state.pos.x}, ${state.pos.y}, ${state.pos.z} | ${state.dimension}`,
          `Health ${state.health}/20 | food ${state.food}/20`,
          ...(state.underwater === true ? [`Air ${state.air ?? "unknown"}/${state.maxAir ?? "unknown"}`] : []),
          ...(state.onFire === true || state.inLava === true ? [`Hazard: ${[state.onFire === true ? "burning" : "", state.inLava === true ? "in lava" : ""].filter(Boolean).join(", ")}`] : []),
          ...(mounted ? [mounted] : []),
          `Held ${held && nonempty(held) ? `${held.count} x ${held.item}` : "empty"} (H${state.selectedSlot})`,
          `Looking ${state.lookingAt.block ?? state.lookingAt.entity ?? state.lookingAt.type}`,
          `Players: ${nearby.filter(playerEntity).map(e => `${e.name ?? `#${e.id}`} ${e.distance}m`).join(", ") || "none"}`,
          `Hostiles: ${nearby.filter(hostileEntity).slice(0, 8).map(e => `${e.type} ${e.distance}m`).join(", ") || "none"}`,
          `Livestock: ${nearby.filter(e => livestock[e.type]).sort((a, b) => a.distance - b.distance).slice(0, 6).map(e => `${e.type} #${e.id} at ${e.pos.map(v => Math.round(v * 10) / 10).join(",")} (${e.distance}m)`).join("; ") || "none sensed nearby"}`,
          navigationStatus(body),
          `Screen: ${state.screen}`,
          ...await this.plans.statusLines().catch(error => [`Plan unavailable: ${error instanceof Error ? error.message : "plan.json could not be read"}.`]),
          ...(survivalWarning ? [survivalWarning] : []),
        ].join("\n");
      }
      case "inventory": {
        const state = await api.state(true);
        if (!state.inventory) throw new Error("Synapse did not provide inventory.");
        const stacks = [
          ...state.inventory.main.filter(nonempty).map(s => stackText(s, s.slot < 9 ? "H" : "")),
          ...state.inventory.armor.filter(nonempty).map(s => stackText(s).replace(/^\d+:/, `${s.equip}:`)),
          ...(nonempty(state.inventory.offhand) ? [stackText(state.inventory.offhand).replace(/^\d+:/, "Offhand:")] : []),
        ];
        return stacks.join("\n") || "Inventory empty.";
      }
      case "look": {
        if (!("x" in args) && !("player" in args)) {
          // Margo asked for {pitch: -45} alone; keep the other angle as it is.
          const { rotation } = await api.state();
          await api.player({ action: "look", yaw: args.yaw ?? rotation.yaw, pitch: args.pitch ?? rotation.pitch });
          return "Looked.";
        }
        if ("player" in args) {
          const state = await api.state(true);
          const entity = state.nearbyEntities?.find(e => playerEntity(e) && e.name?.toLowerCase() === args.player.toLowerCase());
          if (!entity) throw new Error(`Player ${args.player} is not nearby.`);
          await body.lookAt({ x: entity.pos[0], y: entity.pos[1] + 1.62, z: entity.pos[2] }, state);
        } else {
          // Aim at the block's centre: its integer coordinates are a corner shared
          // with seven neighbours, and live both residents kept hitting the
          // ground beside a crafting table they had looked at.
          await body.lookAt({ x: args.x + 0.5, y: args.y + 0.5, z: args.z + 0.5 });
          await Bun.sleep(100);
          const at = (await api.state().catch(() => undefined))?.lookingAt;
          if (!at) return "Looked (target read-back unavailable).";
          return lookReport([args.x, args.y, args.z], at);
        }
        return "Looked.";
      }
      case "attack": {
        // Only the click takes the body from a reflex; while a hold runs the reflexes stay free to act. An unseen
        // player in the crosshair is nothing in reach: no click is sent, which would hit them.
        const { before, swing } = await body.manualAction(async () => {
          const before = await api.state();
          if (unseenSights.has(before.lookingAt)) return { before, swing: { on: "air" } as Record<string, unknown> };
          return { before, swing: await api.player({ action: "attack", ...(args.hold_ticks === undefined ? {} : { ticks: args.hold_ticks }) }) };
        });
        if (!args.hold_ticks) return attackReport(before.lookingAt, swing.on);
        if (swing.on === "air") return holdReport(before, undefined, args.hold_ticks);
        // The hold ends on the client after its ticks; the server's answer about the block follows within a tick or two.
        await Bun.sleep(args.hold_ticks * 50 + 300);
        return holdReport(before, await api.state().catch(() => undefined), args.hold_ticks);
      }
      case "use": {
        const before = !args.hold_ticks ? await api.state() : undefined;
        const bucket = before && bucketKind(before.hotbar.find(s => s.slot === before.selectedSlot && nonempty(s))?.item);
        // Wren filled her bucket at a pond and boarded the chest boat in front of the water instead.
        if (before && bucket) await bucketGuard(body, before);
        await api.player({ action: "use", ...(args.hold_ticks === undefined ? {} : { ticks: args.hold_ticks }) });
        if (!before) return `Holding use for ${args.hold_ticks} ticks.`;
        // A bare "Used." left Margo right-clicking across sessions without
        // knowing what she faced; she concluded crafting tables never open.
        const held = before.hotbar.find(s => s.slot === before.selectedSlot && s.item !== "minecraft:air")?.item ?? "empty hand";
        const at = before.lookingAt;
        const target = at.type === "block" || at.type === "entity" ? sightsText(at) : "nothing in reach (air, or more than about 4.5 blocks away)";
        await Bun.sleep(300);
        // The use already happened; a failed read-back must not become an error.
        const after = await api.state().catch(() => undefined);
        if (!after) return `Used ${held} on ${target} (screen read-back unavailable).`;
        const opened = after.screen !== "none" && after.screen !== before.screen;
        // A bucket acts on the fluid along the line, which the crosshair target ignores: say what it did.
        if (bucket && !opened) return bucketReport(held, bucket, before, after);
        // Planting, placing and filling open no screen. Margo could not tell
        // whether a seed had gone in: say what the hand and the sights show now.
        const effects: string[] = [];
        const has = (stack?: Stack): stack is Stack => stack !== undefined && nonempty(stack);
        const handBefore = before.hotbar.find(s => s.slot === before.selectedSlot), handAfter = after.hotbar.find(s => s.slot === before.selectedSlot);
        const countBefore = has(handBefore) ? handBefore.count : 0, countAfter = has(handAfter) ? handAfter.count : 0;
        if (has(handBefore) && has(handAfter) && handAfter.item !== handBefore.item) effects.push(`your hand now holds ${handAfter.item}`);
        else if (countAfter < countBefore) effects.push(`${countBefore - countAfter} ${held} used up, ${countAfter} left`);
        if (!opened && sightsText(after.lookingAt) !== sightsText(at)) effects.push(`now in your sights: ${sightsText(after.lookingAt)}`);
        const result = opened ? `${after.screen} opened` : "no screen opened";
        const told = effects.join("; ");
        return `Used ${held} on ${target}; ${result}.${told ? ` ${told[0].toUpperCase()}${told.slice(1)}.` : opened ? "" : " Nothing your body can see changed."}`;
      }
      case "select_hotbar": await api.player({ action: "selectHotbar", slot: args.slot }); return `Selected H${args.slot}.`;
      case "eat": {
        const before = await api.state();
        const meal = await body.beginEating(before, args.item);
        await Bun.sleep(2200);
        return `Ate ${await body.finishEating(meal)}`;
      }
      case "open_inventory": return `Opened ${(await body.openInventory()).screen}.`;
      case "screen": {
        const screen = await api.gui();
        const lines = [`${screen.screen}${screen.title ? `: ${screen.title}` : ""}`];
        if (screen.modAdapter?.error) lines.push(`Mod controls unavailable: ${screen.modAdapter.error}`);
        else if (screen.modAdapter?.kind === "rs_grid") lines.push("Network results are not menu slots. Use storage_grid to search/list them and storage_grid_take to withdraw.");
        else if (screen.modAdapter?.kind === "mekanism_machine" && screen.modAdapter.sideConfiguration) lines.push("Use machine_sides for the configuration tab and machine_sides_set for side roles or auto-eject.");
        if (screen.screenWidth) lines.push(`Size ${screen.screenWidth} x ${screen.screenHeight}`);
        const empty = screen.container?.slots.filter(slot => !nonempty(slot)).map(slot => slot.slot);
        if (empty?.length) lines.push(`Empty slots: ${empty.join(", ")}`);
        for (const slot of screen.container?.slots.filter(nonempty) ?? []) lines.push(stackText(slot));
        if (screen.container && screen.container.carried !== "minecraft:air") lines.push(`Cursor: ${screen.container.carried}`);
        for (const widget of screen.widgets ?? []) {
          if (!widget.visible) continue;
          if (widget.button) lines.push(`Button ${widget.index}: ${widget.label}${widget.active ? "" : " (disabled)"}`);
          if (widget.editable) lines.push(`Text ${widget.index}: ${widget.label} = ${widget.value ?? ""}`);
        }
        return lines.join("\n");
      }
      case "click_slot": {
        await api.gui({ action: "clickSlot", ...args });
        // The click already happened: a failed read-back must not turn it into
        // an error the model would answer by clicking again.
        const shown = await api.gui().catch(() => undefined);
        if (!shown) return `Clicked slot ${args.slot} (cursor read-back unavailable).`;
        const carried = shown.container?.carried;
        return `Clicked slot ${args.slot}.${carried && carried !== "minecraft:air" ? ` Cursor now holds ${carried}; put it in a slot before closing.` : ""}`;
      }
      case "click_button": await api.gui({ action: "clickButton", ...args }); return "Pressed button.";
      case "type_text": await api.gui({ action: "keys", text: args.text }); return "Typed text.";
      case "press_key": {
        await api.gui({ action: "key", key: args.key });
        const after = await api.gui();
        return `Pressed ${args.key}; screen afterwards: ${after.screen}.`;
      }
      case "close_screen": {
        // Closing with a stack on the cursor throws it on the ground; Margo
        // lost track of her pickaxe that way and thought it had vanished.
        // Best effort: this read must never stop a screen closing (rescues close screens too).
        const carried = (await api.gui().catch(() => undefined))?.container?.carried;
        const { before, after } = await body.closeScreen();
        if (after === "DeathScreen") throw new Error("You are dead. The death screen does not close; click_button with index 0 is its Respawn button.");
        if (after !== "none") throw new Error(`${after} is still open after close and ESCAPE.`);
        if (before === "none") return "No screen open.";
        return `Closed ${before}.${carried && carried !== "minecraft:air" ? ` The ${carried} on your cursor was dropped on the ground in front of you; walk over it to pick it up.` : ""}`;
      }
      case "picture": return { text: "Client view.", image: await api.picture() };
      case "write_sign": return writeSign(body, args.lines, this.signWaitMs);
      case "guide": return lookupGuide(args, this.knowledge, this.gaps);
      case "guide_feedback": return this.gaps.feedback(args);
      case "guide_updates": return this.gaps.updates(args);
      case "find_item": case "recipes": case "uses": {
        if (!this.knowledge) throw new Error(`Knowledge unavailable: ${this.knowledgeError}`);
        if (tool === "find_item") return this.knowledge.findItems(args.query, 12).map(i => `${i.id}${i.name ? ` — ${i.name}` : ""}`).join("\n") || "No matching items.";
        const lookup = tool === "recipes" ? this.knowledge.recipesFor.bind(this.knowledge) : this.knowledge.usesOf.bind(this.knowledge);
        let recipes = lookup(args.item, 5);
        let matchedId: string | undefined;
        if (!recipes.length) {
          const query = args.item.slice(args.item.indexOf(":") + 1);
          for (const item of this.knowledge.findItems(query, 12)) {
            if (item.id === args.item) continue;
            recipes = lookup(item.id, 5);
            if (recipes.length) { matchedId = item.id; break; }
          }
        }
        const origin = fromMod(this.knowledge, matchedId ?? args.item);
        const prefix = `${matchedId ? `Using ${matchedId} (matched ${args.item}).\n` : ""}${origin ? `${origin}\n` : ""}`;
        return recipes.length ? prefix + recipes.map(recipeText).join("\n") : `${prefix}No indexed recipes for ${args.item}. Mod-specific or runtime recipes may not be exported.`;
      }
      case "mods": {
        if (!this.knowledge) throw new Error(`Knowledge unavailable: ${this.knowledgeError}`);
        return modsReply(this.knowledge, args);
      }
      case "craft": {
        if (!this.knowledge) throw new Error(`Knowledge unavailable: ${this.knowledgeError}`);
        return craft(body, this.knowledge, args.item, args.count ?? 1, { waitMs: this.craftWaitMs, signal });
      }
      case "note_difficulty": {
        let position = "unavailable";
        try { const state = await api.state(); position = `${state.pos.x}, ${state.pos.y}, ${state.pos.z} (${state.dimension})`; } catch {}
        await appendFile(join(body.config.residentDir, "difficulties.md"), `\n## ${new Date().toISOString()}\n${args.text}\nPosition: ${position}\nLast tool error: ${this.lastError ?? "none"}\n`, "utf8");
        return "Recorded in difficulties.md.";
      }
      case "recall": return this.notes.recall(args);
      case "place_save": return this.notes.place_save(args);
      case "place_find": return this.notes.place_find(args);
      case "place_remove": return this.notes.place_remove(args);
      case "skill_save": return this.skills.save(args);
      case "skill_find": return this.skills.find(args);
      case "skill_show": return this.skills.show(args);
      case "skill_run": return this.skills.run(args, signal, skill);
      case "note_share": return this.skills.noteShare(args);
      case "notes_shared": return this.skills.notesShared(args);
      case "feedback": return this.skills.feedback(args);
      case "collaborate": return this.social().collaborate(args);
      case "collaboration_update": return this.social().update(args);
      case "collaboration_show": return this.social().show(args);
      case "facility_register": return this.social().register(args);
      case "facility_update": return this.social().updateFacility(args);
      case "facility_observe": return this.social().observe(args);
      case "facility_show": return this.social().showFacility(args);
      case "plan_set": return this.plans.set(args);
      case "plan_step": return this.plans.step(args);
      case "plan_show": return this.plans.show(args);
      case "plan_focus": return this.plans.focus(args);
      case "plan_finish": return this.plans.finish(args);
      case "what_next": {
        const [state, saved, plan] = await Promise.all([api.state(true), readPlaces(body.config.residentDir, this.commons), this.plans.focused().catch(() => undefined)]);
        const society = await this.society.snapshot({ project: plan?.name, needs: [plan?.goal, plan?.needs].filter(Boolean).join(" "), dimension: state.dimension });
        return whatNext(snapshotOf(state, { now: this.now(), ...saved, plan, knowledge: this.knowledge, society, pack: this.knowledge && packKinds(this.knowledge) }));
      }
      case "set_reflexes":
        Object.assign(body.reflexes, args);
        return `Reflexes: auto_eat=${body.reflexes.auto_eat}, eat_below=${body.reflexes.eat_below}, when_attacked=${body.reflexes.when_attacked}, surface=${body.reflexes.surface}, escape_fire=${body.reflexes.escape_fire}, avoid_creepers=${body.reflexes.avoid_creepers}, water_bucket=${body.reflexes.water_bucket}.`;
    }
  }
}
