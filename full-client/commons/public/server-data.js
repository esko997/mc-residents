// Pure helpers (no DOM) for the Server record panel and the Map's building layer: readable names
// for advancements, items and counters, units for Minecraft's statistics, and the block layer's
// per-chunk summaries. Tested in test/server-data-ui.test.js.

const MOD_NAMES = {
  minecraft: "Minecraft", immersiveengineering: "Immersive Engineering", naturesaura: "Nature's Aura", refinedstorage: "Refined Storage",
  mekanismgenerators: "Mekanism Generators", jumbofurnace: "Jumbo Furnace", exposure_polaroid: "Exposure Polaroid",
};
/** "immersiveengineering" -> "Immersive Engineering" when known, else the id with a capital. */
export const modName = namespace => MOD_NAMES[namespace] ?? namespace.charAt(0).toUpperCase() + namespace.slice(1);
const sentence = words => {
  const text = words.replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * An advancement's title as a person reads it. The server sends whatever its language resolves; for a
 * mod without an English entry that is the translation key itself (`advancements.occultism.craft_satchel.title`).
 * Such keys, and missing titles, are turned into words from the key or the id; `made` says so.
 */
export function readableTitle(title, id) {
  if (title && !/^[a-z0-9_]+(\.[a-z0-9_]+){2,}$/.test(title)) return { text: title, made: false };
  if (title) {
    const parts = title.split(".").filter(part => !["advancements", "advancement", "title", "name"].includes(part));
    const last = parts.at(-1);
    if (last) return { text: sentence(last), made: true };
  }
  const path = (id.split(":")[1] ?? id).split("/");
  const last = path.at(-1) === "root" && path.length > 1 ? path.at(-2) : path.at(-1);
  return { text: last === "root" ? modName(id.split(":")[0]) : sentence(last ?? id), made: true };
}

/** A tab's name: its root's title, or "<Mod>, outside the tabs" for advancements whose parent is not loaded. */
export function tabName(tab) {
  if (tab.id.endsWith(":*")) return `${modName(tab.id.slice(0, -2))}, outside the tabs`;
  return readableTitle(tab.title, tab.id).text;
}

/** "minecraft:oak_log" -> "oak log"; a mod's item keeps its mod: "andesite alloy (Create)". */
export function itemName(id) {
  const [namespace, path] = id.includes(":") ? id.split(":", 2) : ["minecraft", id];
  const words = path.replace(/[_/]+/g, " ");
  return namespace === "minecraft" ? words : `${words} (${modName(namespace)})`;
}

const count = number => Math.round(number).toLocaleString("en-US");

/** Game ticks (20 a second) as hours and minutes. */
export function formatTicks(ticks) {
  const minutes = Math.floor(ticks / 1200);
  if (ticks > 0 && minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  return hours ? `${count(hours)} h ${minutes % 60} min` : `${minutes} min`;
}
/** Centimetres as blocks (one block is a metre); long distances in kilometres. */
export function formatDistance(cm) {
  const blocks = cm / 100;
  if (blocks >= 10_000) return `${(blocks / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
  return `${count(blocks)} ${Math.round(blocks) === 1 ? "block" : "blocks"}`;
}
/** Damage statistics count tenths of a health point; a heart is two points. */
export function formatHearts(tenths) {
  const hearts = tenths / 20;
  return `${hearts >= 100 ? count(hearts) : hearts.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${hearts === 1 ? "heart" : "hearts"}`;
}

/** How a `minecraft:custom` counter's value reads: by its unit (distance, time, damage) or as a count. */
export function counterValue(key, value) {
  const name = key.split(":").pop();
  if (name.endsWith("_one_cm")) return formatDistance(value);
  if (/(^|_)time$|^time_since|^play_one_minute$|^sneak_time$/.test(name)) return formatTicks(value);
  if (name.startsWith("damage_")) return formatHearts(value);
  return count(value);
}
const COUNTER_LABELS = {
  play_time: "time played", total_world_time: "time in the world", time_since_death: "time since last death", time_since_rest: "time since last sleep",
  sneak_time: "time sneaking", leave_game: "times left the game", open_chest: "chests opened", open_barrel: "barrels opened", jump: "jumps",
  drop: "items dropped (presses)", fish_caught: "fish caught", animals_bred: "animals bred", talked_to_villager: "talked to villagers",
  traded_with_villager: "trades with villagers", sleep_in_bed: "nights slept", mob_kills: "mobs killed", player_kills: "players killed",
  deaths: "deaths", damage_taken: "damage taken", damage_dealt: "damage dealt", damage_blocked_by_shield: "damage blocked by a shield",
  fly_one_cm: "airborne (jumps and falls)", aviate_one_cm: "gliding with an elytra", fall_one_cm: "fallen",
};
/** "minecraft:interact_with_crafting_table" -> "interact with crafting table"; a mod's counter keeps its mod. */
export function counterLabel(key) {
  const [namespace, name] = key.includes(":") ? key.split(":", 2) : ["minecraft", key];
  const label = COUNTER_LABELS[name] ?? name.replace(/_one_cm$/, "").replace(/_/g, " ");
  return namespace === "minecraft" ? label : `${label} (${modName(namespace)})`;
}

/** The headline rows, in order, with how each value reads. `optional` rows are left out while every resident has 0. */
export const HEADLINES = [
  { key: "playTime", label: "Time played", unit: formatTicks },
  { key: "onFoot", label: "On foot", note: "walking, running, crouching and climbing", unit: formatDistance },
  { key: "swum", label: "Swimming", unit: formatDistance, optional: true },
  { key: "boat", label: "By boat", unit: formatDistance },
  { key: "ridden", label: "Riding", note: "horse, pig, strider or minecart", unit: formatDistance },
  { key: "glided", label: "Gliding", note: "elytra", unit: formatDistance, optional: true },
  { key: "mined", label: "Blocks mined", unit: count },
  { key: "crafted", label: "Items crafted", note: "a craft of four planks counts four", unit: count },
  { key: "mobKills", label: "Mobs killed", unit: count },
  { key: "deaths", label: "Deaths", unit: count },
  { key: "damageTaken", label: "Damage taken", unit: formatHearts },
  { key: "damageDealt", label: "Damage dealt", unit: formatHearts },
];

/** "+1 h 10 min" for a change in the window, or null when there was none. */
export function changeText(change, unit) {
  if (!change) return null;
  return change > 0 ? `+${unit(change)}` : `−${unit(-change)}`;
}

/**
 * Per chunk of one dimension, what the layer draws: totals for the chosen resident and kind of change,
 * the resident with most changes there (its colour), and everyone's share for the readout.
 * `show` is "both", "placed" or "broken".
 */
export function chunkSummaries(cells, { dimension, who = "All", show = "both" }) {
  const chunks = new Map();
  for (const cell of cells) {
    if (cell.dimension !== dimension || (who !== "All" && cell.resident !== who)) continue;
    const value = show === "placed" ? cell.placed : show === "broken" ? cell.broken : cell.placed + cell.broken;
    if (!value) continue;
    const key = `${cell.chunkX},${cell.chunkZ}`;
    const chunk = chunks.get(key) ?? { chunkX: cell.chunkX, chunkZ: cell.chunkZ, total: 0, placed: 0, broken: 0, lastAt: 0, residents: [] };
    chunk.total += value; chunk.placed += cell.placed; chunk.broken += cell.broken; chunk.lastAt = Math.max(chunk.lastAt, cell.lastAt);
    chunk.residents.push({ name: cell.resident, placed: cell.placed, broken: cell.broken, value });
    chunks.set(key, chunk);
  }
  return [...chunks.values()].map(chunk => {
    chunk.residents.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    return { ...chunk, lead: chunk.residents[0].name };
  });
}

/** Fill strength for a chunk: logarithmic, so one busy build site does not wash out everything else. */
export function shade(total, max) {
  if (!total || !max) return 0;
  return 0.18 + 0.62 * Math.log1p(total) / Math.log1p(max);
}

/** Chunk coordinates of a block position (16 blocks a side, negative coordinates included). */
export const chunkOf = (x, z) => [Math.floor(x / 16), Math.floor(z / 16)];

/** A 64-block area's name for a reader: the nearest saved place within 64 blocks of its middle, else its coordinates. */
export function areaName(area, places) {
  const x0 = area.areaX * 64, z0 = area.areaZ * 64, cx = x0 + 32, cz = z0 + 32;
  let best = null, bestDistance = 64;
  for (const place of places) {
    if (place.dimension !== area.dimension) continue;
    const distance = Math.hypot(place.x - cx, place.z - cz);
    if (distance <= bestDistance) { best = place; bestDistance = distance; }
  }
  const span = `x ${x0}..${x0 + 63}, z ${z0}..${z0 + 63}`;
  return best ? { text: `near ${best.name}`, owner: best.owner, span, x: cx, z: cz } : { text: `around x ${cx}, z ${cz}`, owner: null, span, x: cx, z: cz };
}

/** Hourly totals for the bar strip under the map, oldest first, every hour of the window present. */
export function hourBars(hours, { since, until, dimension, who = "All", show = "both" }) {
  const HOUR = 3_600_000, first = Math.floor(since / HOUR) * HOUR, bars = new Map();
  for (let hour = first; hour < until; hour += HOUR) bars.set(hour, { hour, placed: 0, broken: 0 });
  for (const row of hours) {
    if (row.dimension !== dimension || (who !== "All" && row.resident !== who)) continue;
    const bar = bars.get(row.hour);
    if (!bar) continue;
    if (show !== "broken") bar.placed += row.placed;
    if (show !== "placed") bar.broken += row.broken;
  }
  return [...bars.values()];
}

/** A container flow's item changes in words: "+2 wheat, −1 wheat seeds". */
export function deltaText(deltas) {
  return deltas.map(delta => {
    const change = delta.after - delta.before;
    return change ? `${change > 0 ? "+" : "−"}${count(Math.abs(change))} ${itemName(delta.item)}` : `${itemName(delta.item)} (item data changed)`;
  }).join(", ");
}
const UNCERTAIN = {
  item_kinds_truncated: "more kinds of item than the bridge lists",
  slots_truncated: "more slots than the bridge reads",
  observation_gap: "the container could not be read in between; changes are netted over the gap",
  block_changed: "the block itself was replaced",
  nbt_only_change: "only items with extra data changed, which is not read",
};
export const uncertainText = reason => UNCERTAIN[reason] ?? reason.replace(/_/g, " ");

/** A recorded gap in words: the bridge's run and hour numbers (epoch ms) become times. */
export function gapText(detail, stamp) {
  return detail.replace(/\brun (\d{12,14})\b/g, (_, ms) => `the bridge run that started ${stamp(Number(ms))}`)
    .replace(/\bhour (\d{12,14})\b/g, (_, ms) => `the hour from ${stamp(Number(ms))}`)
    .replace(/\bbefore (\d{12,14})\b/g, (_, ms) => `before ${stamp(Number(ms))}`);
}

const KINDS = {
  stats: "statistics", advancements: "advancement progress", advancement_catalog: "the list of advancements",
  block_hours: "block counts", blocks: "individual block changes", flows: "container flows",
};
/** The bridge's query kinds in words: ["block_hours", "blocks"] -> "block counts and individual block changes". */
export function kindsText(kinds) {
  const words = kinds.map(kind => KINDS[kind] ?? kind.replace(/_/g, " "));
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "";
}
