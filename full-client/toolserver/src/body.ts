import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Events, LogTail, pauseReply, procReply, setReply } from "./events.ts";
import { angles, hostileEntity, nonempty, playerEntity, type Config, type Entity, type Position, type Stack, type State, Synapse } from "./synapse.ts";
import {
  effectiveTripSettings, modeText, sameTripSettings, stopReply, tripSetReply, tripSettingNames, tripSettings,
  tripSettingsSchema, type TripMode, type TripSettings,
} from "./navigation.ts";

/** A destination. `y` is present only when the goal names a height, as in `#goto x y z`. */
export interface Goal { x: number; z: number; y?: number }
/** A mine job watched by the body. Baritone has no radius of its own: `#mine` walks to the nearest block it
 * knows in the loaded chunks, however far, and explores at random when it knows none. Nor does its own count
 * end the job on this client: it logs "Currently have 0 valid items" while holding what it mined. */
export interface MineLimit {
  block: string; radius: number;
  /** The job is done when this many of the `counted` items came in; without it, when none is left within the radius. */
  count?: number;
  /** The items a count is kept in: the block's own, and what a vanilla block is known to drop instead. No other
   * pickup counts, so a block whose drop is not known ends by the radius, never by a count it did not reach. */
  counted: string[];
  /** Item counts carried when the job began, to say what it collected, and how many full state reads the
   * body had made by then: only a later read shows what the job brought in. */
  had: Record<string, number>; reads: number;
  /** Body clock for the next `#proc`, which asks Baritone where it is heading. */
  probeAt: number;
  /** From the latest `#proc` answer: the block Baritone is heading for that is nearest to the start, with its
   * distance from there; "none" when it knows no such block and explores. Unset until an answer is read. */
  nearest?: { pos: Position; distance: number } | "none";
  /** Baritone answered the last `#proc` with no process in control. The first such answer is only asked again
   * (it can come before the job's first tick); the second ends the watch. */
  idle?: true;
  /** The block is on Baritone's blocksToAvoidBreaking list: avoidBreakingMultiplier is 1 for as long as this
   * job may be running. */
  relaxed?: true;
}
export interface Navigation {
  description: string; target?: Goal; follow?: string;
  /** What the whole trip may do to the world on its way; Baritone's settings hold it until the trip is replaced,
   * stopped or ended by death or shutdown. See TripMode. */
  mode: TripMode;
  /** Where he stood when the command was given. */
  start: Position;
  /** `lastMoved` is the last sign of life (a step, a turn of the view, a Baritone reply); `lastStep` the last change of position. */
  lastPos: Position; lastMoved: number; lastStep: number; lastView: string; lastReply?: string; reported: boolean;
  /** Arrival at a fixed destination was reported: Baritone has nothing left to do for this command. */
  arrived?: true;
  /** A mine job Baritone may still be running, whatever has been reported of it (a stall report does not end
   * it). Dropped when the body stops the job or Baritone says twice that it has none. */
  limit?: MineLimit;
  /** After an arrival or a stop-short (not a mine job, which has its own asking, nor a followed player, whom
   * Baritone follows until stopped), the body asks Baritone (`#proc`) at `next` whether it still has the trip;
   * `pending` while that answer is awaited, asked again 3 s later if none comes. "No process in control" ends the
   * trip, and with it the trip's settings. */
  settle?: { next: number; pending?: true };
}
/** `pos` is the block he last stood in alive; `at` is the body clock (ms) when the death was seen. */
export interface Death { pos: Position; dimension: string; at: number }
export interface Reflexes {
  auto_eat: boolean; eat_below: number; when_attacked: "auto" | "fight" | "flee" | "nothing";
  surface: boolean; escape_fire: boolean; avoid_creepers: boolean;
  /** Douse fire with a hotbar water bucket. Off by default: live, the placed
   * water pushed him back into lava and was left flowing where it fell. */
  water_bucket: boolean;
}
interface Meal {
  item: string; before: number; slot: number; rotation: State["rotation"]; doneAt: number;
  moved?: string; automatic: boolean; finished?: boolean; failure?: string;
  /** Baritone was paused for this meal and is resumed when the meal is released. */
  paused?: true;
  /** The body closed an idle screen for this meal: the start of the one reflex line that reports both. */
  closed?: string;
}
/** The body declined to start a meal; nothing was used. */
class MealRefused extends Error {}
/** No meal for a dead body. Reflexes say nothing about it: the `died` event already has. */
class DeadError extends MealRefused { constructor() { super("You are dead; nothing was eaten."); } }
const deathScreen = "DeathScreen";
/** Blocks whose right-click opens or toggles something even with food in hand, by registry name. A heuristic for
 * modded worlds: it only decides whether a meal is refused under such a block, never what is opened. */
const interactable = /(table|chest|barrel|furnace|smoker|shulker_box|hopper|dropper|dispenser|door|gate|button|lever|anvil|sign|loom|stonecutter|grindstone|brewing_stand|beacon|lectern|bell|cake|crate|drawer|cabinet|workbench)(_|$)/;
type RescueKind = "retreat" | "surface" | "lava" | "fire";
interface Rescue {
  kind: RescueKind; reason: string; started: number; paused: boolean; busy: boolean;
  action?: Promise<void>; error?: string; lastAim: number; detail?: string;
  /** Retreat: afloat when it began, so it swims instead of running. */
  swimming?: boolean;
  /** Retreat: body clock when the feet last left the ground, while they are still off it. */
  offGround?: number;
  /** Retreat: distance from the threat when it began; the most since, counted in half-block gains, and when it last grew. */
  startSeparation?: number; bestSeparation?: number; gainedAt?: number;
  /** Retreat: the step last begun, where from and toward what (`heading` in degrees, as atan2 of z and x), and
   * whether it jumped. The next aim judges it: a step that went nowhere is tried once more with a jump, then
   * that way counts as blocked. */
  step?: { from: Position; target: { x: number; z: number }; heading: number; jump: boolean; crumb: boolean };
  /** Retreat: ways found blocked and where he stood when they were. */
  blocked?: { heading: number; at: Position }[];
  enemyId?: number; initialAir?: number; initialMaxAir?: number;
  rotation?: State["rotation"]; slot?: number; bucketSlot?: number; placedAt?: number;
  /** The navigation that was running when a surface or lava rescue began. */
  navigation?: Navigation;
  /** A surface rescue that began with that navigation still under way: he
   * comes up for air and the trip goes on, instead of making for the shore. */
  breath?: true;
}
const rescuePriority: Record<RescueKind, number> = { retreat: 1, fire: 2, surface: 3, lava: 4 };
/** Rescues that keep the controls from the resident's own actions: only `stop` takes the body from them. */
const critical: Partial<Record<RescueKind, true>> = { surface: true, lava: true };
/** A retreat ends this far from the threat. It runs 5 s, longer only while the gap still grew by half a block in
 * the last 1.5 s, and never past 8 s. A step that moves him less than `stuck` blocks went nowhere; a way within
 * `sameWay` degrees of one found blocked less than `near` blocks from here is not tried again. */
const retreatLimit = { clear: 10, ms: 5000, gainMs: 1500, maxMs: 8000, stuck: 0.3, sameWay: 30, near: 1.5 };
/** Ways tried when no crumb leads away: straight away from the threat, then turned by these degrees. */
const retreatTurns = [0, 45, -45, 90, -90];
/** Smallest difference between two headings in degrees. */
const turn = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const tenth = (value: number) => Math.round(value * 10) / 10;
// A retreat is not ended by a hop: knocked back by a hit, a jump or a step down he is airborne for at most 12
// ticks (0.6 s), falls 1.25 blocks and reaches 0.45 blocks a tick downwards; off a one-block ledge 15 ticks,
// 2.25 blocks and 0.59. Beyond these limits it is a drop, and past 3 blocks a fall starts to hurt.
const hopLimit = { ms: 1000, fall: 2.5, speed: 0.65 };
/** What Baritone turns while it works in place: the view, and the block in the sights once the last one is broken. */
const viewOf = (state: State) => `${Math.round(state.rotation.yaw)},${Math.round(state.rotation.pitch)},${state.lookingAt.type === "block" ? `${state.lookingAt.block}@${state.lookingAt.blockPos}` : ""}`;
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const blockOf = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
// A goal with a height is not reached by standing above or below it: an
// underground destination must not report arrival from the surface.
const remaining = (pos: Position, goal: Goal) => Math.hypot(pos.x - goal.x, pos.z - goal.z, goal.y === undefined ? 0 : pos.y - goal.y);
const entityPosition = (entity: Entity): Position => ({ x: entity.pos[0], y: entity.pos[1], z: entity.pos[2] });
/** How many of each item he carries: main inventory with hotbar, and offhand. */
function carried(state: State) {
  const counts: Record<string, number> = {};
  for (const stack of [...(state.inventory?.main ?? state.hotbar), ...(state.inventory ? [state.inventory.offhand] : [])]) {
    if (nonempty(stack)) counts[stack.item] = (counts[stack.item] ?? 0) + stack.count;
  }
  return counts;
}
const blockText = (p: Position) => `${p.x},${p.y},${p.z}`;
type Gain = readonly [string, number];
/** What the inventory holds more of than in `had`, item by item. */
const gains = (state: State, had: Record<string, number>): Gain[] =>
  Object.entries(carried(state)).map(([item, count]) => [item, count - (had[item] ?? 0)] as const).filter(([, count]) => count > 0);
/** What a vanilla 1.20.1 block gives instead of itself, or beside itself, when broken without Silk Touch. A mine
 * count is kept in these and in the block's own item. A block that is not here (leaves, every modded block) is
 * counted by its own item alone: what else came in on the way is no evidence of what it drops. */
const vanillaDrops: Record<string, string[]> = Object.fromEntries(([
  ["stone", "cobblestone"], ["deepslate", "cobbled_deepslate"],
  ["grass_block dirt_path farmland mycelium podzol", "dirt"], ["crimson_nylium warped_nylium", "netherrack"],
  ["coal_ore deepslate_coal_ore", "coal"], ["iron_ore deepslate_iron_ore", "raw_iron"], ["copper_ore deepslate_copper_ore", "raw_copper"],
  ["gold_ore deepslate_gold_ore", "raw_gold"], ["nether_gold_ore gilded_blackstone", "gold_nugget"],
  ["redstone_ore deepslate_redstone_ore", "redstone"], ["lapis_ore deepslate_lapis_ore", "lapis_lazuli"],
  ["diamond_ore deepslate_diamond_ore", "diamond"], ["emerald_ore deepslate_emerald_ore", "emerald"], ["nether_quartz_ore", "quartz"],
  ["gravel", "flint"], ["clay", "clay_ball"], ["glowstone", "glowstone_dust"], ["snow snow_block", "snowball"], ["melon", "melon_slice"],
  ["sea_lantern", "prismarine_crystals"], ["amethyst_cluster", "amethyst_shard"], ["bookshelf", "book"], ["cobweb", "string"],
  ["grass tall_grass fern large_fern", "wheat_seeds"], ["dead_bush", "stick"],
  ["carrots", "carrot"], ["potatoes", "potato"], ["beetroots", "beetroot"], ["sweet_berry_bush", "sweet_berries"], ["cocoa", "cocoa_beans"],
  ["cave_vines cave_vines_plant", "glow_berries"], ["kelp_plant", "kelp"], ["chorus_plant", "chorus_fruit"],
  ["brown_mushroom_block", "brown_mushroom"], ["red_mushroom_block", "red_mushroom"],
] as const).flatMap(([blocks, item]) => blocks.split(" ").map(block => [`minecraft:${block}`, [`minecraft:${item}`]] as [string, string[]])));
/** How many of the counted items came in. */
const tally = (gained: Gain[], counted: string[]) => gained.reduce((sum, [item, count]) => sum + (counted.includes(item) ? count : 0), 0);
/** "3 x minecraft:oak_log, 1 x minecraft:stick", at most three kinds, those that count first. */
function gainText(gained: Gain[], counted: string[]) {
  const ordered = [...gained].sort((a, b) => Number(counted.includes(b[0])) - Number(counted.includes(a[0])));
  return ordered.slice(0, 3).map(([item, count]) => `${count} x ${item}`).join(", ") + (ordered.length > 3 ? ` and ${ordered.length - 3} more kinds` : "") || "nothing";
}
/** For a job that ended short of its count with something picked up: how far the count got, and, when the
 * block's drop is not known and none of its own item came in, that only that item was counted. */
function countText(gained: Gain[], limit: MineLimit) {
  if (limit.count === undefined || !gained.length) return undefined;
  const have = tally(gained, limit.counted);
  return `${have} of ${limit.count}${have || vanillaDrops[limit.block] ? "" : ` (only ${limit.block} itself is counted; what it drops is not known)`}`;
}
/** Baritone breaks a block on its blocksToAvoidBreaking list only at a cost (avoidBreakingMultiplier 0.01), and
 * then `#mine` of such a block finds no path to it. The cost is lifted while a mine job that asks for one may be
 * running. The setting is one for all of Baritone: while it is lifted, every other listed block in that job's
 * way is as cheap to break as the one asked for. */
const avoidBreaking = (value: string) => `#set avoidBreakingMultiplier ${value}`;
/** How often a mine job kept near its start asks Baritone where it is heading, and how soon after it began. */
const probe = { first: 500, every: 3000 };
/** Auto-eat closes a screen in its way only this hungry, and only after this long without a screen action. */
const idleScreen = { food: 6, ms: 30_000 };
const foods: Record<string, true> = Object.fromEntries((
  "apple golden_apple enchanted_golden_apple bread baked_potato carrot golden_carrot beetroot melon_slice sweet_berries glow_berries dried_kelp cookie pumpkin_pie mushroom_stew rabbit_stew beetroot_soup cooked_beef cooked_porkchop cooked_chicken cooked_mutton cooked_rabbit cooked_cod cooked_salmon beef porkchop chicken mutton rabbit cod salmon tropical_fish potato honey_bottle"
).split(" ").map(item => [`minecraft:${item}`, true]));
export class Body {
  readonly events = new Events();
  readonly tail: LogTail;
  state?: State;
  entities: Entity[] = [];
  navigation?: Navigation;
  lastDeath?: Death;
  /** Called once per death, after `lastDeath` is set, so another module can record it. */
  onDeath?: (death: Death) => void | Promise<void>;
  reflexes: Reflexes = { auto_eat: true, eat_below: 12, when_attacked: "auto", surface: true, escape_fire: true, avoid_creepers: true, water_bucket: false };
  error?: string;
  private pollTimer?: Timer;
  private polling?: Promise<void>;
  private lastFull = -Infinity;
  private players = new Map<string, Entity>();
  private eating?: Meal;
  private mealsBlocked?: { since: number; reported: boolean };
  /** The screen the poller last saw and since when (body clock). */
  private screenSeen?: { screen: string; since: number };
  /** When the resident last acted on a screen through a tool (body clock). */
  private lastScreenAction = -Infinity;
  /** No look at the cursor of an idle screen before this (body clock): once a second, 30 s after a close that failed. */
  private nextIdleCheck = 0;
  /** An idle screen was closed for a meal in this reflex pass: the start of the line that reports it. */
  private closedForMeal?: string;
  /** The `#proc` answer being read is the mine job's that is kept near. */
  private procMine = false;
  /** Wall-clock time of the last `#proc` sent. */
  private probeSent = 0;
  /** A hazard is present but a screen would not close; reported once per episode. */
  private rescueBlocked = false;
  private nextMeal = 0;
  private combat?: { target: number; until: number; nextAttack: number; previousSlot: number };
  private fleeing = false;
  private fleeGeneration = 0;
  private crumbs: Position[] = [];
  private rescue?: Rescue;
  /** The kind of rescue moving the body right now, if any. */
  get rescuing(): string | undefined { return this.rescue?.kind; }
  private rescueCleanup?: Promise<void>;
  /** Per goal description, when a surface or lava rescue stopped it (body clock, last ten minutes). */
  private hazardStops = new Map<string, number[]>();
  /** Breaths taken for one goal in the last two minutes; `left` is the distance to a fixed destination afterwards. */
  private breaths?: { description: string; taken: { at: number; left?: number }[] };
  /** Consecutive stop-shorts of one goal from about one place; `start` is where the latest attempt began. */
  private stopShorts?: { description: string; start: Position; count: number };
  private manual = 0;
  private stopped = false;
  /** avoidBreakingMultiplier is 1 in Baritone. It is so only while a mine job of a listed block may be running:
   * every poll puts it right, either way. */
  private lifted = false;
  /** What avoidBreakingMultiplier goes back to: the settings file's value when it was last lifted. */
  private kept = "0.01";
  /** Full state reads so far. */
  private fullReads = 0;
  /** Baritone's trip settings as its settings file last read back (`applied`), what they go back to between trips
   * (`baseline`), and whether the file recording that baseline exists. Read on first use. */
  private trip?: { applied: TripSettings; baseline: TripSettings; recorded: boolean };
  /** Trip settings are changed one call at a time. */
  private tripChange: Promise<unknown> = Promise.resolve();
  /** While navigate() switches modes, the mode a poll must not undo before the new trip is assigned. */
  private switching?: TripMode;
  /** Trip settings that did not read back as wanted after a poll set them; said once until they do. */
  private tripUnconfirmed = false;
  /** `#stop`s the body sent to switch modes whose "ok canceled" has not been read yet. */
  private ownStops = 0;
  constructor(readonly config: Config, readonly api: Synapse, private now = Date.now) {
    this.tail = new LogTail(config.log, config.name, this.events, reply => {
      if (setReply.test(reply) || tripSetReply.test(reply) || this.readProc(reply)) return true;
      if (this.ownStops > 0 && stopReply.test(reply)) { this.ownStops--; return true; }
      if (this.navigation && !this.navigation.reported) {
        // "Paused" and "Resumed" answer the body's own reflexes; they say nothing about why a trip ended.
        if (!pauseReply.test(reply)) this.navigation.lastReply = reply;
        this.navigation.lastMoved = this.now();
      }
      return false;
    });
  }
  async start() {
    // Baritone writes every `#set` to its settings file. A tool server killed in the middle of a mine job that
    // had the cost lifted left it so; the first poll puts it back. Trip settings the same way, from the file
    // that recorded their baseline.
    const settings = await this.baritoneSettings();
    if (settings.blocksToAvoidBreaking && Number(settings.avoidBreakingMultiplier) === 1) this.lifted = true;
    await this.tripState();
    await this.tail.start(); await this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, 250);
  }
  /** Baritone's settings as its file has them (`name value` lines; it rewrites the file itself). The game
   * directory is the parent of the `logs` directory the client log is in. Empty when the file cannot be read. */
  private async baritoneSettings(): Promise<Record<string, string>> {
    const text = await readFile(join(dirname(dirname(this.config.log)), "baritone", "settings.txt"), "utf8").catch(() => "");
    return Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1).trim()];
    }));
  }
  /** Where the trip settings' baseline is recorded while a trip has them changed, beside Baritone's own file. */
  private get baselineFile() { return join(dirname(dirname(this.config.log)), "baritone", "resident-trip-baseline.json"); }
  /** Reads the trip settings once: what Baritone has, and what they go back to. A baseline file left by a tool
   * server that stopped in the middle of a trip names the baseline; otherwise it is what Baritone has now. */
  private async tripState() {
    if (this.trip) return this.trip;
    const applied = effectiveTripSettings(await this.baritoneSettings());
    const recorded = await readFile(this.baselineFile, "utf8").then(text => text, () => undefined);
    let baseline: TripSettings | undefined;
    try { if (recorded !== undefined) baseline = tripSettingsSchema.parse(JSON.parse(recorded)); } catch {}
    // A baseline file that cannot be read as one is still replaced or removed like one.
    return this.trip ??= { applied, baseline: baseline ?? applied, recorded: recorded !== undefined };
  }
  /** Sets the trip settings that differ from `wanted`, one `#set` each, then reads Baritone's settings file back
   * (Baritone saves it as it applies a `#set`; Synapse answers `/chat` after the client thread ran it). Returns
   * the settings that did not read back as wanted. The baseline is recorded before the first change from it,
   * and its record removed once the settings are back at it. */
  private applyTrip(wanted: TripSettings) {
    const change = this.tripChange.then(async () => {
      const trip = await this.tripState();
      const changes = tripSettingNames.filter(name => trip.applied[name] !== wanted[name]);
      if (changes.length) {
        if (!trip.recorded) {
          await mkdir(dirname(this.baselineFile), { recursive: true });
          await writeFile(this.baselineFile, `${JSON.stringify(trip.baseline)}\n`, "utf8");
          trip.recorded = true;
        }
        try { for (const name of changes) await this.api.chat(`#set ${name} ${wanted[name]}`); }
        finally { trip.applied = effectiveTripSettings(await this.baritoneSettings()); }
      }
      if (trip.recorded && sameTripSettings(trip.applied, trip.baseline)) { await rm(this.baselineFile, { force: true }); trip.recorded = false; }
      return tripSettingNames.filter(name => trip.applied[name] !== wanted[name]);
    });
    this.tripChange = change.catch(() => {});
    return change;
  }
  /** Puts the trip settings where they belong now (see update()), and says once when they would not read back so. */
  private async reconcileTrip() {
    const trip = await this.tripState();
    const mode = this.switching ?? this.navigation?.mode;
    const wanted = mode ? tripSettings(mode, trip.baseline) : trip.baseline;
    if (sameTripSettings(trip.applied, wanted) && !(trip.recorded && sameTripSettings(trip.applied, trip.baseline))) { this.tripUnconfirmed = false; return; }
    const wrong = await this.applyTrip(wanted);
    // navigate() may have switched while this waited its turn; only a mismatch with the mode still wanted is news.
    if (!wrong.length || (this.switching ?? this.navigation?.mode) !== mode) { this.tripUnconfirmed = false; return; }
    if (!this.tripUnconfirmed) {
      this.tripUnconfirmed = true;
      this.events.add("system", { text: `Baritone's settings did not read back as set: ${wrong.map(name => `${name} ${trip.applied[name]}, wanted ${wanted[name]}`).join("; ")}` });
    }
  }
  async poll() {
    if (this.stopped) return;
    if (this.polling) return this.polling;
    this.polling = this.update().catch(error => {
      const message = error instanceof Error ? error.message : "Synapse unavailable.";
      if (this.error !== message) this.events.add("system", { text: message });
      this.error = message;
    }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async update() {
    const state = await this.api.state();
    let hurt = false;
    if (this.state) {
      if (state.health < this.state.health) {
        hurt = true; this.events.add("hurt", { from: this.state.health, to: state.health });
      }
      if (state.health <= 0 && this.state.health > 0) {
        const death: Death = { pos: blockOf(this.state.pos), dimension: this.state.dimension, at: this.now() };
        this.lastDeath = death;
        this.events.add("died", {
          at: `${death.pos.x},${death.pos.y},${death.pos.z}`, dimension: death.dimension,
          text: "what you carried dropped there; items last about five minutes",
        });
        // A record that cannot be written must not cost the release of held keys below.
        try { await this.onDeath?.(death); }
        catch (error) { this.events.add("system", { text: `death not recorded: ${error instanceof Error ? error.message : "hook failed"}` }); }
      }
      if (state.food < 7 && this.state.food >= 7) this.events.add("hungry", { food: state.food });
    } else if (state.food < 7) this.events.add("hungry", { food: state.food });
    this.state = { ...state, inventory: this.state?.inventory }; this.error = undefined;
    if (this.now() - this.lastFull >= 1000 || hurt) {
      const full = await this.api.state(true);
      this.lastFull = this.now(); this.fullReads++; this.entities = full.nearbyEntities ?? [];
      this.state = { ...state, inventory: full.inventory };
      const players = new Map<string, Entity>();
      for (const entity of this.entities.filter(playerEntity)) {
        const name = entity.name ?? `player#${entity.id}`;
        if (name.toLowerCase() === this.config.name.toLowerCase()) continue;
        players.set(name, entity);
        if (!this.players.has(name)) this.events.add("player_near", { name, distance: entity.distance });
      }
      for (const name of this.players.keys()) if (!players.has(name)) this.events.add("player_gone", { name });
      this.players = players;
    }
    await this.tail.read();
    this.rememberGround(this.state);
    if (this.screenSeen?.screen !== state.screen) this.screenSeen = { screen: state.screen, since: this.now() };
    // A `#proc`, `#stop` or `#set` that fails is tried again on the next poll and must not cost this poll its reflexes.
    const failures: unknown[] = [];
    await this.checkNavigation(state).catch(error => failures.push(error));
    await this.reflex(this.state, hurt).catch(error => failures.push(error));
    // The cost is lifted exactly while a mine job that needs it may be running. However that job ended (its count,
    // the radius, Baritone giving up, a stop, death, a rescue, another command), it is back within this poll. A
    // stall report alone does not put it back: Baritone is then still at work on the block.
    const relaxed = this.navigation?.limit?.relaxed === true;
    if (this.lifted !== relaxed) await this.api.chat(avoidBreaking(relaxed ? "1" : this.kept)).then(() => { this.lifted = relaxed; }, error => failures.push(error));
    // Trip settings hold the trip's mode for as long as it is this navigation (arrived and stopped-short trips
    // included: Baritone may still be at them), and go back to the baseline once there is none: after a stop, a
    // death, a rescue that abandoned it, a mine job's end or Baritone giving up. Set again if they drifted.
    await this.reconcileTrip().catch(error => failures.push(error));
    if (failures.length) throw failures[0];
  }
  private rememberGround(state: State) {
    if (state.riding || state.health <= 0 || state.onGround !== true || state.inWater !== false || state.inLava !== false || state.onFire !== false) return;
    const last = this.crumbs.at(-1);
    if (!last || distance(last, state.pos) >= 1) {
      this.crumbs.push({ ...state.pos });
      if (this.crumbs.length > 40) this.crumbs.shift();
    }
  }
  /** Newest safe ground at least 1.5 blocks away across the ground. The very
   * newest crumb is often the rim of the hole he fell into: live, aiming at a
   * point 0.2 blocks off spun him in place in a 1x1 lava hole until he died. */
  private escapeCrumb(state: State) {
    const far = [...this.crumbs].reverse().find(p => Math.hypot(p.x - state.pos.x, p.z - state.pos.z) >= 1.5);
    return far ?? this.crumbs.at(-1);
  }
  private retreatSensors(state: State) {
    return state.onGround !== undefined && state.inWater !== undefined && state.inLava !== undefined && state.onFire !== undefined;
  }
  survivalStatus(state: State): string | undefined {
    if (state.riding) return "On-foot eating, combat and rescue reflexes are suspended while riding; use vehicle controls and land safely before dismounting.";
    const unavailable: string[] = [];
    if (!this.retreatSensors(state)) unavailable.push("safe-ground retreat (legacy flee remains active)");
    if (this.reflexes.surface && (state.underwater === undefined || state.air === undefined || state.maxAir === undefined)) unavailable.push("surface off");
    if (this.reflexes.escape_fire && (state.onFire === undefined || state.inWater === undefined || state.inLava === undefined)) unavailable.push("fire/lava rescue off");
    return unavailable.length ? `Survival senses unavailable from older Synapse: ${unavailable.join("; ")}.` : undefined;
  }
  /** Baritone was just told to carry on, or a new command began: the stall clocks start again. */
  private restartStallClock() {
    if (this.navigation) this.navigation.lastMoved = this.navigation.lastStep = this.now();
  }
  /** Baritone 1.10.1 answers `#proc` with five lines (Class, Priority, Temporary, Display name, Last command),
   * or with one when no process is in control. "Display name" is "Mine <filter>" for a mine job, the filter
   * naming the block, and "Last command" ends in its goal: every block it is heading for as `{x=..,y=..,z=..}`,
   * or a GoalRunAway from where it stands when it knows no such block and explores. Anything else (a pause, no
   * goal yet) says nothing. Every such line is the body's own reading: no event, and no sign of life. */
  private readProc(reply: string) {
    const line = procReply.exec(reply);
    if (!line) return false;
    const nav = this.navigation, limit = nav?.limit;
    if (!line[1]) {
      // Baritone has finished or given up: no job is left to keep near, and none that needs the cost lifted.
      // One such answer is not yet that: read before the job's first tick, it would leave the job without a radius.
      if (limit?.idle) {
        nav!.limit = undefined;
        // A job already reported is over: Baritone has nothing left of it, and the settings go back.
        if (nav!.reported) this.navigation = undefined;
      } else if (limit) { limit.idle = true; limit.probeAt = Math.min(limit.probeAt, this.now() + probe.first); }
      if (nav?.settle?.pending) this.tripSettled(nav);
    } else if (line[1] === "Class") { if (limit) limit.idle = undefined; if (nav?.settle) nav.settle.pending = undefined; }
    else if (line[1] === "Display name") this.procMine = limit !== undefined && line[2]!.startsWith("Mine ") && line[2]!.includes(limit.block);
    else if (line[1] === "Last command") {
      if (this.procMine && nav && limit) {
        const goal = line[2]!;
        const heading = [...goal.matchAll(/\{x=(-?\d+),y=(-?\d+),z=(-?\d+)\}/g)]
          .map(([, x, y, z]) => { const pos = { x: Number(x), y: Number(y), z: Number(z) }; return { pos, distance: distance(pos, blockOf(nav.start)) }; })
          .sort((a, b) => a.distance - b.distance);
        if (goal.includes("GoalRunAway")) limit.nearest = "none";
        else if (heading.length) limit.nearest = heading[0];
      }
      this.procMine = false;
    }
    return true;
  }
  /** Baritone answered the body's question after an arrival or a stop-short with no process in control: the trip
   * is over, and its settings go back to the baseline on the next poll. Only what was not yet said is said: an
   * arrival reached after a stop-short, or a trip Baritone gave up. */
  private tripSettled(nav: Navigation) {
    this.navigation = undefined;
    if (nav.arrived) return;
    const state = this.state;
    const left = state && nav.target && !nav.follow ? remaining(state.pos, nav.target) : undefined;
    if (left !== undefined && left <= 2) { this.events.add("arrived", { goal: nav.description }); this.stopShorts = undefined; return; }
    this.events.add("navigation_stopped", {
      goal: nav.description,
      reason: nav.mode === "walk"
        ? "Baritone stopped trying (no process left). On a walk-only trip that means it found no way it could walk from here without breaking or placing blocks: a door, steps, a ladder or a cleared way would give it one, or go_to with mode excavate digs"
        : `Baritone stopped trying (no process left)${nav.target ? " before you arrived" : ""}`,
      ...(state ? { you: blockText(blockOf(state.pos)) } : {}),
      ...(left !== undefined ? { remaining: tenth(left) } : {}),
    });
  }
  /** Asks Baritone whether it still has the trip (see Navigation.settle). */
  private async askSettled(nav: Navigation) {
    nav.settle = { next: this.now() + 3000, pending: true };
    this.probeSent = Date.now();
    await this.api.chat("#proc");
  }
  /** The resident acted on a screen through a tool; an idle screen is one without this for 30 s. */
  screenTouched() { this.lastScreenAction = this.now(); }
  /** Watches a mine job and ends it (true) when it has collected its count, or when the body or the nearest
   * block Baritone is heading for is past the radius; otherwise asks Baritone where it is heading when that is due. */
  private async watchMine(nav: Navigation, limit: MineLimit, state: State) {
    // The inventory is read once a second, and only a reading later than the job's start is compared. Only the
    // counted items count: sticks, saplings and whatever else was picked up on the way end no job.
    if (limit.count !== undefined && this.state?.inventory && this.fullReads > limit.reads) {
      const gained = gains(this.state, limit.had);
      if (tally(gained, limit.counted) >= limit.count) {
        await this.api.chat("#stop");
        nav.reported = nav.arrived = true; nav.limit = undefined; this.stopShorts = undefined;
        // Stopped and done: the trip is over, and its settings go back to the baseline in this poll.
        if (this.navigation === nav) this.navigation = undefined;
        this.events.add("arrived", { goal: nav.description, collected: gainText(gained, limit.counted) });
        return true;
      }
    }
    const strayed = distance(state.pos, nav.start) > limit.radius;
    if (strayed || limit.nearest === "none" || (limit.nearest && limit.nearest.distance > limit.radius)) { await this.endMine(nav, limit, state); return true; }
    if (this.now() >= limit.probeAt) { limit.probeAt = this.now() + probe.every; this.probeSent = Date.now(); await this.api.chat("#proc"); }
    return false;
  }
  /** Stops a mine job that left its radius and says what it collected. A `#stop` that fails is tried again on the next poll. */
  private async endMine(nav: Navigation, limit: MineLimit, state: State) {
    const { nearest } = limit;
    await this.api.chat("#stop");
    nav.reported = true; nav.limit = undefined;
    if (this.navigation === nav) this.navigation = undefined;
    // The job is stopped either way; an inventory that cannot be read is said so.
    const gained = await this.api.state(true).then(full => gains(full, limit.had), () => undefined);
    const counted = gained && countText(gained, limit);
    const start = blockText(blockOf(nav.start));
    this.events.add("navigation_stopped", {
      goal: nav.description, collected: gained ? gainText(gained, limit.counted) : "unknown (inventory unreadable)",
      ...(counted ? { counted } : {}),
      // Only what Baritone said is claimed. A block it knows inside the radius whose path leaves it is not "none
      // left"; and a body past the radius before Baritone answered at all says nothing of what is left.
      reason: nearest === undefined
        ? `you were more than ${limit.radius} blocks from where you started (${start}) before Baritone said where it was heading; whether any ${limit.block} is left near there is not known`
        : nearest !== "none" && nearest.distance <= limit.radius
          ? `the way to the next ${limit.block} led more than ${limit.radius} blocks from where you started (${start})`
          : `no ${limit.block} left within ${limit.radius} blocks of where you started (${start})`,
      ...(nearest === "none" ? { nearest: "none known in the loaded chunks" } : nearest ? { nearest: `${blockText(nearest.pos)}, ${Math.round(nearest.distance)} blocks from where you started` } : {}),
      you: blockText(blockOf(state.pos)),
    });
  }
  private async checkNavigation(state: State) {
    const nav = this.navigation;
    if (!nav) return;
    const held = this.combat || this.fleeing || this.rescue?.paused || this.eating?.paused;
    if (nav.reported) {
      // A stall was reported, but Baritone may still be at work (a hard block outlasts the stall clock) and
      // walk on afterwards: the radius holds until Baritone says it has no job. Any other reported trip is
      // asked after until Baritone says it has nothing left of it.
      if (nav.limit && !held) await this.watchMine(nav, nav.limit, state);
      else if (nav.settle && !held && this.now() >= nav.settle.next) await this.askSettled(nav);
      return;
    }
    // Sampled even while a reflex has the body, so the view it leaves behind is not taken for Baritone's work.
    const view = viewOf(state), turned = view !== nav.lastView;
    nav.lastView = view;
    if (held) return;
    if (nav.follow) {
      const player = this.entities.find(e => playerEntity(e) && e.name === nav.follow);
      if (player) nav.target = { x: player.pos[0], z: player.pos[2] };
    }
    if (nav.limit && await this.watchMine(nav, nav.limit, state)) return;
    const now = this.now();
    if (Math.hypot(state.pos.x - nav.lastPos.x, state.pos.y - nav.lastPos.y, state.pos.z - nav.lastPos.z) > 0.15) {
      nav.lastPos = { ...state.pos }; nav.lastMoved = nav.lastStep = now;
    }
    // Breaking blocks from one spot moves nothing but the view and the block in the sights. That is work, not
    // a stop, for up to 30 s in one place.
    if (turned) nav.lastMoved = now;
    const left = nav.target ? remaining(state.pos, nav.target) : undefined;
    // Baritone keeps a followed player within 3 blocks (its followRadius) and comes no closer.
    if (left !== undefined && left <= (nav.follow ? 4 : 2)) {
      this.events.add("arrived", { goal: nav.description, ...(nav.follow ? { distance: tenth(left) } : {}) });
      nav.reported = true;
      if (!nav.follow) nav.arrived = true;
      this.stopShorts = undefined;
      // Baritone may still be on the last blocks; it is asked a second from now whether it is done.
      if (!nav.follow && !nav.limit) nav.settle = { next: now + 1000 };
    } else if (now - nav.lastMoved >= 4000 || now - nav.lastStep >= 30000) {
      // navigate() dropped the count if this is another goal or began far from the last attempt.
      const attempts = (this.stopShorts?.count ?? 0) + 1;
      this.stopShorts = { description: nav.description, start: nav.start, count: attempts };
      // With a height in the goal, standing on the spot but above or below it also stops short.
      const up = nav.target?.y === undefined || nav.follow ? undefined : nav.target.y - state.pos.y;
      this.events.add("stopped_short", {
        distance: left === undefined ? "unknown (no fixed destination)" : tenth(left),
        ...(up === undefined ? {} : {
          across: tenth(Math.hypot(state.pos.x - nav.target!.x, state.pos.z - nav.target!.z)),
          height: Math.abs(up) < 0.5 ? "goal is level with you" : `goal is ${tenth(Math.abs(up))} ${up > 0 ? "above" : "below"} you`,
        }),
        // Ahead of the Baritone reply, which is what the line limit may cut.
        ...(attempts >= 3 ? {
          attempts,
          text: nav.target && !nav.follow
            ? `same destination has stopped short ${attempts} times from about here`
            : `same command has ended ${attempts} times from about here`,
        } : {}),
        // A walk-only trip that stops short may be one that needed digging or building.
        ...(nav.mode === "walk" ? { mode: "walk-only" } : {}),
        baritone: nav.lastReply ?? "no reply observed since start",
      });
      nav.reported = true;
      // Baritone says nothing when it gives a trip up. Asked at once and every 3 s after, its answer tells a trip
      // it gave up or finished from one it is still at. A mine job has its own asking; a follow is never done.
      if (!nav.limit && !nav.follow) await this.askSettled(nav);
    }
  }
  /** Starts a Baritone command as the body's one trip. `mode` holds for the whole trip (see TripMode): when it
   * differs from what Baritone has, whatever Baritone was doing is cancelled first, because a path it planned
   * under the old settings is walked (and dug) whatever they say afterwards; then the settings are set and read
   * back from Baritone's settings file, and the trip starts only if they read back as wanted. `mine` has the
   * body watch the job: see MineLimit. */
  async navigate(command: string, trip: { mode: TripMode; target?: Goal; follow?: string; mine?: { block: string; radius: number; count?: number } }): Promise<void> {
    const { mode, target, follow, mine } = trip;
    const state = await this.api.state(mine !== undefined);
    const settings: Record<string, string | undefined> = await this.baritoneSettings();
    if (mode === "walk" && settings.allowBreakAnyway?.trim()) {
      throw new Error("Walk-only travel cannot start while Baritone's allowBreakAnyway exceptions are configured. "
        + "Ask maintainers to clear that list; no trip was started.");
    }
    const relaxed = mine !== undefined && settings.blocksToAvoidBreaking?.split(",").map(id => id.trim().toLowerCase()).map(id => id.includes(":") ? id : `minecraft:${id}`).includes(mine.block) === true;
    // Baritone accepts a command on the death screen and nothing moves; the body's stall timer then called that a stop.
    if (state.health <= 0) throw new Error("You are dead; no trip can start before you respawn.");
    // The answer to a `#proc` sent a moment ago would be taken for this job's: let it arrive, then drain.
    const answer = this.probeSent + 300 - Date.now();
    if (answer > 0) await Bun.sleep(answer);
    await this.tail.read(); // Drain old replies before assigning a new navigation.
    // A rescue that is still cleaning up may be about to send #stop for the
    // navigation it interrupted; that must not land after this command.
    while (this.rescueCleanup) await this.rescueCleanup;
    const description = command.slice(1), last = this.stopShorts;
    if (last && (last.description !== description || Math.hypot(state.pos.x - last.start.x, state.pos.z - last.start.z) > 8)) this.stopShorts = undefined;
    const previous = this.navigation, known = await this.tripState(), wanted = tripSettings(mode, known.baseline);
    let cancelled = false, sent = false;
    this.switching = mode;
    try {
      // A finished trip can still be restoring its baseline. Do not launch a
      // new walk while those queued writes could turn digging back on.
      await this.tripChange;
      if (!sameTripSettings(known.applied, wanted)) {
        this.ownStops++;
        await this.api.chat("#stop"); cancelled = true;
        const wrong = await this.applyTrip(wanted);
        if (wrong.length) throw new Error(`Baritone's settings did not read back as ${modeText(mode)} (${wrong.map(name => `${name} reads ${known.applied[name]}`).join(", ")}); no trip was started${previous ? " and the one before it was stopped" : ""}.`);
      }
      const now = this.now();
      this.navigation = {
        description, target, follow, mode, start: { ...state.pos }, lastPos: { ...state.pos }, lastMoved: now, lastStep: now, lastView: viewOf(state), reported: false,
        ...(mine ? { limit: {
          ...mine, counted: [mine.block, ...(vanillaDrops[mine.block] ?? [])], had: carried(state), reads: this.fullReads, probeAt: now + probe.first,
          ...(relaxed ? { relaxed: true as const } : {}),
        } } : {}),
      };
      // Before the command, so that a trip never starts with the cost lifted, nor a mine of a listed block with it kept.
      if (this.lifted !== relaxed) {
        const written = settings.avoidBreakingMultiplier;
        if (relaxed && written && Number.isFinite(Number(written)) && Number(written) !== 1) this.kept = written;
        await this.api.chat(avoidBreaking(relaxed ? "1" : this.kept)); this.lifted = relaxed;
      }
      await this.api.chat(command); sent = true;
      if (this.combat || this.fleeing || this.rescue?.paused) await this.api.chat("#pause");
    } catch (error) {
      // A command that was not sent leaves Baritone at what it was doing: a mine job goes on being watched, with
      // its radius and its cost, unless the mode switch cancelled it. One that was sent is under way, and is
      // watched as well. With no trip left, the next poll puts the settings back to the baseline.
      if (!sent) this.navigation = previous?.limit && !cancelled ? previous : undefined;
      throw error;
    } finally { this.switching = undefined; }
  }
  async lookAt(target: Position, state?: State) {
    state ??= await this.api.state();
    return this.api.player({ action: "look", ...angles(state.eye, target) });
  }
  food(state: State, item?: string): Stack | undefined {
    const stacks = [...state.hotbar, ...(state.inventory?.main.filter(s => s.slot >= 9 && s.slot <= 35) ?? [])];
    const hasEdibleMetadata = stacks.some(stack => stack.edible !== undefined);
    return stacks.find(s => nonempty(s) && (!item || s.item === item) &&
      (s.edible === true || (!hasEdibleMetadata && s.edible === undefined && foods[s.item])));
  }
  async openInventory() {
    const before = await this.api.gui();
    if (before.screen === "InventoryScreen") return before;
    if (before.screen !== "none") throw new Error(`Close ${before.screen} before opening your inventory.`);
    await this.api.gui({ action: "open", target: "inventory" });
    const after = await this.api.gui();
    if (after.screen !== "InventoryScreen") throw new Error(`Inventory did not open; screen is ${after.screen}.`);
    return after;
  }
  async closeScreen() {
    const before = (await this.api.gui()).screen;
    if (before === "none") return { before, after: before };
    await this.api.gui({ action: "close" });
    let after = (await this.api.gui()).screen;
    if (after !== "none") {
      await this.api.gui({ action: "key", key: "ESCAPE" });
      after = (await this.api.gui()).screen;
    }
    return { before, after };
  }
  async beginEating(state: State, item?: string, automatic = false) {
    const screen = (await this.api.gui()).screen;
    if (state.health <= 0 || screen === deathScreen || state.screen === deathScreen) throw new DeadError();
    if (screen !== "none" || state.screen !== "none") throw new MealRefused(`Close ${screen !== "none" ? screen : state.screen} before eating.`);
    let stack = this.food({ ...state, inventory: undefined }, item);
    let moved: string | undefined;
    if (!stack) {
      state = await this.api.state(true);
      stack = this.food(state, item);
      if (!stack) throw new MealRefused("No matching food in inventory.");
      if (stack.slot >= 9) {
        const inventory = await this.openInventory();
        // Survival InventoryMenu slots 9..35 are the main inventory; 36..44 are H0..H8.
        const source = inventory.container?.slots.find(s => s.slot === stack!.slot);
        if (!source || source.item !== stack.item || source.count !== stack.count) {
          await this.closeScreen();
          throw new MealRefused("Inventory food slot changed; no stack was moved.");
        }
        const slot = Array.from({ length: 9 }, (_, i) => i).find(i => !state.hotbar.some(s => s.slot === i && nonempty(s))) ?? state.selectedSlot;
        const displaced = state.hotbar.find(s => s.slot === slot && nonempty(s));
        await this.api.gui({ action: "clickSlot", slot: stack.slot, button: slot, mode: "SWAP" });
        const closed = await this.closeScreen();
        moved = `Moved ${stack.count} x ${stack.item} from inventory ${stack.slot} to H${slot}${displaced ? `; swapped ${displaced.item} to inventory ${stack.slot}` : ""}.`;
        if (closed.after !== "none") throw new MealRefused(`${moved} ${closed.after} is still open after close and ESCAPE; cannot eat.`);
        const refreshed = await this.api.state();
        const ready = refreshed.hotbar.find(s => s.slot === slot && s.item === stack!.item && nonempty(s));
        if (!ready) throw new MealRefused(`Food move to H${slot} was not observed; cannot eat.`);
        stack = ready;
      }
    }
    const meal: Meal = { item: stack.item, before: state.food, slot: state.selectedSlot, rotation: { ...state.rotation }, doneAt: 0, moved, automatic };
    try {
      // Eating is a held right-click, and it lands on whatever the crosshair rests on when the hold begins and
      // again whenever the bite ends early. Baritone turns the view every tick it walks or digs, so a trip that
      // was resumed a moment ago undid the look away below; live that opened the crafting table beside him
      // straight after a fight. Nothing else may steer while the food is in the hand.
      if (this.navigation && !this.navigation.arrived) { await this.api.chat("#pause"); meal.paused = true; }
      await this.api.player({ action: "selectHotbar", slot: stack.slot });
      // move(sneak) only acknowledges after it ends, so cannot safely order it before use.
      // Look away instead, then wait for the client raycast to refresh before holding use.
      await this.api.player({ action: "look", yaw: state.rotation.yaw, pitch: -90 });
      await this.api.request("/wait?ticks=2");
      const aimed = await this.api.state();
      if (aimed.health <= 0 || aimed.screen === deathScreen) throw new DeadError();
      if (aimed.screen !== "none") throw new MealRefused(`Close ${aimed.screen} before eating.`);
      // The look is checked, not assumed: a trip the body does not know of (after a restart) still turns it.
      if (aimed.rotation.pitch > -85) throw new MealRefused(`The view did not stay straight up (pitch ${tenth(aimed.rotation.pitch)}); something else is turning it. Nothing was used.`);
      const sights = aimed.lookingAt;
      const overhead = sights.type === "entity" ? sights.entity ?? "an entity" : sights.type === "block" && interactable.test(sights.block ?? "") ? sights.block : undefined;
      if (overhead) throw new MealRefused(`${overhead} is directly overhead and the meal would use it instead. Nothing was used.`);
      await this.api.player({ action: "use", ticks: 40 });
      meal.doneAt = this.now() + 2200;
      this.eating = meal;
      return meal;
    } catch (error) {
      await this.releaseMeal(meal);
      if (error instanceof DeadError) throw error;
      const text = `${moved ? `${moved} ` : ""}${error instanceof Error ? error.message : "Could not start eating."}`;
      throw error instanceof MealRefused ? new MealRefused(text) : new Error(text);
    }
  }
  /** Lets go of the food and puts slot and view back. `resume: false` leaves a Baritone the meal paused to the caller. */
  private async releaseMeal(meal: Meal, resume = true) {
    meal.finished = true;
    // Every end of a meal comes through here; one that reports itself has taken `closed` first.
    if (meal.closed) { this.events.add("reflex", { text: `${meal.closed}the meal was cut short` }); meal.closed = undefined; }
    if (this.eating === meal) this.eating = undefined;
    try {
      await this.api.player({ action: "release" });
      await this.api.player({ action: "selectHotbar", slot: meal.slot });
      await this.api.player({ action: "look", ...meal.rotation });
    } finally {
      if (meal.paused && resume) { await this.api.chat("#resume"); this.restartStallClock(); }
    }
  }
  private async mealOpenedScreen(meal: Meal, screen: string) {
    meal.failure = `Meal opened ${screen} instead of eating.`;
    this.nextMeal = this.now() + 10000;
    await this.releaseMeal(meal); // Stop use BEFORE closing, or the next tick could reopen it.
    const closed = await this.closeScreen();
    const outcome = closed.after === "none" ? `Closed ${screen}.` : `${closed.after} is still open after close and ESCAPE.`;
    meal.failure += ` ${outcome} Auto-eat paused for 10s.`;
    this.events.add("reflex", { text: `${meal.failure}${meal.moved ? ` ${meal.moved}` : ""}` });
  }
  async finishEating(meal: Meal, state?: State) {
    state ??= await this.api.state();
    if (!meal.finished) {
      // The death screen is not the meal's doing and cannot be closed: let go and touch nothing else.
      if (state.health <= 0 || state.screen === deathScreen) { await this.releaseMeal(meal); meal.failure = "You died before the meal was finished."; }
      else if (state.screen !== "none") await this.mealOpenedScreen(meal, state.screen);
      else await this.releaseMeal(meal);
    }
    if (meal.failure) throw new Error(`${meal.failure}${meal.moved ? ` ${meal.moved}` : ""}`);
    const result = `${meal.item}, food ${meal.before} -> ${state.food}.${meal.moved ? ` ${meal.moved}` : ""}`;
    if (state.food <= meal.before) throw new Error(`Eating failed: no food increase observed (${result})`);
    return result;
  }
  /** Runs one of the resident's own actions, after taking the body from whatever reflex has it. A rescue from
   * drowning or lava is the exception: it keeps the controls and the action is refused with what it is doing,
   * unless the action is an `override` (stop), which ends the rescue and says what he is still in. */
  async manualAction<T>(action: () => Promise<T>, options: { override?: boolean } = {}): Promise<T> {
    this.manual++;
    try {
      // A poll under way may be starting a rescue: it is settled first, so the answer below is about the body as it is.
      await this.polling;
      const rescue = this.rescue, state = this.state;
      if (rescue && critical[rescue.kind]) {
        const air = state?.air !== undefined && state.maxAir !== undefined ? `air ${state.air}/${state.maxAir}` : "air unknown";
        if (!options.override) {
          throw new Error(`Not done: your body is ${rescue.kind === "surface" ? `coming up for air (${air})` : "climbing out of lava"} and keeps the controls until it is out (${rescue.kind === "surface" ? "at most 12 s under water, 20 s swimming for the shore" : "at most 10 s"}; ${seconds(this.now() - rescue.started)} so far). Nothing was done. Wait for the reflex event that ends it, then act; stop takes over at once and ends the rescue.`);
        }
        const still = rescue.kind === "surface" ? `${state?.underwater === true ? "still under water, " : ""}${air}` : state?.inLava === true ? "still in lava" : "no longer in lava";
        await this.finishRescue(`ended by your stop; ${still}`, rescue.breath);
      } else if (rescue) await this.finishRescue("interrupted by your action", rescue.breath);
      await this.finishCombat();
      if (this.fleeing) {
        this.fleeGeneration++; this.fleeing = false;
        await this.api.player({ action: "release" }); await this.api.chat("#resume");
        this.events.add("reflex", { text: "flee interrupted by your action" });
      }
      if (this.eating) {
        await this.releaseMeal(this.eating);
        this.events.add("reflex", { text: "auto-eat interrupted by your action" });
      }
      return await action();
    } finally { this.manual--; }
  }
  /** The resident's stop: takes the body from every reflex, a drowning or lava rescue included, lets go of every
   * key, cancels Baritone and puts the trip settings back to the baseline, read back from its settings file. */
  async stopNavigation(): Promise<string> {
    return this.manualAction(async () => {
      await this.api.player({ action: "release" }); await this.api.chat("#stop"); this.navigation = undefined;
      const trip = await this.tripState();
      // Baritone is stopped either way; settings that could not be set yet are tried again on every poll.
      const settings = await this.applyTrip(trip.baseline).then(
        wrong => wrong.length ? ` Baritone's settings did not read back as they were before the trip: ${wrong.map(name => `${name} reads ${trip.applied[name]}`).join(", ")}.` : "",
        error => ` Baritone's settings could not be put back yet (${error instanceof Error ? error.message : "settings call failed"}); the body keeps trying.`);
      return `Stopped navigation and released keys.${settings}`;
    }, { override: true });
  }
  private async finishCombat(resume = true) {
    const combat = this.combat;
    if (!combat) return;
    this.combat = undefined;
    await this.api.player({ action: "release" });
    await this.api.player({ action: "selectHotbar", slot: combat.previousSlot });
    if (resume) {
      await this.api.chat("#resume");
      this.restartStallClock();
      this.events.add("reflex", { text: "fight ended; navigation resumed" });
    }
  }
  private async startFlee(enemy: Entity, state: State, reason: string) {
    if (this.retreatSensors(state)) {
      await this.startRescue("retreat", `fleeing from ${enemy.type} (${reason})`, state, enemy);
      return;
    }
    // A toolserver restart can precede the mod upgrade. Preserve the old
    // damage response exactly when none of the safe-ground senses exist.
    await this.startLegacyFlee(enemy, state, reason);
  }
  private async startLegacyFlee(enemy: Entity, state: State, reason: string) {
    if (this.fleeing) return;
    this.fleeing = true;
    const generation = ++this.fleeGeneration;
    this.events.add("reflex", { text: `fleeing from ${enemy.type} (${reason}); sprint 3s` });
    await this.api.chat("#pause");
    await this.lookAt({ x: state.pos.x * 2 - enemy.pos[0], y: state.eye.y, z: state.pos.z * 2 - enemy.pos[2] }, state);
    // Timed movement blocks its HTTP call, so let the shared poller continue.
    void this.api.player({ action: "move", forward: true, sprint: true, ticks: 60 })
      .catch(error => this.events.add("reflex", { text: String(error) }))
      .finally(async () => {
        if (generation !== this.fleeGeneration) return;
        this.fleeing = false;
        if (!this.stopped) {
          try {
            await this.api.chat("#resume");
            this.restartStallClock();
            this.events.add("reflex", { text: "flee ended; navigation resumed" });
          } catch (error) { this.events.add("reflex", { text: String(error) }); }
        }
      });
  }
  private environmentalRescue(state: State): { kind: RescueKind; reason: string; enemy?: Entity } | undefined {
    if (this.reflexes.escape_fire && state.inLava === true) return { kind: "lava", reason: "in lava" };
    if (this.reflexes.surface && state.underwater === true && state.air !== undefined && state.maxAir !== undefined && state.maxAir > 0 && state.air < state.maxAir / 2) {
      return { kind: "surface", reason: `air ${state.air}/${state.maxAir}` };
    }
    if (this.reflexes.escape_fire && state.onFire === true && state.inLava === false && state.inWater === false) {
      return { kind: "fire", reason: "burning" };
    }
    if (this.reflexes.avoid_creepers && this.retreatSensors(state)) {
      const enemy = this.entities.find(e => e.type === "minecraft:creeper" && hostileEntity(e) && (e.fuse === true || e.distance <= 3));
      if (enemy) return { kind: "retreat", reason: enemy.fuse === true ? "creeper fuse" : "creeper within 3 blocks", enemy };
    }
    return undefined;
  }
  private async interruptForRescue() {
    // A meal that paused Baritone hands that pause on to the rescue, which resumes or stops it when it ends.
    const meal = this.eating;
    const paused = this.combat !== undefined || this.fleeing || meal?.paused === true;
    if (meal) await this.releaseMeal(meal, false);
    if (this.combat) await this.finishCombat(false);
    if (this.fleeing) {
      this.fleeGeneration++; this.fleeing = false;
      await this.api.player({ action: "release" });
    }
    return paused;
  }
  private async startRescue(kind: RescueKind, reason: string, state: State, enemy?: Entity) {
    if (this.rescue) return;
    const inheritedPause = await this.interruptForRescue();
    let current = state;
    if (kind === "fire") current = await this.api.state();
    const bucket = kind === "fire" && this.reflexes.water_bucket ? current.hotbar.find(s => nonempty(s) && s.item === "minecraft:water_bucket") : undefined;
    const usesControls = kind !== "fire" || (bucket !== undefined && current.dimension !== "minecraft:the_nether");
    const rescue: Rescue = {
      kind, reason, started: this.now(), paused: inheritedPause || usesControls, busy: false, lastAim: -Infinity,
      enemyId: enemy?.id, initialAir: current.air, initialMaxAir: current.maxAir,
      ...(kind === "fire" && usesControls ? { rotation: { ...current.rotation }, slot: current.selectedSlot, bucketSlot: bucket!.slot } : {}),
      ...(kind === "surface" || kind === "lava" ? { navigation: this.navigation } : {}),
      ...(kind === "surface" && this.navigation?.reported === false ? { breath: true as const } : {}),
    };
    this.rescue = rescue;
    if (kind === "fire" && !usesControls) rescue.detail = current.dimension === "minecraft:the_nether" ? "water cannot be used in the Nether" : !this.reflexes.water_bucket ? "water bucket use is off" : "no water bucket in the hotbar";
    // Afloat there is no ground to run on, and standing still in the water is no escape: live, a drowned
    // killed him while each of five retreats ended at once for want of ground.
    if (kind === "retreat" && current.inWater === true && current.onGround !== true) rescue.swimming = true;
    this.events.add("reflex", { text: `${kind} rescue started: ${reason}${rescue.swimming ? "; afloat, swimming away" : ""}${rescue.detail ? `; ${rescue.detail}; reported only` : ""}` });
    try {
      if (usesControls) await this.api.chat("#pause");
      if (kind === "fire") {
        if (!usesControls) return;
        await this.api.player({ action: "selectHotbar", slot: rescue.bucketSlot! });
        await this.api.player({ action: "look", yaw: current.rotation.yaw, pitch: 90 });
        await this.api.player({ action: "use" });
        rescue.placedAt = this.now();
      }
      if (this.rescue === rescue) await this.updateRescue(current);
    } catch (error) {
      await this.finishRescue(`failed: ${error instanceof Error ? error.message : "Synapse action failed"}`);
    }
  }
  private rescueMove(rescue: Rescue, movement: Record<string, unknown>) {
    if (rescue.busy || this.rescue !== rescue) return;
    rescue.busy = true;
    rescue.action = this.api.player({ action: "move", ...movement }).then(() => {}).catch(error => {
      rescue.error = error instanceof Error ? error.message : "Movement failed.";
    }).finally(() => {
      rescue.busy = false; rescue.action = undefined;
    });
  }
  private async updateRescue(state: State) {
    const rescue = this.rescue;
    if (!rescue) return;
    if (rescue.error) { await this.finishRescue(`failed: ${rescue.error}`); return; }
    const elapsed = this.now() - rescue.started;
    if (rescue.kind === "retreat") {
      const enemy = this.entities.find(e => e.id === rescue.enemyId && hostileEntity(e));
      if (!enemy) { await this.finishRescue("threat no longer observed"); return; }
      const threat = entityPosition(enemy), separation = distance(state.pos, threat);
      rescue.startSeparation ??= separation;
      if (rescue.bestSeparation === undefined || separation >= rescue.bestSeparation + 0.5) { rescue.bestSeparation = separation; rescue.gainedAt = this.now(); }
      // Distance is all that is claimed: a mob can follow, and a skeleton shoots from farther than this.
      const gap = `${tenth(separation)} blocks from ${enemy.type} (${tenth(rescue.startSeparation)} at the start)`;
      if (separation >= retreatLimit.clear) { await this.finishRescue(`${gap}; it may still follow or shoot`); return; }
      // Longer than 5 s only while the gap is still growing: more time without progress was no escape (live, a
      // retreat ended at 5.3 s with a skeleton 2 blocks off, and he died).
      if (elapsed >= retreatLimit.ms && (this.now() - rescue.gainedAt! >= retreatLimit.gainMs || elapsed >= retreatLimit.maxMs)) {
        const blocked = rescue.blocked?.length ?? 0;
        await this.finishRescue(`timed out after ${seconds(elapsed)}, ${gap}${blocked ? `; ${blocked} way${blocked === 1 ? "" : "s"} found blocked` : ""}; it is still near`);
        return;
      }
      if (!this.retreatSensors(state)) { await this.finishRescue("survival senses disappeared"); return; }
      // Lava belongs to the lava rescue when that reflex is on; without it the retreat at least walks no further in.
      if (state.inLava === true) { await this.finishRescue("entered lava; movement stopped"); return; }
      const now = this.now(), grounded = state.onGround === true, afloat = state.inWater === true && !grounded;
      if (grounded) rescue.offGround = undefined; else rescue.offGround ??= now;
      if (rescue.swimming && !afloat) rescue.swimming = false; // Feet down or out of the water: on from here as on land.
      if (!rescue.swimming && !grounded) {
        // The hit that starts a retreat throws him into the air, and a jump or a step down lifts his feet too.
        // Ending the retreat for that left him standing beside the mob: live, all 16 retreats from a hit ended
        // within half a second for "left safe ground". Only a real loss of ground ends it.
        const aloft = now - rescue.offGround!;
        if (afloat) {
          if (aloft >= 500) { await this.finishRescue("entered deep water; movement stopped"); return; }
        } else {
          const fell = state.fallDistance ?? 0;
          if (fell > hopLimit.fall || (state.velocity?.y ?? 0) < -hopLimit.speed) { await this.finishRescue(`falling, ${tenth(fell)} blocks so far; movement stopped`); return; }
          if (aloft >= hopLimit.ms) { await this.finishRescue(`no ground underfoot for ${seconds(aloft)}; movement stopped`); return; }
        }
        // A step is begun only from the ground, so none carries him further over an edge.
        return;
      }
      if (rescue.busy || this.now() - rescue.lastAim < 500) return;
      // The step just taken is judged by where it got him. One that went nowhere is tried once more with a jump
      // (a block's rise, a slab, a fence corner); after that the way counts as blocked from here.
      const step = rescue.step;
      let next: Rescue["step"];
      if (step && Math.hypot(state.pos.x - step.from.x, state.pos.z - step.from.z) < retreatLimit.stuck) {
        if (!step.jump) next = { ...step, from: { ...state.pos }, jump: true };
        else (rescue.blocked ??= []).push({ heading: step.heading, at: { ...state.pos } });
      }
      next ??= this.retreatWay(rescue, state, threat, separation);
      if (!next) {
        await this.finishRescue(`every way away was blocked (${rescue.blocked?.length ?? 0} tried from here); movement stopped, ${gap}`);
        return;
      }
      await this.lookAt({ x: next.target.x, y: state.eye.y, z: next.target.z }, state);
      rescue.lastAim = this.now(); rescue.step = next;
      this.rescueMove(rescue, rescue.swimming
        ? { forward: true, jump: true, ticks: 5 }
        : { forward: true, ...(next.crumb ? { sprint: true } : {}), ...(next.jump ? { jump: true } : {}), ticks: next.crumb ? 5 : 4 });
      return;
    }
    if (rescue.kind === "surface") {
      if (state.underwater === undefined || state.air === undefined || state.maxAir === undefined) { await this.finishRescue("air senses disappeared"); return; }
      if (rescue.breath) {
        const air = `air ${rescue.initialAir} -> ${state.air}`;
        if (state.air >= state.maxAir * 0.8) {
          // A go_to given during the breath is another trip; it is resumed and this breath is not held against it.
          const stuck = rescue.navigation === this.navigation ? this.breathWithoutProgress(rescue.navigation!, state) : undefined;
          await this.finishRescue(`took a breath, ${air}${stuck || !this.navigation ? "" : "; trip resumed"}`, !stuck, stuck);
          return;
        }
        if (elapsed >= 12000) {
          await this.finishRescue(`timed out, ${air}`, false, `could not keep your head above water for 12 s (air ${state.air}/${state.maxAir})`);
          return;
        }
        // Up only, and held there until the air is back: resumed at once he went
        // under again within seconds, and live that fired a rescue every few
        // seconds for ten minutes. The trail leads back to the shore he left.
        if (!rescue.busy && (state.underwater || state.inWater === true)) this.rescueMove(rescue, { jump: true, ticks: 5 });
        return;
      }
      if (!state.underwater) {
        // Surfacing alone is not safe: left floating, he sinks and drowns again.
        // Swim for the last dry ground he stood on, head kept up, until out.
        const shore = this.escapeCrumb(state);
        if (state.inWater !== true || !shore) {
          await this.finishRescue(`${state.inWater === true ? "surfaced, no known shore" : "out of the water"} after ${seconds(elapsed)}, air ${rescue.initialAir} -> ${state.air}`);
          return;
        }
        if (elapsed >= 20000) { await this.finishRescue(`surfaced but did not reach the shore in 20 s, air ${state.air}`); return; }
        if (rescue.busy) return;
        if (this.now() - rescue.lastAim >= 500) {
          await this.lookAt({ x: shore.x, y: state.eye.y, z: shore.z }, state);
          rescue.lastAim = this.now();
        }
        this.rescueMove(rescue, { forward: true, jump: true, ticks: 5 });
        return;
      }
      if (elapsed >= 12000) { await this.finishRescue(`timed out after 12 s underwater, air ${rescue.initialAir} -> ${state.air}`); return; }
      if (rescue.busy) return;
      const crumb = elapsed >= 6000 ? this.escapeCrumb(state) : undefined;
      if (crumb && this.now() - rescue.lastAim >= 500) {
        await this.lookAt({ x: crumb.x, y: state.eye.y, z: crumb.z }, state);
        rescue.lastAim = this.now();
      }
      this.rescueMove(rescue, { ...(crumb ? { forward: true } : {}), jump: true, ticks: 5 });
      return;
    }
    if (rescue.kind === "lava") {
      if (state.inLava !== true) { await this.finishRescue(`escaped lava after ${seconds(elapsed)}`); return; }
      if (elapsed >= 10000) { await this.finishRescue("timed out after 10 s in lava"); return; }
      if (rescue.busy) return;
      const crumb = this.escapeCrumb(state);
      if (crumb && this.now() - rescue.lastAim >= 500) {
        await this.lookAt({ x: crumb.x, y: state.eye.y, z: crumb.z }, state);
        rescue.lastAim = this.now();
      }
      // Lava only lifts a held jump about 0.04 blocks a tick; 5-tick pulses
      // sank back between polls and failed 10 s in a row from a 1-deep pool.
      // A 20-tick hold climbed out in one press, 4 of 4 live.
      this.rescueMove(rescue, { ...(crumb ? { forward: true } : {}), jump: true, sprint: true, ticks: 20 });
      return;
    }
    if (rescue.bucketSlot === undefined) {
      if (state.onFire !== true) await this.finishRescue(`${state.onFire === false ? "no longer burning" : "fire sense disappeared"}; ${rescue.detail}; reported only`);
      return;
    }
    if (rescue.placedAt === undefined || this.now() - rescue.placedAt < 1000) return;
    await this.api.player({ action: "look", yaw: rescue.rotation!.yaw, pitch: 90 });
    await this.api.player({ action: "use" });
    // Report what the hotbar shows, not what was attempted: live, flowing water
    // had moved him off the source and the pickup silently missed.
    const after = await this.api.state();
    const retrieved = after.hotbar.find(s => s.slot === rescue.bucketSlot)?.item === "minecraft:water_bucket";
    const water = retrieved ? "water placed and retrieved" : "water placed but NOT picked back up; it is still flowing there";
    await this.finishRescue(`${water}; ${state.onFire === false ? "no longer burning" : "still burning"}`);
  }
  /** Where a retreat steps next: toward the newest crumb on his side of the threat, else straight away from it,
   * else turned from that by up to 90 degrees, never a way found blocked near here. Undefined when every one was. */
  private retreatWay(rescue: Rescue, state: State, threat: Position, separation: number): Rescue["step"] {
    const here = state.pos;
    const blocked = (rescue.blocked ?? []).filter(b => Math.hypot(b.at.x - here.x, b.at.z - here.z) < retreatLimit.near);
    const way = (target: { x: number; z: number }, crumb: boolean) => {
      const heading = Math.atan2(target.z - here.z, target.x - here.x) * 180 / Math.PI;
      return blocked.some(b => turn(b.heading, heading) < retreatLimit.sameWay) ? undefined : { from: { ...here }, target, heading, jump: rescue.swimming === true, crumb };
    };
    // The crumb must lie on his side, away from the threat: one merely farther from it can be behind it, and
    // live he ran past a lit creeper toward ground he had walked on the far side.
    const away = { x: here.x - threat.x, z: here.z - threat.z };
    for (const p of [...this.crumbs].reverse()) {
      if (distance(p, threat) <= separation || distance(p, here) <= 0.75 || (p.x - here.x) * away.x + (p.z - here.z) * away.z < 0) continue;
      const step = way(p, true);
      if (step) return step;
    }
    const straight = Math.atan2(away.z, away.x);
    for (const degrees of retreatTurns) {
      const angle = straight + degrees * Math.PI / 180;
      const step = way({ x: here.x + Math.cos(angle) * 2, z: here.z + Math.sin(angle) * 2 }, false);
      if (step) return step;
    }
    return undefined;
  }
  /** Counts a finished breath for this trip. Returns why the trip should stop,
   * if this is the third in two minutes without coming 8 blocks closer. */
  private breathWithoutProgress(nav: Navigation, state: State): string | undefined {
    const now = this.now();
    // A followed player moves, so the distance to them says nothing about progress.
    const left = nav.target && !nav.follow ? remaining(state.pos, nav.target) : undefined;
    const earlier = this.breaths?.description === nav.description ? this.breaths.taken.filter(b => now - b.at <= 120_000) : [];
    const taken = [...earlier, { at: now, left }];
    this.breaths = { description: nav.description, taken };
    const first = taken.at(-3);
    if (!first) return undefined;
    if (left === undefined || first.left === undefined) return "needed air 3 times in 2 minutes; no destination to measure progress by";
    const closer = first.left - left;
    if (closer >= 8) return undefined;
    return `needed air 3 times in 2 minutes and got ${closer < 1 ? "no closer" : `only ${Math.round(closer * 10) / 10} closer`}`;
  }
  /** Ends the rescue. The navigation a surface or lava rescue interrupted is
   * stopped for `reason` unless `resume` says the trip goes on. */
  private async finishRescue(outcome: string, resume = false, reason?: string) {
    const rescue = this.rescue;
    if (!rescue) { await this.rescueCleanup; return; }
    this.rescue = undefined;
    // Resuming would walk him back into the lava, or the water he cannot get
    // through, that this path crosses. Dropped before any await, so no
    // stopped_short is reported for it. A navigation given during the rescue
    // is another path and resumes as usual.
    const abandoned = !resume && rescue.navigation !== undefined && rescue.navigation === this.navigation ? rescue.navigation : undefined;
    if (abandoned) { this.navigation = undefined; this.breaths = undefined; }
    // He stood still for the rescue; a poll during the cleanup below must not take that for a stall.
    else this.restartStallClock();
    const cleanup = (async () => {
      await rescue.action;
      let failed = false;
      if (rescue.paused) {
        try { await this.api.player({ action: "release" }); } catch { failed = true; }
      }
      if (rescue.bucketSlot !== undefined) {
        try { await this.api.player({ action: "selectHotbar", slot: rescue.slot! }); } catch { failed = true; }
        try { await this.api.player({ action: "look", ...rescue.rotation! }); } catch { failed = true; }
      }
      if (rescue.paused) {
        try {
          // Baritone's stop is cancel: it drops the goal and its pause flag. On shutdown close() sends it.
          if (abandoned) { if (!this.stopped) await this.api.chat("#stop"); }
          else {
            await this.api.chat("#resume");
            this.restartStallClock();
          }
        } catch { failed = true; }
      }
      this.events.add("reflex", { text: `${rescue.kind} rescue ended after ${seconds(this.now() - rescue.started)}: ${outcome}${failed ? "; cleanup incomplete" : ""}` });
      if (abandoned) this.reportTripStopped(abandoned, reason ?? `the path led into ${rescue.kind === "lava" ? "lava" : "deep water"}`);
    })();
    this.rescueCleanup = cleanup;
    try { await cleanup; } finally { if (this.rescueCleanup === cleanup) this.rescueCleanup = undefined; }
  }
  private reportTripStopped(nav: Navigation, reason: string) {
    const now = this.now(), window = 600_000;
    for (const [goal, times] of this.hazardStops) if (now - times.at(-1)! > window) this.hazardStops.delete(goal);
    const times = [...(this.hazardStops.get(nav.description) ?? []).filter(time => now - time <= window), now];
    this.hazardStops.set(nav.description, times);
    const state = this.state!; // A rescue only starts from a polled state.
    const alive = state.health > 0, here = blockOf(state.pos);
    this.events.add("navigation_stopped", {
      goal: nav.description,
      reason: `${reason}${alive ? "" : " and you died there"}`,
      ...(alive ? { you: `${here.x},${here.y},${here.z}` } : {}),
      ...(alive && nav.target && !nav.follow ? { remaining: Math.round(remaining(state.pos, nav.target) * 10) / 10 } : {}),
      ...(times.length > 1 ? { times: `${times.length} in ten minutes` } : {}),
    });
  }
  /** Death ends whatever the body was doing: keys are let go and Baritone is stopped. Nothing is clicked or
   * closed, and nothing is said beyond the `died` event and the end of a trip that was under way. */
  private async settleDeath() {
    const meal = this.eating, nav = this.navigation;
    const paused = meal?.paused === true || this.combat !== undefined || this.fleeing;
    this.navigation = undefined; this.breaths = undefined;
    if (meal) await this.releaseMeal(meal, false);
    if (this.fleeing) {
      this.fleeGeneration++; this.fleeing = false;
      await this.api.player({ action: "release" });
    }
    await this.finishCombat(false);
    // A mine job outlives its stall report: that one too is still Baritone's and would set off again.
    const live = nav !== undefined && (!nav.reported || nav.limit !== undefined);
    // Baritone's stop also drops the pause a reflex set. A trip left alive would set off again from the respawn
    // point, and left to the stall timer it was reported four seconds later as stopped short.
    if ((paused || live) && !this.stopped) await this.api.chat("#stop");
    if (live) this.events.add("navigation_stopped", { goal: nav.description, reason: "you died" });
  }
  private async reflex(state: State, hurt: boolean) {
    try { await this.react(state, hurt); }
    finally {
      // The screen is closed but a rescue, a fight or an error came before the meal: the closing is still said.
      if (this.closedForMeal) { this.events.add("reflex", { text: `${this.closedForMeal}the meal has not started` }); this.closedForMeal = undefined; }
    }
  }
  private async react(state: State, hurt: boolean) {
    const dead = state.health <= 0 || state.screen === deathScreen;
    // A foot rescue cannot steer an aircraft, and release/sneak can cancel flight or eject a rider.
    // Vehicle tools take over through manualAction before mounting, settling existing foot reflexes first.
    if (state.riding && !dead) return;
    const needsMeal = this.reflexes.auto_eat && (state.food < this.reflexes.eat_below || (state.health < 14 && state.food < 20));
    const blocked = needsMeal && !dead && state.screen !== "none";
    if (blocked) {
      this.mealsBlocked ??= { since: this.now(), reported: false };
      if (!this.mealsBlocked.reported && this.now() - this.mealsBlocked.since > 20000) {
        this.events.add("reflex", { text: `${state.screen} is blocking meals; close it to eat (food ${state.food}).` });
        this.mealsBlocked.reported = true;
      }
    } else this.mealsBlocked = undefined;
    // The death screen is no screen the meal opened; it is settled below without a click.
    if (this.eating && state.screen !== "none" && !dead) {
      await this.mealOpenedScreen(this.eating, state.screen);
      return;
    }
    // A screen freezes movement and held keys, so a hazard that arrives while
    // one is open (a chest opened at the water's edge, a crafting table in a
    // burning cabin) must get it out of the way rather than wait for him.
    if (state.screen !== "none" && !dead && !this.manual && !this.stopped && this.environmentalRescue(state)) {
      const closed = await this.closeScreen();
      if (closed.after === "none") {
        this.events.add("reflex", { text: `closed ${closed.before} to escape danger` });
        this.rescueBlocked = false;
        state = { ...state, screen: "none" };
      } else if (!this.rescueBlocked) {
        this.rescueBlocked = true;
        this.events.add("reflex", { text: `in danger but ${closed.after} will not close; rescue blocked` });
      }
    } else if (state.screen === "none") this.rescueBlocked = false;
    // A screen left open kept him from eating: live, a furnace screen blocked meals at food 5 for four minutes.
    // Closing it is safe only when nothing is on the cursor (a carried stack would be thrown on the ground) and
    // he is not in the middle of using it.
    const idle = this.now() - Math.max(this.screenSeen?.since ?? -Infinity, this.lastScreenAction);
    if (blocked && state.screen !== "none" && state.food <= idleScreen.food && idle >= idleScreen.ms && !this.manual && !this.stopped
      && this.now() >= this.nextMeal && this.now() >= this.nextIdleCheck && this.food(state)) {
      this.nextIdleCheck = this.now() + 1000;
      const lastAction = this.lastScreenAction;
      const shown = await this.api.gui();
      // A tool call that arrived during that read is an action too.
      if (shown.screen === state.screen && (shown.container?.carried ?? "minecraft:air") === "minecraft:air" && this.lastScreenAction === lastAction && !this.manual) {
        const closed = await this.closeScreen();
        if (closed.after === "none") {
          this.closedForMeal = `closed ${closed.before} (no action for ${Math.round(idle / 1000)} s) to eat; `;
          state = { ...state, screen: "none" };
        } else this.nextIdleCheck = this.now() + idleScreen.ms;
      }
    }
    // A drowning or lava rescue keeps the controls while one of his own actions is being turned away (manualAction).
    const keepsBody = this.rescue !== undefined && critical[this.rescue.kind] === true && state.screen === "none" && !dead && !this.stopped;
    if (state.screen !== "none" || dead || (this.manual && !keepsBody) || this.stopped) {
      if (this.rescue) {
        const screen = state.screen !== "none";
        await this.finishRescue(dead ? "death" : screen ? `screen opened: ${state.screen}` : "manual control", !dead && !screen && this.rescue.breath);
      }
      if (dead) { await this.settleDeath(); return; }
      if (this.eating?.automatic || this.fleeing) {
        if (this.eating) await this.releaseMeal(this.eating);
        this.fleeGeneration++; this.fleeing = false;
        await this.api.player({ action: "release" });
        this.events.add("reflex", { text: "automatic input released (screen, death or manual control)" });
      }
      await this.finishCombat(); return;
    }
    const requested = this.environmentalRescue(state);
    if (this.rescue && requested && rescuePriority[requested.kind] > rescuePriority[this.rescue.kind]) {
      await this.finishRescue(`superseded by ${requested.kind}`);
    }
    if (this.rescue) { await this.updateRescue(state); return; }
    if (requested) { await this.startRescue(requested.kind, requested.reason, state, requested.enemy); return; }
    if (this.fleeing) return;
    if (this.eating) {
      if (this.now() >= this.eating.doneAt) {
        const closed = this.eating.closed ?? "";
        this.eating.closed = undefined;
        try { this.events.add("reflex", { text: `${closed}ate ${await this.finishEating(this.eating, state)}` }); }
        catch (error) { this.events.add("reflex", { text: `${closed}${error instanceof Error ? error.message : "Eating failed."}` }); }
        // The snapshot still has the meal's upward aim and food slot. Observe
        // restored controls before another automatic meal captures its baseline.
        state = await this.api.state();
      } else if (!hurt) return;
    }
    if (this.combat) {
      const combat = this.combat;
      const enemy = this.entities.find(e => e.id === combat.target && hostileEntity(e) && e.type !== "minecraft:creeper" && e.distance <= 6);
      if (!enemy || this.now() >= combat.until || this.reflexes.when_attacked === "nothing") { await this.finishCombat(); return; }
      if (state.health <= 6 || this.reflexes.when_attacked === "flee") {
        await this.finishCombat(false);
        await this.startFlee(enemy, state, state.health <= 6 ? "low health" : "flee configured");
        return;
      }
      if (this.now() >= combat.nextAttack) {
        await this.lookAt({ x: enemy.pos[0], y: enemy.pos[1] + 1, z: enemy.pos[2] }, state);
        // Do not swing through a player who steps between Gary and the mob.
        const aimed = await this.api.state();
        if (aimed.screen !== "none") { await this.finishCombat(); return; }
        if (this.combat !== combat || this.manual || this.stopped) return;
        if (aimed.lookingAt.entityId === enemy.id && aimed.lookingAt.entity !== "minecraft:player") await this.api.player({ action: "attack" });
        combat.nextAttack = this.now() + 600;
      }
      return;
    }
    const enemy = hurt ? this.entities.find(e => hostileEntity(e) && e.distance <= 6) : undefined;
    if (enemy && this.reflexes.when_attacked !== "nothing") {
      if (this.eating) await this.releaseMeal(this.eating);
      const weapon = state.hotbar.find(s => nonempty(s) && /_(sword|axe)$/.test(s.item));
      const mode = this.reflexes.when_attacked;
      const shouldFlee = mode === "flee" || (mode === "auto" && (!weapon || state.health < 8));
      if (enemy.type === "minecraft:creeper" && !shouldFlee) return;
      if (shouldFlee) {
        await this.startFlee(enemy, state, mode === "flee" ? "flee configured" : !weapon ? "no weapon" : "low health");
      } else {
        await this.api.chat("#pause");
        if (weapon) await this.api.player({ action: "selectHotbar", slot: weapon.slot });
        this.combat = { target: enemy.id, until: this.now() + 15000, nextAttack: 0, previousSlot: state.selectedSlot };
        this.events.add("reflex", { text: `defending against ${enemy.type}; navigation paused` });
      }
      return;
    }
    if (needsMeal && !this.eating && this.now() >= this.nextMeal && this.food(state)) {
      try {
        const meal = await this.beginEating(state, undefined, true);
        meal.closed = this.closedForMeal; this.closedForMeal = undefined;
      } catch (error) {
        if (!(error instanceof MealRefused)) throw error;
        // Said once and tried again in ten seconds. Thrown on to poll(), a refusal became a system line on
        // every poll, and "Close DeathScreen before eating." when he died between two reads.
        this.nextMeal = this.now() + 10000;
        if (!(error instanceof DeadError)) {
          this.events.add("reflex", { text: `${this.closedForMeal ?? ""}Meal not started: ${error.message} Auto-eat retries in 10 s.` });
          this.closedForMeal = undefined;
        }
      }
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.pollTimer); await this.tail.close();
    await this.polling;
    const cleaningRescue = this.rescue !== undefined || this.rescueCleanup !== undefined;
    if (this.rescue) await this.finishRescue("shutdown");
    await this.rescueCleanup;
    await Promise.allSettled([
      ...(cleaningRescue ? [] : [this.api.player({ action: "release" })]),
      this.api.chat("#stop"),
      ...(this.lifted ? [this.api.chat(avoidBreaking(this.kept))] : []),
    ]);
    // After the stop, so no trip goes on under settings it was not planned with. A tool server that never read
    // the trip settings changed none of them.
    if (this.trip) await this.applyTrip(this.trip.baseline).catch(() => {});
  }
}
