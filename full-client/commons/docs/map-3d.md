# A 3D chunk diorama for the Map: how realistic?

Decision document, 2026-11-23. Question from the owner: could the map be an isometric
"diorama" where a cube is one chunk, to show depth and Nether travel? Short answer: **yes for a
few chunks around one resident; no for the whole explored world.** The 2D map now carries
dimension and height (see the README's Map section), so a diorama is a close-up, not a
replacement. The owner chose the §5 first version with block data from the residents' own
clients and ores shown as they are; what was built is in §6. (The synthetic-terrain prototype
page this document first measured, `iso-chunk.html`, was replaced by the real panel.)

## 1. What block data it needs, and where it could come from

A chunk is 16 × 16 columns × 384 blocks (y −64..319) in the Overworld, 256 tall in the Nether
and End: 98 304 block cells, stored by the game as 24 sections of 16³ with a per-section
palette. Two useful levels of detail:

- **Surface only:** per column the height and the top block (a heightmap). Shows hills, water,
  buildings' roofs. Cannot show a mine, a cave or anything under the Nether's bedrock roof,
  which is exactly what the owner asked about (prototype: tick "Heightmap only").
- **Sections:** the real blocks, but only a vertical window around the resident (e.g. y ± 16,
  two or three sections). This is what a cut-away needs.

| Source | How | Freshness | Fidelity | Cost / risk |
|---|---|---|---|---|
| (1) Server bridge (`server-observer/`) | New bounded, declarative read: "sections around configured resident R, Y window W", copied from already-loaded chunks (`getChunkNow`) in the tick budget | Live | Authoritative, every block | Needs the planned query interface plus **one server restart**; its README promises it "never scans the world, never searches for ores"; a section dump around a resident is a deliberate exception to argue for. Not added here. |
| (2a) Residents' clients: Synapse | New read-only Synapse `GET` like `/blocks` (which `find_block` already uses: client-loaded chunks only, loads nothing, radius ≤ 96) returning section palettes for chunks around the body | Live, as the client sees it | Every block the client holds (it receives buried ores too: `find_block` already finds them) | Synapse build and a restart of each resident client; zero server load; each Commons host already reads its own residents' Synapse on loopback, so hub/station federation carries it unchanged |
| (2b) Residents' clients: Xaero's World Map cache | Parse `XaeroWorldMap/…/<dimension>/…/*.zip` region caches in each game dir | As last rendered by Xaero | Surface pixels (top block, height, biome, light); its cave layers, where present, are a different view | Undocumented, versioned binary format [not inspected for this document]; stale; good only for a wide **surface** overview |
| (3) World region files on the server host | Read `world/region/r.X.Z.mca` (Nether `DIM-1/`, End `DIM1/`) read-only: 8 KiB header, zlib NBT per chunk, `sections[].block_states{palette,data}` and `Heightmaps` (37 packed longs each) | As of the last save (autosave about every 5 min; unloaded chunks keep their last save) | Complete, including places nobody has seen | A new process on pop-os (busy, lease-gated host) or copying files off it; torn reads during saves (verify, retry next pass); an NBT reader (~200 lines); the whole world becomes browsable, see §4 |

Modded blocks (Mekanism, Immersive Engineering, Terralith biomes…) need colours: the usual
mapper approach is a one-off table of average texture colours extracted from the modpack's
jars, with a namespace-hash fallback. Same table for every source.

## 2. Data volume and update strategy

- Raw cells: 98 304 per Overworld chunk; at a palette index of 4–8 bits that is 48–96 KiB raw.
  Terrain is mostly stone/deepslate/air, so gzip typically shrinks it 5–10× [estimate, not
  measured on this world]: roughly 10–20 KiB per full chunk, far less for a Y window.
- Surface only: 256 heights (2 B) + 256 top-block indices (1 B) + a palette of ~10–30 ids:
  about 1–1.5 KiB raw, under 1 KiB gzipped.
- Y window of 32 blocks (2–3 sections): about 8–12 KiB raw, 2–4 KiB gzipped per chunk.

| Chunks around a resident | Area | Surface payload | Y-window payload | Full chunks |
|---:|---|---:|---:|---:|
| 1 | 16 × 16 | ~1 KiB | ~3 KiB | ~15 KiB |
| 9 (3 × 3) | 48 × 48 | ~9 KiB | ~30 KiB | ~135 KiB |
| 25 (5 × 5) | 80 × 80 | ~25 KiB | ~75 KiB | ~375 KiB |
| 81 (9 × 9) | 144 × 144 | ~80 KiB | ~250 KiB | ~1.2 MiB |

Caching: key every chunk by (dimension, chunk x, z, section range) with a revision: Synapse can
hash the section palettes and data it sends; region files carry a per-chunk save timestamp in
the header. The browser asks "what changed since revision r" and keeps chunks in memory; a
resident walking adds one row of 3 (or 5) chunks per chunk crossed. Re-query the resident's
own chunk every 10–30 s (they dig), the ring around it only when it changes or on request.
**Reasonable size: 3 × 3 chunks**, 5 × 5 as an option; 9 × 9 is a surface overview job.

## 3. Rendering in the browser without a build step

**Canvas isometric painter** (the prototype, now `public/diorama.js`): extract the
visible faces (top, east, south) of every solid block, sort back to front by x + y + z, fill
parallelograms from a block-colour table, seal hairline seams. Measured in the headless
WebKit on the development machine (synthetic 128-tall terrain, a carved tunnel, 1240 × 1000):

| Chunks | Faces | Find faces | Paint |
|---:|---:|---:|---:|
| 1 | 2 473 | 3 ms | 10 ms |
| 9 | 8 579 | 10 ms | 28 ms |
| 25 | 17 351 | 21 ms | 54 ms |
| 81 | 42 975 | 51 ms | 89 ms |

A real 384-tall chunk with caves has more exposed faces (estimate 2–4×), so 81 chunks lands
near 0.3–0.5 s: fine for a redraw per update, not for smooth spinning. Four fixed rotations
are cheap (re-sort); free orbiting is not.

**WebGL with three.js** vendored as one ES module file (`public/vendor/three.module.min.js`,
~0.7 MB, imported directly, no bundler): greedy meshing in a Web Worker merges coplanar faces
(typically 5–20× fewer quads), then one draw call per chunk. 81 chunks is comfortably 60 fps
on any GPU from the last decade, phones included; orbit, zoom and clipping planes are free.
Costs: a 0.7 MB dependency to vet and update, more code (~600–900 lines), and GL context loss
handling on phones.

**Seeing a resident underground:** (a) *slice at Y*: drop everything above the resident's feet
+ 2 and paint the cut surface darker (prototype: "Cut just above the resident"); default to it
when the sample's sky light is 0. (b) *cross-section*: a vertical clip plane through the
resident along x or z, showing the tunnel in profile, matching the Map's elevation profile.
(c) A ghost outline of the body drawn on top whatever hides it (prototype default).

**The Nether** fits as its own diorama: bedrock roof at y 127 means a slice is always on
(default resident y + 3); the lava sea at y 31 is a translucent plane; coordinates labelled with
their ×8 Overworld equivalents like the 2D map. The End needs no slice.

## 4. Privacy and the "read-only bridge" principles

- Every source above is read-only; none may load chunks, move anything or reach the residents.
- A diorama is **x-ray** for whoever sees it: ores, chests in walls, other players' bases.
  Region files expose the whole world, including places no resident has been; client data
  exposes only what a resident's client already holds near it (and residents can already
  `find_block` buried ores there), which keeps the view to the residents' own surroundings.
- Dashboard only: never send block data to the Resident API, the stream overlay or the Live
  status; no URLs or tokens in public JS (as for the rest of Commons).
- The server bridge's promise ("never scans the world, never searches for ores or structures,
  never reports other players") would have to be amended explicitly, with the owner's consent,
  before it serves sections; do not slip it in as a "small query".
- Consider drawing ores as plain stone and other players' builds outside residents' areas as
  surface only; the owner decides.

## 5. Recommendation

**First version (about 3–4 days, plus a client restart window):** a *Diorama* tab beside the
Map for the selected resident, 3 × 3 chunks, Y window ± 16 around them (slice on by default
underground and always in the Nether), canvas painter from the prototype, block colours from a
generated modpack table, 10–30 s refresh with per-chunk revisions. Data from a new read-only
Synapse endpoint (client-loaded chunks only), read by each host's own Commons over loopback and
federated like trails. Work: Synapse endpoint and tests 1 day; Commons route, cache, federation
and tests 1 day; renderer, colour table and UI 1–1.5 days; device verification 0.5 day.
It looks like the prototype's cut-away: a 48 × 48 block slab, the tunnel open, the resident
standing in it, ◆ portals and the Map's height colours as a side bar.

Later, only if wanted: WebGL (three.js) for orbiting and 9 × 9 overviews (3–5 days); a
surface-only world overview from region files or Xaero caches (2–3 days, needs a decision on
§4). Not recommended: a whole-world block diorama.

## 6. What was built (first version, 2026-11-23)

As recommended in §5, with these choices and differences:

- **Synapse `GET /chunks?radius=&below=&above=&have=`** (source (2a), Synapse README): radius
  0..2 chunks (default 1, 3 × 3; capped at 5 × 5 because this is a close-up and every read is
  x-ray of the resident's surroundings), `below`/`above` 0..32 blocks (default 16), always
  widened to **whole sections** (so ±16 returns three sections, 48 blocks; the cap gives five).
  Per section: palette of block ids (no block states), indices packed LSB-first at
  ceil(log2(palette)) bits, zlib, base64; a 64-bit FNV revision over position, palette and
  indices, per section rather than per chunk (a chunk's window is three to five sections, and a
  resident digging changes one). `have=` lists revisions the caller holds; those come back as
  `{y, rev, same: true}`. Missing columns are listed, never loaded. The client thread only copies
  each section's `PalettedContainer` (an array copy) and the player list, in slices of about
  1 ms (whole columns; at most one column over) with a client tick between slices; packing,
  compression and hashing run on the HTTP thread; one read at a time (`BUSY` 429 otherwise);
  `observe` token level. Reported per read: `timing.clientThreadMicros`,
  `clientThreadMaxSliceMicros`, `clientThreadSlices`, `encodeMicros`, `totalMicros`.
- **Commons** (`src/diorama.ts`, `GET diorama?resident=&have=`): no timer. A host asks a
  resident's client only when a dashboard asks, at most every 10 s per resident for all
  viewers, and sends `have` for what it already holds; the page asks every 15 s while the tab is
  open and visible, with its own `have`. The last view is kept per resident (only its current
  window) with the time it was read; an offline client keeps showing it, labelled. The hub
  forwards to the owning station and re-validates every section (ids, bits versus palette, zlib
  length, counts); an older or unreachable station, or another shape, is `unavailable`.
- **Page:** a *Diorama* tab beside Map rather than a panel inside it (the slab needs the
  height, and the Map's controls already fill a phone screen). The §3 painter, plus: thin
  decorations (grass, torches, rails…) as floor markers, water and glass translucent, hatched
  missing columns, dashed outlines and names for every player in the slab, a compass, tap/hover
  for a block's coordinates and id, the dimension and Nether ↔ Overworld equivalent in the status
  line. Cut by default two blocks over the feet underground (sky light 0) and three in the
  Nether; not on the surface or in the End. Not built: the cross-section clip, the Map's height
  ramp as a side bar, zoom, rotation, the lava sea as a plane.
- **Colours:** `scripts/build-block-colours.ts` reads the client jar and the mods directory
  (including `META-INF/jarjar` jars) at deploy: blockstate → first model → parent chain → the
  top/end/all texture → average of visible pixels; biome-tinted faces get plains colours; for
  `*_ore` blocks the average of the fifth of pixels farthest from the mean (the specks), so ores
  are visible. On the residents' 125-mod pack: 6 659 blocks in 1.6 s, 283 without a readable
  texture (dynamic models), which get a hashed colour; the table is ~280 KB and never committed.
- **Measured:** the Synapse unit tests, the Commons/page tests and a synthetic demo
  (`DEMO_DIORAMA=underground bun scripts/demo.ts`; screenshots labelled synthetic). The real
  payload sizes and client-thread times for 3 × 3 chunks on a live client are **not measured
  yet**: the live check waits for an approved disposable client. The synthetic demo's
  surface reply is 13.5 KB of JSON for 27 sections.
