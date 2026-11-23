// A deliberate, one-way on-air projection. Never spread machine/session objects here.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Context } from "./routes/context.ts";
import { readOverlayFile, type OverlayState } from "./overlay-state.ts";

export interface OverlayData {
  at: number; resident: string; online: boolean; sampledAt: number | null;
  vitals: { health: number | null; maxHealth: number | null; food: number | null; air: number | null } | null;
  position: { x: number; y: number; z: number; dimension: string } | null;
  plan: { focus: string; next: string } | null;
  chat: { at: number; name: string; text: string }[];
  alarms: { at: number; text: string }[];
  nearby: { name: string; distance: number | null }[];
  map: { points: { x: number; z: number; name: string }[]; trail: { x: number; z: number }[] };
  caretaker: string; title: string; nowPlaying: string;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Discover configured secrets locally, without ever opening a network source. */
export function overlaySecrets(config: Config, dashboardToken: string): string[] {
  const secrets = new Set<string>([dashboardToken, config.token ?? "", config.hostName, config.hostname, config.home]);
  const files = [config.tokenFile, ...config.residents.flatMap(resident => resident.tokenFiles), ...(config.observer ? [config.observer.tokenFile] : [])];
  for (const path of files) {
    // Token readers elsewhere allow configured symlinks; resolve them before the bounded read.
    try { secrets.add(readOverlayFile(realpathSync(path), 8192).trim()); } catch { /* Absent tokens have no value to expose. */ }
  }
  const values: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(config);
  // Federation URLs contain remote dashboard tokens, even though remote video is unsupported.
  try { walk(JSON.parse(readOverlayFile(realpathSync(config.stationsFile), 65_536))); } catch { /* No station configuration. */ }
  for (const value of values) {
    if (value.includes("://")) {
      secrets.add(value);
      try {
        const url = new URL(value);
        secrets.add(url.hostname); secrets.add(decodeURIComponent(url.username)); secrets.add(decodeURIComponent(url.password));
        url.pathname.split("/").filter(part => part.length >= 8).forEach(part => secrets.add(decodeURIComponent(part)));
        url.searchParams.forEach(part => secrets.add(part));
      } catch { /* Invalid URLs remain matched literally. */ }
    } else if (/^(?:\/|~\/|[A-Za-z]:\\)/.test(value)) secrets.add(value);
  }
  return [...secrets].filter(value => value.length > 0).sort((a, b) => b.length - a.length);
}

/** Suspicious text is withheld in full, not partially parsed into a possibly leaky sentence. */
export function overlayText(value: unknown, hidden: readonly string[], secrets: readonly string[], limit = 240): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/§./g, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  if (secrets.some(secret => lower.includes(secret.toLowerCase())) ||
      /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:^|[^a-z0-9])(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}(?=$|[^a-z0-9])|(?:^|[\s("'`])(?:~?\/|[A-Za-z]:\\)|\b[\w.-]+\/[\w./-]+|\b[\w-]+(?:\.[\w-]+)+\b|\b[\w-]+:\d{2,5}\b|\b(?:localhost|ssh|bearer|password|passwd|token|credential|cookie|api[_ -]?key|access[_ -]?token|secret|authorization|session[_ -]?id|private[_ -]?key)\b|\b[\da-f]{32,}\b|\b[A-Za-z0-9_+/=-]{48,}\b)/i.test(clean)) return "[private]";
  let text = clean;
  for (const name of hidden) text = text.replace(new RegExp(escaped(name), "gi"), "[hidden]");
  return text.slice(0, limit);
}

function jsonFile(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readOverlayFile(path, 262_144))); } catch { return {}; }
}
function caretakerNote(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) return "";
    const bytes = Buffer.alloc(Math.min(info.size, 65_536));
    const start = Math.max(0, info.size - bytes.length);
    const length = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.toString("utf8", 0, length);
    if (start) text = text.slice(text.indexOf("\n") + 1);
    const sections = text.split(/^## /m);
    for (const section of sections.reverse()) {
      const note = /(?:^|\n)NOTE:\s*([^]*?)(?=\n(?:MAINTAINERS:|## )|$)/.exec(section);
      if (note) return note[1].trim();
    }
  } catch { /* Missing caretaker notes are unavailable, not fabricated. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return "";
}

export function overlayData(context: Context, state: OverlayState, secrets: readonly string[]): OverlayData {
  const { config, watcher, stream, db } = context, at = context.now();
  const resident = config.residents.find(item => item.name === state.resident)!;
  const hidden = state.hideNames, text = (value: unknown, limit = 240) => overlayText(value, hidden, secrets, limit);
  const hide = (name: string) => hidden.some(value => value.toLowerCase() === name.toLowerCase());
  const sighting = watcher.sighting(resident.name), body = sighting.state;
  const position = body && [body.pos.x, body.pos.y, body.pos.z].every(value => number(value) !== null) ? { x: body.pos.x, y: body.pos.y, z: body.pos.z, dimension: text(body.dimension, 80) } : null;
  const planFile = jsonFile(join(resident.dir, "plan.json"));
  const plans = Array.isArray(planFile.plans) ? planFile.plans.slice(0, 100).map(object) : [];
  const active = plans.find(plan => plan.name === planFile.focus);
  const rawSteps = active?.steps;
  const steps = Array.isArray(rawSteps) ? rawSteps.slice(0, 100).map(object) : [];
  const next = steps.find(step => step.state === "doing") ?? steps.find(step => step.state !== "done");
  const chat: OverlayData["chat"] = [];
  // Only explicit ordinary player speech; commands, output, warnings and system text never go on air.
  for (const line of stream.since().lines.slice(-200)) {
    if (line.kind !== "chat" || line.mark || line.noise) continue;
    const speech = /^(?:\[Not Secure\] )?<([\w]{1,40})> (.*)$/.exec(line.text);
    if (!speech || hide(speech[1]) || speech[1].toLowerCase() === "caretaker") continue;
    const name = text(speech[1], 40), message = text(speech[2]);
    if (name && name !== "[private]" && message) chat.push({ at: line.t, name, text: message });
  }
  const alarms: OverlayData["alarms"] = [];
  if (config.role === "hub") {
    const rows = db.query<{ at: number; event_json: string }, [number]>("SELECT at,event_json FROM resident_alarms WHERE at>=? ORDER BY id DESC LIMIT 12").all(at - 3_600_000);
    for (const row of rows.reverse()) {
      try {
        const alarm = object(JSON.parse(row.event_json));
        if (typeof alarm.sender === "string" && !hide(alarm.sender)) alarms.push({ at: row.at, text: text(`${alarm.sender}: ${typeof alarm.reason === "string" ? alarm.reason : "Help requested"}`) });
      } catch { /* A damaged event is not broadcast. */ }
    }
  }
  const nearby: OverlayData["nearby"] = [];
  for (const name of body?.nearby.players.slice(0, 32) ?? []) {
    if (hide(name)) continue;
    const safeName = text(name, 40);
    if (!safeName || safeName === "[private]") continue;
    const other = watcher.sighting(name).state;
    const distance = body && other && other.dimension === body.dimension ? Math.round(Math.hypot(body.pos.x - other.pos.x, body.pos.y - other.pos.y, body.pos.z - other.pos.z)) : null;
    nearby.push({ name: safeName, distance: number(distance) });
  }
  const sameDimension = (value: unknown) => typeof value === "string" && (value === body?.dimension || value.replace(/^minecraft:/, "") === body?.dimension.replace(/^minecraft:/, ""));
  const points: OverlayData["map"]["points"] = [];
  const places = jsonFile(join(resident.dir, "places.json"));
  const own = Array.isArray(places.places) ? places.places.slice(0, 128) : [];
  const shared = config.role === "hub" ? db.query<{ data: string }, []>("SELECT data FROM shared_places ORDER BY rowid DESC LIMIT 128").all().flatMap(row => {
    try { return [JSON.parse(row.data)]; } catch { return []; }
  }) : [];
  for (const value of [...own, ...shared]) {
    const place = object(value), name = text(place.name, 80), x = number(place.x), z = number(place.z);
    if (x !== null && z !== null && sameDimension(place.dimension) && name && name !== "[private]") points.push({ x, z, name });
  }
  const rows = db.query<{ x: number; z: number; dimension: string }, [string, number]>("SELECT x,z,dimension FROM positions WHERE resident=? AND at>=? ORDER BY at DESC LIMIT 256").all(resident.name, at - 3_600_000).reverse();
  const trail = rows.filter(row => sameDimension(row.dimension) && number(row.x) !== null && number(row.z) !== null).map(row => ({ x: row.x, z: row.z }));
  return {
    at, resident: resident.name, online: sighting.status === "online", sampledAt: sighting.checkedAt || null,
    vitals: body ? { health: number(body.health), maxHealth: number(body.maxHealth), food: number(body.food), air: number(body.air?.now) } : null,
    position, plan: typeof planFile.focus === "string" ? { focus: text(planFile.focus, 160), next: text(next?.text, 200) } : null,
    chat: chat.slice(-12), alarms, nearby, map: { points: points.slice(0, 128), trail },
    caretaker: text(caretakerNote(join(config.overseerDir, `${resident.name}.md`)), 360), title: text(state.title, 160), nowPlaying: text(state.nowPlaying, 160),
  };
}
