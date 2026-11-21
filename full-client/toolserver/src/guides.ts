import { z } from "zod";
import type { GuideHit, Knowledge } from "./knowledge/types.ts";
import { referenceGuides, type ReferenceGuide } from "./guides-data.ts";

export const guideDefinition = {
  description: "Offline practical reference guides plus installed mod books: breeding, crops, shelter, Mekanism, Refined Storage, Immersive Engineering, settlement and body controls. Ask a natural question or query='topics'. Follow returned topic/section handles; section='books' searches installed books even for a curated topic. Reference, not a live-tested skill. Installed recipes/JEI override generic quantities.",
  schema: z.object({
    query: z.string().trim().min(1).max(200),
    section: z.string().trim().min(1).max(100).optional(),
  }),
};
export type GuideArgs = z.infer<typeof guideDefinition.schema>;

const MAX_OUTPUT = 1250;
const BOOK_LIMIT = 12;
const filler = new Set("how do does did i we you can could should would please to a an the of in on for with my our is are what where when about tell me get getting make making start starting started guide guides tutorial help need want learn".split(" "));
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normal = (text: string): string => words(text).join(" ");

function phraseScore(query: string, aliases: readonly string[]): number {
  let score = 0;
  const padded = ` ${query} `;
  for (const alias of aliases) {
    const phrase = normal(alias);
    if (padded.includes(` ${phrase} `)) score += words(phrase).length;
  }
  return score;
}

function topics(prefix = "Offline reference topics"): string {
  return `${prefix}\n${referenceGuides.map(guide => `${guide.id}: ${guide.title}`).join("\n")}\nCall guide with a topic as query; sections are shown there. Other queries search installed books. Recipes/JEI override generic instructions; references are not live-tested skills.`;
}

function chooseGuide(query: string): ReferenceGuide | undefined {
  const exact = referenceGuides.find(guide => normal(guide.id) === query);
  if (exact) return exact;
  const matches = referenceGuides.map(guide => ({ guide, score: phraseScore(query, guide.aliases) }))
    .filter(match => match.score > 0).sort((a, b) => b.score - a.score);
  // Cross-topic ambiguity is a navigation choice, never an arbitrary first match.
  if (matches[0] && (!matches[1] || matches[0].score > matches[1].score)) return matches[0].guide;
  return undefined;
}

/** Split without dropping text. Prefer paragraph, sentence, then word boundaries. */
function pages(text: string, budget: number): string[] {
  const result: string[] = [];
  let rest = text.trim();
  while (rest.length > budget) {
    const prefix = rest.slice(0, budget + 1);
    let end = prefix.lastIndexOf("\n", budget);
    if (end < budget / 3) {
      end = 0;
      for (const match of prefix.matchAll(/[.!?](?=\s)/g)) {
        if (match.index + 1 <= budget) end = match.index + 1;
      }
    }
    if (end < budget / 3) end = prefix.lastIndexOf(" ", budget);
    if (end <= 0) {
      end = budget;
      // Do not split a UTF-16 surrogate pair in a long unbroken identifier.
      if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    }
    result.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  result.push(rest);
  return result;
}

function paginated(header: string, text: string, section: string, page: number): string {
  // At most text.length pages: reserve all navigation digits before splitting.
  const digits = String(text.length + 1).length;
  const placeholder = "9".repeat(digits);
  const navigation = `Page ${placeholder}/${placeholder}; next section=${section}:${placeholder}`;
  const chunks = pages(text, MAX_OUTPUT - header.length - navigation.length - 4);
  if (page > chunks.length) return `${header}\n\nNo such page. Use section=${section}:1 through ${section}:${chunks.length}.`;
  const footer = `Page ${page}/${chunks.length}; ${page < chunks.length ? `next section=${section}:${page + 1}` : "end of section"}`;
  return `${header}\n\n${chunks[page - 1]}\n\n${footer}`;
}

function bookHits(query: string, knowledge: Pick<Knowledge, "searchGuides">): GuideHit[] {
  const terms = [...new Set(words(query).filter(word => !filler.has(word)))].slice(0, 12);
  if (!terms.length) return [];
  const combined = knowledge.searchGuides(terms.join(" "), BOOK_LIMIT);
  if (combined.length) return combined;
  // Knowledge.searchGuides is AND-based; relax only when its meaningful phrase fails.
  const hits = new Map<string, GuideHit>();
  for (const term of terms) {
    for (const hit of knowledge.searchGuides(term, BOOK_LIMIT)) {
      hits.set(`${hit.where}\n${hit.excerpt}`, hit);
    }
  }
  const score = (hit: GuideHit) => terms.filter(term => words(`${hit.where} ${hit.excerpt}`).includes(term)).length;
  return [...hits.values()].sort((a, b) => score(b) - score(a)
    || (a.where < b.where ? -1 : a.where > b.where ? 1 : a.excerpt < b.excerpt ? -1 : a.excerpt > b.excerpt ? 1 : 0))
    .slice(0, BOOK_LIMIT);
}

export function lookupGuide(args: GuideArgs, knowledge?: Pick<Knowledge, "searchGuides">): string {
  const parsed = guideDefinition.schema.safeParse(args);
  if (!parsed.success) return "Use guide {query:'topic or question', section?:'section handle[:page]'}. Query must be 1..200 characters, section 1..100.";
  const query = normal(parsed.data.query);
  const requested = parsed.data.section?.toLowerCase();
  if (!query || ["topics", "list", "help", "guides"].includes(query)) return topics();
  const handle = requested?.match(/^([a-z][a-z0-9 -]*)(?::([1-9][0-9]{0,5}))?$/);
  if (requested && !handle) return "Invalid section handle. Use a listed section, optionally followed by :page (starting at 1), or omit section for navigation.";
  const sectionName = handle?.[1]?.trim().replace(/ /g, "-");
  const page = Number(handle?.[2] ?? 1);
  const guide = chooseGuide(query);
  if (!guide && sectionName !== "books") {
    const candidates = referenceGuides.filter(candidate => phraseScore(query, candidate.aliases) > 0);
    if (candidates.length) return topics(`Several reference topics match: ${candidates.map(candidate => candidate.id).join(", ")}. Choose one as query; section=books explicitly searches books.`);
  }
  if (guide && sectionName !== "books") {
    const navigation = `query=${guide.id}; sections=${guide.sections.map(section => section.id).join(",")},books`;
    let section = guide.sections.find(candidate => candidate.id === sectionName);
    if (!sectionName) {
      if (query === normal(guide.id) || /\b(?:start|starting|begin|beginner|beginners)\b/.test(query)) {
        section = guide.sections[0];
      } else {
        const focused = guide.sections.map(candidate => ({ candidate, score: phraseScore(query, candidate.aliases ?? []) }))
          .filter(match => match.score > 0).sort((a, b) => b.score - a.score);
        section = focused[0] && (!focused[1] || focused[0].score > focused[1].score)
          ? focused[0].candidate : guide.sections[0];
      }
    }
    const provenance = `${guide.title}\nScope: ${guide.scope}\nSource: ${section?.source ?? guide.source}\nReference only; installed recipes/JEI win.\n${navigation}`;
    if (!section) return `${provenance}\n\nUnknown section; choose one listed above.`;
    return paginated(`${provenance}\nSection: ${section.id} — ${section.title}`, section.paragraphs.join("\n"), section.id, page);
  }
  if (sectionName && sectionName !== "books") return topics("No curated topic matched that section. Try a topic below or section=books.");
  if (!knowledge) return topics(`${guide ? "Book search requested" : "No curated match"}; installed-book index unavailable. Curated references still work offline.`);
  let hits: GuideHit[];
  try {
    hits = bookHits(parsed.data.query, knowledge);
  } catch {
    return topics("Installed-book index could not be read. Curated references still work offline.");
  }
  if (!hits.length) return topics(`${guide ? "No installed-book match" : "No curated or installed-book match"}. Try a specific mod, item or these topics:`);
  // The index already stores bounded excerpts; disclose that these are not complete procedures.
  const common = "Installed-book excerpts (not full procedures)\nScope: indexed pack jars, Java 1.20.1; exact versions depend on index build.\nInstalled recipes/JEI win. Keep same query; section=books[:page]. Up to 12 hits; narrow query for others.";
  const bookPages: { header: string; text: string }[] = [];
  for (const [index, hit] of hits.entries()) {
    const label = `Source ${index + 1}: ${hit.where}`;
    // Repeat normal source labels on every continuation. Long labels themselves
    // paginate, with a stable source number linking their subsequent text.
    const header = label.length <= 400 ? `${common}\n${label}` : `${common}\nSource ${index + 1}: full label starts at section=books:${bookPages.length + 1}`;
    const text = label.length <= 400 ? hit.excerpt : `${label}\n${hit.excerpt}`;
    for (const chunk of pages(text, MAX_OUTPUT - header.length - 90)) bookPages.push({ header, text: chunk });
  }
  const selected = bookPages[page - 1];
  if (!selected) return `${common}\nNo such page; use section=books:1 through books:${bookPages.length}.`;
  return `${selected.header}\n\n${selected.text}\n\nPage ${page}/${bookPages.length}; ${page < bookPages.length ? `next section=books:${page + 1}` : "end of results"}`;
}
