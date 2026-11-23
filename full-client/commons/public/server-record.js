// Server record panel: what the Minecraft server itself counted for each resident (statistics,
// advancements, building and digging, container flows), from the hub's copy of the server bridge's
// queries (api/server-data/*). Hub only; a station says where to look instead.
// Every section says, next to its figures, where they come from, how fresh they are, and what is
// missing or unsupported. Comparisons are side by side in roster order, never ranked.
import { dimensionName } from "./map-trails.js";
import {
  areaName, changeText, counterLabel, counterValue, deltaText, gapText, HEADLINES, itemName, kindsText, readableTitle, tabName, uncertainText,
} from "./server-data.js";

const KEY = "commons.record";
const DAY = 86_400_000;
const WINDOWS = [{ value: "session", label: "Last session" }, { value: "24h", label: "Last 24 h" }, { value: "7d", label: "Last 7 days" }];
const SPANS = [{ value: "1", label: "24 h" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }];
const LISTS = [
  { key: "mined", label: "Mined" }, { key: "crafted", label: "Crafted" },
  { key: "used", label: "Used", note: "placing a block counts as using it; a tool counts each use" },
  { key: "picked_up", label: "Picked up" }, { key: "killed", label: "Killed" }, { key: "killed_by", label: "Killed by", unit: "times" },
  { key: "broken", label: "Tools worn out" }, { key: "dropped", label: "Dropped" },
];

export function createServerRecord(root, { html, setHtml, get, colour, stamp, clock, ago, now, residents, places, goToMap, openFacility }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { /* private mode */ }
  const view = {
    window: WINDOWS.some(w => w.value === saved.window) ? saved.window : "session",
    span: SPANS.some(s => s.value === saved.span) ? saved.span : "7",
    record: null, ledger: null, blocks: null, problem: "", places: [], placesAt: 0,
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ window: view.window, span: view.span })); } catch { /* ignore */ } };
  const count = number => Math.round(number).toLocaleString("en-US");
  const buttons = (attribute, choices, current) => html`${choices.map(choice =>
    html`<button type="button" data-${attribute}="${choice.value}" aria-pressed="${String(choice.value === current)}">${choice.label}</button>`)}`;

  /** Roster order and colours from the Residents reply; server names are matched ignoring case. */
  function roster(names) {
    const known = residents()?.residents ?? [];
    const order = known.map(resident => resident.name);
    const byKey = new Map(known.map(resident => [resident.name.toLowerCase(), resident]));
    // Recorded residents the dashboard does not list (a station not configured here) take the colours the listed ones do not use.
    const recorded = (view.record?.residents ?? []).map(entry => entry.resident);
    const strangers = recorded.filter(name => !byKey.has(name.toLowerCase())).sort();
    const used = new Set(recorded.filter(name => byKey.has(name.toLowerCase())).map(name => colour(byKey.get(name.toLowerCase()).name)));
    const spare = [0, 1, 2, 3].map(i => `var(--c${i})`).filter(tint => !used.has(tint));
    const tint = name => byKey.has(name.toLowerCase()) ? colour(byKey.get(name.toLowerCase()).name)
      : spare.length ? spare[Math.max(0, strangers.indexOf(name)) % spare.length] : "var(--lichen)";
    return [...names].sort((a, b) => {
      const ia = order.findIndex(name => name.toLowerCase() === a.toLowerCase()), ib = order.findIndex(name => name.toLowerCase() === b.toLowerCase());
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    }).map(name => ({ name, info: byKey.get(name.toLowerCase()) ?? null, colour: tint(name) }));
  }

  // ---------- data health, said next to the data it affects ----------
  function bridgeLine(health) {
    return {
      unconfigured: "This hub has no server bridge configured, so nothing new is being recorded.",
      unchecked: "The hub has not asked the server bridge yet (it does a few seconds after starting).",
      unsupported: "The server bridge running now is an older version without these queries: nothing new is recorded until version 0.2.0 or later is installed. What is shown was stored before.",
      error: `The hub could not reach the server bridge on its last try${health.detail ? ` (${health.detail})` : ""}; it keeps trying.`,
    }[health.status] ?? null;
  }
  function sourceLine(set, health, { about, extra }) {
    const parts = [];
    if (set.supported === false) {
      parts.push(html`<span class="bad">${health.status === "unsupported" ? bridgeLine(health)
        : `The server bridge does not offer ${kindsText(set.missing)} (an older version, or this hub's token is not allowed it), so these figures are not being updated.`}</span>`);
    } else if (set.supported === null && bridgeLine(health)) parts.push(html`<span class="warn">${bridgeLine(health)}</span>`);
    if (set.lastPass && !set.lastPass.ok) parts.push(html`<span class="warn">Last read failed at ${clock(set.lastPass.at, false)}: ${set.lastPass.detail ?? "no detail"}.</span>`);
    parts.push(about);
    if (set.lastPass?.ok) parts.push(`Hub last read ${ago(set.lastPass.at)}.`);
    if (extra) parts.push(extra);
    if (set.gaps.count) {
      parts.push(html`<span class="warn">${set.gaps.count === 1 ? "One known gap" : `${set.gaps.count} known gaps`} in the last 7 days:
        ${set.gaps.recent.map((gap, i) => html`${i ? "; " : ""}${stamp(gap.at)} ${gapText(gap.detail, stamp)}`)}.</span>`);
    }
    return html`<p class="fine source">${parts.map((part, i) => html`${i ? " " : ""}${part}`)}</p>`;
  }

  // ---------- statistics ----------
  function windowText(stats, info) {
    const w = stats.window;
    if (stats.savedAt === null) return "No statistics stored yet.";
    if (w.kind === "session") {
      if (w.partial && w.from === w.to) return `One save stored so far (${stamp(w.to)}): changes show after its next save while playing.`;
      if (w.partial) return `This session began before the hub's record (${stamp(w.from)}); changes since then.`;
      const online = info?.status === "online";
      return `Session from about ${stamp(w.startedAbout)}${online ? `, still playing (last save ${ago(w.to)})` : ` to ${clock(w.to, false)}`}.`;
    }
    const span = w.kind === "24h" ? "the last 24 h" : "the last 7 days";
    return w.partial ? `Since the hub's record began, ${stamp(w.from)} (less than ${span}).` : `In ${span}; newest save ${ago(w.to)}.`;
  }
  function comparisonNote(people) {
    const since = people.map(person => person.advancements?.firstAt ? `${person.name} ${stamp(person.advancements.firstAt).split(" ").slice(0, 2).join(" ")}` : null).filter(Boolean);
    // "Gary and Margo on inspiron, Wren and Tobin on chungus1": where each runs, as the dashboard knows it.
    const where = new Map();
    for (const person of people) {
      const host = person.info?.host ?? "a machine this dashboard does not list";
      where.set(host, [...(where.get(host) ?? []), person.name]);
    }
    const machines = [...where].map(([host, names]) => `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} on ${host}`).join(", ");
    return html`<p class="fine">Side by side, not a ranking. They arrived at different times${since.length ? ` (first advancement: ${since.join(", ")})` : ""},
      run on their own machines (${machines}) with their own personas and models, and are stopped and started separately:
      a bigger total mostly means a longer life here, not a better one. Read down a column for what one resident has done.</p>`;
  }
  function statsSection(people, health) {
    const shown = HEADLINES.filter(row => !row.optional || people.some(person => person.stats.headline[row.key].now));
    const newest = Math.max(0, ...people.map(person => person.stats.savedAt ?? 0));
    return html`<section class="group" aria-labelledby="rec-stats">
      <h2 id="rec-stats">What they have done</h2>
      ${sourceLine(health.sets.stats, health, {
        about: newest ? `From each resident's statistics file, which the server writes about every five minutes while they play and when they leave; newest save ${stamp(newest)}, so figures can be a few minutes behind.` : "No statistics stored yet." })}
      ${comparisonNote(people)}
      <div class="record-scroll"><table class="record-table">
        <thead><tr><th scope="col"><span class="sr">Figure</span></th>${people.map(person => html`<th scope="col" style="--who:${person.colour}">
          <b>${person.name}</b>${person.info?.host ? html`<span class="meta"> ${person.info.host}</span>` : ""}
          <span class="window">${windowText(person.stats, person.info)}</span></th>`)}</tr></thead>
        <tbody>${shown.map(row => html`<tr><th scope="row">${row.label}${row.note ? html`<span class="meta">${row.note}</span>` : ""}</th>
          ${people.map(person => {
            const figure = person.stats.headline[row.key], moved = changeText(figure.change, row.unit);
            return html`<td><b>${person.stats.savedAt === null ? "—" : row.unit(figure.now)}</b>${moved ? html`<span class="change">${moved}</span>` : ""}</td>`;
          })}</tr>`)}</tbody>
      </table></div>
      <p class="fine">Bold: all time. Below it: the change in the chosen window (blank: none). Distances: one block is a metre.</p>
      <div class="cards record-cards">${people.map(person => html`<article class="card" style="--who:${person.colour}">
        <header><h3>${person.name}</h3></header>
        ${LISTS.filter(list => person.stats.lists[list.key].total).map(list => {
          const data = person.stats.lists[list.key];
          return html`<div class="record-list"><h4>${list.label} <span class="meta">${count(data.total)} ${list.unit ?? ""} of ${data.kinds} ${data.kinds === 1 ? "kind" : "kinds"}${list.note ? `; ${list.note}` : ""}</span></h4>
            ${data.byChange.length ? html`<p class="moved">This window: ${data.byChange.map((entry, i) => html`${i ? ", " : ""}${itemName(entry.key)} <b>+${count(entry.change)}</b>`)}</p>` : ""}
            <p>${data.byTotal.map((entry, i) => html`${i ? " · " : ""}${itemName(entry.key)} <span class="data">${count(entry.now)}</span>`)}</p></div>`;
        })}
        ${person.stats.custom.length ? html`<details data-d="rec-custom:${person.name}"><summary>Every other counter (${person.stats.custom.length})</summary>
          <dl class="facts">${person.stats.custom.map(entry => html`<dt>${counterLabel(entry.key)}</dt><dd><span class="data">${counterValue(entry.key, entry.now)}</span>${entry.change
            ? html` <span class="meta">+${counterValue(entry.key, entry.change)}</span>` : ""}</dd>`)}</dl></details>` : ""}
        ${person.stats.savedAt === null ? html`<p class="empty">No statistics stored yet.</p>` : ""}
      </article>`)}</div>
    </section>`;
  }

  // ---------- advancements ----------
  function title(item) {
    const { text, made } = readableTitle(item.title, item.id);
    return made ? html`<span class="made" title="${`No English name on the server; made from ${item.title ?? item.id}`}">${text}</span>` : text;
  }
  function advancementsSection(people, catalog, health) {
    const tabs = new Map(catalog.tabs.map(tab => [tab.id, tab]));
    const savedAt = Math.max(0, ...people.map(person => person.advancements.savedAt ?? 0));
    return html`<section class="group" aria-labelledby="rec-adv">
      <h2 id="rec-adv">Advancements</h2>
      ${sourceLine(health.sets.advancements, health, {
        about: html`From each resident's advancement file (written with the statistics)${savedAt ? `, newest ${stamp(savedAt)}` : ""}, against the ${count(catalog.total)} advancements loaded on the server
          ${catalog.builtAt ? `(list built ${stamp(catalog.builtAt)})` : "(no list stored yet)"}. Names in italics have no English text on the server and were made from internal names.` })}
      <div class="cards record-cards">${people.map(person => {
        const a = person.advancements, mine = new Map(a.tabs.map(tab => [tab.id, tab]));
        const untouched = catalog.tabs.filter(tab => !mine.has(tab.id) && !tab.id.endsWith(":*"));
        return html`<article class="card" style="--who:${person.colour}">
          <header><h3>${person.name}</h3><span class="meta">${count(a.done)} of ${count(catalog.total)} earned${a.firstAt ? `; first on ${stamp(a.firstAt)}` : ""}</span></header>
          ${a.tabs.length ? html`<ul class="tab-progress">${a.tabs.map(entry => {
            const tab = tabs.get(entry.id), total = tab?.total ?? entry.done;
            return html`<li><span>${tab ? tabName(tab) : entry.id}${tab && !tab.vanilla ? html` <span class="meta">mod</span>` : ""}</span>
              <span class="bar" role="img" aria-label="${`${entry.done} of ${total}`}"><i style="--p:${(entry.done / Math.max(1, total) * 100).toFixed(1)}%"></i></span>
              <span class="data">${entry.done}/${total}${entry.started ? html` <span class="meta">+${entry.started} started</span>` : ""}</span></li>`;
          })}</ul>` : html`<p class="empty">No advancements recorded yet.</p>`}
          ${untouched.length ? html`<p class="fine">Nothing yet in: ${untouched.map(tab => tabName(tab)).join(", ")}.</p>` : ""}
          ${a.recent.length ? html`<h4>Recently earned</h4><ol class="record-timeline">${a.recent.slice(0, 8).map(item => html`<li>
            <time>${item.doneAt ? stamp(item.doneAt) : "time unknown"}</time><span>${title(item)}${item.frame === "challenge" ? html` <span class="pill verified">challenge</span>` : ""}
            <span class="meta">${tabs.has(item.tab) ? tabName(tabs.get(item.tab)) : ""}</span></span></li>`)}</ol>` : ""}
          ${a.nearly.length ? html`<h4>Started, not finished</h4><ul class="record-plain">${a.nearly.slice(0, 5).map(item => html`<li>${title(item)} <span class="meta">${item.remaining === null
            ? "partly done" : `${item.criteriaDone} of ${item.criteriaTotal}${item.remaining === 1 ? ", one to go" : `, ${item.remaining} to go`}`}</span></li>`)}</ul>` : ""}
          ${a.next.length ? html`<h4>One step away <span class="meta">not started; the one before it is done</span></h4>
            <p>${a.next.map((item, i) => html`${i ? ", " : ""}${title(item)}`)}${a.nextCount > a.next.length ? ` and ${a.nextCount - a.next.length} more` : ""}.</p>` : ""}
        </article>`;
      })}</div>
    </section>`;
  }

  // ---------- building and digging ----------
  function buildingSection(people, blocks) {
    if (!blocks) return "";
    const health = view.record.health, set = blocks.health, totals = new Map();
    for (const row of blocks.hours) {
      const total = totals.get(row.resident) ?? { placed: 0, broken: 0 };
      total.placed += row.placed; total.broken += row.broken;
      totals.set(row.resident, total);
    }
    // Saved places name the areas: the Map's when it has been opened, else a light read of its reply.
    const known = places().length ? places() : view.places;
    const spanText = SPANS.find(s => s.value === view.span).label;
    return html`<section class="group" aria-labelledby="rec-blocks">
      <h2 id="rec-blocks">Building and digging <small>last ${spanText}</small></h2>
      ${sourceLine(set, health, {
        about: html`Counted by the server as residents place and break blocks: every change is counted per chunk and hour; individual changes are only a sample (bursts skip some) and are kept 14 days.
          Not seen at all: explosions, pistons, water and lava, mobs, machines, and placing with a bucket.${set.newest ? ` Newest change ${stamp(set.newest)}.` : ""}` })}
      <ul class="record-plain">${people.map(person => {
        const total = totals.get(person.name), spill = blocks.overflow.find(row => row.resident === person.name);
        return html`<li style="--who:${person.colour}" class="who-line"><b>${person.name}</b>: ${total ? `placed ${count(total.placed)}, broke ${count(total.broken)}` : "no blocks placed or broken"}
          ${spill ? html`<span class="warn">plus ${count(spill.placed + spill.broken)} counted without a position (the server's table was full)</span>` : ""}</li>`;
      })}</ul>
      ${blocks.areas.length ? html`<h3>Who built where</h3><ul class="record-areas">${blocks.areas.slice(0, 16).map(area => {
        const name = areaName(area, known), person = roster([area.resident])[0];
        return html`<li style="--who:${person.colour}"><b>${area.resident}</b> ${name.text}${name.owner ? html` <span class="meta">(${name.owner === "shared" ? "shared place" : `${name.owner}'s place`})</span>` : ""}
          <span class="meta">${area.dimension === "overworld" ? "" : `${dimensionName(area.dimension)}, `}${name.span}</span><br>
          placed ${count(area.placed)}, broke ${count(area.broken)} in ${area.chunks === 1 ? "one chunk" : `${area.chunks} chunks`}${area.kinds.length
            ? html`; mostly ${area.kinds.map(kind => itemName(kind.block)).join(", ")}` : ""}; last ${ago(area.lastAt)}
          <button type="button" class="link" data-go="${JSON.stringify([area.dimension, name.x, name.z])}">Show on the map</button></li>`;
      })}</ul>` : html`<p class="empty">No resident placed or broke a block in this period, as far as the server saw.</p>`}
      <p class="fine">The Map shows the same counts chunk by chunk under the trails (Building and digging, below the map), with each chunk's hours and recent changes.</p>
    </section>`;
  }

  // ---------- container flows ----------
  function flowsSection(ledger) {
    if (!ledger) return "";
    const health = view.record.health;
    const spanText = SPANS.find(s => s.value === view.span).label;
    return html`<section class="group" aria-labelledby="rec-flows">
      <h2 id="rec-flows">Container flows <small>last ${spanText}</small></h2>
      ${sourceLine(ledger.health, health, {
        about: html`<b>Evidence, not proof.</b> The server compares each registered container with its previous look and records what changed in between.
          "Near" lists residents within 8 blocks at that moment; human players are never considered, and hoppers, pipes and machines are invisible,
          so a change with a resident near may still have been made by someone or something else. Two changes that cancel out between looks are not seen.`,
        extra: ledger.truncated ? html`<span class="warn">Only the newest 2,000 changes in this period are summed.</span>` : "" })}
      ${ledger.facilities.length ? html`<div class="cards record-cards">${ledger.facilities.map(facility => html`<article class="card ledger">
        <header><h3>${facility.label ?? facility.facility}</h3>
          ${facility.pos ? html`<button type="button" class="link" data-facility="${facility.facility}">Facility entry</button>` : ""}</header>
        <p class="meta">${facility.label ? `${facility.facility} · ` : ""}${facility.pos ? `${facility.pos.join(", ")}, ${dimensionName(facility.dimension)}` : "not in the current server snapshot (no longer registered, or the snapshot is unavailable)"}</p>
        <p>${count(facility.flows)} ${facility.flows === 1 ? "change" : "changes"} seen between ${stamp(facility.firstAt)} and ${stamp(facility.lastAt)}.</p>
        <table class="ledger-table"><thead><tr><th scope="col">Item</th><th scope="col">In</th><th scope="col">Out</th></tr></thead>
          <tbody>${facility.items.map(item => html`<tr><td>${itemName(item.item)}</td><td class="data">${item.in ? `+${count(item.in)}` : ""}</td><td class="data">${item.out ? `−${count(item.out)}` : ""}</td></tr>`)}</tbody></table>
        <p>${facility.nearest.length ? html`Nearest resident at the time: ${facility.nearest.map((near, i) => html`${i ? ", " : ""}<b style="color:${roster([near.name])[0].colour}">${near.name}</b> ${near.flows}×`)}.` : ""}
          ${facility.unattributed ? `${facility.unattributed === facility.flows ? "Every change" : `${facility.unattributed} ${facility.unattributed === 1 ? "change" : "changes"}`} with no resident within 8 blocks.` : ""}</p>
        ${facility.uncertain.length ? html`<p class="warn fine">Possibly incomplete: ${facility.uncertain.map((u, i) => html`${i ? "; " : ""}${uncertainText(u.name)} (${u.flows}×)`)}.</p>` : ""}
        <details data-d="ledger:${facility.facility}"><summary>Each change (newest ${facility.recent.length})</summary><ol class="record-timeline">${facility.recent.map(flow => html`<li>
          <time>${stamp(flow.at)}</time><span>${deltaText(flow.deltas)}${flow.deltasTruncated ? " …" : ""}
          <span class="meta">${flow.resident ? `nearest: ${flow.resident}` : "no resident near"}${flow.nearby.length > 1 ? `; also near: ${flow.nearby.slice(1).map(n => n.resident).join(", ")}` : ""}</span></span></li>`)}</ol></details>
      </article>`)}</div>` : html`<p class="empty">No changes seen in registered containers in this period.</p>`}
    </section>`;
  }

  // ---------- data health, all sets together ----------
  function healthSection(health) {
    const rows = [["Statistics", health.sets.stats], ["Advancements", health.sets.advancements], ["Building and digging", health.sets.blocks], ["Container flows", health.sets.flows]];
    const state = set => set.supported === false ? html`<span class="bad">not offered: ${kindsText(set.missing)}</span>`
      : set.supported === null ? html`<span class="meta">not known yet</span>` : set.lastPass && !set.lastPass.ok ? html`<span class="warn">last read failed</span>` : html`<span class="good">offered</span>`;
    return html`<section class="group" aria-labelledby="rec-health">
      <h2 id="rec-health">Where this comes from</h2>
      <p class="fine">Only the hub asks the server bridge for this, for every resident whichever machine runs them, about once a minute (statistics every 15 minutes, advancements every 30). ${bridgeLine(health) ?? ""}</p>
      <div class="record-scroll"><table class="ledger-table health-table"><thead><tr><th scope="col">Data</th><th scope="col">Bridge</th><th scope="col">Hub last read</th><th scope="col">Newest in it</th><th scope="col">Known gaps, 7 days</th></tr></thead>
        <tbody>${rows.map(([label, set]) => html`<tr><th scope="row">${label}</th><td>${state(set)}</td><td>${set.lastPass ? stamp(set.lastPass.at) : "not since the hub started"}</td>
          <td>${set.newest ? stamp(set.newest) : "nothing stored"}</td><td>${set.gaps.count || "none"}</td></tr>`)}</tbody></table></div>
    </section>`;
  }

  function render() {
    const body = root.querySelector("#record-body");
    setHtml(root.querySelector("#record-window"), buttons("window", WINDOWS, view.window));
    setHtml(root.querySelector("#record-span"), buttons("span", SPANS, view.span));
    if (view.problem) { setHtml(body, html`<p class="empty">${view.problem}</p>`); return; }
    if (!view.record) { setHtml(body, html`<p class="empty">Reading…</p>`); return; }
    const byName = new Map(view.record.residents.map(entry => [entry.resident, entry]));
    const people = roster(view.record.residents.map(entry => entry.resident)).map(person => ({ ...person, ...byName.get(person.name) }));
    setHtml(body, people.length ? html`${statsSection(people, view.record.health)}${advancementsSection(people, view.record.catalog, view.record.health)}
      ${buildingSection(people, view.blocks)}${flowsSection(view.ledger)}${healthSection(view.record.health)}`
      : html`<p class="empty">Nothing recorded from the server yet.</p>${healthSection(view.record.health)}`);
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.window) { view.window = button.dataset.window; save(); render(); void load(); }
    else if (button.dataset.span) { view.span = button.dataset.span; save(); render(); void load(); }
    else if (button.dataset.go) { const [dimension, x, z] = JSON.parse(button.dataset.go); goToMap(dimension, x, z); }
    else if (button.dataset.facility) openFacility(button.dataset.facility);
  });

  async function load() {
    if (residents()?.role === "station") {
      view.problem = "The server record is kept on the Commons hub for every resident; open the hub's dashboard to see it.";
      render();
      return;
    }
    const since = now() - Number(view.span) * DAY, asked = `${view.window}|${view.span}`;
    const [record, ledger, blocks] = await Promise.all([
      get(`api/server-data/record?window=${view.window}`), get(`api/server-data/ledger?since=${since}`), get(`api/server-data/block-map?since=${since}`),
    ]);
    if (asked !== `${view.window}|${view.span}`) return; // the choice changed while reading
    if (!places().length && Date.now() - view.placesAt > 300_000) {
      view.placesAt = Date.now();
      view.places = (await get("api/map?hours=1").catch(() => null))?.places ?? view.places;
    }
    Object.assign(view, { record, ledger, blocks, problem: "" });
    render();
  }
  return { load, render };
}
