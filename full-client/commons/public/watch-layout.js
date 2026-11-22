"use strict";
// Optional desktop arrangement. The same panels keep their content, polling and forms.
(() => {
  const watch = document.querySelector(".watch");
  const residents = document.querySelector("#residents");
  const shared = document.querySelector("#shared");
  const sharedParent = shared.parentElement;
  const media = matchMedia("(min-width: 900px)");
  const key = "minecraft-residents:watch-layout:v1";
  let layout = { enabled: false, panels: {} }, storage = true, active = false, drag = null, top = 2;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && typeof saved.enabled === "boolean" && saved.panels && typeof saved.panels === "object") layout = saved;
  } catch { storage = false; }
  const entries = new Map();
  const toolbar = document.createElement("div");
  toolbar.className = "watch-layout-controls controls";
  toolbar.innerHTML = '<label class="check"><input type="checkbox"> Arrange panels</label><button type="button">Reset layout</button><span class="fine"></span>';
  watch.before(toolbar);
  const toggle = toolbar.querySelector("input"), reset = toolbar.querySelector("button"), hint = toolbar.querySelector("span");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify(layout)); }
    catch { storage = false; hint.textContent = "Layout works in this tab; browser storage is unavailable."; }
  };
  const bounds = value => ({
    x: clamp(value.x, 0, Math.max(0, watch.clientWidth - value.w)), y: clamp(value.y, 0, 3000),
    w: clamp(value.w, Math.min(280, watch.clientWidth), watch.clientWidth), h: clamp(value.h, 220, 1400),
  });
  function geometry(entry, index) {
    const value = layout.panels[entry.id];
    if (value && [value.x, value.y, value.w, value.h].every(Number.isFinite)) {
      const size = bounds(value);
      return bounds(size); // Clamp x again if a narrower viewport changed the width.
    }
    const columns = Math.max(1, Math.min(3, Math.floor((watch.clientWidth + 14) / 360)));
    const width = Math.floor((watch.clientWidth - 14 * (columns - 1)) / columns);
    return { x: index % columns * (width + 14), y: Math.floor(index / columns) * 574, w: width, h: 560 };
  }
  function height() {
    if (!active) return;
    let bottom = 0;
    for (const entry of entries.values()) bottom = Math.max(bottom, entry.el.offsetTop + entry.el.offsetHeight);
    watch.style.height = `${bottom + 20}px`;
  }
  function place(entry, value) {
    const g = bounds(bounds(value));
    Object.assign(entry.el.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    layout.panels[entry.id] = g;
    height();
  }
  function apply() {
    if (watch.clientWidth === 0 || residents.children.length === 0) return; // Hidden/loading tabs must not overwrite saved sizes.
    active = layout.enabled && media.matches;
    watch.classList.toggle("arranged", active);
    toggle.checked = layout.enabled;
    toggle.disabled = !media.matches;
    hint.textContent = !media.matches ? "Panels stack on small screens; your desktop arrangement is kept."
      : !active ? "Arrange and resize the resident views and chat/console here."
      : storage ? "Drag Move or a resize corner. Arrow keys on Move/Resize also work. Saved in this browser."
      : "Layout works in this tab; browser storage is unavailable.";
    if (active) {
      watch.before(shared);
      [...entries.values()].sort((a, b) => Number(a.id === "console") - Number(b.id === "console")).forEach((entry, index) => place(entry, geometry(entry, index)));
      height();
    } else {
      sharedParent.append(shared);
      watch.style.removeProperty("height");
      for (const entry of entries.values()) {
        for (const property of ["left", "top", "width", "height", "z-index"]) entry.el.style.removeProperty(property);
      }
    }
  }
  function connect(el, id, name) {
    if (entries.has(id)) return false;
    const tools = document.createElement("div");
    tools.className = "watch-panel-tools";
    const entry = { el, id };
    entries.set(id, entry);
    for (const mode of ["move", "resize"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = mode === "move" ? `Move ${name}` : "Resize";
      button.setAttribute("aria-label", `${mode === "move" ? "Move" : "Resize"} ${name}; drag or use arrow keys`);
      button.className = `watch-${mode}`;
      button.addEventListener("pointerdown", event => {
        if (!active || event.button !== 0) return;
        event.preventDefault(); button.focus(); button.setPointerCapture(event.pointerId);
        el.style.zIndex = String(++top);
        drag = { entry, mode, pointer: event.pointerId, x: event.clientX, y: event.clientY, g: { ...layout.panels[id] } };
      });
      button.addEventListener("pointermove", event => {
        if (!drag || drag.entry !== entry || drag.pointer !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y, g = drag.g;
        place(entry, mode === "move" ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, w: g.w + dx, h: g.h + dy });
      });
      const release = event => {
        if (drag?.entry !== entry || drag.pointer !== event.pointerId) return;
        drag = null; save();
      };
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      button.addEventListener("keydown", event => {
        if (!active || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const g = { ...layout.panels[id] }, step = event.shiftKey ? 5 : 20;
        const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? (mode === "move" ? "x" : "w") : (mode === "move" ? "y" : "h");
        g[axis] += ["ArrowLeft", "ArrowUp"].includes(event.key) ? -step : step;
        el.style.zIndex = String(++top); place(entry, g); save();
      });
      tools.append(button);
    }
    el.prepend(tools);
    sizes.observe(el);
    return true;
  }
  const sizes = new ResizeObserver(records => {
    if (!active || watch.clientWidth === 0) return;
    let changed = false;
    for (const record of records) {
      const entry = [...entries.values()].find(item => item.el === record.target);
      if (!entry || !layout.panels[entry.id]) continue;
      const previous = layout.panels[entry.id];
      const w = entry.el.offsetWidth, h = entry.el.offsetHeight;
      if (Math.abs(previous.w - w) < 1 && Math.abs(previous.h - h) < 1) continue;
      place(entry, { ...previous, w, h }); changed = true;
    }
    if (changed && !drag) save();
    height();
  });
  function discover() {
    let changed = false;
    for (const [id, entry] of entries) if (!entry.el.isConnected) { sizes.unobserve(entry.el); entries.delete(id); changed = true; }
    for (const card of residents.children) {
      const name = card.querySelector(".view")?.dataset.name;
      if (name) changed = connect(card, `resident:${name}`, name) || changed;
    }
    changed = connect(document.querySelector("#glance"), "console", "chat and console") || changed;
    if (changed) apply();
  }
  toggle.addEventListener("change", () => { layout.enabled = toggle.checked; apply(); save(); });
  reset.addEventListener("click", () => { drag = null; layout = { enabled: false, panels: {} }; apply(); save(); });
  new MutationObserver(discover).observe(residents, { childList: true });
  let lastWidth = -1;
  new ResizeObserver(() => {
    const width = watch.clientWidth;
    if (width !== lastWidth && !drag) { lastWidth = width; apply(); }
  }).observe(watch);
  media.addEventListener("change", apply);
  discover();
})();
