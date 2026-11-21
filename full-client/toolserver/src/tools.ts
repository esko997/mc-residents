import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Body } from "./body.ts";
import { hostileEntity, nonempty, playerEntity, type Stack } from "./synapse.ts";
import type { Knowledge, RecipeSummary } from "./knowledge/types.ts";

const finite = z.number().finite();
const name = z.string().regex(/^\w{1,16}$/, "Use an in-game player name.");
const itemId = z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Use an item or block registry id.").transform(id => id.includes(":") ? id : `minecraft:${id}`);
const hold = { hold_ticks: z.number().int().min(1).max(200).optional() };
const key = z.enum(["ENTER", "ESCAPE", "BACKSPACE", "TAB", "UP", "DOWN", "LEFT", "RIGHT", "DELETE"]);
export const definitions = {
  wait: { description: "Wait for chat, danger, players or navigation (seconds 1..120); wakes immediately.", schema: z.object({ seconds: z.number().min(1).max(120), for: z.array(z.enum(["chat", "hurt", "died", "player_near", "arrived", "stopped_short"])).optional() }) },
  go_to: { description: "Start Baritone travel; returns immediately. Arrival is an event.", schema: z.object({ x: z.number().int(), z: z.number().int(), y: z.number().int().optional() }) },
  mine: { description: "Start Baritone mining; bare block names mean minecraft:.", schema: z.object({ block: itemId, count: z.number().int().positive().optional() }) },
  follow: { description: "Start following a named player.", schema: z.object({ player: name }) },
  explore: { description: "Start Baritone exploration.", schema: z.object({}) },
  stop: { description: "Stop Baritone and release held keys.", schema: z.object({}) },
  status: { description: "Brief body, surroundings, navigation and screen status.", schema: z.object({}) },
  inventory: { description: "Non-empty inventory stacks; H marks hotbar (slots 0..8).", schema: z.object({}) },
  say: { description: "Speak plain chat, independently of walking; not commands.", schema: z.object({ text: z.string().min(1).max(256) }) },
  look: { description: "Look by yaw/pitch, world coordinates, or nearby player name.", schema: z.union([z.object({ yaw: finite, pitch: finite.min(-90).max(90) }).strict(), z.object({ x: finite, y: finite, z: finite }).strict(), z.object({ player: name }).strict()]) },
  use: { description: "Right-click; optionally hold use 1..200 ticks (20 ticks/s).", schema: z.object(hold) },
  attack: { description: "Left-click; optionally hold attack to mine by hand.", schema: z.object(hold) },
  select_hotbar: { description: "Select hotbar slot 0..8.", schema: z.object({ slot: z.number().int().min(0).max(8) }) },
  eat: { description: "Eat food from hotbar, optionally a specific item id; report food before/after.", schema: z.object({ item: itemId.optional() }) },
  screen: { description: "Read screen title, non-empty indexed slots, buttons and text boxes.", schema: z.object({}) },
  click_slot: { description: "Click a container menu slot; indexes come from screen, not inventory.", schema: z.object({ slot: z.number().int().min(-999), button: z.number().int().min(0).max(8).optional(), mode: z.enum(["PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "QUICK_CRAFT", "PICKUP_ALL"]).optional() }) },
  click_button: { description: "Press a screen button by label or widget index.", schema: z.union([z.object({ label: z.string().min(1) }).strict(), z.object({ index: z.number().int().nonnegative() }).strict()]) },
  type_text: { description: "Type characters into the open screen (including sign/book editors).", schema: z.object({ text: z.string().max(8192) }) },
  press_key: { description: "Press a named key once on the open screen.", schema: z.object({ key }) },
  close_screen: { description: "Close the current screen.", schema: z.object({}) },
  picture: { description: "See the client framebuffer as an image.", schema: z.object({}) },
  write_sign: { description: "Place selected sign on the looked-at block, write up to four lines, finish.", schema: z.object({ lines: z.array(z.string().max(90).refine(s => !/[\r\n]/.test(s), "One line per entry.")).min(1).max(4) }) },
  find_item: { description: "Search modpack item ids and display names.", schema: z.object({ query: z.string().min(1).max(200) }) },
  recipes: { description: "Recipes producing an item id, including shaped grids.", schema: z.object({ item: itemId }) },
  uses: { description: "Recipes consuming an item id (including matching tags).", schema: z.object({ item: itemId }) },
  guide: { description: "Search the modpack's own guide books.", schema: z.object({ query: z.string().min(1).max(200) }) },
  note_difficulty: { description: "Tell body maintainers what is hard; append dated position and last error to difficulties.md.", schema: z.object({ text: z.string().min(1).max(4000) }) },
  set_reflexes: { description: "Configure auto-eat and attack response: auto (armed and healthy: fight; otherwise flee), fight, flee, nothing.", schema: z.object({ auto_eat: z.boolean().optional(), eat_below: z.number().int().min(0).max(20).optional(), when_attacked: z.enum(["auto", "fight", "flee", "nothing"]).optional() }) },
};
export type ToolName = keyof typeof definitions;
const knowledgeNames = ["find_item", "recipes", "uses", "guide"];
const takeoverTools = ["look", "use", "attack", "select_hotbar", "eat", "click_slot", "click_button", "type_text", "press_key", "write_sign", "stop"];
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
  constructor(readonly body: Body, readonly knowledge?: Knowledge, private knowledgeError = "KNOWLEDGE_DB is not configured.") {}
  get registeredNames(): ToolName[] {
    return (Object.keys(definitions) as ToolName[]).filter(n => this.knowledge || !knowledgeNames.includes(n));
  }
  async call(name: string, args: unknown = {}, signal?: AbortSignal): Promise<CallToolResult> {
    let text: string;
    let image: string | undefined;
    let isError = false;
    try {
      if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown tool: ${name}`);
      const parsed = definitions[name as ToolName].schema.parse(args);
      // The runtime-selected schema and its tool name are a correlated pair.
      const command = [name, parsed] as Command;
      const run = () => this.execute(command, signal);
      const value = takeoverTools.includes(name) ? await this.body.manualAction(run) : await run();
      if (typeof value === "string") text = value;
      else { text = value.text; image = value.image; }
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : error instanceof Error ? error.message : "Tool failed.";
      this.lastError = message.replace(/\s+/g, " ").slice(0, 400);
      text = `Error: ${this.lastError}`; isError = true;
    }
    const events = this.body.events.consume();
    const budget = 1499 - events.length - 2;
    if (text.length > budget) text = text.slice(0, budget - 28) + "\n… remaining output omitted.";
    return { isError, content: [...(image ? [{ type: "image" as const, data: image, mimeType: "image/png" }] : []), { type: "text", text: `${text}\n\n${events}` }] };
  }
  private async execute(command: Command, signal?: AbortSignal): Promise<string | { text: string; image: string }> {
    const [tool, args] = command;
    const body = this.body, api = body.api;
    switch (tool) {
      case "wait": return body.events.wait(args.seconds, args.for, signal);
      case "go_to": {
        const command = `#goto ${args.x} ${args.y === undefined ? "" : `${args.y} `}${args.z}`;
        await body.navigate(command, { x: args.x, z: args.z, ...(args.y === undefined ? {} : { y: args.y }) });
        return `Started ${command}.`;
      }
      case "mine": {
        const command = `#mine ${args.count === undefined ? "" : `${args.count} `}${args.block}`;
        await body.navigate(command); return `Started ${command}.`;
      }
      case "follow": await body.navigate(`#follow player ${args.player}`, undefined, args.player); return `Following ${args.player}.`;
      case "explore": await body.navigate("#explore"); return "Exploring.";
      case "stop":
        await api.player({ action: "release" }); await api.chat("#stop"); body.navigation = undefined;
        return "Stopped navigation and released keys.";
      case "say":
        if (/^[#/]/.test(args.text.trimStart()) || /[\r\n]/.test(args.text)) throw new Error("Plain chat only; use movement tools for # commands. Slash commands are not a resident tool.");
        await api.chat(args.text); return "Said.";
      case "status": {
        const state = await api.state(true);
        const nearby = state.nearbyEntities ?? [];
        const held = state.hotbar.find(s => s.slot === state.selectedSlot);
        return [
          `Position ${state.pos.x}, ${state.pos.y}, ${state.pos.z} | ${state.dimension}`,
          `Health ${state.health}/20 | food ${state.food}/20`,
          `Held ${held && nonempty(held) ? `${held.count} x ${held.item}` : "empty"} (H${state.selectedSlot})`,
          `Looking ${state.lookingAt.block ?? state.lookingAt.entity ?? state.lookingAt.type}`,
          `Players: ${nearby.filter(playerEntity).map(e => `${e.name ?? `#${e.id}`} ${e.distance}m`).join(", ") || "none"}`,
          `Hostiles: ${nearby.filter(hostileEntity).slice(0, 8).map(e => `${e.type} ${e.distance}m`).join(", ") || "none"}`,
          `Navigation: ${body.navigation?.description ?? "none"}${body.navigation?.reported ? " (arrival/stop reported)" : ""}`,
          `Screen: ${state.screen}`,
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
        if ("yaw" in args) { await api.player({ action: "look", yaw: args.yaw, pitch: args.pitch }); return "Looked."; }
        if ("player" in args) {
          const state = await api.state(true);
          const entity = state.nearbyEntities?.find(e => playerEntity(e) && e.name?.toLowerCase() === args.player.toLowerCase());
          if (!entity) throw new Error(`Player ${args.player} is not nearby.`);
          await body.lookAt({ x: entity.pos[0], y: entity.pos[1] + 1.62, z: entity.pos[2] }, state);
        } else await body.lookAt(args);
        return "Looked.";
      }
      case "use": case "attack":
        await api.player({ action: tool, ...(args.hold_ticks === undefined ? {} : { ticks: args.hold_ticks }) });
        return args.hold_ticks ? `Holding ${tool} for ${args.hold_ticks} ticks.` : `${tool === "use" ? "Used" : "Attacked"}.`;
      case "select_hotbar": await api.player({ action: "selectHotbar", slot: args.slot }); return `Selected H${args.slot}.`;
      case "eat": {
        const before = await api.state();
        const stack = await body.beginEating(before, args.item);
        await Bun.sleep(2200);
        const after = await api.state();
        await api.player({ action: "selectHotbar", slot: before.selectedSlot });
        return `Ate ${stack.item}; food ${before.food} -> ${after.food}${after.food <= before.food ? " (no increase observed)" : ""}.`;
      }
      case "screen": {
        const screen = await api.gui();
        const lines = [`${screen.screen}${screen.title ? `: ${screen.title}` : ""}`];
        if (screen.screenWidth) lines.push(`Size ${screen.screenWidth} x ${screen.screenHeight}`);
        for (const slot of screen.container?.slots.filter(nonempty) ?? []) lines.push(stackText(slot));
        if (screen.container && screen.container.carried !== "minecraft:air") lines.push(`Cursor: ${screen.container.carried}`);
        for (const widget of screen.widgets ?? []) {
          if (!widget.visible) continue;
          if (widget.button) lines.push(`Button ${widget.index}: ${widget.label}${widget.active ? "" : " (disabled)"}`);
          if (widget.editable) lines.push(`Text ${widget.index}: ${widget.label} = ${widget.value ?? ""}`);
        }
        return lines.join("\n");
      }
      case "click_slot": await api.gui({ action: "clickSlot", ...args }); return `Clicked slot ${args.slot}.`;
      case "click_button": await api.gui({ action: "clickButton", ...args }); return "Pressed button.";
      case "type_text": await api.gui({ action: "keys", text: args.text }); return "Typed text.";
      case "press_key": await api.gui({ action: "key", key: args.key }); return `Pressed ${args.key}.`;
      case "close_screen": await api.gui({ action: "close" }); return "Closed screen.";
      case "picture": return { text: "Client view.", image: await api.picture() };
      case "write_sign": {
        const state = await api.state();
        const held = state.hotbar.find(s => s.slot === state.selectedSlot);
        if (!held?.item.endsWith("_sign") || state.lookingAt.type !== "block") throw new Error("Select a sign in the hotbar and look at a block first.");
        if (state.screen !== "none") throw new Error("Close the current screen before placing a sign.");
        await api.player({ action: "use" });
        let screen = await api.gui();
        for (let tries = 0; tries < 20 && !/sign/i.test(screen.screen); tries++) { await Bun.sleep(100); screen = await api.gui(); }
        if (!/sign/i.test(screen.screen)) throw new Error(`Sign editor did not open (screen ${screen.screen}); no text was entered.`);
        for (let i = 0; i < args.lines.length; i++) {
          if (i) await api.gui({ action: "key", key: "ENTER" });
          await api.gui({ action: "keys", text: args.lines[i] });
        }
        screen = await api.gui();
        const done = screen.widgets?.find(w => w.button && w.active && w.visible && /^done$/i.test(w.label));
        await api.gui(done ? { action: "clickButton", index: done.index } : { action: "key", key: "ESCAPE" });
        const after = await api.gui();
        if (/sign/i.test(after.screen)) throw new Error("Text entered, but sign editor is still open; inspect screen before continuing.");
        return `Entered ${args.lines.length} sign lines; editor closed (${done ? "Done" : "ESCAPE"}). Text persistence is server-controlled.`;
      }
      case "find_item": case "recipes": case "uses": case "guide": {
        if (!this.knowledge) throw new Error(`Knowledge unavailable: ${this.knowledgeError}`);
        if (tool === "find_item") return this.knowledge.findItems(args.query, 12).map(i => `${i.id}${i.name ? ` — ${i.name}` : ""}`).join("\n") || "No matching items.";
        if (tool === "guide") return this.knowledge.searchGuides(args.query, 3).map(h => `${h.where}: ${h.excerpt}`).join("\n") || "No guide matches.";
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
        const prefix = matchedId ? `Using ${matchedId} (matched ${args.item}).\n` : "";
        return recipes.length ? prefix + recipes.map(recipeText).join("\n") : `No indexed recipes for ${args.item}. Mod-specific or runtime recipes may not be exported.`;
      }
      case "note_difficulty": {
        let position = "unavailable";
        try { const state = await api.state(); position = `${state.pos.x}, ${state.pos.y}, ${state.pos.z} (${state.dimension})`; } catch {}
        await appendFile(join(body.config.residentDir, "difficulties.md"), `\n## ${new Date().toISOString()}\n${args.text}\nPosition: ${position}\nLast tool error: ${this.lastError ?? "none"}\n`, "utf8");
        return "Recorded in difficulties.md.";
      }
      case "set_reflexes":
        Object.assign(body.reflexes, args);
        return `Reflexes: auto_eat=${body.reflexes.auto_eat}, eat_below=${body.reflexes.eat_below}, when_attacked=${body.reflexes.when_attacked}.`;
    }
  }
}
