"use strict";
// The Commons page. No framework and no build step: each panel fetches JSON from
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

function residentInfo(resident) {
  const s = resident.state, tokens = resident.tokens, session = tokens.session;
  const live = !s ? "" : html`
    <div class="vitals">
      <span class="label">Health</span>${pips("health", s.health, s.maxHealth)}<span class="data">${s.health} / ${s.maxHealth}</span>
      <span class="label">Food</span>${pips("food", s.food, 20)}<span class="data">${s.food} / 20</span>
      ${s.air ? html`<span class="label">Air</span>${pips("air", s.air.now, s.air.max)}<span class="data">${s.air.now} / ${s.air.max}</span>` : ""}
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
async function loadPicture(name, fresh = false) {
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
  const box = document.querySelector(`.view[data-name="${CSS.escape(name)}"]`);
  if (!box) return;
  const record = pictures.get(name) ?? {}, resident = state.residents?.residents.find(entry => entry.name === name);
  const online = resident?.status === "online";
  const image = $("img", box), blank = $(".blank", box);
  if (record.url && image.dataset.url !== record.url) { image.src = record.url; image.dataset.url = record.url; }
  image.hidden = !record.url;
  blank.hidden = Boolean(record.url);
  blank.textContent = online ? (record.problem || "Fetching what it sees…") : `${name} is not in the world; there is nothing to see.`;
  box.classList.toggle("stale", Boolean(record.url) && !online);
  $(".when", box).textContent = record.url ? `${online ? "Seen" : "Last seen"} ${clock(record.at)}` : "";
  $("button", box).hidden = !online;
}

function renderResidents(data) {
  patch($("#residents"), data.residents, resident => resident.name, (card, resident) => {
    if (card.__new) {
      card.__new = false;
      card.className = "card resident";
      card.style.setProperty("--who", colour(resident.name));
      card.innerHTML = html`<header></header>
        <div class="view" data-name="${resident.name}"><img alt="What ${resident.name} sees" hidden><p class="blank"></p>
          <div class="bar"><span class="when"></span><button type="button">Refresh picture</button></div></div>
        <div class="info"></div>`.text;
      $(".view button", card).onclick = () => loadPicture(resident.name, true);
    }
    const words = {
      online: `looked ${ago(resident.checkedAt)}`,
      offline: resident.lastOnlineAt ? `last in the world ${stamp(resident.lastOnlineAt)} (${ago(resident.lastOnlineAt)})` : "not seen since this app started watching",
      unchecked: "not looked at yet",
    }[resident.status] ?? resident.detail;
    setHtml($("header", card), html`<h2>${resident.name}</h2><span class="pill ${resident.status}">${resident.status}</span><span class="meta">${words}</span>`);
    setHtml($(".info", card), residentInfo(resident));
  }, "article");
  // After the cards are in the page: a new card is filled before it is attached.
  for (const resident of data.residents) showPicture(resident.name);

  const quota = data.quota;
  setHtml($("#shared"), html`
    ${data.sharedUnits.map(unit => html`<span class="unit"><span class="data">${unit.unit}</span> <span class="pill ${unit.state}">${unit.state}</span></span>`)}
    ${quota ? html`<span>Codex quota: ${quota.usedPercent}% of the ${quota.windowMinutes ? `${Math.round(quota.windowMinutes / 1440)}-day` : ""} window used${
      quota.resetsAt ? `, resets ${stamp(quota.resetsAt)}` : ""} (read ${ago(quota.at)})</span>` : ""}
    <span>State and position are read every ${data.sampleSeconds} s; pictures at most every ${data.pictureSeconds} s while this panel is open.</span>`);
}

async function loadResidents() {
  const data = await get("api/residents");
  skew = data.now - Date.now();
  const first = !state.residents;
  state.residents = data;
  state.names = data.residents.map(resident => resident.name);
  const online = data.residents.filter(resident => resident.status === "online").length;
  $("#pulse").textContent = `${online} of ${data.residents.length} in the world, read ${clock(data.now)}`;
  renderResidents(data);
  setChat(data.chatUrl);
  setBadge("commons", data.pending);
  if (first) drawTabs();
}
function residentsTick() {
  if (state.active !== "residents" || !state.residents) return;
  for (const resident of state.residents.residents) {
    const record = pictures.get(resident.name);
    if (resident.status === "online" && Date.now() - (record?.asked ?? 0) >= state.residents.pictureSeconds * 1000) void loadPicture(resident.name);
  }
}

// ---------- Activity ----------
const activity = { boot: "", after: 0, entries: new Map(), who: "All", quiet: false, summary: [], first: true };
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
    kind = { remark: "remark", thought: "thought", prompt: "told" }[entry.kind] ?? entry.kind;
    what = html`${entry.text}`;
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

function renderActivity() {
  segmented($("#activity-who"), [{ value: "All", label: "All" }, ...state.names.map(name => ({ value: name, label: name, who: name }))], activity.who, value => { activity.who = value; renderActivity(); });
  patch($("#signs"), activity.summary.filter(info => activity.who === "All" || info.name === activity.who), info => info.name, signsCard, "article");
  const shown = [...activity.entries.values()]
    .filter(entry => (activity.who === "All" || entry.resident === activity.who) && (activity.quiet || !entry.quiet))
    .sort((a, b) => b.t - a.t || b.id - a.id).slice(0, 300);
  patch($("#feed"), shown, entry => entry.id, (row, entry) => {
    if (!row.__new) return; // entries never change once recorded
    row.__new = false;
    const { cls, markup } = feedRow(entry);
    row.className = `${cls}${activity.first ? "" : " fresh"}`;
    row.style.setProperty("--who", colour(entry.resident));
    row.innerHTML = markup.text;
  }, "li");
  const empty = $("#feed-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = activity.entries.size ? "Only routine lines here (status, wait, arrivals). Tick “Routine lines too” to see them."
    : "No session in the last two days. Lines appear here as soon as a resident's session starts writing.";
}
$("#feed").addEventListener("click", event => event.target.closest("li.long")?.classList.toggle("open"));
$("#activity-quiet").addEventListener("change", event => { activity.quiet = event.target.checked; renderActivity(); });

async function loadActivity() {
  const data = await get(`api/activity?boot=${encodeURIComponent(activity.boot)}&after=${activity.after}&limit=500`);
  if (data.boot !== activity.boot) { activity.entries.clear(); activity.after = 0; activity.boot = data.boot; activity.first = true; }
  for (const entry of data.entries) { activity.entries.set(entry.id, entry); activity.after = Math.max(activity.after, entry.id); }
  if (activity.entries.size > 2000) {
    const keep = [...activity.entries.values()].sort((a, b) => b.t - a.t).slice(0, 1500);
    activity.entries = new Map(keep.map(entry => [entry.id, entry]));
  }
  activity.summary = data.residents;
  renderActivity();
  activity.first = false;
}

// ---------- Map ----------
const map = { hours: 6, data: null, cx: 0, cz: 0, scale: 2, fitted: false, pointers: new Map(), moved: 0, features: [], canvas: $("#map") };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const canvasColour = name => css(name === "shared" ? "--shared" : `--c${Math.max(0, state.names.indexOf(name)) % 4}`);
const toScreen = (x, z) => [(x - map.cx) * map.scale + map.canvas.clientWidth / 2, (z - map.cz) * map.scale + map.canvas.clientHeight / 2];
const toWorld = (sx, sy) => [(sx - map.canvas.clientWidth / 2) / map.scale + map.cx, (sy - map.canvas.clientHeight / 2) / map.scale + map.cz];

function fitMap() {
  const points = [];
  for (const resident of map.data?.residents ?? []) {
    for (const point of resident.trail) points.push([point[1], point[2]]);
    if (resident.position) points.push([resident.position.x, resident.position.z]);
  }
  for (const place of map.data?.places ?? []) points.push([place.x, place.z]);
  for (const death of map.data?.deaths ?? []) points.push([death.x, death.z]);
  if (!points.length) { map.cx = 0; map.cz = 0; map.scale = 2; return; }
  const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
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
  const ink = css("--parchment"), faint = css("--lichen"), soft = css("--seam-soft");
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
  ctx.fillStyle = "rgba(20,23,27,.85)"; ctx.fillRect(0, height - 20, 150, 20);
  ctx.fillStyle = faint; ctx.textAlign = "left"; ctx.fillText(`grid: ${step} blocks  x → east, z ↓ south`.slice(0, 60), 6, height - 10);

  map.features = [];
  const label = (text, sx, sy, colourValue, bold = false) => {
    ctx.font = `${bold ? "bold " : ""}12px ${css("--ui")}`; ctx.textAlign = "left";
    ctx.lineWidth = 3; ctx.strokeStyle = "#14171b"; ctx.strokeText(text, sx + 9, sy);
    ctx.fillStyle = colourValue; ctx.fillText(text, sx + 9, sy);
  };
  for (const resident of map.data?.residents ?? []) {
    const tint = canvasColour(resident.name);
    ctx.strokeStyle = tint; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.globalAlpha = .85;
    ctx.beginPath();
    let previous;
    for (const point of resident.trail) {
      const [sx, sy] = toScreen(point[1], point[2]);
      // A jump no walk explains (death and respawn, a portal, a teleport) is a gap, not a line across the map.
      const jump = previous && Math.hypot(point[1] - previous[1], point[2] - previous[2]);
      if (!previous || (jump > 64 && jump / Math.max(1, (point[0] - previous[0]) / 1000) > 12)) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      previous = point;
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (const place of map.data?.places ?? []) {
    const [sx, sy] = toScreen(place.x, place.z), tint = canvasColour(place.owner);
    ctx.beginPath(); ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 6, sy); ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 6, sy); ctx.closePath();
    ctx.fillStyle = "#14171b"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = tint; ctx.stroke();
    if (map.scale >= 0.5) label(place.name, sx, sy, ink);
    map.features.push({ sx, sy, text: `${place.name} (${place.owner === "shared" ? `shared${place.author ? ` by ${place.author}` : ""}` : `${place.owner}'s place`}, y ${place.y})${place.note ? `: ${place.note}` : ""}` });
  }
  for (const death of map.data?.deaths ?? []) {
    const [sx, sy] = toScreen(death.x, death.z);
    ctx.strokeStyle = css("--redstone"); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5); ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5); ctx.stroke();
    map.features.push({ sx, sy, text: `${death.resident} died here, y ${death.y}, ${stamp(death.at)}` });
  }
  // Residents last, so a marker is never hidden under a place it stands on; its name goes above it.
  for (const resident of map.data?.residents ?? []) {
    const tint = canvasColour(resident.name), last = resident.trail[resident.trail.length - 1];
    const here = resident.position ? [resident.position.x, resident.position.z] : last ? [last[1], last[2]] : undefined;
    if (!here) continue;
    const [sx, sy] = toScreen(here[0], here[1]);
    ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = "#14171b";
    if (resident.position) { ctx.fillStyle = tint; ctx.fill(); ctx.stroke(); } else { ctx.strokeStyle = tint; ctx.stroke(); }
    const name = resident.position ? resident.name : `${resident.name} (last sample)`;
    ctx.font = `bold 12px ${css("--ui")}`;
    label(name, sx - 9 - ctx.measureText(name).width / 2, sy - 15, tint, true);
    map.features.push({ sx, sy, text: resident.position ? `${resident.name} is here now, y ${resident.position.y}` : `${resident.name}'s last sample on this map, ${stamp(last[0])}` });
  }
}
function readout(sx, sy) {
  const [x, z] = toWorld(sx, sy);
  let nearest, best = 18;
  for (const feature of map.features) {
    const distance = Math.hypot(feature.sx - sx, feature.sy - sy);
    if (distance < best) { best = distance; nearest = feature; }
  }
  $("#map-readout").textContent = `x ${Math.round(x)}, z ${Math.round(z)}${nearest ? `   ${nearest.text}` : ""}`;
}
function renderMap() {
  const data = map.data;
  segmented($("#map-hours"), data.choices.map(hours => ({ value: String(hours), label: hours < 24 ? `${hours} h` : `${hours / 24} d` })), String(map.hours), value => {
    map.hours = Number(value); map.fitted = false; panels.find(panel => panel.id === "map").at = 0; tick();
  });
  setHtml($("#map-legend"), html`${data.residents.map(resident => html`<span class="key" style="--who:${colour(resident.name)}"><i></i>${resident.name}:
    ${resident.position ? `at ${Math.round(resident.position.x)}, ${Math.round(resident.position.z)}` : resident.online ? `in ${resident.dimension}, not on this map` : "offline"},
    ${plural(resident.trail.length, "trail point")}</span>`)}
    <span>◆ saved place (pale: shared)</span><span class="bad">✕ death</span>`);
  if (!map.fitted && map.canvas.clientWidth) { fitMap(); map.fitted = true; }
  drawMap();
}
async function loadMap() {
  map.data = await get(`api/map?hours=${map.hours}`);
  renderMap();
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
      drawMap();
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
    if (point && map.moved < 6) readout(point[0], point[1]);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", event => { event.preventDefault(); const [sx, sy] = at(event); zoomAt(sx, sy, Math.exp(-event.deltaY * 0.0015)); }, { passive: false });
  const centre = factor => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
  $("#map-in").onclick = () => centre(1.6);
  $("#map-out").onclick = () => centre(1 / 1.6);
  $("#map-fit").onclick = () => { fitMap(); drawMap(); };
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

// ---------- Commons ----------
const commons = { data: null, busy: "", messages: new Map() };
const reviewerInput = $("#reviewer-name");
reviewerInput.value = localStorage.getItem("commons.reviewer") ?? "";
const reviewerHint = () => { $("#reviewer-hint").textContent = reviewerInput.value.trim() ? "Saved in this browser; written on every verdict." : "Type your name once; every verdict is signed with it."; };
reviewerInput.addEventListener("input", () => { localStorage.setItem("commons.reviewer", reviewerInput.value.trim()); reviewerHint(); });
$("#reviewer").addEventListener("submit", event => { event.preventDefault(); reviewerInput.blur(); });
reviewerHint();

const VERDICT_WORDS = { keep: "kept it", reject: "rejected it", comment: "commented" };
const reviewList = reviews => reviews.length === 0 ? "" : html`<ul class="reviews">${reviews.map(row => html`<li><b>${row.reviewer}</b>
  <span class="${row.verdict === "keep" ? "good" : row.verdict === "reject" ? "bad" : ""}">${VERDICT_WORDS[row.verdict]}</span> <span class="meta">${stamp(row.at)}</span>${row.text ? html`: ${row.text}` : ""}</li>`)}</ul>`;
function feedbackFigure(feedback, key) {
  return html`<div><h3>What residents say</h3>
    <b>${feedback.entries.length === 0 ? "No verdicts yet" : `worked for ${feedback.worked}, not for ${feedback.notWorked}`}</b>
    ${feedback.outdated ? html`<p>${plural(feedback.outdated, "verdict")} about an older version, not counted.</p>` : ""}
    ${feedback.entries.length ? html`<details data-d="say:${key}"><summary>Their words</summary><ul>${feedback.entries.map(entry => html`<li>
      <b>${entry.resident}</b>: <span class="${entry.worked ? "good" : "bad"}">${entry.worked ? "worked" : "did not work"}</span>${entry.version !== null ? ` (v${entry.version})` : ""}${entry.text ? `: ${entry.text}` : ""}
      <span class="meta">${stamp(entry.at)}</span></li>`)}</ul></details>` : ""}</div>`;
}
function verdictForm(kind, item, canKeep) {
  const key = `${kind}:${item.id}`, message = commons.messages.get(key), busy = commons.busy === key;
  return html`<form class="verdict" data-kind="${kind}" data-id="${item.id}" data-version="${item.version ?? ""}">
    <textarea data-i="reason:${key}" maxlength="600" placeholder="Reason (needed to reject) or a comment" aria-label="Reason or comment; one plain line, its author may read it"></textarea>
    <div class="buttons">
      ${canKeep ? html`<button type="button" class="keep" data-verdict="keep" ${busy ? "disabled" : ""}>Keep</button>` : ""}
      <button type="button" class="reject" data-verdict="reject" ${busy ? "disabled" : ""}>Reject</button>
      <button type="button" class="comment" data-verdict="comment" ${busy ? "disabled" : ""}>Comment only</button>
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
      <span class="meta">by ${skill.author}; changed ${stamp(skill.updatedAt)}</span></header>
    <p class="said">${skill.description}</p>
    <dl class="facts">
      ${parameters.length ? html`<dt>Takes</dt><dd>${parameters.map(([name, meaning], i) => html`${i ? "; " : ""}<span class="data">${name}</span> ${typeof meaning === "string" ? meaning : JSON.stringify(meaning)}`)}</dd>` : ""}
      <dt>Expects</dt><dd>${skill.expect === null ? html`<span class="warn">nothing declared: its runs cannot be checked</span>` : html`<span class="data">${typeof skill.expect === "string" ? skill.expect : JSON.stringify(skill.expect)}</span>`}</dd>
    </dl>
    <details data-d="code:${skill.id}"><summary>Code (${plural(skill.code.split("\n").length, "line")})</summary><pre>${skill.code}</pre></details>
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
    ${verdictForm("skill", skill, skill.status !== "draft")}`);
}
function noteCard(card, note) {
  card.className = "card item";
  card.style.setProperty("--who", colour(note.author));
  setHtml(card, html`
    <header><span class="name">${note.topic}</span><span class="pill ${note.status}">${note.status}</span><span class="meta">shared note by ${note.author}, ${stamp(note.createdAt)}</span></header>
    <p class="said">${note.text}</p>
    ${note.feedback.entries.length ? html`<div class="three">${feedbackFigure(note.feedback, `note:${note.id}`)}</div>` : ""}
    ${reviewList(note.reviews)}
    ${verdictForm("note", note, true)}`);
}
const itemCard = (card, item) => item.kind === "skill" ? skillCard(card, item.it) : noteCard(card, item.it);

function renderCommons() {
  const data = commons.data, body = $("#commons-body");
  if (!body.firstChild) {
    body.innerHTML = html`
      <section class="group"><h2>Waiting for your decision <small id="g-waiting-n"></small></h2><p id="g-waiting-empty" class="empty" hidden>
        Nothing is waiting. A skill arrives here once it has passed its own check; a shared note as soon as a resident offers one. Until you keep a note, no other resident sees it.</p><div id="g-waiting"></div></section>
      <section class="group"><details data-d="group:drafts"><summary id="g-drafts-n"></summary><p class="fine" style="margin:6px 0 10px">Only its author sees and runs a draft. It can be rejected or commented on, but not kept before it passes its check.</p><div id="g-drafts"></div></details></section>
      <section class="group"><details data-d="group:decided"><summary id="g-decided-n"></summary><div id="g-decided" style="margin-top:10px"></div></details></section>
      <section class="group"><h2>Caretaker notes <small>written hourly by the overseer; read-only here</small></h2><div id="g-caretaker"></div></section>`.text;
  }
  const items = [...data.skills.map(it => ({ kind: "skill", it })), ...data.notes.map(it => ({ kind: "note", it }))];
  const keyOf = item => `${item.kind}:${item.it.id}`;
  const waiting = items.filter(item => item.it.status === "verified" || item.it.status === "proposed").sort((a, b) => a.it.updatedAt - b.it.updatedAt);
  const drafts_ = items.filter(item => item.it.status === "draft");
  const decided = items.filter(item => item.it.status === "curated" || item.it.status === "rejected");
  patch($("#g-waiting"), waiting, keyOf, itemCard, "article");
  patch($("#g-drafts"), drafts_, keyOf, itemCard, "article");
  patch($("#g-decided"), decided, keyOf, itemCard, "article");
  $("#g-waiting-n").textContent = waiting.length ? `${waiting.length}, oldest first` : "";
  $("#g-waiting-empty").hidden = waiting.length > 0;
  $("#g-drafts-n").textContent = `Drafts (${drafts_.length})`;
  $("#g-decided-n").textContent = `Decided (${decided.filter(item => item.it.status === "curated").length} kept, ${decided.filter(item => item.it.status === "rejected").length} rejected)`;
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

// A message about a missing reason is stale as soon as the reason is being typed.
$("#commons-body").addEventListener("input", event => {
  const key = event.target.dataset.i?.replace(/^reason:/, "");
  if (key && commons.messages.delete(key)) renderCommons();
});
$("#commons-body").addEventListener("click", async event => {
  const button = event.target.closest("button[data-verdict]");
  if (!button) return;
  const form = button.closest("form"), kind = form.dataset.kind, id = Number(form.dataset.id), key = `${kind}:${id}`;
  const verdict = button.dataset.verdict, text = (drafts.get(`reason:${key}`) ?? "").trim(), reviewer = reviewerInput.value.trim();
  const say = (message, ok = false) => { commons.messages.set(key, { text: message, ok }); renderCommons(); };
  if (!reviewer) { say("Type your name at the top first; every verdict is signed."); reviewerInput.focus(); return; }
  if (verdict === "reject" && !text) { say("A rejection needs a reason, so its author learns something from it."); return; }
  if (verdict === "comment" && !text) { say("Write the comment first."); return; }
  commons.busy = key; renderCommons();
  try {
    const response = await fetch("api/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, id, verdict, text, reviewer, ...(form.dataset.version ? { version: Number(form.dataset.version) } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    drafts.delete(`reason:${key}`);
    commons.messages.set(key, { ok: true, text: { keep: "Kept. Every resident now sees it as reviewed.", reject: "Rejected, with your reason on record.", comment: "Comment saved." }[verdict] });
    form.querySelector("textarea").value = "";
  } catch (error) { commons.messages.set(key, { ok: false, text: error.message || "The server did not answer. Nothing was changed." }); }
  commons.busy = "";
  await loadCommons().catch(() => renderCommons());
});
async function loadCommons() {
  commons.data = await get("api/commons");
  setBadge("commons", commons.data.pending);
  renderCommons();
}

// ---------- panels, tabs, and the refresh loop ----------
const panels = [
  { id: "residents", title: "Residents", every: 5000, load: loadResidents, always: true },
  { id: "activity", title: "Activity", every: 4000, load: loadActivity },
  { id: "map", title: "Map", every: 10000, load: loadMap },
  { id: "notes", title: "Notes", every: 30000, load: loadNotes },
  { id: "commons", title: "Commons", every: 15000, load: loadCommons },
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
    ${panel.id === state.active ? html`aria-current="page"` : ""}>${panel.title}${badges[panel.id] ? html`<span class="badge" title="waiting for review">${badges[panel.id]}</span>` : ""}</button>`)}`);
}
function show(id) {
  const panel = panels.find(entry => entry.id === id && !entry.hidden) ?? panels[0];
  state.active = panel.id;
  for (const entry of panels) $(`#p-${entry.id}`).hidden = entry.id !== panel.id;
  // The chat page is loaded when first opened, and again only if its address changes.
  if (panel.id === "chat" && panel.shown !== panel.url) { $("#chat-frame").src = panel.url; panel.shown = panel.url; }
  if (location.hash.slice(1) !== panel.id) history.replaceState(null, "", `#${panel.id}`);
  drawTabs();
  $("main").scrollTop = 0;
  if (panel.id === "map") requestAnimationFrame(() => { if (map.data) renderMap(); });
  tick();
}
$("#tabs").addEventListener("click", event => { const id = event.target.closest("button")?.dataset.panel; if (id) show(id); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

function refresh(id) { panels.find(panel => panel.id === id).at = 0; tick(); }
async function tick() {
  if (document.visibilityState === "hidden") return;
  for (const panel of panels) {
    if (!panel.load || panel.loading || !(panel.always || panel.id === state.active) || Date.now() - (panel.at ?? 0) < panel.every) continue;
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
