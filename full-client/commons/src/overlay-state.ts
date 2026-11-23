// Durable broadcast configuration. Loading never silently overwrites a damaged file.
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const WIDGET_IDS = ["vitals", "position", "plan", "chat", "alarms", "nearby", "map", "caretaker", "title"] as const;
export type WidgetId = typeof WIDGET_IDS[number];
export const WIDGET_SIZES: Record<WidgetId, [number, number]> = {
  vitals: [280, 112], position: [280, 108], plan: [360, 146], chat: [440, 260], alarms: [360, 130],
  nearby: [280, 150], map: [340, 290], caretaker: [420, 150], title: [520, 112],
};
export const LAYOUTS = { "1920x1080": [1920, 1080], "1280x720": [1280, 720] } as const;
export type OverlayLayout = keyof typeof LAYOUTS;
const widget = z.object({ enabled: z.boolean(), x: z.number().finite().min(-10_000).max(10_000), y: z.number().finite().min(-10_000).max(10_000), scale: z.number().finite().min(0.5).max(2), theme: z.enum(["slate", "paper", "minimal"]) }).strict();
const widgets = z.object({ vitals: widget, position: widget, plan: widget, chat: widget, alarms: widget, nearby: widget, map: widget, caretaker: widget, title: widget }).strict();
const schema = z.object({
  version: z.literal(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  resident: z.string().regex(/^\w{1,40}$/), layout: z.enum(["1920x1080", "1280x720"]),
  preset: z.enum(["exploring", "building", "chat-heavy", "custom"]),
  hideNames: z.array(z.string().regex(/^\w{1,40}$/)).max(64), title: z.string().max(160), nowPlaying: z.string().max(160), widgets,
}).strict();
export type OverlayState = z.infer<typeof schema>;
export class OverlayStateError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** At most limit bytes, including files that grow after stat. Never follow a symlink. */
export function readOverlayFile(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error("File exceeds its read budget.");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, count = 0;
    do { count = readSync(fd, bytes, length, bytes.length - length, null); length += count; } while (count && length < bytes.length);
    if (length > limit) throw new Error("File exceeds its read budget.");
    return bytes.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

/** `residents` undefined: shape only (a saved federated name may be unknown until discovery). */
export function validateOverlayState(value: unknown, residents?: readonly string[]): OverlayState {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OverlayStateError(400, "Invalid overlay settings; check fields and numeric bounds.");
  const state = parsed.data;
  if (residents) {
    const resident = residents.find(name => name.toLowerCase() === state.resident.toLowerCase());
    if (!resident) throw new OverlayStateError(400, "Choose a configured resident.");
    state.resident = resident;
  }
  state.hideNames = [...new Map(state.hideNames.map(name => [name.toLowerCase(), name])).values()];
  const [width, height] = LAYOUTS[state.layout];
  for (const id of WIDGET_IDS) {
    const entry = state.widgets[id], [w, h] = WIDGET_SIZES[id];
    entry.x = Math.max(0, Math.min(entry.x, width - w * entry.scale));
    entry.y = Math.max(0, Math.min(entry.y, height - h * entry.scale));
  }
  return state;
}

/** Presets are concrete positions, not a second hidden layout system. */
export function overlayPresets(layout: OverlayLayout = "1920x1080"): Record<"exploring" | "building" | "chat-heavy", OverlayState["widgets"]> {
  const factor = LAYOUTS[layout][0] / 1920;
  const positions: Record<WidgetId, [number, number]> = { title: [32, 24], vitals: [32, 154], position: [32, 282], nearby: [32, 408], map: [1548, 32], plan: [1528, 676], alarms: [1528, 528], chat: [32, 788], caretaker: [620, 898] };
  const make = (enabled: WidgetId[]): OverlayState["widgets"] => Object.fromEntries(WIDGET_IDS.map(id => [id, {
    enabled: enabled.includes(id), x: positions[id][0] * factor, y: positions[id][1] * factor, scale: factor, theme: "slate",
  }])) as OverlayState["widgets"];
  const exploring = make(["title", "vitals", "position", "map", "alarms", "nearby"]);
  const building = make(["title", "vitals", "position", "plan", "map", "caretaker"]);
  const chatHeavy = make(["title", "vitals", "chat", "caretaker", "alarms"]);
  chatHeavy.chat.x = 32 * factor; chatHeavy.chat.y = 486 * factor; chatHeavy.chat.scale = 1.5 * factor;
  return { exploring, building, "chat-heavy": chatHeavy };
}

export class OverlayStore {
  private state: OverlayState;
  private residents: () => readonly string[];
  readonly path: string;
  /** `residents` is called on every save: a hub passes its local plus federated names. */
  constructor(dbPath: string, residents: readonly string[] | (() => readonly string[]), owners: readonly string[] = []) {
    this.path = `${dbPath}.overlay.json`;
    this.residents = typeof residents === "function" ? residents : () => residents;
    const names = this.residents();
    if (!names.length) throw new Error("Overlay requires a locally configured resident.");
    // Hidden by default: the people who play here (COMMONS_OWNER). No name is built in.
    this.state = validateOverlayState({ version: 1, revision: 0, resident: names[0], layout: "1920x1080", preset: "exploring", hideNames: [...new Set(owners)], title: "", nowPlaying: "", widgets: overlayPresets().exploring }, names);
    // A saved resident may live on a station not yet rediscovered after restart; it shows as unavailable.
    try { this.state = validateOverlayState(JSON.parse(readOverlayFile(this.path, 32_768))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Overlay settings are unreadable or invalid; preserve and repair the overlay state file.");
    }
  }
  get(): OverlayState { return structuredClone(this.state); }
  replace(revision: number, value: unknown): OverlayState {
    if (!Number.isSafeInteger(revision) || revision !== this.state.revision) throw new OverlayStateError(409, "Overlay changed in another controller. Reload before saving.");
    const next = validateOverlayState(value, this.residents());
    if (next.revision !== revision) throw new OverlayStateError(409, "The overlay revision does not match the submitted state.");
    if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new OverlayStateError(409, "Overlay revision limit reached; restart with operator assistance.");
    next.revision = revision + 1;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined, directory: number | undefined, committed = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      directory = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
      fd = openSync(temp, "wx", 0o600); fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(next)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
      this.state = next; committed = true;
      // Persist the directory entry as well as the file contents across a power loss.
      fsyncSync(directory);
    } catch {
      throw new OverlayStateError(500, committed
        ? "Overlay settings were saved, but durability could not be confirmed. Reload before saving again."
        : "Overlay settings could not be saved; the previous settings remain active.");
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (directory !== undefined) closeSync(directory);
      try { unlinkSync(temp); } catch { /* Already renamed, or never created. */ }
    }
    return this.get();
  }
}
