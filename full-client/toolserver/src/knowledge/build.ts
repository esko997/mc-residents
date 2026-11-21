import { Database } from "bun:sqlite";
import { unzipSync, strFromU8 } from "fflate";
import { dirname, resolve } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import type { RecipeIngredient, RecipeSummary } from "./types";

type Json = Record<string, unknown>;
type Counts = Record<string, number>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registryId(value: string): string {
  return value.includes(":") ? value : `minecraft:${value}`;
}

function merge(parts: RecipeIngredient[]): RecipeIngredient[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    if (part.what === "minecraft:air") continue;
    counts.set(part.what, (counts.get(part.what) ?? 0) + part.count);
  }
  return [...counts].map(([what, count]) => ({ what, count }));
}

function ingredients(value: unknown, multiplier = 1): RecipeIngredient[] {
  if (typeof value === "string") {
    return [{ what: value.startsWith("#") ? `#${registryId(value.slice(1))}` : registryId(value), count: multiplier }];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => ingredients(entry, multiplier));
  if (!isObject(value)) return [];
  const count = multiplier * (typeof value.count === "number" ? value.count : typeof value.amount === "number" ? value.amount : 1);
  for (const key of ["item", "tag", "fluid", "gas", "infuse_type", "pigment", "slurry", "chemical", "id"]) {
    if (typeof value[key] === "string") {
      const id = registryId(value[key]);
      return [{ what: key === "tag" ? `#${id}` : id, count }];
    }
    if (value[key] && typeof value[key] === "object") return ingredients(value[key], count);
  }
  return ["ingredient", "base_ingredient", "value", "items", "children"].flatMap((key) =>
    value[key] === undefined ? [] : ingredients(value[key], count));
}

/** Unknown config/tag conditions remain unknown, rather than rejecting valid pack recipes. */
export function conditionAllows(condition: unknown, mods: Set<string>): boolean | undefined {
  if (Array.isArray(condition)) {
    const values = condition.map((value) => conditionAllows(value, mods));
    return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
  }
  if (!isObject(condition)) return undefined;
  const type = String(condition.type ?? condition.condition ?? "");
  if (/(?:mod_loaded|modloaded|mod_present)$/.test(type)) {
    const mod = condition.modid ?? condition.mod_id ?? condition.mod;
    return typeof mod === "string" ? mods.has(mod) : undefined;
  }
  if (type.endsWith(":not")) {
    const value = conditionAllows(condition.value ?? condition.term, mods);
    return value === undefined ? undefined : !value;
  }
  if (type.endsWith(":and")) return conditionAllows(condition.values ?? condition.terms, mods);
  if (type.endsWith(":or")) {
    const terms = condition.values ?? condition.terms;
    if (!Array.isArray(terms)) return undefined;
    const values = terms.map((value: unknown) => conditionAllows(value, mods));
    return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
  }
  if (type.endsWith(":true")) return true;
  if (type.endsWith(":false")) return false;
  return undefined;
}

export function summarizeRecipe(id: string, recipe: Json): RecipeSummary {
  if (typeof recipe.type !== "string") throw new Error("Recipe missing type");
  const type = recipe.type;
  const inputs: RecipeIngredient[] = [];
  const outputs: RecipeIngredient[] = [];
  const notes: string[] = [];
  let pattern: (string | null)[][] | null = null;
  const gridKey = recipe.key;
  if (isObject(gridKey) && Array.isArray(recipe.pattern) && recipe.pattern.every((row: unknown) => typeof row === "string")) {
    pattern = recipe.pattern.map((row: string) => [...row].map((symbol) => {
      if (symbol === " ") return null;
      const choices = ingredients(gridKey[symbol]);
      inputs.push(...choices);
      if (choices.length > 1) notes.push(`grid ${symbol} alternatives: ${choices.map((choice) => choice.what).join(" or ")}`);
      return choices[0]?.what ?? null;
    }));
  }
  for (const [key, value] of Object.entries(recipe)) {
    if (/output|result/i.test(key) || ["secondaries", "slag", "stripped"].includes(key)) {
      outputs.push(...ingredients(value, key === "result" && typeof value === "string" && typeof recipe.count === "number" ? recipe.count : 1));
      if (key === "secondaryOutput" && recipe.secondaryChance !== undefined) notes.push(`secondary chance ${recipe.secondaryChance}`);
    } else if (/input|ingredient/i.test(key) || ["base", "addition", "template", "additives", "sapling", "start_item", "activation_item", "primary", "secondary", "materials", "photograph", "film", "source", "item_to_use"].includes(key)) {
      inputs.push(...ingredients(value));
    } else if (key === "pattern" && !pattern && Array.isArray(value)) {
      inputs.push(...ingredients(value));
    } else if (["catalyst", "mold", "tool", "soil"].includes(key)) {
      const required = ingredients(value);
      inputs.push(...required);
      notes.push(`${key}: ${required.length ? required.map((part) => part.what).join(" or ") : JSON.stringify(value)}`);
    } else if (key === "fluid") {
      // IE fermenters/squeezers emit fluid; bottlers/mixers/refineries consume it.
      (/:(fermenter|squeezer)$/.test(type) ? outputs : inputs).push(...ingredients(value));
    } else if (["time", "cookingtime", "crushing_time", "duration", "energy", "energyRequired", "aura", "temperature", "tempKelvin", "burnTime", "creosote", "growthModifier", "pentacle_id", "ritual_type", "entity", "entity_to_summon", "entity_to_sacrifice", "weight", "bonus_chance"].includes(key)) {
      notes.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
  }
  if (recipe.sequence) notes.push(`sequence (${recipe.loops ?? 1} loops): ${JSON.stringify(recipe.sequence)}`);
  if (recipe.conditions || recipe.global_conditions) notes.push("config/tag conditions may apply");
  const raw = JSON.stringify(recipe);
  if (raw.includes('"nbt"')) notes.push("NBT restrictions apply");
  if (raw.includes('"chance"')) notes.push("probabilistic outputs; listed counts are per successful roll");
  if (type.endsWith(":rotary")) notes.push("reversible conversion; inputs/outputs list both directions");
  // The summary contract has no OR node; preserve alternatives for reverse lookup and label them.
  if (Array.isArray(recipe.ingredient) || Object.entries(recipe).some(([key, value]) =>
    (/input$/i.test(key) && Array.isArray(value)) || (Array.isArray(value) && value.some(Array.isArray)))) {
    notes.push("ingredient alternatives are listed together, not all required");
  }
  if (!outputs.length) notes.push("no static item/fluid output (dynamic or effect recipe)");
  return { id, type, inputs: merge(inputs), outputs: merge(outputs), pattern, note: notes.length ? [...new Set(notes)].join("; ") : null };
}

export function plainText(text: string): string {
  return text.replace(/\$\((?:br|br2|p)\)/g, " ").replace(/\$\([^)]*\)/g, "")
    .replace(/§[0-9a-fk-or]/gi, "").replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#~]/g, "")
    .replace(/\\([\\[\]*_])/g, "$1").replace(/\s+/g, " ").trim();
}

export async function buildKnowledge(jarPaths: string[], modDirs: string[], output: string): Promise<void> {
  const jars = new Set(jarPaths.map((path) => resolve(path)));
  for (const dir of modDirs) {
    for (const file of (await readdir(dir)).sort()) if (file.endsWith(".jar")) jars.add(resolve(dir, file));
  }
  if (!jars.size) throw new Error("No input jars; pass --jar or --mods");
  await mkdir(dirname(resolve(output)), { recursive: true });
  const temp = `${output}.building-${process.pid}`;
  const db = new Database(temp, { create: true, strict: true });
  const skipped: Counts = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const mods = new Set(["minecraft", "forge"]);
  const tags = new Map<string, string[]>();
  try {
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE lang(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE recipes(id TEXT PRIMARY KEY, type TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE recipe_inputs(recipe TEXT NOT NULL, what TEXT NOT NULL, PRIMARY KEY(recipe,what));
      CREATE TABLE recipe_outputs(recipe TEXT NOT NULL, what TEXT NOT NULL, PRIMARY KEY(recipe,what));
      CREATE TABLE tag_items(tag TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(tag,item));
      CREATE VIRTUAL TABLE guides USING fts5(book UNINDEXED, title, text, tokenize='unicode61');`);
    const itemInsert = db.query("INSERT INTO items VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=coalesce(excluded.name,items.name)");
    const langInsert = db.query("INSERT OR REPLACE INTO lang VALUES (?,?)");
    const langGet = db.query<{ value: string }, [string]>("SELECT value FROM lang WHERE key=?");
    const translate = (value: unknown): string => {
      if (typeof value === "string") {
        const row = langGet.get(value);
        return row && typeof row.value === "string" ? row.value : value;
      }
      if (Array.isArray(value)) return value.map(translate).join(" ");
      if (isObject(value)) return translate(value.translate ?? value.text ?? "") + (value.extra ? ` ${translate(value.extra)}` : "");
      return "";
    };
    // First discover every mod id, including multi-mod Forge jars, before checking compat recipes.
    for (const jar of jars) {
      const files = unzipSync(new Uint8Array(await Bun.file(jar).arrayBuffer()), { filter: (entry) =>
        /^(META-INF\/(?:mods|neoforge\.mods)\.toml|fabric\.mod\.json|assets\/[^/]+\/lang\/en_us\.json)$/.test(entry.name) });
      db.transaction(() => {
        for (const [path, bytes] of Object.entries(files)) {
          const text = strFromU8(bytes);
          if (path.endsWith(".toml")) {
            for (const match of text.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)) mods.add(match[1]!);
          } else {
            try {
              const data: unknown = JSON.parse(text);
              if (!isObject(data)) throw new Error("Expected metadata/language object");
              if (path === "fabric.mod.json") { if (typeof data.id === "string") mods.add(data.id); continue; }
              for (const [key, value] of Object.entries(data)) {
                if (typeof value !== "string") continue;
                langInsert.run(key, value);
                const match = /^(?:item|block)\.([^.]+)\.(.+)$/.exec(key);
                if (match) itemInsert.run(`${match[1]}:${match[2]}`, plainText(value));
              }
            } catch { skip("invalid metadata/language JSON"); }
          }
        }
      })();
    }
    const recipeInsert = db.query("INSERT OR REPLACE INTO recipes VALUES (?,?,?)");
    const inInsert = db.query("INSERT OR IGNORE INTO recipe_inputs VALUES (?,?)");
    const outInsert = db.query("INSERT OR IGNORE INTO recipe_outputs VALUES (?,?)");
    const guideInsert = db.query("INSERT INTO guides(book,title,text) VALUES (?,?,?)");
    const addRecipe = (id: string, recipe: unknown): void => {
      if (!isObject(recipe)) { skip("invalid recipe object"); return; }
      if (conditionAllows(recipe.conditions ?? [], mods) === false || conditionAllows(recipe.global_conditions ?? [], mods) === false) { skip("condition false/missing mod"); return; }
      if (recipe.type === "forge:conditional") {
        let selected = false;
        for (const branch of Array.isArray(recipe.recipes) ? recipe.recipes : []) {
          if (!isObject(branch) || conditionAllows(branch.conditions ?? [], mods) === false) continue;
          addRecipe(id, branch.recipe); selected = true; break;
        }
        if (!selected) skip("conditional recipe without eligible branch");
        return;
      }
      if (isObject(recipe.baseRecipe)) { addRecipe(id, { ...recipe.baseRecipe, type: recipe.type }); return; }
      if (typeof recipe.type !== "string") { skip("recipe missing type"); return; }
      const summary = summarizeRecipe(id, recipe);
      // Replaced resources must not retain the previous jar's input/output index rows.
      db.query("DELETE FROM recipe_inputs WHERE recipe=?").run(id);
      db.query("DELETE FROM recipe_outputs WHERE recipe=?").run(id);
      recipeInsert.run(id, summary.type, JSON.stringify(summary));
      for (const part of summary.inputs) inInsert.run(id, part.what);
      for (const part of summary.outputs) {
        outInsert.run(id, part.what);
        if (!part.what.startsWith("#")) itemInsert.run(part.what, null);
      }
    };
    for (const jar of jars) {
      const files = unzipSync(new Uint8Array(await Bun.file(jar).arrayBuffer()), { filter: (entry) =>
        /^data\/[^/]+\/(recipes|tags\/items)\/.+\.json$/.test(entry.name) ||
        /^(?:data|assets)\/[^/]+\/(?:patchouli_books|modonomicon\/books)\/.+\.json$/.test(entry.name) ||
        /^assets\/immersiveengineering\/manual\/en_us\/.+\.txt$/.test(entry.name) });
      db.transaction(() => {
        for (const [path, bytes] of Object.entries(files)) {
          try {
            const text = strFromU8(bytes);
            let match = /^assets\/immersiveengineering\/manual\/en_us\/(.+)\.txt$/.exec(path);
            if (match) {
              const [title, ...body] = text.split(/\r?\n/);
              for (const page of body.join("\n").split(/<np>/)) {
                const clean = plainText(page);
                if (clean) guideInsert.run("immersiveengineering:manual", plainText(title!), clean);
              }
              continue;
            }
            const data: unknown = JSON.parse(text);
            if (!isObject(data)) throw new Error("Expected resource object");
            match = /^data\/([^/]+)\/recipes\/(.+)\.json$/.exec(path);
            if (match) { addRecipe(`${match[1]}:${match[2]}`, data); continue; }
            match = /^data\/([^/]+)\/tags\/items\/(.+)\.json$/.exec(path);
            if (match) {
              const id = `${match[1]}:${match[2]}`;
              if (!Array.isArray(data.values)) { skip("invalid tag values"); continue; }
              const values: string[] = [];
              for (const entry of data.values) {
                const value = typeof entry === "string" ? entry : isObject(entry) ? entry.id : undefined;
                if (typeof value === "string") values.push(value.startsWith("#") ? `#${registryId(value.slice(1))}` : registryId(value));
              }
              tags.set(id, data.replace ? values : [...(tags.get(id) ?? []), ...values]);
              continue;
            }
            match = /^(?:data|assets)\/([^/]+)\/(?:patchouli_books\/([^/]+)(?:\/en_us)?|modonomicon\/books\/([^/]+))\/entries\/(.+)\.json$/.exec(path);
            if (!match) continue;
            const book = `${match[1]}:${match[2] ?? match[3]}`;
            const title = plainText(translate(data.name ?? data.title ?? match[4]));
            for (const page of Array.isArray(data.pages) ? data.pages : []) {
              if (!isObject(page)) { skip("invalid guide page"); continue; }
              const fragments = Object.entries(page).filter(([key]) => /^(text\d*|title\d*|description|caption)$/.test(key))
                .map(([, value]) => translate(value));
              const clean = plainText(fragments.join(" "));
              if (clean) guideInsert.run(book, title, clean);
            }
          } catch { skip(`invalid ${path.includes("/recipes/") ? "recipe" : path.includes("/tags/") ? "tag" : "guide"} file`); }
        }
      })();
    }
    const tagInsert = db.query("INSERT OR IGNORE INTO tag_items VALUES (?,?)");
    // Walk per root, rather than caching incomplete cycle results from a recursive DFS.
    db.transaction(() => {
      for (const root of tags.keys()) {
        const seen = new Set<string>();
        const pending = [root];
        while (pending.length) {
          const current = pending.pop()!;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const value of tags.get(current) ?? []) {
            if (value.startsWith("#")) pending.push(value.slice(1));
            else tagInsert.run(root, value);
          }
        }
      }
    })();
    db.exec(`CREATE INDEX input_what ON recipe_inputs(what,recipe);
      CREATE INDEX output_what ON recipe_outputs(what,recipe);
      CREATE INDEX tag_item ON tag_items(item,tag);
      DROP TABLE lang; INSERT INTO guides(guides) VALUES('optimize'); PRAGMA optimize; VACUUM;`);
    console.log(`Jars: ${jars.size}; detected mods: ${mods.size}`);
    for (const table of ["items", "recipes", "guides"]) {
      const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get();
      console.log(`${table}: ${row?.n}`);
    }
    const memberships = db.query<{ n: number }, []>("SELECT count(*) AS n FROM tag_items").get();
    console.log(`tags: ${tags.size}; resolved memberships: ${memberships?.n}`);
    console.log("Top recipe types:", db.query("SELECT type, count(*) AS count FROM recipes GROUP BY type ORDER BY count DESC LIMIT 15").all());
    console.log("Guide pages per book:", db.query("SELECT book, count(*) AS count FROM guides GROUP BY book ORDER BY book").all());
    console.log("Skipped files/branches by reason:", skipped);
    const dynamic = db.query<{ n: number }, []>("SELECT count(*) AS n FROM recipes WHERE id NOT IN (SELECT recipe FROM recipe_outputs)").get();
    console.log(`Recipes without static outputs: ${dynamic?.n}`);
    db.close();
    await rename(temp, output);
  } catch (error) {
    db.close();
    await rm(temp, { force: true });
    throw error;
  }
}
