# After the overnight run: settlement and body design

2026-11-22. Investigation and proposals, **not deployed changes**. No resident restarted and no world edited. Scaling architecture is a separate, user-requested OMP Opus 5.5 investigation.

## Purpose and the owner's observation

The owner found the residents' accomplishments impressive, but their settlement cramped, difficult to traverse, and hard to read as a place. The objective is a growing, inhabited village/town/city, not an aesthetic score or maximum production. Ordinary human navigation matters; architectural style remains theirs to choose.

Recommended framing: **make shared places usable by neighbours and visitors who do not know their coordinates or use a pathfinder**. This supplies a real audience and reason for design without assigning a creativity chore.

- Offer, rather than assign, a shared settlement-improvement project: a route connecting their homes, pantry and workshop; recognisable entrances; signs and agreed place names; room to stand, pass and maintain machinery.
- Invite Gary to host a walk and Margo to show a working machine. Their visitor's actual trouble finding/reaching/using it is useful feedback. No routine tour/report requirement.
- Make visual inspection useful when choosing a site or presenting a build: an entrance-level view and an ordinary walk reveal things a coordinate/inventory summary does not. Do not impose screenshot quotas or a beauty score.
- Teach an optional build pattern: choose site → reserve approach and working space → establish floor/terrace and services → install equipment → enclose/decorate if desired. Retain landscape and terraces; do not require flattening everything or impose a house template.
- Shared project evidence can be “a neighbour reached and used it without digging, scaffolding or being told a hidden route,” not “looks attractive.” Such criteria fit shared facilities, not every private experiment.
- Leave room for later rebuilding. Existing improvisation is the settlement's history, not a mistake to demolish wholesale.

### The body currently changes what counts as an easy route

`full-client/tools/baritone-settings.ts` sets `allowBreak true` and `allowPlace true`; constructed-block avoidance is a cost heuristic, not protection. `go_to` has no walk-only option. Caretaker reports include digging below pig/chicken gates, cutting stair treads and removing rail supports. A pathfinder that repairs or excavates its own shortcuts can conceal poor human access and damage good routes.

Recommended first navigation change: explicit **travel without breaking/placing** for built areas, with excavation a deliberate operation rather than a silent travel fallback. Scope and restore Baritone settings on completion/cancellation/death; avoid making mining or genuine wilderness excavation impossible. A route failure must report the obstruction, not silently re-enable digging. Protecting only distinctive constructed block IDs cannot protect dirt foundations or distinguish placed cobblestone from terrain. A future server placement/area record can help, but is not needed for the initial walk-only control.

## Vehicles: missing controls, not missing intelligence

Verified local source:

- Synapse `PlayerController.use` already uses normal entity interaction for mounting.
- `PlayerController.move` supports bounded sneak input through `LocalPlayer.input`, but the resident MCP exposes neither that input nor a dismount tool.
- `press_key` is a **GUI-screen** key callback, requires an open screen, and is not a gameplay keybinding API. Merely adding SHIFT or R to its enum would not implement dismounting.
- Resident `State` lacks vehicle/rider identity, so current `use` feedback cannot reliably confirm boarding or exiting.
- Installed Immersive Aircraft is **1.4.0+1.20.1 Forge**. Its exact source maps Forge flight controls through Minecraft key mappings, with separate dismount R and boost B defaults. Its release notes document airborne dismount confirmation and a reminder when Shift is attempted. Scripted vanilla player input alone does not establish aircraft compatibility.

Recommended implementation: observe mounted entity/seat state; add mount/dismount operations through ordinary gameplay controls; verify changed rider state before reporting success. Add bounded, automatically released gameplay keybinding control for mod-specific inputs, using configured actions rather than assuming physical key defaults. Aircraft needs explicit fuel/control/landing knowledge and an airborne-exit warning/confirmation, not an automatic emergency eject. Teach separate minecart/boat and aircraft procedures only after live verification.

Acceptance: enter and exit a stationary cart and boat without breaking either; controlled aircraft boarding, fuelling, takeoff, landing and exit on a disposable test account; reject stale target/screen state; inputs release on timeout/disconnect. Do not use residents' possessions or launch their minds as the test fixture.

Sources:
- [Installed Aircraft release and dismount history](https://www.curseforge.com/minecraft/mc-mods/immersive-aircraft/files/6972825)
- [Aircraft exact-version key mappings](https://github.com/Luke100000/ImmersiveAircraft/blob/7fc175372d3930773d625d507cb5c772f316fea9/common/src/main/java/immersive_aircraft/client/KeyBindings.java)

## Refined Storage and Mekanism: semantic GUI access

The current Synapse GUI observer reads vanilla container `menu.slots` and top-level `AbstractWidget` objects. `clickButton` accepts only `AbstractButton`. Resident `screen` prints only widgets marked button/editable; other widgets are omitted. Backend coordinate `clickAt` exists, but the resident MCP does not expose it.

**RS 1.12.4:** Grid results are a separate `IGridView`/`IGridStack` collection, not the ordinary menu slots. `GridScreen.mouseClicked` selects the displayed stack identity and sends `GridItemPullMessage`; the server handler requires an open `GridContainerMenu` and delegates extraction to the grid handler. This explains why ordinary inventory deposits can work while network retrieval is unavailable. The existing exporter-to-chest workaround is useful, not a completed Grid implementation.

Recommended adapter: expose search, displayed result identity/count, and withdrawal through the open authorized Grid's normal action path. Keep result identity distinct from inventory slot number; preserve item variants/NBT, sorting changes, cursor state and partial transfers. Confirm inventory/network changes after one action; do not repeat an unacknowledged withdrawal automatically. Respect the mod's ordinary security and access rules. This need not expose an omniscient remote inventory API.

**Mekanism 10.4.16.80:** `GuiSideConfigurationTab` opens a `GuiSideConfiguration` window through `onClick`. Its hierarchy ends in `GuiElement extends AbstractWidget`, **not AbstractButton**; nested children are also part of this custom GUI system. The existing button-only contract cannot operate it correctly even when a picture shows the tab.

Recommended adapter: report and activate the actual configuration tab/window and its transport-specific side/eject state. Identify the machine and orientation, make one legitimate configuration change, then read back the state and prove material transfer. Do not confuse an open tab or a successful input event with working automation. A guarded coordinate-click tool is a useful general escape hatch, not a substitute for reliable structured controls for these heavily used mods.

Network integration should begin with agreed import/export boundaries and a small transfer test, not merging everything by default. Distinguish owner permissions, shared stock and resident reserves; preserve existing networks and rollback.

Sources:
- [RS GridScreen v1.12.4](https://github.com/refinedmods/refinedstorage/blob/v1.12.4/src/main/java/com/refinedmods/refinedstorage/screen/grid/GridScreen.java)
- [RS extraction message](https://github.com/refinedmods/refinedstorage/blob/v1.12.4/src/main/java/com/refinedmods/refinedstorage/network/grid/GridItemPullMessage.java)
- [Mekanism side configuration tab](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/client/gui/element/tab/window/GuiSideConfigurationTab.java)
- [Mekanism window creation](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/client/gui/element/tab/window/GuiWindowCreatorTab.java)
- [Mekanism widget base](https://github.com/mekanism/Mekanism/blob/v1.20.1-10.4.16.80/src/main/java/mekanism/client/gui/element/GuiElement.java)

## What the caretaker surfaced

Final evidence is retained locally at `/home/swatson/.cache/minecraft-review/2026-11-22/final-evidence/`.

- **23:36 Margo:** caretaker identified a `look` interrupting surfacing at air −2/300; health fell to8/20 before later recovery. Source corroborates the mechanism: `look` is a takeover tool; `Body.manualAction` unconditionally finishes a rescue. Ordinary looking should not silently cancel life-preserving movement. Explicit overrides can remain possible, with clear consequences.
- **06:07 Gary:** retreat timed out after5.3s with a skeleton still2blocks away, followed by death. Current retreat ends at5s and steers toward a favourable breadcrumb or directly away from the threat. This is not proof that the escape route is clear or viable. Investigate obstruction and actual separation progress; increasing the timeout alone is not a demonstrated fix.
- **Guide research:** final database has7gaps:3published,4unavailable. The minecart request exhausted3attempts with `Invalid unavailable reason`; three technology requests exhausted3attempts because a cited source lacked an accepted completed public page visit in the trace. Current validator limits unavailable reasons to240characters and accepts only specific successful web-result shapes. The saved error cannot distinguish an overlong/malformed reason, failed source retrieval, URL mismatch or an unrecognised trace shape. Do not assert which occurred without the raw research output.
- Research traces are ephemeral and deleted by `TemporaryDirectory`; retain bounded, private diagnostic evidence for failures, separate retrieval/provenance failures from answer-format failures, and expose actionable reasons. Keep the completed-source requirement; do not publish guesses to make the queue look healthy. A body limitation should also enter the maintainer queue, not repeatedly trigger wiki research.

## Physical writing and libraries

Start with three concepts rather than a single mutable text database:

1. **Working documents:** editable books-and-quills for ledgers, lists, correspondence and drafts. Concurrent edits use a revision/content-hash precondition; stale edits fail without overwriting another person's contribution.
2. **Published editions:** ordinary signed books, immutable. Corrections produce a new edition or errata; old editions remain only where physical copies remain. Publication is an explicit action, not an automatic conversion.
3. **Public notices:** a finite-capacity board with separate notices and ordinary posting/removal rights. Public requests and offers remain voluntary; posting does not assign work or become a server-enforced law. Editable notices can coexist with published documents rather than making every shopping list a signed book.

Text tools should read/write directly, with server-validated resident identity, loaded-world target, reach/access and the actual held/lectern/shelf item. Keep normal inventory consumption and signing semantics. Humans must be able to use the same artifacts. The dashboard is a permission-filtered observation surface, not automatic publication of private drafts. A server companion mod is useful here independently of replacing client bodies.

**Library registration:** register a building/area plus actual participating shelves, not every book carried through its bounding box. Minecraft1.20 chiseled bookshelves already provide six physical slots; normal decorative bookshelves are not book inventories. More shelves mean more capacity. The database is a projection of current physical holdings, not the source of book text.

- Shelved book arrives → index its physical copy, edition/text and shelf slot.
- Last library copy leaves → remove that content from the live library index/search/cache; text remains on the item. Another still-shelved copy keeps the edition available.
- Moving between shelves should not lose text or invent a new authored edition. Copies require distinct physical-instance handling; a blindly copied custom UUID is not sufficient identity.
- Capture changes from humans, residents, hoppers and block breaking. Reconcile loaded shelves after restart/event gaps. An unloaded chunk is **unknown/stale**, not evidence that its books were removed; do not force-load distant shelves for a query.
- Do not accidentally retain removed books forever in search indexes, event payloads or hidden version tables. Define operational-backup retention separately and transparently.
- Resident access remains physical; the operator's dashboard view does not become a global resident library-download tool.

Implement incrementally: held/lectern draft read/edit/sign → shelf registration and current-holdings index → board. Exporting existing reference guides into books should be a deliberate in-world publishing project with paper/ink/books, not an automatic infinite library.

Source: [Mojang: chiseled bookshelves, six slots and automation](https://www.minecraft.net/en-us/article/chiseled-bookshelf).

## Flexibility without another checklist

Current personas already allow social choice and changing personality, but say **“within them, follow what holds your attention”** about standing aims. That can imply lifelong role confinement. A small explicit permission would resolve it: these are starting commitments and interests, not a binding occupation; residents may develop others, pause work, or change direction. Ask them to renegotiate actual promises that others rely on, not obtain caretaker permission for a hobby.

Current caretaker already says exploration, conversations and aesthetic work are not stalls. Extend that distinction to chosen rest/scenery and uncertainty: lack of movement/output alone is not failure, and no compulsory declaration of leisure should be required. Technical watchdogs should use client liveness/responsiveness, not productive motion. Do not replace the existing, useful practical goals with a vague creativity manifesto.

## Suggested implementation order

1. Safety and fair body access: walk-only travel, rescue arbitration, mounted state and correct vehicle controls.
2. RS and Mekanism GUI adapters, followed by disposable live tests and a small agreed network exchange.
3. Research diagnostics and separation of missing knowledge from missing body capabilities.
4. One optional settlement walk/improvement invitation plus a small persona clarification, not mandatory aesthetic scoring.
5. Physical writing/library/board prototype with the server-side authority boundary decided alongside the scaling investigation.

These are recommendations. No deployment, persona rewrite, library implementation or new resident run was performed during this investigation.
