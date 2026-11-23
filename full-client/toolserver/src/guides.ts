import { z } from "zod";
import type { GuideHit, Knowledge } from "./knowledge/types.ts";
import { referenceGuides, type ReferenceGuide } from "./guides-data.ts";
import type { KnowledgeGaps, Reference } from "./knowledge-gaps.ts";

export const guideDefinition = {
  description: "Practical reference guides, installed mod books and caretaker-researched references. Ask a natural question, query='topics', query='references', or a returned ref-N handle. section='books' searches installed books; section='references' finds researched alternatives. References are untested, not skills; installed recipes/JEI win. Unmatched questions are queued for research; guide_feedback reports corrections and guide_updates revisits your requests.",
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
  return `${prefix}\n${referenceGuides.map(guide => `${guide.id}: ${guide.title}`).join("\n")}\nCall guide with a topic as query; sections are shown there. query=references browses researched references. Other queries search installed books. Recipes/JEI override generic instructions; references are not live-tested skills. mods lists every installed mod by kind.`;
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

type LookupState = { kind: "match" | "navigation" | "miss" | "unavailable" };

function lookupCuratedGuide(args: GuideArgs, knowledge: Pick<Knowledge, "searchGuides"> | undefined, state: LookupState): string {
  const parsed = guideDefinition.schema.safeParse(args);
  if (!parsed.success) return "Use guide {query:'topic or question', section?:'section handle[:page]'}. Query must be 1..200 characters, section 1..100.";
  const query = normal(parsed.data.query);
  const requested = parsed.data.section?.toLowerCase();
  if (!query || ["topics", "list", "help", "guides"].includes(query)) return topics();
  if (!words(query).some(word => !filler.has(word))) return topics("Please name a topic, item or gameplay question.");
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
    state.kind = "match";
    return paginated(`${provenance}\nSection: ${section.id} — ${section.title}`, section.paragraphs.join("\n"), section.id, page);
  }
  if (sectionName && sectionName !== "books") return topics("No curated topic matched that section. Try a topic below or section=books.");
  if (!knowledge) {
    state.kind = "unavailable";
    return topics(`${guide ? "Book search requested" : "No curated match"}; installed-book index unavailable. Curated references still work offline.`);
  }
  let hits: GuideHit[];
  try {
    hits = bookHits(parsed.data.query, knowledge);
  } catch {
    state.kind = "unavailable";
    return topics("Installed-book index could not be read. Curated references still work offline.");
  }
  if (!hits.length) {
    // A supplied section is navigation, not evidence that a new question is unanswered.
    state.kind = requested ? "navigation" : "miss";
    return topics(`${guide ? "No installed-book match" : "No curated or installed-book match"}. Try a specific mod, item or these topics:`);
  }
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
  state.kind = "match";
  return `${selected.header}\n\n${selected.text}\n\nPage ${page}/${bookPages.length}; ${page < bookPages.length ? `next section=books:${page + 1}` : "end of results"}`;
}

function referenceText(reference: Reference, section: string | undefined): string {
  const handle = section?.match(/^reference(?::([1-9][0-9]{0,5}))?$/);
  if (section && !handle) return `Use query=ref-${reference.gap_id}, section=reference[:page].`;
  const header = `ref-${reference.gap_id} r${reference.revision}: ${reference.title.slice(0, 160)}\nUNTESTED REFERENCE — not a tested skill.${reference.stale ? " OUTDATED: correction pending; do not rely on disputed instructions." : ""}`;
  const prerequisites = JSON.parse(reference.prerequisites_json) as string[];
  const controls = JSON.parse(reference.controls_json) as string[];
  const sources = JSON.parse(reference.sources_json) as { url: string; title: string; supports: string }[];
  const body = `Version scope: ${reference.scope}\n\n${reference.answer}\n\nPrerequisites:\n${prerequisites.join("\n")}\n\nBody-control translations (not executed):\n${controls.join("\n")}\n\nCaveats: ${reference.caveats}\n\nSources (research evidence, not live play verification):\n${sources.map((source, i) => `${i + 1}. ${source.title}\n${source.url}\nSupports: ${source.supports}`).join("\n\n")}`;
  return paginated(header, body, "reference", Number(handle?.[1] ?? 1));
}

/** Internal outcome metadata is authoritative; never infer a queue-worthy miss from prose. */
export async function lookupGuideResult(args: GuideArgs, knowledge?: Pick<Knowledge, "searchGuides">, gaps?: KnowledgeGaps): Promise<{ text: string; kind: LookupState["kind"]; queuedId?: number }> {
  const state: LookupState = { kind: "navigation" };
  const parsed = guideDefinition.schema.safeParse(args);
  if (parsed.success && gaps) {
    const query = parsed.data.query;
    const ref = query.match(/^ref-([1-9][0-9]*)$/i);
    try {
      if (ref) {
        const found = await gaps.get(Number(ref[1]));
        return { text: found ? referenceText(found, parsed.data.section?.toLowerCase()) : `No published reference at ${query}. Check guide_updates for its request status.`, kind: found ? "match" : "navigation" };
      }
      const referencePage = parsed.data.section?.match(/^references(?::([1-9][0-9]{0,5}))?$/);
      if (normal(query) === "references" || referencePage) {
        const page = Number(referencePage?.[1] ?? 1);
        const browsing = normal(query) === "references";
        const found = browsing ? await gaps.list(page) : await gaps.search(query);
        return { text: found.length ? `Untested researched references; choose a stable handle as query:\n${found.slice(0, 6).map(row => `ref-${row.gap_id} r${row.revision}: ${row.title}${row.stale ? " [correction pending]" : ""}`).join("\n")}\n${browsing && found.length > 6 ? `More: query=references, section=references:${page + 1}` : "Narrow your query with section=references for other matches."}` : "No matching researched references on this page. Other queries still search curated guides and installed books.", kind: "navigation" };
      }
      if (!parsed.data.section && !["topics", "list", "help", "guides"].includes(normal(query))) {
        const exact = await gaps.exact(query);
        if (exact) return { text: referenceText(exact, undefined), kind: "match" };
      }
    } catch { /* A queue/library outage must not suppress otherwise valid offline output. */ }
  }
  const text = lookupCuratedGuide(args, knowledge, state);
  if ((state.kind === "miss" || state.kind === "unavailable") && gaps && parsed.success && !parsed.data.section) {
    try {
      const found = await gaps.search(parsed.data.query);
      if (found.length === 1) return { text: referenceText(found[0]!, undefined), kind: "match" };
      if (found.length > 1) return { text: `Matching untested references; choose a handle as query:\n${found.map(row => `ref-${row.gap_id}: ${row.title}`).join("\n")}`, kind: "navigation" };
      if (state.kind !== "miss") return { text, kind: state.kind };
      const queuedId = await gaps.recordMiss(parsed.data.query);
      return { text: `${text}\nResearch request ref-${queuedId} saved. Use guide_updates when useful; no need to repeat the question.`, kind: "miss", queuedId };
    } catch { return { text, kind: state.kind }; }
  }
  return { text, kind: state.kind };
}

export async function lookupGuide(args: GuideArgs, knowledge?: Pick<Knowledge, "searchGuides">, gaps?: KnowledgeGaps): Promise<string> {
  return (await lookupGuideResult(args, knowledge, gaps)).text;
}
