// The Map's building layer: where residents placed and broke blocks, per chunk, from the hub's copy of
// the server bridge's hour cells (api/server-data/block-map), under the trails of the shown dimension.
// Below the map: what to show and whose, an hourly strip (select an hour to show only it), "who built
// where", and a selected chunk's hours, block kinds and the recent individual changes the hub keeps.
import { areaName, chunkOf, chunkSummaries, gapText, hourBars, itemName, kindsText, shade } from "./server-data.js";

const KEY = "commons.mapBlocks";
const HOUR = 3_600_000;
const SHOW = [{ value: "off", label: "Off" }, { value: "both", label: "Placed and broken" }, { value: "placed", label: "Placed" }, { value: "broken", label: "Broken" }];

export function createBlockLayer(root, { html, setHtml, get, colour, canvasColour, stamp, clock, ago, now, hours, dimension, dimensionLabel, places, residents, redraw, centre }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { /* private mode */ }
  const layer = {
    show: SHOW.some(s => s.value === saved.show) ? saved.show : "both", who: typeof saved.who === "string" ? saved.who : "All",
    hour: null, data: null, hourData: null, chunks: [], max: 0, selected: null, cell: null, problem: "", since: 0, until: 0,
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ show: layer.show, who: layer.who })); } catch { /* ignore */ } };
  const count = number => Math.round(number).toLocaleString("en-US");
  const span = (chunkX, chunkZ) => `x ${chunkX * 16}..${chunkX * 16 + 15}, z ${chunkZ * 16}..${chunkZ * 16 + 15}`;
  const range = () => layer.hour === null ? [layer.since, layer.until] : [layer.hour, layer.hour + HOUR];

  function recompute() {
    const cells = (layer.hour === null ? layer.data?.cells : layer.hourData?.cells) ?? [];
    layer.chunks = layer.show === "off" ? [] : chunkSummaries(cells, { dimension: dimension(), who: layer.who, show: layer.show });
    layer.max = Math.max(0, ...layer.chunks.map(chunk => chunk.total));
  }
  const chunkAt = (x, z) => { const [cx, cz] = chunkOf(x, z); return layer.chunks.find(chunk => chunk.chunkX === cx && chunk.chunkZ === cz); };

  /** Called by the map while drawing, after its grid and before the trails. */
  function draw(ctx, toScreen, width, height) {
    if (!layer.chunks.length) return;
    for (const chunk of layer.chunks) {
      const [x1, y1] = toScreen(chunk.chunkX * 16, chunk.chunkZ * 16), [x2, y2] = toScreen(chunk.chunkX * 16 + 16, chunk.chunkZ * 16 + 16);
      if (x2 < 0 || y2 < 0 || x1 > width || y1 > height) continue;
      ctx.globalAlpha = shade(chunk.total, layer.max);
      ctx.fillStyle = canvasColour(chunk.lead);
      ctx.fillRect(x1, y1, Math.max(2, x2 - x1), Math.max(2, y2 - y1));
      if (chunk.residents.length > 1 && x2 - x1 > 6) {
        // More than one resident worked here: a corner in the second one's colour.
        ctx.globalAlpha = .9; ctx.fillStyle = canvasColour(chunk.residents[1].name);
        const s = Math.min(8, (x2 - x1) / 3);
        ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - s, y2); ctx.lineTo(x2, y2 - s); ctx.closePath(); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const chosen = layer.selected?.dimension === dimension() ? layer.selected : null;
    if (chosen) {
      const [x1, y1] = toScreen(chosen.chunkX * 16, chosen.chunkZ * 16), [x2, y2] = toScreen(chosen.chunkX * 16 + 16, chosen.chunkZ * 16 + 16);
      ctx.lineWidth = 2; ctx.strokeStyle = "#ece4d2"; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
  }
  /** The readout's words for a point over a shaded chunk, or "" when there is none. */
  function describe(x, z) {
    const chunk = chunkAt(x, z);
    if (!chunk) return "";
    return `Chunk ${chunk.chunkX}, ${chunk.chunkZ}: ${chunk.residents.map(r => `${r.name} placed ${count(r.placed)}, broke ${count(r.broken)}`).join("; ")}${layer.hour === null ? "" : ` at ${clock(layer.hour, false)}`}. Select for detail.`;
  }
  /** A press on the map that hit no other feature: select the chunk under it, if shaded. */
  function select(x, z) {
    const chunk = chunkAt(x, z);
    if (!chunk) return false;
    choose(dimension(), chunk.chunkX, chunk.chunkZ);
    return true;
  }
  function choose(where, chunkX, chunkZ) {
    layer.selected = { dimension: where, chunkX, chunkZ };
    layer.cell = null;
    render(); redraw();
    void loadCell();
  }
  async function loadCell() {
    const chosen = layer.selected;
    if (!chosen) return;
    const [since, until] = range();
    try {
      const cell = await get(`api/server-data/block-cell?dimension=${encodeURIComponent(chosen.dimension)}&chunkX=${chosen.chunkX}&chunkZ=${chosen.chunkZ}&since=${since}&until=${until}&limit=100`);
      if (layer.selected === chosen) { layer.cell = cell; render(); }
    } catch (error) { if (layer.selected === chosen) { layer.cell = { problem: error.message }; render(); } }
  }

  function sourceLine() {
    const set = layer.data?.health;
    if (!set) return "";
    const parts = ["Counted by the server per chunk and hour as residents place and break blocks; explosions, pistons, water and lava, mobs, machines and bucket placement are not seen."];
    if (set.supported === false) parts.push(html`<span class="bad">The server bridge running now does not offer ${kindsText(set.missing)} (an older version), so this layer is not being updated.</span>`);
    if (set.gaps.count) parts.push(html`<span class="warn">${set.gaps.count} known ${set.gaps.count === 1 ? "gap" : "gaps"} in 7 days (${gapText(set.gaps.recent[0].detail, stamp)}).</span>`);
    if (layer.data.truncated) parts.push(html`<span class="warn">Only the busiest ${count(layer.data.cells.length)} chunk counts are drawn.</span>`);
    parts.push(set.newest ? `Newest change ${ago(set.newest)}.` : "No block changes stored yet.");
    return html`${parts.map((part, i) => html`${i ? " " : ""}${part}`)}`;
  }
  function cellPanel() {
    const chosen = layer.selected, cell = layer.cell;
    if (!chosen) return html`<p class="fine">Select a shaded chunk on the map for its hours, the kinds of block and the recent individual changes.</p>`;
    const head = html`<h3>Chunk ${chosen.chunkX}, ${chosen.chunkZ}</h3><p class="data">${span(chosen.chunkX, chosen.chunkZ)} · ${dimensionLabel(chosen.dimension)}</p>`;
    if (!cell) return html`${head}<p class="fine">Reading…</p>`;
    if (cell.problem) return html`${head}<p class="bad">${cell.problem}</p>`;
    const byResident = new Map();
    for (const row of cell.hours) {
      const entry = byResident.get(row.resident) ?? { placed: 0, broken: 0, hours: [] };
      entry.placed += row.placed; entry.broken += row.broken; entry.hours.push(row);
      byResident.set(row.resident, entry);
    }
    return html`${head}
      ${byResident.size ? html`<ul class="record-plain">${[...byResident].map(([name, entry]) => html`<li class="who-line" style="--who:${colour(name)}"><b>${name}</b> placed ${count(entry.placed)}, broke ${count(entry.broken)}
        <span class="meta">${entry.hours.map(row => `${clock(row.hour, false)} ${count(row.placed + row.broken)}`).join(" · ")}</span></li>`)}</ul>`
        : html`<p class="fine">No changes counted here in this period.</p>`}
      ${cell.kinds.length ? html`<table class="ledger-table"><thead><tr><th scope="col">Block</th><th scope="col">Who</th><th scope="col">Placed</th><th scope="col">Broken</th></tr></thead>
        <tbody>${cell.kinds.slice(0, 12).map(kind => html`<tr><td>${itemName(kind.block)}</td><td>${kind.resident}</td><td class="data">${kind.placed || ""}</td><td class="data">${kind.broken || ""}</td></tr>`)}
        ${cell.other.map(other => html`<tr><td class="meta">other kinds (not named per hour)</td><td>${other.resident}</td><td class="data">${other.placed || ""}</td><td class="data">${other.broken || ""}</td></tr>`)}</tbody></table>` : ""}
      <h4>Individual changes</h4>
      <p class="fine">${count(cell.detailed)} of the ${count(cell.counted)} counted changes have their own record here: the server keeps only a sample (it skips some in bursts),
        and the hub keeps them 14 days${cell.detailFrom ? `; the oldest it still has is from ${stamp(cell.detailFrom)}` : ""}.</p>
      ${cell.changes.length ? html`<ol class="record-timeline">${cell.changes.map(change => html`<li><time>${stamp(change.at)}</time>
        <span><b style="color:${colour(change.resident)}">${change.resident}</b> ${change.action === "place" ? "placed" : "broke"} ${itemName(change.block)} <span class="data meta">${change.x}, ${change.y}, ${change.z}</span></span></li>`)}</ol>` : ""}`;
  }

  function render() {
    if (residents()?.role === "station") { root.hidden = true; return; }
    root.hidden = false;
    recompute();
    const names = [...new Set((layer.data?.hours ?? []).map(row => row.resident))].sort();
    setHtml(root.querySelector("#mb-show"), html`${SHOW.map(choice => html`<button type="button" data-show="${choice.value}" aria-pressed="${String(choice.value === layer.show)}">${choice.label}</button>`)}`);
    setHtml(root.querySelector("#mb-who"), html`<button type="button" data-who-pick="All" aria-pressed="${String(layer.who === "All")}">All</button>${names.map(name =>
      html`<button type="button" data-who-pick="${name}" data-who style="--who:${colour(name)}" aria-pressed="${String(layer.who === name)}">${name}</button>`)}`);
    setHtml(root.querySelector("#mb-source"), sourceLine());
    if (layer.problem) { setHtml(root.querySelector("#mb-summary"), html`<span class="bad">${layer.problem}</span>`); return; }
    const where = dimension();
    const bars = layer.data ? hourBars(layer.data.hours, { since: layer.since, until: now(), dimension: where, who: layer.who, show: layer.show === "off" ? "both" : layer.show }) : [];
    const top = Math.max(1, ...bars.map(bar => bar.placed + bar.broken));
    const placed = bars.reduce((sum, bar) => sum + bar.placed, 0), broken = bars.reduce((sum, bar) => sum + bar.broken, 0);
    setHtml(root.querySelector("#mb-hours"), html`${bars.map(bar => html`<button type="button" data-hour="${bar.hour}" aria-pressed="${String(bar.hour === layer.hour)}"
      title="${`${stamp(bar.hour)}: placed ${bar.placed}, broke ${bar.broken}`}" aria-label="${`${stamp(bar.hour)}: placed ${bar.placed}, broke ${bar.broken}`}"
      style="--p:${((bar.placed) / top * 100).toFixed(1)}%;--b:${((bar.broken) / top * 100).toFixed(1)}%"><i class="p"></i><i class="b"></i></button>`)}`);
    const any = placed + broken > 0;
    root.querySelector("#mb-hours").hidden = !any;
    setHtml(root.querySelector("#mb-summary"), !any && layer.hour === null
      ? html`No block changes${layer.who === "All" ? "" : ` by ${layer.who}`} in the ${dimensionLabel(where)} in the map's window.`
      : html`${layer.hour === null
        ? `In the ${dimensionLabel(where)}, over the map's window: ${count(placed)} placed and ${count(broken)} broken${layer.who === "All" ? "" : ` by ${layer.who}`}.`
        : html`Showing only ${stamp(layer.hour)} to ${clock(layer.hour + HOUR, false)}. <button type="button" class="link" data-hour="${layer.hour}">Show the whole window</button>`}
      ${layer.show === "off" ? " The layer is off." : ` ${count(layer.chunks.length)} ${layer.chunks.length === 1 ? "chunk" : "chunks"} shaded in the resident's colour; stronger means more changes; a corner shows a second resident.`}
      Bars above: each hour from ${stamp(bars[0].hour)} to ${clock(bars.at(-1).hour + HOUR, false)}, green placed, brown broken; select one to show only that hour.`);
    const areas = (layer.data?.areas ?? []).filter(area => area.dimension === where && (layer.who === "All" || area.resident === layer.who));
    setHtml(root.querySelector("#mb-areas"), areas.length ? html`<h3>Who built where</h3><ul class="record-areas">${areas.slice(0, 10).map(area => {
      const name = areaName(area, places());
      return html`<li style="--who:${colour(area.resident)}"><b>${area.resident}</b> ${name.text} <span class="meta">${name.span}</span><br>
        placed ${count(area.placed)}, broke ${count(area.broken)}${area.kinds.length ? `; mostly ${area.kinds.map(kind => itemName(kind.block)).join(", ")}` : ""}
        <button type="button" class="link" data-centre="${JSON.stringify([name.x, name.z])}">Centre</button></li>`;
    })}</ul>` : "");
    setHtml(root.querySelector("#mb-cell"), cellPanel());
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.show) { layer.show = button.dataset.show; save(); render(); redraw(); }
    else if (button.dataset.whoPick) { layer.who = button.dataset.whoPick; save(); render(); redraw(); }
    else if (button.dataset.hour) {
      const hour = Number(button.dataset.hour);
      layer.hour = layer.hour === hour ? null : hour; layer.hourData = null;
      render(); redraw(); void load();
    } else if (button.dataset.centre) { const [x, z] = JSON.parse(button.dataset.centre); centre(dimension(), x, z); }
  });

  async function load() {
    if (residents()?.role === "station") { root.hidden = true; return; }
    layer.until = now() + HOUR; layer.since = now() - hours() * HOUR;
    try {
      const hour = layer.hour;
      const [data, hourData] = await Promise.all([
        get(`api/server-data/block-map?since=${layer.since}&until=${layer.until}`),
        hour === null ? null : get(`api/server-data/block-map?since=${hour}&until=${hour + HOUR}`),
      ]);
      Object.assign(layer, { data, hourData, problem: "" });
      // An hour that slid out of the window is let go.
      if (layer.hour !== null && layer.hour < layer.since - HOUR) layer.hour = null;
      if (layer.selected) void loadCell();
    } catch (error) { layer.problem = `Building layer: ${error.message}`; }
    render();
  }
  return {
    load, render, draw, describe, select, choose, loadCell,
    /** Dimensions with block changes in the window, for the map's dimension switch. */
    dimensions: () => (layer.data?.dimensions ?? []).map(entry => entry.dimension),
  };
}
