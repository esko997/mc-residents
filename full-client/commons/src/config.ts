import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { observerSourceFromEnv, type ObserverSource } from "./observer.ts";

export interface ResidentConfig {
  name: string;
  /** Its note directory: memory.md, journal.md, notes/, places.json. */
  dir: string;
  synapseUrl: string;
  /** Tried in order; the first readable, non-empty file wins. */
  tokenFiles: string[];
  /** The unit that runs its Minecraft client. */
  clientUnit: string;
  /** Its client's log; the `[CHAT]` lines in it are what the resident saw in game. */
  clientLog: string;
  /** Dedicated launcher-owned Pulse null sink; never a speaker or microphone. */
  audioSink?: string;
}
export interface UnitConfig { unit: string; resident?: string }

export interface LiveConfig {
  enabled: boolean;
  ffmpeg: string;
  encoder: "h264_nvenc" | "h264_vaapi" | "libx264";
  vaapiDevice?: string;
  audio?: boolean;
  rtspUrl: string;
  whepUrl: string;
}
export interface Config {
  role: "hub" | "station";
  hostName: string;
  /** Only the hub reads this private list of station dashboard URLs. */
  stationsFile: string;
  home: string;
  port: number;
  hostname: string;
  dbPath: string;
  schemaPath: string;
  tokenFile: string;
  /** Bearer hashes for the hub Resident API, separate from the dashboard URL token. */
  credentialsFile: string;
  /** Set when COMMONS_TOKEN is given; otherwise the token file decides. */
  token?: string;
  chatUrl?: string;
  /**
   * Base address of the phone-chat service on the server machine, ending in `/<its token>/`.
   * The server console is read from it and commands are sent through it. Unset: neither is possible.
   */
  consoleUrl?: string;
  /** Optional read-only server observations, independent of each client's controls. */
  observer?: ObserverSource;
  /** On-demand framebuffer streaming, with dedicated resident audio opt-in. */
  live?: LiveConfig;
  /** Make every proposed shared note visible to residents at once; review comes afterwards. */
  autoAccept: boolean;
  /** In-game names of the people who own and play on the server; the console keeps mod lines that mention them. */
  owners: string[];
  sessionsDir: string;
  /** Where each resident's tool server writes its body calls, `<Name>.jsonl`. */
  callsDir: string;
  overseerDir: string;
  sharedPlaces: string;
  publicDir: string;
  /**
   * Every systemd user unit the app knows about, and the resident it belongs to, if any.
   * This and `residents` are the one place where names of residents and units are worked out.
   */
  units: UnitConfig[];
  systemctl: string;
  residents: ResidentConfig[];
  sampleMs: number;
  pictureMs: number;
  activityDays: number;
}

export const expandHome = (path: string) => path === "~" ? homedir() : path.replace(/^~\//, `${homedir()}/`);
const packageRoot = resolve(import.meta.dir, "..");

/** `KEY=value` lines as systemd's EnvironmentFile and bash both read them. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const found = /^([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (!found) continue;
    values[found[1]] = found[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** Restricted namespace reserved for launcher-created null sinks. */
export function residentAudioSink(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^resident_[A-Za-z0-9_]{1,48}$/.test(value)) {
    throw new Error("GARY_CLIENT_AUDIO_SINK must be a dedicated resident_ name containing only letters, digits and underscores.");
  }
  return value;
}

function residents(home: string, env: Record<string, string | undefined>): ResidentConfig[] {
  const sharedToken = env.SYNAPSE_TOKEN_FILE ? [expandHome(env.SYNAPSE_TOKEN_FILE)] : [];
  const unit = (name: string) => (env.COMMONS_CLIENT_UNIT ?? "gary-client@%s").replace("%s", name);
  const make = (name: string, gameDir: string, synapseUrl: string, sink?: string): ResidentConfig => ({
    name, dir: join(home, "resident", name.toLowerCase()), synapseUrl: synapseUrl.replace(/\/$/, ""),
    // The mod mirrors its token to ~/.synapse/token (what synapse.sh reads); the game directory is the fallback.
    tokenFiles: [...sharedToken, join(homedir(), ".synapse", "token"), join(gameDir, "config", "synapse", "token")],
    clientUnit: unit(name), clientLog: join(gameDir, "logs", "latest.log"),
    audioSink: residentAudioSink(sink),
  });
  const found = env.COMMONS_ROLE === "station" && !existsSync(join(home, "resident", "gary"))
    ? [] : [make("Gary", join(home, "game"), env.GARY_SYNAPSE_URL ?? "http://127.0.0.1:25599", env.GARY_CLIENT_AUDIO_SINK)];
  let files: string[] = [];
  try { files = readdirSync(join(home, "instances")).filter(file => file.endsWith(".env")).sort(); } catch { /* no other residents */ }
  for (const file of files) {
    const name = basename(file, ".env");
    if (!/^\w{1,16}$/.test(name)) continue;
    let values: Record<string, string> = {};
    try { values = parseEnvFile(readFileSync(join(home, "instances", file), "utf8")); } catch { continue; }
    if (name.toLowerCase() === "gary") {
      const gary = found.find(resident => resident.name === "Gary");
      if (gary) gary.audioSink = residentAudioSink(env.GARY_CLIENT_AUDIO_SINK ?? values.GARY_CLIENT_AUDIO_SINK);
      continue;
    }
    const resident = make(name, values.GAME_DIR ?? join(home, `game-${name}`), values.SYNAPSE_URL ?? "http://127.0.0.1:25599", values.GARY_CLIENT_AUDIO_SINK);
    // A test client has an instance file but no life of its own: no notes, nothing to watch.
    if (existsSync(resident.dir)) found.push(resident);
  }
  const sinks = found.flatMap(resident => resident.audioSink ? [resident.audioSink] : []);
  if (new Set(sinks).size !== sinks.length) throw new Error("Each resident audio sink must be dedicated to exactly one resident.");
  return found;
}

function liveConfig(env: Record<string, string | undefined>): LiveConfig {
  const endpoint = (key: string, fallback: string, protocol: string) => {
    const value = env[key] ?? fallback;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} must be a loopback URL.`); }
    // Numeric loopback only (or localhost): no DNS-dependent arbitrary hosts.
    if (url.protocol !== protocol || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")
      || !/^\/[A-Za-z0-9_/-]+$/.test(url.pathname) || url.pathname.endsWith("/")) {
      throw new Error(`${key} must be a loopback ${protocol} URL without credentials, query or fragment.`);
    }
    return url.href;
  };
  const encoder = env.COMMONS_LIVE_ENCODER ?? "h264_nvenc";
  if (encoder !== "h264_nvenc" && encoder !== "h264_vaapi" && encoder !== "libx264") {
    throw new Error("COMMONS_LIVE_ENCODER must explicitly select h264_nvenc, h264_vaapi or libx264; no fallback is used.");
  }
  const vaapiDevice = env.COMMONS_LIVE_VAAPI_DEVICE;
  if ((encoder === "h264_vaapi" && !vaapiDevice) || (vaapiDevice !== undefined && !/^\/dev\/dri\/renderD[0-9]{3,4}$/.test(vaapiDevice))) {
    throw new Error("COMMONS_LIVE_VAAPI_DEVICE must name a DRM render node for h264_vaapi.");
  }
  if (env.COMMONS_LIVE_AUDIO !== undefined && !["true", "false"].includes(env.COMMONS_LIVE_AUDIO)) {
    throw new Error("COMMONS_LIVE_AUDIO must be true or false (default false).");
  }
  const ffmpeg = env.COMMONS_LIVE_FFMPEG ?? "ffmpeg";
  if (!ffmpeg.trim() || ffmpeg.includes("\0")) throw new Error("COMMONS_LIVE_FFMPEG must name an executable.");
  return {
    enabled: env.COMMONS_LIVE_ENABLED === "true", ffmpeg, encoder, vaapiDevice, audio: env.COMMONS_LIVE_AUDIO === "true",
    rtspUrl: endpoint("COMMONS_LIVE_RTSP_URL", "rtsp://127.0.0.1:8554/resident", "rtsp:"),
    whepUrl: endpoint("COMMONS_LIVE_WHEP_URL", "http://127.0.0.1:8889/resident/whep", "http:"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = real(expandHome(env.GARY_CLIENT_HOME ?? "~/gary-client"));
  const role = env.COMMONS_ROLE ?? "hub";
  if (role !== "hub" && role !== "station") throw new Error("COMMONS_ROLE must be hub or station.");
  const hostName = env.COMMONS_HOST_NAME?.trim() || hostname();
  const dbPath = expandHome(env.COMMONS_DB ?? join(home, "commons", "commons.sqlite"));
  const port = Number(env.PORT ?? 8770);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env.PORT}.`);
  if (env.COMMONS_TOKEN !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(env.COMMONS_TOKEN)) {
    throw new Error("COMMONS_TOKEN must be 8 to 128 letters, digits, - or _ (it is a URL path segment).");
  }
  const found = residents(home, env);
  // COMMONS_UNITS replaces the run units; each resident's client unit is always included.
  const runUnits = env.COMMONS_UNITS === undefined
    ? [...found.map(resident => `${resident.name.toLowerCase()}-run`), "overseer-run"]
    : env.COMMONS_UNITS.split(/[\s,]+/).filter(Boolean);
  const units: UnitConfig[] = [...new Set([...runUnits, ...found.map(resident => resident.clientUnit)])].map(unit => ({
    unit,
    // A client unit is named after the template ("gary-client@Margo"), so it is matched whole before any prefix.
    resident: (found.find(resident => unit === resident.clientUnit)
      ?? found.find(resident => unit.toLowerCase().startsWith(`${resident.name.toLowerCase()}-`)))?.name,
  }));
  const consoleUrl = env.CONSOLE_URL || env.CHAT_URL || undefined;
  return {
    role, hostName,
    stationsFile: expandHome(env.COMMONS_STATIONS_FILE ?? join(home, "commons-data", "stations.json")),
    consoleUrl: role === "hub" && consoleUrl ? `${consoleUrl.replace(/\/+$/, "")}/` : undefined,
    observer: role === "hub" ? observerSourceFromEnv(env) : undefined,
    live: role === "hub" ? liveConfig(env) : undefined,
    autoAccept: role === "hub" && !/^(0|off|false|no)$/i.test(env.COMMONS_AUTO_ACCEPT ?? ""),
    owners: (env.COMMONS_OWNER ?? "spesk01").split(/[\s,]+/).filter(Boolean),
    home, port, hostname: env.COMMONS_BIND ?? "0.0.0.0", dbPath,
    schemaPath: expandHome(env.COMMONS_SCHEMA ?? join(packageRoot, "schema.sql")),
    tokenFile: expandHome(env.COMMONS_TOKEN_FILE ?? join(dirname(dbPath), "token")),
    credentialsFile: expandHome(env.COMMONS_CREDENTIALS_FILE ?? join(home, "commons-data", "credentials.json")),
    token: env.COMMONS_TOKEN, chatUrl: env.CHAT_URL || undefined,
    sessionsDir: join(expandHome(env.CODEX_HOME ?? join(home, "codex-home")), "sessions"),
    callsDir: expandHome(env.CALLS_DIR ?? join(home, "calls")),
    overseerDir: join(home, "overseer"),
    sharedPlaces: join(home, "resident", "shared", "places.json"),
    publicDir: join(packageRoot, "public"),
    units,
    systemctl: env.COMMONS_SYSTEMCTL ?? "systemctl",
    residents: found,
    sampleMs: Math.max(1000, Number(env.COMMONS_SAMPLE_SECONDS ?? 10) * 1000 || 10_000),
    pictureMs: 15_000,
    activityDays: Math.max(1, Number(env.COMMONS_ACTIVITY_DAYS ?? 2) || 2),
  };
}
