import { Database } from "bun:sqlite";
import { z } from "zod";

export const wikiDefinition = {
  description: "Look up the vanilla Minecraft Wiki. It documents the newest game version, but this world runs 1.20.1, so newer blocks, items and mechanics may not exist here. It is written for keyboard and mouse: right-click means use, left-click means attack, and the inventory key means open_inventory. For anything from a mod use guide and recipes instead. Call with a page name or topic, then call again with section to read one section.",
  schema: z.object({
    query: z.string().min(1).max(120),
    section: z.string().optional(),
  }),
};

export type WikiArgs = z.infer<typeof wikiDefinition.schema>;
export interface Wiki { lookup(args: WikiArgs): Promise<string> }
type WikiPage = { title: string; extract: string };
type PageChoice = { title: string; others: string[] };
type CacheRow = { value: string; expires: number };
type Section = { name: string; level: number; start: number; bodyStart: number; end: number };

export interface WikiOptions {
  fetch?: typeof fetch;
  cachePath?: string;
  now?: () => number;
  timeoutMs?: number;
}

const API = "https://minecraft.wiki/api.php";
const USER_AGENT = "minecraft-residents/1.0 (private family server; low volume)";
const NETWORK_ERROR = "The wiki could not be reached; try again later.";
const SEARCH_TTL = 24 * 60 * 60 * 1000;
const PAGE_TTL = 30 * SEARCH_TTL;
const MAX_OUTPUT = 1300;
const MORE = "More text exists.";
const spinOffTitle = /^(?:Minecraft Dungeons|Minecraft Legends|Minecraft Earth)| Update$/i;
const versionTitle = /^(?:(?:beta|alpha)\s+)?(?:\d+\.)+\d+[a-z0-9-]*$|^\d{2}w\d{2}[a-z]$/i;
const disambiguatedTitle = /\([^)]*\bEdition\b[^)]*\)/i;
const fillerWords: Record<string, true> = {
  how: true, do: true, does: true, i: true, to: true, a: true, an: true, the: true,
  make: true, get: true, find: true, what: true, is: true, are: true, can: true, you: true,
  my: true, of: true, in: true, for: true, with: true, use: true,
};
const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", thinsp: " ", ensp: " ", emsp: " ", middot: "·", times: "×", trade: "™",
};

function isExcludedTitle(title: string): boolean {
  const trimmed = title.trim();
  return spinOffTitle.test(trimmed) || /\bPatch\b/i.test(trimmed) || versionTitle.test(trimmed)
    || (/\bEdition\b/i.test(trimmed) && !/^(?:Java|Bedrock) Edition$/i.test(trimmed) && !disambiguatedTitle.test(trimmed));
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const value = Number.parseInt(code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1), code[1]?.toLowerCase() === "x" ? 16 : 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }
    return entities[code.toLowerCase()] ?? entity;
  });
}

function cacheKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function finished(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function shorten(text: string, maximum: number, rowBoundaries = false): string {
  const clean = text.trim();
  if (clean.length <= maximum) return clean;
  if (maximum <= MORE.length + 1) return MORE.slice(0, maximum);
  const budget = maximum - MORE.length - 1;
  const prefix = clean.slice(0, budget);
  if (rowBoundaries) {
    const rowEnd = prefix.lastIndexOf("\n");
    if (rowEnd > 0) return `${prefix.slice(0, rowEnd).trimEnd()}\n${MORE}`;
  }
  let cut = 0;
  for (const match of prefix.matchAll(/[.!?](?=\s|$)/g)) cut = match.index + 1;
  let body: string;
  if (cut > 0) body = prefix.slice(0, cut).trimEnd();
  else {
    const word = prefix.lastIndexOf(" ");
    body = finished(prefix.slice(0, word > 0 ? word : budget).trimEnd().replace(/[;:,]+$/, ""));
  }
  return `${body}\n${MORE}`;
}

function compose(title: string, body: string, footers: string[], rowBoundaries = false): string {
  const footer = footers.filter(Boolean).join("\n");
  const full = `${title}\n${body}${body && footer ? "\n" : ""}${footer}`;
  if (full.length <= MAX_OUTPUT) return finished(full);
  // Keep the section index visible when an article has a long introduction.
  if (footer && footer.length < MAX_OUTPUT / 2 && body) {
    const budget = MAX_OUTPUT - title.length - footer.length - 2;
    if (budget > MORE.length + 20) {
      return finished(`${title}\n${shorten(body, budget, rowBoundaries)}\n${footer}`);
    }
  }
  return shorten(full, MAX_OUTPUT, rowBoundaries);
}

function parseSections(extract: string): { intro: string; sections: Section[] } {
  const headings = [...extract.matchAll(/^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm)].map(match => ({
    name: match[2].trim(),
    level: match[1].length,
    start: match.index,
    bodyStart: match.index + match[0].length,
  }));
  const sections = headings.map((heading, index) => {
    let end = extract.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) { end = headings[next].start; break; }
    }
    return { ...heading, end };
  });
  return { intro: extract.slice(0, headings[0]?.start ?? extract.length).trim(), sections };
}

function sectionText(extract: string, section: Section): string {
  return extract.slice(section.bodyStart, section.end)
    .replace(/^={2,6}[ \t]*(.+?)[ \t]*={2,6}[ \t]*$/gm, "$1")
    .trim();
}

function renderedText(html: string): string {
  const lines: string[] = [];
  let outside = "";
  let cell: string | undefined;
  let cells: string[] = [];
  let cellIcons: string[] = [];
  let tableDepth = 0;
  let skipDepth = 0;
  let position = 0;
  const links: { title: string; start: number; inCell: boolean }[] = [];

  function attribute(tag: string, name: string): string {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
  }
  function append(text: string): void {
    if (cell !== undefined) cell += text;
    else if (tableDepth === 0) outside += text;
  }
  function flush(): void {
    const text = outside.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    outside = "";
  }
  function closeCell(): void {
    if (cell === undefined) return;
    const text = cell.replace(/\s+/g, " ").trim().replace(/^(?:;\s*)+|(?:;\s*)+$/g, "");
    cells.push(text || [...new Set(cellIcons)].join("; "));
    cell = undefined;
    cellIcons = [];
  }

  for (const token of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>/g)) {
    if (!skipDepth) append(decodeEntities(html.slice(position, token.index)));
    position = token.index + token[0].length;
    const tag = token[0];
    if (tag.startsWith("<!")) continue;
    const name = /^<\/?\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = /^<\//.test(tag);
    const voidTag = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) || /\/>$/.test(tag);
    if (skipDepth) {
      if (closing) skipDepth--;
      else if (!voidTag) skipDepth++;
      continue;
    }
    if (!closing && (/^(?:script|style|h[1-6])$/.test(name)
      || /(?:^|\s)(?:reference|mw-editsection)(?:\s|$)/.test(attribute(tag, "class")))) {
      if (!voidTag) skipDepth = 1;
      continue;
    }
    if (name === "table") {
      if (closing) tableDepth--;
      else { flush(); tableDepth++; }
    } else if (name === "tr" && tableDepth > 0) {
      if (closing) {
        closeCell();
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
        cells = [];
      }
    } else if ((name === "td" || name === "th") && tableDepth > 0) {
      if (closing) closeCell();
      else { closeCell(); cell = ""; }
    } else if (name === "a") {
      if (!closing) links.push({ title: attribute(tag, "title"), start: (cell ?? outside).length, inCell: cell !== undefined });
      else {
        const link = links.pop();
        if (link?.title && link.inCell && cell !== undefined && cell.length === link.start) cellIcons.push(link.title);
      }
    } else if (name === "img" && !closing) {
      const icon = attribute(tag, "alt") || attribute(tag, "title");
      if (icon && cell !== undefined) cellIcons.push(icon);
    } else if (name === "li" && cell !== undefined) {
      if (cell.trim() && !cell.trimEnd().endsWith(";")) cell += "; ";
    } else if (/^(?:p|div|li|br|hr|figure|figcaption)$/.test(name)) {
      if (cell !== undefined) cell += " ";
      else flush();
    }
  }
  if (!skipDepth) append(decodeEntities(html.slice(position)));
  flush();
  return lines.join("\n").replace(/\[edit(?:\s+source)?\]|\[\d+\]/gi, "").trim();
}

const listingNoise = /^(history|development|issues|gallery|screenshots|renders|videos|trivia|sounds|data values|id|statistics|other|achievements|advancements|in other media|see also|references|navigation|external links|.* edition|.* graphics pack|.* combat tests)$/i;

export function createWiki(options: WikiOptions = {}): Wiki {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8000;
  const db = options.cachePath ? new Database(options.cachePath, { create: true, strict: true }) : undefined;
  db?.exec("CREATE TABLE IF NOT EXISTS wiki_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
  let queue: Promise<void> = Promise.resolve();

  function readCache<T>(key: string): T | undefined {
    if (!db) return undefined;
    const row = db.query("SELECT value, expires FROM wiki_cache WHERE key = ?").get(key) as CacheRow | null;
    if (!row) return undefined;
    if (row.expires <= now()) {
      db.query("DELETE FROM wiki_cache WHERE key = ?").run(key);
      return undefined;
    }
    try { return JSON.parse(row.value) as T; }
    catch {
      db.query("DELETE FROM wiki_cache WHERE key = ?").run(key);
      return undefined;
    }
  }

  function writeCache(key: string, value: unknown, ttl: number): void {
    db?.query("INSERT OR REPLACE INTO wiki_cache (key, value, expires) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), now() + ttl);
  }

  async function request(parameters: Record<string, string>): Promise<unknown> {
    const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...parameters })}`;
    const controller = new AbortController();
    const timeout = Promise.withResolvers<never>();
    const operation = (async () => {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Wiki HTTP ${response.status}`);
      return await response.json();
    })();
    const timer = setTimeout(() => {
      controller.abort();
      timeout.reject(new Error("Wiki request timed out"));
    }, timeoutMs);
    try {
      return await Promise.race([operation, timeout.promise]);
    } catch {
      throw new Error(NETWORK_ERROR);
    } finally {
      clearTimeout(timer);
    }
  }

  async function exactTitle(query: string): Promise<string | undefined> {
    const key = `resolve:${cacheKey(query)}`;
    const cached = readCache<string | null>(key);
    if (cached !== undefined) return cached && !isExcludedTitle(cached) && !disambiguatedTitle.test(cached) ? cached : undefined;
    const data = await request({ action: "query", titles: query, redirects: "1" }) as {
      query?: { pages?: { title?: string; missing?: boolean }[] };
    };
    const title = data.query?.pages?.[0]?.title;
    const valid = typeof title === "string" && !data.query?.pages?.[0]?.missing && !isExcludedTitle(title) && !disambiguatedTitle.test(title);
    const resolved = valid ? title : null;
    writeCache(key, resolved, SEARCH_TTL);
    return resolved ?? undefined;
  }

  async function search(query: string, inTitle: boolean): Promise<PageChoice | undefined> {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return undefined;
    const srsearch = inTitle ? words.map(word => `intitle:${word}`).join(" ") : query;
    const key = `search:${inTitle ? "title" : "plain"}:${cacheKey(query)}`;
    let titles = readCache<string[]>(key);
    if (titles === undefined) {
      const data = await request({
        action: "query", list: "search", srsearch, srnamespace: "0", srlimit: "10",
      }) as { query?: { search?: { title?: string }[] } };
      titles = (data.query?.search ?? []).map(hit => hit.title)
        .filter((title): title is string => typeof title === "string");
      writeCache(key, titles, SEARCH_TTL);
    }
    titles = titles.filter(title => !isExcludedTitle(title));
    titles = [...titles.filter(title => !disambiguatedTitle.test(title)), ...titles.filter(title => disambiguatedTitle.test(title))];
    if (!titles.length || disambiguatedTitle.test(titles[0])) return undefined;
    return { title: titles[0], others: titles.slice(1, 5) };
  }

  async function findPage(query: string): Promise<PageChoice | undefined> {
    const exact = await exactTitle(query);
    if (exact) return { title: exact, others: [] };
    const words = (query.match(/[\p{L}\p{N}_'-]+/gu) ?? []).filter(word => !fillerWords[word.toLowerCase()]);
    const phrase = words.join(" ");
    const attempts = new Set([phrase, ...words]);
    const seenTitles = new Set<string>();
    const titles: string[] = [];
    for (const attempt of attempts) {
      if (!attempt || cacheKey(attempt) === cacheKey(query)) continue;
      const title = await exactTitle(attempt);
      if (title && !seenTitles.has(cacheKey(title))) {
        seenTitles.add(cacheKey(title));
        titles.push(title);
      }
    }
    if (titles.length) return { title: titles[0], others: titles.slice(1, 5) };
    return await search(phrase || query, true) ?? await search(phrase || query, false);
  }

  async function fetchPage(title: string): Promise<WikiPage | undefined> {
    const key = `page:${cacheKey(title)}`;
    const cached = readCache<WikiPage>(key);
    if (cached !== undefined) return cached;
    const data = await request({
      action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki",
      redirects: "1", titles: title,
    }) as { query?: { pages?: { title?: string; extract?: string; missing?: boolean }[] } };
    const page = data.query?.pages?.[0];
    if (!page || page.missing || typeof page.title !== "string" || typeof page.extract !== "string" || isExcludedTitle(page.title)) {
      return undefined;
    }
    const result = { title: page.title, extract: page.extract };
    writeCache(key, result, PAGE_TTL);
    return result;
  }

  async function fetchRenderedSection(title: string, name: string): Promise<string | undefined> {
    const key = `rendered:${cacheKey(title)}:${cacheKey(name)}`;
    const cached = readCache<string>(key);
    if (cached !== undefined) return cached;
    const metadata = await request({ action: "parse", page: title, prop: "sections" }) as {
      parse?: { sections?: { index: string; line: string }[] };
    };
    const section = metadata.parse?.sections?.find(candidate =>
      decodeEntities(candidate.line.replace(/<[^>]*>/g, "")).trim().toLowerCase() === name.toLowerCase());
    if (!section) return undefined;
    const data = await request({
      action: "parse", page: title, section: section.index, prop: "text", disabletoc: "1",
    }) as { parse?: { text?: string } };
    if (typeof data.parse?.text !== "string") return undefined;
    const text = renderedText(data.parse.text);
    writeCache(key, text, PAGE_TTL);
    return text;
  }

  async function performLookup(args: WikiArgs): Promise<string> {
    const choice = await findPage(args.query.trim());
    if (!choice) return `No vanilla Minecraft wiki page found for "${args.query.trim()}".`;
    const page = await fetchPage(choice.title);
    if (!page) return `No vanilla Minecraft wiki page found for "${args.query.trim()}".`;
    const others = choice.others.length ? `Other pages: ${choice.others.join("; ")}.` : "";
    const extract = page.extract.replace(/\[edit(?:\s+source)?\]/gi, "");
    const { intro, sections } = parseSections(extract);
    // The list is for choosing what to read next; changelog, media and data-table
    // sections are most of a page's headings and none of its gameplay. They can
    // still be read by name.
    const listed = sections.filter(section => !listingNoise.test(section.name));
    const availableSections = listed.length ? `Sections: ${listed.map(section => section.name).join("; ")}.` : "No named sections.";
    const requested = args.section?.trim();
    if (!requested) return compose(page.title, intro, [availableSections, others]);

    const wanted = requested.toLowerCase();
    const exact = sections.find(section => section.name.toLowerCase() === wanted);
    const prefixed = sections.filter(section => section.name.toLowerCase().startsWith(wanted));
    const selected = exact ?? (prefixed.length === 1 ? prefixed[0] : undefined);
    if (!selected) {
      const problem = prefixed.length > 1
        ? `Section "${requested}" is ambiguous in ${page.title}.`
        : `No section "${requested}" in ${page.title}.`;
      return compose(problem, "", [availableSections, others]);
    }
    let body = sectionText(extract, selected);
    let rowBoundaries = false;
    if (body.length < 80) {
      const rendered = await fetchRenderedSection(page.title, selected.name);
      if (rendered !== undefined) { body = rendered; rowBoundaries = true; }
    }
    return compose(`${page.title}: ${selected.name}`, body || "This section has no text.", [others], rowBoundaries);
  }

  function lookup(rawArgs: WikiArgs): Promise<string> {
    const args = wikiDefinition.schema.parse(rawArgs);
    const result = queue.then(() => performLookup(args));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { lookup };
}
