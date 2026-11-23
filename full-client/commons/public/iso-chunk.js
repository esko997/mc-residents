// Prototype for docs/map-3d.md: an isometric "diorama" of 1-81 chunks painted on a 2D canvas
// from a block grid. The terrain here is SYNTHETIC (seeded noise, one carved tunnel, a resident
// in it); no world data is read. It measures what a canvas painter costs and shows the cut-away.
const $ = selector => document.querySelector(selector);
const AIR = 0, STONE = 1, DIRT = 2, GRASS = 3, SAND = 4, WATER = 5, COAL = 6, IRON = 7, DIAMOND = 8, BEDROCK = 9,
  DEEPSLATE = 10, NETHERRACK = 11, LAVA = 12, SOUL_SAND = 13, GLOWSTONE = 14, QUARTZ = 15;
const COLOURS = {
  [STONE]: [128, 128, 128], [DIRT]: [134, 96, 67], [GRASS]: [106, 168, 79], [SAND]: [219, 207, 142], [WATER]: [62, 108, 220],
  [COAL]: [52, 52, 52], [IRON]: [200, 162, 122], [DIAMOND]: [95, 224, 224], [BEDROCK]: [51, 51, 51], [DEEPSLATE]: [80, 84, 92],
  [NETHERRACK]: [122, 46, 46], [LAVA]: [240, 122, 26], [SOUL_SAND]: [84, 64, 50], [GLOWSTONE]: [250, 210, 110], [QUARTZ]: [232, 224, 214],
};
const HEIGHT = 128; // world y 0..127 in this prototype (a real Overworld chunk is 384 tall, -64..319)

function random(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function noise2(seed) {
  const grid = new Map(), rnd = (x, z) => { const k = `${x},${z}`; if (!grid.has(k)) grid.set(k, random(seed ^ (x * 73856093) ^ (z * 19349663))()); return grid.get(k); };
  const smooth = t => t * t * (3 - 2 * t);
  return (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = smooth(x - x0), fz = smooth(z - z0);
    const a = rnd(x0, z0), b = rnd(x0 + 1, z0), c = rnd(x0, z0 + 1), d = rnd(x0 + 1, z0 + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
  };
}

/** A synthetic block grid `side`×HEIGHT×`side` (side = 16 × chunks across), plus the resident's spot. */
function world(scene, side) {
  const blocks = new Uint8Array(side * side * HEIGHT), at = (x, y, z) => (y * side + z) * side + x;
  const n1 = noise2(7), n2 = noise2(11), n3 = noise2(23), rnd = random(42);
  let lowest = HEIGHT, highest = 0;
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    if (scene === "nether") {
      const floor = Math.round(30 + 18 * n1(x / 20, z / 20) + 6 * n2(x / 6, z / 6));
      const roof = Math.round(98 + 14 * n3(x / 18, z / 18));
      for (let y = 0; y < HEIGHT; y++) {
        let block = AIR;
        if (y === 0 || y >= 124) block = BEDROCK;
        else if (y <= floor || y >= roof) block = rnd() < .03 ? QUARTZ : y <= floor && y > floor - 2 && n2(x / 4, z / 4) > .7 ? SOUL_SAND : NETHERRACK;
        else if (y <= 31) block = LAVA;
        else if (y === roof - 1 && rnd() < .02) block = GLOWSTONE;
        blocks[at(x, y, z)] = block;
      }
      continue;
    }
    const top = Math.round(62 + 16 * n1(x / 28, z / 28) + 5 * n2(x / 7, z / 7));
    lowest = Math.min(lowest, top); highest = Math.max(highest, top);
    for (let y = 0; y < HEIGHT; y++) {
      let block = AIR;
      if (y === 0) block = BEDROCK;
      else if (y < 8) block = DEEPSLATE;
      else if (y < top - 3) {
        const roll = rnd();
        block = y < 16 && roll < .004 ? DIAMOND : y < 60 && roll < .012 ? IRON : roll < .02 ? COAL : STONE;
      } else if (y < top) block = top <= 64 ? SAND : DIRT;
      else if (y === top) block = top <= 63 ? SAND : GRASS;
      else if (y <= 62) block = WATER;
      blocks[at(x, y, z)] = block;
    }
  }
  // One tunnel: a resident's staircase mine from the middle of the area down to y 20.
  const centre = side / 2, start = scene === "nether" ? 60 : 80;
  let resident = [centre, 20, centre];
  for (let step = 0; step <= 260; step++) {
    const t = step / 260, x = centre + Math.cos(t * 5) * side * .22, z = centre + Math.sin(t * 5) * side * .22, y = start - (start - 22) * t;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const bx = Math.round(x + dx), by = Math.round(y + dy), bz = Math.round(z + dz);
      if (dx * dx + dz * dz > 5 || bx < 0 || bz < 0 || bx >= side || bz >= side || by <= 0 || by >= HEIGHT) continue;
      if (blocks[at(bx, by, bz)] !== BEDROCK && blocks[at(bx, by, bz)] !== WATER) blocks[at(bx, by, bz)] = AIR;
    }
    if (step === 236) resident = [Math.round(x), Math.round(y) - 1, Math.round(z)];
  }
  // The diorama starts a little below the lowest thing of interest; the Nether shows its lava sea.
  const floor = scene === "nether" ? 20 : Math.max(1, Math.min(resident[1] - 6, lowest - 12));
  return { blocks, side, at, resident, floor, top: scene === "nether" ? HEIGHT - 1 : Math.max(highest, 62) };
}

/**
 * The faces a viewer from the south-east, above, can see: top (+y), east (+x), south (+z).
 * `cut` removes everything above that height and paints the cut surface; `surfaceOnly` keeps just
 * each column's highest block filled solid downwards (what a heightmap alone can show).
 */
function faces(model, cut, surfaceOnly) {
  const { blocks, side, at } = model, list = [];
  const solid = (x, y, z) => {
    if (x < 0 || z < 0 || x >= side || z >= side || y < 0) return false;
    if (y > cut) return false;
    const block = blocks[at(x, y, z)];
    return block !== AIR && block !== WATER;
  };
  const tops = surfaceOnly ? new Int16Array(side * side).fill(-1) : null;
  if (surfaceOnly) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    for (let y = Math.min(cut, HEIGHT - 1); y >= 0; y--) { const b = blocks[at(x, y, z)]; if (b !== AIR) { tops[z * side + x] = y; break; } }
  }
  const blockAt = (x, y, z) => {
    if (!surfaceOnly) return blocks[at(x, y, z)];
    const top = tops[z * side + x];
    return y > top ? AIR : y === top ? blocks[at(x, y, z)] : STONE;
  };
  const filled = surfaceOnly ? (x, y, z) => x >= 0 && z >= 0 && x < side && z < side && y >= 0 && y <= tops[z * side + x] && blocks[at(x, tops[z * side + x], z)] !== WATER : solid;
  for (let y = model.floor; y <= Math.min(cut, HEIGHT - 1); y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const block = blockAt(x, y, z);
    if (block === AIR) continue;
    if (block === WATER) {
      if (y === Math.min(cut, HEIGHT - 1) || blockAt(x, y + 1, z) === AIR) list.push([x, y, z, 0, block, false]);
      continue;
    }
    const top = y === cut ? 1 : !filled(x, y + 1, z) ? 0 : -1;
    if (top >= 0) list.push([x, y, z, 0, block, top === 1]);
    if (!filled(x + 1, y, z)) list.push([x, y, z, 1, block, false]);
    if (!filled(x, y, z + 1)) list.push([x, y, z, 2, block, false]);
  }
  // Back to front: a unit cube can only hide cubes with a smaller x + y + z.
  list.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  return list;
}

function draw(model, list, options) {
  const canvas = $("#iso"), ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = "#14171b"; ctx.fillRect(0, 0, width, height);
  const side = model.side, span = model.top + 1 - model.floor;
  const tile = Math.min(28, (width - 40) / side, (height - 40) / (side / 2 + span / 2));
  const ox = width / 2, oy = 20 + span * tile / 2;
  const project = (x, y, z) => [ox + (x - z) * tile / 2, oy + (x + z) * tile / 4 - (y - model.floor) * tile / 2];
  const quad = (points, fill, seal) => {
    ctx.beginPath(); ctx.moveTo(...project(...points[0]));
    for (let i = 1; i < 4; i++) ctx.lineTo(...project(...points[i]));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    // Anti-aliased edges would leave hairline seams that show the faces painted behind.
    if (seal) { ctx.strokeStyle = fill; ctx.lineWidth = .8; ctx.stroke(); }
  };
  const [rx, ry, rz] = model.resident, residentSum = rx + ry + rz;
  let residentDrawn = false;
  const drawResident = alpha => {
    const [sx, sy] = project(rx + .5, ry + 1, rz + .5);
    ctx.globalAlpha = alpha; ctx.fillStyle = "#58c2b4"; ctx.strokeStyle = "#14171b"; ctx.lineWidth = 1.5;
    ctx.fillRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6); ctx.strokeRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6);
    ctx.globalAlpha = 1;
  };
  for (const [x, y, z, face, block, cutFace] of list) {
    if (!residentDrawn && x + y + z > residentSum) { drawResident(1); residentDrawn = true; }
    const [r, g, b] = COLOURS[block], shade = face === 0 ? (cutFace ? .55 : 1) : face === 1 ? .78 : .62;
    const alpha = block === WATER ? .72 : 1, fill = `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},${alpha})`;
    const seal = block !== WATER;
    if (face === 0) quad([[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
    else if (face === 1) quad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], fill, seal);
    else quad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
  }
  if (!residentDrawn) drawResident(1);
  // Where the resident is even when rock hides it: a ghost outline on top.
  if (options.ghost) {
    const [sx, sy] = project(rx + .5, ry + 1, rz + .5);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = "#58c2b4"; ctx.lineWidth = 1.5;
    ctx.strokeRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6); ctx.setLineDash([]);
    ctx.font = "bold 12px system-ui"; ctx.fillStyle = "#58c2b4"; ctx.fillText(`Wren, y ${ry + 1}`, sx + tile, sy - tile);
  }
}

const state = { scene: "overworld", chunks: 1, cut: 127, surfaceOnly: false, ghost: true, model: null, key: "" };
function render() {
  const key = `${state.scene}:${state.chunks}`;
  if (key !== state.key) { state.model = world(state.scene, 16 * Math.round(Math.sqrt(state.chunks))); state.key = key; }
  const t0 = performance.now(), list = faces(state.model, state.cut, state.surfaceOnly), t1 = performance.now();
  draw(state.model, list, state);
  const t2 = performance.now();
  $("#iso-stats").textContent = `${state.chunks} chunk${state.chunks > 1 ? "s" : ""} (${state.model.side}×${state.model.side} columns, ${HEIGHT} tall): `
    + `${list.length.toLocaleString("en-US")} faces; faces found in ${(t1 - t0).toFixed(0)} ms, painted in ${(t2 - t1).toFixed(0)} ms`;
  $("#iso-cut-value").textContent = state.cut >= 127 ? "no cut" : `cut at y ${state.cut}`;
}
for (const input of document.querySelectorAll("[data-set]")) {
  input.addEventListener("input", () => {
    const value = input.type === "checkbox" ? input.checked : input.type === "range" || input.dataset.number ? Number(input.value) : input.value;
    state[input.dataset.set] = value; render();
  });
}
$("#iso-cut-resident").addEventListener("click", () => {
  if (!state.model) return;
  state.cut = state.model.resident[1] + 3; $('[data-set="cut"]').value = String(state.cut); render();
});
new ResizeObserver(render).observe($("#iso"));
