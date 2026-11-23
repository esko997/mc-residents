import type { FrontierEntry, FrontierReply, FrontierTab } from "../../commons/src/resident-advancements.ts";
import type { Knowledge } from "./knowledge/types.ts";
import { span } from "./plan.ts";

/**
 * Advancements one step from what the resident has done, as the advancements screen shows them, written for
 * `what_next`. The hub works out the frontier from the server's records (commons/src/resident-advancements.ts); the
 * knowledge export adds the pack's English titles and descriptions. Information to consult: each line says what
 * the advancement is, where it belongs and what is still missing, never that it should be done.
 */
export type Frontier = Extract<FrontierReply, { status: "ok" }>;
export type FrontierKnowledge = Pick<Knowledge, "advancement" | "modOf">;

const descriptionLimit = 110;

/** "base game" or "mod Quark", as the knowledge export names the mod. */
function source(id: string, knowledge?: FrontierKnowledge): string {
  const namespace = id.slice(0, id.indexOf(":"));
  return namespace === "minecraft" ? "base game" : `mod ${knowledge?.modOf?.(id)?.name ?? namespace}`;
}

/** The pack's English title when the server had only a translation key; otherwise the server's. */
function titleOf(item: { id: string; title: string; titleIsId: boolean }, knowledge?: FrontierKnowledge): { text: string; isId: boolean } {
  if (!item.titleIsId) return { text: item.title, isId: false };
  const known = knowledge?.advancement?.(item.id)?.title;
  return known ? { text: known, isId: false } : { text: item.title, isId: true };
}

function tabText(tab: FrontierTab | undefined, entry: FrontierEntry, knowledge?: FrontierKnowledge): string {
  if (!tab) return `in a tab of the ${source(entry.tab, knowledge)}`;
  const title = titleOf(tab, knowledge);
  const added = entry.mod !== tab.mod ? `; this one from ${source(entry.id, knowledge)}` : "";
  return `tab "${title.text}"${title.isId ? " (no title on the server)" : ""} (${source(tab.id, knowledge)}${added}; ${tab.done} of ${tab.total} done there)`;
}

/** What the server's records say is still missing. They name met criteria only, never the missing ones. */
function missingText({ criteria }: FrontierEntry): string {
  const { met, total, needs, groups } = criteria;
  if (total <= 1) return "";
  if (needs === "any") return ` Any one of its ${total} criteria completes it.`;
  if (needs === "groups") return ` ${met} of ${total} criteria met; it needs one in each of ${groups} groups.`;
  return met ? ` ${met} of its ${total} criteria met, ${total - met} still missing.` : ` Needs all ${total} of its criteria; none met yet.`;
}

/** Where to read about it: the mod's overview for modded entries, recipes for an item its criteria name, the guide. */
function learnMore(entry: FrontierEntry, items: string[]): string {
  const ways = [
    ...(entry.mod === "minecraft" ? [] : [`mods {query:"${entry.mod}"}`]),
    ...(items.length ? [`recipes {item:"${items[0]}"}`] : []),
    "guide",
  ];
  return ` Learn more: ${ways.join(", ")}.`;
}

/** One frontier entry in plain words. A `standalone` line (in what_next's suggestions) says what it is and how old the record is. */
export function frontierText(entry: FrontierEntry, frontier: Frontier, knowledge?: FrontierKnowledge, standalone = true): string {
  const known = knowledge?.advancement?.(entry.id);
  const title = titleOf(entry, knowledge);
  const name = title.isId ? `"${title.text}" (no title on the server; id ${entry.id})` : `"${title.text}"`;
  const description = known?.description?.trim();
  const what = !description ? "" : description.length > descriptionLimit ? ` ${description.slice(0, descriptionLimit - 1)}…` : ` ${description}${/[.!?]$/.test(description) ? "" : "."}`;
  const tab = frontier.tabs.find(candidate => candidate.id === entry.tab);
  const text = `${name}, ${tabText(tab, entry, knowledge)}.${what}${missingText(entry)}${learnMore(entry, known?.items ?? [])}`;
  return standalone ? `Advancement within reach (server record ${span(frontier.ageMs)} old): ${text}` : text;
}

const listedTabs = 12;
/** "Minecraft 7, Adventure 26, …": tabs with something within reach and how many. */
function tabsText(frontier: Frontier, knowledge?: FrontierKnowledge): string {
  const shown = frontier.tabs.slice(0, listedTabs).map(tab => `${titleOf(tab, knowledge).text}${tab.mod === "minecraft" ? "" : ` (${tab.mod})`} ${tab.withinReach}`);
  const more = frontier.tabsTotal - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more tab${more === 1 ? "" : "s"}` : ""}`;
}

/**
 * The reply of `what_next {advancements}`: the frontier of one tab or mod ("all" for every tab), a page at a time.
 * `frontier` is the hub's reply, or the message of the error that kept it from answering.
 */
export function frontierReport(asked: string, frontier: FrontierReply | string, knowledge?: FrontierKnowledge): string {
  if (typeof frontier === "string") return `Advancement progress unavailable: ${frontier}`;
  if (frontier.status === "unavailable") return `Advancement progress unavailable: ${frontier.reason}`;
  const age = `server record ${span(frontier.ageMs)} old; the server saves about every 5 min and the hub reads it every 30 min`;
  if (!frontier.total) {
    const tabs = frontier.tabsTotal ? ` Tabs with something within reach: ${tabsText(frontier, knowledge)}.` : "";
    return frontier.scopeMatched
      ? `Nothing within reach in your advancement tabs (${age}).${tabs}`
      : `No tab or mod "${asked}" has an advancement within reach (${age}).${tabs}`;
  }
  const where = frontier.scope === null ? "across your advancement tabs" : `for "${asked}"`;
  const lines = [
    `${frontier.total} advancement${frontier.total === 1 ? "" : "s"} within reach ${where}: not done yet, the one before done (${age}).${frontier.total > frontier.entries.length ? ` ${frontier.entries.length} shown; asking again shows others.` : ""}`,
    ...frontier.entries.map((entry, index) => `${index + 1}. ${frontierText(entry, frontier, knowledge, false)}`),
  ];
  if (frontier.scope === null) lines.push(`Tabs with something within reach: ${tabsText(frontier, knowledge)}. what_next {advancements:"<tab or mod>"} lists one of them.`);
  return lines.join("\n");
}
