import { Events, LogTail } from "./events.ts";
import { angles, hostileEntity, nonempty, playerEntity, type Config, type Entity, type Position, type Stack, type State, Synapse } from "./synapse.ts";

/** A destination. `y` is present only when the goal names a height, as in `#goto x y z`. */
export interface Goal { x: number; z: number; y?: number }
export interface Navigation {
  description: string; target?: Goal; follow?: string;
  /** Where he stood when the command was given. */
  start: Position;
  lastPos: Position; lastMoved: number; lastReply?: string; reported: boolean;
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
}
type RescueKind = "retreat" | "surface" | "lava" | "fire";
interface Rescue {
  kind: RescueKind; reason: string; started: number; paused: boolean; busy: boolean;
  action?: Promise<void>; error?: string; lastAim: number; detail?: string;
  enemyId?: number; initialAir?: number; initialMaxAir?: number;
  rotation?: State["rotation"]; slot?: number; bucketSlot?: number; placedAt?: number;
  /** The navigation that was running when a surface or lava rescue began. */
  navigation?: Navigation;
}
const rescuePriority: Record<RescueKind, number> = { retreat: 1, fire: 2, surface: 3, lava: 4 };
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const blockOf = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
// A goal with a height is not reached by standing above or below it: an
// underground destination must not report arrival from the surface.
const remaining = (pos: Position, goal: Goal) => Math.hypot(pos.x - goal.x, pos.z - goal.z, goal.y === undefined ? 0 : pos.y - goal.y);
const entityPosition = (entity: Entity): Position => ({ x: entity.pos[0], y: entity.pos[1], z: entity.pos[2] });
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
  /** A hazard is present but a screen would not close; reported once per episode. */
  private rescueBlocked = false;
  private nextMeal = 0;
  private combat?: { target: number; until: number; nextAttack: number; previousSlot: number };
  private fleeing = false;
  private fleeGeneration = 0;
  private crumbs: Position[] = [];
  private rescue?: Rescue;
  private rescueCleanup?: Promise<void>;
  /** Per goal description, when a surface or lava rescue stopped it (body clock, last ten minutes). */
  private hazardStops = new Map<string, number[]>();
  /** Consecutive stop-shorts of one goal from about one place; `start` is where the latest attempt began. */
  private stopShorts?: { description: string; start: Position; count: number };
  private manual = 0;
  private stopped = false;
  constructor(readonly config: Config, readonly api: Synapse, private now = Date.now) {
    this.tail = new LogTail(config.log, config.name, this.events, reply => {
      if (this.navigation && !this.navigation.reported) {
        this.navigation.lastReply = reply;
        this.navigation.lastMoved = this.now();
      }
    });
  }
  async start() {
    await this.tail.start(); await this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, 250);
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
      this.lastFull = this.now(); this.entities = full.nearbyEntities ?? [];
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
    this.checkNavigation(state);
    await this.reflex(this.state, hurt);
  }
  private rememberGround(state: State) {
    if (state.health <= 0 || state.onGround !== true || state.inWater !== false || state.inLava !== false || state.onFire !== false) return;
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
    const unavailable: string[] = [];
    if (!this.retreatSensors(state)) unavailable.push("safe-ground retreat (legacy flee remains active)");
    if (this.reflexes.surface && (state.underwater === undefined || state.air === undefined || state.maxAir === undefined)) unavailable.push("surface off");
    if (this.reflexes.escape_fire && (state.onFire === undefined || state.inWater === undefined || state.inLava === undefined)) unavailable.push("fire/lava rescue off");
    return unavailable.length ? `Survival senses unavailable from older Synapse: ${unavailable.join("; ")}.` : undefined;
  }
  private checkNavigation(state: State) {
    const nav = this.navigation;
    if (!nav || nav.reported || this.combat || this.fleeing || this.rescue?.paused) return;
    if (nav.follow) {
      const player = this.entities.find(e => playerEntity(e) && e.name === nav.follow);
      if (player) nav.target = { x: player.pos[0], z: player.pos[2] };
    }
    if (Math.hypot(state.pos.x - nav.lastPos.x, state.pos.y - nav.lastPos.y, state.pos.z - nav.lastPos.z) > 0.15) {
      nav.lastPos = { ...state.pos }; nav.lastMoved = this.now();
    }
    const left = nav.target ? remaining(state.pos, nav.target) : undefined;
    if (left !== undefined && left <= 2) {
      this.events.add("arrived", { goal: nav.description }); nav.reported = true;
      this.stopShorts = undefined;
    } else if (this.now() - nav.lastMoved >= 4000) {
      // navigate() dropped the count if this is another goal or began far from the last attempt.
      const attempts = (this.stopShorts?.count ?? 0) + 1;
      this.stopShorts = { description: nav.description, start: nav.start, count: attempts };
      this.events.add("stopped_short", {
        distance: left === undefined ? "unknown (no fixed destination)" : Math.round(left * 10) / 10,
        // Ahead of the Baritone reply, which is what the line limit may cut.
        ...(attempts >= 3 ? {
          attempts,
          text: nav.target && !nav.follow
            ? `same destination has stopped short ${attempts} times from about here`
            : `same command has ended ${attempts} times from about here`,
        } : {}),
        baritone: nav.lastReply ?? "no reply observed since start",
      });
      nav.reported = true;
    }
  }
  async navigate(command: string, target?: Goal, follow?: string) {
    const state = await this.api.state();
    await this.tail.read(); // Drain old replies before assigning a new navigation.
    // A rescue that is still cleaning up may be about to send #stop for the
    // navigation it interrupted; that must not land after this command.
    while (this.rescueCleanup) await this.rescueCleanup;
    const description = command.slice(1), last = this.stopShorts;
    if (last && (last.description !== description || Math.hypot(state.pos.x - last.start.x, state.pos.z - last.start.z) > 8)) this.stopShorts = undefined;
    this.navigation = { description, target, follow, start: { ...state.pos }, lastPos: { ...state.pos }, lastMoved: this.now(), reported: false };
    try {
      await this.api.chat(command);
      if (this.combat || this.fleeing || this.rescue?.paused) await this.api.chat("#pause");
    } catch (error) { this.navigation = undefined; throw error; }
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
    if (screen !== "none" || state.screen !== "none") throw new Error(`Close ${screen !== "none" ? screen : state.screen} before eating.`);
    let stack = this.food({ ...state, inventory: undefined }, item);
    let moved: string | undefined;
    if (!stack) {
      state = await this.api.state(true);
      stack = this.food(state, item);
      if (!stack) throw new Error("No matching food in inventory.");
      if (stack.slot >= 9) {
        const inventory = await this.openInventory();
        // Survival InventoryMenu slots 9..35 are the main inventory; 36..44 are H0..H8.
        const source = inventory.container?.slots.find(s => s.slot === stack!.slot);
        if (!source || source.item !== stack.item || source.count !== stack.count) {
          await this.closeScreen();
          throw new Error("Inventory food slot changed; no stack was moved.");
        }
        const slot = Array.from({ length: 9 }, (_, i) => i).find(i => !state.hotbar.some(s => s.slot === i && nonempty(s))) ?? state.selectedSlot;
        const displaced = state.hotbar.find(s => s.slot === slot && nonempty(s));
        await this.api.gui({ action: "clickSlot", slot: stack.slot, button: slot, mode: "SWAP" });
        const closed = await this.closeScreen();
        moved = `Moved ${stack.count} x ${stack.item} from inventory ${stack.slot} to H${slot}${displaced ? `; swapped ${displaced.item} to inventory ${stack.slot}` : ""}.`;
        if (closed.after !== "none") throw new Error(`${moved} ${closed.after} is still open after close and ESCAPE; cannot eat.`);
        const refreshed = await this.api.state();
        const ready = refreshed.hotbar.find(s => s.slot === slot && s.item === stack!.item && nonempty(s));
        if (!ready) throw new Error(`Food move to H${slot} was not observed; cannot eat.`);
        stack = ready;
      }
    }
    const meal: Meal = { item: stack.item, before: state.food, slot: state.selectedSlot, rotation: { ...state.rotation }, doneAt: 0, moved, automatic };
    try {
      await this.api.player({ action: "selectHotbar", slot: stack.slot });
      // move(sneak) only acknowledges after it ends, so cannot safely order it before use.
      // Look away instead, then wait for the client raycast to refresh before holding use.
      await this.api.player({ action: "look", yaw: state.rotation.yaw, pitch: -90 });
      await this.api.request("/wait?ticks=2");
      const current = (await this.api.gui()).screen;
      if (current !== "none") throw new Error(`Close ${current} before eating.`);
      await this.api.player({ action: "use", ticks: 40 });
      meal.doneAt = this.now() + 2200;
      this.eating = meal;
      return meal;
    } catch (error) {
      await this.releaseMeal(meal);
      throw new Error(`${moved ? `${moved} ` : ""}${error instanceof Error ? error.message : "Could not start eating."}`);
    }
  }
  private async releaseMeal(meal: Meal) {
    meal.finished = true;
    if (this.eating === meal) this.eating = undefined;
    await this.api.player({ action: "release" });
    await this.api.player({ action: "selectHotbar", slot: meal.slot });
    await this.api.player({ action: "look", ...meal.rotation });
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
      if (state.screen !== "none") await this.mealOpenedScreen(meal, state.screen);
      else await this.releaseMeal(meal);
    }
    if (meal.failure) throw new Error(`${meal.failure}${meal.moved ? ` ${meal.moved}` : ""}`);
    const result = `${meal.item}, food ${meal.before} -> ${state.food}.${meal.moved ? ` ${meal.moved}` : ""}`;
    if (state.food <= meal.before) throw new Error(`Eating failed: no food increase observed (${result})`);
    return result;
  }
  async manualAction<T>(action: () => Promise<T>): Promise<T> {
    this.manual++;
    try {
      if (this.rescue) await this.finishRescue("interrupted by your action");
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
  private async finishCombat(resume = true) {
    const combat = this.combat;
    if (!combat) return;
    this.combat = undefined;
    await this.api.player({ action: "release" });
    await this.api.player({ action: "selectHotbar", slot: combat.previousSlot });
    if (resume) {
      await this.api.chat("#resume");
      if (this.navigation) this.navigation.lastMoved = this.now();
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
            if (this.navigation) this.navigation.lastMoved = this.now();
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
    const paused = this.combat !== undefined || this.fleeing;
    if (this.eating) await this.releaseMeal(this.eating);
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
    };
    this.rescue = rescue;
    if (kind === "fire" && !usesControls) rescue.detail = current.dimension === "minecraft:the_nether" ? "water cannot be used in the Nether" : !this.reflexes.water_bucket ? "water bucket use is off" : "no water bucket in the hotbar";
    this.events.add("reflex", { text: `${kind} rescue started: ${reason}${rescue.detail ? `; ${rescue.detail}; reported only` : ""}` });
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
      const threat = entityPosition(enemy);
      const separation = distance(state.pos, threat);
      if (separation >= 10) { await this.finishRescue(`clear of threat at ${Math.round(separation * 10) / 10} blocks`); return; }
      if (elapsed >= 5000) { await this.finishRescue(`timed out after 5 s, ${Math.round(separation * 10) / 10} blocks from threat`); return; }
      if (state.onGround !== true) { await this.finishRescue("left safe ground; movement stopped"); return; }
      if (!this.retreatSensors(state)) { await this.finishRescue("survival senses disappeared"); return; }
      if (rescue.busy) return;
      if (this.now() - rescue.lastAim >= 500) {
        // The crumb must lie on his side, away from the threat: one merely
        // farther from it can be behind it, and live he ran past a lit creeper
        // toward ground he had walked on the far side.
        const away = { x: state.pos.x - threat.x, z: state.pos.z - threat.z };
        const crumb = [...this.crumbs].reverse().find(p =>
          distance(p, threat) > separation && distance(p, state.pos) > 0.75 &&
          (p.x - state.pos.x) * away.x + (p.z - state.pos.z) * away.z >= 0);
        const target = crumb ?? { x: state.pos.x * 2 - threat.x, y: state.eye.y, z: state.pos.z * 2 - threat.z };
        await this.lookAt({ x: target.x, y: state.eye.y, z: target.z }, state);
        rescue.lastAim = this.now();
        this.rescueMove(rescue, crumb ? { forward: true, sprint: true, ticks: 5 } : { forward: true, ticks: 4 });
      }
      return;
    }
    if (rescue.kind === "surface") {
      if (state.underwater === undefined || state.air === undefined || state.maxAir === undefined) { await this.finishRescue("air senses disappeared"); return; }
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
  private async finishRescue(outcome: string) {
    const rescue = this.rescue;
    if (!rescue) { await this.rescueCleanup; return; }
    this.rescue = undefined;
    // Resuming would walk him back into the water or lava this path crosses.
    // Dropped before any await, so no stopped_short is reported for it. A
    // navigation given during the rescue is another path and resumes as usual.
    const abandoned = rescue.navigation !== undefined && rescue.navigation === this.navigation ? rescue.navigation : undefined;
    if (abandoned) this.navigation = undefined;
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
            if (this.navigation) this.navigation.lastMoved = this.now();
          }
        } catch { failed = true; }
      }
      this.events.add("reflex", { text: `${rescue.kind} rescue ended after ${seconds(this.now() - rescue.started)}: ${outcome}${failed ? "; cleanup incomplete" : ""}` });
      if (abandoned) this.reportHazardStop(abandoned, rescue.kind === "lava" ? "lava" : "deep water");
    })();
    this.rescueCleanup = cleanup;
    try { await cleanup; } finally { if (this.rescueCleanup === cleanup) this.rescueCleanup = undefined; }
  }
  private reportHazardStop(nav: Navigation, hazard: string) {
    const now = this.now(), window = 600_000;
    for (const [goal, times] of this.hazardStops) if (now - times.at(-1)! > window) this.hazardStops.delete(goal);
    const times = [...(this.hazardStops.get(nav.description) ?? []).filter(time => now - time <= window), now];
    this.hazardStops.set(nav.description, times);
    const state = this.state!; // A rescue only starts from a polled state.
    const alive = state.health > 0, here = blockOf(state.pos);
    this.events.add("navigation_stopped", {
      goal: nav.description,
      reason: `the path led into ${hazard}${alive ? "" : " and you died there"}`,
      ...(alive ? { you: `${here.x},${here.y},${here.z}` } : {}),
      ...(alive && nav.target && !nav.follow ? { remaining: Math.round(remaining(state.pos, nav.target) * 10) / 10 } : {}),
      ...(times.length > 1 ? { times: `${times.length} in ten minutes` } : {}),
    });
  }
  private async reflex(state: State, hurt: boolean) {
    const needsMeal = this.reflexes.auto_eat && (state.food < this.reflexes.eat_below || (state.health < 14 && state.food < 20));
    const blocked = needsMeal && state.health > 0 && state.screen !== "none";
    if (blocked) {
      this.mealsBlocked ??= { since: this.now(), reported: false };
      if (!this.mealsBlocked.reported && this.now() - this.mealsBlocked.since > 20000) {
        this.events.add("reflex", { text: `${state.screen} is blocking meals; close it to eat (food ${state.food}).` });
        this.mealsBlocked.reported = true;
      }
    } else this.mealsBlocked = undefined;
    if (this.eating && state.screen !== "none") {
      await this.mealOpenedScreen(this.eating, state.screen);
      return;
    }
    // A screen freezes movement and held keys, so a hazard that arrives while
    // one is open (a chest opened at the water's edge, a crafting table in a
    // burning cabin) must get it out of the way rather than wait for him.
    if (state.screen !== "none" && state.health > 0 && !this.manual && !this.stopped && this.environmentalRescue(state)) {
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
    if (state.screen !== "none" || state.health <= 0 || this.manual || this.stopped) {
      if (this.rescue) await this.finishRescue(state.health <= 0 ? "death" : state.screen !== "none" ? `screen opened: ${state.screen}` : "manual control");
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
        try { this.events.add("reflex", { text: `ate ${await this.finishEating(this.eating, state)}` }); }
        catch (error) { this.events.add("reflex", { text: error instanceof Error ? error.message : "Eating failed." }); }
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
      await this.beginEating(state, undefined, true);
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
    ]);
  }
}
