# Shared Knowledge

One page, opened from a phone or laptop on the home LAN, to watch the residents,
to look over their Shared Knowledge (skills and shared notes), and to
read and use the Minecraft server's console. It is the home base for running
the project, laid out so that panels and actions can be added. What it changes:
shared knowledge (reviews, edits, automatic acceptance of notes), and the server
through the commands typed into its console.

The dashboard is one Bun process, with no build step. Optional live video adds
FFmpeg and MediaMTX. Each host reads its own files and clients' Synapse APIs on
loopback. The hub owns the shared SQLite (`schema.sql`); residents use its
authenticated resident API rather than opening that database.

The header and browser title follow the active panel. The library tab is
**Shared Knowledge**; internal `commons` paths, API routes, service name,
database and existing bookmarks are unchanged.

## Hub and stations

`COMMONS_ROLE=hub` (default) is the shared-knowledge authority. Set
`COMMONS_HOST_NAME=inspiron` on the hub; the default is the operating-system hostname.
The hub retains the existing dashboard token, console bridge and local Live service.
It alone serves shared knowledge, reviews, commands and the resident API.

`COMMONS_ROLE=station` runs the same package for another host's residents. Set
`COMMONS_HOST_NAME=chungus1` there. A station serves only authenticated dashboard
GETs for `residents`, `activity`, `thoughts`, `map`, `notes`, `file`, `picture`, `map-picture`
and `overlay/source`, plus the dashboard static assets and its own Live API
(see [Live on stations](#live-on-stations)). It samples local positions into its own SQLite
and keeps its local place-picture cache; it never initializes or accesses shared
tables. Shared Knowledge, review, console and server observer are disabled,
even if their old environment settings are present. Do not copy the hub DB to a station.
Stations now read the `COMMONS_LIVE_*` settings like the hub: an invalid
leftover value (for example `h264_vaapi` without a device) stops Commons at start.

The hub reads `COMMONS_STATIONS_FILE`, default
`~/gary-client/commons-data/stations.json` (under `GARY_CLIENT_HOME` when set):

```json
[{"host":"chungus1","url":"http://192.168.1.120:8770/<station-token>/"}]
```

Replace the placeholder with the station's own dashboard token; keep this file
**mode 600**, regular and not symlinked. Up to 16 unique hosts are supported.
Each URL must be an HTTP(S) origin plus its single secret path and trailing slash,
without a query, fragment or embedded username/password. The file is optional
(missing means no stations); mtime/inode changes reload it without a restart.
Invalid edits show a configuration error and retain the last valid configuration.
Never put these URLs in public JavaScript or copy them into resident credentials.
Use trusted LAN routing or an SSH tunnel/TLS for transport; a secret URL is not encryption.

Station discovery refreshes every five seconds, with a 2.5-second request/body
deadline and single-flight caching. Aggregate replies return immediately with
cached station data: a slow station cannot delay the local residents. Until first
successful discovery, a failed host is shown as an error without invented resident
names. After discovery, its roster stays listed as **host unreachable**, with
`hostLastSeen` (Unix milliseconds), while its last good trails/activity are retained
in memory. The hub persists names and last-seen times in a mode-600
`<COMMONS_DB>.station-roster.json` (no station URL), so an unreachable station's
roster survives a hub restart; preserve that file alongside the DB. Duplicate names,
ignoring case, are visible configuration errors, and ambiguous resident-scoped reads
return 409.

Merged dashboard shapes preserve existing fields:

- `residents`: adds `role`, `federationErrors`; each resident has `host`,
  `hostUnreachable`, `hostLastSeen`, `liveAvailable`, `audioAvailable`. A station
  reports its own Live/audio settings; the hub shows them only while the station is
  reachable and the name is unique.
- `activity`: merges host-tagged entries and summaries, remapping IDs into a hub
  cursor. A source restart/discovery changes `boot`, resetting browser cursors.
- `map`: merges local/shared places with station-private places, deaths and trails
  for the requested hours. Remote picture IDs are `station:<host>:<image-id>`;
  `map-picture` forwards them without exposing the station URL.
- `notes?resident=Name`, `file`, `picture` and `thoughts?resident=Name` resolve the owning host. Notes include
  that host's caretaker entries and the hub's current shared places. `commons`
  includes remote caretaker notes but never fetches a station's shared knowledge.
- Scoped remote reads have the same five-second cache and bounded deadline;
  unavailable data returns 502 instead of pretending an old picture/file is current.
  Console remains hub-local: phone-chat server lines plus the hub's client logs.

### Install a station

1. Install Bun and this Commons package under `~/gary-client/commons`, then
   `bun install --frozen-lockfile`. Use the same service unit on the station.
2. Install only that host's resident directories and `instances/Name.env` files,
   local Synapse token files, rollout/call logs and `overseer/`. Gary is inferred
   on stations only when `resident/gary` actually exists; Wren/Tobin each need
   their own instance file and lowercase note directory.
3. In private `~/.config/commons/env`, set `COMMONS_ROLE=station`,
   `COMMONS_HOST_NAME`, `GARY_CLIENT_HOME`, `PORT=8770`, and a **local**
   `COMMONS_DB=~/gary-client/commons-data/station.sqlite`. Let Commons create its
   own dashboard token or set a separate token file. Do not reuse the hub token.
4. Permit the hub to reach the station port (or configure a tunnel), start Commons,
   then add its host/secret URL to the hub's mode-600 stations file. Preserve the
   hub's original dashboard secret URL.
5. Configure residents and the per-host caretaker to call the **hub**
   `COMMONS_URL`, with individual resident tokens and a distinct caretaker token.
   Register their hash-only credential records on the hub. See
   [the caretaker README](../overseer/README.md) for `caretaker.env` and role gates.
   Only the hub runs central review/research jobs. Never use the dashboard token
   as a bearer token or overwrite it with the caretaker token.
6. Optional: enable Live on the station itself; see [Live on stations](#live-on-stations).

## Run

    bun src/server.ts          # on the game machine, from ~/gary-client/commons
    bun run demo               # anywhere: made-up data, a stand-in client for Gary, Margo offline
    bun test && bun run typecheck   # needs `bun install` once (types and tsc only)

The demo also stores a made-up week of the server record (`scripts/demo-server-data.ts`) and
runs a stand-in server bridge; `DEMO_OLD_BRIDGE=1 bun run demo` makes it an older bridge
without queries, to see how the Server record says so.

As a service: see `commons.service`.

The dedicated resident host is **Inspiron**, `swatson@192.168.1.69` (Debian 13).
The Minecraft server remains on pop-os, `192.168.1.233:25570`. Preserve the
existing URL's secret path when changing an old dashboard bookmark's host to
`192.168.1.69:8770`; migration does not rotate its token.

Host operations use `tools/with-inspiron.sh <scope>` from the repository root:
it holds the canonical `DEVICE_ACCESS_INSPIRON7577.md` flock and exports
`INSPIRON`, `INSPIRON_SSH` and `INSPIRON_NOTE`. Keep every SSH/copy inside that
wrapper. One-off SSH commands must read `/dev/null`; remote scripts use heredocs.

Clients use the NVIDIA X11 session (`DISPLAY=:0`, `~/.Xauthority`), the portable
Java 17 at `~/gary-client/jdk17`, and a host-native Python venv with
`portablemc==5.0.6`. Debian prerequisites: `python3-venv`, `libopenal1`, `bubblewrap`.
`launch.sh` defaults to a 4 GiB Java heap. Resident clients, minds, caretaker,
dashboard and `residents.slice` have no systemd memory or swap caps on this
dedicated host. CPU quotas remain. Linux may still swap or invoke its global
OOM killer if the machine is exhausted; this is not a guarantee of capacity.
Install `full-client/residents.slice` in `~/.config/systemd/user/` and start
mind/caretaker transient units with `--slice=residents.slice`, without memory
properties. This runtime policy does not relax the separate build-memory guard.
`GARY_CLIENT_JAVA`,
`GARY_CLIENT_HEAP` and `GARY_CLIENT_DISPLAY_BACKEND` can be set in the instance
environment. The optional `headless` backend requires Gamescope; Debian 13's
configured repositories do not provide it. The X11 backend requires a logged-in,
unlocked desktop even when user-service lingering is enabled; Inspiron's
Light Locker/idle sleep/DPMS are disabled for unattended operation.
Install the distribution `bubblewrap` even though Codex advertises a bundled
fallback: on this Debian host the fallback left native file edits failing while
MCP-written plans worked. A real workspace-write `apply_patch` and readback
succeeded after installation; do not disable the sandbox to fix this.

Only `commons.service` is enabled persistently. Resident sessions and the
caretaker are started explicitly, never at boot: by `tools/start-run.sh` on the
resident host (which reproduces the old launcher: `<name>-run` per resident plus
`overseer-run`, one shared deadline) or through Commons' run controller, which
the Residents view's Start/Stop buttons and Switchyard use. Stop with
`tools/stop-run.sh` or the controller. Commons does no scheduling itself;
Switchyard keeps the daily window. See [docs/run-controller.md](docs/run-controller.md).

For a continuous run with an exact wall-clock end, pass `SESSION_END_AT`
(Unix seconds) to `run-session.sh`; it overrides minutes and includes startup.
Set `TZ=America/New_York` when calculating/displaying the deadline. Do not use
`run-until.sh` for continuous-mind experiments. Codex resumes its same thread
after voluntary early returns; repeated rapid returns and no-body runs stop.
Deploy `health-watch.py` beside the launcher. It probes authenticated read-only
body state every 15 seconds, allows five minutes for startup, and recovers after
at least three failures spanning a minute. A normal death is not disconnection.
Recovery stops the old mind/client, waits 30/60/120 seconds and then up to five
minutes between later attempts, restarts the client, and resumes the same Codex
thread. It keeps retrying recoverable body/startup failures until the original
deadline; it never replays a world action. The resumed resident is told to inspect
current state because an interrupted action may already have completed.
Credential/configuration errors and genuine mind failures still require repair.
Health, reason, deadline, thread, restart count and next retry are recorded in
`sessions/<Name>-health.json`; transitions also go to its `.jsonl` and session
log, and the Residents panel displays recovery progress. An operator stop or the
absolute deadline interrupts backoff; neither starts another attempt. Shutdown
and note cleanup remain bounded.

The caretaker loop accepts the same `SESSION_END_AT`. On the **hub only**, it runs
`knowledge-research.py` once per cycle: at most two requests, 180 seconds each,
three attempts per revision with exponential backoff starting at thirty minutes.
Publication needs version-scoped structured guidance and completed web-source
visits from an allowlisted public documentation site or official repository.
Unsupported evidence stays unavailable with a reason; it is never promoted
to a tested skill. No human approval gate is imposed.

Failed research retains bounded, redacted diagnostics in the private
`~/gary-client/overseer/research-diagnostics/` directory (0700; files 0600;
newest 40, at most 16 MiB). Preserve this directory during deployments.
Missing controls enter a separate capability queue; dependent questions are
parked instead of repeatedly researched. Maintainers resolve a capability with:

```bash
python3 ~/gary-client/overseer/knowledge-research.py \
  --resolve-capability 1 --resolution provided --note 'Implemented and verified with a disposable client.'
```

Use `declined` with an explanation when it will not be supplied. `provided`
reopens questions whose remaining blocking capabilities are all resolved;
it is not evidence that every use works.

Shared Knowledge now also displays voluntary agreements, observed facilities,
knowledge gaps and researched references. `GET commons` includes these under
`community`. Agreements distinguish acceptance, provider-reported delivery and
recipient confirmation. Facilities preserve stewardship/access terms separately
from visitors' observations; condition ages after six hours and stock after
thirty minutes. Counts are dated reports, not live inventory or reservations.
Both residents receive MCP tools for these records and guide feedback/updates;
`what_next` and the caretaker see relevant dependencies and shared capabilities.
These panels are read-only: they do not assign work or forge world evidence.

An optional read-only server observer adds **separate** server-presence and
facility-stock observations. It never changes a failed client into an online
client, substitutes server coordinates into client trails, or overwrites resident
reports. Snapshot time, health and stock provenance remain visible. Unloaded
facilities and observer outages retain explicitly historical stock, not a
current or empty inventory. This prototype is opt-in; installing or configuring
the server mod is a separate operation. See `../../server-observer/README.md`.

Connect through a loopback SSH tunnel or equivalent protected transport.
Configure both observer environment variables, or neither; keep the bearer
token in a private file, never in the URL. Management needs the observer's
`residents`, `facilities` and `status` scopes, not a resident `self` token.

With a bridge of version 0.2.0 or later, the hub also ingests the bridge's declarative
queries once a minute (`src/observer-ingest.ts`, tables `server_*` in `schema.sql`):
each resident's server statistics (stored per save, only changed values) and advancement
progress with criterion times, the advancement catalog, block place/break by residents (complete
per-chunk hourly counts plus a recent detail window) and item flows in registered facilities
(with the nearest resident within reach as evidence, not proof). Known losses (ring
overwritten, cells evicted, bridge restart) are stored in `server_ingest_gaps`. An older bridge
answers "unsupported" and is re-checked every 10 minutes, so the hub runs before and after the
jar swap. Read API, hub only: `GET api/server-data` (summary and ingest health),
`server-data/stats?resident=&type=&key=&since=`, `server-data/advancements?resident=`,
`server-data/blocks?since=&until=&resident=&dimension=&limit=`,
`server-data/block-changes?since=&resident=&limit=`, `server-data/flows?since=&facility=&limit=`,
`server-data/gaps?since=`. Times there are the server's clock. The **Server record** panel and
the Map's building layer read four more, aggregated on the hub and bounded
(`src/server-data-views.ts`): `server-data/record?window=session|24h|7d`,
`server-data/block-map?since=&until=&dimension=&resident=&limit=`,
`server-data/block-cell?dimension=&chunkX=&chunkZ=&since=&until=&limit=` and
`server-data/ledger?since=` (see [Panels](#panels-and-what-each-reads)).

Dashboard addresses are `http://<machine>:<PORT>/<token>/...`. A wrong or missing token
gets 404. `/<token>` redirects to `/<token>/`. Keep the address private and off
public networks. The separate Resident API uses bearer credentials, not this URL token.
When `COMMONS_TOKEN` is not set, a token is made at the first
start, saved (mode 600) next to the database, and the full address is printed
once; later starts print only where the token file is.

## Private live video

The **Live** panel lists every resident, on the hub and on stations. Each host
has one shared channel for its own residents: Watch starts it; watching another
resident **on the same host** switches it for all of that host's viewers, while
channels on other hosts are unaffected. The status line names the host whose
channel you see. Up to four viewers may share one channel. Stop, leaving Live, or
hiding the page releases that viewer; capture and encoding stop when the last
viewer leaves. Lost viewers expire after 30 seconds. Audio is opt-in; there is no
recording or desktop capture.

Loading screens do not end the channel. When the resident changes dimension,
respawns or the client stops sending frames for 5 seconds, Synapse ends its raw
stream. Commons then keeps the same FFmpeg process, publisher and viewers, and
re-sends the last complete frame every 0.5 seconds while it polls `/video/info`
every 0.5 seconds. Live status stays `live` with `resuming: true` and the page
says "Between worlds; holding the last picture." When the same framebuffer size
is available again, capture resumes. Only whole frames reach the encoder; a
partial frame left by the ended stream is discarded. The channel fails after 90
seconds of resuming, or at once if the framebuffer size changes (a new size
needs a new encoder), or on authentication or incompatible-header errors. The
server never restarts a failed channel.

When a session still ends for a recoverable reason (channel ended or failed,
track ended, connection failed) while the page is visible and the viewer has not
pressed Stop or chosen another resident, the browser presses Watch again for the
same resident after 1, 3 and 8 seconds, at most three attempts per two minutes,
then shows a final message. It never reconnects after Stop, a resident change, a
hidden page, or when Live is disabled or unsupported.

The path is the client's main framebuffer → authenticated loopback raw frames
→ FFmpeg → loopback RTSP → MediaMTX → WebRTC. Only encoded WebRTC media listens
on the LAN (UDP/TCP 8189); signaling uses this dashboard's existing secret URL.
Keep the dashboard on a trusted LAN: its HTTP signaling is not HTTPS. No
Internet traversal, STUN or TURN is configured. Status beside the video has its
own sample time; it is not frame-synchronized and does not infer the resident's
current action.

Install FFmpeg with the explicitly selected H.264 encoder (NVENC, VAAPI or
libx264), plus Pulse input and libopus for optional audio, and MediaMTX **1.21.4**.
Copy the MediaMTX executable to `~/gary-client/bin/mediamtx`, and
`../live/mediamtx.yml` to `~/gary-client/live/mediamtx.yml`. Install
`../live/resident-video.service` as a user service and
`../live/commons-live.conf` as
`~/.config/systemd/user/commons.service.d/live-video.conf`, then run
`systemctl --user daemon-reload`. The drop-in enables video and starts the
relay alongside Commons. The relay may stay running; the encoder and
framebuffer capture are on demand only.

Enable `[features] videoEnabled = true` in each stopped client's
`config/synapse-client.toml`, with the matching Synapse build installed.
Set `COMMONS_LIVE_ENABLED=true` for Commons, start `resident-video.service`,
then restart Commons. The default encoder is `h264_nvenc`; failures are shown,
never silently retried with software encoding.

Optional overrides: `COMMONS_LIVE_FFMPEG` (executable path),
`COMMONS_LIVE_RTSP_URL` (default `rtsp://127.0.0.1:8554/resident`) and
`COMMONS_LIVE_WHEP_URL` (default `http://127.0.0.1:8889/resident/whep`).
Both publish/signaling URLs must remain loopback-only. Set
`COMMONS_LIVE_ENCODER` explicitly to `h264_nvenc`, `h264_vaapi` or `libx264`;
VAAPI also requires `COMMONS_LIVE_VAAPI_DEVICE`. No fallback is automatic.

The experimental [Twitch mode guide](../../docs/TWITCH-MODE.md) covers isolated
per-client audio, OBS RTSP pull, transparent overlays, the second-window scene
editor and composite preview. These pages live under the existing secret URL:
`overlay`, `overlay/control`, `overlay/preview`. Keep that URL off stream.

### Live on stations

A station may run Live for its own residents when **its own** configuration
enables it, with its own explicit encoder and its own MediaMTX. The browser still
talks only to the hub's secret URL:

```text
browser ──signaling──▶ hub /<hub-token>/api/live/* ──server-side──▶ station /<station-token>/api/live/*
browser ◀═══════════ WebRTC media (UDP/TCP 8189) ═══════════════▶ station MediaMTX
```

The hub routes each request by resident: `GET live/status?resident=Name`, and
`POST live/watch {resident}`, `live/offer {lease, generation, resident, sdp}`,
`live/heartbeat {lease, generation, resident}`, `live/stop {lease, generation, resident}`.
A hub resident (or a request without `resident`, from an old page) uses the hub's
own channel; a station resident's request goes to the station URL in the stations
file. The station alone issues leases and generations, so fencing, the four-viewer
cap, last-viewer teardown and the "between worlds" resume work as on the hub. The
hub checks origin, JSON type and the SDP body limit before forwarding, rebuilds
the body from validated fields, and returns only a validated status/lease/SDP
shape plus `host`. That is the stations-file label, already shown on every
dashboard resident (`Wren (chungus1)`) and never on the overlay; choose a label
that is not the station's DNS name if the name itself is private. Station
status details and error sentences are relayed only when they contain no URL,
IP address, `name:port`, long token-like run, control character, or the
station URL's host, port or secret path; otherwise a fixed sentence replaces
them. Deadlines: status 2.5 s, watch 33 s,
offer 11 s, heartbeat and stop 6 s; at most 12 calls in flight per station
(then 429). Concurrent status reads for one station share one request. A
station that is unreachable, has Live disabled, or shares a resident name with
another host is refused for that resident with a clear reason; hub-local Live and
other stations are never delayed. The station's media candidates (its LAN
address and port 8189) reach the browser inside the SDP answer; nothing else about
the station does.

The overlay pages (`overlay`, `overlay/control`, `overlay/preview`) also accept
any federated resident. Overlay state stays on the hub. For a station resident the
hub reads the station's `overlay/source?resident=Name` through the federation
cache (five seconds, never awaited by the overlay), accepts only its exact bounded
shape, and applies the hub's secret filter and hide list as for hub residents.
Chat, alarms and shared places come from the hub. While the station is
unreachable, the last sample stays visible with its time but is shown offline.

Install on the station:

1. FFmpeg with the selected encoder. For AMD, install Mesa's VA-API driver and
   check the encoder on the actual render node, for example
   `vainfo --display drm --device /dev/dri/renderD128` must list
   `VAProfileH264ConstrainedBaseline` (or `VAProfileH264Main`) with
   `VAEntrypointEncSlice`, and `ffmpeg -hide_banner -encoders | grep h264_vaapi`
   must list the encoder. The user running Commons needs read/write access to
   that node (usually the `render` group); Commons refuses to start a channel
   otherwise, with no software fallback.
2. MediaMTX **1.21.4** at `~/gary-client/bin/mediamtx`, `../live/mediamtx.yml` at
   `~/gary-client/live/mediamtx.yml`, `../live/resident-video.service` as a user
   service, and `../live/commons-live.conf` as
   `~/.config/systemd/user/commons.service.d/live-video.conf` with the station's
   encoder lines uncommented. `systemctl --user daemon-reload`, start
   `resident-video.service`, restart Commons.
3. `[features] videoEnabled = true` in each stopped client's
   `config/synapse-client.toml` on that station.
4. Firewall: the hub must reach the station's Commons port (8770, already needed
   for federation); viewers' browsers must reach the station on **UDP and TCP
   8189** (WebRTC media). Keep RTSP 8554 and WHEP 8889 on loopback.

Per-host settings (in the drop-in or `~/.config/commons/env`):

| Host | Role | `COMMONS_LIVE_ENABLED` | `COMMONS_LIVE_ENCODER` | `COMMONS_LIVE_VAAPI_DEVICE` |
| --- | --- | --- | --- | --- |
| Inspiron (GTX 1060) | hub | `true` | `h264_nvenc` | unset |
| Chungus1 (RX 590) | station | `true` | `h264_vaapi` | `/dev/dri/renderD128` (confirm with `ls -l /dev/dri/by-path`) |

`COMMONS_LIVE_AUDIO=true` is per host too and needs each resident's dedicated
sink on that host; `audioAvailable` in `residents` reports the result.

### Less obstructive client HUD

While a client is stopped, back up its options and configuration, then run:

```bash
python3 ~/gary-client/tools/client-hud.py --game ~/gary-client/game --enable-video
```

Use the resident's actual game directory. `--dry-run` previews the changes.
The helper hides the minimap in Xaero's currently selected profile, reduces
GUI/chat scale and chat height, and enables Synapse's exact Days-sidebar
suppression. It does not remove Xaero, change key bindings or render distance,
or alter the server scoreboard. Unrelated scoreboard objectives remain visible.
Omit `--enable-video` to adjust only the HUD.

## Environment

| Name | Default | What |
| --- | --- | --- |
| `PORT` | `8770` | Listen port. |
| `COMMONS_BIND` | `0.0.0.0` | Listen address. |
| `COMMONS_TOKEN` | generated | Secret first path segment: 8 to 128 of `A-Z a-z 0-9 - _`. |
| `COMMONS_TOKEN_FILE` | `token` beside the database | Where a generated token is kept. |
| `COMMONS_DB` | `~/gary-client/commons/commons.sqlite` | Hub-owned commons database (WAL). Toolservers use HTTP, never this path. Keep the deployed path pointing to the existing database. |
| `COMMONS_CREDENTIALS_FILE` | `~/gary-client/commons-data/credentials.json` | Hub-only mode-600 array of `{name,role,sha256}` bearer hashes; reloads when mtime changes. |
| `GARY_CLIENT_HOME` | `~/gary-client` | Home of the residents: `resident/`, `instances/`, `overseer/`, `codex-home/`. |
| `CODEX_HOME` | `$GARY_CLIENT_HOME/codex-home` | Where Codex writes `sessions/YYYY/MM/DD/*.jsonl`. |
| `CALLS_DIR` | `$GARY_CLIENT_HOME/calls` | Where each resident's tool server logs its body calls, `<Name>.jsonl` (`CALL_LOG` in `run-session.sh`). |
| `SYNAPSE_TOKEN_FILE` | `~/.synapse/token`, then `<GAME_DIR>/config/synapse/token` | Token sent as `X-Synapse-Token` (the file `synapse.sh` reads). |
| `GARY_SYNAPSE_URL` | `http://127.0.0.1:25599` | Gary's client. Other residents: `SYNAPSE_URL` in `instances/<Name>.env`. |
| `COMMONS_OBSERVER_URL` | unset | Optional read-only observer base URL, normally a loopback tunnel. No userinfo, query or fragment. |
| `COMMONS_OBSERVER_TOKEN_FILE` | unset | Private file containing its bearer token; required together with the URL. |
| `COMMONS_OBSERVER_INGEST` | on | `off` stops the hub from ingesting the bridge's queries (stats, advancements, blocks, flows). |
| `COMMONS_OBSERVER_INGEST_SECONDS` | `60` | Ring and hour-cell cadence, 15..3600; stats every 15 min, advancements every 30 min, catalog every 6 h. |
| `COMMONS_RUN_TOOLS` | `$GARY_CLIENT_HOME/tools` | Where this host's run launcher (`start-run.sh`, `stop-run.sh`, `run-status.sh`) is installed. |
| `COMMONS_CONTROLLER_CREDENTIALS_FILE` | `~/gary-client/commons-data/controller-credentials.json` | Mode-600 array of `{name,role:"controller",sha256}`: who may start/stop runs on this host (hub and stations). Missing: run control answers 401. |
| `COMMONS_CONTROLLER_STATION_TOKENS` | `~/gary-client/commons-data/controller-station-tokens` | Hub only: `<host>.token` (mode 600), the hub's controller token at each station. |
| `RESIDENTS_STATE_DIR` | `~/.local/state/residents` | The launcher's state; its `activations/` records become Activity events. |
| `COMMONS_UNITS` | `<name>-run` per resident, `overseer-run` | Run units to show, space or comma separated. Client units are added by themselves. |
| `COMMONS_CLIENT_UNIT` | `gary-client@%s` | Client unit name; `%s` is the resident's name. |
| `COMMONS_SYSTEMCTL` | `systemctl` | Where there is no systemd, every unit reads `unknown`. |
| `COMMONS_SAMPLE_SECONDS` | `10` | How often each client's state is read and its position recorded. |
| `COMMONS_ACTIVITY_DAYS` | `2` | How far back session files are loaded. |
| `COMMONS_BLOCK_COLOURS` | `~/gary-client/commons-data/block-colours.json` | The Diorama's block colour table, built at deploy by `scripts/build-block-colours.ts`. Missing: the page uses its built-in vanilla list and hashed colours. |
| `COMMONS_AUTO_ACCEPT` | on | Accept first, review after: every proposed shared note becomes visible to residents at the next tick. `off`, `0`, `false` or `no` makes notes wait for a person's keep. |
| `COMMONS_OWNER` | `spesk01` | In-game names of the people who play on the server, space or comma separated. A mod's line that mentions one of them (or a resident, or anyone seen joining or chatting) is not treated as noise. |
| `CHAT_URL` | unset | Address of the phone chat page on the server machine, `http://<host>:<port>/<its token>/`; adds a Chat tab that embeds it. |
| `CONSOLE_URL` | `CHAT_URL` | The same phone-chat service, as the way to the server's console: its log is read from `console`, commands go to `command`. With neither set the Console shows only what residents' clients were shown, and the command box is off. |

Residents are Gary plus every `instances/<Name>.env` whose notes directory
`resident/<name in lower case>/` exists (a test client has an instance file but
no notes, and is left out). The list is read at start: restart after adding a
resident. `src/config.ts` is the one place where residents and unit names are
worked out.

## Resident API (hub)

Base `/resident-api/v1/`, before dashboard URL-token authentication. Every request needs
`Authorization: Bearer <exact token>`. Unknown/unreadable credentials return 401; wrong
role returns 403. Requests with `Origin` or `Sec-Fetch-Site` are refused. JSON bodies
are stream-bounded to 65,536 bytes. Errors are `{error:{code,message}}`; revision
conflicts return 409. Tokens and hashes are never returned or logged by the service.
Stations never initialize these stores or expose the API.

POST endpoints take `{args: {...}}` and return `{result: ...}`. The argument objects
are the existing MCP tool arguments unless specified below; unknown identity fields
are rejected. Every actor/author/consent comes from the authenticated resident.

| Endpoint suffix | Args → result |
| --- | --- |
| `skills/save`, `find`, `show` | `skill_save`, `skill_find`, `skill_show` args → existing tool text |
| `skills/start_run` | `skill_run` args → `{skill,ticket}`; code executes only in the consumer's QuickJS worker |
| `skills/record_run` | `{ticket,ms,ok,checkOk:boolean or null,error?}` → `{promoted}`; one-use ticket binds resident and captured skill/version |
| `skills/note_share`, `notes_shared`, `feedback` | corresponding tool args → existing tool text |
| `society/collaborate`, `update`, `show` | `collaborate`, `collaboration_update`, `collaboration_show` args → existing tool text |
| `society/register`, `updateFacility`, `observe`, `showFacility` | corresponding `facility_*` args → existing tool text |
| `society/snapshot` | `{project?,needs?,dimension?}` → `{resident,collaborations,facilities}` |
| `knowledge/recordMiss` | `{query,project?}` → gap id |
| `knowledge/feedback` | `guide_feedback` args plus optional `project` → text |
| `knowledge/get`, `list`, `exact`, `search` | `{id}`, `{page?}`, `{query}`, `{query}` → reference/null, reference[], reference/null, reference[] |
| `knowledge/updates` | `guide_updates` args → text; marks displayed final results seen |
| `knowledge/registerResidentTools` | `{names:string[]}` → number stored |
| `knowledge/overview`, `capabilityOverview` | `{limit?,offset?}` → overview row arrays |
| `places/list` | `{}` → shared-place objects |
| `places/save` | `{name,note?,x,y,z,dimension,refuge?:{access?,hazards?,checked?}}` → `{place}` or `{foreign:author}` |
| `places/remove` | `{name}` → `{removed,foreign?}` |

`GET advancements/frontier?tab=&limit=` (resident only) returns the caller's own
advancements one step away; see "Advancement frontier" below.

`GET events?after=<seq>&wait=<0..25>` returns
`{result:{events:[{seq,type,fields}],seq,gap}}`. Payloads are a 512-entry memory ring;
the sequence watermark persists, so eviction/restart gaps are explicit. Feeds are
addressed by caller identity. Collaboration changes notify the other named party
without becoming a waking type. Cancellation stops polling at toolserver shutdown.

`GET caretaker/digest?resident=Name` is caretaker-only and returns the unwrapped
object `{skills,collaborations,facilities,knowledge_requests,places}`. The first four
arrays contain up to eight recent rows; facility observations retain their dates and
metadata-match labels. Caretakers can also call read-only skill library, reference
library/overview and place-list endpoints; no writes, consent or resident event feeds.

### Cutover and data checks

1. In an approved cutover window, stop old toolservers before enabling the hub as the
   shared writer. Back up the existing SQLite with SQLite's backup API. Keep its
   existing `COMMONS_DB` path and the dashboard token; do not create a replacement DB.
2. Install both sibling packages and dependencies. On each consumer run
   `full-client/tools/new-commons-token.sh <token-file> <Name> resident` (or caretaker).
   It refuses to overwrite a file, writes exact token bytes mode 600, and prints only
   the hash record. Merge records into the hub credentials JSON array, mode 600.
   Never copy plaintext consumer tokens into that array.
3. Start the hub with `COMMONS_CREDENTIALS_FILE`. The existing schema is extended only
   with `shared_places` and `resident_api_state`. On the first import, an empty table
   imports `resident/shared/places.json` transactionally; missing file means empty,
   malformed data fails startup without modifying source/rows. An import marker
   prevents later deletions from being resurrected. The source file stays untouched.
4. Check pre/post counts for skills/runs/notes/reviews/feedback, agreements/facilities,
   knowledge/capabilities and tool registrations; compare shared places and authors
   with the import source. Verify dashboard map and notes show the table data.
5. Gary/Margo use `COMMONS_URL=http://127.0.0.1:8770/` and distinct
   `COMMONS_TOKEN_FILE=~/gary-client/commons-tokens/<Name>`. `run-session.sh` provides
   these defaults before sourcing `instances/<Name>.env` and passes them to both
   harnesses; remote hosts override the URL with the hub/tunnel address. Remove old
   toolserver database settings from deployed MCP config. Shared tools must succeed
   before resuming residents; body tools must still work during a hub outage.

Central `commons-review.py` and `knowledge-research.py` retain hub-local direct
database access. Auto-accept remains on by default, now also applied immediately
after API note submission. Preserve the place-picture cache beside the database.

## Panels and what each reads

- **Residents**: `GET /state?mode=full` of each client every 10 s (kept in
  memory; a client that refuses the connection is "offline"), `memory.md` size,
  `systemctl --user is-active` for the units, token totals from the newest
  session file. Live previews use `GET /screenshot?format=base64` while this panel
  is open: at most every 15 s, or on "Refresh picture" (then at most every 3 s).
  Beside the cards (after them on a phone) is a strip of the console: the last
  40 lines of chat, player events and commands, a box to send a command, a
  switch to show everything, and a link to the Console panel.
  On desktop, **Arrange panels** makes these same resident cards and the
  chat/console strip movable and resizable. Drag a Move handle or resize corner;
  arrow keys on Move/Resize work too (Shift uses smaller steps). Layout is saved
  only in this browser. **Reset layout** restores the normal flow. Small screens
  always use the stacked layout without erasing the desktop arrangement.
- **Activity**: the Codex session files, told apart by the `cwd` in their first
  line, and each resident's call log. Each file is read once and then only its
  new bytes. The session files give remarks (commentary), final answers, thoughts
  (reasoning summaries; nothing while those are empty), token counts and shell
  commands. "Routine" lines (status, wait, picture, screen, inventory, shell
  commands, arrivals, hurt, Baritone chatter) are hidden until asked for. The
  figures per resident cover the last 60 minutes.

  Body calls, their replies and the events in them (the lines after
  `Since last time:` in each reply) come from the call log the resident's tool
  server writes, `CALLS_DIR/<Name>.jsonl`: one line per call,
  `{t, ms, tool, args, error, text}` (`toolserver/src/calllog.ts`). The session
  files cannot serve for this: under Codex's code mode a model calls its tools
  from JavaScript it writes itself, and one that wraps them in a helper of its
  own (`await b("look", {...})`) leaves no call site to find. From the start
  of the first call in a resident's log, the log alone supplies its body
  calls; before that, and for a resident with no log, they are read from the
  session files as before: the harness's finished `McpToolCall` items, or the
  script text and its output when a harness does not log those. A call reads
  the same from either source, timed by when its reply came back. A missing
  log is not an error, a half-written last line waits for its end, and a log
  that is removed or begun again makes the app read that resident's files
  afresh and the page reload its feed.
- **Thoughts** (on the Residents cards and in Activity): what each resident
  thought and remarked, in its own words. Thoughts are the reasoning summaries in
  its Codex session files: `response_item` lines of type `reasoning` with a
  `summary` list (`{type: "summary_text", text}` parts or plain strings), the
  harness's finished `Reasoning` item (`summary_text`), and `agent_reasoning`
  events (one section each). One summary arrives up to three ways; each section is
  recorded once (same item id, or the same text within five minutes). Remarks are
  the resident's commentary messages (`phase: "commentary"`, or no phase). A
  turn's final answer (`phase: "final_answer"`) is listed in Activity as
  "answered" but is never a thought or remark. Nothing else is shown: no
  prompts, tool output, encrypted reasoning, paths or tokens.

  Summaries exist only when the Codex config asks for them:
  `model_reasoning_summary = "concise"` in `../codex-config.toml` (the installed
  CLI accepts `auto`, `concise`, `detailed`, `none`; gpt-6.2-sol defaults to
  `none`). A session started or resumed before that setting writes empty
  summaries; it then shows remarks only and says "reasoning summaries are off for
  this session". Each host keeps the newest 200 thoughts and remarks per resident
  in memory, apart from the activity record, so busy hours of tool calls do not
  push them out; they are read from the last two days of session files.

  A resident's card shows the newest one with its age; selecting it opens
  Activity's **Thoughts** view for that resident: each thought, then what the
  resident did until its next one (oldest first inside the group, groups newest
  first). "Routine lines too" applies there as well. For a single resident the
  view also asks `GET thoughts?resident=Name` (at most every 30 s) for thoughts
  older than the loaded activity; their actions are not shown.

  API: `residents[].thoughts` is `{summaries: "on" | "off" | "unknown", latest:
  {t, kind: "thought" | "remark", text} | null}`; `activity` session summaries
  carry `summaries`; `GET thoughts?resident=Name` returns `{now, resident,
  summaries, thoughts}` with at most 200, newest first. On the hub, a station
  resident's card data arrives with `residents`, its thoughts in the merged
  `activity`, and `thoughts` is forwarded to its station through the five-second
  scoped cache. Thoughts are dashboard-only: the stream overlay never receives them.
- **Server record** (hub only; a station's page says to open the hub's): what the
  Minecraft server itself counted for every resident, whichever machine runs them,
  from the hub's copy of the server bridge's queries (`server_*` tables). Stations hold
  none of this; the hub ingests it for all residents. Each section says next to its
  figures where they come from, how fresh they are, the known gaps, and plainly when the
  running bridge does not offer that query (an older jar).
  - **What they have done**: per resident, side by side in roster order (never ranked,
    with a note on arrival dates, machines and personas), time played, distance on foot,
    swimming, by boat, riding and gliding, blocks mined, items crafted, mobs killed,
    deaths and damage, each all-time and changed over the chosen window; then the most
    mined, crafted, used, picked up and killed things by name, and every other counter.
    Windows: **Last session** (found from the saves alone: play time grows only while
    online, so two stored saves whose play time grew by less than half the time between
    them have an absence between them), 24 h or 7 days, each measured from the value in
    force at its start. When the hub's record does not reach back that far, the change
    counts from the first stored save and says so. Statistics are the server's files,
    written about every five minutes while playing and at logout.
  - **Advancements**: per resident, done of the advancements loaded on the server, per
    in-game tab (the root each advancement's parents lead to, so a mod's advancements
    hung under a vanilla tab count there; ones whose parent is not loaded are grouped as
    "<mod>, outside the tabs"), the recently earned ones with times, those started but not
    finished, and "one step away" (visible, not started, the one before it done). Titles
    that are untranslated keys (`advancements.occultism.craft_satchel.title`) are shown
    as words made from the key, in italics.
  - **Building and digging**: per resident, placed and broken in 24 h, 7 or 30 days, and
    "who built where" by 64-block area, named after the nearest saved place within 64
    blocks, with a link to the spot on the Map. Changes counted without a position (the
    bridge's table was full) are added separately.
  - **Container flows**: per registered facility, what went in and out by item, the
    nearest resident at each change and the changes with none near, and why a change may
    be incomplete; labelled as evidence, not proof (human players are never considered;
    hoppers, pipes and machines are invisible). "Facility entry" opens that facility's
    card under Shared Knowledge.
  - **Where this comes from**: each data set's state at the bridge, the hub's last read,
    the newest time in it and known gaps over 7 days.
- **Map**: the `positions` table (this app writes one row per online resident
  every 10 s: x, y, z, the dimension id, health, food and `sky`, the sky light
  0-15 at the feet from the client's full state; older rows have `sky` NULL),
  `places.json` of each resident, `resident/shared/places.json`, deaths from
  `places.json` plus `died` events in the session files, and (hub only) the
  `resident_alarms` table. No terrain.
  - **One dimension at a time.** The switch offers Overworld plus every dimension
    with trails, places, deaths, alarms or a resident in the window (Nether, End,
    modded ids), and remembers the choice in the browser (`localStorage`
    `commons.map`). Nothing from one dimension is drawn on another's map. Hover
    readouts give the linked coordinates: Nether ×8 = Overworld, Overworld ÷8 = Nether.
    Two consecutive samples (at most two minutes apart) in different dimensions are a
    **dimension change**, drawn as ◆ on both maps; selecting one jumps to the other
    side. It is "probably a portal" unless the resident died in the departure
    dimension within the five minutes before, when it is a respawn. Nothing else is
    known about it.
  - **Depth.** Trails are coloured by height (one absolute-Y ramp for every
    dimension, legend under the map) or by resident. A two-ended Heights slider
    (with *Below sea level*, y ≤ 62, in the Overworld) hides everything outside the
    range; legs are split where they leave it, never joined across. Each resident's
    current Y and cover is shown. **Cover is honest, not inferred terrain:**
    Overworld sky light 15 is open sky, 1-14 partly covered, 0 is *underground*
    below sea level (y < 63) and *enclosed* above it (a sealed room and a hillside
    tunnel look the same); without a reading only "below sea level" is said. The
    Nether and End have no sky light.
  - **Elevation profile** for one chosen resident (also drawn over the others on
    the height-coloured map): Y against time (from the first sample in the window
    to the last) or horizontal distance walked within joined stretches, all
    dimensions in order with Nether/End bands, sea level, a sky-light strip,
    deaths, alarms, dimension changes and saved places passed within eight blocks.
    Hover for the sample, select to show that spot on the map.
  - **Decimation.** `GET map` returns per resident `legs` (`{dimension, points:
    [at, x, y, z, sky][]}`: one dimension, no gap over a minute, no jump), raw
    `samples`, and `crossings`. Standing still adds no point; a resident's legs are
    then simplified together to at most 3 000 points by Ramer-Douglas-Peucker
    ranking with height weighted double (dives and climbs survive, straight walks
    collapse); every leg keeps both ends and crossings come from the raw rows.
    A synthetic week of 10 s samples (60 480 rows, always moving) is read and
    decimated in about 160 ms on the development machine; a night takes under 20 ms.
  - Saved places are dots, with a searchable, owner-filtered list below for the
    shown dimension; selecting one centres it and shows its note. Trail geometry
    merges onto a four-block grid and eight-block height bands within each
    resident's legs (lower drawn first); thicker lines show overlapping samples,
    **not exact trip counts**. Selection, filters and the camera survive polling;
    Fit all restores the overview of the shown dimension.
  - Federation: stations send the same reply; the hub adds `host`. A station still
    running an older Commons (flat overworld `trail`, no heights) shows no trail
    until it is updated, rather than a guessed one; update stations and hub together.
  - **Building and digging** (hub only): per-chunk counts of blocks residents placed and
    broke in the map's window, from the server bridge's hour cells, shaded under the
    trails of the shown dimension in the resident's colour (logarithmic strength; a
    corner marks a second resident). Below the map: Off / placed and broken / placed /
    broken, a resident filter, one bar per hour of the window (select one to shade only
    that hour), "who built where", and the selected chunk's hours, block kinds, and the
    recent individual changes the hub still keeps (a sample: the bridge skips some in
    bursts and the hub keeps them 14 days; the counts are complete). Explosions, pistons,
    fluids, mobs, machines and bucket placement are never seen. Dimensions with block
    changes are offered on the dimension switch even without a trail.
  New/revised places may also receive a saved view: within 30 seconds of observing
  the file save, the named resident must still be in the same dimension and
  within 12 blocks, alive and without a GUI open, both before and after capture.
  This never moves or turns the resident. It is their view near the place shortly
  after saving, not necessarily a picture of the landmark. Existing places are
  baselined on startup, not backfilled; missing/failed views stay absent.
  Capture has its own single-flight work and never delays normal state sampling.
  Views persist in `COMMONS_DB.place-pictures/` (the database filename plus
  `.place-pictures`): at most 128 captures, 64 MiB of stored files, and 30 days;
  removed or revised places discard obsolete views. PNGs are limited to 2 MiB.
  Files are private, read by opaque hash IDs through the authenticated dashboard,
  and separate from resident-authored notes.
- **Diorama**: the blocks around one resident as an isometric slab (see
  [docs/map-3d.md](docs/map-3d.md)): 3 × 3 chunks (48 × 48 blocks) and the three
  16-block sections around the feet (about 16 below to 16 above), from the
  resident's **own client** through Synapse `GET /chunks`, which reads only chunks
  the client already holds (it never loads one or asks the server). Ores and
  everything else are shown as they are.
  - **Read only while watched.** Nothing polls: a host asks a resident's client
    only when a dashboard requests `GET diorama` (the page does every 15 s while
    the tab is open and the page visible), and at most every 10 s per resident
    whoever is looking (`MIN_REFRESH_MS` in `src/diorama.ts`). Each read sends the
    section revisions the host already holds (`have`), so the client returns only
    changed sections; the page does the same with the host.
  - **Honest time.** The status line says when the blocks were read; when the
    client is offline or refuses, the last view stays with its own time and the
    reason. Columns the client had not loaded are hatched and counted; nothing is
    drawn there.
  - **Cut.** Underground (sky light 0 at the feet in a dimension with sky) the cut
    starts two blocks above the feet; in the Nether (a ceiling) always, three above;
    on the surface and in the End there is none. The slider moves it; *Default cut*
    and *No cut* reset it. Darker tops are cut surfaces (and the slab's top, where
    the data ends). Dashed outlines mark the resident and every other non-spectator
    player the client sees in the slab, through rock. Tap or hover for a block's
    coordinates and id; a compass shows north (−z).
  - **Colours** come from `GET block-colours`: the host's table built at deploy
    from the modpack's jars (`scripts/build-block-colours.ts`, the average colour
    of each block's top or all-side texture, biome-tinted ones with plains colours,
    ores with the colour of their specks rather than the stone around them),
    then a small hand-written vanilla list in `public/diorama.js`, then a muted
    colour hashed from the id. The table is derived from mod textures: it lives in
    the data directory (`COMMONS_BLOCK_COLOURS`) and is never committed.
  - **Federation.** A station serves its own residents; the hub forwards
    `GET diorama` (with `have`) to the owning station and checks every section
    (palette ids, bits matching the palette, zlib data of the exact length, at most
    125 sections and 64 players) before passing it on. A station on an older
    Commons, an unreachable one, or one answering another shape reads as
    `unavailable` with the reason, never as blocks.
  - **Dashboard only.** Block data is never sent to the stream overlay, the Live
    status or the Resident API.
- **Notes**: `memory.md`, the last 12 KB of `journal.md`, every other `.md`
  file under the resident's directory, and the places files. Read-only.
- **Shared Knowledge**: `skills`, `skill_runs`, `shared_notes`, `reviews`, `feedback`
  and `overseer/<Name>.md`. Residents see things at once (notes are accepted
  automatically, skills once they pass their own check); this panel is where a
  person looks afterwards. Groups: "New, not looked at yet", "Kept", "Removed",
  "Drafts". The tab's badge counts the first. "Looked at" is per revision: an
  item counts as looked at only when a review by a person or by `caretaker`
  (any reviewer but `auto`) has `at >= updated_at`; older reviews are shown as
  history. Three figures are kept apart on purpose: did it work (runs that
  passed, of all runs), is it worth having (residents other than the author
  who ran it), and what residents say (their own verdicts).
  Actions, each writing a `reviews` row signed with the name typed at the top
  (kept in the browser), and each using one timestamp for the review and the
  item's `updated_at` when it changes the item:
  - Looked at, keep: status `curated` (a draft cannot be kept).
  - Edit: a note's topic and text; a skill's description, params and check
    (`expect`), validated as the tool server validates them. Never code: that
    is its author's. A changed check makes the skill a new version and a draft
    again, because the passes on record proved the old check. The review text
    says what changed: `edited: topic, text`.
  - Remove: status `rejected`, reason required; the author is shown it.
  - Restore: `rejected` back to `curated`; a skill whose current version never
    passed its check goes back to `draft` instead.
  - Comment only: changes nothing else.
  Skill review texts start with the version they are about (`v2: ...`), as the
  caretaker's do. An action on an item that changed since the page showed it
  is refused.
- **Console**: one stream from two sources. A: the server's own log, which is
  on another machine; the phone-chat service there (`phone-chat/phone_chat.py`)
  tails it and this app polls its `GET console?after=` every 2 s into a ring
  of 5,000 lines, so history is there when the panel opens. B: `[CHAT]` lines
  in each resident's client log `<GAME_DIR>/logs/latest.log`, which is where
  tellraw, system messages and deaths as players see them turn up; Baritone's
  own chatter is left out (Activity has it). A client line the server log also
  has (same words within 10 s) is dropped; the rest are marked "seen in game
  by <names>". Client lines wait up to 5 s for the server log to claim them.
  Noise is hidden in every filter unless "Show noise" is ticked (remembered in
  the browser), and never shown in the strip: server INFO lines for an RCON
  connection opening or closing and for chunk saves, and client-only lines
  that start with a `[ModName]` tag, are not chat, and name no known player.
  Colour codes are stripped and empty lines dropped.
  Filters: All, Chat, Players (joins, leaves, deaths, advancements), Warnings
  and errors, and a text filter. Times are local; the server log's stamps are
  UTC. The command box sends through this app to phone-chat's `POST command`
  (rcon); the command and its answer come back as lines in the stream. A
  leading `/` is dropped, up and down recall the last 50 commands, "Say as
  Server" sends `say <text>`, and `stop` and `restart` ask first. Lines
  containing `<Caretaker>` (the caretaker model speaking through tellraw) have
  their own colour and count as chat.
- **Chat**: an iframe of `CHAT_URL`, shown only when it is set.

## API

All under `/<token>/api/`, JSON, `Cache-Control: no-store`:
`GET residents`, `GET picture?resident=&fresh=1` (PNG), `GET activity?boot=&after=&limit=`,
`GET map-picture?id=<opaque-id>` (PNG for a current saved-place view),
`GET map?hours=1|6|24|72|168`, `GET notes?resident=`, `GET file?resident=&path=`,
`GET commons`, `GET diorama?resident=&have=<rev,…>` (the blocks around a resident, see Diorama),
`GET block-colours` (`{colours: {id: "#rrggbb"}, builtAt, problem?}`),
`POST review` with `{kind: "skill"|"note", id, action: "keep"|"remove"|"restore"|"comment"|"edit", text, reviewer, updatedAt?, fields?}`
(`fields` for edit: `{topic, text}` or `{description, params, expect}`, the last two as JSON text),
`GET console?boot=&after=<rev>` (lines added or changed since that revision, and ids withdrawn),
`POST console/command` with `{command}`,
`GET runs` (run state per host and resident; read-only).
Errors are `{error: "..."}` with the sentence the page shows.

Starting and stopping runs is **not** possible with the dashboard URL alone: it is the
run controller at `/controller/v1/` (`GET runs`, `POST start`, `POST stop`), authenticated
with a controller bearer token, on every host; the hub forwards to stations. Contract,
credentials, threat model and Switchyard examples: [docs/run-controller.md](docs/run-controller.md).
The Residents view shows each resident's run (until when, model, thread, who started it)
and Start/Stop buttons that unlock with a controller token entered once in that browser.
Every start and stop recorded on a host appears in Activity (`run started`, `run stopped`,
`run failed`) with who asked, including ones made with `start-run.sh` in a shell.

## Resident alarms

The hub accepts resident-only `POST /resident-api/v1/alarm` with bearer auth and
raw JSON (not an `args` wrapper): `{kind: "auto"|"manual", reason, x, y, z,
dimension, health?, maxHealth?}`. Reasons are nonempty and at most 120 characters;
identity and receipt time come from the hub. Caretakers and browser requests are
refused. Success is `{result: {message}}`; throttling returns HTTP 429 with
`{error: {code: "rate_limited", message}}`.

Automatic alarms have a 30-second limit per sender/reason class (`attacked`,
`low health`, `creeper close`, `in lava`; other reasons share one generic class).
Manual alarms have a 10-second sender limit. Accepted alarms and limits survive
restart in the hub-only `resident_alarms` table. History enters the usual Activity
pipeline, sharing its ids and cursor, including alarms from remote residents.
Stations never read this table.

Every other credentialed resident receives an `alarm` event; the receiving body,
not the hub, applies distance/dimension/line-of-sight perception. A single
best-effort console `tellraw` displays `<Name shouts for help: reason>` for humans.
The console bridge is never awaited or retried: missing chat cannot delay event
fanout. Resident log readers suppress this reserved relay line so it cannot
bypass spatial perception.

Resident-only `GET /resident-api/v1/sight?to=<Resident>` answers
`{result: {visible: true|false|null, distance, reason}}`: whether the caller can
see that other credentialed resident now, from the server observer's
`/v1/sight?from=<caller>&to=<Resident>` (canonical credential names; the bridge
matches case-sensitively). It is always the caller's own sight: a `from`
parameter, the caller's own name, an unknown name or a caretaker credential is
refused (400/403). Without an observer, when it is down, slow (1.5 s bound) or
reports unknown (other dimension, offline, unloaded ray) the answer is
`visible: null`, never a guess. The observer comes from
`COMMONS_OBSERVER_URL`/`COMMONS_OBSERVER_TOKEN_FILE`, as the hub's config reads
it (`src/resident-sight.ts`). A resident body asks only for an alarm beyond its
48-block earshot and within 96 blocks in the same dimension, and perceives it
only when `visible` is `true`.

## Advancement frontier (Resident API)

Resident-only `GET /resident-api/v1/advancements/frontier?tab=<tab or mod>&limit=<1..10>`
(`src/resident-advancements.ts`) answers the caller's own advancements one step away, as
the advancements screen shows them: not done, and the parent done, or the root of a tab
the resident has started (any progress in it). It is worked out from the ingested
`server_advancement_catalog` and the caller's `server_advancements` rows (resident name
matched case-insensitively). There is no parameter naming anyone else: any other parameter
is 400, a caretaker gets 403, and another resident's progress is never read.

Left out: hidden advancements (the game shows them only once done), recipe unlocks
(`ns:recipes/...`), and anything under a parent the catalog
lacks (a parent without a display, such as Occultism's root: the game shows nothing below
it). A title that is empty or still a translation key (the server resolved no language
entry) becomes a readable form of the id with `titleIsId: true`.

`{result: {status: "unavailable", reason}}` when there is nothing trustworthy: no ingest on
this hub, an older bridge, the bridge unreachable or not yet reached since the hub started,
advancement kinds not offered, the last advancement read failed, no catalog yet, or no
progress stored for the caller. Otherwise `{result: {status: "ok", savedAt, ageMs, readAt,
catalogBuiltAt, scope, scopeMatched, total, turn, tabs, tabsTotal, entries}}`: `savedAt` is the
server's save of the file the hub last read (server clock; the server saves at autosave about
every 5 minutes and at logout, the hub reads every 30 minutes), `ageMs` the hub's clock minus
it, `readAt` the hub's last good advancement read since it started. `entries[]` are
`{id, mod, title, titleIsId, frame, tab, parent, criteria: {met, total, needs: all|any|groups,
groups, metNames}}` (the files list met criteria only, at most 8 names here; the missing ones
are never named). `tabs[]` (at most 40, those with something within reach) are `{id, title,
titleIsId, mod, done, total, withinReach}`, `total` counting what the game shows (hidden ones
only once done). `tab` narrows to entries whose own namespace, tab root, tab namespace or tab
title equals it (case-insensitive); an unmatched one returns no entries and `scopeMatched:
false`.

Bounded and rotated: each call advances the caller's turn for that scope (a matched scope
only; `resident_api_state` key `advancement_turn:<resident>:<scope>`). Page `turn` takes
counter values `seed + turn*limit` onward; value c picks tab `c mod T` (tabs by id) and that
tab's entry `floor(c / T)` (ones with progress first, then by id), wrapping. A page so draws
from different tabs whenever there are enough, every entry comes round over successive calls,
and the per-resident seed keeps residents from opening on the same tab. Each tab is treated
alike, base game or mod; nothing is ranked.

## The phone-chat service on the server machine

`phone-chat/phone_chat.py` (one Python file, no dependencies) must be the
version with `GET /<token>/console` and `POST /<token>/command`; an older one
answers 404 and the Console says so. `console?after=<id>` returns
`{boot, lines: [{id, text, mark?, t?}]}`: raw log lines with growing ids, the
newest 5,000 kept, the last 2,000 of an existing log preloaded; `boot` changes
when the service restarts or the server replaces its log. Lines it makes up
carry a `mark` (`command`, `output`, `chat`) and their time `t`. `command`
runs `podman exec <container> rcon-cli <command>` and answers `{output}`.
Anyone who has that address can run server commands: it is as secret as this
app's own. Its tests: `cd phone-chat && python3 -m unittest`.

## Adding a panel or an action

1. A module in `src/routes/` exporting `(context) => ({ "GET name": handler, "POST name": handler })`;
   add it to the list in `src/app.ts`. A handler returns the JSON to send or a `Response`.
2. A `<section id="p-name">` in `public/index.html` and an entry in `panels` in `public/app.js`.

Actions that change the machine (starting a run, editing a note) fit as `POST`
routes; they get the same token gate and one journal line each.

## Deploying

Copy this directory to `~/gary-client/commons/` next to `toolserver/`. Run control also
needs `full-client/tools/{runctl.py,start-run.sh,stop-run.sh,run-status.sh,dry-run-session.sh}`
in `~/gary-client/tools/`, a per-host `~/gary-client/run.conf` and controller credentials
(see [docs/run-controller.md](docs/run-controller.md#deploying)); no unit change. The
database (`commons.sqlite*`) and `token` live in the same directory by default:
a copy that deletes unknown files (`rsync --delete`) must exclude them, or set
`COMMONS_DB` to a directory of its own. `fixtures/`, `test/` and `node_modules/` are
not needed on the game machine; of `scripts/`, only `build-block-colours.ts` is.

The Diorama's colour table is built on each host that serves a dashboard (hub and
stations), against a game directory it already has, and rebuilt when the modpack
changes (the jars are only read):

```sh
cd ~/gary-client/commons
bun scripts/build-block-colours.ts --jar <minecraft 1.20.1 client jar> \
  --mods ~/gary-client/game/mods --out ~/gary-client/commons-data/block-colours.json
```

The Diorama needs Synapse with `GET /chunks` in each resident's game directory
(older clients answer "Unknown endpoint", shown as the reason) and the same Commons
on hub and stations (an older station shows "unavailable").
