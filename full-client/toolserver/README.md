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

- `wait` — Wait 1..120 seconds for chat, damage, death, a rescue/reflex, a player arriving or navigation; optional `for` event-type filter.
- `go_to` — Start `#goto x [y] z`; floats use the containing block (`floor`, including negative coordinates). Arrival means within two blocks, including height when supplied.
- `mine` — Start `#mine [count] namespace:block`; searches known and nearby chunks and may walk far. Baritone 1.10.1 has no per-command radius limit, so there is no `near` argument.
- `follow` — Start `#follow player name`.
- `explore` — Start `#explore`.
- `stop` — Stop Baritone and release held keys.
- `status` — Position, dimension, health, food, held item, target, nearby players/hostiles, navigation and screen.
- `inventory` — Non-empty inventory, armor and offhand, including durability; `H` marks hotbar indexes 0..8.
- `say` — Plain chat; rejects Baritone/slash commands and line breaks.
- `look` — Aim with yaw/pitch, block coordinates (floats use the containing block) or a nearby player name.
- `use` — Right-click, optionally hold for `hold_ticks` (1..200).
- `attack` — Left-click, optionally hold to mine by hand.
- `select_hotbar` — Select slot 0..8.
- `eat` — Eat food for 40 ticks; optionally name an item. Refuses open screens, moves off-hotbar food into a hotbar slot with a verified inventory swap, and fails if food does not increase.
- `open_inventory` — Open your own inventory, without replacing another screen.
- `screen` — Screen title, indexed non-empty slots, buttons and text fields.
- `click_slot` — Click a menu slot with optional button/mode; these are **screen** indexes, not inventory indexes.
- `craft` — Craft a shaped or shapeless recipe in one call (database required): at an open crafting table, or in the player's own 2x2 grid, which it opens when no screen is open. `count` is 1..16 crafting operations. One item per cell per operation, every click read back from `/gui`; the output is taken only when it shows the requested item, and on any failure the grid and cursor are emptied back into the inventory.
- `click_button` — Press a widget by label or index.
- `type_text` — Type into the current editor, including signs and books.
- `press_key` — Press ENTER, ESCAPE, BACKSPACE, TAB, arrows or DELETE; report the screen open afterwards.
- `close_screen` — Request closure, read back the screen, try ESCAPE if needed, then report whether it actually closed.
- `picture` — Return the actual framebuffer as MCP image content.
- `write_sign` — Place selected sign against the looked-at block, enter up to four lines and finish the editor.
- `find_item` — Search item names/ids (knowledge database required).
- `recipes` — Find item-producing recipes; shaped recipes include a grid legend (database required).
- `uses` — Find item-consuming recipes, including tags (database required).
- `guide` — Search mod guide-book text (database required).
- `note_difficulty` — Append dated text, position and last tool error for maintainers.
- `set_reflexes` — Configure `auto_eat`, `eat_below`, `when_attacked` (`auto`, `fight`, `flee`, `nothing`), and the independently switchable `surface`, `escape_fire` (both fire and lava) and `avoid_creepers` rescues. Rescue switches default to `true`.

Bare ids for `mine`, `eat`, `recipes` and `uses` assume `minecraft:`. When an exact recipe/use lookup is empty, matching indexed item ids are tried and any selected alternate id is reported.

## Body behavior

One shared poller reads summary at 4 Hz and full state at 1 Hz (also on damage). Waits subscribe to its events, never add HTTP polling. Chat comes from a 50 ms local log tail, including phone-style system chat. Every tool result ends with unseen events, at most eight, with an older-dropped count. Text is capped below 1500 characters with explicit omission; screenshot image bytes are separate. Large inventories/menus/recipe lists can therefore be abbreviated.

Reflex defaults: auto-eat below 12 food, and also below 14 health when food is below 20 so regeneration can start; `auto` attack response fights only with a sword/axe in the hotbar and at least 8 health, otherwise flees (the event states why). Both automatic and explicitly configured fights break off and flee at 6 health or below. Food detection uses Synapse's edible metadata (including modded foods), with a vanilla-food fallback only for older payloads without that metadata. Combat pauses navigation, selects a sword/axe, aims and attacks no faster than every 600 ms, checks the actual raycast target, and stops after 15 seconds or when the mob disappears. It never deliberately attacks players or creepers. Each automatic meal produces one completion event with item, any inventory move, and observed food before/after (or a failure). Screens suppress reflexes; a screen blocking meals for more than 20 seconds at low food produces one warning until unblocked. Only hands/view/hotbar tools (`look`, `use`, `attack`, `select_hotbar`, `eat`, `open_inventory`, `close_screen`, `click_*`, `type_text`, `press_key`, `write_sign`, `stop`) take over automatic behavior; navigation, chat, waits and observations leave it running. A navigation command issued during combat or a rescue is kept paused until that reflex ends.

Survival rescue priority is lava, drowning, fire, creeper, being attacked, then eating. A higher-priority rescue interrupts a meal, fight or lower rescue; start and end emit one `reflex` event each and wake a pending `wait`. Every active rescue shares cleanup that releases keys and resumes Baritone exactly once on success, timeout, death, a screen opening, manual takeover or shutdown. Fire view/hotbar state is restored before resumption. Missing fields never default to false/zero: the affected new rescue stays off and `status` has one combined older-Synapse warning.

- **Safe-ground trail and retreat:** With `onGround`, `inWater`, `inLava` and `onFire` present, the poller retains the last 40 grounded, dry, cool positions, adding one after at least a block of movement. Retreat aims about twice a second toward the newest crumb farther from the threat, using short sprint steps, and stops at 10 blocks separation or 5 seconds. Without a qualifying crumb it walks directly away in short steps and stops immediately if ground is lost. This serves `when_attacked: "flee"`, unarmed/unhealthy `auto`, and low-health combat break-off. Against the previous mod payload none of these senses exist, so the old 60-tick sprint-away flee remains unchanged.
- **Drowning (`surface`):** If `underwater` is true and `air < maxAir / 2`, pause Baritone and hold jump in repeated five-tick steps until the eyes leave water. After six seconds underwater, also move toward the latest safe crumb; a 12-second timeout releases/resumes rather than holding keys forever. The end event reports observed air before/after.
- **Lava and fire (`escape_fire`):** In lava, pause and use repeated jump+sprint steps toward the latest safe crumb until observed out (10-second timeout). Burning outside water/lava uses a hotbar water bucket when outside the Nether: select it, look straight down, place, retrieve after one second, restore slot/view and resume. Without a usable bucket the fire is only reported, without pausing navigation.
- **Creepers (`avoid_creepers`):** A creeper with `fuse: true`, or any creeper within three blocks, starts retreat before damage. Combat never attacks a creeper, including when `when_attacked` is `fight`.

`status` adds air while underwater and a burning/lava hazard line. These rescues require Synapse's `air`/`maxAir`, fluid/contact, burning, grounding and creeper-fuse fields; the older-payload fallback applies only when those senses are unavailable.

Meals use the hotbar first, otherwise open the survival inventory and swap the food stack to an empty hotbar slot (or the selected slot if full, reporting the displaced stack). They verify the hotbar and close the inventory before using food. To avoid right-clicking the crafting table/chest in front of the player instead of eating, meals aim straight up, wait two client ticks for the raycast, and restore the selected slot and aim after releasing use. Synapse's sneak movement can coexist with held use, but its acknowledgement arrives only after movement ends; it cannot guarantee sneak-before-use ordering. If a screen nevertheless appears during a meal, use is released before verified closure, one reflex event reports the failed meal, and auto-eat waits 10 seconds before trying again. This also prevents close/reopen loops. The mod's close acknowledgement now reflects the actual screen instead of unconditional success; real modpack behavior still requires live verification.

Requires Synapse's timed use/attack, `release`, sprint movement, GUI character/key input, `eye` position, and player names/hostile flags in full state. Unknown modded enemies require Synapse's hostile flag; no registry-name guessing. Minecraft server corrections, claims, food consumption and sign persistence remain authoritative. A path reports `stopped_short` after four seconds without movement **or a fresh Baritone reply**, including the last reply since that navigation started and the distance left. Mine/explore have no fixed destination, so their remaining distance is explicitly unknown. The timer is an inactivity heuristic, not direct access to Baritone's calculation state. Mining command syntax was checked against [Baritone 1.10.1 MineCommand](https://github.com/cabaletta/baritone/blob/v1.10.1/src/main/java/baritone/command/defaults/MineCommand.java).
