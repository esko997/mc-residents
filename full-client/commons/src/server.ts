// Entry point:  bun src/server.ts   (environment: see README.md)
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { createApp, type App } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";

/** COMMONS_TOKEN, else the saved token, else a new one saved for the next start. */
export function resolveToken(config: Config): { token: string; created: boolean } {
  if (config.token) return { token: config.token, created: false };
  try {
    const saved = readFileSync(config.tokenFile, "utf8").trim();
    if (/^[A-Za-z0-9_-]{8,128}$/.test(saved)) return { token: saved, created: false };
  } catch { /* first start */ }
  const token = randomBytes(18).toString("base64url");
  mkdirSync(dirname(config.tokenFile), { recursive: true });
  writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(config.tokenFile, 0o600);
  return { token, created: true };
}

export interface Running { app: App; port: number; token: string; stop(): void }
/** Open the database, start watching, and listen. */
export function serve(config: Config): Running {
  const { token, created } = resolveToken(config);
  const app = createApp(config, token);
  const server = Bun.serve({ hostname: config.hostname, port: config.port, fetch: request => app.fetch(request) });
  app.start();
  const port = server.port ?? config.port;
  console.log(`commons: watching ${config.residents.map(resident => resident.name).join(", ")}; database ${config.dbPath}; port ${port}`);
  if (created) {
    // Printed once, when the token is made. Later starts keep it out of the journal.
    const lan = Object.values(networkInterfaces()).flat().find(address => address && address.family === "IPv4" && !address.internal)?.address ?? "localhost";
    console.log(`commons: open http://${lan}:${port}/${token}/  (token saved in ${config.tokenFile})`);
  } else if (!config.token) console.log(`commons: the address is http://<this machine>:${port}/<token>/ with the token in ${config.tokenFile}`);
  return { app, port, token, stop() { app.stop(); void server.stop(true); } };
}

if (import.meta.main) {
  const running = serve(loadConfig());
  // Let the encoder's bounded TERM/KILL/reap cleanup finish before Bun exits.
  const stop = () => { running.stop(); process.exitCode = 0; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
