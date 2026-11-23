// The Diorama panel's data and painter (docs/map-3d.md): the blocks around one resident as an
// isometric slab, read from its own client (Synapse GET /chunks through api/diorama). Pure
// helpers are exported for the tests; `paint` draws on a 2D canvas, viewed from the south-east
// and above, faces sorted back to front. No world data is invented: columns the client did
// not hold are drawn as hatched gaps.

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
 * the feet; underground (no sky light at the feet in a dimension that has sky) two over; else none.
 */
export function defaultCut(view) {
  if (view.hasCeiling) return view.origin[1] + 3;
  if (view.hasSkyLight && view.skyLight === 0) return view.origin[1] + 2;
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
    const map = entry.palette.map(id => {
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

/**
 * The visible faces from the south-east above, back to front: [x, y, z, face, kind, cut] in grid
 * coordinates; face 0 top, 1 east (+x), 2 south (+z), 3 a thin block's floor marker. `cut` is the
 * highest grid y shown. A top face there is a cut surface (painted darker) when something above
 * it was removed by the cut, or always at the top of the window, where the data ends.
 */
export function faces(grid, cut = grid.height - 1) {
  const { side, height, kinds, cells } = grid, list = [], top = Math.min(cut, height - 1);
  const kindAt = (x, y, z) => x < 0 || z < 0 || x >= side || z >= side || y < 0 || y > top ? "air" : kinds[cells[(y * side + z) * side + x]].kind;
  for (let y = 0; y <= top; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const k = cells[(y * side + z) * side + x], kind = kinds[k].kind;
    if (kind === "air") continue;
    if (kind === "thin") { list.push([x, y, z, 3, k, false]); continue; }
    const above = kindAt(x, y + 1, z), east = kindAt(x + 1, y, z), south = kindAt(x, y, z + 1);
    if (kind === "liquid" || kind === "glass") {
      if (above !== kind && above !== "solid") list.push([x, y, z, 0, k, false]);
      if (east !== kind && east !== "solid") list.push([x, y, z, 1, k, false]);
      if (south !== kind && south !== "solid") list.push([x, y, z, 2, k, false]);
      continue;
    }
    if (above !== "solid") list.push([x, y, z, 0, k, y === top && (top === height - 1 || cells[((y + 1) * side + z) * side + x] !== 0)]);
    if (east !== "solid") list.push([x, y, z, 1, k, false]);
    if (south !== "solid") list.push([x, y, z, 2, k, false]);
  }
  // A unit cube can only hide cubes with a smaller x + y + z.
  list.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  return list;
}

/** Screen geometry for a grid in a box: tile size and the projection. */
export function layout(grid, width, height, cut) {
  const span = Math.min(cut, grid.height - 1) + 2;
  const tile = Math.max(2, Math.min(28, (width - 24) / grid.side, (height - 28) / (grid.side / 2 + span / 2)));
  const ox = width / 2, oy = 14 + span * tile / 2;
  return { tile, project: (x, y, z) => [ox + (x - z) * tile / 2, oy + (x + z) * tile / 4 - y * tile / 2] };
}

/** The highest block under a screen point whose top face is visible there, in grid coordinates, or null. */
export function pick(grid, geometry, cut, sx, sy) {
  const { tile, project } = geometry, [ox, oy] = project(0, 0, 0);
  for (let y = Math.min(cut, grid.height - 1); y >= 0; y--) {
    // Invert the projection on the plane of this block's top face (y + 1).
    const u = (sx - ox) / (tile / 2), v = (sy - oy + (y + 1) * tile / 2) / (tile / 4);
    const x = Math.floor((u + v) / 2), z = Math.floor((v - u) / 2);
    if (x < 0 || z < 0 || x >= grid.side || z >= grid.side) continue;
    const k = grid.cells[(y * grid.side + z) * grid.side + x];
    if (k && grid.kinds[k].kind !== "air") return { x, y, z, id: grid.kinds[k].id };
  }
  return null;
}

/**
 * Paints the slab. `players` are { name, x, y, z, self } in world coordinates; `colour` is the
 * resident's CSS colour. Returns the geometry (for `pick`).
 */
export function paint(ctx, grid, list, { width, height, cut, players = [], colour = "#58c2b4", ink = "#ece4d2" }) {
  ctx.fillStyle = "#14171b"; ctx.fillRect(0, 0, width, height);
  const geometry = layout(grid, width, height, cut), { tile, project } = geometry;
  const quad = (points, fill, seal) => {
    ctx.beginPath(); ctx.moveTo(...project(...points[0]));
    for (let i = 1; i < points.length; i++) ctx.lineTo(...project(...points[i]));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    // Anti-aliased edges would leave hairline seams that show the faces painted behind.
    if (seal) { ctx.strokeStyle = fill; ctx.lineWidth = .8; ctx.stroke(); }
  };
  // Columns the client did not hold: a hatched floor, nothing invented.
  for (const [x, z] of grid.missing) {
    quad([[x, 0, z], [x + 16, 0, z], [x + 16, 0, z + 16], [x, 0, z + 16]], "rgba(229,100,90,.10)", false);
    ctx.strokeStyle = "rgba(229,100,90,.45)"; ctx.lineWidth = 1;
    for (let d = 2; d < 32; d += 4) {
      ctx.beginPath(); ctx.moveTo(...project(x + Math.max(0, d - 16), 0, z + Math.min(16, d))); ctx.lineTo(...project(x + Math.min(16, d), 0, z + Math.max(0, d - 16))); ctx.stroke();
    }
  }
  const marks = players.map(p => ({ ...p, gx: p.x - grid.minX, gy: p.y - grid.minY, gz: p.z - grid.minZ }))
    .filter(p => p.gx >= 0 && p.gz >= 0 && p.gx < grid.side && p.gz < grid.side)
    .map(p => ({ ...p, sum: Math.floor(p.gx) + Math.floor(p.gy) + Math.floor(p.gz), drawn: false }));
  const figure = (p, alpha) => {
    const [sx, sy] = project(p.gx, p.gy, p.gz);
    ctx.globalAlpha = alpha; ctx.fillStyle = p.self ? colour : ink; ctx.strokeStyle = "#14171b"; ctx.lineWidth = 1.5;
    ctx.fillRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6); ctx.strokeRect(sx - tile * .3, sy - tile * 1.6, tile * .6, tile * 1.6);
    ctx.globalAlpha = 1;
  };
  const cutTop = Math.min(cut, grid.height - 1);
  for (const [x, y, z, face, k, cutFace] of list) {
    for (const p of marks) if (!p.drawn && p.gy <= cutTop + 1 && x + y + z > p.sum) { figure(p, 1); p.drawn = true; }
    const { kind, rgb: [r, g, b] } = grid.kinds[k];
    const shade = face === 0 || face === 3 ? (cutFace ? .55 : 1) : face === 1 ? .78 : .62;
    const alpha = kind === "liquid" ? .72 : kind === "glass" ? .4 : 1;
    const fill = `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},${alpha})`, seal = alpha === 1;
    if (face === 0) quad([[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
    else if (face === 1) quad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], fill, seal);
    else if (face === 2) quad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill, seal);
    else quad([[x + .25, y + .12, z + .25], [x + .75, y + .12, z + .25], [x + .75, y + .12, z + .75], [x + .25, y + .12, z + .75]], fill, false);
  }
  for (const p of marks) if (!p.drawn && p.gy <= cutTop + 1) figure(p, 1);
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
