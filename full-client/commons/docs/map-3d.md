# A 3D chunk diorama for the Map: how realistic?

Decision document, 2026-11-23. Question from the owner: could the map be an isometric
"diorama" where a cube is one chunk, to show depth and Nether travel? Short answer: **yes for a
few chunks around one resident; no for the whole explored world.** The 2D map now carries
dimension and height (see the README's Map section), so a diorama is a close-up, not a
replacement. A working canvas prototype is at `<dashboard>/iso-chunk.html` (unlinked,
synthetic terrain only; its screenshots went with the 2026-11-23 report).

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

**Canvas isometric painter** (the prototype, `public/iso-chunk.js`, ~180 lines): extract the
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
