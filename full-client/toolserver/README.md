# Resident full-client tools

Bun stdio MCP server for a real Forge client running Synapse and Baritone. No server-side bot or remote administration. Run this **on the client machine**, under the resident's account; keep Synapse loopback-only. Requires Bun 1.4+.

```sh
bun install
CLIENT_LOG="$HOME/gary-client/game/logs/latest.log" RESIDENT_NAME=Gary bun src/main.ts
bun test
bun run typecheck
```

Only MCP messages go to stdout; startup diagnostics go to stderr. Closing stdin, SIGINT and SIGTERM release held keys and send `#stop` (best effort if the client is unreachable).

## Environment

| Variable | Default / purpose |
| --- | --- |
| `CLIENT_LOG` | Required; client's `logs/latest.log`, followed across replacement/truncation. Existing lines are skipped at startup. |
| `RESIDENT_NAME` | Required; in-game name, used to ignore own chat echoes. |
| `SYNAPSE_URL` | `http://127.0.0.1:25599` |
| `SYNAPSE_TOKEN_FILE` | `~/.synapse/token`; token is never returned to the model. |
| `RESIDENT_DIR` | Current directory; `note_difficulty` appends `difficulties.md` here. Directory must exist. |
| `KNOWLEDGE_DB` | Optional read-only SQLite export; knowledge tools register only when it opens. Missing/invalid database is reported clearly on stderr; attempted knowledge calls return a tool error. |

Paths accept `~/`. Knowledge export/build instructions live alongside `scripts/build-knowledge.ts`; runtime lookup never contacts a service or generates recipes.

For a Codex MCP client, use absolute paths (and the client's own home/token):

```toml
[mcp_servers.body]
command = "/home/your-user/.local/bin/bun"
args = ["/home/your-user/Repos/minecraft-residents/full-client/toolserver/src/main.ts"]
tool_timeout_sec = 180

[mcp_servers.body.env]
CLIENT_LOG = "/home/your-user/gary-client/game/logs/latest.log"
RESIDENT_NAME = "Gary"
RESIDENT_DIR = "/home/your-user/gary-client/resident"
KNOWLEDGE_DB = "/home/your-user/gary-client/knowledge.sqlite"
```

## Tools

- `wait` — Wait 1..120 seconds for chat, damage, death, a player arriving or navigation; optional `for` event-type filter.
- `go_to` — Start `#goto x [y] z`; arrival means within two blocks horizontally.
- `mine` — Start `#mine [count] namespace:block`; bare block names assume `minecraft:`.
- `follow` — Start `#follow player name`.
- `explore` — Start `#explore`.
- `stop` — Stop Baritone and release held keys.
- `status` — Position, dimension, health, food, held item, target, nearby players/hostiles, navigation and screen.
- `inventory` — Non-empty inventory, armor and offhand, including durability; `H` marks hotbar indexes 0..8.
- `say` — Plain chat; rejects Baritone/slash commands and line breaks.
- `look` — Aim with yaw/pitch, coordinates or a nearby player name.
- `use` — Right-click, optionally hold for `hold_ticks` (1..200).
- `attack` — Left-click, optionally hold to mine by hand.
- `select_hotbar` — Select slot 0..8.
- `eat` — Eat hotbar food for 40 ticks and report food before/after; optional specific item id.
- `screen` — Screen title, indexed non-empty slots, buttons and text fields.
- `click_slot` — Click a menu slot with optional button/mode; these are **screen** indexes, not inventory indexes.
- `click_button` — Press a widget by label or index.
- `type_text` — Type into the current editor, including signs and books.
- `press_key` — Press ENTER, ESCAPE, BACKSPACE, TAB, arrows or DELETE.
- `close_screen` — Close the current screen.
- `picture` — Return the actual framebuffer as MCP image content.
- `write_sign` — Place selected sign against the looked-at block, enter up to four lines and finish the editor.
- `find_item` — Search item names/ids (knowledge database required).
- `recipes` — Find item-producing recipes; shaped recipes include a grid legend (database required).
- `uses` — Find item-consuming recipes, including tags (database required).
- `guide` — Search mod guide-book text (database required).
- `note_difficulty` — Append dated text, position and last tool error for maintainers.
- `set_reflexes` — Configure `auto_eat`, `eat_below` and `when_attacked` (`auto`, `fight`, `flee`, `nothing`).

Bare ids for `mine`, `eat`, `recipes` and `uses` assume `minecraft:`. When an exact recipe/use lookup is empty, matching indexed item ids are tried and any selected alternate id is reported.

## Body behavior

One shared poller reads summary at 4 Hz and full state at 1 Hz (also on damage). Waits subscribe to its events, never add HTTP polling. Chat comes from a 50 ms local log tail, including phone-style system chat. Every tool result ends with unseen events, at most eight, with an older-dropped count. Text is capped below 1500 characters with explicit omission; screenshot image bytes are separate. Large inventories/menus/recipe lists can therefore be abbreviated.

Reflex defaults: auto-eat below 12 food; `auto` attack response fights only with a sword/axe in the hotbar and at least 8 health, otherwise flees (the event states why). Both automatic and explicitly configured fights break off and flee at 6 health or below. Food detection uses Synapse's edible metadata (including modded foods), with a vanilla-food fallback only for older payloads without that metadata. Combat pauses navigation, selects a sword/axe, aims and attacks no faster than every 600 ms, checks the actual raycast target, and stops after 15 seconds or when the mob disappears. It never deliberately attacks players. Flee sprints directly away for 60 client ticks (about three seconds). Each automatic meal produces one completion event with item and food before/after. Screens suppress reflexes and release automatic holds. Only hands/view/hotbar tools (`look`, `use`, `attack`, `select_hotbar`, `eat`, `click_*`, `type_text`, `press_key`, `write_sign`, `stop`) take over automatic behavior; navigation, chat, waits and observations leave it running. A navigation command issued during combat is kept paused until combat ends.

Requires Synapse's timed use/attack, `release`, sprint movement, GUI character/key input, `eye` position, and player names/hostile flags in full state. Unknown modded enemies require Synapse's hostile flag; no registry-name guessing. Minecraft server corrections, claims, food consumption and sign persistence remain authoritative. A stalled path reports `stopped_short` after four seconds; mine/explore have no fixed destination so report unknown remaining distance.
