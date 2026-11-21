# Commons

One page, opened from a phone or laptop on the home LAN, to watch the residents
and to review what they put in the commons (skills and shared notes). It is the
home base for running the project: read-only today except for review verdicts,
and laid out so that panels and actions can be added.

One Bun process, no build step, no dependencies at run time. It reads the game
machine's files and each client's Synapse API on loopback, and shares one SQLite
file, the commons, with the residents' tool servers (`schema.sql` here is the
authoritative schema; both sides apply it with `CREATE ... IF NOT EXISTS`).

## Run

    bun src/server.ts          # on the game machine, from ~/gary-client/commons
    bun run demo               # anywhere: made-up data, a stand-in client for Gary, Margo offline
    bun test && bun run typecheck   # needs `bun install` once (types and tsc only)

As a service: see `commons.service`.

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
| `SYNAPSE_TOKEN_FILE` | `~/.synapse/token`, then `<GAME_DIR>/config/synapse/token` | Token sent as `X-Synapse-Token` (the file `synapse.sh` reads). |
| `GARY_SYNAPSE_URL` | `http://127.0.0.1:25599` | Gary's client. Other residents: `SYNAPSE_URL` in `instances/<Name>.env`. |
| `COMMONS_UNITS` | `<name>-run` per resident, `overseer-run` | Run units to show, space or comma separated. Client units are added by themselves. |
| `COMMONS_CLIENT_UNIT` | `gary-client@%s` | Client unit name; `%s` is the resident's name. |
| `COMMONS_SYSTEMCTL` | `systemctl` | Where there is no systemd, every unit reads `unknown`. |
| `COMMONS_SAMPLE_SECONDS` | `10` | How often each client's state is read and its position recorded. |
| `COMMONS_ACTIVITY_DAYS` | `2` | How far back session files are loaded. |
| `CHAT_URL` | unset | Address of the phone chat page; adds a Chat tab that embeds it. |

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
- **Activity**: the Codex session files, told apart by the `cwd` in their first
  line. Each file is read once and then only its new bytes. Tool calls come
  from the harness's finished `McpToolCall` items (falling back to the script
  text and its output when a harness does not log those), events from the
  lines after `Since last time:` in each tool result, remarks from assistant
  messages, thoughts from reasoning summaries (nothing while those are empty).
  "Routine" lines (status, wait, picture, screen, inventory, shell commands,
  arrivals, hurt, Baritone chatter) are hidden until asked for. The figures per
  resident cover the last 60 minutes.
- **Map**: the `positions` table (this app writes one row per online resident
  every 10 s), `places.json` of each resident, `resident/shared/places.json`,
  and deaths from `places.json` plus `died` events in the session files.
  Overworld only, no terrain.
- **Notes**: `memory.md`, the last 12 KB of `journal.md`, every other `.md`
  file under the resident's directory, and the places files. Read-only.
- **Commons**: `skills`, `skill_runs`, `shared_notes`, `reviews`, `feedback`
  and `overseer/<Name>.md`. Three figures are kept apart on purpose: did it
  work (runs that passed, of all runs), is it worth having (residents other
  than the author who ran it), and what residents say (their own verdicts).
  Keep sets `curated`, Reject sets `rejected` and needs a reason; both, and
  "Comment only", write a `reviews` row signed with the name typed at the top
  (kept in the browser). A draft can be rejected or commented on, not kept. A
  verdict on a skill that changed version since the page loaded is refused.
- **Chat**: an iframe of `CHAT_URL`, shown only when it is set.

## API

All under `/<token>/api/`, JSON, `Cache-Control: no-store`:
`GET residents`, `GET picture?resident=&fresh=1` (PNG), `GET activity?boot=&after=&limit=`,
`GET map?hours=1|6|24|72|168`, `GET notes?resident=`, `GET file?resident=&path=`,
`GET commons`, `POST review` with `{kind: "skill"|"note", id, verdict: "keep"|"reject"|"comment", text, reviewer, version?}`.
Errors are `{error: "..."}` with the sentence the page shows.

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
