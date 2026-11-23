// The Diorama panel's data and painter (docs/map-3d.md): the blocks around one resident as an
// isometric slab, read from its own client (Synapse GET /chunks through api/diorama). Pure
// helpers are exported for the tests; `paint` draws on a 2D canvas, viewed from the south-east
// and above, faces sorted back to front. No world data is invented: columns the client did
// not hold are drawn as hatched gaps.
//
// What is drawn is a *window* of the grid, in grid coordinates: layers `bottom`..`top` (the
// levels around the feet and the cut) minus an optional `open` corner (the cutaway that keeps
// the resident visible). faces(), pick() and covered() all see the grid through the same
// window, so the readout names what is drawn.

/** Air never draws; the other ids here get special treatment by kind. */
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
/** Drawn as a flat marker on the block's floor and see-through to what is behind. */
const THIN = /(^|[:_])(grass|short_grass|tall_grass|fern|large_fern|flower|tulip|poppy|dandelion|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torch|wall_torch|sapling|mushroom|dead_bush|vine|vines|kelp|kelp_plant|seagrass|tall_seagrass|roots|sprouts|rail|powered_rail|detector_rail|activator_rail|button|lever|carpet|ladder|sign|wall_sign|hanging_sign|banner|wall_banner|pressure_plate|tripwire|tripwire_hook|redstone_wire|cobweb|candle|sugar_cane|lichen|glow_lichen|sculk_vein|pointed_dripstone|chain|lantern|soul_lantern|flower_pot|fire|soul_fire|snow|lily_pad|cave_vines|cave_vines_plant|hanging_roots|spore_blossom|small_dripleaf|big_dripleaf_stem|sweet_berry_bush|wheat|carrots|potatoes|beetroots|nether_wart|crimson_fungus|warped_fungus|nether_sprouts|weeping_vines|twisting_vines|weeping_vines_plant|twisting_vines_plant|scaffolding|end_rod|lightning_rod|bamboo_sapling|moss_carpet|pink_petals|frogspawn|bubble_column|structure_void|light|barrier)$/;
const GLASS = /(^|[:_])(glass|glass_pane|ice|frosted_ice|slime_block|honey_block)$/;
const LIQUID = /(^|:)(water|lava|flowing_water|flowing_lava)$|:.*_(fluid|still|flowing)$/;

/** Hand-picked approximations (not taken from any texture) for when no table was built on the host. */
export const BUILTIN_COLOURS = {
  stone: [125, 125, 125], cobblestone: [118, 118, 118], mossy_cobblestone: [105, 120, 95], andesite: [136, 136, 138], diorite: [190, 190, 190],
  granite: [150, 105, 85], tuff: [106, 107, 98], calcite: [222, 222, 218], deepslate: [80, 80, 86], cobbled_deepslate: [76, 76, 82],
  bedrock: [52, 52, 52], dirt: [134, 96, 67], coarse_dirt: [118, 85, 60], rooted_dirt: [140, 100, 72], mud: [60, 57, 60], podzol: [92, 64, 28],
  grass_block: [106, 168, 79], dirt_path: [148, 122, 66], farmland: [120, 80, 50], mycelium: [112, 98, 104], moss_block: [90, 110, 45],
  sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], gravel: [131, 127, 126], clay: [160, 166, 179],
  snow_block: [240, 246, 246], snow: [240, 246, 246], ice: [146, 184, 254], packed_ice: [141, 180, 250], blue_ice: [116, 167, 253],
  water: [62, 108, 220], lava: [230, 112, 24], obsidian: [20, 18, 30], crying_obsidian: [40, 10, 70],
  coal_ore: [96, 96, 96], deepslate_coal_ore: [64, 64, 66], iron_ore: [172, 150, 132], deepslate_iron_ore: [110, 100, 92],
  copper_ore: [130, 125, 100], deepslate_copper_ore: [96, 96, 86], gold_ore: [180, 166, 100], deepslate_gold_ore: [118, 108, 70],
  redstone_ore: [150, 92, 92], deepslate_redstone_ore: [112, 64, 66], lapis_ore: [96, 110, 150], deepslate_lapis_ore: [76, 86, 118],
  diamond_ore: [110, 180, 178], deepslate_diamond_ore: [86, 130, 132], emerald_ore: [108, 160, 116], deepslate_emerald_ore: [78, 116, 92],
  nether_gold_ore: [140, 72, 48], nether_quartz_ore: [150, 100, 92], ancient_debris: [96, 64, 56], raw_iron_block: [166, 135, 107],
  oak_log: [110, 86, 52], spruce_log: [58, 38, 18], birch_log: [216, 215, 210], jungle_log: [86, 68, 26], acacia_log: [104, 96, 86], dark_oak_log: [60, 46, 26],
  oak_leaves: [72, 120, 40], spruce_leaves: [56, 92, 56], birch_leaves: [92, 124, 60], jungle_leaves: [60, 120, 30], acacia_leaves: [80, 116, 40], dark_oak_leaves: [56, 100, 30],
  oak_planks: [162, 131, 79], spruce_planks: [115, 85, 49], birch_planks: [192, 175, 121], crafting_table: [130, 100, 60], chest: [160, 112, 48],
  furnace: [110, 110, 110], glass: [200, 225, 235], torch: [250, 205, 90], lantern: [220, 170, 80], bricks: [150, 97, 83], stone_bricks: [122, 121, 122],
  netherrack: [111, 54, 53], soul_sand: [81, 62, 51], soul_soil: [75, 57, 46], basalt: [80, 81, 86], blackstone: [42, 36, 41], magma_block: [140, 60, 20],
  glowstone: [250, 210, 110], nether_bricks: [44, 22, 26], crimson_nylium: [130, 31, 31], warped_nylium: [43, 114, 101], shroomlight: [240, 146, 70],
  end_stone: [220, 223, 158], purpur_block: [170, 126, 170], amethyst_block: [134, 98, 191], dripstone_block: [134, 107, 92], sculk: [12, 30, 36],
  short_grass: [104, 160, 72], grass: [104, 160, 72], tall_grass: [104, 160, 72], fern: [90, 140, 60], kelp: [80, 140, 50], seagrass: [70, 130, 50],
  rail: [140, 120, 100], cobweb: [220, 220, 220], terracotta: [152, 94, 67], white_wool: [234, 236, 236],
};

/** A stable colour for an id nobody listed: hue from its hash, muted. */
export function hashColour(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const hue = (h % 360) / 60, s = .32, l = .5, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(hue % 2 - 1)), m = l - c / 2;
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}

/** The colour of a block: the host's table ("#rrggbb"), then the built-in one by vanilla name, then the hash. */
export function blockColour(id, table = {}) {
  const hex = table[id];
  if (typeof hex === "string" && /^#[0-9a-f]{6}$/.test(hex)) return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  if (id.startsWith("minecraft:") && BUILTIN_COLOURS[id.slice(10)]) return BUILTIN_COLOURS[id.slice(10)];
  return hashColour(id);
}

/** How a block takes part in the picture. */
export function blockKind(id) {
  if (AIR.has(id)) return "air";
  if (LIQUID.test(id)) return /lava/.test(id) ? "solid" : "liquid";
  if (GLASS.test(id)) return "glass";
  if (THIN.test(id)) return "thin";
  return "solid";
}

/** 4096 palette indices of `bits` bits, least significant bit first (Synapse's SectionCodec.pack). */
export function unpack(bytes, bits, count = 4096) {
  const out = new Uint16Array(count);
  if (!bits) return out;
  const mask = (1 << bits) - 1;
  for (let i = 0, bit = 0; i < count; i++, bit += bits) {
    const at = bit >> 3, shift = bit & 7;
    // At most 12 bits starting anywhere in a byte span three bytes.
    out[i] = ((bytes[at] | (bytes[at + 1] ?? 0) << 8 | (bytes[at + 2] ?? 0) << 16) >> shift) & mask;
  }
  return out;
}

/** A section's indices from its base64 zlib `data` (none when bits is 0). */
export async function decodeSection(section) {
  if (!section.bits) return new Uint16Array(4096);
  const compressed = Uint8Array.from(atob(section.data), char => char.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
  return unpack(new Uint8Array(await new Response(stream).arrayBuffer()), section.bits);
}

/**
 * Where to cut by default: in a dimension with a ceiling (the Nether) always, three blocks over
 * the feet; underground (no sky light at the feet in a dimension that has sky) at head height,
 * so a 1 × 2 tunnel is open from above; else none.
 */
export function defaultCut(view) {
  if (view.hasCeiling) return view.origin[1] + 3;
  if (view.hasSkyLight && view.skyLight === 0) return view.origin[1] + 1;
  return null;
}

/**
 * One block grid from the view and its decoded sections (Map "x,y,z" -> { palette, indices }).
 * kinds[k] = { id, kind, rgb }; cells hold kind numbers, 0 is air (also for unread places).
 */
export function buildGrid(view, decoded, table = {}) {
  const span = 2 * view.radius + 1, side = 16 * span, height = Math.max(0, view.maxY - view.minY + 1);
  const minX = ((view.origin[0] >> 4) - view.radius) * 16, minZ = ((view.origin[2] >> 4) - view.radius) * 16;
  const kinds = [{ id: "minecraft:air", kind: "air", rgb: [0, 0, 0] }], byId = new Map([["minecraft:air", 0]]);
  const cells = new Uint16Array(side * side * height);
  for (const { x: cx, y: sy, z: cz } of view.sections) {
    const entry = decoded.get(`${cx},${sy},${cz}`);
    if (!entry) continue;
    // Every air id (cave_air, void_air too) is cell 0, so nothing downstream can draw, name or count it.
    const map = entry.palette.map(id => {
      if (blockKind(id) === "air") return 0;
      if (!byId.has(id)) { byId.set(id, kinds.length); kinds.push({ id, kind: blockKind(id), rgb: blockColour(id, table) }); }
      return byId.get(id);
    });
    const ox = cx * 16 - minX, oz = cz * 16 - minZ, oy = sy * 16 - view.minY;
    if (ox < 0 || oz < 0 || ox >= side || oz >= side || oy < 0 || oy >= height) continue;
    for (let i = 0; i < 4096; i++) {
      const kind = map[entry.indices[i]] ?? 0;
      if (!kind) continue;
      cells[((oy + (i >> 8)) * side + oz + ((i >> 4) & 15)) * side + ox + (i & 15)] = kind;
    }
  }
  const missing = view.missing.map(([x, z]) => [x * 16 - minX, z * 16 - minZ]);
  return { side, height, minX, minZ, minY: view.minY, kinds, cells, missing };
}

/** Levels shown above and below the feet (the page's choices). The host reads ±32. */
export const LEVELS = [4, 8, 16, 32];
export const DEFAULT_LEVELS = 16;
/**
 * Share of the resident's figure that must be covered before the automatic cutaway opens: half,
 * or a quarter when the view is cut at most two blocks over the feet, where the opening is only
 * a step (a 1 × 2 tunnel under the head-height cut covers 45 %; so does a two-block rise beside
 * someone on a hillside, where opening the quarter would carve a large piece of the hill).
 */
export const HIDDEN_SHARE = .5, STEP_SHARE = .25;

/** World heights [low, high] shown for ±levels around the feet, within what was read. */
export function levelRange(view, levels) {
  const feet = view.origin[1];
  return [Math.max(view.minY, feet - levels), Math.min(view.maxY, feet + levels)];
}

/**
 * The cutaway's corner in grid coordinates: everything at x >= open.x, z >= open.z and
 * y >= open.y (the feet's layer, up to the window's top) is left out, so the resident stands in
 * the inner corner of an opened quarter, floor at the feet, walls behind. The corner lies one
 * block beyond floor(position − 0.6) to the west and north: the least that keeps every wall off
 * the figure, which is drawn taller than the body (tests check every position in a block).
 */
export function opening(grid, player) {
  return { x: Math.floor(player.x - grid.minX - .6) - 1, y: Math.floor(player.y - grid.minY), z: Math.floor(player.z - grid.minZ - .6) - 1 };
}

/** A window clamped to the grid. */
function clampWindow(grid, { top = grid.height - 1, bottom = 0, open = null } = {}) {
  return { top: Math.min(top, grid.height - 1), bottom: Math.max(0, bottom), open };
}

/** The kind number drawn at a grid cell through a window: 0 outside it, in the opening, or air. */
function shownAt(grid, win) {
  const { side, kinds, cells } = grid, { top, bottom, open } = win;
  return (x, y, z) => {
    if (x < 0 || z < 0 || x >= side || z >= side || y < bottom || y > top) return 0;
    const k = cells[(y * side + z) * side + x];
    // Thin things on the opened floor (a torch, a rail) stay: they hide nothing.
    if (k && open && x >= open.x && z >= open.z && y >= open.y && !(y === open.y && kinds[k].kind === "thin")) return 0;
    return k;
  };
}

/**
 * The visible faces from the south-east above, back to front: [x, y, z, face, kind, cut] in grid
 * coordinates; face 0 top, 1 east (+x), 2 south (+z), 3 a thin block's floor marker. `win` is
 * { top, bottom, open } (see the head of this file). A face is a cut surface (painted darker)
 * when the block in front of it is in the data but not drawn (above the cut or in the opening),
 * and the top of the data is always one.
 */
export function faces(grid, win = {}) {
  const { side, height, kinds, cells } = grid, { top, bottom, open } = clampWindow(grid, win), list = [];
  const at = shownAt(grid, { top, bottom, open }), kindAt = (x, y, z) => kinds[at(x, y, z)].kind;
  const held = (x, y, z) => x >= 0 && z >= 0 && x < side && z < side && y >= 0 && y < height && cells[(y * side + z) * side + x] !== 0;
  const cutBy = (x, y, z) => y >= height || (held(x, y, z) && !at(x, y, z));
  for (let y = bottom; y <= top; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const k = at(x, y, z), kind = kinds[k].kind;
    if (kind === "air") continue;
    if (kind === "thin") { list.push([x, y, z, 3, k, false]); continue; }
    const above = kindAt(x, y + 1, z), east = kindAt(x + 1, y, z), south = kindAt(x, y, z + 1);
    if (kind === "liquid" || kind === "glass") {
      if (above !== kind && above !== "solid") list.push([x, y, z, 0, k, false]);
      if (east !== kind && east !== "solid") list.push([x, y, z, 1, k, false]);
      if (south !== kind && south !== "solid") list.push([x, y, z, 2, k, false]);
      continue;
    }
    if (above !== "solid") list.push([x, y, z, 0, k, cutBy(x, y + 1, z)]);
    if (east !== "solid") list.push([x, y, z, 1, k, cutBy(x + 1, y, z)]);
    if (south !== "solid") list.push([x, y, z, 2, k, cutBy(x, y, z + 1)]);
  }
  // A unit cube can only hide cubes with a smaller x + y + z.
  list.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  return list;
}

/** Screen geometry for a grid window in a box: tile size and the projection. */
export function layout(grid, width, height, win = {}) {
  const { top, bottom } = clampWindow(grid, win), span = top - bottom + 2;
  const tile = Math.max(2, Math.min(28, (width - 24) / grid.side, (height - 28) / (grid.side / 2 + span / 2)));
  const ox = width / 2, oy = 14 + (top + 2) * tile / 2;
  return { tile, project: (x, y, z) => [ox + (x - z) * tile / 2, oy + (x + z) * tile / 4 - y * tile / 2] };
}

/**
 * Walks the line of sight through the grid point [px, py, pz] from the viewer's side (direction
 * −1, −1, −1, the order the painter covers things in) and returns the first drawn cell that
 * `stop(x, y, z, k, line)` accepts, as { x, y, z, k }, or null. `line(y)` gives the line's x
 * and z at height y, for thin blocks' markers.
 */
function march(grid, win, [px, py, pz], stop) {
  const { top, bottom } = win, at = shownAt(grid, win);
  const y0 = top + 1, x0 = px + y0 - py, z0 = pz + y0 - py;
  const line = y => [x0 - (y0 - y), z0 - (y0 - y)];
  let cx = Math.ceil(x0) - 1, cy = top, cz = Math.ceil(z0) - 1, tx = x0 - cx, ty = 1, tz = z0 - cz;
  while (cy >= bottom && cx >= 0 && cz >= 0) {
    if (cx < grid.side && cz < grid.side) {
      const k = at(cx, cy, cz);
      if (k && stop(cx, cy, cz, k, line)) return { x: cx, y: cy, z: cz, k };
    }
    if (tx <= ty && tx <= tz) { cx--; tx++; } else if (ty <= tz) { cy--; ty++; } else { cz--; tz++; }
  }
  return null;
}

/** Whether the line of sight crosses a thin block's floor marker (painted at y + .12, the middle half). */
function onMarker(x, y, z, line) {
  const [lx, lz] = line(y + .12);
  return lx - x >= .25 && lx - x <= .75 && lz - z >= .25 && lz - z <= .75;
}

/** A player's figure on screen: 0.6 tiles wide and 1.6 tall, standing on the projected feet. */
export function figureBox(geometry, gx, gy, gz) {
  const { tile, project } = geometry, [sx, sy] = project(gx, gy, gz);
  return [sx - tile * .3, sy - tile * 1.6, sx + tile * .3, sy];
}

/**
 * How much of a player's figure the drawn blocks cover, 0..1: the share of points on it where a
 * solid or liquid face painted after the figure (x + y + z above the feet cell's) lies on the line
 * of sight. A figure point (a, b) in tiles maps to the grid point (gx + a, gy + 2b, gz − a).
 */
export function covered(grid, win, player, columns = 5, rows = 8) {
  const w = clampWindow(grid, win), gx = player.x - grid.minX, gy = player.y - grid.minY, gz = player.z - grid.minZ;
  const sum = Math.floor(gx) + Math.floor(gy) + Math.floor(gz), { kinds } = grid;
  let hidden = 0;
  for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) {
    const a = -.3 + .6 * (i + .5) / columns, b = 1.6 * (j + .5) / rows;
    const hit = march(grid, w, [gx + a, gy + 2 * b, gz - a], (x, y, z, k) => x + y + z <= sum || kinds[k].kind === "solid" || kinds[k].kind === "liquid");
    if (hit && hit.x + hit.y + hit.z > sum) hidden++;
  }
  return hidden / (columns * rows);
}

/**
 * The window to draw: levels around the feet, the cut (world y, null for none) and the cutaway
 * mode ("auto" opens when the resident would be hidden, see HIDDEN_SHARE; "on"; "off").
 * Returns { top, bottom, open, hidden } in grid coordinates; `hidden` is the share of the
 * resident's figure the blocks would cover without an opening (null when it is not drawn).
 */
export function sliceWindow(grid, view, { levels = DEFAULT_LEVELS, cut = null, cutaway = "auto" } = {}) {
  const [low, high] = levelRange(view, levels), top = (cut === null ? high : Math.max(low, Math.min(high, cut))) - grid.minY;
  const win = { top, bottom: low - grid.minY, open: null, hidden: null };
  const self = view.players.find(p => p.self);
  const gy = self ? self.y - grid.minY : NaN;
  if (!self || !(gy >= win.bottom && gy <= top + 1)) return win;
  win.hidden = covered(grid, win, self);
  const enough = top - Math.floor(gy) <= 2 ? STEP_SHARE : HIDDEN_SHARE;
  if (cutaway === "on" || (cutaway === "auto" && win.hidden >= enough)) win.open = opening(grid, self);
  return win;
}

/**
 * What is drawn under a screen point: a player's figure ({ player }) or the nearest drawn block
 * ({ x, y, z, id } in grid coordinates), or null. `geometry` is what `paint` returned.
 */
export function pick(grid, win, geometry, sx, sy) {
  const { tile, project } = geometry, [ox, oy] = project(0, 0, 0), w = clampWindow(grid, win);
  // The screen point is the line x − z = u, x + z − 2y = v.
  const u = (sx - ox) / (tile / 2), v = (sy - oy) / (tile / 4);
  const hit = march(grid, w, [(u + v) / 2, 0, (v - u) / 2], (x, y, z, k, line) => grid.kinds[k].kind !== "thin" || onMarker(x, y, z, line));
  // A figure is painted over faces up to its own x + y + z and under the rest.
  const figure = (geometry.figures ?? []).filter(f => sx >= f.box[0] && sx <= f.box[2] && sy >= f.box[1] && sy <= f.box[3]
    && (!hit || hit.x + hit.y + hit.z <= f.sum)).sort((a, b) => b.sum - a.sum)[0];
  if (figure) return { player: figure.player };
  return hit && { x: hit.x, y: hit.y, z: hit.z, id: grid.kinds[hit.k].id };
}

/**
 * Paints the slab through a window. `players` are { name, x, y, z, self } in world coordinates;
 * `colour` is the resident's CSS colour. Returns the geometry (for `pick`), with the figures drawn.
 */
export function paint(ctx, grid, list, { width, height, win = {}, players = [], colour = "#58c2b4", ink = "#ece4d2" }) {
  ctx.fillStyle = "#14171b"; ctx.fillRect(0, 0, width, height);
  const { top, bottom } = clampWindow(grid, win), geometry = layout(grid, width, height, { top, bottom }), { tile, project } = geometry;
  const quad = (points, fill, seal) => {
    ctx.beginPath(); ctx.moveTo(...project(...points[0]));
    for (let i = 1; i < points.length; i++) ctx.lineTo(...project(...points[i]));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    // Anti-aliased edges would leave hairline seams that show the faces painted behind.
    if (seal) { ctx.strokeStyle = fill; ctx.lineWidth = .8; ctx.stroke(); }
  };
  // Columns the client did not hold: a hatched floor, nothing invented.
  for (const [x, z] of grid.missing) {
    const y = bottom;
    quad([[x, y, z], [x + 16, y, z], [x + 16, y, z + 16], [x, y, z + 16]], "rgba(229,100,90,.10)", false);
    ctx.strokeStyle = "rgba(229,100,90,.45)"; ctx.lineWidth = 1;
    for (let d = 2; d < 32; d += 4) {
      ctx.beginPath(); ctx.moveTo(...project(x + Math.max(0, d - 16), y, z + Math.min(16, d))); ctx.lineTo(...project(x + Math.min(16, d), y, z + Math.max(0, d - 16))); ctx.stroke();
    }
  }
  // Players below the levels shown are left out; above the cut only their outline is drawn.
  const marks = players.map(p => ({ ...p, gx: p.x - grid.minX, gy: p.y - grid.minY, gz: p.z - grid.minZ }))
    .filter(p => p.gx >= 0 && p.gz >= 0 && p.gx < grid.side && p.gz < grid.side && p.gy >= bottom)
    .map(p => ({ ...p, sum: Math.floor(p.gx) + Math.floor(p.gy) + Math.floor(p.gz), drawn: false }));
  geometry.figures = [];
  const figure = p => {
    const box = figureBox(geometry, p.gx, p.gy, p.gz);
    ctx.fillStyle = p.self ? colour : ink; ctx.strokeStyle = "#14171b"; ctx.lineWidth = 1.5;
    ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]); ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    p.drawn = true;
    geometry.figures.push({ box, sum: p.sum, player: { name: p.name, x: p.x, y: p.y, z: p.z, ...(p.self ? { self: true } : {}) } });
  };
  for (const [x, y, z, face, k, cutFace] of list) {
    for (const p of marks) if (!p.drawn && p.gy <= top + 1 && x + y + z > p.sum) figure(p);
    const { kind, rgb: [r, g, b] } = grid.kinds[k];
    const shade = (face === 0 || face === 3 ? 1 : face === 1 ? .78 : .62) * (cutFace ? (face === 0 ? .55 : .7) : 1);
    const alpha = kind === "liquid" ? .72 : kind === "glass" ? .4 : 1;
    const fill = `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},${alpha})`, seal = alpha === 1;
    if (face === 0) quad([[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
    else if (face === 1) quad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], fill, seal);
    else if (face === 2) quad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
    else quad([[x + .25, y + .12, z + .25], [x + .75, y + .12, z + .25], [x + .75, y + .12, z + .75], [x + .25, y + .12, z + .75]], fill, false);
  }
  for (const p of marks) if (!p.drawn && p.gy <= top + 1) figure(p);
  // Everyone in the slab is outlined on top, so rock never hides where they are.
  ctx.font = "bold 12px system-ui, sans-serif"; ctx.textBaseline = "alphabetic";
  for (const p of marks) {
    const [sx, sy] = project(p.gx, p.gy, p.gz);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = p.self ? colour : ink; ctx.lineWidth = 1.5;
    ctx.strokeRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6); ctx.setLineDash([]);
    ctx.fillStyle = p.self ? colour : ink;
    ctx.fillText(`${p.name}, y ${Math.floor(p.y)}`, sx + Math.max(8, tile), sy - Math.max(8, tile));
  }
  // Compass: north is −z (up and right here), east +x (down and right).
  const cx = width - 46, cy = 40, [nx, ny] = [.894, -.447];
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - nx * 18, cy - ny * 18); ctx.lineTo(cx + nx * 18, cy + ny * 18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + nx * 24, cy + ny * 24); ctx.lineTo(cx + nx * 14 - ny * 5, cy + ny * 14 + nx * 5); ctx.lineTo(cx + nx * 14 + ny * 5, cy + ny * 14 - nx * 5); ctx.closePath(); ctx.fill();
  ctx.font = "bold 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", cx + nx * 34, cy + ny * 34);
  ctx.font = "11px system-ui, sans-serif"; ctx.fillText("E", cx + 30, cy + 18); ctx.textAlign = "start";
  return geometry;
}
