import { Events, LogTail } from "./events.ts";
import { angles, hostileEntity, nonempty, playerEntity, type Config, type Entity, type Position, type Stack, type State, Synapse } from "./synapse.ts";

export interface Navigation {
  description: string; target?: Position; follow?: string;
  lastPos: Position; lastMoved: number; reported: boolean;
}
export interface Reflexes { auto_eat: boolean; eat_below: number; when_attacked: "auto" | "fight" | "flee" | "nothing" }
const foods: Record<string, true> = Object.fromEntries((
  "apple golden_apple enchanted_golden_apple bread baked_potato carrot golden_carrot beetroot melon_slice sweet_berries glow_berries dried_kelp cookie pumpkin_pie mushroom_stew rabbit_stew beetroot_soup cooked_beef cooked_porkchop cooked_chicken cooked_mutton cooked_rabbit cooked_cod cooked_salmon beef porkchop chicken mutton rabbit cod salmon tropical_fish potato honey_bottle"
).split(" ").map(item => [`minecraft:${item}`, true]));
export class Body {
  readonly events = new Events();
  readonly tail: LogTail;
  state?: State;
  entities: Entity[] = [];
  navigation?: Navigation;
  reflexes: Reflexes = { auto_eat: true, eat_below: 12, when_attacked: "auto" };
  error?: string;
  private pollTimer?: Timer;
  private polling?: Promise<void>;
  private lastFull = -Infinity;
  private players = new Map<string, Entity>();
  private eating?: { item: string; before: number; slot: number; doneAt: number };
  private combat?: { target: number; until: number; nextAttack: number; previousSlot: number };
  private fleeing = false;
  private fleeGeneration = 0;
  private manual = 0;
  private stopped = false;
  constructor(readonly config: Config, readonly api: Synapse, private now = Date.now) {
    this.tail = new LogTail(config.log, config.name, this.events);
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
      if (state.health <= 0 && this.state.health > 0) this.events.add("died");
      if (state.food < 7 && this.state.food >= 7) this.events.add("hungry", { food: state.food });
    } else if (state.food < 7) this.events.add("hungry", { food: state.food });
    this.state = state; this.error = undefined;
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
    this.checkNavigation(state);
    await this.reflex(state, hurt);
  }
  private checkNavigation(state: State) {
    const nav = this.navigation;
    if (!nav || nav.reported || this.combat || this.fleeing) return;
    if (nav.follow) {
      const player = this.entities.find(e => playerEntity(e) && e.name === nav.follow);
      if (player) nav.target = { x: player.pos[0], y: player.pos[1], z: player.pos[2] };
    }
    if (Math.hypot(state.pos.x - nav.lastPos.x, state.pos.y - nav.lastPos.y, state.pos.z - nav.lastPos.z) > 0.15) {
      nav.lastPos = { ...state.pos }; nav.lastMoved = this.now();
    }
    const distance = nav.target ? Math.hypot(state.pos.x - nav.target.x, state.pos.z - nav.target.z) : undefined;
    if (distance !== undefined && distance <= 2) {
      this.events.add("arrived", { goal: nav.description }); nav.reported = true;
    } else if (this.now() - nav.lastMoved >= 4000) {
      this.events.add("stopped_short", { distance: distance === undefined ? "unknown (no fixed destination)" : Math.round(distance * 10) / 10 });
      nav.reported = true;
    }
  }
  async navigate(command: string, target?: Position, follow?: string) {
    const state = await this.api.state();
    await this.api.chat(command);
    if (this.combat || this.fleeing) await this.api.chat("#pause");
    this.navigation = { description: command.slice(1), target, follow, lastPos: { ...state.pos }, lastMoved: this.now(), reported: false };
  }
  async lookAt(target: Position, state?: State) {
    state ??= await this.api.state();
    return this.api.player({ action: "look", ...angles(state.eye, target) });
  }
  food(state: State, item?: string): Stack | undefined {
    const hasEdibleMetadata = state.hotbar.some(stack => stack.edible !== undefined);
    return state.hotbar.find(s => nonempty(s) && (!item || s.item === item) &&
      (s.edible === true || (!hasEdibleMetadata && s.edible === undefined && foods[s.item])));
  }
  async beginEating(state: State, item?: string) {
    if (state.screen !== "none") throw new Error("Close the screen before eating.");
    const stack = this.food(state, item);
    if (!stack) throw new Error("No matching food in hotbar; move food there with click_slot first.");
    await this.api.player({ action: "selectHotbar", slot: stack.slot });
    await this.api.player({ action: "use", ticks: 40 });
    return stack;
  }
  async manualAction<T>(action: () => Promise<T>): Promise<T> {
    this.manual++;
    try {
      await this.finishCombat();
      if (this.fleeing) {
        this.fleeGeneration++; this.fleeing = false;
        await this.api.player({ action: "release" }); await this.api.chat("#resume");
        this.events.add("reflex", { text: "flee interrupted by your action" });
      }
      if (this.eating) {
        await this.api.player({ action: "release" }); this.eating = undefined;
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
  private async reflex(state: State, hurt: boolean) {
    if (state.screen !== "none" || state.health <= 0 || this.manual || this.stopped) {
      if (this.eating || this.fleeing) {
        this.eating = undefined; this.fleeGeneration++; this.fleeing = false;
        await this.api.player({ action: "release" });
        this.events.add("reflex", { text: "automatic input released (screen, death or manual control)" });
      }
      await this.finishCombat(); return;
    }
    if (this.fleeing) return;
    if (this.eating) {
      if (this.now() >= this.eating.doneAt) {
        const eating = this.eating; this.eating = undefined;
        await this.api.player({ action: "selectHotbar", slot: eating.slot });
        this.events.add("reflex", { text: `ate ${eating.item}, food ${eating.before} -> ${state.food}` });
      } else if (!hurt) return;
    }
    if (this.combat) {
      const combat = this.combat;
      const enemy = this.entities.find(e => e.id === combat.target && hostileEntity(e) && e.distance <= 6);
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
      if (this.eating) { await this.api.player({ action: "release" }); this.eating = undefined; }
      const weapon = state.hotbar.find(s => nonempty(s) && /_(sword|axe)$/.test(s.item));
      const mode = this.reflexes.when_attacked;
      if (mode === "flee" || (mode === "auto" && (!weapon || state.health < 8))) {
        await this.startFlee(enemy, state, mode === "flee" ? "flee configured" : !weapon ? "no weapon" : "low health");
      } else {
        await this.api.chat("#pause");
        if (weapon) await this.api.player({ action: "selectHotbar", slot: weapon.slot });
        this.combat = { target: enemy.id, until: this.now() + 15000, nextAttack: 0, previousSlot: state.selectedSlot };
        this.events.add("reflex", { text: `defending against ${enemy.type}; navigation paused` });
      }
      return;
    }
    if (this.reflexes.auto_eat && state.food < this.reflexes.eat_below && !this.eating && this.food(state)) {
      const stack = await this.beginEating(state);
      this.eating = { item: stack.item, before: state.food, slot: state.selectedSlot, doneAt: this.now() + 2200 };
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.pollTimer); await this.tail.close();
    await this.polling;
    await Promise.allSettled([this.api.player({ action: "release" }), this.api.chat("#stop")]);
  }
}
