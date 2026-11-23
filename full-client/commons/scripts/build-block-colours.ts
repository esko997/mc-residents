// Deploy-time: the diorama's block colour table from the modpack's own jars. Run on the host
// that serves the dashboard, against a game dir it already has (read-only), e.g.
//   bun scripts/build-block-colours.ts --jar ~/gary-client/game/versions/1.20.1/1.20.1.jar \
//     --mods ~/gary-client/game/mods --out ~/gary-client/commons-data/block-colours.json
// The output is derived from mod textures: keep it in the data directory, never in the repo.
import { readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildBlockColours } from "../src/block-colours.ts";

const jars: string[] = [];
let out: string | undefined;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--jar") jars.push(resolve(value));
    else if (flag === "--mods") for (const file of (await readdir(value)).sort()) { if (file.endsWith(".jar")) jars.push(resolve(value, file)); }
    else if (flag === "--out") out = resolve(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!out || !jars.length) throw new Error("Usage: bun scripts/build-block-colours.ts --jar <minecraft client jar> --mods <mods dir> --out <block-colours.json> (repeat --jar/--mods as needed; the client jar first)");
  const started = Date.now();
  const table = await buildBlockColours(jars, line => console.error(line));
  const temporary = `${out}.${process.pid}`;
  await writeFile(temporary, JSON.stringify({ version: 1, builtAt: Date.now(), sources: table.sources, colours: table.colours }), { mode: 0o644 });
  await rename(temporary, out);
  console.log(`${Object.keys(table.colours).length} block colours from ${table.sources.length} jars in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${out}`);
  if (table.missing.length) console.log(`${table.missing.length} blocks without a readable texture (shown with a hashed colour), e.g. ${table.missing.slice(0, 8).join(", ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
