# Resident Observer (server-side, read-only)

A small Forge 1.20.1 mod (`resident_observer`) for the **dedicated server**. It reports what the
server itself sees of the **configured residents** and the **registered facilities**, so Commons
and the caretaker have one authoritative, least-privilege source that does not depend on where
the resident clients run. Status: prototype; built on Inspiron with 41 passing Java tests.
Dedicated-server smoke checks passed on an isolated Forge 47.4.10 pack copy on 2026-11-22.
It is not installed on the live server.

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
  capabilities (a vanilla double chest, for example) look at the neighbouring block through the
  level. If any of those chunks is unloaded, the facility is reported as `unloaded`, with the
  last observation kept as history (`lastKnown`, `lastObservedAtMs`).
- **Tick-thread budget.** All world reads happen in the server tick (END phase). Every
  `intervalTicks`, each configured resident is read with one UUID map lookup. Facilities are
  read round-robin while that tick's observer time is under `tickBudgetMicros`, and the rest
  carry over to the next tick. The budget decides whether to *start* another read. A single
  read that overruns it is counted (`overBudgetTicks`, `maxTickMicros`), not hidden. Slot and
  item-kind counts per facility are capped (`maxFacilitySlots`, `maxItemKinds`, at most 16
  tanks).
- **Request threads never touch the game.** They only serialize immutable published snapshots
  and an event ring. The ring is bounded and drops the oldest events, with monotonic `seq` so a
  consumer can detect gaps. HTTP handling uses 2 threads and a 16-entry queue. When both are
  full, the next exchange runs on the server's dispatcher thread, which stops new connections
  from being accepted until a handler is free. The queue never grows, and nothing is dropped
  silently.
- **Failure isolation.** A facility read that throws becomes that facility's `error` view. A
  whole tick that throws counts as a failure, and `failureTripCount` consecutive failures trip
  the observer off until the server restarts (state `tripped`). `config/resident_observer.paused`
  pauses it without a restart: create the file to pause, delete it to resume. A daemon thread
  checks for the file every 5 s, never the server thread. A missing, disabled or invalid config
  means no socket and no tick work.
- **Client-optional.** It registers no blocks, items, entities or network channels, and its
  `displayTest` is `IGNORE_SERVER_VERSION`.
- **No NBT leaves the server.** Item stacks are counted by id. A stack with NBT is counted
  (`nbtStacks`), and its NBT (book text, names, nested inventories) is never sent.

## Access

- Binds `127.0.0.1` or `::1` only. Any other bind is a config error. To reach it from another
  machine (for example Commons on Inspiron), use an SSH local forward or WireGuard and point
  Commons at the local end:

  ```sh
  ssh -N -L 127.0.0.1:25640:127.0.0.1:25640 <server-user>@<server-host>
  ```

- `Authorization: Bearer <token>`. The server config stores only `tokenSha256` (lowercase hex
  SHA-256 of the exact token string), so the config never holds a usable credential. Tokens
  and hashes are never logged or returned.
- `Host` must be a loopback name. The port is not checked, so a tunnel with a different local
  port works. Requests carrying `Origin` or `Sec-Fetch-Site` (browsers) are refused.
- Scopes, one credential per consumer:

  | scope        | grants |
  |--------------|--------|
  | `residents`  | every configured resident's body and events |
  | `facilities` | registered facility stock and facility events |
  | `status`     | `/v1/status` diagnostics |
  | `self`       | only the bound `resident`'s own body and events; cannot be combined with `residents`/`facilities` |

  Create a credential on the machine that will use it. The token goes to the file and the JSON
  line goes into the server config:

  ```sh
  server-observer/tools/new-consumer-token.sh ~/gary-client/commons-data/observer.token commons residents,facilities,status
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
- `GET /v1/events?after=<seq>&limit=<1..500>` returns `events[{seq, type, atMs, gameTime,
  resident, facility, detail}]`, `oldestSeq`, `latestSeq` and `gap`. `gap` is true when events
  after `after` were already dropped. Event types: `observer_started`, `observer_tripped`,
  `resident_online`, `resident_offline`, `resident_dimension`, `resident_died`,
  `facility_status`.
- `GET /v1/status` (scope `status`): budget, tick timing, lag, failure counters, `lastError`,
  `paused`, `tripped`, configured counts and `eventsDropped`.

Errors use `{"schema":1,"source":"server-observer","error":{"code","message"}}` with status 401
(token), 403 (scope, Host or browser), 405 (non-GET), 404 (path) or 400 (query).

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

The build targets Forge 47.4.20. All 41 pure/config/HTTP/sampler tests passed on
2026-11-22. The first cold-cache build took about 23 minutes, mostly downloading
and preparing the Minecraft development dependencies.

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

O4 (resident-scoped book reading with reach and claim checks) is out of scope for this
read-only prototype. The `self` scope returns only the resident's own body.
