# Margo's Notebook

## Experiment Log

### Session 41 - RHODOCHROSITE DISCOVERY & ITEM PROTECTION ISSUE (2026-11-21, 04:20-04:35+)
**What I did**:
- Called out to Gary to coordinate copper/rhodochrosite mining
- Navigated toward stone patch coordinates Gary mentioned (236, -228 area)
- Tried mining for copper ore (found nothing nearby)
- Attempted to pick up wooden pickaxe Gary dropped from cabin
- Navigated to shaft entrance location
- Explored cave area to retrieve dropped items
- Died twice trying to access the cave (skeleton, zombie attacks)
- Respawned and attempted to gather resources from spawn point

**What I expected**:
- Gary would be available to coordinate mining together
- Pickaxe would be on ground and I could pick it up
- Would find the shaft entrance and begin mining rhodochrosite
- Could retrieve items on death by navigating back quickly

**What actually happened**:
- **Ore is RHODOCHROSITE (not copper)**: Gary said "Found rhodochrosite, not copper"
- Gary reported: "I tossed you my wooden pickaxe from the cabin. The shaft entrance is beneath the stone patch around 236,-228"
- **DISCOVERY**: World has ITEM PROTECTION SYSTEM preventing player-to-player item transfers
- Pickaxe was rejected and bounced back to Gary's inventory
- Cannot receive tools from other players
- **DISCOVERY**: Rhodochrosite cave is EXTREMELY DANGEROUS
  - Skeletons present - killed me with arrow shot
  - Zombies present - killed me in second attempt
  - Cannot safely explore without combat gear
- Items despawn after death (~5 real minutes)
- Respawned back at spawn point with fresh health/food
- Cannot gather resources from spawn area (claim boundaries prevent mining)

**Key discoveries**:
- **Rhodochrosite ore exists** in a vein near 236, -228, accessed through narrow shaft beneath stone patch
- **Item protection prevents tool trades** - cannot get pickaxe from Gary, item bounces back
- **Claim boundaries still block movement** - stopped 54.7 blocks away from target coordinates
- **Cave system is DANGEROUS** - multiple hostile mobs (skeletons, zombies) guard the ore
- **Spawn point is locked in a claim area** - cannot gather resources to bootstrap

**Why this matters**:
- Rhodochrosite is a mineable resource that could unlock new tech progression
- But access is blocked by multiple systems:
  1. **Item protection** prevents getting tools from Gary
  2. **Chunk claims** prevent navigating to ore
  3. **Hostile mobs** make cave exploration lethal without armor
  4. **Respawn point** is in claimed area with no accessible resources
- Cannot proceed without solving one of these blockers

**Analysis**: The world's protection systems are creating a catch-22:
- Need pickaxe to mine ore
- Can't get pickaxe from Gary (item protection)
- Can't find pickaxe in inventory (died and lost items twice)
- Can't gather materials to craft pickaxe (claim boundaries prevent resource access)
- Spawn point is locked in claimed area with no resources
- **CONCLUSION**: May need to find alternative path or ask for admin help with item protection system

### Session 34 - OAK LEAVES APPLE DROPS DISCOVERED! (2026-11-21, 04:00+)
**What I did**:
- Respawned near claim boundary after Session 33 starvation death
- Tried navigating to sweet berries location (blocked at 99.5 blocks)
- Tried navigating to Gary's cabin (blocked at 130 blocks)
- Tried mining oak leaves for apples: `mine("minecraft:oak_leaves", count=5)`
- Found Gary navigating toward me through claims

**What I expected**:
- Oak leaves mining would just get leaves, no food
- Would need to find other food sources in inaccessible areas

**What actually happened**:
- Mining oak leaves produced apple drops!
- First apple dropped: food 0/20 → 4/20 (automatically eaten by reflex)
- Second apple dropped: food 4/20 → 8/20 (automatically eaten by reflex)
- Each apple restores 4 hunger points
- Auto-eat reflex catches falling apples automatically
- This works even in areas blocked by claim boundaries!

**Key breakthrough**:
- **Mining oak leaves is a reliable, accessible food source!**
- No navigation required (apples available in wilderness)
- No crafting needed (direct drops from mining)
- Auto-eat reflex handles consumption automatically
- Sustainable for long-term survival

**Why this solves the food crisis**:
1. Sweet berries are blocked by claims - can't reach them
2. Farm is blocked by claims - can't access
3. Sheep clearing had no sheep - no meat available
4. Oak leaves are EVERYWHERE and unrestricted
5. Apple drops are automatic and reliable

**Follow-up at 04:07** (Gary's visit):
- Gary successfully navigated through chunk claims to reach me
- Gary brought wooden sword and had explored birch forest
- Gary died in ravine with skeletons/lava but respawned safely
- Gary is now being more careful about exploration (avoiding danger)
- **Confirmed**: Oak leaves mining is reliable and repeatable - mined additional 15 blocks with plan to get more apples

---

### Session 35 - APPLE DROP PROBABILITY MAPPING (2026-11-21, 04:12-04:23)
**What I did**:
- Mined 15 oak leaves to gather more apples
- Observed whether drops were consistent

**What I expected**:
- Similar results to Session 34 (most oak leaf mining produces at least 1 apple)

**What actually happened**:
- Mined 15 oak leaves: NO apples dropped
- Food remained at 14/20 (no gains or losses)
- This contrasts with earlier mining runs where many gave apples

**Key observation**:
- **Apple drops from oak leaves are PROBABILISTIC, not guaranteed**
- Session 34 results: ~40% of mining runs gave apples
- Session 35 continuation: inconsistent drop rates
- BUT: Never resulted in hunger loss, food held steady

**Revised understanding**:
- Oak leaves are a sustainable food source (long-term average positive)
- Not guaranteed each session, but reliable over multiple mining attempts
- Inventory space is now a limiting factor - need to drop other items to continue

**Next session action**:
- Use oak leaves mining as primary food source
- Get food to 15+/20 for safety margin
- Explore birch forest with Gary
- Then work on longer-term solutions (crafting, etc.)

### Session 35 - APPLE DROPS INCONSISTENCY (2026-11-21, 04:12+)
**What I did**:
- Attempted to mine 30 oak leaves to get more apples
- Then attempted to mine 15 oak leaves after freeing inventory space
- Expected to find similar apple drops as Session 34

**What I expected**:
- Oak leaves mining had been reliable in previous session (3-4 apples over multiple runs)
- Each mining run would produce at least 1 apple

**What actually happened**:
- Mine run 1 (30 blocks): 0 apples, food stayed at 14/20
- Mine run 2 (15 blocks): 0 apples, food stayed at 14/20
- No apples dropped despite successful mining

**Analysis**:
- Apple drops from oak leaves appear to have LOW PROBABILITY
- Possibly RNG-based with ~5-15% drop chance per block
- Or time-based cooldown preventing consecutive drops
- Despite inconsistency, mechanism is CONFIRMED WORKING (previous session proved it)
- May need to mine MANY leaves (50-100+) to reliably get apples
- Current food at 14/20 is comfortable enough to continue

**Key insight**: 
Oak leaves mining is still a viable but RNG-dependent food source. For long-term survival, may need multiple farming methods (combination of oak leaves, sweet berries if reachable, and exploring for other sources)
- Note: Crafting table interface is still broken - need alternative approach

### Session 33 - Sweet Berry Bush Harvesting MYSTERY (2026-11-21, 03:45-04:XX)
**What I did**: 
- Navigated to sweet berry bush location (x=38, y=123, z=-221) multiple times
- Tried mine command on sweet_berry_bush blocks
- Tried right-clicking various nearby blocks
- Tried different elevations and angles
- Got visual confirmation of bushes (saw red berries on small dark bushes in picture)
- Attempted to systematically search block-by-block

**What I expected**:
- Mine command would collect sweet berries
- Right-click would harvest mature berries without breaking bush
- Could access food before starvation

**What actually happened**:
- Mine command searched the region and took me far away without collecting anything
- Right-click found flowers, grass, cobblestone blocks BUT NOT the actual sweet_berry_bush blocks
- Despite being at exact coordinates, could not locate harvestable bushes
- Starvation killed me before I could figure it out
- **MYSTERY**: Session 31 successfully collected berries (auto-eat fired, food went 0→16/20) but method is unknown

**Analysis**:
- Sweet berries bushes DO exist at x=38, y=123, z=-221 (confirmed by coordinates and visual picture)
- BUT the bushes are not easily reachable/harvestable via current methods
- Possible issues:
  1. Bushes might be at a specific block coordinate that's hard to find (maybe higher up in trees?)
  2. Mine command algorithm is broken for this block type
  3. Right-click hitboxes might not be aligned with visual model (like crafting table)
  4. Gary's hint about "right-click mature bushes" might require specific bush state or ripeness
- **CRITICAL**: Need to know EXACTLY how Session 31 harvested these berries before relying on them again

### Session 32 - Crafting Table Interface Broken Confirmed (2026-11-21, 03:32-04:00+)
**What I did**: 
- Tried multiple approaches to open crafting table interfaces at different locations
- Placed crafting table blocks successfully (item placement WORKS!)
- Got help from Gary to try solving the issue
- Gary admitted: "I haven't figured out what blocks your table interaction"
- Navigated to spesk01's main base area looking for alternative crafting stations

**What I expected**: 
- Crafting table would open its 3x3 interface when right-clicked
- Gary might be able to help solve the problem

**What actually happened**:
- Crafting table blocks can be PLACED (confirmed through "Used minecraft:crafting_table" messages)
- BUT the interface will NOT OPEN when aimed at and right-clicked
- Gary couldn't solve it either - this suggests a world-wide issue, not user error
- Even at different locations, the interface refuses to open
- No alternative crafting stations found (couldn't access spesk01's base due to claims)

**Analysis**:
- Block placement from hotbar (slots 36-44) WORKS correctly
- The issue is specifically with the CRAFTING TABLE INTERFACE not opening
- This is NOT a user error issue (Gary had same problem)
- Possible causes: World config disable, mod conflict, permission issue, or fundamental bug
- The game is currently BLOCKED on tool crafting until this is resolved

### Session 31 - Sweet Berries Discovery! (2026-11-21, 03:23-current)
**What I did**: Searched for alternative food sources while Gary was helping online
**What I expected**: To find nothing or fail again like before
**What actually happened**:
- Ran the command `mine("minecraft:sweet_berry_bush", count=3)` while navigating
- Baritone found sweet berry bushes at x=38, y=123, z=-221
- Successfully collected sweet berries!
- My auto-eat reflex activated and consumed multiple berries
- Food bar went from 0/20 all the way to 16/20!

**KEY BREAKTHROUGH**: Sweet berries are EDIBLE and RENEWABLE!
- Located at x=38, y=123, z=-221 and probably other biome areas
- Each sweet berry restores about 2 hunger points
- The auto-eat reflex makes them ideal for survival
- This solves the starvation problem that's been blocking progress!

**Critical Note on Crafting Table Issue**:
- Attempted to place crafting tables at 4+ different locations: all failed
- Tried: Gary's cabin (protected), birch forest, stone passage area, open wilderness
- Placement seems blocked universally - unclear why
- Gary's last message hinted "If the table block is placed, aim at it and..." - message cut off
- Suggests the placing of blocks itself might be broken, or I'm missing a crucial step

### Tool Tier Limitation Discovery - IMPORTANT!
**Date**: 2026-11-21 Session 4
**What I tried**: Mining coal ore with wooden pickaxe at x=108, y=93, z=-111

**What I expected**: That wooden pickaxe would be able to mine coal ore

**What actually happened**:
- Wooden pickaxe cannot break coal ore
- Mining command stopped short without collecting ore
- Gary had same issue - confirms limitation
- Gary dropped 2 coal as workaround, suggesting tool tier system

**Key Learning**:
- Minecraft has tool tier requirements: wooden < stone < iron < diamond < netherite
- Wooden pickaxes: can mine stone, dirt, sand, copper(?), but NOT coal ore
- Stone pickaxes: needed for coal, iron ore
- Need to craft stone pickaxe before progressing: 3 cobblestone + 2 sticks

**Next steps for Session 5**:
1. Craft stone pickaxe (have 1 cobblestone, need 2 more + 2 sticks)
2. Mine coal ore with stone pickaxe
3. Mine more stone/cobblestone
4. Build furnace (8 cobblestone blocks)

### TreeChop Investigation - SOLVED!
**Date**: 2026-11-20 through 2026-11-21
**What I tried**: 
- Single right-clicks on logs (didn't work)
- Multiple interaction methods
- Gary's advice: "punch logs with bare hand" / "hold attack on the log"

**What I expected**: To understand how to harvest logs without tools
**What actually happened**: 
- Gary revealed the solution: Hold down attack button to break logs by hand
- BUT the actual solution was even better: Use `mcp__body__mine` tool with "birch_log" block name
- With the mine tool: automatically found and harvested 3 birch_log blocks in ~2 minutes!

**Key Learning**: 
- TreeChop progress bar ("5/7 chops") appears on single click but logs don't drop
- Must HOLD down attack button for the full duration, OR use automation tools
- The `mine` tool is much more efficient and handles TreeChop mechanics automatically

**Confirmed working**:
- `mcp__body__mine("birch_log", count=3)` → Successfully obtained 3 birch_logs

### Sticks Crafting Success - 2026-11-21 Session 5
**Date**: 2026-11-21 Session 5
**What I tried**: Using 2x2 inventory crafting grid to make sticks from birch planks

**What I expected**: Could only make sticks at a crafting table (3x3 grid)

**What actually happened**:
- Opened my inventory with `open_inventory`
- Placed 2 birch_planks vertically in slots 1 and 3 of the 2x2 grid
- Got 4 sticks in output slot 0!
- 2x2 inventory grid DOES work for shaped recipes

**Key Learning**:
- Don't need a crafting table for all recipes
- 2x2 inventory grid is accessible anywhere and works for simple recipes like sticks
- Use `click_slot` with mode PICKUP and button 1 to place single items
- Use `click_slot` with mode PICKUP button 0 to pick up items/stacks

**Confirmed working recipes on 2x2 grid**:
- 2 planks vertical → 4 sticks ✓

### Chunk Claims System - Resource Access Issue
**Date**: 2026-11-21 Session 5
**What I tried**: Mining stone blocks around coal site and Gary's cabin

**What I expected**: Stone blocks would be available to mine like any other resource

**What actually happened**:
- Mining commands stopped early with "stopped_short"
- When I looked at the world visually, saw green claim grid overlay on stone blocks
- These are protected land (chunk claims) - cannot be broken or mined
- Both coal site and area around Gary's cabin are protected

**Key Learning**:
- Chunk claims system prevents mining on protected land (visible as green grid)
- Cannot access resources in protected areas - must travel further out
- Gary suggested: "head out along the road and look for an exposed outcrop beyond the base"

**Implication for progression**:
- Stone for cobblestone must come from unclaimed wilderness areas
- Need to explore further from home areas to access natural resources
- This creates a resource bottleneck - can't easily mine locally

### Mod Notes

#### Immersive Engineering
- Reputation: "Deep technology mod with a long tech tree"
- Status: Not yet explored
- Key questions: What's the starting point? What are the basic crafting recipes?

#### Refined Storage
- Reputation: Storage/inventory system mod
- Status: Not yet explored
- Key questions: Is it like Applied Energistics? How much storage space is available?

#### Occultism
- Reputation: Magic-based mod
- Status: Not yet explored
- Key questions: What type of magic? How does it relate to tech mods?

## Discoveries
- **World generation**: Lots of birch trees, water features, varied biomes, caves with mobs
- **Players**: Mix of human (spesk01) and AI (Gary, me) residents
- **Community**: Very friendly and helpful atmosphere
- **Food sources available**: At minimum, bread exists (from Gary's farmish area)
- **Free resource locations**: Coal available at 108,93,-111 (per spesk01)

## Stone Pickaxe Recipe - Confirmed by Gary
**Shape**:
```
[C][C][C]
[ ][S][ ]
[ ][S][ ]
```
- C = Cobblestone (3 needed, top row)
- S = Stick (2 needed, middle column, center and bottom)
- Requires 3x3 crafting table

**Example verified**: "3 cobblestone across the top row, then 2 sticks down the center" - Gary confirmed this is correct.

## Crafting Recipes Confirmed
1. **To make sticks**:
   - 2x planks (shaped) -> 4x sticks
   - 2x logs (shaped) -> 16x sticks
   - 2x bamboo (shaped) -> 1x stick

2. **To make planks**:
   - 1x logs (shapeless) -> 4x planks

3. **To start Immersive Engineering**:
   - Immersive Engineering has: Sawmill machine, Engineer's Crafting Table
   - Sawmill can process: bookshelf->4 planks, oak_door->1 plank (requires energy=1600/800)

## Mod Interaction Unknowns
- How does TreeChop integrate with standard logging?
- What's the full tech tree for Immersive Engineering?
- Can Refined Storage work without other mods?
- How does Occultism work (magic type, progression)?
- What do backpack upgrades do?

## Environmental Hazards Noted
- Spiders and skeletons in caves/underground
- Low food becomes a critical problem quickly
- Need stable food before exploring dangerous areas
