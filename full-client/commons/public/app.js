"use strict";
import { coverOf, dimensionName as dimensionLabel, equivalent, heightColour, heightDomain, mapDimensions, mergeMapTrail, nearestIndex, passedPlaces, profileSeries, SEA_LEVEL, splitByHeight } from "./map-trails.js";
import { createLiveView } from "./live-view.js";
// The Shared Knowledge page. No framework and no build step: each panel fetches JSON from
// api/<route> (relative, so the token in the address carries over) and patches
// only the parts of the page whose content changed, so nothing flickers and
// open sections, scroll positions and half-typed reasons survive a refresh.
//
// To add a panel: a <section id="p-NAME"> in index.html, an entry in `panels`
// below with a load function, and a route module on the server.

// ---------- small tools ----------
const $ = (selector, root = document) => root.querySelector(selector);
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
class Markup { constructor(text) { this.text = text; } }
/** Everything interpolated is escaped unless it is Markup itself (the result of another html``). */
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => { out += embed(value) + strings[index + 1]; });
  return new Markup(out);
}
function embed(value) {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(embed).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value).replace(/[&<>"']/g, char => ESCAPES[char]);
}

let skew = 0; // server clock minus this device's clock
const serverNow = () => Date.now() + skew;
const two = number => String(number).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function clock(t, seconds = true) {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
}
function stamp(t) {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(t, false)}`;
}
function ago(t) {
  const seconds = Math.max(0, Math.round((serverNow() - t) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}
const count = number => Number(number).toLocaleString("en-US");
const size = bytes => bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
const plural = (number, word, many = `${word}s`) => `${count(number)} ${number === 1 ? word : many}`;

async function get(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `The server answered ${response.status}.`);
  return response.json();
}

// What must survive a re-render: which <details> are open and what is typed where.
const opened = new Set();
const drafts = new Map();
document.addEventListener("toggle", event => {
  const key = event.target.dataset?.d;
  if (key) event.target.open ? opened.add(key) : opened.delete(key);
}, true);
document.addEventListener("input", event => {
  const key = event.target.dataset?.i;
  if (key) drafts.set(key, event.target.value);
}, true); // capture: the draft is stored before any panel's own input handler re-renders

/** Replace an element's content only when it differs from what was last put there. */
function setHtml(element, markup) {
  if (element.__html === markup.text) return false;
  const focusKey = element.contains(document.activeElement) ? document.activeElement.dataset.i : undefined;
  const caret = focusKey ? document.activeElement.selectionStart : 0;
  element.innerHTML = element.__html = markup.text;
  for (const details of element.querySelectorAll("details[data-d]")) details.open = opened.has(details.dataset.d);
  for (const field of element.querySelectorAll("[data-i]")) field.value = drafts.get(field.dataset.i) ?? "";
  if (focusKey) {
    const field = element.querySelector(`[data-i="${CSS.escape(focusKey)}"]`);
    if (field) { field.focus(); field.setSelectionRange?.(caret, caret); }
  }
  return true;
}
/** Keep one child per item, in order, re-rendering only the children whose markup changed. */
function patch(container, items, keyOf, render, tag = "div") {
  const have = new Map([...container.children].map(child => [child.dataset.key, child]));
  let index = 0;
  for (const item of items) {
    const key = String(keyOf(item));
    let child = have.get(key);
    have.delete(key);
    if (!child) { child = document.createElement(tag); child.dataset.key = key; child.__new = true; }
    render(child, item);
    if (container.children[index] !== child) container.insertBefore(child, container.children[index] ?? null);
    index++;
  }
  for (const stale of have.values()) stale.remove();
}

// ---------- residents everyone shares ----------
const state = { names: [], residents: null, active: "residents", failures: 0 };
const colour = name => name === "shared" ? "var(--shared)" : `var(--c${Math.max(0, state.names.indexOf(name)) % 4})`;
const liveView = createLiveView($("#p-live"), { now: serverNow, stamp, colour });
function segmented(container, choices, current, onPick) {
  setHtml(container, html`${choices.map(choice => html`<button type="button" data-value="${choice.value}" aria-pressed="${String(choice.value === current)}"
    ${choice.who ? html`data-who style="--who:${colour(choice.who)}"` : ""}>${choice.label}</button>`)}`);
  container.onclick = event => {
    const value = event.target.closest("button")?.dataset.value;
    if (value !== undefined) onPick(value);
  };
}

// ---------- Residents ----------
function pips(kind, value, max) {
  // As the game draws them: ten pips, each worth a tenth of the maximum, filled in halves, rounding up.
  const halves = Math.ceil(value / (max / 20) - 1e-9);
  return html`<span class="pips ${kind}" role="img" aria-label="${value} of ${max}">${Array.from({ length: 10 }, (_, i) =>
    html`<i class="${halves >= 2 * (i + 1) ? "full" : halves === 2 * i + 1 ? "half" : ""}"></i>`)}</span>`;
}
const stackText = stack => `${stack.item} ×${stack.count}${stack.maxDurability ? ` (${stack.durability}/${stack.maxDurability} uses left)` : ""}`;

const observerFresh = health => health && ["ok", "degraded"].includes(health.status)
  && health.snapshotAgeMs !== null && health.snapshotAgeMs <= 30_000;

function residentInfo(resident, observer) {
  const s = resident.state, tokens = resident.tokens, session = tokens.session;
  const observation = resident.serverObservation, body = observation?.body ?? observation?.lastSeen;
  const live = !s ? "" : html`
    <div class="vitals">
      <span class="label">Health</span>${pips("health", s.health, s.maxHealth)}<span class="data">${s.health} / ${s.maxHealth}</span>
      <span class="label">Food</span>${pips("food", s.food, 20)}<span class="data">${s.food} / 20</span>
      ${s.air && s.air.now < s.air.max ? html`<span class="label">Air</span>${pips("air", s.air.now, s.air.max)}<span class="data">${s.air.now} / ${s.air.max}</span>` : ""}
    </div>
    ${s.dangers.length ? html`<p class="bad">Right now: ${s.dangers.join(", ")}.</p>` : ""}
    <dl class="facts">
      <dt>Position</dt><dd class="data">${s.pos.x}, ${s.pos.y}, ${s.pos.z}</dd>
      <dt>Dimension</dt><dd>${s.dimension}${s.world ? html`<span class="meta"> ${[s.world.biome, s.world.timeOfDay, s.world.weather].filter(Boolean).join(", ")}</span>` : ""}</dd>
      <dt>Holding</dt><dd>${s.held ? html`<span class="data">${stackText(s.held)}</span>` : "nothing"} <span class="meta">hotbar slot ${s.selectedSlot + 1}</span></dd>
      <dt>Screen</dt><dd>${s.screen ? html`<span class="warn data">${s.screen}</span> is open` : "none open"}</dd>
      ${s.lookingAt ? html`<dt>Looking at</dt><dd class="data">${s.lookingAt}</dd>` : ""}
      <dt>Nearby</dt><dd>${[s.nearby.players.length ? `players: ${s.nearby.players.join(", ")}` : "no players",
        s.nearby.hostiles ? html`<span class="bad">${plural(s.nearby.hostiles, "hostile")}</span>` : "no hostiles"].map((part, i) => html`${i ? "; " : ""}${part}`)}</dd>
      ${s.armor.length ? html`<dt>Wearing</dt><dd class="data">${s.armor.join(", ")}</dd>` : ""}
      <dt>Carrying</dt><dd>${!s.inventory ? "not reported" : s.inventory.items.length === 0 ? "nothing" : html`
        ${s.inventory.usedSlots} of ${s.inventory.totalSlots} slots
        <div class="chips">${s.inventory.items.slice(0, 8).map(entry => html`<span class="data">${entry.item} ×${entry.count}</span>`)}</div>
        ${s.inventory.items.length > 8 ? html`<details data-d="inv:${resident.name}"><summary>${s.inventory.items.length - 8} more kinds</summary>
          <div class="chips">${s.inventory.items.slice(8).map(entry => html`<span class="data">${entry.item} ×${entry.count}</span>`)}</div></details>` : ""}`}</dd>
    </dl>`;
  return html`${live}
    <dl class="facts" ${s ? html`style="margin-top:10px"` : ""}>
      ${observation ? html`<dt>Server observation</dt><dd>
        ${observerFresh(observer) ? "Observed" : "Historical observation"} at ${stamp(observation.checkedAt)}:
        ${observation.online ? "present on the server" : "not present on the server"}.
        ${body ? html`<span class="data">${body.pos.x}, ${body.pos.y}, ${body.pos.z}</span> (${body.dimension}); body seen ${stamp(body.at)}.` : ""}
        <span class="fine">Independent of client connection and session health.</span></dd>` : ""}
      <dt>memory.md</dt><dd>${resident.memoryBytes === null ? "no file" : html`<span class="data">${size(resident.memoryBytes)}</span>${resident.memoryBytes > 8000
        ? html` <span class="warn">over 8 KB: its next session opens with a request to rewrite it</span>` : ""}`}</dd>
      <dt>Units</dt><dd>${resident.units.map(unit => html`<span class="unit"><span class="data">${unit.unit}</span> <span class="pill ${unit.state}">${unit.state}</span></span> `)}</dd>
      <dt>Tokens</dt><dd>${!session?.tokens ? "no session in the last two days" : html`
        <span class="data">${count(session.tokens.total)}</span> in its latest session
        <span class="meta">(${count(session.tokens.cached)} of ${count(session.tokens.input)} input cached, ${count(session.tokens.output)} output;
        ${session.model ?? "model unknown"}; started ${stamp(session.startedAt)}, last line ${ago(session.lastAt)})</span><br>
        <span class="data">${count(tokens.day.total)}</span> <span class="meta">in the last 24 h over ${plural(tokens.daySessions, "session")}</span>`}</dd>
    </dl>`;
}

const pictures = new Map(); // name -> { at, url, asked }
const pictureAmbiguous = name => (state.residents?.residents.filter(resident => resident.name.toLowerCase() === name.toLowerCase()).length ?? 0) > 1;
async function loadPicture(name, fresh = false) {
  if (pictureAmbiguous(name)) return;
  const record = pictures.get(name) ?? {};
  pictures.set(name, record);
  if (record.loading) return;
  record.loading = true; record.asked = Date.now();
  try {
    const response = await fetch(`api/picture?resident=${encodeURIComponent(name)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "No picture.");
    const url = URL.createObjectURL(await response.blob());
    if (record.url) URL.revokeObjectURL(record.url);
    Object.assign(record, { url, at: Number(response.headers.get("X-Picture-At")), problem: "" });
  } catch (error) { record.problem = error.message; }
  record.loading = false;
  showPicture(name);
}
function showPicture(name) {
  const ambiguous = pictureAmbiguous(name), record = ambiguous ? {} : pictures.get(name) ?? {};
  for (const box of document.querySelectorAll(`.view[data-name="${CSS.escape(name)}"]`)) {
    const resident = state.residents?.residents.find(entry => entry.name === name && entry.host === box.dataset.host);
    const online = !ambiguous && resident?.status === "online" && !resident.hostUnreachable;
    const image = $("img", box), blank = $(".blank", box);
    if (record.url && image.dataset.url !== record.url) { image.src = record.url; image.dataset.url = record.url; }
    image.hidden = !record.url;
    blank.hidden = Boolean(record.url);
    blank.textContent = ambiguous ? `Pictures are unavailable: ${name} is configured on more than one host. Resolve the duplicate resident name.`
      : resident?.hostUnreachable ? `No current picture: host ${resident.host} is unreachable.`
      : online ? (record.problem || "Fetching what it sees…") : `No current picture: ${name}'s client is unreachable. Server presence is reported separately.`;
    box.classList.toggle("stale", Boolean(record.url) && !online);
    $(".when", box).textContent = record.url ? `${online ? "Seen" : "Last seen"} ${clock(record.at)}` : "";
    $("button", box).hidden = !online;
  }
}

// ---------- Thoughts: reasoning summaries and remarks, in the resident's own words ----------
// A summary section opens with its title in bold (**Checking the wheat**); nothing else of Markdown is used.
function voiceInline(text) {
  return text.split(/\*\*(.+?)\*\*/s).map((part, i) => i % 2 ? html`<b>${part}</b>` : part);
}
/** Title lines become headings in the resident's colour; the rest are paragraphs. */
function voiceBlock(text) {
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
    const title = /^\*\*(.+)\*\*$/.exec(line);
    return title ? html`<b>${title[1]}</b>` : html`<p>${voiceInline(line)}</p>`;
  });
}
const SUMMARIES_OFF = "Reasoning summaries are off for this session";
function musing(resident) {
  const thoughts = resident.thoughts;
  if (!thoughts) return html`<p class="fine">This host does not report thoughts yet.</p>`;
  const latest = thoughts.latest, off = thoughts.summaries === "off";
  if (!latest) return html`<p class="fine">${off ? `${SUMMARIES_OFF}, and it has made no remark yet.` : "No thoughts or remarks in the last two days."}</p>`;
  return html`<button type="button" class="musing" aria-label="Read ${resident.name}'s thoughts in Activity">
    <span class="voice ${latest.kind}">${voiceInline(latest.text.replace(/\s*\n+\s*/g, " "))}</span>
    <span class="meta">${latest.kind === "thought" ? "Thought" : "Remark"} ${ago(latest.t)}${off ? html`; <span class="warn">${SUMMARIES_OFF.toLowerCase()}</span>` : ""}</span>
  </button>`;
}

function renderResidents(data) {
  patch($("#residents"), data.residents, resident => JSON.stringify([resident.host, resident.name]), (card, resident) => {
    if (card.__new) {
      card.__new = false;
      card.className = "card resident";
      card.style.setProperty("--who", colour(resident.name));
      card.innerHTML = html`<header></header>
        <div class="musing-slot"></div>
        <div class="view" data-name="${resident.name}" data-host="${resident.host}"><img alt="What ${resident.name} sees" hidden><p class="blank"></p>
          <div class="bar"><span class="when"></span><button type="button">Refresh picture</button></div></div>
        <div class="info"></div>`.text;
      $(".view button", card).onclick = () => loadPicture(resident.name, true);
      $(".musing-slot", card).onclick = event => { if (event.target.closest(".musing")) openThoughts(resident.name); };
    }
    const words = {
      online: `looked ${ago(resident.checkedAt)}`,
      offline: resident.lastOnlineAt ? `client last reachable ${stamp(resident.lastOnlineAt)} (${ago(resident.lastOnlineAt)})` : "client not reached since this app started watching",
      unchecked: "not looked at yet",
    }[resident.status] ?? resident.detail;
    const health = resident.sessionHealth;
    setHtml($("header", card), html`<h2>${resident.name}</h2>
      <span class="${resident.hostUnreachable ? "error" : "meta"}">Host: ${resident.host}${resident.hostUnreachable ? " — host unreachable; showing cached data" : ""}.
        ${resident.hostLastSeen !== null ? `Host last seen ${stamp(resident.hostLastSeen)} (${ago(resident.hostLastSeen)}).` : "Host not reached yet."}</span>
      <span class="pill ${resident.hostUnreachable ? "offline" : resident.status}">${resident.hostUnreachable ? `last known client ${resident.status}` : `client ${resident.status}`}</span><span class="meta">${words}</span>
      ${health ? html`<p class="${["paused", "failed"].includes(health.status) ? "error" : "fine"}">
        Session ${health.status}: ${health.reason || "body health watched"}.
        ${health.auto_restart ? `Automatic recovery enabled. Stops ${stamp(health.end_at * 1000)}.` : ""}
        ${health.restart_count ? `Restarts: ${health.restart_count}.` : ""}
        ${health.next_retry_at ? `Retry ${stamp(health.next_retry_at * 1000)}.` : ""}
        Recorded ${ago(health.updated_at * 1000)}.</p>` : ""}`);
    setHtml($(".musing-slot", card), musing(resident));
    setHtml($(".info", card), residentInfo(resident, data.observer));
  }, "article");
  // After the cards are in the page: a new card is filled before it is attached.
  for (const resident of data.residents) showPicture(resident.name);

  const quota = data.quota;
  setHtml($("#shared"), html`
    ${(data.federationErrors ?? []).map(error => html`<p class="error" role="alert">Federation: ${error}</p>`)}
    ${data.sharedUnits.map(unit => html`<span class="unit"><span class="data">${unit.unit}</span> <span class="pill ${unit.state}">${unit.state}</span></span>`)}
    ${quota ? html`<span>Codex quota: ${quota.usedPercent}% of the ${quota.windowMinutes ? `${Math.round(quota.windowMinutes / 1440)}-day` : ""} window used${
      quota.resetsAt ? `, resets ${stamp(quota.resetsAt)}` : ""} (read ${ago(quota.at)})</span>` : ""}
    ${data.observer ? html`<span>Server observer: ${data.observer.status}${data.observer.detail ? ` — ${data.observer.detail}` : ""}.</span>` : ""}
    <span>State and position are read every ${data.sampleSeconds} s; pictures at most every ${data.pictureSeconds} s while this panel is open.</span>`);
}

async function loadResidents() {
  const data = await get("api/residents");
  skew = data.now - Date.now();
  const first = !state.residents;
  state.residents = data;
  state.names = data.residents.map(resident => resident.name);
  liveView.updateResidents(data);
  const online = data.residents.filter(resident => resident.status === "online" && !resident.hostUnreachable).length;
  $("#pulse").textContent = `${online} of ${data.residents.length} clients reachable, read ${clock(data.now)}`;
  renderResidents(data);
  setChat(data.chatUrl);
  setBadge("commons", data.pending);
  if (first) drawTabs();
}
function residentsTick() {
  if (state.active !== "residents" || !state.residents) return;
  for (const resident of state.residents.residents) {
    const record = pictures.get(resident.name);
    if (!pictureAmbiguous(resident.name) && !resident.hostUnreachable && resident.status === "online" && Date.now() - (record?.asked ?? 0) >= state.residents.pictureSeconds * 1000) void loadPicture(resident.name);
  }
}

// ---------- Activity ----------
const activity = { boot: "", after: 0, entries: new Map(), who: "All", quiet: false, summary: [], first: true,
  view: "all", older: new Map() }; // older: name -> { at, thoughts } from api/thoughts
const EVENT_WORDS = { died: "died", stopped_short: "stopped short", navigation_stopped: "nav stopped", reflex: "reflex", chat: "heard", player_near: "player near", player_gone: "player gone" };

function feedRow(entry) {
  let kind = entry.kind, what, cls = entry.kind;
  if (entry.kind === "call" || entry.kind === "said") {
    kind = entry.kind === "said" ? "said" : entry.tool === "shell" ? "shell" : "did";
    const result = entry.result && entry.result !== "Sent." ? html`<span class="result">${entry.result}</span>` : "";
    what = entry.kind === "said" ? html`“${entry.text}”${entry.error ? result : ""}`
      : html`<b class="data">${entry.tool}</b> <span class="data">${entry.args}</span>${entry.ms >= 1000 ? html` <span class="meta">${(entry.ms / 1000).toFixed(1)} s</span>` : ""}${result}`;
    if (entry.error) cls += " alarm";
  } else if (entry.kind === "event") {
    kind = EVENT_WORDS[entry.type] ?? entry.type.replaceAll("_", " ");
    const chat = entry.type === "chat" && /^from=(\S+) text=(.*)$/s.exec(entry.text);
    // "text=" is the event's only field for reflex and Baritone lines; the label already says what it is.
    what = chat ? html`<b>${chat[1]}</b>: ${chat[2]}` : html`<span class="data">${entry.text.replace(/^text=/, "")}</span>`;
    cls += entry.type === "died" ? " alarm" : entry.type === "chat" ? " heard" : "";
  } else {
    kind = { remark: "remark", answer: "answered", thought: "thought", prompt: "told" }[entry.kind] ?? entry.kind;
    what = entry.kind === "thought" || entry.kind === "remark" ? html`${voiceInline(entry.text)}` : html`${entry.text}`;
  }
  const long = (entry.text ?? "").length + (entry.result ?? "").length > 260;
  return { cls: `${cls}${entry.quiet ? " quiet" : ""}${long ? " long" : ""}`, markup: html`<time title="${stamp(entry.t)}">${clock(entry.t)}</time><span class="kind">${kind}</span><span class="what">${what}</span>` };
}

function signsCard(card, info) {
  const s = info.indicators, session = info.sessions[0];
  card.className = "card";
  card.style.setProperty("--who", colour(info.name));
  const stuck = s.stoppedShort + s.navigationStopped;
  setHtml(card, html`
    <header><h2>${info.name}</h2><span class="meta">last ${s.windowMinutes} min${session ? `; session started ${stamp(session.startedAt)}, ${session.model ?? "model unknown"}` : "; no session in the last two days"}</span></header>
    <div class="figures">
      <div class="figure"><b>${count(s.calls)}</b><span>tool calls${s.errors ? html`, <span class="bad">${plural(s.errors, "error")}</span>` : ""}</span></div>
      <div class="figure"><b class="${stuck > s.arrived ? "warn" : ""}">${s.arrived} / ${stuck}</b><span>arrived / stopped (${s.stoppedShort} short, ${s.navigationStopped} by a hazard)</span></div>
      <div class="figure"><b class="${s.deaths ? "bad" : ""}">${s.deaths}</b><span>${s.deaths === 1 ? "death" : "deaths"}; ${plural(s.reflexes, "reflex line")}, hurt ${s.hurt}×</span></div>
      <div class="figure"><b>${s.said} / ${s.chatHeard}</b><span>chat lines said / heard</span></div>
    </div>
    <p class="repeats">${s.repeats.length === 0 ? html`<span class="meta">No action was repeated back to back.</span>` : html`Same action back to back:
      ${s.repeats.map((repeat, i) => html`${i ? "; " : " "}<span class="data ${repeat.times >= 3 ? "warn" : ""}">${repeat.action} ×${repeat.times}</span> <span class="meta">(last ${clock(repeat.lastAt, false)})</span>`)}`}</p>
    ${s.byTool.length ? html`<details data-d="tools:${info.name}"><summary>Calls by tool</summary><div class="chips">${s.byTool.map(tool => html`<span class="data">${tool.tool} ${tool.count}</span>`)}</div></details>` : ""}`);
}

// Thoughts view: each thought or remark, then what the resident did until its next one, oldest first
// inside a group so it reads thought → action; groups newest first like the feed.
function musingGroups(mine) {
  const groups = [], open = new Map();
  for (const entry of [...mine].sort((a, b) => a.t - b.t || a.id - b.id)) {
    if (entry.kind === "thought" || entry.kind === "remark") {
      const group = { key: `e${entry.id}`, thought: entry, then: [] };
      open.set(entry.resident, group); groups.push(group);
    } else if (entry.kind !== "prompt" && (activity.quiet || !entry.quiet)) open.get(entry.resident)?.then.push(entry);
  }
  for (const group of open.values()) group.last = true;
  return groups.reverse();
}
function musingMarkup(item) {
  const { thought, then } = item;
  const head = html`<div class="musing-head"><time title="${stamp(thought.t)}">${clock(thought.t)}</time>${activity.who === "All" ? html`<span class="who">${thought.resident}</span>` : ""}<span>${thought.kind}</span></div>
    <div class="voice ${thought.kind}">${voiceBlock(thought.text)}</div>`;
  if (!then) return head;
  const row = entry => { const { cls, markup } = feedRow(entry); return html`<li class="${cls}">${markup}</li>`; };
  const first = then.slice(0, 8), rest = then.slice(8);
  if (!then.length) return html`${head}<p class="then-none meta">${item.last ? "Nothing done since." : "Nothing done before the next one."}</p>`;
  return html`${head}<ol class="feed then">${first.map(row)}</ol>
    ${rest.length ? html`<details data-d="then:${item.key}"><summary>${plural(rest.length, "more line")}</summary><ol class="feed then">${rest.map(row)}</ol></details>` : ""}`;
}
function renderMusings(mine) {
  const off = activity.summary.filter(info => (activity.who === "All" || info.name === activity.who) && info.sessions[0]?.summaries === "off");
  const note = $("#musings-note");
  note.hidden = off.length === 0;
  setHtml(note, html`${off.map(info => html`<p class="fine summaries-off">Reasoning summaries are off for ${info.name}'s current session, so only its remarks appear.
    Summaries begin when a session starts or resumes with <code>model_reasoning_summary</code> set in the residents' Codex config.</p>`)}`);
  const groups = musingGroups(mine).slice(0, 150);
  // Older thoughts, from the resident's own host: what it did between them is older than this page holds.
  const floor = mine.length ? Math.min(...mine.map(entry => entry.t)) : Infinity;
  const older = activity.who === "All" ? [] : (activity.older.get(activity.who)?.thoughts ?? []).filter(thought => thought.t < floor)
    .map(thought => ({ key: `o${thought.t}:${thought.kind}:${thought.text.length}`, thought: { ...thought, resident: activity.who }, then: null }));
  const items = [...groups, ...(older.length ? [{ key: "earlier" }, ...older] : [])];
  patch($("#musings"), items, item => item.key, (li, item) => {
    if (!item.thought) {
      li.className = "musing-earlier";
      li.textContent = `Earlier thoughts. What ${activity.who} did between them is older than this page holds.`;
      return;
    }
    li.className = `musing-group${li.__new && !activity.first ? " fresh" : ""}`;
    li.__new = false;
    li.style.setProperty("--who", colour(item.thought.resident));
    setHtml(li, musingMarkup(item));
  }, "li");
  return items.length;
}

function renderActivity() {
  segmented($("#activity-who"), [{ value: "All", label: "All" }, ...state.names.map(name => ({ value: name, label: name, who: name }))], activity.who, value => { activity.who = value; renderActivity(); void loadOlderThoughts(); });
  segmented($("#activity-view"), [{ value: "all", label: "Everything" }, { value: "thoughts", label: "Thoughts" }], activity.view, value => { activity.view = value; renderActivity(); void loadOlderThoughts(); });
  patch($("#signs"), activity.summary.filter(info => activity.who === "All" || info.name === activity.who), info => info.name, signsCard, "article");
  const thinking = activity.view === "thoughts";
  $("#feed").hidden = thinking;
  $("#musings").hidden = !thinking;
  if (!thinking) $("#musings-note").hidden = true;
  const mine = [...activity.entries.values()].filter(entry => activity.who === "All" || entry.resident === activity.who);
  const empty = $("#feed-empty");
  if (thinking) {
    empty.hidden = renderMusings(mine) > 0;
    empty.textContent = "No thoughts or remarks yet in what this page holds. They appear as the residents' sessions write them.";
    return;
  }
  const shown = mine.filter(entry => activity.quiet || !entry.quiet).sort((a, b) => b.t - a.t || b.id - a.id).slice(0, 300);
  patch($("#feed"), shown, entry => entry.id, (row, entry) => {
    if (!row.__new) return; // entries never change once recorded
    row.__new = false;
    const { cls, markup } = feedRow(entry);
    row.className = `${cls}${activity.first ? "" : " fresh"}`;
    row.style.setProperty("--who", colour(entry.resident));
    row.innerHTML = markup.text;
  }, "li");
  empty.hidden = shown.length > 0;
  empty.textContent = activity.entries.size ? "Only routine lines here (status, wait, arrivals). Tick “Routine lines too” to see them."
    : "No session in the last two days. Lines appear here as soon as a resident's session starts writing.";
}
for (const list of ["#feed", "#musings"]) $(list).addEventListener("click", event => event.target.closest("li.long")?.classList.toggle("open"));
$("#activity-quiet").addEventListener("change", event => { activity.quiet = event.target.checked; renderActivity(); });

/** From a resident's card: its thoughts, each followed by what it did. */
function openThoughts(name) {
  activity.who = name; activity.view = "thoughts";
  show("activity");
  renderActivity();
  void loadOlderThoughts();
}
/** Thoughts older than the loaded activity, for one resident, from its own host; at most every 30 s. */
async function loadOlderThoughts() {
  const who = activity.who;
  if (activity.view !== "thoughts" || who === "All" || Date.now() - (activity.older.get(who)?.at ?? 0) < 30_000) return;
  activity.older.set(who, { at: Date.now(), thoughts: activity.older.get(who)?.thoughts ?? [] });
  try {
    const data = await get(`api/thoughts?resident=${encodeURIComponent(who)}`);
    activity.older.set(who, { at: Date.now(), thoughts: data.thoughts });
  } catch { /* the newest thoughts are still in the activity feed; older ones are tried again later */ }
  if (activity.view === "thoughts" && activity.who === who) renderActivity();
}

async function loadActivity() {
  const data = await get(`api/activity?boot=${encodeURIComponent(activity.boot)}&after=${activity.after}&limit=500`);
  if (data.boot !== activity.boot) {
    // The app restarted, or read a file again from its start: the numbers of the rows on screen now belong to other entries, or to none.
    activity.entries.clear(); activity.after = 0; activity.boot = data.boot; activity.first = true;
    $("#feed").replaceChildren(); $("#musings").replaceChildren();
  }
  for (const entry of data.entries) { activity.entries.set(entry.id, entry); activity.after = Math.max(activity.after, entry.id); }
  if (activity.entries.size > 2000) {
    const keep = [...activity.entries.values()].sort((a, b) => b.t - a.t).slice(0, 1500);
    activity.entries = new Map(keep.map(entry => [entry.id, entry]));
  }
  activity.summary = data.residents;
  renderActivity();
  activity.first = false;
  void loadOlderThoughts();
}

// ---------- Map ----------
// One dimension at a time; trails coloured by height (or by resident), a two-ended height
// filter, and a side-on elevation profile for one resident. Choices survive reloads.
const MAP_KEY = "commons.map";
const mapSaved = (() => { try { return JSON.parse(localStorage.getItem(MAP_KEY)) ?? {}; } catch { return {}; } })();
const map = { hours: 6, data: null, cx: 0, cz: 0, scale: 2, fitted: false, pointers: new Map(), moved: 0,
  features: [], trails: [], places: [], visiblePlaces: [], selected: null, who: "All", search: "", failedPicture: null, canvas: $("#map"),
  dimensions: ["overworld"],
  // The chosen dimension; while it has nothing in the window the Overworld is shown and the choice is kept.
  want: typeof mapSaved.dimension === "string" ? mapSaved.dimension : "overworld", dimension: "overworld",
  colourBy: mapSaved.colourBy === "resident" ? "resident" : "height",
  heights: mapSaved.heights && typeof mapSaved.heights === "object" ? mapSaved.heights : {},
  profileWho: typeof mapSaved.profileWho === "string" ? mapSaved.profileWho : null,
  profileAxis: mapSaved.profileAxis === "distance" ? "distance" : "time",
  profile: null, profileHover: -1, profileFeatures: [], profileCanvas: $("#map-profile"), pin: null, queued: false };
function saveMap() {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify({ dimension: map.want, colourBy: map.colourBy, heights: map.heights,
      profileWho: map.profileWho, profileAxis: map.profileAxis }));
  } catch { /* private mode: choices last for this page only */ }
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const canvasColour = name => css(name === "shared" ? "--shared" : `--c${Math.max(0, state.names.indexOf(name)) % 4}`);
const toScreen = (x, z) => [(x - map.cx) * map.scale + map.canvas.clientWidth / 2, (z - map.cz) * map.scale + map.canvas.clientHeight / 2];
const toWorld = (sx, sy) => [(sx - map.canvas.clientWidth / 2) / map.scale + map.cx, (sy - map.canvas.clientHeight / 2) / map.scale + map.cz];
const placeKey = place => JSON.stringify([place.owner, place.dimension, place.name]);
const placeOwner = place => place.owner === "shared" ? `Shared${place.author ? ` · saved by ${place.author}` : ""}` : `${place.owner}'s place`;
const placeCoordinates = place => `x ${place.x}, y ${place.y}, z ${place.z}`;
/** "x 30, z -22 (Overworld ≈ 240, -176)": the linked dimension's equivalent, for portal building. */
function whereText(dimension, x, z) {
  const other = equivalent(dimension, x, z);
  return `x ${Math.round(x)}, z ${Math.round(z)}${other ? ` (${dimensionLabel(other.dimension)} ≈ ${other.x}, ${other.z})` : ""}`;
}
const PORTAL = "#b07cff";
const BAND_TINT = { the_nether: "rgba(229,100,90,.14)", the_end: "rgba(180,139,224,.16)" };

function heightRange() {
  const [min, max] = heightDomain(map.dimension), saved = map.heights[map.dimension];
  const lo = Number.isFinite(saved?.[0]) ? Math.max(min, Math.min(max, saved[0])) : min;
  const hi = Number.isFinite(saved?.[1]) ? Math.max(lo, Math.min(max, saved[1])) : max;
  return [lo, hi];
}
/** Trails of the shown dimension inside the height filter, merged and grouped by drawing style. */
function rebuildTrails() {
  const [min, max] = heightDomain(map.dimension), [lo, hi] = heightRange();
  const low = lo <= min ? -Infinity : lo, high = hi >= max ? Infinity : hi;
  map.trails = (map.data?.residents ?? []).map(resident => {
    const runs = resident.legs.filter(leg => leg.dimension === map.dimension).flatMap(leg => splitByHeight(leg.points, low, high));
    const groups = new Map();
    for (const edge of mergeMapTrail(runs)) {
      const y = edge.y === null ? null : Math.round(edge.y / 4) * 4, key = `${y}|${edge.width}`;
      if (!groups.has(key)) groups.set(key, { y, width: edge.width, edges: [] });
      groups.get(key).edges.push(edge);
    }
    // Lower first, so higher routes are drawn over what lies beneath them.
    return { name: resident.name, groups: [...groups.values()].sort((a, b) => (a.y ?? -Infinity) - (b.y ?? -Infinity)) };
  });
}
function setDimension(dimension) {
  map.want = map.dimension = dimension; map.fitted = false; saveMap();
  $("#map-readout").textContent = `${dimensionLabel(dimension)}: move over the map for coordinates.`;
  rebuildTrails();
}
function showOnMap(dimension, x, z) {
  if (!map.dimensions.includes(dimension)) return;
  if (dimension !== map.dimension) setDimension(dimension);
  map.pin = { dimension, x, z };
  map.cx = x; map.cz = z; map.scale = Math.max(map.scale, 1); map.fitted = true;
  renderMap();
}
/** Coalesce slider and pointer input into one redraw per frame. */
function scheduleMap(rebuild = false) {
  map.rebuild ||= rebuild;
  if (map.queued) return;
  map.queued = true;
  requestAnimationFrame(() => {
    map.queued = false;
    if (map.rebuild) { map.rebuild = false; rebuildTrails(); }
    drawMap();
  });
}

function renderMapSelection() {
  const panel = $("#map-selection"), place = map.places.find(place => place.key === map.selected);
  panel.style.setProperty("--who", place ? colour(place.owner) : "var(--lichen)");
  if (!place) {
    setHtml(panel, html`<p class="fine">${map.selected ? "This saved place is no longer available." : "Select a dot or a place in the list to centre it on the map and read its note."}</p>`);
    return;
  }
  const picture = place.picture, other = equivalent(place.dimension, place.x, place.z);
  setHtml(panel, html`<h3>${place.name}</h3><p class="data">${placeCoordinates(place)} · ${dimensionLabel(place.dimension)}</p>
    ${other ? html`<p class="meta">${dimensionLabel(other.dimension)} equivalent ≈ x ${other.x}, z ${other.z}</p>` : ""}
    <p class="meta">${placeOwner(place)}</p>
    ${map.visiblePlaces.some(item => item.key === place.key) ? "" : html`<p class="fine">This selection is hidden by the saved-place filter.</p>`}
    ${place.note ? html`<p class="map-place-note">${place.note}</p>` : ""}
    ${picture && picture.id !== map.failedPicture ? html`<figure class="map-place-picture">
      <img src="api/map-picture?id=${encodeURIComponent(picture.id)}" alt="${picture.resident}'s view near ${place.name} shortly after save" loading="lazy">
      <figcaption class="fine">${picture.resident}'s view near this place shortly after save (${stamp(picture.at)}).
        Not necessarily looking at the landmark or the exact historical save frame.</figcaption></figure>` : html`<p class="fine">No saved picture available.</p>`}`);
  const image = $("img", panel);
  if (image) image.onerror = () => {
    // Expired or missing captures are normal, not a dashboard failure.
    if (map.selected !== place.key) return;
    map.failedPicture = picture.id; renderMapSelection();
  };
}

function renderMapPlaces() {
  const owners = [...new Set([...(map.data?.residents ?? []).map(resident => resident.name), ...map.places.map(place => place.owner)])]
    .filter(owner => owner !== "shared");
  segmented($("#map-who"), [{ value: "All", label: "All" },
    ...owners.map(owner => ({ value: owner, label: owner, who: owner })), { value: "shared", label: "Shared", who: "shared" }],
  map.who, value => { map.who = value; renderMapPlaces(); drawMap(); });
  const query = map.search.trim().toLocaleLowerCase(), here = map.places.filter(place => place.dimension === map.dimension);
  map.visiblePlaces = here.filter(place => (map.who === "All" || map.who === place.owner) && (!query || place.search.includes(query)));
  $("#map-place-count").textContent = map.visiblePlaces.length
    ? `${map.visiblePlaces.length} of ${here.length} saved places in the ${dimensionLabel(map.dimension)}`
    : here.length ? "No saved places match. Change the owner filter or search." : `No saved places in the ${dimensionLabel(map.dimension)} yet.`;
  const grouped = new Map();
  for (const place of map.visiblePlaces) {
    if (!grouped.has(place.owner)) grouped.set(place.owner, []);
    grouped.get(place.owner).push(place);
  }
  patch($("#map-place-list"), [...grouped], group => group[0], (section, [owner, places]) => {
    section.className = "map-place-group";
    section.style.setProperty("--who", colour(owner));
    if (section.__new) { setHtml(section, html`<h3></h3><div role="group"></div>`); section.__new = false; }
    $("h3", section).textContent = `${owner === "shared" ? "Shared" : owner} (${places.length})`;
    const rows = $("div", section);
    rows.setAttribute("aria-label", owner === "shared" ? "Shared places" : `${owner}'s places`);
    patch(rows, places, place => place.key, (button, place) => {
      button.type = "button"; button.className = "map-place-row";
      button.dataset.place = place.key;
      button.setAttribute("aria-pressed", String(place.key === map.selected));
      setHtml(button, html`<b>${place.name}</b><span class="data">${placeCoordinates(place)}</span>
        ${place.author ? html`<span class="meta">Saved by ${place.author}</span>` : ""}
        ${place.note ? html`<span class="meta map-place-note">${place.note}</span>` : ""}`);
    }, "button");
  }, "section");
  renderMapSelection();
}

function selectMapPlace(key) {
  const place = map.places.find(place => place.key === key);
  if (!place) return;
  if (place.dimension !== map.dimension && map.dimensions.includes(place.dimension)) setDimension(place.dimension);
  map.selected = key; map.cx = place.x; map.cz = place.z; map.fitted = true;
  renderMapPlaces(); drawMap();
  $("#map-readout").textContent = `${place.name}: ${placeCoordinates(place)}`;
}

function fitMap() {
  const points = [], dimension = map.dimension;
  for (const resident of map.data?.residents ?? []) {
    for (const leg of resident.legs) if (leg.dimension === dimension) for (const point of leg.points) points.push([point[1], point[3]]);
    if (resident.position && resident.dimension === dimension) points.push([resident.position.x, resident.position.z]);
    for (const crossing of resident.crossings) for (const end of [crossing.from, crossing.to]) if (end.dimension === dimension) points.push([end.x, end.z]);
  }
  for (const list of [map.data?.places, map.data?.deaths, map.data?.alarms]) {
    for (const item of list ?? []) if (item.dimension === dimension) points.push([item.x, item.z]);
  }
  if (!points.length) { map.cx = 0; map.cz = 0; map.scale = 2; return; }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  map.cx = (minX + maxX) / 2; map.cz = (minZ + maxZ) / 2;
  const room = Math.max(40, Math.min(map.canvas.clientWidth, map.canvas.clientHeight) * 0.16);
  map.scale = Math.min(12, Math.max(0.02, Math.min(
    (map.canvas.clientWidth - room) / Math.max(16, maxX - minX), (map.canvas.clientHeight - room) / Math.max(16, maxZ - minZ))));
}
function zoomAt(sx, sy, factor) {
  const [wx, wz] = toWorld(sx, sy);
  map.scale = Math.min(32, Math.max(0.01, map.scale * factor));
  map.cx = wx - (sx - map.canvas.clientWidth / 2) / map.scale;
  map.cz = wz - (sy - map.canvas.clientHeight / 2) / map.scale;
  drawMap();
}

function drawMap() {
  const canvas = map.canvas, width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const ink = css("--parchment"), faint = css("--lichen"), soft = css("--seam-soft"), dimension = map.dimension;
  ctx.font = `11px ${css("--data")}`;
  ctx.textBaseline = "middle";

  // Grid: the smallest power-of-two step (from one chunk, 16 blocks) that keeps lines a thumb apart.
  let step = 16;
  while (step * map.scale < 56) step *= 2;
  const [left, top] = toWorld(0, 0), [right, bottom] = toWorld(width, height);
  ctx.lineWidth = 1;
  for (let x = Math.floor(left / step) * step; x <= right; x += step) {
    const [sx] = toScreen(x, 0);
    ctx.strokeStyle = x === 0 ? faint : soft;
    ctx.beginPath(); ctx.moveTo(Math.round(sx) + .5, 0); ctx.lineTo(Math.round(sx) + .5, height); ctx.stroke();
    ctx.fillStyle = faint; ctx.textAlign = "left"; ctx.fillText(String(x), sx + 3, 8);
  }
  for (let z = Math.floor(top / step) * step; z <= bottom; z += step) {
    const [, sy] = toScreen(0, z);
    ctx.strokeStyle = z === 0 ? faint : soft;
    ctx.beginPath(); ctx.moveTo(0, Math.round(sy) + .5); ctx.lineTo(width, Math.round(sy) + .5); ctx.stroke();
    if (sy > 16) { ctx.fillStyle = faint; ctx.textAlign = "left"; ctx.fillText(String(z), 3, sy - 7); }
  }
  ctx.fillStyle = "rgba(20,23,27,.85)"; ctx.fillRect(0, height - 20, 236, 20);
  ctx.fillStyle = faint; ctx.textAlign = "left";
  ctx.fillText(`${dimensionLabel(dimension)} · grid ${step} blocks · x → east, z ↓ south`.slice(0, 70), 6, height - 10);

  map.features = [];
  const label = (text, sx, sy, colourValue, bold = false) => {
    ctx.font = `${bold ? "bold " : ""}12px ${css("--ui")}`; ctx.textAlign = "left";
    ctx.lineWidth = 3; ctx.strokeStyle = "#14171b"; ctx.strokeText(text, sx + 9, sy);
    ctx.fillStyle = colourValue; ctx.fillText(text, sx + 9, sy);
  };
  const off = (sx, sy, margin = 12) => sx < -margin || sx > width + margin || sy < -margin || sy > height + margin;
  // With height colours one resident (the profile's) is drawn fully and the others faintly, under it.
  const focus = map.colourBy === "height" ? map.profileWho : null;
  ctx.lineCap = "round";
  for (const resident of [...map.trails].sort((a, b) => Number(a.name === focus) - Number(b.name === focus))) {
    ctx.globalAlpha = focus && resident.name !== focus ? .3 : .85;
    for (const group of resident.groups) {
      ctx.strokeStyle = map.colourBy === "height" ? heightColour(group.y) : canvasColour(resident.name);
      ctx.lineWidth = group.width; ctx.beginPath();
      let any = false;
      for (const edge of group.edges) {
        const [x1, y1] = toScreen(edge.x1, edge.z1), [x2, y2] = toScreen(edge.x2, edge.z2);
        if (Math.max(x1, x2) < -5 || Math.min(x1, x2) > width + 5 || Math.max(y1, y2) < -5 || Math.min(y1, y2) > height + 5) continue;
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); any = true;
      }
      if (any) ctx.stroke();
    }
  }
  ctx.globalAlpha = 1; ctx.lineCap = "butt";
  for (const place of map.visiblePlaces) {
    const [sx, sy] = toScreen(place.x, place.z), tint = canvasColour(place.owner);
    if (off(sx, sy)) continue;
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fillStyle = tint; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#14171b"; ctx.stroke();
    map.features.push({ sx, sy, key: place.key, text: `${place.name} (${placeOwner(place)}, ${placeCoordinates(place)})${place.note ? `: ${place.note}` : ""}` });
  }
  const selected = map.visiblePlaces.find(place => place.key === map.selected);
  if (selected) {
    const [sx, sy] = toScreen(selected.x, selected.z);
    ctx.beginPath(); ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.stroke();
  }
  // Dimension changes: the end on this map, linked to the other side.
  for (const resident of map.data?.residents ?? []) {
    for (const crossing of resident.crossings) {
      for (const [here, there, verb] of [[crossing.from, crossing.to, "left for"], [crossing.to, crossing.from, "arrived from"]]) {
        if (here.dimension !== dimension) continue;
        const [sx, sy] = toScreen(here.x, here.z);
        if (off(sx, sy)) continue;
        ctx.beginPath(); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx + 7, sy); ctx.lineTo(sx, sy + 7); ctx.lineTo(sx - 7, sy); ctx.closePath();
        ctx.fillStyle = canvasColour(resident.name); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = PORTAL; ctx.stroke();
        map.features.push({ sx, sy, go: there, text: `${resident.name} ${verb} the ${dimensionLabel(there.dimension)} here (y ${here.y}), ${stamp(crossing.at)}, ${crossing.kind === "respawn" ? "respawning after a death" : "probably by portal"}; other side ${dimensionLabel(there.dimension)} ${there.x}, ${there.y}, ${there.z}. Select to go there.` });
      }
    }
  }
  for (const death of map.data?.deaths ?? []) {
    if (death.dimension !== dimension) continue;
    const [sx, sy] = toScreen(death.x, death.z);
    ctx.strokeStyle = css("--redstone"); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5); ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5); ctx.stroke();
    map.features.push({ sx, sy, text: `${death.resident} died here, y ${death.y}, ${stamp(death.at)}` });
  }
  for (const alarm of map.data?.alarms ?? []) {
    if (alarm.dimension !== dimension) continue;
    const [sx, sy] = toScreen(alarm.x, alarm.z);
    if (off(sx, sy)) continue;
    ctx.beginPath(); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx + 7, sy + 5); ctx.lineTo(sx - 7, sy + 5); ctx.closePath();
    ctx.fillStyle = css("--glow"); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#14171b"; ctx.stroke();
    map.features.push({ sx, sy, text: `${alarm.resident} shouted for help (${alarm.kind}): ${alarm.reason}, y ${alarm.y}, ${stamp(alarm.at)}` });
  }
  if (map.pin?.dimension === dimension) {
    const [sx, sy] = toScreen(map.pin.x, map.pin.z);
    ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  }
  // Residents last, so a marker is never hidden under a place it stands on; its name goes above it.
  for (const resident of map.data?.residents ?? []) {
    const tint = canvasColour(resident.name), now = resident.position && resident.dimension === dimension ? resident.position : null;
    const leg = resident.legs.findLast(leg => leg.dimension === dimension && leg.points.length), last = leg?.points[leg.points.length - 1];
    const here = now ? [now.x, now.z] : last ? [last[1], last[3]] : undefined;
    if (!here) continue;
    const [sx, sy] = toScreen(here[0], here[1]);
    ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = "#14171b";
    if (now) { ctx.fillStyle = tint; ctx.fill(); ctx.stroke(); } else { ctx.strokeStyle = tint; ctx.stroke(); }
    const name = now ? `${resident.name} · y ${Math.round(now.y)}${coverOf(dimension, now.y, now.sky).underground ? ", underground" : ""}` : `${resident.name} (last sample)`;
    ctx.font = `bold 12px ${css("--ui")}`;
    label(name, sx - 9 - ctx.measureText(name).width / 2, sy - 15, tint, true);
    map.features.push({ sx, sy, text: now
      ? `${resident.name} is here now: y ${Math.round(now.y)}, ${coverOf(dimension, now.y, now.sky).label}`
      : `${resident.name}'s last sample on this map: y ${last[2]}, ${stamp(last[0])}` });
  }
}
function nearestFeature(sx, sy, wanted = () => true) {
  let nearest, best = 18;
  for (const feature of map.features) {
    if (!wanted(feature)) continue;
    const distance = Math.hypot(feature.sx - sx, feature.sy - sy);
    if (distance < best) { best = distance; nearest = feature; }
  }
  return nearest;
}
function readout(sx, sy) {
  const [x, z] = toWorld(sx, sy), nearest = nearestFeature(sx, sy);
  $("#map-readout").textContent = `${whereText(map.dimension, x, z)}${nearest ? `   ${nearest.text}` : ""}`;
}

function renderHeights() {
  const [min, max] = heightDomain(map.dimension), [lo, hi] = heightRange(), all = lo <= min && hi >= max;
  for (const [input, value] of [[$("#map-lo"), lo], [$("#map-hi"), hi]]) { input.min = String(min); input.max = String(max); input.value = String(value); }
  const at = y => `${((y - min) / (max - min) * 100).toFixed(2)}%`;
  const ramp = Array.from({ length: 13 }, (_, i) => `${heightColour(min + (max - min) * i / 12)} ${(i / 12 * 100).toFixed(2)}%`).join(", ");
  $("#map-height .dual-track").style.background = `linear-gradient(to right, rgba(20,23,27,.82) ${at(lo)}, transparent ${at(lo)} ${at(hi)}, rgba(20,23,27,.82) ${at(hi)}), linear-gradient(to right, ${ramp})`;
  $("#map-height-value").textContent = all ? `all, y ${min} to ${max}` : `y ${lo} to ${hi}`;
  $("#map-h-all").setAttribute("aria-pressed", String(all));
  $("#map-h-under").hidden = map.dimension !== "overworld";
  $("#map-h-under").setAttribute("aria-pressed", String(lo <= min && hi === SEA_LEVEL - 1));
}
function setHeights(range) {
  if (range) map.heights[map.dimension] = range; else delete map.heights[map.dimension];
  saveMap(); renderHeights(); scheduleMap(true);
}

function residentWhere(resident) {
  if (!resident.position || !resident.dimension) return resident.online ? "online, position unknown" : "offline";
  const p = resident.position, here = resident.dimension === map.dimension;
  return `${dimensionLabel(resident.dimension)} ${whereText(resident.dimension, p.x, p.z)}, y ${Math.round(p.y)}, ${coverOf(resident.dimension, p.y, p.sky).label}${here ? "" : " (not on this map)"}`;
}
function renderMap() {
  const data = map.data;
  segmented($("#map-hours"), data.choices.map(hours => ({ value: String(hours), label: hours < 24 ? `${hours} h` : `${hours / 24} d` })), String(map.hours), value => {
    map.hours = Number(value); panels.find(panel => panel.id === "map").at = 0; tick();
  });
  segmented($("#map-dim"), map.dimensions.map(key => ({ value: key, label: dimensionLabel(key) })), map.dimension, value => { setDimension(value); renderMap(); });
  segmented($("#map-colour"), [{ value: "height", label: "Height" }, { value: "resident", label: "Resident" }], map.colourBy, value => {
    map.colourBy = value; saveMap(); renderMap();
  });
  renderHeights();
  const [min, max] = heightDomain(map.dimension);
  const ticks = [min, 0, SEA_LEVEL, 128, 256, max].filter((y, i, all) => y >= min && y <= max && all.indexOf(y) === i);
  const ramp = Array.from({ length: 13 }, (_, i) => `${heightColour(min + (max - min) * i / 12)} ${(i / 12 * 100).toFixed(2)}%`).join(", ");
  setHtml($("#map-legend"), html`${data.residents.map(resident => html`<span class="key" style="--who:${colour(resident.name)}"><i></i>${resident.name}: ${residentWhere(resident)}</span>`)}
    ${map.colourBy === "height" ? html`<span class="height-key" role="img" aria-label="Trail colour by height, from y ${min} to y ${max}"><span class="ramp" style="background:linear-gradient(to right, ${ramp})">${ticks.map(y =>
      html`<span style="left:${((y - min) / (max - min) * 100).toFixed(2)}%">${y === SEA_LEVEL ? "63 sea" : y}</span>`)}</span></span>` : ""}
    <span>● saved place (pale: shared)</span><span class="bad">✕ death</span><span class="warn">▲ alarm</span><span class="portal">◆ dimension change</span>
    ${map.colourBy === "height" && map.profileWho ? html`<span>${map.profileWho}'s trail drawn over the others' (choose under Elevation)</span>` : ""}`);
  renderMapPlaces();
  if (!map.fitted && map.canvas.clientWidth) { fitMap(); map.fitted = true; }
  drawMap();
  renderProfile();
}
async function loadMap() {
  map.data = await get(`api/map?hours=${map.hours}`);
  map.dimensions = mapDimensions(map.data);
  const shown = map.dimensions.includes(map.want) ? map.want : "overworld";
  if (shown !== map.dimension) { map.dimension = shown; map.fitted = false; }
  map.places = map.data.places.map(place => ({ ...place, key: placeKey(place),
    search: `${place.name} ${place.owner} ${place.author ?? ""} ${place.note ?? ""} ${placeCoordinates(place)} ${place.x}, ${place.y}, ${place.z}`.toLocaleLowerCase() }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
  rebuildTrails();
  renderMap();
}

// ---------- Map: elevation profile ----------
function profileFor(name) {
  const resident = map.data?.residents.find(entry => entry.name === name);
  if (!resident) return null;
  const series = profileSeries(resident.legs);
  return { data: map.data, resident, series, passed: passedPlaces(series, map.places),
    deaths: map.data.deaths.filter(death => death.resident === name), alarms: map.data.alarms.filter(alarm => alarm.resident === name) };
}
function renderProfile() {
  const residents = map.data?.residents ?? [];
  if (!residents.some(resident => resident.name === map.profileWho)) {
    map.profileWho = (residents.find(resident => resident.legs.some(leg => leg.points.length)) ?? residents[0])?.name ?? null;
  }
  segmented($("#map-profile-who"), residents.map(resident => ({ value: resident.name, label: resident.name, who: resident.name })), map.profileWho, value => {
    map.profileWho = value; map.profileHover = -1; saveMap(); renderMap();
  });
  segmented($("#map-profile-axis"), [{ value: "time", label: "Time" }, { value: "distance", label: "Distance" }], map.profileAxis, value => {
    map.profileAxis = value; map.profileHover = -1; saveMap(); renderProfile();
  });
  if (!map.profile || map.profile.data !== map.data || map.profile.resident.name !== map.profileWho) { map.profile = profileFor(map.profileWho); map.profileHover = -1; }
  const profile = map.profile;
  if (map.profileHover < 0) {
    $("#map-profile-readout").textContent = profile
      ? `${profile.resident.name}: ${plural(profile.resident.samples, "sample")} in ${map.data.hours} h, ${plural(profile.series.length, "point")} drawn (standing still merged, straight stretches simplified).`
      : "No resident to show.";
  }
  drawProfile();
}
function profilePointText(point) {
  return `${stamp(point.at)} · y ${point.y} · ${dimensionLabel(point.dimension)} ${whereText(point.dimension, point.x, point.z)} · ${coverOf(point.dimension, point.y, point.sky).label} · ${count(Math.round(point.distance))} blocks along`;
}
function niceStep(span, target, steps) { return steps.find(step => span / step <= target) ?? steps[steps.length - 1]; }
function drawProfile() {
  const canvas = map.profileCanvas, width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const faint = css("--lichen"), soft = css("--seam-soft"), ink = css("--parchment");
  ctx.font = `11px ${css("--data")}`; ctx.textBaseline = "middle";
  map.profileFeatures = [];
  const profile = map.profile, series = profile?.series ?? [];
  if (!series.length) {
    ctx.fillStyle = faint; ctx.textAlign = "center";
    ctx.fillText(profile ? `${profile.resident.name} has no samples in this window.` : "No resident selected.", width / 2, height / 2);
    return;
  }
  const left = 46, right = 14, top = 22, strip = 6, bottom = 24;
  const plotHeight = height - top - bottom - strip - 6, plotWidth = width - left - right, stripTop = top + plotHeight + 4;
  const byTime = map.profileAxis === "time", key = byTime ? "at" : "distance";
  // Time runs over the samples' own span (not the whole window), so a short trip is not a sliver.
  const latest = Math.max(series[series.length - 1].at, ...[...profile.deaths, ...profile.alarms].map(mark => mark.at));
  const from = byTime ? series[0].at : 0;
  const to = byTime ? Math.max(latest, from + 600_000) : Math.max(16, series[series.length - 1].distance);
  let low = Infinity, high = -Infinity;
  for (const point of series) { low = Math.min(low, point.y); high = Math.max(high, point.y); }
  for (const mark of [...profile.deaths, ...profile.alarms]) if (mark.at >= series[0].at) { low = Math.min(low, mark.y); high = Math.max(high, mark.y); }
  if (high - low < 24) { const middle = (high + low) / 2; low = middle - 12; high = middle + 12; }
  const pad = (high - low) * .08; low -= pad; high += pad;
  const sx = value => left + (value - from) / (to - from) * plotWidth;
  const sy = y => top + (high - y) / (high - low) * plotHeight;
  const along = at => byTime ? at : series[nearestIndex(series, "at", at)].distance;

  // Time spent in the Nether or End: tinted bands with the dimension's name.
  let start = 0;
  for (let i = 1; i <= series.length; i++) {
    if (i < series.length && series[i].dimension === series[start].dimension) continue;
    const dimension = series[start].dimension;
    if (dimension !== "overworld") {
      const x1 = sx(series[start][key]), x2 = Math.max(x1 + 2, sx(series[i - 1][key]));
      ctx.fillStyle = BAND_TINT[dimension] ?? "rgba(163,171,155,.1)"; ctx.fillRect(x1, top, x2 - x1, plotHeight);
      if (x2 - x1 > 46) { ctx.fillStyle = faint; ctx.textAlign = "left"; ctx.fillText(dimensionLabel(dimension), x1 + 4, top + 9); }
    }
    start = i;
  }
  // Height grid, sea level, and the horizontal axis.
  const yStep = niceStep(high - low, 6, [4, 8, 16, 32, 64, 128]);
  ctx.lineWidth = 1; ctx.textAlign = "right";
  for (let y = Math.ceil(low / yStep) * yStep; y <= high; y += yStep) {
    ctx.strokeStyle = soft; ctx.beginPath(); ctx.moveTo(left, Math.round(sy(y)) + .5); ctx.lineTo(width - right, Math.round(sy(y)) + .5); ctx.stroke();
    ctx.fillStyle = faint; ctx.fillText(String(y), left - 6, sy(y));
  }
  if (series.some(point => point.dimension === "overworld") && SEA_LEVEL > low && SEA_LEVEL < high) {
    ctx.strokeStyle = "rgba(91,140,240,.7)"; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(left, Math.round(sy(SEA_LEVEL)) + .5); ctx.lineTo(width - right, Math.round(sy(SEA_LEVEL)) + .5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(140,175,245,.9)"; ctx.textAlign = "right"; ctx.fillText("sea 63", width - right - 2, sy(SEA_LEVEL) - 7);
  }
  ctx.fillStyle = faint; ctx.textAlign = "center";
  if (byTime) {
    const hour = 3_600_000, xStep = niceStep(to - from, 8, [600_000, 1_800_000, hour, 2 * hour, 3 * hour, 6 * hour, 12 * hour, 24 * hour]);
    for (let t = Math.ceil(from / xStep) * xStep; t <= to; t += xStep) ctx.fillText(xStep >= 24 * hour ? stamp(t).replace(/ \d\d:\d\d$/, "") : clock(t, false), sx(t), height - 9);
  } else {
    const xStep = niceStep(to - from, 7, [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000]);
    for (let d = 0; d <= to; d += xStep) ctx.fillText(d >= 1000 ? `${d / 1000}k` : String(d), sx(d), height - 9);
    ctx.textAlign = "left"; ctx.fillText("blocks", left + 2, height - 9);
  }
  // The line, coloured by height like the map; nothing joins across a gap, jump or dimension change.
  ctx.lineWidth = 2; ctx.lineCap = "round";
  for (let i = 0; i < series.length; i++) {
    const point = series[i], previous = series[i - 1];
    if (point.joined && previous) {
      ctx.strokeStyle = heightColour((previous.y + point.y) / 2);
      ctx.beginPath(); ctx.moveTo(sx(previous[key]), sy(previous.y)); ctx.lineTo(sx(point[key]), sy(point.y)); ctx.stroke();
      if (point.dimension === "overworld" && Number.isFinite(point.sky)) {
        ctx.fillStyle = point.sky === 0 ? "#8a6a3e" : "#4f86c6";
        const x1 = Math.floor(sx(previous[key]));
        ctx.fillRect(x1, stripTop, Math.max(1, Math.ceil(sx(point[key])) - x1), strip);
      }
    } else if (!series[i + 1]?.joined) {
      ctx.fillStyle = heightColour(point.y); ctx.beginPath(); ctx.arc(sx(point[key]), sy(point.y), 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.lineCap = "butt";
  // Marks: dimension changes, places passed, alarms and deaths.
  for (const crossing of profile.resident.crossings) {
    if (byTime && crossing.at < from) continue;
    const x = Math.round(sx(along(crossing.at))) + .5;
    ctx.strokeStyle = PORTAL; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotHeight); ctx.stroke(); ctx.setLineDash([]);
    map.profileFeatures.push({ sx: x, sy: top + plotHeight / 2, wide: true, text: `${stamp(crossing.at)}: ${dimensionLabel(crossing.from.dimension)} ${crossing.from.x}, ${crossing.from.y}, ${crossing.from.z} → ${dimensionLabel(crossing.to.dimension)} ${crossing.to.x}, ${crossing.to.y}, ${crossing.to.z} (${crossing.kind === "respawn" ? "respawn after a death" : "probably a portal"})` });
  }
  // Places passed: a tick along the top edge (the line itself stays readable near a busy base).
  let lastLabel = -Infinity;
  for (const passed of profile.passed) {
    const x = sx(byTime ? passed.at : passed.distance), tint = canvasColour(passed.place.owner);
    ctx.beginPath(); ctx.moveTo(x - 4, top - 8); ctx.lineTo(x + 4, top - 8); ctx.lineTo(x, top - 2); ctx.closePath();
    ctx.fillStyle = tint; ctx.fill();
    if (x - lastLabel > 96) {
      ctx.font = `11px ${css("--ui")}`; ctx.fillStyle = tint; ctx.textAlign = "left";
      ctx.fillText(passed.place.name.slice(0, 16), Math.min(x + 6, width - right - 80), top - 13); lastLabel = x;
      ctx.font = `11px ${css("--data")}`;
    }
    map.profileFeatures.push({ sx: x, sy: top - 5, text: `Passed ${passed.place.name} (${placeOwner(passed.place)}, ${placeCoordinates(passed.place)}) at ${stamp(passed.at)}, y ${Math.round(passed.y)}` });
  }
  for (const alarm of profile.alarms) {
    if (byTime && alarm.at < from) continue;
    const x = sx(along(alarm.at)), y = sy(alarm.y);
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 4); ctx.lineTo(x - 6, y + 4); ctx.closePath();
    ctx.fillStyle = css("--glow"); ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = "#14171b"; ctx.stroke();
    map.profileFeatures.push({ sx: x, sy: y, text: `${stamp(alarm.at)}: shouted for help (${alarm.kind}): ${alarm.reason}, ${dimensionLabel(alarm.dimension)} ${alarm.x}, ${alarm.y}, ${alarm.z}` });
  }
  for (const death of profile.deaths) {
    if (byTime && death.at < from) continue;
    const x = sx(along(death.at)), y = sy(death.y);
    ctx.strokeStyle = css("--redstone"); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
    map.profileFeatures.push({ sx: x, sy: y, text: `${stamp(death.at)}: died, ${dimensionLabel(death.dimension)} ${death.x}, ${death.y}, ${death.z}` });
  }
  // Hover: a crosshair on the nearest sample.
  const hovered = series[map.profileHover];
  if (hovered) {
    const x = sx(hovered[key]), y = sy(hovered.y);
    ctx.strokeStyle = ink; ctx.globalAlpha = .5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, top); ctx.lineTo(Math.round(x) + .5, top + plotHeight); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.stroke();
  }
  map.profileScale = { left, plotWidth, from, to, key };
}
{
  const canvas = map.profileCanvas, at = event => { const box = canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  const pointAt = ([px]) => {
    const scale = map.profileScale, series = map.profile?.series ?? [];
    if (!scale || !series.length) return -1;
    return nearestIndex(series, scale.key, scale.from + (px - scale.left) / scale.plotWidth * (scale.to - scale.from));
  };
  canvas.addEventListener("pointermove", event => {
    const position = at(event), index = pointAt(position);
    if (index < 0) return;
    let mark, best = 9;
    for (const feature of map.profileFeatures) {
      const distance = feature.wide ? Math.abs(feature.sx - position[0]) : Math.hypot(feature.sx - position[0], feature.sy - position[1]);
      if (distance < best) { best = distance; mark = feature; }
    }
    map.profileHover = index;
    $("#map-profile-readout").textContent = `${profilePointText(map.profile.series[index])}${mark ? `   ${mark.text}` : ""}`;
    drawProfile();
  });
  canvas.addEventListener("pointerleave", () => { map.profileHover = -1; renderProfile(); });
  canvas.addEventListener("click", event => {
    const point = map.profile?.series[pointAt(at(event))];
    if (point) showOnMap(point.dimension, point.x, point.z);
  });
  new ResizeObserver(() => drawProfile()).observe(canvas);
}
{
  const canvas = map.canvas, at = event => { const box = canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture(event.pointerId);
    map.pointers.set(event.pointerId, at(event));
    if (map.pointers.size === 1) map.moved = 0;
  });
  canvas.addEventListener("pointermove", event => {
    const now = at(event), before = map.pointers.get(event.pointerId);
    if (!before) { readout(now[0], now[1]); return; }
    if (map.pointers.size === 1) {
      map.cx -= (now[0] - before[0]) / map.scale; map.cz -= (now[1] - before[1]) / map.scale;
      map.moved += Math.hypot(now[0] - before[0], now[1] - before[1]);
      map.pointers.set(event.pointerId, now);
      scheduleMap();
    } else {
      // Two fingers: zoom about the point between them by how far they moved apart.
      const other = [...map.pointers].find(([id]) => id !== event.pointerId)[1];
      const was = Math.hypot(before[0] - other[0], before[1] - other[1]), is = Math.hypot(now[0] - other[0], now[1] - other[1]);
      map.pointers.set(event.pointerId, now); map.moved += 10;
      if (was > 0) zoomAt((now[0] + other[0]) / 2, (now[1] + other[1]) / 2, is / was);
    }
  });
  const release = event => {
    const point = map.pointers.get(event.pointerId);
    map.pointers.delete(event.pointerId);
    if (point && map.moved < 6 && event.type === "pointerup") {
      readout(point[0], point[1]);
      const nearest = nearestFeature(point[0], point[1], feature => feature.key || feature.go);
      if (nearest?.key) selectMapPlace(nearest.key);
      else if (nearest?.go) showOnMap(nearest.go.dimension, nearest.go.x, nearest.go.z);
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", event => { event.preventDefault(); const [sx, sy] = at(event); zoomAt(sx, sy, Math.exp(-event.deltaY * 0.0015)); }, { passive: false });
  const centre = factor => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
  $("#map-in").onclick = () => centre(1.6);
  $("#map-out").onclick = () => centre(1 / 1.6);
  $("#map-fit").onclick = () => { map.pin = null; fitMap(); drawMap(); };
  $("#map-search").addEventListener("input", event => {
    map.search = event.target.value; renderMapPlaces(); drawMap();
  });
  $("#map-place-list").onclick = event => {
    const key = event.target.closest("button[data-place]")?.dataset.place;
    if (key) selectMapPlace(key);
  };
  // The two thumbs never cross: the one being moved stops at the other.
  $("#map-lo").addEventListener("input", () => {
    const hi = heightRange()[1];
    setHeights([Math.min(Number($("#map-lo").value), hi), hi]);
  });
  $("#map-hi").addEventListener("input", () => {
    const lo = heightRange()[0];
    setHeights([lo, Math.max(Number($("#map-hi").value), lo)]);
  });
  $("#map-h-all").onclick = () => setHeights(null);
  $("#map-h-under").onclick = () => setHeights([heightDomain(map.dimension)[0], SEA_LEVEL - 1]);
  new ResizeObserver(() => { if (map.data && !map.fitted && canvas.clientWidth) { fitMap(); map.fitted = true; } drawMap(); }).observe(canvas);
}

// ---------- Notes ----------
const notes = { who: null, what: "memory", data: null, file: null, fileData: null };
const noteText = text => html`<div class="text">${text.split("\n").map(line => /^#{1,6} /.test(line) ? html`<span class="h">${line}</span>\n` : html`${line}\n`)}</div>`;
const dimensionName = id => id.replace(/^minecraft:/, "");
function placesList(title, places) {
  if (!places.length) return html`<h3>${title}</h3><p class="meta">None.</p>`;
  return html`<h3>${title}</h3><ul class="places">${places.map(place => html`<li><b>${place.name}</b> <span class="data">${place.x}, ${place.y}, ${place.z}</span>
    <span class="meta">${dimensionName(place.dimension)}${place.author ? `, saved by ${place.author}` : ""}</span>${place.note ? html`<br>${place.note}` : ""}</li>`)}</ul>`;
}
function renderNotes() {
  segmented($("#notes-who"), state.names.map(name => ({ value: name, label: name, who: name })), notes.who, value => {
    notes.who = value; notes.data = null; notes.file = null; notes.fileData = null; renderNotes(); refresh("notes");
  });
  segmented($("#notes-what"), [["memory", "Memory"], ["journal", "Journal"], ["files", "Other files"], ["places", "Places"]].map(([value, label]) => ({ value, label })), notes.what, value => { notes.what = value; renderNotes(); });
  const body = $("#notes-body"), data = notes.data;
  body.style.setProperty("--who", colour(notes.who));
  if (!data) { setHtml(body, html`<p class="empty">Reading ${notes.who}'s notes…</p>`); return; }
  const fileHead = (file, extra = "") => html`<p class="meta"><span class="data">${file.path}</span>, ${size(file.bytes)}, changed ${stamp(file.modifiedAt)} (${ago(file.modifiedAt)})${extra}</p>`;
  let markup;
  if (notes.what === "memory") {
    markup = data.memory ? html`<div class="note">${fileHead(data.memory, data.memory.truncated ? "; showing the first 200 KB" : "")}${noteText(data.memory.text)}</div>`
      : html`<p class="empty">${data.name} has no memory.md yet.</p>`;
  } else if (notes.what === "journal") {
    markup = data.journal ? html`<div class="note">${fileHead(data.journal, data.journal.truncated ? "; showing the end of it" : "")}${noteText(data.journal.text)}</div>`
      : html`<p class="empty">${data.name} has no journal.md yet.</p>`;
  } else if (notes.what === "files") {
    markup = data.files.length === 0 ? html`<p class="empty">No other Markdown files in ${data.name}'s directory. Topic files go in notes/.</p>` : html`
      <ul class="files">${data.files.map(file => html`<li><button type="button" data-file="${file.path}" aria-pressed="${String(file.path === notes.file)}">
        <span class="data">${file.path}</span><span class="meta">${size(file.bytes)}, ${stamp(file.modifiedAt)}</span></button></li>`)}</ul>
      ${notes.fileData ? html`<div class="note" style="margin-top:12px">${fileHead(notes.fileData, notes.fileData.truncated ? "; showing the first 200 KB" : "")}${noteText(notes.fileData.text)}</div>` : ""}`;
  } else {
    const problem = data.places.problem || data.shared.problem;
    markup = html`<div class="note">${problem ? html`<p class="warn">${problem}</p>` : ""}
      ${placesList(`${data.name}'s own places`, data.places.places)}
      ${placesList("Shared places (every resident sees these)", data.shared.places)}
      <h3>${data.name}'s recent deaths</h3>${data.places.deaths.length === 0 ? html`<p class="meta">None recorded.</p>` : html`<ul class="places">
        ${data.places.deaths.map(death => html`<li><span class="bad">Died</span> ${stamp(death.at)} at <span class="data">${death.x}, ${death.y}, ${death.z}</span> <span class="meta">${dimensionName(death.dimension)}</span></li>`)}</ul>`}</div>`;
  }
  setHtml(body, markup);
}
$("#notes-body").addEventListener("click", async event => {
  const path = event.target.closest("button[data-file]")?.dataset.file;
  if (!path) return;
  notes.file = path; notes.fileData = null; renderNotes();
  try { notes.fileData = await get(`api/file?resident=${encodeURIComponent(notes.who)}&path=${encodeURIComponent(path)}`); }
  catch (error) { notes.fileData = { path, bytes: 0, modifiedAt: Date.now(), text: error.message, truncated: false }; }
  renderNotes();
});
async function loadNotes() {
  notes.who ??= state.names[0];
  if (!notes.who) return;
  const who = notes.who, data = await get(`api/notes?resident=${encodeURIComponent(who)}`);
  if (who !== notes.who) return;
  notes.data = data;
  renderNotes();
}


// ---------- Shared Knowledge ----------
// Residents see notes and verified skills at once; this panel is where a person looks afterwards.
const commons = { data: null, busy: "", messages: new Map(), editing: new Map() };
const reviewerInput = $("#reviewer-name");
reviewerInput.value = localStorage.getItem("commons.reviewer") ?? "";
const reviewerHint = () => { $("#reviewer-hint").textContent = reviewerInput.value.trim() ? "Saved in this browser; signed on everything you do here." : "Type your name once; everything you do here is signed with it."; };
reviewerInput.addEventListener("input", () => { localStorage.setItem("commons.reviewer", reviewerInput.value.trim()); reviewerHint(); });
$("#reviewer").addEventListener("submit", event => { event.preventDefault(); reviewerInput.blur(); });
reviewerHint();

const VERDICT_WORDS = { keep: "kept it", reject: "removed it", comment: "commented" };
const reviewList = reviews => reviews.length === 0 ? "" : html`<ul class="reviews">${reviews.map(row => row.reviewer === "auto"
  ? html`<li class="past">Made visible to residents automatically <span class="meta">${stamp(row.at)}</span></li>`
  : html`<li class="${row.current ? "" : "past"}"><b>${row.reviewer}</b>
    <span class="${row.verdict === "keep" ? "good" : row.verdict === "reject" ? "bad" : ""}">${VERDICT_WORDS[row.verdict]}</span> <span class="meta">${stamp(row.at)}</span>${row.text ? html`: ${row.text}` : ""}
    ${row.current ? "" : html`<span class="meta">(about an earlier revision)</span>`}</li>`)}</ul>`;
function feedbackFigure(feedback, key) {
  return html`<div><h3>What residents say</h3>
    <b>${feedback.entries.length === 0 ? "No verdicts yet" : `worked for ${feedback.worked}, not for ${feedback.notWorked}`}</b>
    ${feedback.outdated ? html`<p>${plural(feedback.outdated, "verdict")} about an older version, not counted.</p>` : ""}
    ${feedback.entries.length ? html`<details data-d="say:${key}"><summary>Their words</summary><ul>${feedback.entries.map(entry => html`<li>
      <b>${entry.resident}</b>: <span class="${entry.worked ? "good" : "bad"}">${entry.worked ? "worked" : "did not work"}</span>${entry.version !== null ? ` (v${entry.version})` : ""}${entry.text ? `: ${entry.text}` : ""}
      <span class="meta">${stamp(entry.at)}</span></li>`)}</ul></details>` : ""}</div>`;
}

// What can be edited here. Code cannot: it belongs to its author.
const EDIT_FIELDS = {
  note: [["topic", "Topic", 60, 1], ["text", "Text", 600, 5]],
  skill: [["description", "Description: what it does and when to use it", 300, 3], ["params", "Params, as JSON: each name and what it means", 2000, 3],
    ["expect", "Check (expect), as JSON; leave empty for no check", 2000, 4]],
};
function openEditor(kind, item) {
  const key = `${kind}:${item.id}`;
  commons.editing.set(key, { updatedAt: item.updatedAt });
  const values = kind === "note" ? { topic: item.topic, text: item.text }
    : { description: item.description, params: JSON.stringify(item.params, null, 1), expect: item.expect === null ? "" : JSON.stringify(item.expect, null, 1) };
  for (const [name] of EDIT_FIELDS[kind]) drafts.set(`edit:${key}:${name}`, values[name]);
}
function closeEditor(kind, key) {
  commons.editing.delete(key);
  for (const [name] of EDIT_FIELDS[kind]) drafts.delete(`edit:${key}:${name}`);
}
function actionForm(kind, item) {
  const key = `${kind}:${item.id}`, message = commons.messages.get(key), off = commons.busy === key ? html`disabled` : "";
  const editing = commons.editing.has(key), removed = item.status === "rejected", draft = item.status === "draft";
  const editor = !editing ? "" : html`<div class="editor">
    ${EDIT_FIELDS[kind].map(([name, label, max, rows]) => html`<label>${label}
      ${rows === 1 ? html`<input data-i="edit:${key}:${name}" maxlength="${max}">` : html`<textarea data-i="edit:${key}:${name}" maxlength="${max}" rows="${rows}" class="${name === "params" || name === "expect" ? "data" : ""}" spellcheck="${String(name !== "params" && name !== "expect")}"></textarea>`}</label>`)}
    ${kind === "skill" ? html`<p class="fine">Changing the check makes this a new version and a draft again: its author must run it and pass before the others see it. Description and params change nothing else.</p>` : ""}</div>`;
  const reasonHint = editing ? "Why you changed it (optional); its author may read this" : removed ? "A comment, or why you restore it (optional)" : "Reason (needed to remove) or a comment";
  return html`<form class="verdict" data-kind="${kind}" data-id="${item.id}" data-updated="${item.updatedAt}">
    ${editor}
    <textarea data-i="reason:${key}" maxlength="600" placeholder="${reasonHint}" aria-label="${reasonHint}; one plain line"></textarea>
    <div class="buttons">${editing ? html`
      <button type="button" class="keep" data-action="edit" ${off}>Save changes</button>
      <button type="button" class="comment" data-action="cancel" ${off}>Cancel</button>` : html`
      ${removed || draft ? "" : html`<button type="button" class="keep" data-action="keep" ${off}>Looked at, keep</button>`}
      ${removed ? html`<button type="button" class="keep" data-action="restore" ${off}>Restore</button>` : ""}
      <button type="button" class="comment" data-action="open" ${off}>Edit</button>
      ${removed ? "" : html`<button type="button" class="reject" data-action="remove" ${off}>Remove</button>`}
      <button type="button" class="comment" data-action="comment" ${off}>Comment only</button>`}
    </div>
    ${message ? html`<p class="${message.ok ? "done" : "problem"}" role="${message.ok ? "status" : "alert"}">${message.text}</p>` : ""}</form>`;
}
function skillCard(card, skill) {
  card.className = "card item";
  card.style.setProperty("--who", colour(skill.author));
  const key = `skill:${skill.id}`, now = skill.runs.current, all = skill.runs.all;
  const others = skill.users.filter(user => !user.isAuthor), author = skill.users.find(user => user.isAuthor);
  const parameters = Object.entries(skill.params);
  setHtml(card, html`
    <header><span class="name">${skill.name}</span><span class="meta">version ${skill.version}</span><span class="pill ${skill.status}">${skill.status}</span>
      <span class="meta">skill by ${skill.author}; changed ${stamp(skill.updatedAt)}</span></header>
    <p class="said">${skill.description}</p>
    <dl class="facts">
      ${parameters.length ? html`<dt>Takes</dt><dd>${parameters.map(([name, meaning], i) => html`${i ? "; " : ""}<span class="data">${name}</span> ${typeof meaning === "string" ? meaning : JSON.stringify(meaning)}`)}</dd>` : ""}
      <dt>Expects</dt><dd>${skill.expect === null ? html`<span class="warn">nothing declared: its runs cannot be checked</span>` : html`<span class="data">${typeof skill.expect === "string" ? skill.expect : JSON.stringify(skill.expect)}</span>`}</dd>
    </dl>
    <details data-d="code:${skill.id}"><summary>Code (${plural(skill.code.split("\n").length, "line")})</summary><pre>${skill.code}</pre>
      <p class="fine">Code is its author's and cannot be edited here. To stop a skill being used, remove it with a reason: ${skill.author} is shown the reason and can save a better version.</p></details>
    <div class="three">
      <div><h3>Did it work</h3>
        <b>${now.total === 0 ? "Never run in this version" : `${now.passed} of ${plural(now.total, "run")} passed`}</b>
        <p>${now.unchecked ? `${plural(now.unchecked, "passing run")} had no check to pass. ` : ""}${all.total > now.total ? `All versions: ${all.passed} of ${all.total}.` : ""}</p>
        ${skill.recentRuns.length ? html`<details data-d="runs:${skill.id}"><summary>Last ${plural(skill.recentRuns.length, "run")}</summary><ul>${skill.recentRuns.map(run => html`<li>
          ${stamp(run.startedAt)} ${run.resident} v${run.version}:
          <span class="${run.ok && run.checkOk !== false ? "good" : "bad"}">${!run.ok ? "did not finish" : run.checkOk === null ? "finished, unchecked" : run.checkOk ? "passed" : "check failed"}</span>,
          ${(run.ms / 1000).toFixed(1)} s${run.args && run.args !== "{}" ? html` <span class="data">${run.args}</span>` : ""}${run.error ? html`<br><span class="bad">${run.error}</span>` : ""}</li>`)}</ul></details>` : ""}</div>
      <div><h3>Is it worth having</h3>
        <b>${others.length === 0 ? "Nobody but its author has run it" : `Run by ${plural(others.length, "other resident")}`}</b>
        <p>${others.map(user => `${user.resident} ${plural(user.total, "run")} (last ${stamp(user.lastAt)})`).join("; ")}${others.length && author ? "; " : ""}${author ? `author ${author.resident} ${plural(author.total, "run")}` : ""}</p></div>
      ${feedbackFigure(skill.feedback, key)}
    </div>
    ${reviewList(skill.reviews)}
    ${actionForm("skill", skill)}`);
}
function noteCard(card, note) {
  card.className = "card item";
  card.style.setProperty("--who", colour(note.author));
  setHtml(card, html`
    <header><span class="name">${note.topic}</span><span class="pill ${note.status}">${note.status}</span><span class="meta">shared note by ${note.author}, ${stamp(note.createdAt)}</span></header>
    ${note.status === "proposed" ? html`<p class="warn">Other residents do not see this until it is kept (automatic acceptance is off, or has not run yet).</p>` : ""}
    <p class="said">${note.text}</p>
    ${note.feedback.entries.length ? html`<div class="three">${feedbackFigure(note.feedback, `note:${note.id}`)}</div>` : ""}
    ${reviewList(note.reviews)}
    ${actionForm("note", note)}`);
}
const itemCard = (card, item) => item.kind === "skill" ? skillCard(card, item.it) : noteCard(card, item.it);

function storedList(value) {
  try { const list = JSON.parse(value); return Array.isArray(list) ? list : []; }
  catch { return []; }
}
function stockText(value) {
  const list = storedList(value);
  return list.length ? list.map(item => `${item.count} ${item.item}`).join(", ") : "none observed";
}
function referenceSource(source) {
  let url;
  try { url = new URL(source.url); } catch { return html`<li>Invalid source link</li>`; }
  if (url.protocol !== "https:" || url.username || url.password) return html`<li>Invalid source link</li>`;
  return html`<li><a href="${url.href}" target="_blank" rel="noopener noreferrer">${source.title || url.hostname}</a>
    ${source.supports ? html`<br>${source.supports}` : ""}${source.version_evidence ? html`<br><span class="fine">${source.version_evidence}</span>` : ""}</li>`;
}

function observedStock(contents) {
  return html`<p>${contents.items.length ? contents.items.map(item =>
    `${item.count} ${item.item}${item.nbtStacks ? ` (${item.nbtStacks} stacks have item data)` : ""}`).join(", ") : "No items reported."}</p>
    <p class="fine">${contents.usedSlots} of ${contents.slots} sampled slots occupied.
      ${contents.slotsTruncated || contents.itemsTruncated ? "Partial inventory: scan limit reached." : ""}
      ${contents.energy ? `Energy: ${contents.energy.stored} / ${contents.energy.max}.` : ""}
      ${contents.fluids.map(fluid => `${fluid.fluid}: ${fluid.amount} / ${fluid.capacity}`).join("; ")}</p>`;
}

function renderObserver(observation) {
  const health = observation?.health, world = observation?.world;
  setHtml($("#g-observer-health"), html`Server observer: ${health?.status ?? "unconfigured"}.
    ${health?.detail ?? ""}
    ${health?.missedEvents ? "Some server events were missed; this is not a complete history." : ""}
    ${world ? `Snapshot taken ${stamp(world.builtAt)}. No remote chunk loading or resident control.` : "No server snapshot available."}`);
  const facilities = world?.facilities ?? [];
  patch($("#g-observed-facilities"), facilities, item => item.id, (card, item) => {
    card.className = "card";
    const recent = observerFresh(health) && item.status === "observed" && serverNow() - item.checkedAt <= 30_000;
    const contents = item.contents ?? item.lastKnown;
    setHtml(card, html`<header><h3>${item.label}</h3><span class="pill">${item.status}</span></header>
      <p>${item.pos.join(", ")} (${item.dimension}); ${item.side ? `access side ${item.side}` : "unsided inventory"}.</p>
      <p>${item.detail ?? ""} Checked ${stamp(item.checkedAt)}.</p>
      ${contents ? html`<p><b>${recent ? "Observed stock" : "Historical stock — not a current count"}</b>,
        ${item.status === "observed" ? stamp(item.checkedAt) : item.lastObservedAt !== null ? stamp(item.lastObservedAt) : "time not recorded"}. Not a reservation.</p>
        ${observedStock(contents)}` : html`<p>No stock observation available. Unloaded or inaccessible does not mean empty.</p>`}`);
  }, "article");
  $("#g-observed-empty").hidden = facilities.length > 0;
}

function renderCommons() {
  const data = commons.data, body = $("#commons-body");
  if (!body.firstChild) {
    body.innerHTML = html`
      <section class="group"><h2>Shared facilities</h2><p class="fine">Last reported condition and stock, not live inventory. Access terms still apply. Latest 50 registrations.</p><p id="g-facilities-empty" class="empty">Residents have not registered any shared facilities yet.</p><div id="g-facilities"></div></section>
      <section class="group"><h2>Server-observed facilities</h2><p class="fine">Read-only observations of registered blocks, separate from residents' reports. Access terms still apply.</p><p id="g-observer-health" role="status"></p><p id="g-observed-empty" class="empty">No registered facilities in the available server snapshot.</p><div id="g-observed-facilities"></div></section>
      <section class="group"><h2>Collaboration and handoffs</h2><p class="fine">Voluntary agreements. Reported delivery is not confirmation by the recipient. Latest 50 updates.</p><p id="g-collaborations-empty" class="empty">No requests or offers recorded yet.</p><div id="g-collaborations"></div></section>
      <section class="group"><h2>Knowledge gaps</h2><p class="fine">Unanswered questions and reported guide problems. The caretaker researches bounded batches without waiting for human approval. Latest 50 questions.</p><p id="g-gaps-empty" class="empty">No knowledge gaps recorded yet.</p><div id="g-gaps"></div></section>
      <section class="group"><h2>Missing body controls</h2><p class="fine">Reported capabilities for maintainers, not research chores for residents. “Provided” is a maintainer resolution, not proof every use works. Latest 50 entries, open first.</p><p id="g-capabilities-empty" class="empty">No missing body controls reported.</p><div id="g-capabilities"></div></section>
      <section class="group"><h2>Researched references</h2><p class="fine">Source-backed guidance, not live-tested skills. Installed recipes and observed results take precedence. Latest 30 publications.</p><p id="g-references-empty" class="empty">No caretaker references published yet.</p><div id="g-references"></div></section>
      <section class="group"><h2>New, not looked at yet <small id="g-new-n"></small></h2><p id="g-new-empty" class="empty" hidden>
        Nothing new. A shared note shows up here as soon as a resident offers it, a skill once it has passed its own check. Residents can already see and use them; this is where you look afterwards, and edit or remove what is wrong.</p><div id="g-new"></div></section>
      <section class="group"><details data-d="group:kept"><summary id="g-kept-n"></summary><div id="g-kept" class="grouped"></div></details></section>
      <section class="group"><details data-d="group:removed"><summary id="g-removed-n"></summary><p class="fine grouped">Residents no longer see these. The author is shown the reason. Restore brings one back.</p><div id="g-removed"></div></details></section>
      <section class="group"><details data-d="group:draft"><summary id="g-draft-n"></summary><p class="fine grouped">Only its author sees and runs a draft, until a run passes its check.</p><div id="g-draft"></div></details></section>
      <section class="group"><h2>Caretaker notes <small>written hourly by the overseer; read-only here</small></h2><div id="g-caretaker"></div></section>`.text;
  }
  renderObserver(data.observer);
  patch($("#g-facilities"), data.community.facilities, item => item.id, (card, item) => {
    card.className = "card";
    setHtml(card, html`<header><h3>${item.name}</h3><span class="pill">${item.conditionFreshness}</span></header>
      <p>${item.purpose}</p><p>At ${item.x}, ${item.y}, ${item.z} (${item.dimension}). Steward: ${item.steward}.</p>
      <p><b>Access:</b> ${item.access}</p>
      <p>${item.condition || "No condition reported."}${item.observedAt ? ` — ${item.observer}, ${stamp(item.observedAt)}; ${item.source}` : ""}</p>
      <p><b>Capabilities:</b> ${storedList(item.capabilities).join(", ")}</p>
      ${item.stock !== null ? html`<p><b>Stock (${item.stockFreshness}):</b> ${stockText(item.stock)}<br>
        <span class="fine">Count reported by ${item.stockObserver} at ${stamp(item.stockAt)}. Not a reservation.</span></p>` : ""}`);
  }, "article");
  $("#g-facilities-empty").hidden = data.community.facilities.length > 0;
  patch($("#g-collaborations"), data.community.collaborations, item => item.id, (card, item) => {
    card.className = "card";
    setHtml(card, html`<header><h3>#${item.id} ${item.kind}: ${item.sender} → ${item.recipient || "any neighbour"}</h3><span class="pill">${item.status}</span></header>
      <p>${item.terms}</p><p class="fine">${item.project ? `Project: ${item.project}. ` : ""}Terms revision ${item.revision}; updated ${stamp(item.updatedAt)}.</p>
      ${item.evidence ? html`<p><b>Reported result:</b> ${item.evidence}</p>` : ""}
      ${item.confirmation ? html`<p><b>Recipient's report:</b> ${item.confirmation}</p>` : ""}`);
  }, "article");
  $("#g-collaborations-empty").hidden = data.community.collaborations.length > 0;
  patch($("#g-gaps"), data.community.knowledgeGaps, item => item.id, (card, item) => {
    card.className = "card";
    setHtml(card, html`<header><h3>#${item.id} ${item.question}</h3><span class="pill">${item.status}</span><span class="pill">${item.kind}</span></header>
      <p>${item.requests || "Requester not recorded"}; ${item.occurrences} reports, ${item.attempts} research attempts.</p>
      ${item.parked ? html`<p>Automatic research paused.${item.blockedBy ? ` Waiting on ${item.blockedBy}.` : ""}</p>` : ""}
      ${item.reason ? html`<p>${item.reason}</p>` : ""}<p class="fine">Updated ${stamp(item.updatedAt)}. ${item.scope}</p>`);
  }, "article");
  $("#g-gaps-empty").hidden = data.community.knowledgeGaps.length > 0;
  patch($("#g-capabilities"), data.community.capabilityGaps, item => item.id, (card, item) => {
    card.className = "card";
    setHtml(card, html`<header><h3>cap-${item.id}: ${item.capability}</h3><span class="pill">${item.status}</span></header>
      <p>${item.detail}</p><p>${item.reporters || "Reporter not recorded"}; ${item.occurrences} reports.
        ${item.references ? `References: ${item.references}.` : ""} ${item.parkedRequests} parked requests.</p>
      ${item.resolution ? html`<p><b>Resolution:</b> ${item.resolution}</p>` : ""}
      ${item.reportsSinceResolution ? html`<p class="warn">${item.reportsSinceResolution} reports since that resolution; the limitation may still exist.</p>` : ""}
      <p class="fine">Updated ${stamp(item.updatedAt)}.</p>`);
  }, "article");
  $("#g-capabilities-empty").hidden = data.community.capabilityGaps.length > 0;
  patch($("#g-references"), data.community.references, item => `${item.gapId}:${item.revision}`, (card, item) => {
    card.className = "card";
    setHtml(card, html`<header><h3>ref-${item.gapId}: ${item.title}</h3><span class="pill">${item.stale ? "correction pending" : "untested reference"}</span></header>
      <p class="fine">Revision ${item.revision}, published ${stamp(item.publishedAt)}. ${item.scope}</p>
      <details data-d="reference:${item.gapId}"><summary>Read guidance and sources</summary><p>${item.answer}</p>
        <p><b>Prerequisites:</b></p><ul>${storedList(item.prerequisites).map(text => html`<li>${text}</li>`)}</ul>
        <p><b>Body controls:</b></p><ul>${storedList(item.controls).map(text => html`<li>${text}</li>`)}</ul>
        <p><b>Caveats:</b> ${item.caveats}</p><ul>${storedList(item.sources).map(referenceSource)}</ul></details>`);
  }, "article");
  $("#g-references-empty").hidden = data.community.references.length > 0;
  const items = [...data.skills.map(it => ({ kind: "skill", it })), ...data.notes.map(it => ({ kind: "note", it }))];
  const keyOf = item => `${item.kind}:${item.it.id}`;
  const titles = { kept: "Kept", removed: "Removed", draft: "Drafts" };
  for (const group of ["new", "kept", "removed", "draft"]) {
    // New: oldest first, so nothing waits forever. The others: latest change first.
    const members = items.filter(item => item.it.group === group).sort((a, b) => group === "new" ? a.it.updatedAt - b.it.updatedAt : b.it.updatedAt - a.it.updatedAt);
    patch($(`#g-${group}`), members, keyOf, itemCard, "article");
    if (group === "new") {
      $("#g-new-n").textContent = members.length ? `${members.length}, oldest first` : "";
      $("#g-new-empty").hidden = members.length > 0;
    } else $(`#g-${group}-n`).textContent = `${titles[group]} (${members.length})`;
  }
  patch($("#g-caretaker"), data.caretaker, entry => entry.resident, (card, entry) => {
    card.className = "card caretaker";
    card.style.setProperty("--who", colour(entry.resident));
    setHtml(card, html`<header><h2>${entry.resident}</h2><span class="meta">${entry.entries.length ? `latest ${plural(entry.entries.length, "note")}` : "no caretaker notes yet"}</span></header>
      <ul>${entry.entries.slice(0, 3).map(caretakerLine)}</ul>
      ${entry.entries.length > 3 ? html`<details data-d="care:${entry.resident}"><summary>${entry.entries.length - 3} earlier</summary><ul>${entry.entries.slice(3).map(caretakerLine)}</ul></details>` : ""}`);
  }, "article");
}
const caretakerLine = note => html`<li><span class="when">${note.heading}</span>
  ${note.note ? html`<br><b>To the resident:</b> ${note.note}` : ""}${note.maintainers ? html`<br><b>To maintainers:</b> ${note.maintainers}` : ""}${note.other ? html`<br>${note.other}` : ""}</li>`;

// A message about a missing reason is stale as soon as something is being typed.
$("#commons-body").addEventListener("input", event => {
  const key = /^(?:reason|edit):(\w+:\d+)/.exec(event.target.dataset.i ?? "")?.[1];
  if (key && commons.messages.delete(key)) renderCommons();
});
$("#commons-body").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const form = button.closest("form"), kind = form.dataset.kind, id = Number(form.dataset.id), key = `${kind}:${id}`;
  const action = button.dataset.action, item = (kind === "skill" ? commons.data.skills : commons.data.notes).find(entry => entry.id === id);
  const say = (message, ok = false) => { commons.messages.set(key, { text: message, ok }); renderCommons(); };
  if (action === "open") { openEditor(kind, item); commons.messages.delete(key); renderCommons(); $(`form[data-kind="${kind}"][data-id="${id}"] .editor [data-i]`)?.focus(); return; }
  if (action === "cancel") { closeEditor(kind, key); commons.messages.delete(key); renderCommons(); return; }
  const text = (drafts.get(`reason:${key}`) ?? "").trim(), reviewer = reviewerInput.value.trim();
  if (!reviewer) { say("Type your name at the top first; everything done here is signed."); reviewerInput.focus(); return; }
  if (action === "remove" && !text) { say("Removing needs a reason: its author is shown it and learns from it."); return; }
  if (action === "comment" && !text) { say("Write the comment first."); return; }
  const request = { kind, id, action, text, reviewer, updatedAt: Number(form.dataset.updated) };
  if (action === "edit") {
    // What the editor was opened on: if the item changed since, the server says so instead of overwriting it.
    request.updatedAt = commons.editing.get(key).updatedAt;
    request.fields = Object.fromEntries(EDIT_FIELDS[kind].map(([name]) => [name, drafts.get(`edit:${key}:${name}`) ?? ""]));
  }
  commons.busy = key; renderCommons();
  try {
    const response = await fetch("api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    drafts.delete(`reason:${key}`);
    if (action === "edit") closeEditor(kind, key);
    commons.messages.set(key, { ok: true, text: {
      keep: "Kept.",
      remove: `Removed. Residents no longer see it, and ${item.author} is shown your reason.`,
      restore: result.status === "draft" ? "Restored as a draft: this version never passed its check, so only its author sees it until it does." : "Restored. Residents see it again.",
      comment: "Comment saved.",
      edit: `Saved: ${(result.changed ?? []).join(", ")}.${result.status === "draft" && result.changed?.includes("expect") ? " The check changed, so it is a draft again until its author runs it and it passes." : ""}`,
    }[action] });
  } catch (error) { commons.messages.set(key, { ok: false, text: error.message || "The server did not answer. Nothing was changed." }); }
  commons.busy = "";
  await loadCommons().catch(() => renderCommons());
});
async function loadCommons() {
  if (state.residents?.role === "station") {
    setHtml($("#commons-body"), html`<p class="empty">Shared Knowledge is available on the Commons hub, not this station.</p>`);
    return;
  }
  commons.data = await get("api/commons");
  setBadge("commons", commons.data.pending);
  renderCommons();
}

// ---------- Console ----------
// One store of lines, fed by api/console, shared by Console, Residents and Live.
// Each view has its own filter and scroll position; Live is read-only.
const consoleStore = { boot: "", rev: 0, byId: new Map(), sorted: [], server: null, commandsOff: null, loaded: false };
const consoleViews = [];
const CARETAKER = "<Caretaker>";
const HISTORY_KEY = "commons.commands";

/** Text with the residents' names in their colours. */
function withNames(text) {
  if (!state.names.length) return html`${text}`;
  const parts = text.split(new RegExp(`\\b(${state.names.map(name => name.replace(/\W/g, "\\$&")).join("|")})\\b`));
  return html`${parts.map((part, index) => index % 2 ? html`<b style="color:${colour(part)}">${part}</b>` : part)}`;
}
function lineTime(t) {
  const date = new Date(t), today = new Date(serverNow());
  return date.toDateString() === today.toDateString() ? clock(t) : `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock(t, false)}`;
}
function consoleRow(line) {
  const classes = [line.kind, line.source, line.mark ?? "", line.text.includes(CARETAKER) ? "by-caretaker" : "", line.noise ? "noise" : ""].filter(Boolean).join(" ");
  return { classes, markup: html`<time title="${new Date(line.t).toLocaleString()}">${lineTime(line.t)}</time><span class="what">${line.tag ? html`<span class="tag">${line.tag}</span> ` : ""}${withNames(line.text.replace(/^\[Not Secure\] /, ""))}${
    line.seenBy ? html` <span class="tag">seen in game by ${line.seenBy.join(", ")}</span>` : ""}</span>` };
}

function drawConsole(view) {
  // A hidden view has no size to scroll in; it is drawn when its panel is shown.
  if (!view.box.offsetParent) return;
  const needle = view.text.toLowerCase();
  const matching = consoleStore.sorted.filter(line => (view.noise || !line.noise) && (!view.kinds || view.kinds.has(line.kind))
    && (!needle || `${line.tag ?? ""} ${line.text} ${line.seenBy?.join(" ") ?? ""}`.toLowerCase().includes(needle)));
  const shown = matching.slice(-view.limit);
  const newest = shown.length ? shown[shown.length - 1].id : 0, stick = view.stick;
  patch(view.list, shown, line => line.id, (row, line) => {
    if (row.__rev === line.rev) return;
    row.__rev = line.rev;
    const { classes, markup } = consoleRow(line);
    row.className = classes;
    row.innerHTML = markup.text;
  }, "li");
  view.more.hidden = !view.grows || matching.length <= view.limit;
  view.more.firstChild.textContent = `Show earlier lines (${count(matching.length - shown.length)} more)`;
  view.empty.hidden = shown.length > 0;
  view.empty.textContent = !consoleStore.loaded ? "Reading the console…" : consoleStore.sorted.length ? "No line matches this filter." : "Nothing yet. Lines appear as the server writes its log and as the residents' clients show chat.";
  if (stick) view.box.scrollTop = view.box.scrollHeight;
  else if (newest !== view.newest) view.jump.hidden = false;
  view.newest = newest;
  if (view.readOnly) return;
  const off = consoleStore.commandsOff;
  view.input.disabled = view.send.disabled = Boolean(off) || view.sending;
  view.off.hidden = !off;
  view.off.textContent = off ?? "";
}
const drawConsoles = () => { for (const view of consoleViews) drawConsole(view); };

function consoleView(root, options) {
  root.innerHTML = html`
    <div class="console-box" tabindex="0" role="log" aria-label="${options.label ?? "Console lines, newest last"}">
      <p class="console-more" hidden><button type="button"></button></p><ol class="console-lines"></ol><p class="empty" hidden></p></div>
    <button type="button" class="jump" hidden>New lines below. Jump to newest</button>
    ${options.readOnly ? "" : html`<form class="command" autocomplete="off">
      <label class="check" title="Turns what you type into: say &lt;text&gt;"><input type="checkbox" class="as-server"> Say as Server</label>
      <div class="command-row"><span class="prompt" aria-hidden="true">&gt;</span>
        <input class="command-input data" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Server command">
        <button class="send">Send</button></div>
      <p class="problem" role="alert"></p><p class="fine command-off" hidden></p>
    </form>`}`.text;
  const view = {
    ...options, text: "", stick: true, newest: 0, sending: false,
    box: $(".console-box", root), list: $("ol", root), more: $(".console-more", root), empty: $(".empty", root), jump: $(".jump", root),
    input: $(".command-input", root), send: $(".send", root), off: $(".command-off", root),
  };
  // Scrolling up pauses following; coming back to the bottom resumes it.
  view.box.addEventListener("scroll", () => {
    view.stick = view.box.scrollHeight - view.box.scrollTop - view.box.clientHeight < 40;
    if (view.stick) view.jump.hidden = true;
  });
  view.jump.onclick = () => { view.stick = true; view.jump.hidden = true; view.box.scrollTop = view.box.scrollHeight; };
  view.more.firstChild.onclick = () => { view.limit += 1000; drawConsole(view); };
  consoleViews.push(view);
  if (view.readOnly) return view;

  const form = $("form", root), asServer = $(".as-server", root), problem = $(".problem", root);
  const placeholder = () => { view.input.placeholder = asServer.checked ? "Say to everyone as [Server]" : "Server command, such as: list"; };
  asServer.onchange = placeholder;
  placeholder();
  let recall = -1, unsent = "";
  const pastCommands = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? []; } catch { return []; } };
  view.input.addEventListener("keydown", event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const past = pastCommands();   // newest first
    if (recall < 0) unsent = view.input.value;
    recall = Math.max(-1, Math.min(past.length - 1, recall + (event.key === "ArrowUp" ? 1 : -1)));
    view.input.value = recall < 0 ? unsent : past[recall];
    // A recalled line is a whole command already.
    if (recall >= 0) { asServer.checked = false; placeholder(); }
    event.preventDefault();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const typed = view.input.value.trim().replace(/^\/+/, "").trim();
    if (!typed || view.sending) return;
    const command = asServer.checked ? `say ${typed}` : typed, word = command.split(/\s+/)[0].toLowerCase();
    if ((word === "stop" || word === "restart") && !confirm(`Run "${command}"? This takes the Minecraft server down for everyone on it.`)) return;
    view.sending = true; problem.textContent = ""; drawConsole(view);
    try {
      const response = await fetch("api/console/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `The server answered ${response.status}.`);
      localStorage.setItem(HISTORY_KEY, JSON.stringify([command, ...pastCommands().filter(past => past !== command)].slice(0, 50)));
      view.input.value = ""; recall = -1; view.stick = true;
    } catch (error) { problem.textContent = error.message || "This page could not reach the Shared Knowledge server. The command was not sent."; }
    view.sending = false;
    // The command and its answer are in the stream by now, whether it worked or not.
    await loadConsole().catch(() => drawConsole(view));
    view.input.focus();
  });
  return view;
}

// The strip shows what people said and did, and what you typed; the panel starts with everything.
const GLANCE_KINDS = ["chat", "players", "command"];
const glanceView = consoleView($("#glance-view"), { kinds: new Set(GLANCE_KINDS), limit: 40, grows: false });
const fullView = consoleView($("#console-view"), { kinds: null, limit: 1000, grows: true });
consoleView($("#live-chat-view"), { kinds: new Set(["chat"]), limit: 5000, grows: false, readOnly: true, label: "Game chat, newest last" });
$("#glance-all").onchange = event => { glanceView.kinds = event.target.checked ? null : new Set(GLANCE_KINDS); glanceView.stick = true; drawConsole(glanceView); };
const CONSOLE_FILTERS = [["all", "All", null], ["chat", "Chat", ["chat"]], ["players", "Players", ["players"]], ["warn", "Warnings and errors", ["warn"]]];
let consoleFilter = "all";
function drawConsoleFilter() {
  segmented($("#console-kind"), CONSOLE_FILTERS.map(([value, label]) => ({ value, label })), consoleFilter, value => {
    consoleFilter = value;
    const kinds = CONSOLE_FILTERS.find(filter => filter[0] === value)[2];
    fullView.kinds = kinds && new Set(kinds); fullView.stick = true; fullView.limit = 1000;
    drawConsoleFilter(); drawConsole(fullView);
  });
}
drawConsoleFilter();
$("#console-text").addEventListener("input", event => { fullView.text = event.target.value.trim(); fullView.stick = true; drawConsole(fullView); });
// Noise is hidden in every filter unless asked for here; the strip never shows it.
const NOISE_KEY = "commons.noise";
$("#console-noise").checked = fullView.noise = localStorage.getItem(NOISE_KEY) === "1";
$("#console-noise").onchange = event => {
  fullView.noise = event.target.checked; fullView.stick = true;
  localStorage.setItem(NOISE_KEY, fullView.noise ? "1" : "0");
  drawConsole(fullView);
};

async function loadConsole() {
  const store = consoleStore;
  if (state.residents?.role === "station") {
    store.commandsOff = "Console commands are disabled on stations. Use the Commons hub.";
    store.loaded = true;
    for (const selector of ["#console-status", "#live-chat-status"]) {
      const status = $(selector);
      status.hidden = false;
      status.textContent = "The server console is available on the Commons hub, not this station.";
    }
    drawConsoles();
    return;
  }
  const data = await get(`api/console?boot=${encodeURIComponent(store.boot)}&after=${store.rev}`);
  if (data.boot !== store.boot) {
    // The app restarted and numbers its lines from 1 again: rows on screen with those numbers are other lines.
    store.byId.clear(); store.boot = data.boot;
    for (const view of consoleViews) view.list.replaceChildren();
  }
  for (const id of data.gone) store.byId.delete(id);
  for (const line of data.lines) store.byId.set(line.id, line);
  if (data.lines.length || data.gone.length || !store.loaded) {
    const sorted = [...store.byId.values()].sort((a, b) => a.t - b.t || a.id - b.id);
    // As on the server: at most 500 noise lines, so they do not push out what people said, then the newest 5,000.
    const noisy = sorted.filter(line => line.noise), surplus = new Set(noisy.slice(0, Math.max(0, noisy.length - 500)));
    store.sorted = sorted.filter(line => !surplus.has(line)).slice(-5000);
    if (store.sorted.length < sorted.length) store.byId = new Map(store.sorted.map(line => [line.id, line]));
  }
  Object.assign(store, { rev: data.rev, server: data.server, commandsOff: data.commandsOff, loaded: true });
  const status = $("#console-status"), server = data.server;
  status.hidden = server.state === "ok";
  status.textContent = {
    unset: "No server log here: neither CONSOLE_URL nor CHAT_URL is set. Showing only what the residents' clients were shown in game.",
    unknown: "Asking the server machine for its log…",
    unreachable: `The server log cannot be read right now. ${server.detail ?? ""} Meanwhile this shows what the residents' clients were shown in game.`,
  }[server.state] ?? "";
  const liveChatStatus = $("#live-chat-status");
  liveChatStatus.hidden = status.hidden;
  liveChatStatus.textContent = status.textContent;
  const noisy = store.sorted.filter(line => line.noise).length;
  $("#console-noise-n").textContent = noisy ? `(${count(noisy)} lines)` : "";
  drawConsoles();
}

// ---------- panels, tabs, and the refresh loop ----------
const panels = [
  { id: "residents", title: "Residents", every: 5000, load: loadResidents, always: true },
  { id: "live", title: "Live", every: 5000, load: () => liveView.loadStatus() },
  { id: "activity", title: "Activity", every: 4000, load: loadActivity },
  { id: "map", title: "Map", every: 10000, load: loadMap },
  { id: "notes", title: "Notes", every: 30000, load: loadNotes },
  { id: "commons", title: "Shared Knowledge", every: 15000, load: loadCommons },
  // One poll also feeds the visible chat beside Residents or Live.
  { id: "console", title: "Console", every: 2000, load: loadConsole, also: ["residents", "live"] },
  { id: "chat", title: "Chat", hidden: true },
];
const badges = {};
function setBadge(id, number) { if (badges[id] !== number) { badges[id] = number; drawTabs(); } }
function setChat(url) {
  const panel = panels.find(entry => entry.id === "chat");
  if (panel.hidden === !url) return;
  panel.hidden = !url; panel.url = url;
  drawTabs();
}
function drawTabs() {
  setHtml($("#tabs"), html`${panels.filter(panel => !panel.hidden).map(panel => html`<button type="button" id="t-${panel.id}" data-panel="${panel.id}"
    ${panel.id === state.active ? html`aria-current="page"` : ""}>${panel.title}${badges[panel.id] ? html`<span class="badge" title="new, not looked at yet">${badges[panel.id]}</span>` : ""}</button>`)}`);
  // On a phone the tab bar scrolls sideways; keep the open tab in sight.
  $("#tabs [aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function show(id) {
  const panel = panels.find(entry => entry.id === id && !entry.hidden) ?? panels[0];
  state.active = panel.id;
  liveView.setActive(panel.id === "live");
  $("#top h1").textContent = panel.title;
  document.title = `${panel.title} — Minecraft residents`;
  for (const entry of panels) $(`#p-${entry.id}`).hidden = entry.id !== panel.id;
  // The chat page is loaded when first opened, and again only if its address changes.
  if (panel.id === "chat" && panel.shown !== panel.url) { $("#chat-frame").src = panel.url; panel.shown = panel.url; }
  if (location.hash.slice(1) !== panel.id) history.replaceState(null, "", `#${panel.id}`);
  drawTabs();
  $("main").scrollTop = 0;
  if (panel.id === "map") requestAnimationFrame(() => { if (map.data) renderMap(); });
  drawConsoles();
  tick();
}
$("#tabs").addEventListener("click", event => { const id = event.target.closest("button")?.dataset.panel; if (id) show(id); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

function refresh(id) { panels.find(panel => panel.id === id).at = 0; tick(); }
async function tick() {
  if (document.visibilityState === "hidden") return;
  for (const panel of panels) {
    const wanted = panel.always || panel.id === state.active || panel.also?.includes(state.active);
    if (!panel.load || panel.loading || !wanted || Date.now() - (panel.at ?? 0) < panel.every) continue;
    // Other panels need the residents' names (and their colours) first.
    if (!panel.always && !state.residents) continue;
    panel.loading = true; panel.at = Date.now();
    panel.load().then(() => { state.failures = 0; $("#lost").hidden = true; })
      .catch(() => { if (++state.failures >= 3) $("#lost").hidden = false; })
      .finally(() => { panel.loading = false; if (panel.always && state.failures === 0) tick(); });
  }
  residentsTick();
}
document.addEventListener("visibilitychange", tick);
setInterval(tick, 1000);
drawTabs();
show(location.hash.slice(1) || "residents");
