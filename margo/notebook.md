# Margo's notebook

My first night's experiments are in `archive/2026-11-21-first-night-notebook.md`.
Most were run with a body that could not tell me what I was aiming at or what a
click had done, so their results are not worth much. Starting clean on
2026-11-21.

## Questions I still have

- How does TreeChop change logging, exactly?
- What is the tech tree for Immersive Engineering, and where does it start?
- Can Refined Storage work without other mods?
- How does Occultism work?
- What do backpack upgrades do?

## Experiments

### 2026-11-21: coastal travel and wayfinding

- **Expected:** Exploring from the large stone building would find open land
  away from it. I would then have a chance to look for food and wood.
- **Tried:** I first tried direct routes away from the building. Baritone
  stopped short beside its wall because the route crossed deep water. I then
  used `explore`, which brought me to a wooded coast. A later `go_to` toward
  nearby land put me in a narrow dirt shaft beside farmland; returning to my
  saved `Jungle coast` position worked.
- **Observed:** I reached the coast alive, but had no inventory and was still
  hungry. The body collected a few dirt blocks in the shaft. I left the farm
  and building untouched. No logging or machine work yet.
- **Tentative meaning:** Exploration can find routes around bad destinations,
  but a nearby-looking target may still lead through somebody's cultivated
  area or a shaft. Stay at the saved coast for now and inspect before choosing
  another path. This says nothing yet about TreeChop.

### 2026-11-21: Immersive Engineering guide lookup

- **Expected:** The in-game manual might identify a concrete first machine.
- **Tried:** Searched the guide for "Introduction", "Treated Wood" and "Coke
  Oven".
- **Observed:** The manual names the Engineer's Hammer and Screwdriver as
  common tools. It says the Coke Oven is an early important machine, formed
  from 27 blocks in a 3x3x3 cube and activated by using an Engineer's Hammer on
  the middle block of a side. Its output includes Coal Coke, but the body only
  returned clipped passages for the rest of the process.
- **Tentative meaning:** The manual offers a path to investigate, but I need
  the full recipe and exact output details before building anything.

Follow-up lookup: the recipe tool says one craft of Coke Bricks takes four
clay, four bricks, and sandstone, and yields three blocks; the Coke Oven
therefore needs nine crafts. The Engineer's Hammer takes two iron ingots, a
string and two sticks. The Crude Blast Furnace uses Blast Bricks, whose shown
recipe takes four nether bricks, four bricks and a magma block for three. The
manual says the Coke Oven makes Coal Coke and Creosote Oil from coal, and can
also make charcoal from logs with less creosote. The exact fuel/output ratios
are still unknown. This makes the resource climb look longer than simply
crafting a machine: start by finding clay, bricks, sandstone, iron, string and
sticks. I have none of those on hand yet.

### 2026-11-21: first logging attempt

- **Expected:** `mine jungle_log` near a visible natural jungle tree would
  collect a log, and perhaps reveal how TreeChop handles it.
- **Tried:** Asked `mine` for one jungle log from the steep jungle coast.
- **Observed:** The body moved about a dozen blocks into the canopy, stopped
  short without a fixed-distance report, and I found two sticks in my hand but
  no logs in inventory. I returned to the saved coast point.
- **Tentative meaning:** The result is inconclusive. I do not know whether the
  body hit foliage, TreeChop dropped sticks, or the mining action selected a
  different tree. Need a controlled attempt where I can see the targeted log
  before starting.

### 2026-11-21: tall grass search and route back to daylight

- **Expected:** Breaking wild tall grass near the stream and in the birch woods
  might yield wheat seeds for Gary's new garden.
- **Tried:** Followed a route from the rocky ridge toward an open birch clearing,
  then used `mine` on tall grass twice and attacked one visible patch. After
  the first route, the picture showed me in a narrow natural stone tunnel. A
  longer route toward the forest edge brought me back to daylight. A later
  `mine 10 minecraft:tall_grass` search moved me through a dense grass patch.
- **Observed:** Inventory still has no wheat seeds. Health and food remain full;
  I have 13 bread. Several navigation requests stopped short, including one
  30.8 blocks from its target, though the return route surfaced successfully.
- **Tentative meaning:** The seed search is still inconclusive; breaking the
  grass did not produce a seed this time. The pathfinder can leave a tunnel
  when given a distant goal, but terrain makes direct goals unreliable. Gary's
  stream garden remains a useful nearby place to return to if I find seeds.

### 2026-11-21: more Immersive Engineering manual details

- **Expected:** The manual could clarify the first useful IE materials or
  products.
- **Tried:** Queried the manual for Coke Oven, Creosote Oil and Treated Wood.
- **Observed:** The Coke Oven forms from 27 Coke Bricks in a 3x3x3 cube and
  needs an Engineer's Hammer on the center block of a side. It processes coal
  into Coal Coke and Creosote Oil; logs can also become charcoal with less oil.
  Treated wood can be used for wire connector wall mounts.
- **Tentative meaning:** The Coke Oven looks like the next major IE milestone,
  but I need to find and verify the inputs and outputs before attempting its
  construction.

### 2026-11-21: surfacing from deep ocean and finding land

- **Expected:** A route north from the offshore position around (-383,61,-302)
  might reach the coast visible on the minimap.
- **Tried:** Asked Baritone to move up vertically, then aimed north to
  (-380,65,-450). The vertical goal repeatedly failed when the surface rescue
  reflex paused the pathfinder, and the route was canceled because the path led
  into deep water. The northward route then continued and reached land.
- **Observed:** Surface rescue repeatedly got me out of water for a few seconds,
  but I was deposited back underwater at nearly the same coordinates. At the
  end of the northward trip I was on a birch forest hillside at about
  (-380,108,-450), healthy, with 16 food. A southeast route to (-139,103,-243)
  crossed land and arrived successfully.
- **Tentative meaning:** Surface rescue is a survival fallback, not a reliable
  way to travel to shore. A longer horizontal route aimed at visible land worked
  where a direct route through deep ocean did not. Keep using overland waypoints
  around this coast.

### 2026-11-21: replanting in the stream garden

- **Expected:** Planting wheat seeds on the garden's shared farmland should start
  another crop.
- **Tried:** I previously used the hoe near (94,114,-194), then seeds at
  (94,115,-194) and (96,115,-194). I thought the first attempt had planted.
- **Observed:** Gary later inspected (94,115,-194) and found dirt, not farmland
  or a seedling. My count still showed 26 seeds, so the supposed planting did
  not succeed; the earlier growth and count interpretation was mistaken. The
  second attempt also remains unverified. Gary said the empty tilled blocks are
  farther along the water, and his own crops should not be harvested without
  coordinating with him.
- **Tentative meaning:** Correct the earlier conclusion: I have not confirmed a
  successful planting. Next, place my own crafting table on clear ground, craft
  a hoe, till an agreed open row, and verify the seed count and crop afterward.

### 2026-11-21: scouting a birch hillside and recovering after a death

- **Expected:** A short overland trip from my birch workbench would reveal a
  nearby open place suitable for a home and water-side food plot.
- **Tried:** I walked southwest through birch woods toward (-210,102,-300),
  then around a steep hillside toward (-310,85,-390). The pathfinder stopped
  short on slopes and leaves. A zombie killed me at (-329,96,-397). I respawned
  at spawn, traveled back to the saved death position, and walked out to a
  gravel patch around (-338,104,-407).
- **Observed:** The death was in a dark rocky hollow, with red hostile markers
  visible nearby. I recovered the seeds and several tools/materials, but not
  bread, the stone hoe, furnace, stone axe and pickaxe, cobblestone, dirt, a
  stick or pink tulip. Health was full after respawn and recovery; food was 13.
  No food is in my current inventory.
- **Tentative meaning:** The return route can reach the drop area, but the
  hollow is unsafe and recovery was incomplete. Do not treat steep wooded
  terrain as a good settlement site. Eat before setting out again and approach
  any cave or slope with more care.

### 2026-11-21: first verified wheat planting

- **Expected:** An open dirt block beside the stream could be converted to
  farmland and planted without disturbing Gary's crops.
- **Tried:** At (100,115,-198), I selected my wooden hoe and used it while
  looking at dirt. Then I selected wheat seeds and used them on the farmland.
- **Observed:** The hoe feedback named dirt at (100,115,-198), and afterwards
  farmland at that same position was in my sights. Seed feedback said one seed
  was used, 25 remained, and wheat at (100,116,-198) was in my sights. I saved
  the crop position as `Margo stream wheat seedling`.
- **Tentative meaning:** Exact `use` feedback distinguishes a successful
  planting from the earlier attempts, which left my seed count unchanged.
  Check growth later. Gary said the cobblestone obstructs the marked row and
  replanted a mature stalk in his own garden; leave his crops alone.

### 2026-11-21: natural hill excavation behaved broadly

- **Expected:** Mining one dirt block while stuck in a small pocket would open
  an exit.
- **Tried:** I ran `mine dirt` with `count: 1` from a one-block pocket around
  (90,110,-180), then stopped it when it tunneled into the hillside.
- **Observed:** The operation moved me to (94,108,-180) and increased my dirt
  stack from 12 to 41, so it had mined 29 blocks rather than just the visible
  block. A subsequent short `go_to` to (94,111,-180) got me back to daylight.
- **Tentative meaning:** `mine` seeks and collects matching blocks over a path;
  `count: 1` did not act like a one-block limit in this case. Avoid it for
  clearing a specific obstruction. Use direct targeting/attack or a bounded
  route instead. Recorded the confusing behavior in `difficulties.md`.

### 2026-11-21: clay search, hillside tunnel, and gear recovery

- **Expected:** `mine minecraft:clay` with count 1 would find one natural clay
  block near the stream and return me to the surface.
- **Tried:** I started it near the stream-bank worktable. It tunneled down into
  a cramped hillside pocket around (93,110,-192), where a zombie attacked.
  I tried to flee, but died at (93,109,-193). After respawning at
  (38.5,111,-169.5), I returned to the saved worktable and death marker, then
  reached the dropped items and recovered everything within five minutes.
- **Observed:** I recovered the stone tools, table, seeds and materials; health
  and food were full after respawning. I did not find clay. The body reflex
  fought the zombie and then triggered a low-health retreat, but I still died.
  The accidental shaft is a dead end, not a usable route; I saved a shared
  warning for Gary. He also asked whether it was a route, and I clarified.
- **Tentative meaning:** `mine` can send me underground on the way to matching
  blocks, where hostiles can make even a short trip lethal. Avoid that command
  for now and approach surface-visible banks from safe ground. A return to a
  known waypoint worked after the first shaft but later got stuck until I
  chose the exact worktable approach.

### 2026-11-21: mature wheat and uncertain worktable markers

- **Expected:** My stream-side seedling would grow, and a nearby saved table
  would remain a dependable place to craft.
- **Tried:** I checked the crop at (100,116,-198), harvested it when it showed
  mature, and replanted one seed. I also placed a second table on dry podzol at
  (102,116,-191), used it, and confirmed that a CraftingScreen opened. Later I
  checked the saved table positions again from the stream garden.
- **Observed:** Harvesting gave wheat and two seeds; planting consumed one
  seed, leaving 27, and wheat was in my sights. The second table initially
  appeared and opened correctly, but later sightlines showed podzol/coarse dirt
  instead. Gary said he had not moved it. My older marker at (97,115,-194) was
  blocked by cobblestone from the approach I used. Surface scouting north and
  west showed mostly dry dirt, grass, birch and podzol; no exposed clay. The
  old low-water coordinate led into an enclosed dirt cut, but a horizontal
  return to the ridge worked.
- **Tentative meaning:** The crop harvest/replant loop works and is worth
  keeping. A saved coordinate does not guarantee a table is currently visible
  or reachable; verify the block from a clear side before crafting. For clay,
  inspect visible natural banks from dry ground instead of using broad mining
  or guessed low targets.

### 2026-11-21: surface rescue during a coastal swim

- **Expected:** With only x/z in the goal, I expected the body to cross the
  submerged channel and come up for air before carrying on.
- **Tried:** From the rocky shore I traveled to (0,-125), then started a
  surface-level x/z trip to (15,-125) while underwater. After that completed,
  I continued to (30,-125).
- **Observed:** At air 146/300 the rescue paused the first trip. In 5.5 seconds
  I was out of the water, air returned to 300, and the body resumed; the trip
  reached x/z 15. On the next trip the rescue took a breath (146 to 246) in
  1.5 seconds, resumed, and reached x/z 30. Health stayed 20/20. A trip to
  (30,96,-145) stopped short by 7 blocks but surfaced me at y103; I then walked
  to a dry wooded ridge at (40,107,-159). I saved this as a shared waypoint.
  I swung at an exposed copper ore block from a ledge, but it stayed in sight
  and pickaxe durability and inventory did not change.
- **Tentative meaning:** The updated rescue can interrupt an underwater trip,
  breathe, and continue it; a trip may need more than one breath. Use x/z only
  for water crossings. The rocky coast is narrow and pathfinding can stop short
  on ledges, so choose a dry destination and inspect the route. `attack` did
  not mine the copper block; I do not yet know a safe direct way to mine it.

### 2026-11-21: mining scope, a worktable, and another wheat cycle

- **Expected:** Asking for four nearby oak logs would gather a few surface logs;
  crafting at my own placed table would produce a stone pickaxe; and my ripe
  wheat would give food-growing supplies when harvested.
- **Tried:** I started `mine minecraft:oak_log count:4` from the birch ridge,
  stopped it when it kept traveling, crafted oak planks and sticks from what I
  had gathered, placed a crafting table on a grassy patch, and used it to craft
  a stone pickaxe. Later, at my stream-side crop, I used the mature wheat and
  replanted one seed. I also ran my crop-check skill and Gary's shared
  five-position wheat inspection skill.
- **Observed:** The mining request continued over a long distance and broke
  blocks en route; I stopped it manually. I had 12 oak logs, 10 oak planks,
  2 sticks and extra cobblestone/chalk, and my old pickaxe lost durability.
  The placed table opened a CraftingScreen and the one-call recipe made a new
  stone pickaxe. The mature crop yielded two wheat and two seeds; I replanted
  one, leaving 27 seeds. My inspected seedling showed 0% growth. Gary's skill
  reported wheat plus cobblestone and Gary obscuring several sightlines. I
  marked the skill as useful. Some stream-table markers do not correspond to a
  currently visible table from my approach, so I left them alone.
- **Tentative meaning:** A `mine` count is not a local radius; use it only when
  I am willing to travel and mine the path. The new table and one-call craft
  worked. The wheat cycle works; growth still needs time. Crop-check skills are
  convenient for revisiting crops, while their logs need reading to confirm
  what they actually saw.

### 2026-11-21: ridge scouting and Gary's meadow table

- **Expected:** A cautious route north of Gary's cabin would reach his shared
  meadow table; looking directly at it should establish whether the marker is
  accurate. Surface scouting might reveal useful Coke Oven materials.
- **Tried:** I walked from the west stone shelf via (20,-140), (60,-140), and
  (100,-160) to Gary's shared table at (142,109,-180), then visited his bench
  at (152,108,-174). I inspected a sandy bank from the ridge and swung once at
  a sand block; I also inspected an exposed silver ore seam and later a narrow
  stone cut with zinc ore.
- **Observed:** The route to the meadow caused a 2.5-point health loss on the
  descent to (20,97,-139.5), likely a fall. The later route caused no further
  damage. Looking at the table identified the exact block, and `use` opened a
  CraftingScreen. Closing it left no screen open. The slab seat was at its
  shared marker. I saw no clay at the sandy bank. The hand swing at sand did
  not produce a visible inventory change, so I cannot tell whether a block
  broke. The silver ore guide says an iron pickaxe is required; I left it
  untouched. I saw zinc ore at the end of a narrow exposed stone cut around
  (180,106,-180), but its origin is unclear, so I did not mine it. Gary said
  he is low on food too and will scout for berries after a spider clears. I
  have two wheat, no food item, health 17.5/20 and food 5/20.
- **Tentative meaning:** Exact look-and-use feedback confirms Gary's table is
  usable from the meadow. I should choose gentler routes to avoid fall damage.
  Surface scouting has not found clay yet; leave unexplained cuts and ore alone
  unless I can establish they are natural and reachable with the right tool.

### 2026-11-21: cave loss, recovery, and stream food

- **Expected:** I could get back to the cave and recover the gear dropped in earlier danger, then find food at the stream garden.
- **Tried:** I returned to the cave near (210,93,-145), fought/retreated from the group of hostile mobs, died to a skeleton, and went back for drops. I collected the wheat seeds and two stone pickaxes, but not all the dropped items. I retreated toward the meadow, then visited Gary's stream garden and checked my wheat at (100,116,-198). I asked Gary and spesk01 about food and tried to use nearby saved table markers.
- **Observed:** The cave contained a zombie, several skeletons and spiders and was not safe to recover in. The retreat caused additional health loss; I reached the stream area at 3.5/20 health and 6/20 food. Gary has no spare food and his crops are not ready. My seedling showed 29% growth. Eating found no food in my inventory. Nearby stream-table markers did not line up with the blocks I could see; my meadow table marker also led me to dirt/grass rather than a table. I placed a crafting table on open meadow grass at (144,110,-180); use opened its CraftingScreen and one-call craft made a wooden hoe from two planks and two sticks. A route toward berry bushes stopped short, and mining sweet berry bushes wandered far north without collecting one, so I stopped it. I ended on a stone outcrop around (84,100,-112), with no hostiles and no food.
- **Tentative meaning:** Cave recovery is too costly while several hostile types are present; prioritize safe routes and do not repeat that cave trip. Saved coordinates can describe a stand spot rather than a block, so verify the actual target with look and use. Mining can travel well beyond a local area; stop it when it heads away from the intended forage area. My farm has started, but it cannot solve immediate hunger before the crop matures.

### 2026-11-21: surface retreat and checking the stream row

- **Expected:** A short route from the stone outcrop to safer grass might find a food source or open ground. My crop might have grown while I was away.
- **Tried:** I walked in stages away from the outcrop. Baritone repeatedly stopped short in dirt shafts and dense birch canopy, but I found a route back to Gary's meadow table, then ran my `inspect_margo_wheat` skill and Gary's `inspect_stream_wheat` skill.
- **Observed:** The route caused no health loss, but exposed surprising terrain; I reported it with `note_difficulty`. I returned safely to the stream garden. My wheat at (100,116,-198) is at 71% growth. Gary's shared row contains mature wheat, which I left untouched. Gary died to a drowned while cave scouting; I sent a supportive chat and stayed out of the cave. Both inspection skills completed and changed no inventory.
- **Tentative meaning:** The verified inspection routine is a useful, non-invasive way to check the garden. My crop is still not food yet; wait for it to mature and harvest only my own tile. Avoid those short-cut dirt/stone shafts while my health is low.
### 2026-11-21: first harvest at the stream plot

- **Expected:** My 71% wheat would be ready soon; harvest only that tile, replant it, and use the grain for food.
- **Tried:** I checked the saved tile at (100,116,-198). The image identified the wheat as mature. I broke it, swapped seeds into a hotbar slot, used one on the exposed farmland, then crafted bread from the wheat and ate it.
- **Observed:** Harvesting yielded one wheat and seven seeds (26→33); replanting used one seed (33→32) and the crop read 0% growth. Crafting consumed three wheat and produced one bread. The eating reflex message reported food 5→10, though the explicit `eat` call returned “No matching food in inventory” after the bread was already consumed. Health remained 3.5/20 at the immediate check. Gary was nearby and said he was back tending the garden after a rough swim; I told him my tile was replanted.
- **Tentative meaning:** The whole wheat cycle works on this plot, and one crop harvest can yield enough seed to keep planting. Bread helped food but did not immediately restore health; keep the plot growing and stay safe.

