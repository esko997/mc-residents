"use strict";
import { WIDGETS, api, clone, dimensions, boundedWidget, element, linkPaths, createRenderer, fitStage, subscribe } from "./overlay-core.js";

linkPaths();
const find = id => document.getElementById(id);
const stage = find("overlay-stage"), viewport = find("stage-viewport");
let latest = null, draft = null, baseRevision = 0, selected = "title", dirty = false;
let saving = false, conflict = false, connected = false, editSerial = 0, timer = null, drag = null, presetRequest = 0;
const renderer = createRenderer(stage, { editable: true, select: choose });
const pickerButtons = new Map();
for (const [id, spec] of Object.entries(WIDGETS)) {
  const button = element("button", "", spec.label); button.type = "button";
  button.addEventListener("click", () => choose(id)); find("widget-picker").append(button); pickerButtons.set(id, button);
}
function status(message) { find("save-status").textContent = message; }
function draw() {
  if (!draft || !latest) return;
  renderer.render(latest, draft); renderer.choose(selected); fitStage(viewport, stage, draft);
  find("stage-size").textContent = draft.layout.replace("x", " × ");
  for (const [id, button] of pickerButtons) { button.setAttribute("aria-pressed", String(id === selected)); button.classList.toggle("off", !draft.widgets[id].enabled); }
  find("save-now").disabled = !dirty || saving || conflict;
  find("conflict").hidden = !conflict;
}
function inspector() {
  if (!draft) return;
  const widget = draft.widgets[selected], [width, height] = dimensions(draft), size = WIDGETS[selected];
  find("selected-widget").textContent = size.label;
  find("widget-enabled").checked = widget.enabled;
  find("widget-x").value = widget.x; find("widget-x").max = Math.floor(Math.max(0, width - size.width * widget.scale));
  find("widget-y").value = widget.y; find("widget-y").max = Math.floor(Math.max(0, height - size.height * widget.scale));
  find("widget-scale").value = Number(widget.scale.toFixed(2)); find("widget-theme").value = widget.theme;
}
function channelFields() {
  find("resident").value = draft.resident; find("layout").value = draft.layout; find("preset").value = draft.preset;
  find("broadcast-title").value = draft.title; find("now-playing").value = draft.nowPlaying; find("hide-names").value = draft.hideNames.join("\n");
}
function choose(id) { if (!WIDGETS[id]) return; selected = id; renderer.choose(id); inspector(); draw(); }
function adopt(snapshot) {
  draft = clone(snapshot.state); baseRevision = draft.revision; dirty = false; conflict = false;
  channelFields(); inspector(); draw(); status(connected ? "All changes saved." : "Saved layout loaded. Connecting to updates…");
}
function updateResidents(snapshot) {
  const select = find("resident"), before = select.value;
  const items = (snapshot.residents || []).map(item => [item.name, item.liveAvailable === true ? item.name : `${item.name} — Live unavailable${item.detail ? `: ${item.detail}` : ""}`]);
  if (JSON.stringify(items) === JSON.stringify(Array.from(select.options, option => [option.value, option.textContent]))) return;
  select.replaceChildren();
  for (const [name, label] of items) { const option = element("option", "", label); option.value = name; select.append(option); }
  select.value = draft?.resident || before || snapshot.state.resident;
}
function receive(snapshot) {
  if (!snapshot.state || !snapshot.data || (latest && snapshot.state.revision < latest.state.revision)) return;
  latest = snapshot; updateResidents(snapshot);
  if (!draft) {
    for (const input of document.querySelectorAll(".inspector input,.inspector textarea,.inspector select")) input.disabled = false;
    adopt(snapshot);
  } else if (!dirty && !saving) adopt(snapshot);
  else {
    if (!saving && snapshot.state.revision > baseRevision) {
      conflict = true; clearTimeout(timer); status("Another window saved a newer layout. Resolve the conflict below.");
    }
    draw();
  }
}
function changed({ custom = false, delay = 250 } = {}) {
  if (!draft) return;
  if (custom) { draft.preset = "custom"; find("preset").value = "custom"; }
  dirty = true; editSerial++; draw();
  if (!conflict) status(saving ? "Saving; newer edits are queued…" : "Changes waiting to save…");
  clearTimeout(timer); if (!conflict) timer = setTimeout(() => void save(), delay);
}
async function save() {
  clearTimeout(timer);
  if (!draft || !dirty || saving || conflict) return;
  if (draft.hideNames.length > 64 || draft.hideNames.some(name => !/^\w{1,40}$/.test(name))) {
    status("Use up to 64 hidden names, with 1–40 letters, numbers or underscores per name.");
    find("hide-names").setAttribute("aria-invalid", "true");
    return;
  }
  find("hide-names").removeAttribute("aria-invalid");
  saving = true; const sentSerial = editSerial, state = clone(draft), revision = baseRevision;
  status("Saving changes…"); draw();
  try {
    const snapshot = await api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, state }) });
    if (!latest || snapshot.state.revision >= latest.state.revision) latest = snapshot;
    baseRevision = snapshot.state.revision; draft.revision = baseRevision;
    dirty = sentSerial !== editSerial;
    if (latest.state.revision > baseRevision) { conflict = true; status("Another window saved a newer layout. Resolve the conflict below."); }
    else if (!dirty) { draft = clone(snapshot.state); channelFields(); inspector(); status("All changes saved."); }
    else status("Saving newer edits…");
  } catch (error) {
    if (error.status === 409) {
      conflict = true; status("Another window saved a newer layout. Resolve the conflict below.");
      try { const snapshot = await api(); if (!latest || snapshot.state.revision >= latest.state.revision) latest = snapshot; } catch { status("Layout conflict. Reconnect before choosing which version to keep."); }
    } else {
      status(error.status === 400 ? "Changes were not accepted. Check field lengths and values, then Save now." : "Save not confirmed. Your edits remain here. Reconnect or choose Save now.");
      // A lost reply may have committed. Read before any subsequent overwrite.
      try {
        const snapshot = await api();
        if (!latest || snapshot.state.revision >= latest.state.revision) latest = snapshot;
        if (snapshot.state.revision > baseRevision) { conflict = true; status("The saved version changed while saving. Resolve the conflict below."); }
      } catch { connected = false; }
    }
  } finally {
    saving = false; draw();
    if (dirty && !conflict && sentSerial !== editSerial) timer = setTimeout(() => void save(), 250);
  }
}
async function applyPreset(preset, layout) {
  if (!draft) return;
  const request = ++presetRequest; find("preset").disabled = true; find("layout").disabled = true;
  try {
    const presets = await api(`/presets?layout=${encodeURIComponent(layout)}`);
    if (request !== presetRequest) return;
    if (!presets[preset]) throw new Error("unavailable");
    draft.layout = layout; draft.preset = preset; draft.widgets = clone(presets[preset]);
    for (const id of Object.keys(WIDGETS)) draft.widgets[id] = boundedWidget(draft, id, draft.widgets[id]);
    channelFields(); inspector(); changed();
  } catch { channelFields(); status("Preset could not be loaded. Your previous layout is unchanged; try selecting it again."); }
  finally { if (request === presetRequest) { find("preset").disabled = false; find("layout").disabled = false; } }
}
find("resident").addEventListener("change", event => { if (draft) { draft.resident = event.target.value; changed(); } });
find("preset").addEventListener("change", event => {
  if (!draft) return;
  if (event.target.value === "custom") { draft.preset = "custom"; changed(); }
  else void applyPreset(event.target.value, draft.layout);
});
find("layout").addEventListener("change", event => {
  if (!draft) return;
  const layout = event.target.value;
  if (draft.preset !== "custom") { void applyPreset(draft.preset, layout); return; }
  const [oldWidth, oldHeight] = dimensions(draft); draft.layout = layout; const [width, height] = dimensions(draft);
  for (const id of Object.keys(WIDGETS)) {
    const widget = draft.widgets[id];
    draft.widgets[id] = boundedWidget(draft, id, { ...widget, x: widget.x * width / oldWidth, y: widget.y * height / oldHeight, scale: Math.max(.5, Math.min(2, widget.scale * width / oldWidth)) });
  }
  inspector(); changed();
});
for (const [id, key] of [["widget-x", "x"], ["widget-y", "y"], ["widget-scale", "scale"]]) {
  find(id).addEventListener("input", event => {
    if (!draft || event.target.value === "" || !Number.isFinite(event.target.valueAsNumber)) return;
    draft.widgets[selected] = boundedWidget(draft, selected, { ...draft.widgets[selected], [key]: event.target.valueAsNumber });
    changed({ custom: true });
  });
  find(id).addEventListener("blur", inspector);
}
find("widget-enabled").addEventListener("change", event => { if (draft) { draft.widgets[selected].enabled = event.target.checked; changed({ custom: true }); } });
find("widget-theme").addEventListener("change", event => { if (draft) { draft.widgets[selected].theme = event.target.value; changed({ custom: true }); } });
for (const [id, key] of [["broadcast-title", "title"], ["now-playing", "nowPlaying"]]) find(id).addEventListener("input", event => { if (draft) { draft[key] = event.target.value; changed({ delay: 400 }); } });
find("hide-names").addEventListener("input", event => {
  if (!draft) return;
  draft.hideNames = [...new Set(event.target.value.split(/[\n,]/).map(name => name.trim()).filter(Boolean))]; changed({ delay: 400 });
});
find("save-now").addEventListener("click", () => void save());
find("take-server").addEventListener("click", () => { if (!saving && latest) { clearTimeout(timer); adopt(latest); } });
find("keep-mine").addEventListener("click", async () => {
  if (!draft || saving) return;
  find("keep-mine").disabled = true;
  try {
    const snapshot = await api(); latest = snapshot; baseRevision = snapshot.state.revision; draft.revision = baseRevision;
    conflict = false; dirty = true; editSerial++; draw(); await save();
  } catch { status("Cannot read the saved layout. Reconnect before saving your version."); }
  finally { find("keep-mine").disabled = false; }
});
stage.addEventListener("pointerdown", event => {
  const handle = event.target.closest(".drag-handle"), panel = handle?.closest("[data-widget]");
  if (!draft || !panel || event.button !== 0) return;
  event.preventDefault(); choose(panel.dataset.widget);
  drag = { id: selected, x: event.clientX, y: event.clientY, widget: { ...draft.widgets[selected] }, scale: viewport.clientWidth / dimensions(draft)[0], pointer: event.pointerId, handle };
  handle.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  draft.widgets[drag.id] = boundedWidget(draft, drag.id, { ...drag.widget, x: drag.widget.x + (event.clientX - drag.x) / drag.scale, y: drag.widget.y + (event.clientY - drag.y) / drag.scale });
  changed({ custom: true, delay: 300 }); inspector();
});
function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointer) return;
  if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
  drag = null; if (dirty && !conflict) { clearTimeout(timer); void save(); }
}
stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
new ResizeObserver(() => { if (draft) fitStage(viewport, stage, draft); }).observe(viewport);
const subscription = subscribe(receive, ok => {
  connected = ok; find("connection-dot").classList.toggle("connected", ok);
  if (!ok) status(dirty ? "Connection lost. Unsaved edits remain here; reconnect before leaving." : "Connection lost. Saved layout remains; reconnect for current context.");
  else if (!dirty && !saving && !conflict) status("All changes saved.");
});
find("retry").addEventListener("click", () => subscription.retry());
window.addEventListener("beforeunload", event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => clearTimeout(timer));
