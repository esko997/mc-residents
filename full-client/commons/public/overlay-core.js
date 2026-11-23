"use strict";

// All three surfaces share this renderer. Only the server's privacy projection is
// accepted as on-air content; editor drafts are never substituted for live data.
export const WIDGETS = {
  vitals: { label: "Vitals", width: 280, height: 112 },
  position: { label: "Position", width: 280, height: 108 },
  plan: { label: "Current plan", width: 360, height: 146 },
  chat: { label: "Conversation", width: 440, height: 260 },
  alarms: { label: "Alarms", width: 360, height: 130 },
  nearby: { label: "Nearby", width: 280, height: 150 },
  map: { label: "Navigation", width: 340, height: 290 },
  caretaker: { label: "Caretaker", width: 420, height: 150 },
  title: { label: "Nameplate", width: 520, height: 112 },
};
export const base = `/${location.pathname.split("/").filter(Boolean)[0] || ""}/`;
export const clone = value => JSON.parse(JSON.stringify(value));
export const dimensions = state => state.layout === "1280x720" ? [1280, 720] : [1920, 1080];
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
export function linkPaths() {
  for (const link of document.querySelectorAll("[data-route]")) link.href = base + link.dataset.route;
}
export function boundedWidget(state, id, value) {
  const [width, height] = dimensions(state), size = WIDGETS[id];
  const scale = Math.min(2, Math.max(0.1, Number(value.scale) || 1));
  return { ...value, scale,
    x: Math.min(Math.max(0, Math.floor(width - size.width * scale)), Math.max(0, Math.round(Number(value.x) || 0))),
    y: Math.min(Math.max(0, Math.floor(height - size.height * scale)), Math.max(0, Math.round(Number(value.y) || 0))) };
}
export async function api(path = "", options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(base + "api/overlay" + path, { cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer", ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(response.status === 409 ? "conflict" : "unavailable"); error.status = response.status; throw error; }
    if (!data || typeof data !== "object") throw new Error("unavailable");
    return data;
  } finally { clearTimeout(timer); }
}
export function subscribe(onSnapshot, onStatus = () => {}) {
  let source = null, disposed = false, loading = false;
  async function open() {
    if (disposed || document.hidden || source || loading) return;
    loading = true;
    try {
      const snapshot = await api();
      if (disposed || document.hidden) return;
      onSnapshot(snapshot); onStatus(true);
      source = new EventSource(base + "api/overlay/events");
      source.addEventListener("snapshot", event => {
        try { onSnapshot(JSON.parse(event.data)); onStatus(true); } catch { onStatus(false); }
      });
      source.onerror = () => onStatus(false);
    } catch { onStatus(false); }
    finally { loading = false; }
  }
  function close() { source?.close(); source = null; }
  const visible = () => { if (document.hidden) close(); else void open(); };
  const pagehide = () => { close(); };
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", visible);
  void open();
  return { retry: () => { close(); void open(); }, close: () => { disposed = true; close(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", visible); } };
}
function lines(root, values, empty, limit) {
  const list = element("ul", "widget-lines");
  for (const value of values.slice(-limit)) list.append(element("li", "", value));
  if (!list.children.length) list.append(element("li", "empty", empty));
  root.append(list);
}
function number(value) { return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString() : "—"; }
function mapView(root, data) {
  const canvas = element("canvas", "navigation-map"); canvas.width = 312; canvas.height = 180;
  canvas.setAttribute("aria-label", "Schematic X/Z navigation map, not terrain"); canvas.setAttribute("role", "img"); root.append(canvas);
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const points = (data.map?.points || []).slice(0, 80), trail = (data.map?.trail || []).slice(-180);
  const position = data.position;
  const all = [...points, ...trail, ...(position ? [position] : [])].filter(p => Number.isFinite(p.x) && Number.isFinite(p.z));
  ctx.fillStyle = "#23374b"; ctx.fillRect(0, 0, 312, 180);
  ctx.strokeStyle = "#40576a"; ctx.lineWidth = 1;
  for (let x = 26; x < 312; x += 26) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 180); ctx.stroke(); }
  for (let y = 25; y < 180; y += 26) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(312, y); ctx.stroke(); }
  if (!all.length) { root.append(element("p", "map-caption", "No position or saved places available.")); return; }
  const xs = all.map(p => p.x), zs = all.map(p => p.z);
  const minX = Math.min(...xs) - 12, minZ = Math.min(...zs) - 12;
  const span = Math.max(Math.max(...xs) - minX + 12, Math.max(...zs) - minZ + 12, 48);
  const project = p => [16 + (p.x - minX) / span * 280, 16 + (p.z - minZ) / span * 148];
  ctx.strokeStyle = "#718b9a"; ctx.lineWidth = 2; ctx.beginPath();
  trail.forEach((p, i) => { const [x, y] = project(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  for (const p of points) { const [x, y] = project(p); ctx.fillStyle = "#f1f4ed"; ctx.fillRect(x - 2, y - 2, 4, 4); }
  if (position) { const [x, y] = project(position); ctx.fillStyle = "#d8b66b"; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x - 6, y + 5); ctx.closePath(); ctx.fill(); }
  root.append(element("p", "map-caption", `N ↑ · X/Z schematic · ${points.length} saved places`));
  if (points.length) root.append(element("p", "map-caption map-places", points.slice(0, 3).map(point => point.name).join(" · ")));
}
export function createRenderer(stage, { editable = false, select = () => {} } = {}) {
  let snapshot = null, chosen = null;
  const nodes = new Map();
  for (const [id, size] of Object.entries(WIDGETS)) {
    const panel = element("section", `overlay-widget widget-${id}`); panel.dataset.widget = id;
    panel.style.width = size.width + "px"; panel.style.height = size.height + "px";
    const header = element(editable ? "button" : "h2", "widget-heading", size.label);
    if (editable) { header.type = "button"; header.classList.add("drag-handle"); header.setAttribute("aria-label", `Select or drag ${size.label}`); header.addEventListener("click", () => select(id)); }
    const body = element("div", "widget-body"); panel.append(header, body); stage.append(panel); nodes.set(id, { panel, header, body });
  }
  function render(next, draft = next.state) {
    snapshot = next;
    const [width, height] = dimensions(draft); stage.style.width = width + "px"; stage.style.height = height + "px";
    const data = next.data || {}, age = data.sampledAt == null ? null : Math.max(0, Math.floor((Date.now() - data.sampledAt) / 1000));
    const stale = !data.online || age === null || age > 30;
    stage.classList.toggle("stale", stale);
    for (const [id, { panel, header, body }] of nodes) {
      const settings = boundedWidget(draft, id, draft.widgets[id]);
      panel.hidden = !settings.enabled; panel.dataset.theme = settings.theme;
      header.textContent = `${WIDGETS[id].label}${stale && id !== "title" ? " · stale" : ""}`;
      panel.classList.toggle("selected", chosen === id);
      panel.style.left = settings.x + "px"; panel.style.top = settings.y + "px"; panel.style.transform = `scale(${settings.scale})`;
      body.replaceChildren();
      if (id === "title") {
        body.append(element("strong", "resident-name", data.resident || "Resident"));
        if (data.title) body.append(element("p", "broadcast-title", data.title));
        body.append(element("p", "sample-status", `${!data.online ? "Offline" : stale ? "Context stale" : "In the field"}${age === null ? " · no sample" : ` · sampled ${age}s ago`}`));
        if (data.nowPlaying) body.append(element("p", "now-playing", `Playing: ${data.nowPlaying}`));
      } else if (id === "vitals") {
        const stats = element("dl", "vital-strip");
        for (const [label, value] of [["Health", data.vitals ? `${number(data.vitals.health)}/${number(data.vitals.maxHealth)}` : "—"], ["Food", number(data.vitals?.food)], ["Air", number(data.vitals?.air)]]) {
          const cell = element("div"); cell.append(element("dt", "", label), element("dd", "", value)); stats.append(cell);
        } body.append(stats);
      } else if (id === "position") {
        body.append(element("p", "coordinates", data.position ? `${number(data.position.x)} / ${number(data.position.y)} / ${number(data.position.z)}` : "Position unavailable"), element("p", "muted", data.position?.dimension || "No dimension sampled"));
      } else if (id === "plan") {
        body.append(element("p", "focus-line", data.plan?.focus || "No current focus shared."), element("p", "muted", data.plan?.next ? `Next: ${data.plan.next}` : "No next step shared."));
      } else if (id === "chat") {
        const list = element("ul", "widget-lines chat-lines");
        for (const message of (data.chat || []).slice(-5)) { const row = element("li"); row.append(element("span", "chat-name", `${message.name}: `), element("span", "", message.text)); list.append(row); }
        if (!list.children.length) list.append(element("li", "empty", "No public conversation yet.")); body.append(list);
      } else if (id === "alarms") lines(body, (data.alarms || []).map(item => item.text), "No reported alarms.", 3);
      else if (id === "nearby") lines(body, (data.nearby || []).map(item => `${item.name}${item.distance == null ? "" : ` · ${number(item.distance)} blocks`}`), "No nearby residents sampled.", 4);
      else if (id === "caretaker") body.append(element("p", "caretaker-note", data.caretaker || "No public caretaker note."));
      else if (id === "map") mapView(body, data);
    }
  }
  return { render, choose(id) { chosen = id; for (const [key, { panel }] of nodes) panel.classList.toggle("selected", key === id); }, panel: id => nodes.get(id)?.panel, snapshot: () => snapshot };
}
export function fitStage(viewport, stage, state) {
  const [width, height] = dimensions(state), fullscreen = document.fullscreenElement === viewport;
  const scale = fullscreen ? Math.min(viewport.clientWidth / width, viewport.clientHeight / height) : viewport.clientWidth / width;
  const left = fullscreen ? (viewport.clientWidth - width * scale) / 2 : 0;
  const top = fullscreen ? (viewport.clientHeight - height * scale) / 2 : 0;
  stage.style.transform = `scale(${scale})`; stage.style.left = left + "px"; stage.style.top = top + "px";
  viewport.style.setProperty("--frame-width", width * scale + "px");
  viewport.style.setProperty("--frame-height", height * scale + "px");
  viewport.style.setProperty("--frame-left", left + "px");
  viewport.style.setProperty("--frame-top", top + "px");
  if (!fullscreen) viewport.style.height = height * scale + "px";
  return scale;
}
