"use strict";
import { api, clone, createRenderer, fitStage, linkPaths, subscribe } from "./overlay-core.js";
import { createPreviewMedia } from "./overlay-media.js";

linkPaths();
const find = id => document.getElementById(id), stage = find("overlay-stage"), viewport = find("stage-viewport"), select = find("preview-resident");
const renderer = createRenderer(stage);
let latest = null, selecting = false;
const media = createPreviewMedia({ video: find("preview-video"), blank: find("preview-blank"), watch: find("watch"), stop: find("stop"), audio: find("audio"), fullscreen: find("fullscreen"), stage: viewport, status: find("media-status"), resident: () => latest?.state.resident || "" });
function render() {
  if (!latest) return;
  renderer.render(latest); fitStage(viewport, stage, latest.state);
}
function receive(snapshot) {
  if (!snapshot.state || !snapshot.data || (latest && snapshot.state.revision < latest.state.revision)) return;
  if (latest && latest.state.resident !== snapshot.state.resident) media.selectionChanged();
  latest = snapshot;
  const residents = snapshot.residents || [];
  const label = item => item.liveAvailable === true ? item.name : `${item.name} — Live unavailable${item.detail ? `: ${item.detail}` : ""}`;
  if (JSON.stringify(Array.from(select.options, option => [option.value, option.textContent])) !== JSON.stringify(residents.map(item => [item.name, label(item)]))) {
    select.replaceChildren();
    for (const resident of residents) { const option = document.createElement("option"); option.textContent = label(resident); option.value = resident.name; select.append(option); }
  }
  select.value = snapshot.state.resident; select.disabled = selecting || !residents.length;
  media.availability(!selecting && residents.some(item => item.name === snapshot.state.resident && item.liveAvailable === true));
  render();
}
select.addEventListener("change", async () => {
  if (!latest || selecting) return;
  media.selectionChanged(); media.availability(false); selecting = true; select.disabled = true;
  const state = clone(latest.state); state.resident = select.value;
  try {
    const snapshot = await api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: latest.state.revision, state }) });
    receive(snapshot); find("sync-status").textContent = "Resident selection saved. Press Watch to start video.";
  } catch (error) {
    find("sync-status").textContent = error.status === 409 ? "The layout changed in another window. Your selection was not saved; choose the resident again." : "Resident selection was not confirmed. Reconnect, then choose the resident again.";
    try { receive(await api()); } catch { /* Keep the last privacy-projected snapshot, never stale media. */ }
  } finally {
    selecting = false; if (latest) receive(latest);
  }
});
new ResizeObserver(render).observe(viewport);
const subscription = subscribe(receive, ok => {
  find("connection-dot").classList.toggle("connected", ok);
  find("sync-status").textContent = ok ? "Overlay is synchronized with the broadcast desk." : "Overlay connection lost. Context may be stale; reconnect for current settings.";
});
find("retry").addEventListener("click", () => subscription.retry());
setInterval(() => { if (!document.hidden) render(); }, 1000);
