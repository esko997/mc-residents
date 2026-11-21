import { buildKnowledge } from "../src/knowledge/build";

const jars: string[] = [];
const dirs: string[] = [];
let out: string | undefined;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--jar") jars.push(value);
    else if (flag === "--mods") dirs.push(value);
    else if (flag === "--out") out = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!out) throw new Error("Usage: bun scripts/build-knowledge.ts --jar <vanilla-client.jar> --jar <forge-universal.jar> --mods <mod-directory> --out <db.sqlite> (repeat --jar/--mods as needed; Forge supplies the baseline forge: item tags)");
  await buildKnowledge(jars, dirs, out);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
