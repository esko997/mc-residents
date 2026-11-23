import { Database } from "bun:sqlite";
import type { GuideHit, ItemHit, Knowledge, ModFacts, RecipeSummary } from "./types";

function boundedLimit(limit: number | undefined, fallback: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(500, Math.trunc(limit!))) : fallback;
}

export function openKnowledge(dbPath: string): Knowledge {
  const db = new Database(dbPath, { readonly: true, strict: true });
  const recipes = (sql: string, item: string, limit?: number): RecipeSummary[] =>
    (db.query(sql).all(item, boundedLimit(limit, 12)) as { summary: string }[])
      .map((row) => JSON.parse(row.summary) as RecipeSummary);
  const typeOrder = `CASE r.type
    WHEN 'minecraft:crafting_shaped' THEN 0
    WHEN 'minecraft:crafting_shapeless' THEN 1
    WHEN 'minecraft:smelting' THEN 2
    WHEN 'minecraft:blasting' THEN 3
    WHEN 'minecraft:smoking' THEN 4
    WHEN 'minecraft:campfire_cooking' THEN 5
    WHEN 'minecraft:stonecutting' THEN 6
    ELSE CASE WHEN r.type GLOB 'minecraft:smithing_*' THEN 7 ELSE 8 END
    END, r.type, r.id`;
  return {
    findItems(query, limit) {
      const text = query.trim();
      if (!text) return [];
      return db.query(`SELECT id, name FROM items
        WHERE instr(lower(id), lower(?1)) > 0 OR instr(lower(coalesce(name, '')), lower(?1)) > 0
        ORDER BY CASE WHEN lower(id) = lower(?1) OR lower(name) = lower(?1) THEN 0 ELSE 1 END,
          length(coalesce(name, id)), id LIMIT ?2`)
        .all(text, boundedLimit(limit, 20)) as ItemHit[];
    },
    recipesFor(itemId, limit) {
      return recipes(`SELECT r.summary FROM recipes r WHERE r.id IN (
        SELECT recipe FROM recipe_outputs WHERE what = ?1
        UNION SELECT o.recipe FROM recipe_outputs o JOIN tag_items t ON o.what = '#' || t.tag WHERE t.item = ?1
      ) ORDER BY NOT EXISTS (
        SELECT 1 FROM recipe_outputs o WHERE o.recipe = r.id AND o.what = ?1
      ), ${typeOrder} LIMIT ?2`, itemId, limit);
    },
    usesOf(itemId, limit) {
      return recipes(`SELECT r.summary FROM recipes r WHERE r.id IN (
        SELECT recipe FROM recipe_inputs WHERE what = ?1
        UNION SELECT i.recipe FROM recipe_inputs i JOIN tag_items t ON i.what = '#' || t.tag WHERE t.item = ?1
      ) ORDER BY NOT EXISTS (
        SELECT 1 FROM recipe_inputs i WHERE i.recipe = r.id AND i.what = ?1
      ), ${typeOrder} LIMIT ?2`, itemId, limit);
    },
    itemsInTag(tag, limit) {
      return (db.query("SELECT item FROM tag_items WHERE tag = ? ORDER BY item LIMIT ?")
        .all(tag.replace(/^#/, ""), boundedLimit(limit, 100)) as { item: string }[]).map((row) => row.item);
    },
    searchGuides(query, limit) {
      // Treat user text as words, not FTS syntax (quotes and operators otherwise throw).
      const words = query.match(/[\p{L}\p{N}_]+/gu);
      if (!words?.length) return [];
      const match = words.map((word) => `"${word}"`).join(" AND ");
      return db.query(`SELECT book || ' / ' || title AS "where",
        substr(snippet(guides, 2, '', '', ' … ', 42), 1, 360) AS excerpt FROM guides
        WHERE guides MATCH ? ORDER BY rank LIMIT ?`)
        .all(match, boundedLimit(limit, 8)) as GuideHit[];
    },
    blockDrops(blockId) {
      try {
        return (db.query("SELECT item FROM block_drops WHERE block = ? ORDER BY item").all(blockId) as { item: string }[]).map((row) => row.item);
      } catch { return undefined; } // An export built before loot tables were indexed.
    },
    // Exports built before the pack overview have no mods tables: answer undefined, as blockDrops does.
    modList() {
      try {
        return (db.query("SELECT facts FROM mods ORDER BY lower(name), id").all() as { facts: string }[]).map((row) => JSON.parse(row.facts) as ModFacts);
      } catch { return undefined; }
    },
    modOf(itemId) {
      try {
        return db.query<{ id: string; name: string }, [string]>(`SELECT m.id AS id, m.name AS name FROM namespaces n JOIN mods m ON m.id = n.mod
          WHERE n.namespace = substr(?1, 1, instr(?1, ':') - 1)`).get(itemId) ?? undefined;
      } catch { return undefined; }
    },
    modItems(mod, words, offset, limit) {
      // Every word must appear in the display name or the id, as in JEI's search box.
      const terms = words.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      const where = terms.map((_, i) => `AND (instr(lower(coalesce(i.name, '')), ?${i + 2}) > 0 OR instr(lower(r.id), ?${i + 2}) > 0)`).join(" ");
      const from = `FROM registered r JOIN items i ON i.id = r.id WHERE r.mod = ?1 ${where}`;
      const total = db.query<{ n: number }, string[]>(`SELECT count(*) AS n ${from}`).get(mod, ...terms)?.n ?? 0;
      // Both bounds are whole numbers here, so they go into the statement text.
      const items = db.query<ItemHit & { kind: string }, string[]>(`SELECT r.id AS id, i.name AS name, r.kind AS kind ${from}
        ORDER BY lower(coalesce(i.name, r.id)), r.id LIMIT ${boundedLimit(limit, 20)} OFFSET ${Math.max(0, Math.trunc(offset) || 0)}`).all(mod, ...terms);
      return { items, total };
    },
    advancement(id) {
      try {
        const row = db.query<{ title: string; description: string; items: string }, [string]>("SELECT title, description, items FROM advancements WHERE id = ?").get(id);
        return row ? { title: row.title, description: row.description, items: JSON.parse(row.items) as string[] } : undefined;
      } catch { return undefined; }
    },
    close() { db.close(); },
  };
}
