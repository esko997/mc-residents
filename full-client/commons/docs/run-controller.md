# Run controller

Commons owns what a resident **run** is and exposes one controller API to start and stop
runs; Switchyard owns *when and where* (the daily window, noon to 01:00 America/New_York)
and calls this API. The dashboard's Residents view uses the same API.

A run is exactly what the old hand-written launcher made, per host:

- per resident a transient user unit `<name>-run.service` (`systemd-run --user --collect
  --slice=residents.slice -p CPUQuota=200% -p RuntimeMaxSec=<deadline+10 min>
  --setenv=TZ=America/New_York --setenv=SESSION_END_AT=<epoch> [--setenv=RESUME_THREAD=<id>]
  ~/gary-client/run-session.sh <Name> <persona> 0 <model>`), whose watchdog
  (`health-watch.py`) keeps the body `gary-client@<Name>` alive on the same thread until the
  deadline;
- one caretaker unit `overseer-run.service` (`overseer-loop.sh <HH:MM> <interval>
  Name:persona ...`, CPUQuota=100%) with only that host's running residents.

Rules the controller enforces: one end time shared by every run and caretaker on every
host; never two runs or bodies for one resident; resume the resident's Codex thread unless
a fresh one is asked for; nothing starts at boot; a deadline must be in the future and at
most 24 h away; a stop leaves no client or caretaker behind and lets `run-session.sh`
commit the notes.

## Pieces

| Where | What |
| --- | --- |
| every resident host, `~/gary-client/tools/` | `start-run.sh`, `stop-run.sh`, `run-status.sh` (thin wrappers around `runctl.py`), `dry-run-session.sh` |
| every resident host, `~/gary-client/run.conf` | fixed placement: `HOST`, `RESIDENTS`, `DEFAULT_MODEL`, caretaker defaults (see `tools/run.conf.example`) |
| `~/gary-client/instances/<Name>.env` | `GAME_DIR`, `SYNAPSE_URL`, and now `PERSONA=` (default: the name in lower case, today's behaviour) |
| `~/.local/state/residents/activations/` | one JSON record per start or stop that changed something (mode 600, newest 500 kept) |
| Commons on each host | `/controller/v1/*`: runs **only its own host's** launcher; the hub also forwards to stations |

Each host's Commons invokes its own launcher with a fixed argument vector built from
validated fields (`--opt=value` words, never a shell string), a scrubbed environment
(`HOME PATH USER LOGNAME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS GARY_CLIENT_HOME
RESIDENTS_STATE_DIR RESIDENTS_RUN_CONF LANG`), one start/stop at a time per Commons, and
timeouts (status 15 s, start 60 s, stop 170 s; a hub waits 8/75/185 s for a station).

## API

Base: `http://<hub>:8770/controller/v1/` (the hub is Inspiron, `192.168.1.69`). Every
request needs `Authorization: Bearer <controller token>`; POST bodies are
`Content-Type: application/json`, at most 16 KiB, unknown fields refused. Browser
requests from another origin are refused. Run state (not start/stop) is also readable at
`/<dashboard token>/api/runs`.

### `GET runs`

```json
{ "ok": true, "code": "ok", "now": 1795456000, "warnings": [],
  "hosts": [
    { "host": "inspiron", "ok": true, "code": "ok", "end_at": 1795500000,
      "residents": [ { "name": "Gary", "running": true, "run_state": "active", "client_state": "active",
                       "end_at": 1795500000, "model": "gpt-6.2-sol", "mode": "resume",
                       "thread_id": "01a20685-…", "started_by": "daily_window via switchyard",
                       "started_at": 1795456000, "activation": "20261123T170000Z-start-1a2b3c",
                       "unit": "gary-run.service", "client_unit": "gary-client@Gary.service", "dry_run": false } ],
      "caretaker": { "unit": "overseer-run.service", "state": "active", "running": true,
                     "end_at": 1795500000, "roster": ["Gary:gary", "Margo:margo"], "interval": 25 } },
    { "host": "chungus1", "ok": false, "code": "unreachable", "residents": [], "caretaker": null,
      "error": "station chungus1 unreachable: its runs are unknown" } ] }
```

`started_by` is `outside the launcher` for a run that has no activation record (started
by hand). `thread_id` is the resident's current thread from `sessions/<Name>-health.json`.

### `POST start`

```json
{ "residents": "all" | ["Gary", "Wren"],
  "end_at": 1795500000,                 // or "end": "2026-11-24T01:00:00-05:00" (ISO 8601 with offset)
  "model": "gpt-6.2-sol",               // optional: everyone started; default each host's run.conf
  "models": { "Margo": "gpt-6.1-sol" }, // optional: per resident, wins over "model"
  "fresh": ["Tobin"] | "all",           // optional: new thread; default resumes the existing thread
  "caretaker": { "enabled": true, "interval": 25, "speak": "keep" | "on" | "off" },  // optional; default run.conf
  "note": "one line for the opening prompt",  // optional, SESSION_NOTE, at most 300 characters
  "on_behalf_of": "daily_window" }      // optional word recorded as "daily_window via <credential name>"
```

### `POST stop`

```json
{ "residents": "all" | ["Wren"], "on_behalf_of": "daily_window" }
```

Stopping a resident stops `<name>-run` first (run-session.sh takes the body offline and
commits the notes), then any body still up, then the caretaker when no resident of that
host is still running (otherwise the caretaker is restarted without the stopped
resident, same deadline). `"all"` also stops every caretaker. Each host then verifies the
units are inactive and that no client process is left on the resident's game directory.

### Replies

Start and stop reply with the same shape as `GET runs` plus `end_at` (start), and per
resident a `result`: `started`, `already_running`, `failed`, `stopped`, `not_running`,
`still_active`; per caretaker `started`, `restarted`, `already_running`, `left_running`,
`off`, `stopped`, `not_running`, `failed`. **Each host is its own entry**: one host's
failure never turns into an overall `ok`.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 200 | `ok` | every targeted host did what was asked (including no-ops) |
| 207 | `partial` | some hosts ok, some not: read `hosts[]` |
| 400 | `usage` | malformed request; nothing ran |
| 401 | `unauthorized` | missing/unknown token, or no controller credentials on that host |
| 403 | `forbidden` / `gate` | cross-origin request / the start gate refused (reserved, see below) |
| 404 | `unknown_resident` | a named resident is not on any host |
| 409 | `conflict` | something already runs with another end time, model or thread mode; a body runs without its run; a persona changed while resuming. **Nothing was started** |
| 422 | `deadline` / `config` | end time past, more than 24 h away or ambiguous / host config refuses (missing `run.conf`, persona without `AGENTS.md`) |
| 429 | `busy` | another start/stop is in progress on that host |
| 502 | `systemd` / `unreachable` / `still_active` / `error` | systemd failed (reply lists what did start) / station down: nothing done there / stop left something running / unreadable launcher reply |
| 503 | `not_configured` | credentials file invalid, launcher not installed, or the hub has no token for a station |
| 504 | `timeout` | the launcher or station did not answer in time: **outcome unknown** |

When every targeted host fails with the same code, that code's status is returned; a
single-host request returns that host's status.

### Idempotency

- `start` for a resident already running **with the same `end_at`** is a no-op success
  (`already_running`, no new record). Retrying a start after a timeout is safe.
- A different `end_at` anywhere (any resident or caretaker on any reachable host) is
  `409 conflict` before anything starts, e.g. `Tobin is already running until 01:00 on chungus1`.
- An explicit `model` different from the running one, or `fresh` for a resident running on a
  resumed thread, is `409` (stop first). Without an explicit model the running one is kept.
- `stop` of something not running is a success (`not_running`).

## Credentials and the dashboard

Controller credentials are separate from the dashboard URL token and from Resident API
tokens. Each host has its own mode-600 `~/gary-client/commons-data/controller-credentials.json`
(`COMMONS_CONTROLLER_CREDENTIALS_FILE`), a JSON array of `{"name","role":"controller","sha256"}`,
hot-reloaded; a group- or world-readable file is refused as a whole. Generate a token **on
the machine that will use it**; only the printed hash record goes to the host it calls:

```sh
~/gary-client/tools/new-commons-token.sh ~/.config/switchyard/residents-controller.token switchyard controller
# -> {"name": "switchyard", "role": "controller", "sha256": "…"}  appended to the hub's controller-credentials.json
```

Use one credential per caller (`switchyard`, `owner_dashboard`): Activity names the caller
and revoking one is deleting its line.

**Hub to stations.** The hub calls each station's `/controller/v1/` with its own token,
read from `commons-data/controller-station-tokens/<host>.token` (mode 600,
`COMMONS_CONTROLLER_STATION_TOKENS`); the station's credentials file holds that token's hash
as `hub_<hubhost>`. Stations record the whole chain, e.g. `daily_window via switchyard via hub_inspiron`. Status reads go through the
station's secret dashboard URL that `stations.json` already holds.

**Dashboard buttons.** The person enters a controller token once on the Residents view; it is
kept in that browser (`localStorage`, or `sessionStorage` with "remember" unticked; "Forget
controller token" removes it) and sent only as an `Authorization` header to this page's own
`/controller/v1/`. A 401 forgets it.

Threat model assumed: a LAN-only, plain-HTTP dashboard behind a secret URL. That URL is
already shared widely (phones, the Overlay browser source in OBS uses the same token) and can
already send chat as a person and server commands through the console. Starting runs spends
model quota and changes the world, so the URL alone must not do it. A bearer header is never
attached by the browser on its own, so there is no cross-site request forgery path (unlike a
cookie or HTTP Basic auth), and cross-origin requests are refused. Not defended against: anyone
who can read LAN traffic (plain HTTP, as today: use a tunnel/TLS for more), and script injection
into the dashboard (which could read the stored token; it could already use the console). Rejected:
an "opt-in on the hub" that lets the secret URL start runs (it would hand that power to every
copy of the URL, including overlay links).

## Example calls (Switchyard)

Keep the token out of process arguments; `printf` is a shell builtin:

```sh
TOKEN_FILE=~/.config/switchyard/residents-controller.token
auth() { printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")"; }
HUB=http://192.168.1.69:8770/controller/v1

# Start all at 12:00 until the next 01:00 New York time.
END=$(TZ=America/New_York date -d 'tomorrow 01:00' +%s)   # at 12:00; after midnight use 'today 01:00'
curl -sS --max-time 200 -H @<(auth) -H 'Content-Type: application/json' \
  -d "{\"residents\":\"all\",\"end_at\":$END,\"on_behalf_of\":\"daily_window\"}" "$HUB/start"

# Stop all (e.g. pause the window).
curl -sS --max-time 200 -H @<(auth) -H 'Content-Type: application/json' \
  -d '{"residents":"all","on_behalf_of":"daily_window"}' "$HUB/stop"

# State, for reconciliation.
curl -sS --max-time 20 -H @<(auth) "$HUB/runs"
```

Use a client timeout of at least 200 s for `stop` (each host stops its runs in parallel; a
stuck client gets systemd's 90 s stop timeout).

## What Switchyard should do on each result

| Result | Action |
| --- | --- |
| 200 | Done. Optionally confirm with `GET runs`. |
| 207 | Act per host: hosts `ok` are done; apply the rows below to each failed host. Retrying the **same** start is safe (no-op where already running). |
| `unreachable` (station) | Nothing was done there. Retry the same request later (bounded, e.g. every 5 min within the window); do not stop the other hosts. |
| `timeout` | Outcome unknown: `GET runs` first, then retry the same request if still needed. |
| `busy` (429) | Someone else is starting/stopping that host. Retry after 30 s, at most a few times. |
| `conflict` (409) | Do not retry automatically; something runs with another end time or settings (an operator started it). Report it; to impose the window, `stop` then `start` is an operator decision. |
| `deadline` (422) | Fix the computed end time (past, >24 h, or an ambiguous DST time). |
| `gate` (403) | The start gate refused (generation token missing/revoked). Never retry; report. |
| `still_active` (stop, 502) | Something did not stop. Report to the operator; do not loop stops. |
| `systemd` (502) | Partial start on that host: the reply lists what started. `GET runs`, report; a retry of the same start fills in what failed. |
| `usage`, `unknown_resident`, `config`, `not_configured`, `unauthorized` | Configuration or client bug. Do not retry; report. |

## The launcher on its own (on a resident host)

```sh
~/gary-client/tools/start-run.sh --all --end '2026-11-24 01:00'            # wall time in New York
~/gary-client/tools/start-run.sh Margo --end-at 1795500000 --model gpt-6.1-sol --fresh Margo \
    --caretaker on --caretaker-interval 25 --caretaker-speak keep --by owner --json
~/gary-client/tools/stop-run.sh Margo        # or --all
~/gary-client/tools/run-status.sh [--json]
```

Exit codes: 0 ok, 2 usage, 3 deadline, 4 conflict, 5 config, 6 systemd, 7 still active after
stop, 75 busy (another start/stop holds `~/.local/state/residents/control.lock`), 77 start gate
refused. `--json` prints one JSON object (the per-host part of the API reply). A start that
changed nothing writes no record.

**Start gate (reserved).** `start_gate()` near the top of `start-run.sh` is the one place
where Switchyard's generation token will be checked
(`~/.local/state/switchyard/tokens/minecraft-residents/<component>.token`). It is called after
all validation, with the host lock held, right before the first `systemd-run`, with one
argument per component about to start (`resident-<name>`, `caretaker-<host>`). Today it is a
no-op. Returning 77 (or any non-zero) refuses with exit 77 and nothing started.

**Dry run.** `--dry-run` starts the same units with `tools/dry-run-session.sh` in place of
`run-session.sh` and `overseer-loop.sh`: no mind, no model call, same deadline and stop path.
`--dry-run-body` also starts and stops the real body. Records and status say `dry_run`.

## Deploying

On each resident host (Inspiron: Gary, Margo and the hub; Chungus1: Wren, Tobin and a station):

1. Install `full-client/tools/{runctl.py,start-run.sh,stop-run.sh,run-status.sh,dry-run-session.sh,new-commons-token.sh}`
   into `~/gary-client/tools/` (executable). `python3` (3.9+, with `zoneinfo` and the system tz database) is required.
2. Create `~/gary-client/run.conf` from `tools/run.conf.example` (`HOST=inspiron RESIDENTS="Gary Margo"`;
   `HOST=chungus1 RESIDENTS="Wren Tobin"`). Add `PERSONA=` to an instance file only when it is
   not the name in lower case.
3. Create `commons-data/controller-credentials.json` (mode 600): on the hub with the
   `switchyard` and `owner_dashboard` records; on each station with the hub's `hub_inspiron`
   record. On the hub, put the hub's token for each station in
   `commons-data/controller-station-tokens/<host>.token` (mode 600, directory 700).
4. Deploy Commons as usual and restart it (it reads the new files without a restart afterwards).

**Systemd and the Commons unit.** No unit or drop-in change is needed. Checked on both hosts
(2026-11-23, `systemctl --user show commons`): `commons.service` has no sandboxing
(`ProtectSystem=no`, `ProtectHome=no`, `NoNewPrivileges=no`, `PrivateTmp=no`, no
`ReadWritePaths`/`SystemCallFilter`/`RestrictAddressFamilies`), and as a user service it already
reaches the user manager (it runs `systemctl --user is-active` today). The run units it creates
are transient units of the user manager in `residents.slice`, not children of Commons, so a
Commons restart never stops a run. Two consequences to know: `KillMode=control-group` means a
Commons restart *during* a start or stop kills that launcher process mid-way (re-read `GET runs`,
then repeat the request); and `CPUQuota=50%` applies to the launcher while it runs (it is short).
If the unit is ever sandboxed, it must keep: the user bus (`$XDG_RUNTIME_DIR/bus`), write access
to `~/.local/state/residents` and `~/gary-client/overseer` (the speak flag), read access to
`~/gary-client` and `/proc` (stray client detection).
