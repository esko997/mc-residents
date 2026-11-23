# Resident Observer server bridge (server-side, read-only)

A small Forge 1.20.1 mod (`resident_observer`) for the **dedicated server**. It reports what the
server itself sees of the **configured residents** and the **registered facilities**, so Commons
and the caretaker have one authoritative, least-privilege source that does not depend on where
the resident clients run. The original snapshot prototype was built with 41 passing Java tests
and smoke-tested on isolated Forge 47.4.10 on 2026-11-22. **The LAN/sight/library/long-poll
extension is not yet built or dedicated-server-tested.** It is not installed on the live server.

It is an adjunct to each resident client's Synapse. It does not replace them: the server cannot
see a client's screen, picture, open GUI or the health of its process.

## What it does and does not do

- **Reads, never writes.** Only `GET` is accepted. There are no commands, RCON, chat,
  inventory or world changes, and no "run arbitrary" endpoint. A future writing API would be a
  separate design.
- **Only configured things.** It reads residents by UUID from the config and facilities by
  their registered block position. It never scans the world, never searches for ores or
  structures, and never reports other players.
- **Never loads chunks.** Chunk access goes only through `ServerChunkCache#getChunkNow`, which
  returns null for anything not already fully loaded. It deliberately avoids
  `Level#getBlockEntity`/`getBlockState`, because both load chunks on the server thread. A
  facility is read only when its whole 3×3 chunk neighbourhood is loaded, because some
  capabilities (a vanilla double chest, for example) look at neighbouring blocks through the
  level. If any of those chunks is unloaded, the facility is reported as `unloaded`, with the
  last observation kept as history (`lastKnown`, `lastObservedAtMs`). Library reads use the
  registered chunk directly, not inventory capabilities. Sight uses a non-loading block view;
  an unloaded chunk anywhere along the ray (even beyond a blocker) means unknown.
- **Tick-thread budget.** All world reads happen in the server tick (END phase). Every
  `intervalTicks`, each configured resident is read with one UUID map lookup. At most one
  queued bridge request present at tick entry runs next, if the budget permits; then facilities
  are read round-robin while under `tickBudgetMicros`. Requests arriving during the tick wait
  for the next tick. Queue backlog or budget exhaustion can defer them further, up to the
  request timeout. The budget decides whether to *start* another read; a single overrun is
  counted (`overBudgetTicks`, `maxTickMicros`), not hidden. Slot/item counts and book/ray sizes
  are capped. Queue capacity defaults to 16 and timeout to 2000 ms; expired/cancelled queued
  reads are discarded. A read already executing cannot be preempted, but never writes.
- **Request threads never touch the game.** They serialize immutable snapshots/results and
  the bounded event ring, or enqueue typed reads with immutable configured arguments. Normal
  HTTP handling uses 2 threads and a 16-entry queue with dispatcher backpressure. Separate
  pools admit at most 4 simultaneous tick waits and 4 event long-polls, with no waiting queue;
  excess waits get HTTP 503. Long-polls inspect the published ring at most every 100 ms and
  never acquire a tick-thread monitor. Sequence numbers remain monotonic for the server run.
- **Failure isolation.** A facility read that throws becomes that facility's `error` view. A
  whole tick or queued bridge read that throws counts as a failure, and `failureTripCount` consecutive failures trip
  the observer off until the server restarts (state `tripped`). `config/resident_observer.paused`
  pauses it without a restart: create the file to pause, delete it to resume. A daemon thread
  checks for the file every 5 s, never the server thread. A missing, disabled or invalid config
  means no socket and no tick work.
- **Client-optional.** It registers no blocks, items, entities or network channels, and its
  `displayTest` is `IGNORE_SERVER_VERSION`.
- **No arbitrary NBT leaves the server.** Stock snapshots still only count item ids and
  `nbtStacks`. The sole exception is explicitly registered library shelves under the separate
  `library` scope: selected book metadata, content hashes, and bounded written/writable page
  text. No nested inventories, enchantment data, arbitrary tags or component actions are sent.

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
- Scopes, one credential per consumer:

  | scope        | grants |
  |--------------|--------|
  | `residents`  | every configured resident's body, events and pairwise sight |
  | `facilities` | registered facility stock and facility events (no book text) |
  | `library`    | registered library shelves and book text; health events only without other scopes |
  | `status`     | `/v1/status` diagnostics |
  | `self`       | only the bound resident's own body and events; cannot combine with `residents`/`facilities`/`library` |

  Create a credential on the machine that will use it. The token goes to the file and the JSON
  line goes into the server config:

  ```sh
  server-observer/tools/new-consumer-token.sh ~/gary-client/commons-data/observer.token commons residents,facilities,library,status
  ```

## Endpoints (schema 1)

Every reply has `schema`, `source: "server-observer"`, `consumer`, `scopes`, `state`
(`starting|ok|degraded|paused|stalled|tripped`), `stateDetail`, `servedAtMs` and `heartbeatAtMs`.
All times are milliseconds on the server's clock. `servedAtMs - builtAtMs` gives a skew-free age.

- `GET /v1/snapshot`: `snapshot` is null until the first tick. Otherwise it contains `seq`,
  `builtAtMs`, `gameTime`, `residents[]` and `facilities[]`.
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
- `GET /v1/events?after=<seq>&limit=<1..500>&wait=<0..25>` returns
  `events[{seq,type,atMs,gameTime,resident,facility,detail}]`, `oldestSeq`, `latestSeq`, `gap`.
  `wait` defaults to 0 seconds; an existing page/gap returns immediately. Otherwise wait up
  to the deadline for ring advancement, pause, or trip. An invisible event also ends the wait
  with an empty filtered page and advanced `latestSeq`, so clients can advance their cursor.
  A cursor ahead of the current ring (server restart) returns immediately. `gap` is true when
  events after `after` were dropped. Event types remain `observer_started`, `observer_tripped`,
  `resident_online`, `resident_offline`, `resident_dimension`, `resident_died`, `facility_status`.
- `GET /v1/status` (scope `status`): budget, tick timing, lag, failure counters, `lastError`,
  `paused`, `tripped`, configured counts and `eventsDropped`.
- `GET /v1/sight?from=Gary&to=Margo` (`residents`, never `self`): adds
  `sight:{visible:true|false|null,distance:number|null,reason:string}`. Both names must be
  configured (case-sensitive); the tick resolves their online players and eye positions.
  Different dimensions, offline players, out-of-range or unloaded rays are unknown (`null`),
  not an obstruction. Distance is eye-to-eye blocks when meaningful; max defaults to 128.
- `GET /v1/library/shelf?facility=commons-library` (`library`): adds
  `shelf:{facility,status,reason,slots:[{slot,kind,title,author,generation,pageCount,contentHash}]}`.
  Slots are occupied books only, numbered 0..5; kind is `written|writable|enchanted|plain`.
  Nullable metadata is null when inapplicable. No pages appear in shelf replies.
- `GET /v1/library/book?facility=commons-library&slot=0` (`library`): adds
  `book:{facility,status,reason,book:BookInfo|null,pages:string[]}`. Written/writable books
  return plain text pages; other kinds are `not_readable`. Only configured facilities with
  `"library":true` are accepted; no scans or arbitrary coordinates. Success is `observed`;
  unavailable/error results have explicit status/reason and no stale pages. Invalid/oversized
  books fail closed rather than returning a hash of truncated text.

Library status values: `observed|unloaded|no_level|no_block_entity|unsupported|empty|not_readable|
too_large|invalid|error`; `reason` may be null on success. One invalid book fails the whole shelf
listing explicitly (no misleading partial list). Page limits count UTF-16 code units and cover
both selected source and decoded text; aggregate limits include title and author. Titles are
capped at 128 characters, authors at 64, written-book generation at 0..3. Written pages accept
literal JSON text/arrays/`extra`; formatting/actions are discarded. Dynamic `selector`, `score`,
`nbt`, `translate` and `keybind` components fail closed; they are never resolved.

`contentHash` is SHA-256 of the `resident-book-v1` projection, not the raw item/NBT: length-prefixed
UTF-8 kind/title/author/generation plus page count and plain-text pages. Slot, facility, formatting,
click/hover actions, enchantments, filtered pages and other NBT are excluded. Exact framing is in
`BookText.java`. Plain/enchanted books hash only their kind and empty selected content.

Sight/library requests enter the bounded tick queue; they do not read cached players/blocks
on HTTP threads. Envelope times are sampled after completion. No automatic action retries.
Commons helpers in `full-client/commons/src/observer.ts`: `observerSight(source,{from,to})`,
`observerShelf(source,{facility})`, `observerBook(source,{facility,slot})`, and
`observerEvents(source,{after,limit,wait,timeoutMs})`. Helpers preserve unknown sight and
health/scopes. `ObserverFeed` defaults to non-waiting events; `eventWaitSeconds` opts into
long-polling. Event deadlines add the wait to the timeout margin, and event times use the event
reply's own clock offset. Sight/book helpers default to a 4 s HTTP timeout (server default 2 s).

Errors use `{"schema":1,"source":"server-observer","error":{"code","message"}}` with status 401
(token), 403 (scope, Host or browser), 405 (non-GET), 404 (path/unregistered library), 400 (query),
503 (bounded wait/queue full, paused, tripped, stopping), 504 (tick result timeout), or 500 (read failure).

## Facilities: what is readable

Facilities are read through the generic Forge capabilities `ITEM_HANDLER`, `ENERGY` and
`FLUID_HANDLER`, on `side` (or null). Vanilla containers expose these. Whether a given modded
block exposes them on the null side, and what slots it shows there, varies by mod and is
**unverified** for this pack (Mekanism side configuration, Refined Storage nodes). A block entity
with none of the three capabilities is reported `unsupported`, with its type id. This prototype
contains no mod-specific adapters (no RS network totals) and no universal registry. Register the
specific block (or side) that exposes the stock.

## Config

Copy `config.example.json` to `<server>/config/resident_observer.json` and replace every
placeholder. Unknown keys are errors, so a typo cannot silently keep a default. Defaults:
port 25640, interval 20 ticks, budget 500 µs per tick, 256 slots, 64 item kinds, 256 events,
trip after 5 failures, stalled after 10 s without a tick. The config is read once at server
start; restart the server to change it.

New settings (all read once at startup):

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
| facility `library` | `false` | explicit chiseled bookshelf; `side` must be null/absent |

The mod provides bounded read primitives; new hub tools composed from them need only a Commons
reload/restart, **not** a Minecraft restart. Changing server config, registrations/scopes or
adding a genuinely new game primitive still requires a server restart.

## Minecraft API review checklist (official 1.20.1 mappings)

The new bridge uses these exact APIs; compile against Forge 47.4.x and stage their behaviour:

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
- Shelf: `ResourceLocation.tryParse`, `ResourceKey.create(Registries.DIMENSION,...)`,
  `MinecraftServer.getLevel`, `ServerLevel.isOutsideBuildHeight`,
  `getChunkNow`, `LevelChunk.getBlockState(...).is(Blocks.CHISELED_BOOKSHELF)`,
  `LevelChunk.getBlockEntity(pos,LevelChunk.EntityCreationType.CHECK)`, `BlockEntity.isRemoved`,
  exact `ChiseledBookShelfBlockEntity.class` and `getItem(0..5)`. No capability or loot resolution.
- Books: `ItemStack.isEmpty()`, `is(Items.WRITTEN_BOOK|WRITABLE_BOOK|ENCHANTED_BOOK|BOOK)`,
  `getTag()` (never `getOrCreateTag`); `CompoundTag.get` for only title/author/generation/pages,
  `StringTag.getAsString`, `IntTag.getAsInt`, `ListTag.size/isEmpty/getElementType/get`,
  `Tag.TAG_STRING`. No Minecraft component deserializer, `resolveBookComponents`, tag copies
  or serialization. Literal written-page JSON is parsed by bounded Gson `JsonReader`.

Unverified: Forge compilation, modded collision callbacks, actual per-read MSPT/overruns and
chunk counts, real shelf behaviour with this pack, and container mount/network topology.
Mappings signatures alone are not dedicated-server evidence.

Authoring verification: the single permitted guarded Commons command passed 19 observer tests
across two files. `tsc --noEmit` then reported two widened-string errors in the new library
status test loop; the loop now uses `as const`. Typecheck was not rerun under the one-run limit.
Java tests were added but not run; no Gradle, SSH, deployment or commit occurred.

## Install on pop-os (integration owner; approved restart window only)

1. Build and pass staging below first. Acquire the canonical pop-os device lease before any
   SSH/container access; no live device or server was touched for this source change.
2. Confirm the container's actual `/data` host mount and network mode. Recorded layout is
   `~/mc-servers/simon_vanilla_plus/mc-data` for container `simons-vanilla-plus`; **reconfirm
   that mount before copying**, since it was not inspected during this change.
3. Stop the server cleanly in the user-approved window and back up its world and current
   config/mod jar. Install `resident_observer-0.1.0.jar` into `/data/mods/`
   (host `<confirmed-mc-data>/mods/`), replacing only this mod's old jar.
4. Install the edited example as `/data/config/resident_observer.json`
   (host `<confirmed-mc-data>/config/resident_observer.json`). Use actual resident UUIDs,
   shelf positions and dimensions; all example hashes/positions are placeholders.
5. **On Inspiron**, create one hub credential using the command in Access. Only its printed
   hash entry goes to pop-os `consumers`. Hub needs `residents,facilities,library,status`;
   resident bodies and remote stations do not need server-bridge credentials. Protect the
   token file mode 0600. No extra caretaker token is needed when it reads through the hub.
6. For direct LAN: set the three LAN config fields above; publish container port 25640
   appropriately (host port bound to the intended LAN interface), and firewall it to Inspiron.
   A container's `127.0.0.1` is not host loopback; a published container port requires listening
   on its container interface, or a tunnel/proxy reaching that namespace.
7. Set hub `COMMONS_OBSERVER_URL=http://192.168.1.233:25640` and
   `COMMONS_OBSERVER_TOKEN_FILE=~/gary-client/commons-data/observer.token`, or use the local
   tunnel URL. Start server; verify authenticated status and every staging acceptance item.
8. Pause path is `/data/config/resident_observer.paused` (same confirmed host mount); create/
   remove to pause/resume, up to 5 s detection. Rollback: clean stop, restore prior jar/config,
   restart; preserve the world and credentials. No client mod installation is required.

## Build (integration owner only)

There is no wrapper copy here: reuse Synapse's Gradle 8.8 wrapper. On Inspiron,
the integration cache is `~/.cache/minecraft-gradle`. Use the host's memory-safe
build wrapper (`Skills/host-memory-safe-build.md`, `agent-heavy`) and Gradle lock.
Put the Gradle invocation inside a shell so the guard does not add duplicate worker flags:

```sh
cd ~/Repos/minecraft-residents
GRADLE_USER_HOME="$HOME/.cache/minecraft-gradle" AGENT_BUILD_JOBS=1 \
  flock -n -E 75 /tmp/sortie-gradle.lock ~/.local/bin/agent-heavy /bin/bash -ec \
  '~/Repos/synapse-forge/gradlew -p server-observer --no-daemon --max-workers=1 test build'
# -> server-observer/build/libs/resident_observer-0.1.0.jar
```

The build targets Forge 47.4.20 / official Minecraft 1.20.1 mappings, Java 17.
The 41-test result and ~23-minute cold-cache build refer to the **earlier prototype only**.
The integrator must compile and run all Java tests for this extension; no Gradle was run
while authoring it. Do not use a warm-cache timing estimate for the guarded cold-cache build.

## Staging evidence and remaining checks

On an isolated 47.4.10 dedicated server, a normal pack client **without** the
observer mod joined successfully. Live checks passed for unauthenticated
rejection, write-method rejection, browser-Origin rejection, caretaker scope,
resident-only `self` scope, facility events, and a chest changing from 30 to 20 bread.
A distant registered facility stayed unloaded; an invalid dimension reported
`no_level`. After visiting another chest and leaving, its current contents became
null while `lastKnown` retained its 20 bread. The pause file stopped observations
and removing it resumed them. These checks did not touch the production server.

The broader staging checklist below is not fully measured: client/server position
agreement, modded inventory capabilities, comparative chunk counts and MSPT still
need their own evidence.

Install only on a staging copy of the server first. Then check:

- **O1:** Positions and dimensions of online residents match their clients within one interval.
- **O2:** For a registered chest and Mekanism slot: stock matches the screen; with the chunk
  unloaded, the status is `unloaded`, the timestamp stays put and `lastKnown` is kept.
- **O3:** Loaded and forceloaded chunk counts are identical with the observer on and off.
  `/forceload query` and spark are suitable tools for this.
- **O5:** MSPT with and without the observer (spark), recorded together with `maxTickMicros`
  and `overBudgetTicks`.
- **O6:** The pause file stops reads within about 5 s, and the state reads `paused`. A facility
  whose block was broken reports `no_block_entity`; one with a bad dimension reports `no_level`.
  The game is unaffected in both cases. Kill the tunnel and check that Commons shows the
  observer as `offline` while the clients' own data continues. Exception-driven tripping is
  covered by unit tests only.
- A normal pack client without the observer mod joins normally (passed).

New bridge staging gates (all unverified on a real dedicated server):

- **B1 LAN/auth:** default loopback and missing-opt-in LAN rejection; opt-in LAN with exact
  configured Host succeeds only with bearer; wrong Host/Origin/empty Sec-Fetch-Site/wrong scope/
  write methods rejected. `self` cannot read sight or library. Normal no-mod client still joins.
- **B2 sight:** two configured online residents, clear/blocked eye rays, slabs/fences/glass,
  negative coordinates, exact chunk boundary/corner, offline, cross-dimension and over-distance.
  Unload any crossed chunk (including beyond a blocker): unknown, never false/clear. Compare
  chunk/forceload counts before/after repeated rays, including shape-neighbor accesses.
- **B3 library:** registered chiseled shelf with written/writable/plain/enchanted books; verify
  zero-based slots, title/author/generation/page counts/hash and plain text against the book.
  Change pages and move books between slots: content hash changes only with selected content.
  Test empty/broken/wrong-block/unloaded shelf, unknown id, ordinary non-library facility,
  invalid slot, malformed/oversized pages and malicious JSON components. No raw tags or actions.
- **B4 queues:** no ticks → bounded timeout; paused/tripped → no game reads; concurrent reads/
  long-polls beyond their four slots → 503; snapshot/status remain responsive. Check budgets,
  per-read overruns and facility lag under sustained requests; no accepted wait grows unbounded.
- **B5 events:** empty wait expires at requested 0..25 s; publishing wakes within ~100 ms;
  filter scopes, cursor advancement, dropped-event gaps, restart cursor, fresh reply times,
  server shutdown and tunnel outage. Commons retains its last snapshot and reports outage.
- **B6 production gate:** world backup, approved restart, confirmed config mount/port/firewall,
  jar checksum, clean server log, all above evidence and rollback ready. Do not install merely
  because pure tests pass.
