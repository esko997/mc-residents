# Resident Observer server bridge (server-side)

A small Forge 1.20.1 mod (`resident_observer`) for the **dedicated server**. It reports what the
server itself sees of the **residents and facilities Commons asks it to watch**, of **any block
position**, and of **every chiseled bookshelf and book-holding lectern in loaded chunks**, so Commons
and the caretaker have one authoritative source that does not depend on where the resident clients
run. The snapshot prototype was smoke-tested on isolated Forge 47.4.10 on 2026-11-22; 0.1.0 runs on
pop-os; 0.2.0 added declarative queries and recorders. **0.3.0** (2026-11-23) takes its subjects from
Commons instead of its config, reads any position, and finds every shelf by itself.

It is an adjunct to each resident client's Synapse. It does not replace them: the server cannot
see a client's screen, picture, open GUI or the health of its process.

## 0.3.0 in one paragraph

The bridge keeps no list of its own. Commons pushes the residents and facilities to watch with
`PUT /v1/watch` (scope `watch`); the list lives in memory, is swapped in whole at the next server
tick, and is empty after every server start until Commons pushes again (Commons notices through the
`bootId`). The config file no longer lists `residents` or `facilities`; an old config that still does
starts normally and logs once that those keys are ignored. `GET /v1/block` reads whatever stands at a
position. The library needs no registration: `GET /v1/library/shelves` lists every chiseled bookshelf
and every lectern holding a book in loaded chunks, and shelves and books are read by `dimension` + `pos`.
There is no privacy design (the server is private); every rule that protects the server's tick stays.

## What it does and does not do

- **Never changes the world.** No commands, RCON, chat, inventory or block changes, and no "run
  arbitrary" endpoint. Every endpoint is `GET` except `PUT /v1/watch`, which replaces the bridge's own
  in-memory watch list and nothing else.
- **Reads anything that is loaded.** Watched residents by UUID, watched facilities and any requested
  position by block position, shelves and lecterns wherever they are. It never searches blocks for
  ores or structures, and does not report players who are not on the watch list.
- **Never loads chunks.** Chunk access goes only through `ServerChunkCache#getChunkNow`, which
  returns null for anything not already fully loaded, and (for the shelf scan) through the chunk
  holders' already-complete futures. It deliberately avoids `Level#getBlockEntity`/`getBlockState`,
  because both load chunks on the server thread. A facility or `/v1/block` position is read only when
  its whole 3×3 chunk neighbourhood is loaded, because some capabilities (a vanilla double chest, for
  example) look at neighbouring blocks through the level. If any of those chunks is unloaded, it is
  reported as `unloaded`, with a facility's last observation kept as history (`lastKnown`,
  `lastObservedAtMs`). Shelf and lectern reads use their own chunk only (their getters never look at
  neighbours). Sight uses a non-loading block view; an unloaded chunk anywhere along the ray (even
  beyond a blocker) means unknown.
- **Tick-thread budget.** All world reads happen in the server tick (END phase). A pushed watch list
  is swapped in first (memory only). Every `intervalTicks`, each watched resident is read with one UUID
  map lookup. At most one queued bridge request present at tick entry runs next, if the budget
  permits. Then the shelf scan, when one is wanted, gets the first quarter of `tickBudgetMicros`;
  watched facilities are read round-robin while under the budget; the scan gets whatever is left.
  Requests arriving during the tick wait for the next tick. The budget decides whether to *start*
  another read; a single overrun is counted (`overBudgetTicks`, `maxTickMicros`), not hidden.
  Slot/item counts, book and ray sizes and every list are capped and say when they were cut. Queue
  capacity defaults to 16 and timeout to 2000 ms; expired/cancelled queued reads are discarded.
- **Request threads never touch the game.** They serialize immutable snapshots/results and
  the bounded event ring, or enqueue typed reads with immutable arguments. Normal HTTP handling
  uses 2 threads and a 16-entry queue with dispatcher backpressure. Separate pools admit at most 4
  simultaneous tick waits and 4 event long-polls, with no waiting queue; excess waits get HTTP 503.
  Long-polls inspect the published ring at most every 100 ms and never acquire a tick-thread
  monitor. Sequence numbers remain monotonic for the server run.
- **Failure isolation.** A facility read, a `/v1/block` read, a shelf slot or a scanned chunk that
  throws becomes that read's `error` (or is skipped and counted). A whole tick or queued bridge read
  that throws counts as a failure, and `failureTripCount` consecutive failures trip the observer off
  until the server restarts (state `tripped`). `config/resident_observer.paused` pauses it without a
  restart: create the file to pause, delete it to resume. A daemon thread checks for the file every
  5 s, never the server thread. A missing, disabled or invalid config means no socket and no tick work.
- **Client-optional.** It registers no blocks, items, entities or network channels, and its
  `displayTest` is `IGNORE_SERVER_VERSION`. Its one access transformer makes `ChunkMap#getChunks`
  public (the shelf scan lists loaded chunks with it); it changes no behaviour.
- **No arbitrary NBT leaves the server.** Stock reads only count item ids and `nbtStacks`. Books on
  shelves and lecterns (scope `library`) give selected metadata, content hashes and bounded
  written/writable page text; any other item there gives only its id. No nested inventories,
  enchantment data, arbitrary tags or component actions are sent.

## Access

- Defaults to `127.0.0.1` (or explicitly `::1`), unchanged. A non-loopback literal address
  requires **`allowNonLoopback: true`**. An SSH forward remains the safest default:

  ```sh
  ssh -N -L 127.0.0.1:25640:127.0.0.1:25640 <server-user>@<server-host>
  ```

  Explicit LAN example (also requires container port publishing/firewall rules):

  ```json
  {
    "bind": "0.0.0.0",
    "allowNonLoopback": true,
    "allowedHosts": ["192.168.1.233", "pop-os", "pop-os.local"]
  }
  ```

  `bind` must be an IP literal; it never resolves DNS. `allowedHosts` contains exact names
  or IP literals, without ports (IPv6 in brackets). No wildcards, suffix matching or DNS lookup.
  Loopback names remain allowed. A wildcard bind does **not** allow arbitrary Host headers.
  Plain HTTP exposes bearer tokens to anyone who can observe traffic: restrict the port to
  hub `192.168.1.69` on a trusted LAN, or use a tunnel/VPN/TLS proxy. Never publish it to WAN.

- `Authorization: Bearer <token>`. The server config stores only `tokenSha256` (lowercase hex
  SHA-256 of the exact token string), so the config never holds a usable credential. Tokens
  and hashes are never logged or returned.
- `Host` must be a loopback name or an explicitly configured `allowedHosts` entry. Ports are
  not checked, so tunnels can change local ports. `Origin` or any `Sec-Fetch-Site` is refused.
  These checks come before everything else, the `PUT` included.
- Scopes, one credential per consumer:

  | scope        | grants |
  |--------------|--------|
  | `residents`  | every watched resident's body, events and pairwise sight |
  | `facilities` | watched facility stock, facility events and `GET /v1/block` at any position (no book text) |
  | `library`    | every shelf and lectern: discovery, shelf and book reads; health events only without other scopes |
  | `status`     | `/v1/status` diagnostics and `GET /v1/watch` |
  | `watch`      | `PUT /v1/watch` (and `GET /v1/watch`); Commons only |
  | `self`       | only the bound resident's own body and events while it is watched; cannot combine with `residents`/`facilities`/`library`/`watch` |

  Create a credential on the machine that will use it. The token goes to the file and the JSON
  line goes into the server config:

  ```sh
  server-observer/tools/new-consumer-token.sh ~/gary-client/commons-data/observer.token commons residents,facilities,library,status,watch
  ```

  The script refuses to overwrite an existing token file and prints only the hash entry. To give an
  existing credential another scope, add the scope to its entry's `scopes` in the server config; the
  token and its hash do not change.

## Endpoints (schema 1)

Every reply has `schema`, `source: "server-observer"`, `consumer`, `scopes`, `state`
(`starting|ok|degraded|paused|stalled|tripped`), `stateDetail`, `servedAtMs` and `heartbeatAtMs`.
All times are milliseconds on the server's clock. `servedAtMs - builtAtMs` gives a skew-free age.
Positions are `[x, y, z]` arrays in replies and `pos=x,y,z` in queries (|x|,|z| ≤ 30,000,000,
|y| ≤ 2048); dimensions are ids like `minecraft:overworld`. The watch, block and library endpoints
refuse unknown query parameters (400), so a removed form such as `facility=` fails loudly.

### The watch list

- `PUT /v1/watch` (scope `watch`), `Content-Type: application/json` (charset UTF-8 or none), body at
  most 256 KiB:

  ```json
  { "revision": "<opaque, 1-128 printable ASCII, no spaces>",
    "residents":  [{ "name": "Gary", "uuid": "11111111-1111-1111-1111-111111111111" }],
    "facilities": [{ "id": "facility-12", "label": "Bread chest", "dimension": "minecraft:overworld", "pos": [226, 5, -67], "side": null }] }
  ```

  At most 64 residents and 1024 facilities. Strict JSON (no comments, trailing commas or trailing
  data; nesting at most 8 deep) and strict UTF-8. Every entry is checked as the 0.2 config checked it:
  resident names `[A-Za-z0-9_]{1,16}`, UUIDs, unique names (case-insensitive) and UUIDs; facility ids
  `^[a-z0-9][a-z0-9_-]{0,47}$`, labels at most 80 characters (default: the id), dimension default
  overworld, `side` null or `down|up|north|south|west|east`, unique ids, unique (dimension, pos, side);
  unknown keys are refused. Anything wrong is 400 and **nothing changes**. A valid list is swapped in
  whole at the next tick (also while paused: it touches no world). The reply waits for that (bounded
  by `requestTimeoutMs`) and is `watch:{revision, residents, facilities, appliedAtMs, bootId}`.
  Other answers: 401; 403 (scope, Host, browser); 405 for other methods (`Allow: GET, PUT`); 409
  `superseded` (a newer push arrived first; the newer one wins); 413 (over 256 KiB, by
  `Content-Length` or while reading); 415 (content type); 429 `rate_limited` with `Retry-After` (per
  consumer, burst 10, 30 per minute); 503 `tripped`/`stopped`; 504 `timeout` (taken, no tick yet: it
  is applied at the next tick unless replaced); 202 with the current list if the wait pool is full
  (taken, applied at the next tick).
- `GET /v1/watch` (scope `status` or `watch`): the same `watch` view. Before Commons pushes,
  `revision` and `appliedAtMs` are null and both lists empty. `bootId` is random per server start and
  also in `/v1/status`; Commons re-pushes when `bootId` or `revision` differs from what it sent.
- What a replacement keeps: a resident with the same name and UUID keeps its last observation
  (`lastSeen`); a facility with the same id, dimension, position and side keeps its observation,
  history and flow baseline (a new label is taken over). A facility that moved starts again as
  `pending` (no flow is ever computed across two containers). A removed facility's observation is
  dropped; a removed resident's observation and block hour cells are dropped (the block detail ring
  is a log and keeps its entries until they are overwritten). Block listeners, flow evidence, sight
  and queries use the list in use: they run on the server thread, where the swap happens, or resolve
  names from the published list. After a swap a new resident cycle starts at once, so a snapshot never
  shows a watched resident that has not been read.

### Residents, facilities, events, status

- `GET /v1/snapshot`: `snapshot` is null until the first tick. Otherwise it contains `seq`,
  `builtAtMs`, `gameTime`, `residents[]` and `facilities[]` of the watch list (both empty before
  Commons pushes; a `self` token sees its resident only while it is watched).
  - A resident has `name`, `uuid`, `online`, `checkedAtMs`, plus `body` when online and
    `lastSeen` (the last online body this server run) when offline. A body has `atMs`,
    `gameTime`, `dimension`, `pos{x,y,z}`, `health`, `maxHealth`, `food`, `air`, `maxAir`,
    `gameMode`, `dead`, `sleeping`, `vehicle` and `xpLevel`.
  - A facility has `id`, `label`, `dimension`, `pos[3]`, `side`, `status`
    (`pending|observed|unloaded|no_level|no_block_entity|unsupported|error`), `detail`,
    `checkedAtMs` and `gameTime`. `contents` is present only when the status is `observed`.
    `lastKnown`/`lastObservedAtMs` are history. Contents have `block`, `slots`, `usedSlots`,
    `slotsTruncated`, `items[{item, count, nbtStacks}]`, `itemsTruncated`,
    `energy{stored, max}|null`, `fluids[{fluid, amount, capacity}]` and `readMicros`.
- `GET /v1/block?dimension=<id>&pos=x,y,z` (`facilities`): `block:{dimension,pos,status,reason,block,
  contents}`, read exactly as a facility is (the status vocabulary above without `pending`; `reason`
  is the facility's `detail`; `block` is the block id whenever the chunk was loaded). No
  registration; runs through the tick queue. A capability that throws is this read's `error`, not a
  tick failure.
- `GET /v1/events?after=<seq>&limit=<1..500>&wait=<0..25>` returns
  `events[{seq,type,atMs,gameTime,resident,facility,detail}]`, `oldestSeq`, `latestSeq`, `gap`.
  `wait` defaults to 0 seconds; an existing page/gap returns immediately. Otherwise wait up
  to the deadline for ring advancement, pause, or trip. An invisible event also ends the wait
  with an empty filtered page and advanced `latestSeq`, so clients can advance their cursor.
  A cursor ahead of the current ring (server restart) returns immediately. `gap` is true when
  events after `after` were dropped. Event types are `observer_started` (its detail names the boot
  id), `observer_tripped`, `resident_online`, `resident_offline`, `resident_dimension`,
  `resident_died`, `facility_status` and `recorder_stopped` (health: block recording stopped itself).
- `GET /v1/status` (scope `status`): `bootId`, budget, tick timing, lag, failure counters,
  `lastError`, `paused`, `tripped`, `watchRevision`, `watchAppliedAtMs`, `residentsWatched`,
  `facilitiesWatched`, `eventsDropped`, `library` (shelf scan cost and size, below) and `queries`
  (served/refused/rate-limited counts, player-file reads/cache hits/parse failures, block recorder
  and flow counters, advancement catalog size and build time).
- `GET /v1/sight?from=Gary&to=Margo` (`residents`, never `self`): adds
  `sight:{visible:true|false|null,distance:number|null,reason:string}`. Both names must be
  watched (case-sensitive; 400 otherwise, saying so when nothing was pushed yet); the tick resolves
  their online players and eye positions. Different dimensions, offline players, out-of-range or
  unloaded rays are unknown (`null`), not an obstruction. Distance is eye-to-eye blocks when
  meaningful; max defaults to 128.

### The library

A slot is `BookInfo{slot, kind, item, title, author, generation, pageCount, contentHash}`; `kind` is
`written|writable|enchanted|plain|other` and `item` the registry id. `other` is any item that is not
one of the four vanilla books (the knowledge book; in this pack also guide books and albums that mods
add to the shelf and lectern item tags): no metadata, no pages, a hash of kind and item id. A chiseled
bookshelf has slots 0..5, a lectern slot 0. Only occupied slots are listed; shelf replies carry no pages.

- `GET /v1/library/shelf?dimension=<id>&pos=x,y,z` (`library`): `shelf:{dimension,pos,block,status,
  reason,slots}`, from that position's own loaded chunk, never loading it. Commons learns that a book
  or a shelf is gone from this read, so its answers are exact:
  - a chiseled bookshelf: `observed`, its books (an empty shelf is `observed` with no slots);
  - a lectern: `observed`, slot 0 is its book, no slots when it holds none;
  - anything else there (air, another block, another block entity, a position outside the build
    height): `no_shelf`, with `block` naming it;
  - the chunk is not loaded: `unloaded` (unknown; `block` null; never `no_shelf`, never an empty
    shelf);
  - no such dimension: `no_level`.

  A shelf or lectern that is there but cannot be listed completely answers the first bad slot's
  status with no slots (`invalid`, `too_large`) or `error` (its block entity is missing, or the read
  threw). These mean unknown, never gone: no partial list can pass as complete. A shelf read needs no page
  text, so it reuses the scan's book memo: books already seen unchanged cost nothing, new ones (at most six)
  are decoded in that read's tick.
- `GET /v1/library/book?dimension=<id>&pos=x,y,z&slot=<0..5>` (`library`): `book:{dimension,pos,block,
  status,reason,book:BookInfo|null,pages:string[]}`. Written/writable books return plain-text pages;
  other kinds are `not_readable`. Besides the shelf statuses: `empty` (no book in that slot) and
  `invalid` (slot 1..5 of a lectern, or a malformed book). Invalid/oversized books fail closed rather
  than returning a hash of truncated text, and never stale pages.
- `GET /v1/library/shelves?after=<cursor>&limit=<1..200>` (`library`, default limit 100):
  `shelves:{items:[{dimension,pos,block,status,reason,slots,observedAtMs}], next, loadedOnly:true,
  scannedAtMs, completedAtMs, truncated, total}`. Every chiseled bookshelf (empty ones included) and
  every lectern holding a book in currently loaded chunks, all dimensions, sorted by dimension then
  x, y, z. `next` is an opaque cursor (null on the last page); paging is by key, so it continues
  cleanly across a rescan. A position missing from the list means nothing by itself (unloaded, or the
  list was cut): removal is learned only by the read by position. An item whose books cannot be listed
  carries that status (as above) and no slots. A scan reads holders one at a time over several ticks,
  so each item has its own `observedAtMs` (when its books were read); `scannedAtMs` is when the scan
  began and `completedAtMs` when it finished. A scan is served from memory for 30 s after it
  **finished**, however long it took (a slow pass is never thrown away, and its old observations keep
  their old times). Otherwise the request starts one and waits up to `requestTimeoutMs`, then answers
  503 `scanning` with `Retry-After: 2` if it is still running. While requests keep coming (any within
  5 minutes) a new scan starts 20 s after the previous one finished; with no requests it never scans.
  Paused or tripped, no scan runs: a scan finished within 30 s is served, otherwise 503
  `paused`/`tripped`.

**What one scan costs, and its bounds.** It never walks blocks, and it advances in units, each run only
while the tick's observer time is under budget (the scan has the first quarter of `tickBudgetMicros`
and whatever facilities leave), so a tick overruns its budget by at most one unit:

- *level*: copy the keys of the chunks the server holds for one level (one pass over its chunk map, at
  most 32,768 per level; more cuts the list);
- *slice*: examine at most 1,024 of one chunk's block entities and note the chiseled bookshelves and
  book-holding lecterns among them, reading no books. A chunk with more block entities takes further
  slices (each skips the ones already examined by stepping the map's iterator), so a dense chunk is
  finished over several units, never cut off;
- *holder*: read one noted shelf or lectern at its position, as `/v1/library/shelf` does, decoding at most
  **one** book the bridge has not already seen unchanged. It remembers each successfully selected book while
  its item stack and the tags it read are the same objects (a changed book gets new tag objects, so it is
  decoded again); checking that compares at most `maxBookPages` page tags, and plain, enchanted and `other`
  items keep no tag at all. Failed or oversized books are not remembered: they are tried again, within the
  book limits. A shelf of six new books takes six units and is published from the unit in which all its
  slots are known, so the listing is one consistent read; a shelf whose books keep changing gets its
  remaining books in its eighth unit, so it always ends. An unchanged library costs one cheap unit per holder
  per scan. One book is bounded by the book limits (by default 100 pages and 65,536 characters).

A chunk unloaded before its first slice, or a level that has gone, is simply not loaded (counted in
`lastChunksGone` for chunks); a chunk unloaded between two of its slices, or a unit that throws (counted in
`errors`), cuts the list (`truncated`). A holder that changed since it was noted is read as it is now (a
lectern that lost its book is left out). At most 4,096 items are kept. `/v1/status`
`library` reports per scan `lastWorkMicros` (all its tick time), `lastTicks`, `lastLevels`, `lastChunks`,
`lastSlices`, `lastBlockEntities`, `lastHolders`, `lastHolderUnits`, `lastItems`, `lastMaxUnitMicros` (its longest unit),
and over the run `maxUnitMicros` and `errors`.

Book limits count UTF-16 code units and cover both selected source and decoded text; aggregate
limits include title and author. Titles are capped at 128 characters, authors at 64, written-book
generation at 0..3. Written pages accept literal JSON text/arrays/`extra`; formatting/actions are
discarded. Dynamic `selector`, `score`, `nbt`, `translate` and `keybind` components fail closed;
they are never resolved.

`contentHash` is SHA-256 of the `resident-book-v1` projection, not the raw item/NBT: length-prefixed
UTF-8 kind/title/author/generation plus page count and plain-text pages. Slot, position, formatting,
click/hover actions, enchantments, filtered pages and other NBT are excluded. Exact framing is in
`BookText.java`. Plain/enchanted books hash only their kind and empty selected content; `other`
items hash their kind with the item id in the title's place.

Sight, block and library reads enter the bounded tick queue; they do not read cached players/blocks
on HTTP threads. Envelope times are sampled after completion. No automatic action retries. The
Commons client for all of this lives in `full-client/commons/src/observer.ts`.

Errors use `{"schema":1,"source":"server-observer","error":{"code","message"}}` with status 400
(query or body), 401 (token), 403 (scope, Host or browser), 404 (path, unknown query subject), 405
(method), 409 (superseded push), 413 (body or reply too large), 415 (content type), 429 (rate), 503
(bounded wait/queue full, scanning, paused, tripped, stopping), 504 (tick result timeout), or 500.

## Declarative queries

`GET /v1/query?kind=<kind>&<params>` runs one read from a **fixed vocabulary**; `GET /v1/queries`
lists the kinds, parameters, bounds, subjects and limits the calling token may use (an older
jar answers 404 there, which is how the hub feature-detects). The bridge interprets nothing
else: no expressions, no paths, no NBT selectors, no code. Every request is validated before any
work: an unknown kind (400 `unknown_kind`) or parameter (400 `unknown_param`), a malformed value,
a repeated parameter or more than 8 parameters is refused; numbers outside their range are
**clamped** and named in `query.clamped`; subjects must be a watched resident (case-sensitive)
or a watched facility, and anything else (a human such as spesk01, the spectator, a typo) gets the
same 404 `unknown_subject`. A `self` token whose resident is not watched gets 404 too, never
everyone's data. Paused or tripped: 503. Over the token's rate: 429 with `Retry-After`. A reply over
4 MiB: 413.

Replies carry the usual envelope plus `query: {kind, vocabularyVersion, runStartedAtMs,
params (effective), clamped, result}`. `runStartedAtMs` is the bridge's start: sequence numbers
and in-memory counts restart with it. Times are the server's clock (epoch ms).

| kind | scope | runs where | cost | params (default, bounds) | result |
|---|---|---|---:|---|---|
| `stats` | residents, or self (own only) | player file, request pool | 3 | `resident` (required); `types` (comma list of the 9 vanilla types; all); `limit` per type (1000, 1..2000) | `status`, `savedAtMs`, `dataVersion`, `types[{type,total,truncated,values{key:value}}]` largest first |
| `advancements` | residents, or self | player file, request pool | 3 | `resident` (required); `include` (`all`/`done`/`progress`); `recipes` (`no`/`yes`); `offset` (0, ..100000); `limit` (1000, 1..2000) | `status`, `savedAtMs`, `total`, `done`, `advancements[{id,done,criteriaDone,criteriaTotal,title,frame,criteria[{name,atMs}]}]` |
| `advancement_catalog` | residents, or self | immutable copy | 1 | `offset`, `limit` (1000, 1..2000) | every loaded advancement with a display: `id,title,frame,hidden,criteria,requirements,parent` |
| `blocks` | residents, or self (filtered to own) | published ring | 1 | `resident` (all); `after` cursor; `limit` (500, 1..1000) | `changes[{seq,resident,action,dimension,x,y,z,block,atMs,gameTime}]`, `oldestSeq`, `latestSeq`, `gap`, `nextAfter`, recorder counters |
| `block_hours` | residents, or self (filtered to own) | server tick, budgeted queue | 2 | `resident`; `sinceHour` epoch ms (0); `offset` (0, ..65536); `limit` (500, 1..1000) | `cells[{resident,dimension,chunkX,chunkZ,hourMs,placed,broken,kinds[{block,placed,broken}],otherPlaced,otherBroken}]`, `overflow[{resident,hourMs,placed,broken}]`, `more`, `retainedFromHourMs`, `evictedThroughHourMs` |
| `flows` | facilities | published ring | 1 | `facility` (all); `after`; `limit` (200, 1..500) | `flows[{seq,facility,atMs,sinceMs,continuous,deltas[{item,before,after,nbtBefore,nbtAfter}],uncertain[],attribution,resident,nearby[{resident,distance,when}]}]`, `gap`, `nextAfter`, `dropped` |

**Rate limit:** one token bucket per consumer, `queryBurst` tokens (30), refilled at
`queryRatePerMinute` (60/min); each request costs the kind's cost; refused requests cost 1. Watch
pushes have their own bucket (above); other endpoints are not rate-limited. **Pools:** ring/catalog
kinds answer on the normal handler threads (a copy of published immutable lists); player-file kinds
run on a 1-thread pool with no queue (busy: 503); `block_hours` uses the 4-slot tick-wait pool and
the existing tick queue (queue capacity, `requestTimeoutMs`, failure/trip policy, budget gate all
apply).

### What each data set is and what it loses

- **Statistics and advancements** are read from the files the server already writes,
  `<world>/stats/<uuid>.json` and `<world>/advancements/<uuid>.json`, on a request thread:
  **zero tick cost**, and a slow or huge file cannot stall the game. Chosen over reading
  `ServerStatsCounter` on the tick because enumerating every stat means walking every block/item
  registry (thousands of ids in this pack) per resident; the files contain only non-zero values.
  Paths come only from watched residents' UUIDs; links are refused; size is checked before reading
  (`maxPlayerFileBytes`, 4 MiB); parsed results are cached by modification time and size (at most
  two files per possible resident; the cache is emptied when residents come and go beyond that).
  *Freshness:* the server writes them at autosave (about every 5 minutes) and at logout, so a
  value can be up to ~5 minutes old; `savedAtMs` says when. *Half-written files:* the server
  rewrites them in place; a read that fails to parse is answered from the previous good read with
  `status: "stale"` (and that read's `savedAtMs`), or `unreadable` if there is none. Statuses:
  `observed|stale|missing|too_large|unreadable|unavailable`. Advancement files list only
  advancements with progress; not-started ones come from `advancement_catalog`. Criterion times
  are the file's own (`yyyy-MM-dd HH:mm:ss Z`); an unparseable time is null. Only the first 64
  criteria per advancement are listed (`criteriaTruncated`; `criteriaDone` counts all). The
  catalog is built on the server thread at start and after `/reload` (`OnDatapackSyncEvent`
  for all players), outside the sampler; its build time is in `/v1/status`. Recipe unlocks
  (`ns:recipes/...`) are excluded unless `recipes=yes`. Titles are whatever the server's language
  resolves (English or a translation key), capped at 128 characters.
- **Block place/break by residents** comes from `BlockEvent.BreakEvent` and
  `BlockEvent.EntityPlaceEvent` (multi-place such as beds counts its main position), listened to
  at LOWEST priority without cancelled events. The first step is a UUID lookup in the watch list in
  use: any player who is not a watched resident (humans, the spectator, mods' fake players) returns
  at once and nothing is kept. Two bounded forms: **hour cells** count every accepted change per
  (resident, dimension, chunk, wall-clock hour) with placed/broken per block id for the first 8 ids
  in that cell (the rest summed as `other*`), at most `blockAggregateCells` (4096) cells kept for
  `blockAggregateHours` (48); and a **detail ring** of `blockDetailCapacity` (4096) entries, at most
  `blockDetailPerTick` (32) per tick, and none once the tick's listener time exceeds
  `tickBudgetMicros`. *Under a burst* (Baritone mining hundreds per minute, a vein-miner breaking
  64 at once) the hour cells still count everything; only detail is skipped (`detailSkipped`).
  *When the cell table is full* the oldest cell from an earlier hour is evicted
  (`evictedThroughHourMs`, `cellsEvicted`); if all cells are from the current hour the change is
  counted only in that resident's hour `overflow` (no position). The ring drops its oldest
  entries when unread (`gap`). *Not seen at all:* changes by explosions, pistons, fluids, mobs or
  machines; bucket placement (no place event); a break another mod aborts after the event has
  passed (counted as a break); anything while paused or tripped. Recording costs a hash lookup
  and two small map updates per resident event; it is timed per event and reported on its own as
  `listenerMaxTickMicros`/`listenerOverBudgetTicks`, and it is also added to the tick's
  `lastTickMicros`/`maxTickMicros`/`overBudgetTicks`, which are measured after the recorders
  publish (ring copies, hour roll-over), so those metrics cover all observer work per tick.
  Repeated listener exceptions (`failureTripCount` in a row) stop block recording only, until
  restart, with a `recorder_stopped` event and state `degraded`.
- **Item flows in watched facilities** are derived inside the existing facility reads (no
  extra world access): when a facility is observed and its item counts differ from its previous
  observation, a flow records each changed item's before/after counts. The change happened
  somewhere between `sinceMs` and `atMs`. `nearby` lists watched residents (at most 4,
  nearest first) whose body was within `flowReach` (8) blocks of the block centre at the sample
  that detected the change (`when: "now"`) or the one before (`"previous"`); `attribution` is
  `nearest_resident_within_reach` or `no_resident_within_reach`. **This is evidence, not proof:**
  human players are never considered, and hoppers, pipes and machines are invisible, so a change
  with a resident nearby can still have been made by someone or something else. `uncertain` names
  why deltas may be incomplete: `item_kinds_truncated`, `slots_truncated`, `observation_gap`
  (the facility was unreadable in between; changes are netted over the gap), `block_changed`,
  `nbt_only_change` (only the count of NBT stacks changed; NBT content is never read). Two
  changes that cancel between reads are invisible. Ring of `flowCapacity` (1024); `dropped` counts
  overwritten flows. Fluids and energy are not diffed. A facility kept across watch pushes keeps its
  baseline; one that moved starts a new one.

### Adding a read

One `QueryVocabulary.Kind` constant (id, scope, where it runs, cost, documented parameters with
bounds) plus one case in `QueryService.answer`; a tick read must copy a bounded, immutable
result. Candidates that fit this shape: damage events (a listener like the block one,
resident-attributed, ring + counters), entity counts at watched farms (a bounded loaded-chunk count
around a facility, tick queue), and machine state (energy/progress through capabilities already read
for facilities). Each needs its own review of what it costs.

## Facilities: what is readable

Facilities and `/v1/block` positions are read through the generic Forge capabilities
`ITEM_HANDLER`, `ENERGY` and `FLUID_HANDLER`, on `side` (or null). Vanilla containers expose these.
Whether a given modded block exposes them on the null side, and what slots it shows there, varies by
mod and is **unverified** for this pack (Mekanism side configuration, Refined Storage nodes). A block
entity with none of the three capabilities is reported `unsupported`, with its type id. There are no
mod-specific adapters (no RS network totals) and no universal registry. Watch the specific block (or
side) that exposes the stock.

## Config

Copy `config.example.json` to `<server>/config/resident_observer.json` and replace the placeholder
hash. Unknown keys are errors, so a typo cannot silently keep a default. Defaults: port 25640,
interval 20 ticks, budget 500 µs per tick, 256 slots, 64 item kinds, 256 events, trip after 5
failures, stalled after 10 s without a tick. The config is read once at server start; restart the
server to change it. It holds **no residents and no facilities**: those come from Commons. A 0.2
config that still has `residents`/`facilities` starts normally; the bridge logs once that they are
ignored and never reads them (not even to validate). Remove them when convenient.

| key | default | bounds / meaning |
|---|---:|---|
| `allowNonLoopback` | `false` | explicit LAN opt-in; bearer still mandatory |
| `allowedHosts` | `[]` | ≤32 additional exact Host names; loopback names always allowed |
| `maxSightDistance` | `128` | 1..512 blocks, eye-to-eye |
| `requestQueueCapacity` | `16` | 1..64 pending tick reads; HTTP also caps tick waiters at 4 |
| `requestTimeoutMs` | `2000` | 100..10000; keep caller timeout larger |
| `maxBookPages` | `100` | 1..100 per book |
| `maxBookPageChars` | `8192` | 1..32767 per encoded/raw or decoded page |
| `maxBookChars` | `65536` | 1..262144 total selected source/text characters, including title/author |
| `queryRatePerMinute` | `60` | 6..600 query tokens per minute per consumer |
| `queryBurst` | `30` | 1..120 bucket size |
| `recordBlocks` | `true` | block place/break recording on/off |
| `blockDetailCapacity` | `4096` | 256..65536 detail ring entries |
| `blockDetailPerTick` | `32` | 1..256 detail entries kept per tick |
| `blockAggregateCells` | `4096` | 256..65536 hour cells kept |
| `blockAggregateHours` | `48` | 2..168 hours of cells kept |
| `recordFlows` | `true` | facility flow recording on/off |
| `flowCapacity` | `1024` | 64..8192 flow ring entries |
| `flowReach` | `8` | 1..32 blocks from the block centre for `nearby` |
| `maxPlayerFileBytes` | `4194304` | 64 KiB..32 MiB per stats/advancements file |
| consumer `scopes` | | `residents`, `facilities`, `library`, `status`, `watch`, `self` (with `resident`, a Minecraft name) |

Changing what is watched needs no restart at all (Commons pushes). Changing server config or
scopes, or adding a genuinely new game primitive, still requires a server restart.

## Minecraft API review checklist (official 1.20.1 mappings)

The bridge uses these exact APIs; compile against Forge 47.4.x and stage their behaviour:

- Thread/players: `MinecraftServer.isSameThread()`, `getPlayerList().getPlayer(UUID)`,
  `ServerPlayer.level()`, `serverLevel()`, `getEyePosition()` (`Vec3.x/y/z`).
- Sight chunk gate: `ServerLevel.getChunkSource().getChunkNow(int,int)`,
  `getMinBuildHeight()`, `getHeight()`, `LevelChunk.getBlockState(BlockPos)`.
- Sight shapes: `BlockPos.MutableBlockPos.set(int,int,int)`, `BlockState.isAir()`,
  `getCollisionShape(BlockGetter,BlockPos,CollisionContext.empty())`,
  `VoxelShape.forAllBoxes(Shapes.DoubleLineConsumer)`. Boxes are intersected with the closed
  eye-to-eye segment by the pure slab algorithm in `SightRay.intersects`; **no `Level.clip`,
  `Level.getBlockState` or `Level.getBlockEntity`**. Fluids are not sight blockers.
- Shape callbacks see only a restricted `BlockGetter`: chunk-backed `getBlockState`,
  state-backed `getFluidState`, build height accessors, and a `getBlockEntity` that always
  throws unknown rather than exposing a block entity's real level. Full ray plus one-block
  shape halo must be loaded. Unsupported/context-dependent shapes, or boxes outside local
  coordinates -1..2, report unknown. Conservative grazing intersections count as blocked.
- Shelf and lectern by position: `ResourceLocation.tryParse`, `ResourceKey.create(Registries.DIMENSION,...)`,
  `MinecraftServer.getLevel`, `ServerLevel.isOutsideBuildHeight`, `getChunkNow`,
  `LevelChunk.getBlockState`, `BlockState.is(Blocks.CHISELED_BOOKSHELF|LECTERN)`,
  `LevelChunk.getBlockEntity(pos,LevelChunk.EntityCreationType.CHECK)`, `BlockEntity.isRemoved`,
  `ChiseledBookShelfBlockEntity.getItem(0..5)`, `LecternBlockEntity.getBook()`. No capability or loot
  resolution.
- Shelf scan: `MinecraftServer.getAllLevels()`, `ServerChunkCache.chunkMap`, `ChunkMap.size()`,
  `ChunkMap.getChunks()` (made public by `META-INF/accesstransformer.cfg`, SRG `m_140416_`),
  `ChunkHolder.getFullChunk()` / `getPos()` (completed futures only), `LevelChunk.getBlockEntities()`
  (iterated within one call, never held across ticks), `BlockEntity.getBlockPos()/getBlockState()`.
- Books: `ItemStack.isEmpty()`, `is(Items.WRITTEN_BOOK|WRITABLE_BOOK|ENCHANTED_BOOK|BOOK)`,
  `BuiltInRegistries.ITEM.getKey` for anything else, `getTag()` (never `getOrCreateTag`);
  `CompoundTag.get` for only title/author/generation/pages, `StringTag.getAsString`,
  `IntTag.getAsInt`, `ListTag.size/isEmpty/getElementType/get`, `Tag.TAG_STRING`. No Minecraft
  component deserializer, `resolveBookComponents`, tag copies or serialization. Literal written-page
  JSON is parsed by bounded Gson `JsonReader`.
- Recorders and files: `BlockEvent.BreakEvent` (`getPlayer`, `getLevel`, `getPos`, `getState`),
  `BlockEvent.EntityPlaceEvent` (`getEntity`, `getPlacedBlock`), `IEventBus.addListener(EventPriority.LOWEST,
  false, Class, Consumer)`, `Level.dimension()`, `BuiltInRegistries.BLOCK.getKey`,
  `MinecraftServer.getWorldPath(LevelResource.PLAYER_STATS_DIR|PLAYER_ADVANCEMENTS_DIR)`,
  `getAdvancements().getAllAdvancements()`, `Advancement.getId/getDisplay/getCriteria/getRequirements/getParent`,
  `DisplayInfo.getTitle().getString()/getFrame().getName()/isHidden()`, `OnDatapackSyncEvent.getPlayer/getPlayerList`.

Unverified on a real server: modded collision callbacks, modded capabilities at arbitrary positions,
actual MSPT with many watched facilities and with a busy shelf scan, and the scan on a live world with
players, large modded chunks and other dimensions loaded.

## Verification

0.3.0 (2026-11-23): `gradlew build` on Inspiron (Forge 47.4.20, Java 17, the access transformer
applied), BUILD SUCCESSFUL, **147 JUnit tests** pass (101 in 0.2.0): watch list parsing, caps and
strictness; the PUT's refusals over the real JDK server (scope, Host, browser, content type, body limit
with and without `Content-Length`, malformed and non-UTF-8 bodies, `library: true`, rate limit, methods)
with nothing changed after each; atomic replacement while ticks run on another thread (no snapshot ever
mixes two lists, every push ends applied or superseded, no tick fails); history kept, moved and dropped
across pushes; a server with no list yet; old config subjects ignored; the five shelf answers and
"unloaded is never no_shelf or an empty shelf"; book reads; `other` items; discovery rules, cursor
paging across a rescan; the scan's per-tick bound, one new book per unit and free rescans of unchanged
books (the real book memo over real NBT, its work bounded by the page cap), dense chunks finished over
several slices, a pass slower than 30 s still served with its real read
times, caps, chunks and levels that vanish mid-scan, a throwing chunk contained, demand and the cache.
The isolated server smoke (with measured costs) is described in the 0.3.0 runbook next to the built jar.

## Install on pop-os (integration owner; approved restart window only)

The step-by-step runbook (config change, credential scope, install, checks after the restart,
rollback to 0.2.0) is `RUNBOOK.md` next to the built jar
(`~/.cache/minecraft-review/server-observer-0.3.0/` on Bazzite). In short:

1. Acquire the canonical pop-os device lease before any SSH/container access. Stop the server
   cleanly in the approved window and back up the current jar and config.
2. Replace this mod's old jar in `/data/mods/` with `resident_observer-0.3.0.jar` (one jar for the mod
   id).
3. In `/data/config/resident_observer.json`: remove `residents` and `facilities`, and add `"watch"` to
   the hub consumer's `scopes` (the token is unchanged).
4. Start the server; check the log line `0.3: serving on ...`, then `GET /v1/watch` (empty, with a
   `bootId`) until Commons pushes, then the watch list, discovery and a shelf read.
5. Rollback: the 0.2.0 jar and the backed-up config; the world is never written by the mod.

## Build (integration owner only)

There is no wrapper copy here: reuse Synapse's Gradle 8.8 wrapper. Build on Inspiron in a scratch copy
(Bazzite's memory guard usually defers Gradle):

```sh
# inside the inspiron lease, in a scratch copy of server-observer/ with synapse-forge's gradlew + gradle/
JAVA_HOME=~/gary-client/jdk17 systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 \
  -p CPUQuota=400% ./gradlew --no-daemon --max-workers=1 build < /dev/null
# -> build/libs/resident_observer-0.3.0.jar
```

The build targets Forge 47.4.20 / official Minecraft 1.20.1 mappings, Java 17. The access
transformer makes ForgeGradle rebuild its patched Minecraft jar once (a few minutes on a warm cache).
