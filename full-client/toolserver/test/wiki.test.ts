import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWiki } from "../src/wiki.ts";

type Route = { match: (url: URL) => boolean; body: unknown };
const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function mockFetch(routes: Route[]) {
  const calls: URL[] = [];
  const implementation = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push(url);
    const route = routes.find(candidate => candidate.match(url));
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return Response.json(route.body);
  }) as typeof fetch;
  return { implementation, calls };
}

function titlePage(title: string, missing = false) {
  return { query: { pages: [{ title, ...(missing ? { missing: true } : { pageid: 1 }) }] } };
}

function extractPage(title: string, extract: string) {
  return { query: { pages: [{ title, pageid: 1, extract }] } };
}

function searchResults(...titles: string[]) {
  return { query: { search: titles.map(title => ({ title })) } };
}

function exactRoute(query: string, body: unknown): Route {
  return {
    match: url => url.searchParams.get("action") === "query"
      && !url.searchParams.has("prop") && url.searchParams.get("titles") === query,
    body,
  };
}

function extractRoute(title: string, extract: string): Route {
  return {
    match: url => url.searchParams.get("prop") === "extracts" && url.searchParams.get("titles") === title,
    body: extractPage(title, extract),
  };
}

function searchRoute(srsearch: string, body: unknown): Route {
  return {
    match: url => url.searchParams.get("list") === "search" && url.searchParams.get("srsearch") === srsearch,
    body,
  };
}

function parseRoute(title: string, prop: string, body: unknown, section?: string): Route {
  return {
    match: url => url.searchParams.get("action") === "parse" && url.searchParams.get("page") === title
      && url.searchParams.get("prop") === prop && (section === undefined || url.searchParams.get("section") === section),
    body,
  };
}

async function cachePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "resident-wiki-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "cache.sqlite");
}

describe("Minecraft Wiki lookup", () => {
  test("an exact title returns its intro and section names", async () => {
    const mock = mockFetch([
      exactRoute("Breeding", titlePage("Breeding")),
      extractRoute("Breeding", "Breeding[edit] is a game mechanic.\n\n== Baby animals ==\nBabies follow adults.\n== Food ==\nFood starts breeding."),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "Breeding" });

    expect(result).toBe("Breeding\nBreeding is a game mechanic.\nSections: Baby animals; Food.");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].searchParams.get("redirects")).toBe("1");
  });

  test("search fallback excludes edition, patch, version and spin-off pages and demotes disambiguations", async () => {
    const mock = mockFetch([
      exactRoute("husbandry", titlePage("husbandry", true)),
      searchRoute("intitle:husbandry", searchResults(
        "Wii U Edition Patch 3", "1.20.1", "23w31a", "Beta 1.8", "Java Edition 13w04a",
        "Minecraft Dungeons Cow", "Achievement (Java Edition)", "Breeding", "Cow", "Villager",
      )),
      extractRoute("Breeding", "Breeding makes baby animals.\n== Food =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "husbandry" });

    expect(result).toStartWith("Breeding\nBreeding makes baby animals.");
    expect(result).toContain("Other pages: Cow; Villager; Achievement (Java Edition).");
    for (const excluded of ["Patch", "1.20.1", "23w31a", "Beta 1.8", "Java Edition 13w04a", "Minecraft Dungeons"]) {
      expect(result).not.toContain(excluded);
    }
    expect(mock.calls).toHaveLength(3);
  });

  test("edition disambiguations alone never become the main search result", async () => {
    const mock = mockFetch([
      exactRoute("husbandry", titlePage("husbandry", true)),
      searchRoute("intitle:husbandry", searchResults("Achievement (Java Edition)")),
      searchRoute("husbandry", searchResults("Breeding")),
      extractRoute("Breeding", "Breeding makes baby animals.\n== Food =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    expect(await wiki.lookup({ query: "husbandry" })).toStartWith("Breeding\nBreeding makes baby animals.");
    expect(mock.calls).toHaveLength(4);
  });

  test("question words are removed and verb and plural redirects find both relevant pages", async () => {
    const mock = mockFetch([
      exactRoute("how do I breed cows", titlePage("how do I breed cows", true)),
      exactRoute("breed cows", titlePage("breed cows", true)),
      exactRoute("breed", titlePage("Breeding")),
      exactRoute("cows", titlePage("Cow")),
      extractRoute("Breeding", "Breeding makes baby animals.\n== Breeding foods =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "how do I breed cows" });

    expect(result).toBe("Breeding\nBreeding makes baby animals.\nSections: Breeding foods.\nOther pages: Cow.");
    expect(mock.calls).toHaveLength(5);
  });

  test("the remaining exact topic beats free-text search for a farmland question", async () => {
    const mock = mockFetch([
      exactRoute("how do I make farmland", titlePage("how do I make farmland", true)),
      exactRoute("farmland", titlePage("Farmland")),
      extractRoute("Farmland", "Farmland is a block.\n== Creation =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    expect(await wiki.lookup({ query: "how do I make farmland" })).toBe("Farmland\nFarmland is a block.\nSections: Creation.");
    expect(mock.calls).toHaveLength(3);
  });

  test("plain search uses the remaining topic when exact and title searches miss", async () => {
    const mock = mockFetch([
      exactRoute("how do I cultivate soil", titlePage("how do I cultivate soil", true)),
      exactRoute("cultivate soil", titlePage("cultivate soil", true)),
      exactRoute("cultivate", titlePage("cultivate", true)),
      exactRoute("soil", titlePage("soil", true)),
      searchRoute("intitle:cultivate intitle:soil", searchResults()),
      searchRoute("cultivate soil", searchResults("Farmland")),
      extractRoute("Farmland", "Farmland is a block.\n== Creation =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    expect(await wiki.lookup({ query: "how do I cultivate soil" })).toContain("Farmland\nFarmland is a block.");
    expect(mock.calls).toHaveLength(7);
  });

  test("section names match case-insensitively and include nested sections", async () => {
    const processText = "Processing text explains that one piece of coal cooks eight items while the furnace continues to burn.";
    const extract = `Intro.\n== Usage ==\nUse text.\n=== Processing items ===\n${processText}\n== History ==\nHistory text.`;
    const mock = mockFetch([
      exactRoute("Furnace", titlePage("Furnace")),
      extractRoute("Furnace", extract),
    ]);
    const wiki = createWiki({ fetch: mock.implementation, cachePath: await cachePath() });

    const result = await wiki.lookup({ query: "Furnace", section: "uSaGe" });

    expect(result).toBe(`Furnace: Usage\nUse text.\nProcessing items\n${processText}`);
    expect(mock.calls).toHaveLength(2);
  });

  test("a unique section prefix reads only that section", async () => {
    const processText = "Processing text explains that one piece of coal cooks eight items while the furnace continues to burn.";
    const extract = `Intro.\n== Usage ==\nUse text.\n=== Processing items ===\n${processText}\n=== Fuel ===\nFuel text.\n== History ==\nHistory text.`;
    const mock = mockFetch([
      exactRoute("Furnace", titlePage("Furnace")),
      extractRoute("Furnace", extract),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "Furnace", section: "process" });

    expect(result).toBe(`Furnace: Processing items\n${processText}`);
  });

  test("an unknown section lists the available section names", async () => {
    const historyText = "This history explains changes to the furnace across many game updates and versions since its introduction.";
    const mock = mockFetch([
      exactRoute("Furnace", titlePage("Furnace")),
      extractRoute("Furnace", `Intro.\n== Usage ==\nUse text.\n=== Processing items ===\nProcess text.\n== History ==\n${historyText}`),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "Furnace", section: "cooking" });

    // History is still readable by name, but the listing keeps to gameplay sections.
    expect(result).toBe("No section \"cooking\" in Furnace.\nSections: Usage; Processing items.");
    expect(await wiki.lookup({ query: "Furnace", section: "History" })).toBe(`Furnace: History\n${historyText}`);
  });

  test("short table extracts use rendered rows, preserve icon names, remove clutter and cache the result", async () => {
    const html = `<h3>Breeding foods</h3><span class="mw-editsection">[edit]</span>
      <script>bad script</script><style>bad style</style>
      <table><tr><th>Mob</th><th>Items</th></tr>
      <tr><td><a title="Cow"><img alt=""></a></td>
      <td><a title="Wheat"><img alt="Wheat"></a><sup class="reference">[1]</sup></td></tr>
      <tr><td>Sheep &amp; Goats</td><td><ul><li>Wheat</li><li>Beetroot&nbsp;Seeds</li></ul></td></tr>
      <tr><td><a title="Horse"><img alt="Horse"></a><a title="Horse">Horse</a></td><td>Golden&#32;Carrot</td></tr></table>`;
    const mock = mockFetch([
      exactRoute("Breeding", titlePage("Breeding")),
      extractRoute("Breeding", "Intro.\n== Breeding foods ==\nTable omitted.\n== History =="),
      parseRoute("Breeding", "sections", { parse: { sections: [{ index: "4", line: "Breeding foods" }] } }),
      parseRoute("Breeding", "text", { parse: { text: html } }, "4"),
    ]);
    const wiki = createWiki({ fetch: mock.implementation, cachePath: await cachePath() });

    const result = await wiki.lookup({ query: "Breeding", section: "Breeding foods" });

    expect(result).toBe("Breeding: Breeding foods\nMob | Items\nCow | Wheat\nSheep & Goats | Wheat; Beetroot Seeds\nHorse | Golden Carrot.");
    expect(await wiki.lookup({ query: "Breeding", section: "Breeding foods" })).toBe(result);
    expect(mock.calls).toHaveLength(4);
  });

  test("long rendered tables stop between rows rather than inside a cell", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => `<tr><td>Row ${index}</td><td>${"a".repeat(100)}</td></tr>`).join("");
    const mock = mockFetch([
      exactRoute("Breeding", titlePage("Breeding")),
      extractRoute("Breeding", "Intro.\n== Breeding foods ==\n"),
      parseRoute("Breeding", "sections", { parse: { sections: [{ index: "4", line: "Breeding foods" }] } }),
      parseRoute("Breeding", "text", { parse: { text: `<table>${rows}</table>` } }, "4"),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "Breeding", section: "Breeding foods" });

    expect(result.length).toBeLessThanOrEqual(1300);
    expect(result).toEndWith("\nMore text exists.");
    expect(result.split("\n").at(-2)).toMatch(/^Row \d+ \| a{100}$/);
  });

  test("long output is at most 1300 characters and stops at a sentence", async () => {
    const longIntro = Array.from({ length: 100 }, (_, index) => `Sentence number ${index} explains this block clearly.`).join(" ");
    const mock = mockFetch([
      exactRoute("Long", titlePage("Long")),
      extractRoute("Long", `${longIntro}\n== Usage ==\nUse it.`),
    ]);
    const wiki = createWiki({ fetch: mock.implementation });

    const result = await wiki.lookup({ query: "Long" });

    expect(result.length).toBeLessThanOrEqual(1300);
    expect(result).toMatch(/[.!?]\nMore text exists\.\nSections: Usage\.$/);
    expect(result).not.toContain("clearly Sentence");
  });

  test("a cached exact lookup makes no second requests", async () => {
    const mock = mockFetch([
      exactRoute("Breeding", titlePage("Breeding")),
      extractRoute("Breeding", "Breeding is a game mechanic.\n== Food =="),
    ]);
    const wiki = createWiki({ fetch: mock.implementation, cachePath: await cachePath() });

    const first = await wiki.lookup({ query: "Breeding" });
    const second = await wiki.lookup({ query: "Breeding" });

    expect(second).toBe(first);
    expect(mock.calls).toHaveLength(2);
  });

  test("a network failure has a short actionable error", async () => {
    const wiki = createWiki({ fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch });

    await expect(wiki.lookup({ query: "Breeding" })).rejects.toThrow("The wiki could not be reached; try again later.");
  });

  test("a request that exceeds the timeout has the same short error", async () => {
    const pending = Promise.withResolvers<Response>();
    const pendingFetch = (async () => await pending.promise) as unknown as typeof fetch;
    const wiki = createWiki({ fetch: pendingFetch, timeoutMs: 5 });

    await expect(wiki.lookup({ query: "Breeding" })).rejects.toThrow("The wiki could not be reached; try again later.");
  });
});
