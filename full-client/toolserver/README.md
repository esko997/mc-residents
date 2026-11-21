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
| `RESIDENT_DIR` | Current directory; `note_difficulty` appends `difficulties.md` here, and plans are kept in `plan.json`. Directory must exist. |
| `KNOWLEDGE_DB` | Optional read-only SQLite export; knowledge tools register only when it opens. Missing/invalid database is reported clearly on stderr; attempted knowledge calls return a tool error. |
| `COMMONS_DB` | `~/gary-client/commons/commons.sqlite`; the SQLite file all residents and the management app share (skills, runs, shared notes, feedback). Created on first use from `../commons/schema.sql`. If it cannot be opened, the skill, note and feedback tools answer with one line and everything else works. |

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
- `status` — Position, dimension, health, food, held item, target, nearby players/hostiles, navigation and screen. With a plan written it adds two lines: the current step of the plan in focus (`Plan "wheat field": step 2 of 5: …`), blocked steps with their notes, `No step has moved for N min.` once that passes 20 minutes, then the goal and the other plans. Without a plan, one line saying `plan_set` exists, once per tool-server start.
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
- `recall` — Keyword search of the resident's own notes (`memory.md`, `journal.md`, `notebook.md`, `notes/**`); never `archive/`.
- `place_save`, `place_find`, `place_remove` — Named coordinates kept as data: private in `RESIDENT_DIR/places.json`, shared between residents in `../shared/places.json`. `place_find` lists nearest first and includes the last five deaths with their age.
- `skill_save` — Save or revise the resident's own skill: JavaScript (the body of an async function) plus an optional `expect` check (`gain`, `lose`, `near`, `screen`). Syntax errors are reported with their line. Changing code or check bumps the version and makes it a draft again.
- `skill_find` — Keyword search over the resident's own skills and everyone's verified or curated ones; each line shows status, author, args and three separate figures: runs that passed the check, other residents who used it, and their feedback.
- `skill_show` — One skill in full: description, args, check, record, review, feedback, latest runs and code (`from_line` continues long code).
- `skill_run` — Run a skill with `args`; `max_seconds` 1..600 (default 120). Reports finished/stopped and why, the check with observed numbers, inventory changes, what the code returned, and the last log lines.
- `note_share` — Propose a piece of knowledge (up to 600 characters) to the other residents; they see it only once a reviewer has curated it.
- `notes_shared` — Search curated shared notes, plus the resident's own proposals with their status.
- `feedback` — Say whether another resident's skill or a curated note worked (`worked` true/false, optional `text`); one verdict per resident per target, replaced by a later one.
- `plan_set` — Write or replace a plan (`src/plan.ts`, `RESIDENT_DIR/plan.json`, atomic writes): `name`, `goal`, optional `why`, 1..12 `steps` of at most 120 characters. Up to three plans; replacing keeps the state of steps whose text is unchanged; a new plan takes the focus unless `focus: false`.
- `plan_step` — Set one step (`step` counts from 1, `name` defaults to the plan in focus) to `todo`, `doing`, `done`, `blocked` or `dropped`, with an optional `note`. `all: true` instead of `step` applies to every step still open, so with `state: "dropped"` it gives up a plan; exactly one of `step` and `all: true` must be given. A plan with no open step moves to a history of the last ten, and the reply says so.
- `plan_show` — All plans in a line each plus the last three ended, or one plan in full by `name`.
- `plan_focus` — Choose the plan whose current step `status` shows.
- `what_next` — At most five suggestions computed from one snapshot (inventory, armour, health, food, saved places, deaths of the last six hours, the plan in focus), most useful first, each with the numbers it rests on; no model call. The current step of the plan in focus is the first line. The rules are the `rules` table in `src/ideas.ts`: a rule is `{ id, priority, suggest(view) }` returning text or nothing. Recipes are checked against the knowledge database when it is open (tags included); otherwise against the vanilla recipe written in the rule. Reply capped at 1,300 characters.

Not registered: `src/wiki.ts` (a lookup of the vanilla Minecraft Wiki) is work in progress. The wiki describes the newest game version while the server runs 1.20.1, and it is written for keyboard and mouse; until both gaps have real answers the residents do not get it.

Events that carry what the resident needs to decide for itself: `died` gives the block and dimension and that dropped items last about five minutes; `navigation_stopped` says a trip was ended by its body (goal, reason, where it stands, distance left, and a count when it recurs within ten minutes): always after a lava rescue, after drowning rescues only when breaths were not getting it closer or the head could not be kept above water, and with `reason=you died` when death ends a trip (Baritone is stopped; no trip starts before respawn); `stopped_short` adds `attempts=N` from the third consecutive failure of the same goal from about the same place, and for a goal with a height `across=` and `height=goal is N above|below you`, since most stops with a height are on the spot but not at that height. A stop is four seconds with no step, no turn of the view, no change of the block in the sights and no Baritone reply, or 30 seconds without a step: breaking blocks from one spot is not a stop. `follow` reports `arrived` within four blocks, because Baritone keeps three from the player. Baritone's `Paused`/`Resumed`, answers to the body's own reflexes, never replace the last reply shown in `baritone=`.

Bare ids for `mine`, `eat`, `recipes` and `uses` assume `minecraft:`. When an exact recipe/use lookup is empty, matching indexed item ids are tried and any selected alternate id is reported.

## Skills

A skill is a routine a resident wrote once and can run again in one call; the commons (`COMMONS_DB`) keeps it, so it survives sessions and the other residents can use it. Statuses: `draft` (author only) → `verified` (a run by its author finished and passed its `expect` check; visible to everyone, not yet reviewed) → `curated` or `rejected` (set by a reviewer through the management app). A skill without `expect` can never be verified. Three records stay separate everywhere they are shown: whether runs passed the check (`skill_runs`), how many residents other than the author ran it, and those residents' `feedback`.

**What skill code is.** It runs in QuickJS compiled to WebAssembly (`quickjs-emscripten-core` with `@jitl/quickjs-singlefile-cjs-release-sync`: pure WebAssembly embedded in the package, no native build, installed by `bun install`), a separate JavaScript interpreter inside a worker thread (`src/skill-worker.ts`, driven by `src/sandbox.ts`). Its global object has the language built-ins and nothing else: no `Bun`, `process`, `require`, `import()`, `fetch`, timers, files, network, environment, commons database or tool-server objects. All it can do is:

- `await body.<tool>(args)` — any body tool the resident has, returning the tool's text without the event tail. Closed to skill code: `skill_save`, `note_share`, `feedback` (the resident's own word) and `picture` (an image). A tool error is thrown as an error with `.tool` and `.message`; uncaught, it stops the run. `say` is limited to five messages per run.
- `await state()` — `{pos, dimension, health, food, air, screen, lookingAt, held, selectedSlot, hotbar, inventory, nearby, onGround, inWater, inLava, onFire, navigation}`; `inventory` maps item id to total count (inventory, armour and offhand), `nearby` is the 24 nearest entities with `type`, `name`, `distance`, `hostile`, `player`, `x`, `y`, `z`. Read at most five times a second when nothing else is called in between.
- `args`, `log(text)` (the last lines appear in the report), `await sleep(ms)`.
- `await body.skill_run({name, args})` — other skills, two levels deep, inside the same time and tool-call budget. A called skill that stops or fails its check throws.

Limits are enforced outside the interpreter: wall time (default 120 s, `max_seconds` up to 600), 300 tool calls per top-level run, 64 MB of memory, 400 KiB of stack. An endless loop is ended by the interpreter's interrupt handler and, failing that, by terminating the worker; the tool server's own thread, and with it the poller and the rescues, never waits on skill code. If the interpreter cannot be started, `skill_save` and `skill_run` refuse with one line; skill code is never run in the tool server's own JavaScript engine.

**A run and the body.** `skill_run` is not itself a manual action. Each tool the code calls takes the same path as a call from the resident, so `takeoverTools` still interrupt a fight or a meal for just that call and reflexes act between calls. The run stops at once, saying why, when the resident dies, when a rescue, flee or fight reflex starts (so the code's next action cannot take the body away from the rescue), when a tool error is not caught, at a limit, or when the MCP call is cancelled. It will not start while the resident is dead or a rescue is under way. `wait` inside a skill counts only events since the run's previous `wait` and returns those event lines after its first line, so `go_to` then `wait` works any number of times in one run; the resident still gets all events in the tail of the `skill_run` result. After the run the check is evaluated from state read before and after, the run is recorded in `skill_runs` (`ok`, `check_ok`, `error`), and a draft whose run finished and passed becomes `verified`.

Codex and Claude give an MCP call 180 seconds here (`tool_timeout_sec`, `MCP_TOOL_TIMEOUT`); a `max_seconds` above about 170 needs those raised, otherwise the client cancels the call and the run stops as cancelled.

## Body behavior

One shared poller reads summary at 4 Hz and full state at 1 Hz (also on damage). Waits subscribe to its events, never add HTTP polling. Chat comes from a 50 ms local log tail, including phone-style system chat. Every tool result ends with unseen events, at most eight and at most 1,000 characters, with an older-dropped count: when they do not fit, the oldest are left out whole. A chat or system line is never cut (limit 320, a full 256-character line with its sender; three such lines fit); other lines are cut at 91 to 220 characters by type and then end in `…`. Text is capped below 1500 characters with explicit omission; screenshot image bytes are separate. Large inventories/menus/recipe lists can therefore be abbreviated.

Reflex defaults: auto-eat below 12 food, and also below 14 health when food is below 20 so regeneration can start; `auto` attack response fights only with a sword/axe in the hotbar and at least 8 health, otherwise flees (the event states why). Both automatic and explicitly configured fights break off and flee at 6 health or below. Food detection uses Synapse's edible metadata (including modded foods), with a vanilla-food fallback only for older payloads without that metadata. Combat pauses navigation, selects a sword/axe, aims and attacks no faster than every 600 ms, checks the actual raycast target, and stops after 15 seconds or when the mob disappears. It never deliberately attacks players or creepers. Each automatic meal produces one completion event with item, any inventory move, and observed food before/after (or a failure). Screens suppress reflexes; a screen blocking meals for more than 20 seconds at low food produces one warning until unblocked. Only hands/view/hotbar tools (`look`, `use`, `attack`, `select_hotbar`, `eat`, `open_inventory`, `close_screen`, `click_*`, `type_text`, `press_key`, `write_sign`, `stop`) take over automatic behavior; navigation, chat, waits and observations leave it running. A navigation command issued during combat or a rescue is kept paused until that reflex ends.

Survival rescue priority is lava, drowning, fire, creeper, being attacked, then eating. A higher-priority rescue interrupts a meal, fight or lower rescue; start and end emit one `reflex` event each and wake a pending `wait`. Every active rescue shares cleanup that releases keys and resumes Baritone exactly once on success, timeout, death, a screen opening, manual takeover or shutdown. Fire view/hotbar state is restored before resumption. Missing fields never default to false/zero: the affected new rescue stays off and `status` has one combined older-Synapse warning.

- **Safe-ground trail and retreat:** With `onGround`, `inWater`, `inLava` and `onFire` present, the poller retains the last 40 grounded, dry, cool positions, adding one after at least a block of movement. Retreat aims about twice a second toward the newest crumb farther from the threat, using short sprint steps, and stops at 10 blocks separation or 5 seconds. Without a qualifying crumb it walks directly away in short steps. Feet off the ground do not end it (the hit that starts a retreat throws him into the air, and jumps and steps down do the same): it begins no step in the air and waits for the ground. It ends, saying which, when he is falling (more than 2.5 blocks or faster than 0.65 blocks a tick, both beyond a jump off a one-block ledge), has had no ground for 1 s, has been afloat for half a second in water he walked into, or is in lava. Wading goes on. A retreat begun afloat swims (forward and jump) instead, and runs once his feet are down. This serves `when_attacked: "flee"`, unarmed/unhealthy `auto`, and low-health combat break-off. Against the previous mod payload none of these senses exist, so the old 60-tick sprint-away flee remains unchanged.
- **Drowning (`surface`):** If `underwater` is true and `air < maxAir / 2`, pause Baritone and hold jump in repeated five-tick steps. During a trip this is a breath: once air is back to 80% the same trip is resumed. The trip is stopped, with the numbers, on the third breath within two minutes that brought it less than 8 blocks closer (or the third at all for goals without a destination), or when 12 seconds pass without air recovering. With no trip under way the body surfaces and then makes for the latest safe crumb. The end event reports observed air before/after.
- **Lava and fire (`escape_fire`):** In lava, pause and use repeated jump+sprint steps toward the latest safe crumb until observed out (10-second timeout). Burning outside water/lava uses a hotbar water bucket when outside the Nether: select it, look straight down, place, retrieve after one second, restore slot/view and resume. Without a usable bucket the fire is only reported, without pausing navigation.
- **Creepers (`avoid_creepers`):** A creeper with `fuse: true`, or any creeper within three blocks, starts retreat before damage. Combat never attacks a creeper, including when `when_attacked` is `fight`.

`status` adds air while underwater and a burning/lava hazard line. These rescues require Synapse's `air`/`maxAir`, fluid/contact, burning, grounding and creeper-fuse fields; the older-payload fallback applies only when those senses are unavailable.

Meals use the hotbar first, otherwise open the survival inventory and swap the food stack to an empty hotbar slot (or the selected slot if full, reporting the displaced stack). They verify the hotbar and close the inventory before using food. To avoid right-clicking the crafting table/chest in front of the player instead of eating, meals aim straight up, wait two client ticks for the raycast, and restore the selected slot and aim after releasing use. Synapse's sneak movement can coexist with held use, but its acknowledgement arrives only after movement ends; it cannot guarantee sneak-before-use ordering. If a screen nevertheless appears during a meal, use is released before verified closure, one reflex event reports the failed meal, and auto-eat waits 10 seconds before trying again. This also prevents close/reopen loops. The mod's close acknowledgement now reflects the actual screen instead of unconditional success; real modpack behavior still requires live verification.

A held use lands on whatever the crosshair rests on when the hold begins, and Baritone turns the view on every tick it works. So a meal pauses Baritone while a trip is known (resumed on release, and not counted as a stall), and after looking up it reads the state back: if the view did not stay up, or an entity or a block that opens (table, chest, door, trapdoor, sign and the like, by name) is overhead, nothing is used and `Meal not started: <reason> Auto-eat retries in 10 s.` is the one event (`eat` returns the reason as its error). Death during a meal lets go of the keys and nothing else: the death screen is not treated as a screen the meal opened, nothing is clicked or closed, and the `died` event is the only word on it.

Requires Synapse's timed use/attack, `release`, sprint movement, GUI character/key input, `eye` position, and player names/hostile flags in full state. Unknown modded enemies require Synapse's hostile flag; no registry-name guessing. Minecraft server corrections, claims, food consumption and sign persistence remain authoritative. A path reports `stopped_short` after four seconds without movement **or a fresh Baritone reply**, including the last reply since that navigation started and the distance left. Mine/explore have no fixed destination, so their remaining distance is explicitly unknown. The timer is an inactivity heuristic, not direct access to Baritone's calculation state. Mining command syntax was checked against [Baritone 1.10.1 MineCommand](https://github.com/cabaletta/baritone/blob/v1.10.1/src/main/java/baritone/command/defaults/MineCommand.java).
