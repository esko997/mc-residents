import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
}
export interface UnitConfig { unit: string; resident?: string }
export interface Config {
  home: string;
  port: number;
  hostname: string;
  dbPath: string;
  schemaPath: string;
  tokenFile: string;
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

function residents(home: string, env: Record<string, string | undefined>): ResidentConfig[] {
  const sharedToken = env.SYNAPSE_TOKEN_FILE ? [expandHome(env.SYNAPSE_TOKEN_FILE)] : [];
  const unit = (name: string) => (env.COMMONS_CLIENT_UNIT ?? "gary-client@%s").replace("%s", name);
  const make = (name: string, gameDir: string, synapseUrl: string): ResidentConfig => ({
    name, dir: join(home, "resident", name.toLowerCase()), synapseUrl: synapseUrl.replace(/\/$/, ""),
    // The mod mirrors its token to ~/.synapse/token (what synapse.sh reads); the game directory is the fallback.
    tokenFiles: [...sharedToken, join(homedir(), ".synapse", "token"), join(gameDir, "config", "synapse", "token")],
    clientUnit: unit(name), clientLog: join(gameDir, "logs", "latest.log"),
  });
  const found = [make("Gary", join(home, "game"), env.GARY_SYNAPSE_URL ?? "http://127.0.0.1:25599")];
  let files: string[] = [];
  try { files = readdirSync(join(home, "instances")).filter(file => file.endsWith(".env")).sort(); } catch { /* no other residents */ }
  for (const file of files) {
    const name = basename(file, ".env");
    if (!/^\w{1,16}$/.test(name) || name.toLowerCase() === "gary") continue;
    let values: Record<string, string> = {};
    try { values = parseEnvFile(readFileSync(join(home, "instances", file), "utf8")); } catch { continue; }
    const resident = make(name, values.GAME_DIR ?? join(home, `game-${name}`), values.SYNAPSE_URL ?? "http://127.0.0.1:25599");
    // A test client has an instance file but no life of its own: no notes, nothing to watch.
    if (existsSync(resident.dir)) found.push(resident);
  }
  return found;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = real(expandHome(env.GARY_CLIENT_HOME ?? "~/gary-client"));
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
    consoleUrl: consoleUrl && `${consoleUrl.replace(/\/+$/, "")}/`,
    observer: observerSourceFromEnv(env),
    autoAccept: !/^(0|off|false|no)$/i.test(env.COMMONS_AUTO_ACCEPT ?? ""),
    owners: (env.COMMONS_OWNER ?? "spesk01").split(/[\s,]+/).filter(Boolean),
    home, port, hostname: env.COMMONS_BIND ?? "0.0.0.0", dbPath,
    schemaPath: expandHome(env.COMMONS_SCHEMA ?? join(packageRoot, "schema.sql")),
    tokenFile: expandHome(env.COMMONS_TOKEN_FILE ?? join(dirname(dbPath), "token")),
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
