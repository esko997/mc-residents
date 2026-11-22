# Resident scaling: body architecture and server-side management (research, 2026-11-22)

Original research scope: decide how to grow from 2 to 6–7 residents. The research worker performed no code changes, builds, tests, SSH, ADB, client launches or restarts. Except for the implementation follow-up below, this report describes the morning research baseline, before the integration experiments. Every number was observed in the cited local evidence or primary source; anything else is marked **[INFERENCE]** or **UNMEASURED**.

Status words: **VERIFIED-SOURCE** = read in pinned upstream source for the exact or stated version; **VERIFIED-LOCAL** = observed in local evidence/logs; **[INFERENCE]**; **UNMEASURED**; **UNVERIFIED** (claim exists, not checked).

**Implementation follow-up, 2026-11-22:** real-client adapters now passed Refined Storage search/withdrawal and Mekanism side-configuration checks, including PRIVATE revocation and fail-closed non-owner TRUSTED access. A read-only observer prototype passed isolated-server checks and normal-client compatibility; it is not installed on production. See the [tool verification boundary](../full-client/toolserver/README.md#verification-boundary-2026-11-22) and [observer staging evidence](../server-observer/README.md#staging-evidence-and-remaining-checks).

The [capacity experiment](../full-client/tools/CLIENT-PROFILES.md#inspiron-result--2026-11-22) measured short single-client idle windows: the visual profile reduced mean PSS by only 74 MiB in this comparison. Three clients logged into the server, but startup was stopped at about 781 MiB available host memory, before the third body became healthy; no three-client measurement window or resident minds ran. This does not establish a hard ceiling, but does not justify adding a third resident on the current profile. All disposable units and temporary whitelist/config entries were cleaned up. CPU/GPU now have limited idle measurements; network bytes, server MSPT and sustained three-resident behaviour remain unmeasured.

---

## 1. Executive findings

1. **Do not migrate resident bodies to the server now.** For this pack, server-hosted bodies lose things the residents demonstrably use (framebuffer `picture`, client-side Baritone, real mod screens) and gain nothing in mod coverage for free: each custom mod button/packet must be re-implemented as a server-side adapter. Immersive Aircraft 1.4.0 flight is a hard counterexample: its physics and inputs run only on the pilot's own client (§4.4).
2. **No supported architecture was found for running several residents in one real Forge client, and none is defensible without a significant client rewrite.** One physical client has one logical client and one local player; Baritone 1.10.1's primary instance is "the local player created by the game itself"; Synapse uses `Minecraft.getInstance()` 21 times in 13 files. Practical multi-resident-per-process options found are (a) protocol bots (lose modded content) and (b) server-hosted bodies (the server process). §3.
3. **Recommended architecture: hybrid.** Keep real Forge clients as bodies, slim them only after measurement, distribute them across hosts at a measured density, and add a **separate, read-only, scoped server-side observer mod** for Commons/caretaker. The observer is worth considering **even without body migration** as one central, authoritative source for positions/events/facility stock. It is not the only secure cross-host path: Synapse already has an `OBSERVE` (read-only) access level, so per-host read-only collectors or tunnels are also valid (§6).
4. **Model quota is a plausible early constraint; it is unmeasured.** The shared Codex weekly meter (rounded) went 22 % → 33 % between 21:44 and 08:00 (10.3 h) with two Sol residents plus unrelated usage. Purely as an **illustrative, all-usage-attributed linear extrapolation** (not a rigorous bound, not measured resident cost, not a capacity forecast): 11 pp / (2 × 10.3 h) ≈ 0.54 pp per resident-hour, which for 7 residents over a ~13 h day would be ~49 pp/day. Stage 0 must measure the resident share. Body architecture does not eliminate LLM calls; it may change image, observation and tool round-trip volume, so there is no guaranteed saving either way.
5. **Two clients per 16 GiB Inspiron is a demonstrated configuration, not a measured capacity ceiling.** The earlier stalls (5 s Synapse main-thread timeouts, 21:25 pause) occurred under restrictive `memory.high` soft caps and did not recur after the caps were removed. Gary's client **unit** (cgroup) peaked at 5.6 GiB with a 4 GiB heap; that is not proven process RSS. No three-client run exists. "Four Inspiron-class hosts for seven residents" is a conservative two-per-host arithmetic scenario, not required capacity. CPU, GPU/VRAM, network bytes and server MSPT have **never been measured** for this stack.
6. **Server-body compatibility is mixed, not uniformly bad:** Mekanism and Refined Storage gate access by player **UUID**, and FTB Chunks only applies its fake-player policy to `instanceof FakePlayer`; a non-`FakePlayer` `ServerPlayer` body with the resident's UUID would be treated as the resident. RS Grid extraction and Mekanism side configuration (both currently awkward through the client GUI) are *easier* server-side. But Forge's own `FakePlayer` is unusable as a survival body (no tick, invulnerable, no death) and Carpet-style bodies need explicit physics ticking, a connection facade and a respawn path.
7. **Scaling issues independent of architecture:** `playersSleepingPercentage 100` (recorded in memory; verify on the server) means every resident and the human must sleep to skip night; whole-server chunk/entity load grows with every body in any architecture; Commons/caretaker/watchdog assume one host.

---

## 2. Observed baseline (what we actually know)

| Quantity | Value | Source / status |
|---|---|---|
| Client config | Forge 47.4.10 with Embeddium, Oculus, AdLods, Xaero minimap/world map, EntityCulling, JEI, Baritone standalone 1.10.1 and Synapse 1.3.0; NVIDIA GTX 1060 Max-Q OpenGL 4.6 | `final-evidence/game/logs/2026-11-21-2.log.gz` VERIFIED-LOCAL |
| Launch | PortableMC, 854×480, `-Xmx4G -Xms512m`, X11 `:0`, per-unit `CPUQuota=400%`, slice `CPUQuota=600%` on a 4C/8T i7-7700HQ | `full-client/launch.sh`, `gary-client@.service`, `residents.slice` VERIFIED-LOCAL |
| Per-client memory | Gary client **unit (cgroup)** peak 5.6 GiB against a 5.5 GiB soft cap (not proven process RSS); residents slice peak 12,891,332,608 B; 33.08 % full memory pressure over 300 s; 8 Synapse 5000 ms main-thread timeouts in 21 calls before the 21:25 pause — all **under restrictive `memory.high` caps**, which were then removed; stalls did not recur afterwards | memory page, overnight incident VERIFIED-LOCAL (not a benchmark) |
| Earlier cap episode | 5 GiB/client soft caps → ~46 % full memory pressure and repeated 5 s timeouts, no OOM | memory page VERIFIED-LOCAL |
| Demonstrated density | 2 clients + 2 minds + caretaker + Commons on one 16 GiB Inspiron for the overnight run after caps were removed; no 3-client run exists | memory page, report.md |
| Human client comparison | user's own Prism instance 9.2 GB RSS at render distance 12 (different host/settings) | memory page; not comparable to residents |
| Body call rate (**combined observation window** 00:30Z–12:59Z, i.e. the 19:30 Eastern trial session plus the 21:07:56 Eastern overnight launch) | Gary 36,445 / Margo 35,313 completed calls: ~48/min each; body-call wall time ≈ 28 % of elapsed; `look` p50 ~240 ms, `use` p50 444 ms, `status` p50 ~46 ms; `picture` 2,766 (Gary) / 1,198 (Margo) in the combined window. Overnight-only (from 02:07:56Z): 34,341 / 33,445 calls, `picture` 2,629 / 1,014 | `final-evidence/calls/*.jsonl`, computed here |
| Model usage | Gary 344.7 M input (338.8 M cached), 0.60 M output, 20 compactions; Margo 372.5 M / 366.3 M / 0.61 M, 23 compactions; context window 475 K; shared weekly meter 33 % at 08:00 (22 % at 21:44) | `final-evidence/usage.json`, report.md VERIFIED-LOCAL |
| Server host | **Historical (2026-11-20) snapshot:** pop-os 62 GiB, swap full, server container ~24 GB | memory page; current state UNVERIFIED |
| CPU per client, GPU/VRAM per client, network bytes, server MSPT/TPS per resident, mind-process RSS | — | **UNMEASURED** |

Implication: there is no defensible per-resident CPU/GPU/server-tick number and no measured capacity limit yet. The defensible statement is that two clients ran overnight on one 16 GiB Inspiron once caps were removed.

---

## 3. Can several residents share one client process? (No supported route found for real clients)

| Variant | Verdict | Evidence |
|---|---|---|
| N residents as N local players inside one Forge client | **No supported route found; would need a significant client/mod rewrite, not defensible.** | Forge docs: the logical client "accepts input from the player… runs in the Render Thread" — one per physical client ([Sides, 1.20.1](https://docs.minecraftforge.net/en/1.20.1/concepts/sides/)). Baritone 1.10.1 `getPrimaryBaritone()` is "represented by the local player that is created by the game itself, not a 'bot' player"; multi-user support was deferred to an unmerged `bot-system` ([IBaritoneProvider v1.10.1](https://github.com/cabaletta/baritone/blob/v1.10.1/src/api/java/baritone/api/IBaritoneProvider.java)). Immersive Aircraft reads global `KeyBindings.*.isDown()` when `player.isLocalPlayer()` (§4.4). Synapse: 21 `Minecraft.getInstance()` calls in 13 files (local source). |
| Several Minecraft instances in one JVM via classloader isolation | **Not a supported path; do not pursue.** | No tool found that does this for Forge 1.20.1. [INFERENCE] ModLauncher/LWJGL/GLFW state is process-global. |
| One real client "possessing" several server-side players (Advanced Fake Player) | **Not a resident solution.** | [AFP Modrinth page](https://modrinth.com/mod/advanced-fake-player): MIT, client+server required, no source URL, ops-only commands, one possessed body per controlling client. Custom mod packets are attributed to `context.getSender()` = the connection's player in Mekanism/RS handlers (§4.2–4.3) and in Forge's [SimpleImpl docs](https://docs.minecraftforge.net/en/1.20.1/networking/simpleimpl/); whether AFP re-attributes them is UNVERIFIABLE (closed source). Also time-multiplexes one GUI. |
| Many protocol bots in one process (Mineflayer etc.) | **Joins, but not this pack's content.** | Verified 2026-11-20: FML3 handshake works, but block state ids beyond vanilla are misnamed (barrel seen as soul campfire), modded entities unknown, no mod client code. |
| Many server-hosted bodies in the server JVM | The practical "many bodies, one process" option found. | §4. |

---

## 4. Server-hosted bodies: what the primary sources say

### 4.1 Body substrate

- **Forge `FakePlayer` (1.20.1) is not a survival body.** It overrides `tick()` as a no-op, `isInvulnerableTo` → `true`, `die()` no-op, `canHarmPlayer` → false, and its net handler drops every serverbound handler ([FakePlayer.java, 1.20.1](https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/src/main/java/net/minecraftforge/common/util/FakePlayer.java)). VERIFIED-SOURCE.
- **Carpet's approach (Fabric) shows the work a real body needs**: `placeNewPlayer(new FakeClientConnection(...))`, a tick that calls `super.tick()` **and** `doTick()` and periodically `resetPosition()`/`getChunkSource().move(this)`; death calls `kill()` (removal) rather than respawning ([EntityPlayerMPFake 1.4.112](https://github.com/gnembon/fabric-carpet/blob/1.4.112/src/main/java/carpet/patches/EntityPlayerMPFake.java)). Its connection sets an `EmbeddedChannel` because otherwise `isOpen` is false and e.g. ender pearls do not teleport the fake ([FakeClientConnection](https://github.com/gnembon/fabric-carpet/blob/1.4.112/src/main/java/carpet/patches/FakeClientConnection.java)). VERIFIED-SOURCE; Fabric only, Carpet 1.4.112 is the 1.20.1 line.
- [INFERENCE] For real players, the movement/`aiStep` half of the player tick (travel, hunger via `Player.tick`) is driven by client move packets; a server body must drive it explicitly, as Carpet does. Physics, fall damage, drowning and hunger then happen server-side with vanilla semantics, but **respawn, bed spawn and death-screen semantics must be implemented** (Carpet does not).
- **Forge `NetworkHooks.openScreen`** creates the server menu, sends `OpenContainer` to `player.connection.connection`, then sets `player.containerMenu` and fires `PlayerContainerEvent.Open` ([NetworkHooks 1.20.1](https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/src/main/java/net/minecraftforge/network/NetworkHooks.java) L192–219). VERIFIED-SOURCE. So a server body *can* open modded slot menus and click slots through the menu; the connection facade must accept and discard client-bound packets without queueing them [INFERENCE: a closed `Connection` queues packets].
- **Pathfinding:** Baritone is a client mod. Automatone (server-side Baritone fork) is Fabric, `minecraft_version=1.18`, last push 2024-01-21, self-described experimental with "strange bugs… in heavily modded environments" ([Automatone](https://github.com/Ladysnake/Automatone)). No Forge 1.20.1 server-side pathfinder was found. A server body therefore needs a new pathfinder or a port, running on/against the server thread.
- **Open Companions / VoxelMind:** [CurseForge](https://www.curseforge.com/minecraft/mc-mods/open-companions) now lists Open Companions as *unlisted*, "Final version, no longer developed", 0.6.0, **Fabric, Minecraft 1.21 to 26.2**, Java 21/25, Fabric API required on dedicated servers; LLM "thinking" runs inside the mod. No source link on the page; not on Modrinth. [voxel-mind.com](https://voxel-mind.com/) is a standalone Windows colony sim by Nyvoro UG in closed beta, not a Minecraft mod. Neither is usable on Forge 1.20.1; no source was reviewed (none accessible). Design lessons only: real player bodies, labelled `[AI]`, LLM inside the server process (rejected here, §7).

### 4.2 Mekanism 10.4.16.80 (tag `v1.20.1-10.4.16.80`)

- Security: `SecurityUtils.canAccess(Player, …)` = `isOp(player) || canAccess(player.getUUID(), …)`; ops bypass only when `opsBypassRestrictions` is on **and** the permission node is granted; modes PUBLIC/PRIVATE/TRUSTED keyed by owner UUID ([SecurityUtils](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/common/util/SecurityUtils.java) L56–60, 70–130). VERIFIED-SOURCE. A `ServerPlayer` body with the resident's UUID inherits the resident's ownership/trust; residents must not be ops.
- GUI buttons: `PacketGuiInteract.handle` takes `context.getSender()`, resolves the tile **by position from the sender's level** and invokes an enum interaction (redstone control, security mode, QIO toggles, container tracking…) ([PacketGuiInteract](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/common/network/to_server/PacketGuiInteract.java) L99–118, 175+). Side configuration likewise in [PacketConfigurationUpdate](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/common/network/to_server/PacketConfigurationUpdate.java) L65–70. VERIFIED-SOURCE. In the lines read, these handlers do **not** themselves check reach or that the menu is open (individual interactions such as `incrementSecurityMode` do check security). Consequence for any server-side adapter: it **must add its own reach + open-menu + security checks**, or it becomes a remote-control capability no real player has.
- Gain: side config and redstone/security buttons are a fixed enum → a server body (or a client-side packet sender) can drive them without screen-coordinate guessing. Loss: every other custom button needs its own adapter.

### 4.3 Refined Storage 1.12.4 (tag `v1.12.4`)

- `GridItemPullMessage.handle` enqueues work, requires `player.containerMenu instanceof GridContainerMenu`, then `grid.getItemHandler().onExtract(player, id, -1, flags)` ([GridItemPullMessage](https://github.com/refinedmods/refinedstorage/blob/v1.12.4/src/main/java/com/refinedmods/refinedstorage/network/grid/GridItemPullMessage.java)). `ItemGridHandler.onExtract` checks `SecurityManager.hasPermission(Permission.EXTRACT, player)`, INSERT for inserts, AUTOCRAFTING for crafting ([ItemGridHandler](https://github.com/refinedmods/refinedstorage/blob/v1.12.4/src/main/java/com/refinedmods/refinedstorage/apiimpl/network/grid/handler/ItemGridHandler.java) L127–316). `SecurityManager.hasPermission` keys cards by `player.getGameProfile().getId()` with a global-card fallback ([SecurityManager](https://github.com/refinedmods/refinedstorage/blob/v1.12.4/src/main/java/com/refinedmods/refinedstorage/apiimpl/network/security/SecurityManager.java) L26–43). VERIFIED-SOURCE.
- Parent's verified client finding: `GridScreen` uses a separate `IGridView`/`getStacks`, not `menu.slots`; Synapse sees only slots and top-level widgets. So RS Grid search/withdraw is a **client-side gap today** and a **server-side easy path** (direct `onExtract` with the open grid menu, same permission checks). Either a client-side "send the mod's own packet" adapter or a server adapter preserves RS security; neither is free.

### 4.4 Immersive Aircraft 1.4.0+1.20.1 (commit `7fc17537…`)

- `VehicleEntity.tick`: velocity, boost, controller and `move(...)` run only `if (isControlledByLocalInstance())` (L404–415); pilot inputs come from `KeyBindings.left/right/up/down/push/pull/forward/backward.isDown()` only when the pilot `isLocalPlayer()`, else `setInputs(0,0,0)` (L506–522); collision damage is computed `level().isClientSide` and sent to the server as `CollisionMessage` (L740–752, [CollisionMessage](https://github.com/Luke100000/ImmersiveAircraft/blob/7fc175372d3930773d625d507cb5c772f316fea9/common/src/main/java/immersive_aircraft/network/c2s/CollisionMessage.java)); engine power arrives as `EnginePowerMessage` ([VehicleEntity](https://github.com/Luke100000/ImmersiveAircraft/blob/7fc175372d3930773d625d507cb5c772f316fea9/common/src/main/java/immersive_aircraft/entity/VehicleEntity.java)). VERIFIED-SOURCE.
- Parent-verified: `KeyBindings` uses `FallbackKeyMapping` onto vanilla options; dismount is a separate key **R** (boost **B**). The published changelog shows the airborne R-dismount confirmation dates from 0.7.0 (historical), not new in 1.4.0; it is still present behaviour, so simple sneak input is not sufficient aircraft support.
- Consequence: a server-hosted pilot is never "local", so **the aircraft would not fly** without a server-side re-implementation of the client flight model and crash damage. On real clients it is reachable but needs key-level input (R/B/vehicle controls), not just sneak. Current Synapse `move` swaps `LocalPlayer.input` and sets `shiftKeyDown`; no resident-facing dismount/vehicle tool and no vehicle identity in state (parent-verified).
- Vanilla boats/minecarts: [INFERENCE, not verified against decompiled 1.20.1] boats follow the same client-authoritative pattern; minecarts move server-side; dismount is a shift input processed server-side. Test, do not assume (§8 rows V1–V3).

### 4.5 Immersive Engineering 10.2.0-183, claims and other pack mods

- IE Engineer's Hammer forms multiblocks in `HammerItem.useOn` via `mb.createStructure(world, pos, side, player)` with a `ServerPlayer` branch ([HammerItem](https://github.com/BluSunrize/ImmersiveEngineering/blob/10.2.0-183/src/main/java/blusunrize/immersiveengineering/common/items/HammerItem.java) ~L106–152); IE keeps its own fixed-profile `FakePlayer` for automation ([FakePlayerUtil](https://github.com/BluSunrize/ImmersiveEngineering/blob/10.2.0-183/src/main/java/blusunrize/immersiveengineering/common/util/FakePlayerUtil.java)). VERIFIED-SOURCE. [INFERENCE] IE slot menus (coke oven, cloche, workbench) work as ordinary menus; the IE manual is client-only.
- **FTB Chunks 2001.3.7:** protection treats a player as fake via architectury `PlayerHooks.isFake`, which on Forge is `instanceof FakePlayer` ([PlayerHooksImpl, branch 1.20](https://github.com/architectury/architectury-api/blob/1.20/forge/src/main/java/dev/architectury/hooks/level/entity/forge/PlayerHooksImpl.java); not pinned to the installed 9.2.14). Fake players are denied by default (`def_fake_players=false`), with allow-by-ally-ID default true and a global `fake_players` override ([FTBChunksWorldConfig](https://github.com/FTBTeam/FTB-Chunks/blob/v2001.3.7/common/src/main/java/dev/ftb/mods/ftbchunks/FTBChunksWorldConfig.java) L24–60; [ClaimedChunkManagerImpl](https://github.com/FTBTeam/FTB-Chunks/blob/v2001.3.7/common/src/main/java/dev/ftb/mods/ftbchunks/data/ClaimedChunkManagerImpl.java) L205–224; [ChunkTeamDataImpl](https://github.com/FTBTeam/FTB-Chunks/blob/v2001.3.7/common/src/main/java/dev/ftb/mods/ftbchunks/data/ChunkTeamDataImpl.java) L299–315). VERIFIED-SOURCE. ⇒ a body must be a plain `ServerPlayer` subclass, **not** a Forge `FakePlayer`, to keep the resident's own claim rights and no more.
- SecurityCraft, Sophisticated Backpacks (keybind-opened), Waystones (selection screen), TaCZ, Occultism, Curios: UNVERIFIED for server bodies; each uses its own keybinds/packets [INFERENCE] and would need per-mod adapters.

### 4.6 Identity, rollback, persistence

[INFERENCE, standard vanilla behaviour, verify in staging] A `ServerPlayer` placed through `PlayerList` with the resident's offline UUID loads and saves the same `world/playerdata/<uuid>.dat`, advancements and stats as the real client, so moving a resident between client and server body is reversible **if** both never run concurrently (a duplicate login replaces the older session). Mekanism/RS/FTB ownership is UUID-keyed and unaffected. Rollback set per resident: `playerdata/<uuid>.dat`, `advancements/<uuid>.json`, `stats/<uuid>.json`, FTB team data, plus the off-world mind/notes repo (unchanged by body type).

---

## 5. Decision matrix

Legend: ✔ works/verified, ◐ partial or needs work, ✘ lost/blocked, ? unmeasured.

| Criterion | (1) Distributed full clients (today ×N hosts) | (2) Slim / headless real clients | (3) Server-hosted ServerPlayer bodies | (4) Hybrid: real clients + server observer (+ optional narrow server adapters) |
|---|---|---|---|---|
| Real mod menus/packets (Mekanism, IE, RS screens) | ✔ client runs mod code; RS Grid and Mekanism side-config still need client adapters | ✔ same as (1) if screens init without render; HeadlessMC LWJGL stubbing removes rendering | ◐ slot menus via server menu; every custom button/packet = new adapter; Mekanism enum + RS `onExtract` are tractable | ✔ as (1); server adapters optional for RS/Mekanism with explicit reach/security checks |
| `picture` (combined window 2,766 + 1,198 calls; overnight-only 2,629 + 1,014) | ✔ | ◐ lost under LWJGL stubbing; kept with low-res real rendering | ✘ no framebuffer | ✔ |
| Pathfinding | ✔ Baritone 1.10.1 (client thread pool) | ✔ | ✘ needs new/ported server pathfinder (Automatone is Fabric 1.18) | ✔ |
| Vehicles: Immersive Aircraft | ◐ reachable, needs key input (R/B) | ◐ same | ✘ physics/inputs client-only (VERIFIED-SOURCE) | ◐ as (1) |
| Survival semantics (hunger, damage, sleep, death/respawn) | ✔ vanilla, death screen respawn | ✔ | ◐ must drive tick + implement respawn; FakePlayer unusable | ✔ |
| Claims / ownership | ✔ real player | ✔ | ◐ ✔ only if not `FakePlayer`; then identical to the resident | ✔ |
| RAM per resident | client unit (cgroup) peak 5.6 GiB under soft caps, not proven RSS; density beyond 2/host unmeasured | ? reduction UNMEASURED | ? moves into server heap (pop-os was swap-full in the historical 2026-11-20 snapshot) | as (1)/(2) + small observer ? |
| GPU | ? unmeasured, 1060 Max-Q shared by 2 | ? lower | none | as (1)/(2) |
| Server tick | ? per-body chunk load exists in all options | same | ? adds body tick + pathfinding + adapters to the server thread | observer adds bounded work ? |
| Network | ? world stream per client over Wi-Fi | ? lower with smaller view distance [INFERENCE] | none client-side | as (1)/(2) |
| Failure isolation | ✔ a hung client loses one resident; server unaffected | ✔ | ✘ a bug/stall hits the human's game and every resident | ◐ observer runs in server JVM: must be budgeted, kill-switchable |
| Ops complexity at 7 | ◐ conservative two-per-host arithmetic scenario = 4 hosts (not a measured requirement); per-host locks, watchdog, Commons reach | ◐ fewer hosts if slimming/density measurements allow | ◐ one place, but a new server mod + restarts of the shared server | ◐ hosts as (1)/(2); observer centralizes webapp data |
| Model cost / quota | LLM calls remain in every option; ~48 body calls/min/resident observed with real clients | no guaranteed change; image volume may differ | no guaranteed saving: no images, but observation/tool round trips and adapter results differ; measure | as (1)/(2) |
| Implementation size | none new | small/medium | **large**: body, connection facade, respawn, pathfinder, per-mod adapters, API | medium (observer) |
| Evidence status | 11 h overnight run | none | source reading only | source reading only |

---

## 6. Server-side management mod (independent of body migration)

**Why consider it:** Commons reads each resident's Synapse at `http://127.0.0.1:25599`-style loopback URLs with the resident client's token (`commons/src/config.ts` L73–89); Synapse binds 127.0.0.1 by default and a full token grants body control (`SynapseConfig` L43–44; NOTES-dedicated-server §risks 5). Distribution does **not** force LAN exposure of full-control tokens: Synapse has an `OBSERVE` (read-only: state, gui/chat reads, screenshot, wait) access level (`config/AccessLevel.java` L11–20), so per-host read-only collectors or authenticated tunnels are a valid alternative. A server observer is attractive as **one central, authoritative source** for positions/events/facility stock regardless of where bodies run, including data no client sees; it is one option, not the sole secure cross-host path. It replaces nothing a resident does.

**Required properties** (assessment, not a schema):

| Property | Concrete requirement | Basis |
|---|---|---|
| Read-only | No world writes, no commands, no inventory changes. Commons' existing RCON `POST command` stays a human-only admin path and is never exposed to residents or the caretaker. | Commons README L218–248 |
| No forced loading | Observe only chunks already loaded by someone; for unloaded registered facilities report "unobserved since T", never load them. Use a non-loading chunk lookup [verify the exact 1.20.1 API in staging]. Acceptance: forceloaded/loaded-chunk counts unchanged with observer on vs off. | user requirement |
| Scope | Residents (online bodies) and **registered facilities only**; no world scans for ores/structures. | user requirement |
| Two audiences | Caretaker/operator scope may read facility stock and events. **Resident-facing data must be what that resident could physically perceive** (e.g. book text only when within reach and permitted). Never return undiscovered resources or other residents' private notes/containers. | user requirement |
| Identity-bound scopes | One credential per consumer: operator, caretaker, and per-resident tokens mapped to that resident's UUID; a resident token can only ask about its own online `ServerPlayer`. | [INFERENCE] |
| Permission checks for resident reads | Re-use the game's own checks: reach distance, claim/team permission (FTB Chunks), container ownership (Mekanism/RS UUID checks), lectern/shelf access. The user's ~1-block proximity idea is a policy value, not settled. | §4.2–4.5 |
| Tick-thread safety | Read game state only on the server thread (`server.execute` / Forge `enqueueWork` pattern per [SimpleImpl docs](https://docs.minecraftforge.net/en/1.20.1/networking/simpleimpl/)), in a per-tick time budget at low cadence; serialize and serve off-thread; bounded queues dropping oldest. | Forge docs |
| Snapshots / events | Each snapshot carries game tick, wall time, schema version; events carry a monotonic sequence id so Commons can resume after reconnect and detect gaps. | [INFERENCE] |
| Transport | Bind loopback on pop-os, reach it through an authenticated channel (SSH tunnel/WireGuard or TLS with tokens); never plain-HTTP full-trust on the LAN. | NOTES risk 5 |
| Failure isolation | Catch-all around every handler, config kill switch, no blocking I/O on the server thread, observer failure must leave the game unaffected. Measure its MSPT cost with spark (spark 1.10.53-forge is in the pack cache; server presence UNVERIFIED; [spark tps/tickmonitor docs](https://spark.lucko.me/docs/Command-Usage)). | |
| Client-optional | Server-only mod that registers no blocks/items/channels clients need, so clients join without it. Confirm with `displayTest`/handshake in staging. | [INFERENCE] from [mods.toml docs](https://docs.minecraftforge.net/en/1.20.1/gettingstarted/modfiles/) |

Library/noticeboard projection (parent owns design): server-side is the right authority for "which books are physically on registered shelves now", because it can read block-entity inventories in loaded chunks without OCR and without the resident's client. Keep caretaker-observed holdings separate from what any resident has read.

---

## 7. Recommendation

**Choose (4) hybrid with (1)/(2) bodies.**

1. **Before adding hosts:** measure (Stage 0). Model quota is a plausible early constraint (unmeasured); hardware density is also unmeasured.
2. **Bodies stay real Forge clients.** Try slimming on a disposable identity: drop client-only visual mods (candidates: Oculus, AdLods — its `mods.toml` declares `displayTest="IGNORE_SERVER_VERSION"`, Xaero maps if Commons/residents do not depend on them), minimum useful render distance, test heap 3 vs 4 GiB. Keep real rendering at low resolution so `picture` and screen init still work; do **not** use HeadlessMC LWJGL stubbing unless `picture` is dropped deliberately.
3. **Distribute at measured density:** two per 16 GiB host is the demonstrated configuration; a conservative two-per-host plan for 7 would be 4 Inspiron-class hosts, but that is arithmetic, not a measured requirement. Test three clients per host in Stage 1 before planning hosts. Prefer wired Ethernet where possible (network UNMEASURED).
4. **Build the read-only server observer** for Commons/caretaker (§6), staged on a server copy first.
5. **Server-hosted bodies: experiment only (Stage 3), never a migration of Gary/Margo until every "must" row passes.**

**Do NOT migrate:**
- Resident bodies of existing residents (Gary, Margo) or any resident with real identity until rollback is rehearsed.
- Vehicles/aircraft control, screenshots/`picture`, Baritone navigation, generic mod screens to the server.
- Minds/LLM calls into the server JVM (Open Companions' in-mod thinking model); minds stay off-server and restartable.
- RCON/admin commands into any resident or caretaker path; no `/give`, `/tp`, `/setblock` as substitutes for survival actions.
- Forge `FakePlayer` as a body type (invulnerable, no tick, no death; FTB Chunks denies it by default).

---

## 8. Staged proof-of-compatibility plan (no execution authorized)

Common rules: staging copy of the world and pack (not the live pop-os server) for Stages 2–3; test identities only (e.g. `gary_fc_test`, new offline names), never resident UUIDs; disposable test structures, vehicles, machines and networks built for the test only — never the user's or residents' builds, railway, possessions or claims; back up per-identity files before every stage; never run a client and server body for the same UUID concurrently; device locks and `agent-heavy` as per global policy; record raw measurements, no "looks fine".

| Stage | Bounded work | Exit evidence |
|---|---|---|
| 0. Measure current stack (next authorized run, no code) | Per-process RSS/PSS and CPU (client, mind, caretaker, Commons) every 60 s; `nvidia-smi` VRAM/util per client; per-client network bytes; server MSPT/TPS via spark if installed on server; Codex quota delta with other usage paused or logged. | A table per resident-hour; quota share attributable to residents |
| 1. Slim client A/B (one disposable identity, Inspiron) | Variants: baseline / minus visual client-only mods / lower render distance / 3 GiB heap. Then 3 clients concurrently only if memory headroom shown. | Functional rows F1–F12 below pass identically; peak RSS, main-thread timeout count, VRAM |
| 2. Read-only observer on staging server | §6 properties. | O1–O6 below |
| 3. Server body on staging server (only if user approves building it) | Non-`FakePlayer` ServerPlayer body for a test UUID; minimal walk/use/menu API; no pathfinder beyond straight lines. | S-rows below; MSPT per body |

**Acceptance matrix** (each row run on the real client baseline and, where applicable, the server body; owned/shared setups mirror Gary/Margo's real arrangements):

| ID | Scenario (real pack content) | Pass criterion | Expected server-body result from sources |
|---|---|---|---|
| F1 | Walk, jump, fall damage, drown/surface, hunger drain and eat | Server-side health/food values match client baseline over 10 min | ◐ needs explicit tick |
| F2 | Sleep in own bed at night; respawn at bed after death; recover drops | Spawn point and item recovery identical | ◐ respawn must be built |
| F3 | Vanilla crafting table + 2×2 inventory crafting, chest deposit/withdraw | Exact item counts server-side | ✔ via menu |
| F4 | Mekanism Heat Generator → Metallurgic Infuser (generator front facing infuser), insert coal/redstone/iron, take infused alloy | Alloy count, energy present | ✔ slots |
| F5 | Mekanism security: machine owned by test A set TRUSTED/PRIVATE; test B tries to open | PRIVATE denied, TRUSTED allowed per trust list | ✔ UUID-keyed |
| F6 | Mekanism side config (eject output) and redstone control button | State changes, persisted; adapter enforces reach+open menu | ◐ adapter; handler has no reach check |
| F7 | RS Controller + Grid + Security Manager: card for test B with EXTRACT only | B extracts 1 named item via Grid search; INSERT denied | ◐ easy server-side; client needs adapter |
| F8 | IE Coke Oven, Engineer's Hammer multiblock formation, Garden Cloche | Structure formed, coke/creosote produced | ✔ [INFERENCE] |
| F9 | FTB Chunks: claim by team A; B not ally → block break/open denied; ally → allowed | Same as real player | ✔ only if not FakePlayer |
| F10 | Nether portal round trip; Waystones travel | Dimension change, inventory intact | ? |
| F11 | Sophisticated Backpack open via keybind; Curios slot | Opens, items move | ✘/adapter |
| F12 | Signs and book: write/sign a book, place in chiseled bookshelf/lectern | Text retrievable structurally | ◐ |
| V1 | Minecart ride on a disposable test rail line built for the test + dismount | Arrives, dismounts at destination | ? test |
| V2 | Vanilla boat across water + dismount | Moves, dismounts | ✘ [INFERENCE] client-authoritative |
| V3 | Immersive Aircraft: board, engine on, take off, land, R dismount (airborne confirm) | Completes without crash damage | ✘ server; ◐ client needs key input |
| O1 | Observer: positions/dimension for all online residents | Matches clients within 1 s | — |
| O2 | Registered facility stock (chest, RS network count, Mekanism slot) in loaded chunks | Matches screens; unloaded → "unobserved since T" | — |
| O3 | Loaded/forceloaded chunk counts with observer on vs off | Identical | — |
| O4 | Resident-scoped book read: within reach + permitted ✔; out of reach or in another team's claim ✘ | Denials logged | — |
| O5 | MSPT impact with observer on (spark) | Measured, recorded; budget set by user | — |
| O6 | Kill switch / exception injection | Game unaffected, observer reports degraded | — |
| R1 | Rollback: client → server body → client for test UUID | Inventory, XP, advancements, Mekanism/RS/FTB ownership unchanged | ✔ [INFERENCE] |

Go/no-go for any server-body use: F1–F9 and R1 must pass, V-rows are allowed to fail only if residents keep real clients for vehicles, and MSPT per body must be measured and accepted by the user.

---

## 9. Gains and losses summary

| Option | Gains | Losses |
|---|---|---|
| Distributed full clients | Proven 11 h; full mod fidelity; isolated failures; no server change | Client unit peak ~5.6 GiB under caps (not RSS); 2/host demonstrated, higher density untested; per-host locks/watchdogs; Commons needs cross-host reach (read-only collectors or observer) |
| Slim clients | Same fidelity if rendering kept; possible density gain (UNMEASURED) | Risk of breaking screens/handshake; `picture` lost if LWJGL stubbed |
| Server bodies | No client JVM/GPU; authoritative state; easy RS Grid/Mekanism enum actions; one process | Large new code inside the shared server; no Baritone, `picture`, aircraft/boats; per-mod adapters; server-wide blast radius on pop-os (historically swap-full, 2026-11-20 snapshot); respawn/connection facade to build |
| Hybrid observer | Commons/caretaker independent of body hosts; least-privilege data; library/stock projection | New server mod and restart; must be budgeted, scoped and kill-switchable |

## 10. Open questions (decisions, not blockers)

Already answered by the user and not open: more laptops are available; API keys are the intended eventual model route.

1. During Stage 0, how should resident model usage be attributed (current shared Codex pool now, API keys later) so per-resident cost is measured rather than extrapolated?
2. Confirm the server's current `playersSleepingPercentage` (recorded as 100) and whether the value should change at 7 residents.
3. For cross-host observation: read-only per-host collectors using Synapse `OBSERVE`, a central server observer, or both?
4. Which machine should host the staging world copy for Stages 2–3 (pop-os memory state is a historical 2026-11-20 snapshot; recheck before choosing)? Whether the extra laptops have wired Ethernet affects network measurements.
5. Should `picture` remain a resident capability (it decides whether LWJGL stubbing is ever acceptable)?
6. Which pack features must residents use at 7 (aircraft, backpacks, waystones, SecurityCraft)? Each unsupported one is an adapter cost in any architecture.

## Sources read locally

`~/Documents/SilverBulletAiMemory/Memory/minecraft-model-players.md`, `Memory/inspiron-agent-host.md`; `full-client/{launch.sh,gary-client@.service,residents.slice}`, `full-client/toolserver/{src/tools.ts,README.md}`, `full-client/commons/{README.md,src/config.ts}`; `~/Repos/synapse-forge` (`NOTES-dedicated-server.md`, `SynapseConfig.java`, `PlayerController.java`, `ScreenshotHandler.java`); `~/.cache/minecraft-review/2026-11-22/{report.md,final-evidence/}`; `.cache/mods` (110 jars, `mods.toml` of AdLods), `.cache/knowledge.sqlite` (11,719 items, 11,480 recipes, 846 guides); `research/modded-client.md`.
