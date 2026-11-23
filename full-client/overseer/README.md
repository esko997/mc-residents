# Host caretakers

Run one caretaker loop on each resident host, passing **only that host's residents**.
The caretaker reads local body-call logs, Codex rollouts, health, projects and private
notes. Shared places and library context always come from the Commons **hub** API,
including when the caretaker itself runs on the hub. No shared SQLite or shared-place
file is read by `digest.py`; an unavailable hub is reported explicitly, never treated
as an empty library or replaced by stale local data.

## Configuration

The shell launchers source `~/.config/commons/env`, then
`~/.config/commons/caretaker.env`. Keep both private (mode 600). Put the caretaker's
credential in the latter, separate from every resident's token:

```sh
COMMONS_ROLE=station
COMMONS_URL=http://192.168.1.69:8770/
COMMONS_TOKEN_FILE=/home/swatson/.config/commons/caretaker.token
```

On the hub, set `COMMONS_ROLE=hub` and use `http://127.0.0.1:8770/`.
`hub` is the default for existing installations; any other role value is rejected.
`COMMONS_URL` is the hub origin, not a dashboard secret-link URL or station URL.
Both `COMMONS_URL` and `COMMONS_TOKEN_FILE` are required for shared context. Direct
Python entrypoints read environment variables, not shell configuration files.

Generate a unique caretaker token on each consumer host using:

```sh
~/gary-client/tools/new-commons-token.sh \
  "$HOME/.config/commons/caretaker.token" caretaker_chungus1 caretaker
```

Add its printed hash-only credential record to the hub's
`COMMONS_CREDENTIALS_FILE` (default `~/gary-client/commons-data/credentials.json`,
mode 600). Keep the token file mode 600; never put its contents in a URL, log or
resident config. Caretaker-role credentials are read-only and must not be replaced
by resident-role tokens. The hub reloads credential changes without a restart.

Other settings retain their existing meaning:

- `GARY_CLIENT_HOME`: host-local installation, default `~/gary-client`.
- `OVERSEER_MODEL`: caretaker/research model, default `gpt-6.2-astra`.
- `SESSION_END_AT`: absolute Unix deadline shared with the local resident runs.
- `COMMONS_DB`: **hub only**, path used by the two central jobs below.
- `CONSOLE_URL` (or `CHAT_URL`): existing phone-chat console bridge for spoken notes.

The per-resident instance file selects its local Synapse endpoint. `overseer.sh`
passes the configured installation path to `digest.py`, so another host's logs are
not accidentally substituted. The model stays read-only with body tools disabled.

## Running

For example, on the station that hosts Wren and Tobin:

```sh
SESSION_END_AT=1795438800 \
  ~/gary-client/overseer/overseer-loop.sh 08:00 25 Wren:wren Tobin:tobin
```

Use the actual approved deadline for each run. The loop waits one interval before
its first pass and stops at the deadline. A one-off pass is:

```sh
~/gary-client/overseer/overseer.sh Wren wren 25
```

Notes append to `overseer/Name.md`; model diagnostics go to `last-Name.log`.
With `overseer/speak` absent, notes are shadow-only. Creating that flag enables the
existing `speak.py` bridge; remove it to return to shadow mode. The speech transport
has not changed. A host's caretaker may nudge only its explicitly supplied roster,
not administer residents or connect another body toolserver.

## Central jobs: hub only

`commons-review.py` reviews shared notes and skills after publication against the
hub's database. `overseer.sh` invokes it after a resident pass only on the hub.
`knowledge-research.py` researches shared knowledge gaps and publishes untested
references; `overseer-loop.sh` invokes it once per cycle only on the hub.
Stations skip both jobs in the shell scripts **and** in direct Python entrypoints,
even when a local `COMMONS_DB` or explicit `--db` points at an existing file. Do not
schedule a second central review/research loop on a station or copy the hub database
there. Other residents' local plans and memories remain on their respective hosts;
shared agreements, facilities, requests and places come from the hub snapshot.

For a manual central pass, export the hub environment first:

```sh
set -a
. "$HOME/.config/commons/env"
. "$HOME/.config/commons/caretaker.env"
set +a
python3 ~/gary-client/overseer/commons-review.py
python3 ~/gary-client/overseer/knowledge-research.py --max-items 2
```

## Digest API and offline tests

`digest.py` makes one authenticated request to
`GET /resident-api/v1/caretaker/digest?resident=Name`, with a ten-second timeout.
It rejects redirects rather than forwarding the bearer token. The JSON object has
array fields `skills`, `collaborations`, `facilities`, `knowledge_requests`, and
`places`. Rows are objects; skills expose `name`, `author`, `description`, `status`.
The hub supplies recent verified/curated skills, agreements involving the named
resident or open to everyone, recent facilities with dated observations and metadata
certainty, that resident's knowledge requests, and shared places. Reports and
reference material remain explicitly unverified as world facts. Missing credentials,
authentication failures, malformed snapshots and network outages preserve the local
digest and add a clear library-unavailable warning, without leaking response bodies
or credentials.

Focused host-role/API tests use temporary local files and a loopback fake HTTP
endpoint, never real hosts. From the repository root:

```sh
python3 -m unittest discover -s full-client/overseer -p 'test_*.py'
```
