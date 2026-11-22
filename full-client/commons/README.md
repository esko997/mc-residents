# Shared Knowledge

One page, opened from a phone or laptop on the home LAN, to watch the residents,
to look over their Shared Knowledge (skills and shared notes), and to
read and use the Minecraft server's console. It is the home base for running
the project, laid out so that panels and actions can be added. What it changes:
shared knowledge (reviews, edits, automatic acceptance of notes), and the server
through the commands typed into its console.

One Bun process, no build step, no dependencies at run time. It reads the game
machine's files and each client's Synapse API on loopback, and shares one SQLite
file, the commons, with the residents' tool servers (`schema.sql` here is the
authoritative schema; both sides apply it with `CREATE ... IF NOT EXISTS`).

The visible title and library tab are **Shared Knowledge**. Internal `commons`
paths, API routes, service name, database and existing bookmarks are unchanged.

## Run

    bun src/server.ts          # on the game machine, from ~/gary-client/commons
    bun run demo               # anywhere: made-up data, a stand-in client for Gary, Margo offline
    bun test && bun run typecheck   # needs `bun install` once (types and tsc only)

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
`portablemc==5.0.6`. Debian prerequisites: `python3-venv`, `libopenal1`.
`launch.sh` defaults to a 4 GiB Java heap; each `gary-client@` unit has a
5.5 GiB soft / 6 GiB hard memory cap and no swap. The shared `residents.slice`
caps the entire stack at 13 GiB (12 GiB soft), leaving memory for Debian/Xfce.
Install `full-client/residents.slice` in `~/.config/systemd/user/` and start
mind/caretaker transient units with `--slice=residents.slice`.
`GARY_CLIENT_JAVA`,
`GARY_CLIENT_HEAP` and `GARY_CLIENT_DISPLAY_BACKEND` can be set in the instance
environment. The optional `headless` backend requires Gamescope; Debian 13's
configured repositories do not provide it. The X11 backend requires a logged-in,
unlocked desktop even when user-service lingering is enabled; Inspiron's
Light Locker/idle sleep/DPMS are disabled for unattended operation.

Only `commons.service` is enabled persistently. Resident sessions and the
caretaker are started explicitly with `run-session.sh` / `overseer-loop.sh`;
the web app does not yet implement daily scheduling or pause/resume controls.

Every address is `http://<machine>:<PORT>/<token>/...`. A wrong or missing token
gets 404. `/<token>` redirects to `/<token>/`. The token is the only access
control, as with the phone chat page: keep the address to yourself and off
public networks. When `COMMONS_TOKEN` is not set, a token is made at the first
start, saved (mode 600) next to the database, and the full address is printed
once; later starts print only where the token file is.

## Environment

| Name | Default | What |
| --- | --- | --- |
| `PORT` | `8770` | Listen port. |
| `COMMONS_BIND` | `0.0.0.0` | Listen address. |
| `COMMONS_TOKEN` | generated | Secret first path segment: 8 to 128 of `A-Z a-z 0-9 - _`. |
| `COMMONS_TOKEN_FILE` | `token` beside the database | Where a generated token is kept. |
| `COMMONS_DB` | `~/gary-client/commons/commons.sqlite` | The commons database (WAL, shared with the tool servers). |
| `GARY_CLIENT_HOME` | `~/gary-client` | Home of the residents: `resident/`, `instances/`, `overseer/`, `codex-home/`. |
| `CODEX_HOME` | `$GARY_CLIENT_HOME/codex-home` | Where Codex writes `sessions/YYYY/MM/DD/*.jsonl`. |
| `CALLS_DIR` | `$GARY_CLIENT_HOME/calls` | Where each resident's tool server logs its body calls, `<Name>.jsonl` (`CALL_LOG` in `run-session.sh`). |
| `SYNAPSE_TOKEN_FILE` | `~/.synapse/token`, then `<GAME_DIR>/config/synapse/token` | Token sent as `X-Synapse-Token` (the file `synapse.sh` reads). |
| `GARY_SYNAPSE_URL` | `http://127.0.0.1:25599` | Gary's client. Other residents: `SYNAPSE_URL` in `instances/<Name>.env`. |
| `COMMONS_UNITS` | `<name>-run` per resident, `overseer-run` | Run units to show, space or comma separated. Client units are added by themselves. |
| `COMMONS_CLIENT_UNIT` | `gary-client@%s` | Client unit name; `%s` is the resident's name. |
| `COMMONS_SYSTEMCTL` | `systemctl` | Where there is no systemd, every unit reads `unknown`. |
| `COMMONS_SAMPLE_SECONDS` | `10` | How often each client's state is read and its position recorded. |
| `COMMONS_ACTIVITY_DAYS` | `2` | How far back session files are loaded. |
| `COMMONS_AUTO_ACCEPT` | on | Accept first, review after: every proposed shared note becomes visible to residents at the next tick. `off`, `0`, `false` or `no` makes notes wait for a person's keep. |
| `COMMONS_OWNER` | `spesk01` | In-game names of the people who play on the server, space or comma separated. A mod's line that mentions one of them (or a resident, or anyone seen joining or chatting) is not treated as noise. |
| `CHAT_URL` | unset | Address of the phone chat page on the server machine, `http://<host>:<port>/<its token>/`; adds a Chat tab that embeds it. |
| `CONSOLE_URL` | `CHAT_URL` | The same phone-chat service, as the way to the server's console: its log is read from `console`, commands go to `command`. With neither set the Console shows only what residents' clients were shown, and the command box is off. |

Residents are Gary plus every `instances/<Name>.env` whose notes directory
`resident/<name in lower case>/` exists (a test client has an instance file but
no notes, and is left out). The list is read at start: restart after adding a
resident. `src/config.ts` is the one place where residents and unit names are
worked out.

## Panels and what each reads

- **Residents**: `GET /state?mode=full` of each client every 10 s (kept in
  memory; a client that refuses the connection is "offline"), `memory.md` size,
  `systemctl --user is-active` for the units, token totals from the newest
  session file, and `GET /screenshot?format=base64` only while this panel is
  open: at most every 15 s, or on "Refresh picture" (then at most every 3 s).
  Beside the cards (after them on a phone) is a strip of the console: the last
  40 lines of chat, player events and commands, a box to send a command, a
  switch to show everything, and a link to the Console panel.
- **Activity**: the Codex session files, told apart by the `cwd` in their first
  line, and each resident's call log. Each file is read once and then only its
  new bytes. The session files give remarks (assistant messages), thoughts
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
- **Map**: the `positions` table (this app writes one row per online resident
  every 10 s), `places.json` of each resident, `resident/shared/places.json`,
  and deaths from `places.json` plus `died` events in the session files.
  Overworld only, no terrain.
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
`GET map?hours=1|6|24|72|168`, `GET notes?resident=`, `GET file?resident=&path=`,
`GET commons`,
`POST review` with `{kind: "skill"|"note", id, action: "keep"|"remove"|"restore"|"comment"|"edit", text, reviewer, updatedAt?, fields?}`
(`fields` for edit: `{topic, text}` or `{description, params, expect}`, the last two as JSON text),
`GET console?boot=&after=<rev>` (lines added or changed since that revision, and ids withdrawn),
`POST console/command` with `{command}`.
Errors are `{error: "..."}` with the sentence the page shows.

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

Copy this directory to `~/gary-client/commons/` next to `toolserver/`. The
database (`commons.sqlite*`) and `token` live in the same directory by default:
a copy that deletes unknown files (`rsync --delete`) must exclude them, or set
`COMMONS_DB` to a directory of its own. `fixtures/`, `test/`, `scripts/` and
`node_modules/` are not needed on the game machine.
