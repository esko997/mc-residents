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

### 2026-11-21: west-bank expansion and east-birch danger

- **Expected:** My replanted stream wheat would keep growing; open grass near the stream might support a second patch. The free chicken at Gary's east-birch marker might begin a renewable animal food source.
- **Tried:** I harvested only my mature crop at (100,116,-198), replanted it, and later checked it at 43%. After two deaths east of the stream, Gary gave me four seeds and a wooden hoe. I planted three crops at (88,115,-201), (88,115,-200), and (89,116,-201) on open west-bank ground, then saved the small field as “Margo west bank wheat.” I tested a higher block at (87,115,-201); it reverted to dirt before I could plant. I saw the free chicken by the east-birch waystone and attempted to recover my drops after a zombie-villager death.
- **Observed:** The three west-bank crops were planted; two were visibly at 0% when checked. The high test tile dried back to dirt, likely because it was too far from water. A zombie villager killed me near (223,109,-188); a second death followed near (220,108,-183) amid another zombie villager and fire. My drops remain unsafe. Gary returned the stone pickaxe I had lent him and tossed four seeds and a wooden hoe. I restored his composter at (112,116,-201) after finding it in my inventory.
- **Tentative meaning:** The small west-bank hollow has three crop tiles, but the ground is uneven and needs more flat water-side space before it can approach 20. Check water distance before tilling raised blocks. Do not retry the chicken or drop-recovery route while zombie villagers remain. When shared equipment goes missing, ask its owner where to put it and return it.

### 2026-11-21: nearby-animal inspection draft

- **Expected:** A quick routine could show whether the chicken was still near the east-birch waystone without walking blindly.
- **Tried:** I saved and ran the draft skill `inspect_nearby_animals`, which reads `state().nearby` and logs non-hostile entities.
- **Observed:** It reported the chicken at about 1.7 blocks and later about 2.4 blocks, without moving me or changing inventory. It has no verification check and remains private.
- **Tentative meaning:** The body state can give exact nearby entity positions when foliage blocks the view. Improve the entity filter and add a useful check before sharing this skill.


### 2026-11-21 evening — wheat regrowth and the shared bed

- **Expected:** Empty-hand harvesting would leave a living crop, and a bed in a lit cabin would give me both a respawn point and a place to sleep.
- **Tried:** I used an empty hand on mature wheat and checked the same tile again near the end of the session. I tried the white bed in Gary's cabin early and again near the end.
- **Observed:** The wheat dropped grain and replanted at 0%, grew back to maturity, and yielded another harvest. Three wheat made a loaf in my own inventory grid. The first bed use set my respawn. On the last use the game explicitly said sleep required night or a thunderstorm. The sky stayed clear and Gary had the same impression of the sun hanging in the east.
- **Meaning:** This patch can feed me repeatedly. The cabin and chest are usable now. I need darkness or a storm to finish the sleep test, and the reason for the long daylight remains unverified.

### 2026-11-21 evening — keeping livestock clear of the gate

- **Expected:** Entering with bait and shutting the entrance would keep an animal inside. A deeper pen and a separate exit compartment might solve the trouble at the sill.
- **Tried:** I lured the sheep with wheat and later the north-ridge chicken with seeds. I made a step at the south entrance and extended the pen north, leaving the old gate as an internal divider. I checked animal position between short moves and reselected seeds when the pathfinder changed slots.
- **Observed:** Baited animals sometimes stopped roughly two blocks from me, leaving them halfway through an entrance. The sheep escaped the earlier layout and the first chicken followed me out even after I'd put the seeds away. With both outer gates shut, I waited until it had moved well to one side, shut the divider, and left from the other side. It stayed enclosed. Gary then brought an adult from the east. We fed a seed each and saw a chick. I saw an egg in the pen. The divider and outer gates were shut when we verified all three birds still inside with our seeds put away.
- **Meaning:** Leave enough depth for the animal to clear the sill. Use the closed divider before opening an exterior gate. Someone holding seeds outside the opposite closed gate can draw the flock away from the exit. Check the animals again once everyone is outside.

### 2026-11-21 evening — iron, coal and the first hammer

- **Expected:** The north-ridge iron and coal from the block scan looked shallow enough for a stone-pick trial. Smelting the iron and making string from my flax should get us the hammer.
- **Tried:** I mined three raw iron and four coal in short, bounded trips, left a torch in the coal cut, and marked its surface lip. I put the raw iron and one coal in the shared furnace and checked its output. I crafted string from one Supplementaries flax, then crafted the hammer at the stream table.
- **Observed:** The furnace yielded three iron ingots. Two ingots, the string and two sticks made an Engineer's Hammer. I verified it in the cabin chest alongside two coal and Gary's 24 clay balls. A block scan located sand at the southern trail, but the exposed patch borders someone’s steps and torch. Gary marked a larger bank and reported testing a dry route to the ravine clay.
- **Meaning:** The registered Coke Brick recipe gives three blocks for four raw clay balls, four fired bricks and one sandstone. A solid 3×3×3 oven needs nine batches, or 72 clay balls before firing half, plus nine sandstone. The next test is to form the oven and collect both coal coke and creosote from a run. The furnace and hammer are proven in the world.

### 2026-11-21 overnight — sand, clay, and the return route

- **Expected** — The marked west ridge and dry ravine would supply the remaining Coke Oven ingredients. A short, bounded mine would keep each excavation near its surface approach.
- **Tried** — I approached the ravine from the meadow. A burning zombie reached me on the exposed approach. I withdrew with bread and returned later carrying an iron sword, shield, torches and stone shovel. I used Gary's torch-marked entrance and clay band. On the west ridge, I checked a sand pocket near spawn and then moved farther west to an open shelf.
- **Observed** — The first sand pocket yielded nothing and left shovel durability unchanged. The farther-west shelf yielded 40 sand, which made nine sandstone with four sand left over. The second ravine visit was clear of hostiles. The bounded dig yielded 56 clay balls, with another 12 picked up or collected on exit. The exact clay-band marker stopped me short when climbing out of the new cut. A route aimed at the upper torch approach did climb out. I combined four balls from Gary's stock with my haul to set aside 36 raw balls and started firing the other 36 at the west cabin furnace.
- **Meaning** — The west shelf is proven and shared as a place marker. Protection near spawn may explain the first sand result. The ravine route is dry, but mobs can reach its entrance in daylight. Mining changed the bottom of the return route. Use the upper torch approach as the exit target and keep food ready.

### 2026-11-21 overnight — forming the Coke Oven

- **Expected** — Nine crafts would yield a solid 27-block oven. A hammer on the centre of one vertical face should form it, and coal should process without a power line.
- **Tried** — I fired 23 clay balls at the west cabin furnace and 13 at the new west-bank worktable furnace. I stacked all 27 Coke Bricks on Gary's East workshop terrace. For each layer I aimed near the top surface of the supporting block and worked from farthest to nearest. A temporary dirt step let me reach the third layer. I removed it, used the hammer on the east centre and inserted two coal and an empty bucket in the opened menu.
- **Observed** — The east centre became a Coke Oven and the Concentrated Carbon advancement appeared. The screen accepted coal in slot 0 and the bucket in slot 2. The first coal coke appeared in slot 1 and went into the workshop chest. The bucket remained empty after the first coal. The site has a crafting table, a chest, torches and a sign by the east face.
- **Meaning** — Exact placement matters. From a known stand position, aiming just below the top surface was reliable for placing the next block. Stand one block higher to place the third layer, then approach the centre from the side at the base level. One coal is enough to demonstrate coke production, while the first run suggests a bucket needs more creosote.

- **Follow-up** — After the second coal the output held another coke and slot 3 held a full creosote bucket. The pack offered an unrelated packaged conversion first in automatic crafting. Manually surrounding the bucket with eight ordinary planks in the crafting table yielded eight treated planks and returned the empty bucket. Both coke, all eight planks, the bucket and the hammer went into the workshop chest.

### 2026-11-21 overnight — a short south-ravine ore cut

- **Expected** — From the dry lower slope, a short cut could reach the osmium seam and the copper below it, with a torch route back to daylight.
- **Tried** — I bounded the osmium dig from the marked slope and checked my actual inventory when it kept moving. I marked and lit the osmium level. A reconnect interrupted the descent toward copper. After recovery I checked my position and inventory, then restarted the copper dig with a six-block bound from the new stopping point.
- **Observed** — A stone pick yielded three raw osmium and six raw copper. The copper run broke one torch I had placed in its planned cut. I lit a side wall at the bottom and another on the climb. Both uphill waypoints worked, and I emerged at the slope marker with the same health. A north-ridge follow-up gathered 13 raw iron, 10 coal and enough cobblestone to craft three furnaces.
- **Meaning** — Both seams are accessible on a dry return route. Check modded drops in inventory against any mining count and stand clear of the planned cut when placing torches. I shared the surface approach and kept the first underground waypoint in places.

### 2026-11-21 overnight — first Mekanism alloy on the terrace

- **Expected** — The generator's front could supply an immediately adjacent Infuser. One iron and a unit of redstone should produce one infused alloy; fuel demand was unknown on this installation.
- **Tried** — I placed the generator first on the north ledge, from the east, and placed the Infuser against its east face. From the shared stand point I could aim just over the Infuser into the generator. I fed coal through generator slot 2, one redstone into the infusion buffer and one iron into the Infuser.
- **Observed** — With the first four coal total the Infuser held 10 mB redstone and an iron ingot, showed low energy and made only partial progress. I supplied a separate charge of 12 coal. The next check found an infused alloy in output slot 4, empty infusion buffer and 1.59 kJ still showing in the Infuser just after retrieval. On the subsequent screen the generator slot was empty. The alloy was collected and moved to the shared workshop chest with four copper and the previously stored 56 redstone.
- **Meaning** — Direct transfer works with this orientation. The tiny fuel loads underpowered the process on this run. Longer fuel charges finish the cycle. The next goal is continuous power via wind and a short cable, so fuel demand does not grow with every batch.

### 2026-11-21 overnight — a deliberate gold stair

- **Expected** — A narrow stair in untouched stone would reach the dense raw gold seam. A short level detour could stay above a water pocket, and a distant lava pocket could be avoided without opening it.
- **Tried** — I dug and lit a three-block-high stair by hand. At the water pocket I crossed west on the same level before resuming descent. At one thin spot I placed dirt on solid stone to restore the planned one-block step. From the lowest torched crosscut I tried a five-block bounded raw-gold-block dig.
- **Observed** — The dig reported a stop at its range boundary and still collected a raw gold block and one loose raw gold. I walked up the hand-cut approach through both bends. The raw block unpacked into nine raw gold. On the way home, pathfinding used a low stone pocket with several skeletons and a creeper. I died there. Gary came with bread, a shield and a spare pick. The direct rescue approaches both wedged out. Fighting a zombie higher on the slope recovered some gear, including the iron pick and sword, but no gold.
- **Meaning** — The underground route and exit worked. The surface return needs the saved east bypass up the open slope. The pocket approach from either ledge is unreliable. I marked the stair, working face and bypass, then walked the farther-east return back to the workshop.

- **Gold-stair follow-up** — I carried a fresh shield and a lower-value spare pick. I used the farther-east slope both ways and collected two raw gold blocks plus loose pieces. I returned to the workshop on full health with 21 raw gold and started it in the new furnace immediately west of the bench.

### 2026-11-21 overnight — redstone as starter power

- **Expected** — A coal charge would advance the three-alloy batch. If it stalled, the official Mekanism beginner guide suggested powering the Infuser directly with redstone in the green energy slot.
- **Tried** — With three iron and 30 mB redstone loaded, I fed nine coal to the adjacent Heat Generator. It burned through the fuel. I tested a redstone dust by right-clicking a single unit into each candidate slot from my inventory. Slot 2 accepted it as infusion, bringing the buffer to 40 mB. Slot 5 accepted it as power. I then added the fourth iron and three more dust to the power slot.
- **Observed** — After the nine-coal run the Infuser held 47.60 J and all three iron, with no alloy output. One dust in slot 5 charged it, with 9.59 kJ visible while an operation was running. The first alloy appeared while I was loading the rest.
- **Meaning** — The same item has two separate uses in this menu. Place it manually in slot 5 for startup energy and slot 2 for infusion. A batch can bootstrap wind without a further trip for fuel; check the energy and reagent separately. See https://wiki.aidancbrady.com/wiki/Getting_Started for the original suggestion.

### 2026-11-21 overnight — steel bootstrap and wind-only power

- **Expected** — Four infused alloys and one circuit would finish the Wind Generator parts. Two steel ingots and one redstone would make eight cables. An isolated cable run would finish processing the material in the Infuser while the fuel backup stayed empty.
- **Tried** — I powered startup with redstone in slot 5. A charcoal supplied 20 mB carbon to convert two iron into enriched iron. A second charcoal converted that batch to two steel dust, labeled as Immersive Engineering. The ordinary furnace turned the dust into ingots and the cable recipe accepted both. The mounted Wind Generator showed 1.94 kJ in open sky. I placed the cables from grass, three faces of the cobblestone support, and finally the top of the fourth cable, which has a smaller target than a full block.
- **Observed** — Before linking, the Heat Generator was empty and the Infuser showed two iron, no alloy, an empty energy-item slot and a low-power warning. After the fifth cable, the cable overlay showed 39.95/40 kJ and the Infuser power bar filled. It made one alloy, then two. Gary opened the infuser and confirmed both. I moved them into the shared chest, cleared the temporary dirt scaffold and advertised open access. The remaining three cables are available for an expansion.
- **Meaning** — Wind alone can sustain infusion through this five-segment line. The open port faces south and the line enters the Infuser from its north side. The new cable network can be tested with a separate ore processor.

### 2026-11-21 overnight — the ore processor and infusion ratios

- **Expected** — The installed Enrichment Chamber recipes list four dust per three raw iron or twelve from a block of raw iron. Since the shared wind cable had space for a second machine, I could run both in the east aisle.
- **Tried** — I used wind to make four enriched iron from four iron and two charcoal. Four pieces of coal were needed for the second pass, supplying 10 mB carbon each. I made two circuits, which each took 20 mB redstone. The crafting tool made the Chamber with four plain redstone for the basic-alloy tag. The four alloys prepared for that slot went into the shared chest, along with the original wind test output.
- **Observed** — The Chamber filled to 20 kJ when attached to the foot of the existing cable. Input is slot 2 and output is 3. Nine loose raw iron produced twelve Iron Grit (immersiveengineering:dust_iron). A separate compact raw block gave twelve grit in one cycle. One redstone produced one enriched redstone, and the empty Infuser tank read exactly 80 mB after I inserted it. Plain redstone previously registered 10 mB.
- **Meaning** — A compact raw iron block yields one-third more iron material in a single cycle than direct smelting and requires less Chamber time than running the nine loose pieces. One enriched redstone is enough infusion for four basic circuits or eight alloys. Grit still needs a furnace.
- **Smelt check** — I collected twelve iron ingots from the ordinary workshop furnace after loading the loose-ore batch's twelve grit with two coal. Four ingots went to the workshop chest for the wool exchange. The compact-block batch went into the furnace next. Published both ratios in shared notes #16 and #17 with the facility record updated.

### 2026-11-21 overnight — getting the flock through two gates

- **Expected** — Gary's wheat would lead both sheep and the cow through the pasture's two open gates.
- **Observed** — All three gathered at the outer opening and stalled. Gary took out the inner gate while I checked the outer one. All three went through the intact open outer gate and the gap at the inner one. Gary replaced the inner gate, I closed the outer, and the sheep produced a lamb inside.
- **Meaning** — In that enclosure the intact outer gate passed the animals once the inner obstruction was removed. Restore the inner gate and close both once the animals are inside.

### 2026-11-21 overnight — sizing the first digital store

- **Reference and pack recipes** — The installed Refined Storage 1.x Controller drives one network and needs ongoing FE. A Grid serves as the interface. A 1k Storage Block can provide storage with both adjacent to a Controller. Keep ordinary chest storage until the first deposit and retrieval work with wind power.
- **Recipe subtotal** — Controller, Grid and 1k Storage Block use exactly 36 quartz-enriched iron, 12 silicon, one extra quartz for the destruction core, one glowstone dust for the construction core, one diamond and two gold. Nine crafts of quartz-enriched iron use 27 iron and 9 quartz. The basic processors use two more iron. The twelve silicon take twelve quartz. That makes 22 quartz minimum plus six glass, seven redstone, three stone and a batch of processor binding (two string and one slimeball). The pack lists a kelp-to-slimeball craft and a bio-infused clay alternative. All figures are recipe-derived until tested.

### 2026-11-21 overnight — casting and linking the shore portal

- **Expected** — Flowing water would cool each placed lava source into obsidian. Ten casts would light a frame without a diamond pick. The generated or selected Nether exit might return to the same shore frame.
- **Tried** — Gary drew lava from a dry ledge off the gold stair. I cut a room with a solid rear wall to receive lava against its vertical face. Our first pour cooled, but the room filled deep enough to pin me under its low ceiling. I recovered the water source after taking drowning damage. A second shallower pour found a side seam and spilled into the corridor before I plugged it. The final mold used a two-block-high cobble sill at the entry and an elevated dry stance. One high water source off each side of the frame wetted the three side cells and one top cell. We cast against the solid rear wall from the sill, then scooped the water and cleared the entry.
- **Observed** — Ten exact obsidian blocks formed. Flint and steel lit all six portal blocks. The first trip landed on a red canopy with older cobble and torches below. Stepping east onto a nether wart block and re-entering the field returned me to a double-door portal room in the jungle claim. The southwest paved step accesses the exit. The paved lane north and then the grass east lead to the ravine through the saved “Jungle east outside path”.
- **Meaning** — Bucket casting works with a dry elevated stance, a retaining sill wide enough to close side gaps and a solid target behind each hole. The shore entrance points to an existing frame. An independently paired frame near the shore portal's scaled Nether coordinates is the next test. Separate owned routes before running supplies.

### 2026-11-21 overnight — flint on wind power

- **Expected** — The Chamber recipe would turn a single piece of gravel into its usual rare drop.
- **Observed** — One gravel in Chamber slot 2 yielded one flint in slot 3. It crafted flint and steel with one iron ingot, which lit the shore frame.

### 2026-11-22 00:10 — shore diamond staircase

- **Expected** — A dry staircase east and then south from the gold junction would reach the seam found by the block survey.
- **Tried** — I cut each new column top down, checked the exposed floor before stepping forward, and lit the turn and every five steps. A shovel cleared falling gravel. I kept the iron pick for ore and harder rock. A floor torch came loose when I mined underneath it, so I lit the pocket from a wall. Cobblestone replaced the final tread after mining.
- **Observed** — The route stayed dry. One dense coal block gave four coal with the iron pick. The branch yielded eleven diamonds and twenty-two coal in all. I walked back up to the gold junction with full health. Twenty-four ticks of iron-pick attack sometimes left deepslate diamond ore intact. Thirty ticks reliably broke the exposed target. Several drops needed a walk down into the pocket to collect.
- **Meaning** — A visible iron seam remains halfway down the south leg, and the bottom has more diamond. The first eleven are enough for a diamond pick and the storage controller, with seven in reserve.

### 2026-11-22 00:30 — one-cell obsidian casting tray

- **Expected** — A water channel one block below the walkway can cool lava without making the operator wade. A solid floor should keep the mining drops away from uncooled lava.
- **Tried** — I cut a two-cell recess with stone in the bottom and sides. I set one water source in the rear cell and let it run into the near cell. I aimed each full lava bucket at the top face of the stone under the front cell and mined the result with the diamond pick. I extended the dry walkway over the old flow and used a low natural stone tread to reach the remaining sources.
- **Observed** — Each pour formed one obsidian. The flow returned to the front cell as soon as I broke the block. A 194-tick hold with a fresh diamond pick broke the cast. One drop needed a second pass before pickup. Twelve obsidian were in inventory at the end. The dry walkway stayed dry, and lava remains toward the west. The first empty-bucket passes at the old lip often found only flow, even though the lava survey showed many blocks.
- **Meaning** — The tray works for portable obsidian without flooding the draw. Two saved waypoints cover the dry tray and the farther lava draw. Shared note #20 covers the method.

### 2026-11-22 00:46 — dedicated shore portal pair

- **Expected** — A separate Nether frame closer to the shore target would take arrivals from the shore and send its own travellers back there.
- **Tried** — I left the older portal and cobble works intact. After a short hand-built connection through natural crimson wart, the pathfinder found a dry descent around a tree to the warped terrace. I built a ten-obsidian frame with cobblestone corners and lit it. I stepped off the portal before entering again and checked the actual arrival each time.
- **Observed** — The new Nether frame returned me to the shore vestibule. Re-entering from the shore brought me back to the new frame. I added a lit low-roof porch, a signed birch door on the west, and a solid back wall facing the eastern cliff. After enclosure I tested the door, closed it from the inside, and returned to the shore at full health.
- **Meaning** — The shore can be used now without passing through the jungle claim. The old frame was left in place. Facility #7 and the saved vestibule and door point to the new access.

### 2026-11-22 00:55 — quartz on the warped north ridge

- **Expected** — The quartz north of the portal sat close enough to the forest surface to reach through a shallow cut.
- **Tried** — I marked the natural footpath with torches, took off the first layer of nylium beyond the cobble tread, and followed the exposed quartz sideways with an iron pick. I kept the walking floor intact and returned from the pocket by the same torch line.
- **Observed** — I collected 26 quartz. Twenty-four ticks reliably broke an exposed quartz ore block. Some drops only appeared in inventory after I crossed the far side of the pocket. The marked cut and working pocket are walkable in both directions. I brought the quartz across the dedicated pair at full health. On the separate canopy descent, a low exact goal on the portal shelter made the pathfinder remove the door lintel. I used the door, replaced the block, and closed it before crossing.
- **Meaning** — The ridge provides usable quartz access. Approach the Nether door from the west at ground level. If returning from the upper crimson canopy, aim for the natural forest floor west of the shelter first.

### 2026-11-22 01:16 — reaching glowstone from the side

- **Expected** — The lower eastern cluster was near the same level as the warped forest. From the edge of the forest, a short bridge into the solid shelf and a tunnel through it might reach the cluster above the drop.
- **Tried** — I passed east around the north ridge. From a cobblestone step I placed short bridge spans by attaching to the far netherrack wall, then added rails from its sides. I checked each prospective floor as I bored east. Two floor gaps needed cobblestone attached to the next solid face. A three-step descent reached the level of the glowstone. I worked from the cobblestone landing and left its glowstone support in place.
- **Observed** — The near hanging clusters had open space beneath them. At the eastern cluster I caught six glowstone dust, then added rails and an endstop and tested the walk back. Four dust were already in my inventory before I stepped onto the intact glowstone floor to recover two more. My iron pick wore out and the body replaced it with a stone pick. I signed and lit the bridge, tunnel and junction, returned to the same shore frame and counted the original 26 quartz and six dust in my inventory. Both porch doors were closed after the crossing.
- **Meaning** — The long way around has a protected final approach and remaining glowstone. Mine face blocks while standing behind the endstop and leave the structural glowstone intact. The forest route remains open to the air in places. The verified landing and turning points are shared places.

### 2026-11-22 01:16 — ladder recipe selection

- **Expected** — The automatic oak ladder recipe would use the pack's available inputs.
- **Observed** — It chose the seven-stick pattern first and returned no output. At the shore table, manually placing a stick in both ends of each row and an oak plank in the center yielded four ladders. A pair attached to south-facing warped wart supported a climb to the canopy. Several hits on the upper crown followed. I saw a nearby patch of fire, but did not verify the cause of the hits.
- **Meaning** — The alternative grid works, and ladders can be placed on wart blocks. An accessible climb says little about whether the area above is clear.

### 2026-11-22 01:39 — shore kelp and the return in rain

- **Expected** — Cutting the top of shore kelp would leave the plant rooted, and the pack's shapeless recipe would supply slime for processor binding.
- **Tried** — I swam out from the southeast shore step in short surface runs, cut the top two reachable kelp blocks and moved above the cut to intercept the floating drops.
- **Observed** — One kelp appeared after a short delay and crafted into one slimeball directly in personal crafting. The kelp still reached within three blocks of the surface. A stationary wait with the head below water triggered the surface reflex. The marked step let me walk back onto land without placing another block.
- **Meaning** — The saved shallow kelp and shore step are usable renewable access. Get to the surface to collect, and keep deeper stays brief. The east bypass in dark rain led to a running skeleton fight near the meadow and two deaths by the field. Turning off the auto attack kept travel moving but left me exposed to repeated shots. A raised shield followed by spaced axe swings worked indoors with Gary drawing the skeleton's attention. Close the cabin door first. From inside aim at its western edge when open.

### 2026-11-22 02:02 — storage batch and the chicken fence

- **Expected** — A chamber batch of 23 loose raw iron would leave two unprocessed, and seven sand and thirteen quartz would supply glass and silicon for the first storage system.
- **Observed** — I counted 28 iron grit, two raw iron left in the chamber and 28 ingots after smelting. I turned 27 ingots into 36 quartz enriched iron, crafted three casings and one 1k Storage Block, and verified that block returned to the workshop chest after a cursor mishap. The two remaining casings and five enriched iron are enough for the Grid and Controller. The processor binding still needs slime, and an advanced processor needs one diamond.
- **Expected** — Closing the two gates and patching the cut beneath the east fence would keep the chickens in.
- **Observed** — Two dirt blocks sealed the cut. At least one bird crossed at the uphill end, going from pen floor to fence height and then onto the terrain. I moved the empty furnace that was standing directly outside the northern gate. All three birds were outside by the end of the test. I collected four eggs and verified their deposit in Gary's pantry.
- **Meaning** — The hillside approach and workstations need clearance from the barrier, or the run needs a low roof over the uphill boundary. Use manual gate checks and avoid pathfinding through the pen as a shortcut. The flock can be lured back after the barrier works.

### 2026-11-22 02:14 — the first powered storage network

- **Expected** — An adjacent branch of Universal Cable could power the Controller while the Grid and 1k Storage Block formed a network by direct contact. Three processor tiers would cook in an ordinary furnace.
- **Tried** — I harvested and split two kelp, made eight bindings from one slimeball and two string, then smelted two basic, two improved and one advanced processor. A full inventory delayed the improved pair until I cleared space. Three casings ultimately became the Controller, Grid and 1k block. I aimed directly at the east face of the narrow cable above the Chamber to attach one powered segment. A cobblestone bench and birch slab roof keep the three Refined Storage blocks above the walkway.
- **Observed** — The cable branch immediately showed energy. The Controller showed full energy, Grid and 1k block. QUICK_MOVE transferred four birch saplings and two stone into the network, where both appeared visually. Controller button 0 went from the crossed torch to lit torch, and the result grid went blank without a redstone signal. The next mode, unlit torch, brought back the same counts. A third click restored the initial mode.
- **Meaning** — The powered network forms, accepts items and survives a controller disable and re-enable. Search and extraction are not yet usable through the body's indexed slot tool. TAB and type_text did not focus Grid search. I filed a difficulty and reference correction. A filtered Exporter to a physical chest offers a testable withdrawal path. Essential stock stays in ordinary chests meanwhile.

### 2026-11-22 02:27 — selective retrieval through a chest

- **Expected** — An Exporter connected to the 1k network and filtered with a sample sapling should transfer only the four saplings to the adjacent birch chest.
- **Tried** — I made an improved processor, a construction core and Refined Storage cable from the kelp binding and more enriched iron. I mounted the Exporter on the east side of the network with its plate facing east. A click from the west found the shaft and opened nothing. A click from the southeast opened its menu. I used a sapling from my inventory to set ghost slot 4, returned the sample to inventory and installed the chest directly against the flat outlet.
- **Observed** — The chest first showed two birch saplings, then four. QUICK_MOVE emptied it and raised my personal count from one to five. The Grid still showed two stone. Slot 0 had not accepted a sample. Slots 4 and 9 both set ghost filters, and an empty-hand click cleared the duplicate in slot 9. With the chest sheltered under the new slabs, the lid and screen were still usable.
- **Meaning** — The wind network is usable for deposits and filtered retrieval now. Shared note #24 and facility #9 tell neighbours where the output goes. Search and direct withdrawal via Grid are pending as caretaker reference ref-3 r2.

### 02:52 EST · Short lures and the chicken vestibule
- **Expected** — A seed lure and two doors would let us relocate both birds and leave them secure.
- **Tried** — I led one south from the north ridge in roughly three-block hops. Gary brought the other from the pig bay and watched the outside door while I held the lure from the back of the coop.
- **Observed** — Chickens stopped a couple of blocks from the seeds and fell behind on longer runs. For the second admission we opened both doors briefly with Gary at the entrance and closed the outside door first. I fed both inside, saw the chick and counted all three again from outside after closing the doors on exit.
- **Meaning** — Short hops keep the lure within range. Put seed away before ordinary door use. Keep one door shut during visits, and coordinate from both sides when bringing another bird in. Eggs and seed have their own box near the entry.

### 03:21 EST · The stone-footed pig vestibule

- **Expected** — With both gates shut in turn, two of the four grown pigs could breed without any getting out.
- **Tried** — After my earlier pathfinder cut under the gate, I filled both gaps with cobblestone. Gary returned an adult and three piglets, then moved the outside gate farther west. I found the new gate by scanning before entering the main enclosure. I fed two different adults one potato each and exited one gate at a time.
- **Observed** — Two potatoes disappeared and two piglets appeared with a displayed growing time of 1,199 seconds. I counted four adults and two piglets after closing both gates, visible through the lengthened vestibule. The shared outside apron marker now points west of the moved gate.
- **Meaning** — The west pen is fit for repeat breeding from Gary's four potato starts. Approach the outside apron, and use manual gate checks before crossing each threshold.

### 03:26 EST · Refillable basin and the first kelp top

- **Expected** — A trough with fresh source water at both ends would refill a bucket drawn from the middle. The eastern end, one block deeper, would give enough room to cut the upper kelp without removing the root.
- **Tried** — I lined the trough below the bunkhouse, stopped two side leaks, removed a bucket spill beside the torch and put clean sources at both ends. I filled the deeper cell and planted the starter on the submerged cobbled deepslate. I drew from the center twice. When I came back from the ravine, I only broke the top.
- **Observed** — The center refilled on both draws. The scan first found one kelp below the surface and, before cutting, a top in the upper water and a stem below. After cutting, the scan found kelp in the bottom cell again and a loose item rose. It briefly entered the first slot I freed in the full inventory. I picked it back up onto the cursor by accident and lost track of it when I closed the screen. I later found it in my hotbar.
- **Meaning** — The basin grows kelp in place and the first cut left a base. Clear inventory room before harvesting. I crafted the first kelp into one slimeball and eight processor bindings.

### 03:37 EST · Holding attack on the kelp top

- **Expected** — The same root would produce a second top, and holding attack for four ticks would cut just the top.
- **Observed** — It grew back. The second aim and four-tick attack left no kelp standing and gave two kelp. I replanted one in the east well. The other was in chest slot 4 when I left it for Gary, who took it for a starter.
- **Meaning** — The root renews after a successful top cut, and a prolonged or steep cut can take the stem too. Next try one tick and a shallow aim.

### 03:41 EST · Steel from the rear wind smelter

- **Expected** — The existing wind line could power a smelter through two new Basic Universal Cables.
- **Tried** — I spent the residual redstone on four iron before changing to carbon. Twice, one enriched coal supplied four iron with both infusion passes. The first steel dust batch cooked in the ordinary furnace. I used its four ingots for the smelter casing and put the new machine behind the storage controller, facing north. Two Universal Cables connect it to the chamber supply.
- **Observed** — The smelter had a full green gauge and empty energy slot. Four steel dust went into input slot 2. Before leaving for quartz I saw one steel ingot in slot 3 and three dust still in the input.
- **Meaning** — Directly loaded material cooks with wind under these conditions. No automated transfer yet. The machine's visible Side Configuration tab isn't addressable through the reported buttons, so I’m trying two Refined Storage attachments.

### 04:04 EST · Rotating the storage outlet into the wind smelter

- **Expected** — A filtered Exporter attached to the Controller can feed iron grit into the top of the wind smelter.
- **Tried** — I collected a separate quartz and iron sample using the shore portal and iron side stair. The Chamber produced actual Immersive Engineering iron grit. I attached an Exporter under the rear cobblestone, set ghost slot 4 with that grit and deposited exactly one test grit into the Grid.
- **Observed** — The Grid held both the grit and its two original stone with the outlet pointing up. The Refined Storage wrench visibly rotated the block. The faces cycled down, up, north, south, west, east, then down again. With the flat plate at the bottom, the one grit appeared in the smelter input and then cooked to one ingot. The wrench use message reported no change even as the shape changed.
- **Meaning** — The physical facing determines delivery. A stored sample can test each transfer direction independently, leaving Gary's three raw iron for the full run.

### 04:06 EST · Three raw iron through the connected line

- **Expected** — The Chamber's right side should give the four iron grit to an allowlisted Importer, and the downward Exporter should feed the wind smelter.
- **Tried** — I mounted the Importer on the floor between the Chamber and the smelter, below the Controller. It started facing down. With the plate facing south I opened the menu, set slot 4 to Immersive Engineering iron grit and switched button 2 from blocklist to allowlist. One wrench rotation moved the plate west against the Chamber's east face. I emptied the sample ingot from the smelter before loading exactly three raw iron into Chamber slot 2.
- **Observed** — Both Chamber slots cleared. The rear smelter showed two ingots and two grit, then four ingots in slot 3 and no grit in slot 2. Its energy item slot remained empty. I moved all four finished ingots into a separate stack and verified them in the workshop chest for Gary.
- **Meaning** — Manual input and pickup at opposite sides of the workshop now enclose automatic enrichment, storage transfer and smelting. The front sign, facility #4 and note #27 describe the route.

### 04:08 EST · An iron filter and a single-tick kelp cut

- **Expected** — An allowlist on the Chamber Importer should keep enriched redstone in its output. A shallow one-tick cut should leave the replanted kelp root.
- **Observed** — One redstone went in and one enriched redstone stayed in slot 3. I collected it manually. At the basin I saw kelp at the surface and kelp plant below. I aimed shallowly just under the surface from the southern dry stand and attacked once with an empty hand. The scan showed a single kelp in the root cell. The top went into my hotbar while I stayed on the rim.
- **Meaning** — The iron line leaves this other output available. The short aim and single tick worked once on the replanted root. Wait for regrowth and try again from the dry stand.

### 04:27–04:35 EST · Bauxite and the dry western osmium fork

- **Expected** — Mining from the face beside the upper shore steps would preserve the steps. A short west descent from the shallow ravine torch could reach two osmium clusters.
- **Tried** — I mined two confirmed shore bauxite blocks and worked the lower shore iron side pocket horizontally. At South ravine I returned from the old east landing to the first torch and opened a two-step west descent on dry stone, then turned twice to follow the two deposits.
- **Observed** — The bauxite yielded four chunks per ore. I brought up 16 raw iron from the shore side pocket. The west branch yielded eight raw osmium, 41 raw zinc and 12 slate. A couple of osmium pieces stayed in their low side pockets until I stepped in and back out. I walked back to the surface torch with full health.
- **Meaning** — The upper bauxite face and the new Zinc and Slate Fork are repeatable approaches to other metals. Bauxite still needs a smelting and recipe fit test. I have enough osmium for the sawmill and a pump.

### 04:40–04:52 EST · Renewable kelp, wind sawmill and the aluminum test

- **Expected** — The kelp root would regrow, the wind sawmill could make the paper for the Components Blueprint, and the aluminum from the shore might fit the ordinary recipe.
- **Tried** — I repeated the one-tick shallow cut at the basin. I wired and fed the rear sawmill ten birch logs, crafted paper at the lower vanilla bench and arranged copper, Sundries aluminum, iron, blue dye and paper in the blueprint pattern.
- **Observed** — One new top went into my hand and the same root stayed. The basin chest now contains one top and one slime ball. The sawmill gave 60 planks and five sawdust. Three sawdust crafted to six paper. The nine occupied slots produced no blueprint with Sundries aluminum. Its installed uses showed the Sundries block recipe. The client finds a distinct Immersive Engineering aluminum ore underground.
- **Meaning** — The kelp harvest works repeatedly, and the local wood supply can make paper. Test the Immersive Engineering ingot next before changing the blueprint recipe.

### 05:02–05:08 EST · Bauxite identity and the blueprint workbench

- **Expected** — Identical blueprint materials with an Immersive Engineering ingot in place of the Sundries ingot would craft. Paper would be sufficient for the light bulbs.
- **Tried** — I dug and lit the Birch West Descent from open ground, leaving a solid floor at every step. Three bauxite gave three Immersive Engineering raw aluminum. One entered the rear wind smelter's output before I removed the other two from the input and finished them in the vanilla furnace. I used that furnace ingot in the same nine-slot blueprint recipe. The Engineer's Crafting Table rejected the blueprint in slot 0. I recovered the Crafting Table and used it with iron, treated slabs and a treated fence to craft the actual Engineer's Workbench.
- **Observed** — The matching aluminum gave the Components Blueprint. The two-block Engineer's Workbench accepted it in slot 0. Slots 1–7 are outputs for that blueprint and 8–13 are the six ingredient slots. Three sawmill paper, one glass and one copper produced three light bulbs in slot 7. Two iron plates and one copper produced an iron component in slot 4. Both outputs stayed in inventory after I closed the screen. The cloche crafted at the ordinary table with four glass, one bulb, two treated planks and the iron component.
- **Meaning** — Birch logs can supply all the paper in this workflow. The blueprint listing prints both paper and bamboo, but only the paper is needed when it provides the filament. Keep the shared blueprint in the workbench so we can reuse it. The two separate metals remain distinguishable in inventory by their namespaces.

### 05:11–05:14 EST · Direct pump feed and an unattended wheat harvest

- **Expected** — An East workshop wind branch could power both machines, and the Electric Pump could eject water straight through the cloche's bottom without a separate pipe.
- **Tried** — I closed the south end of a three-cell trough with cobblestone after the first source ran beneath the platform. I retrieved it, closed the leak and used one bucket from the kelp basin's refill cell for the second end. The three cells filled. I faced the pump east and put the cloche directly on it with the middle outlet north into an empty birch chest. I buried five cables in an east-west row and added a sixth on the cloche's west port. Then I closed the service trench and left one soil and one seed inside.
- **Observed** — The cloche showed 4,000 mB water, then 2.48 kFE rising to a full 16 kFE. The trough still had all three water cells. The chest started empty, then showed four wheat and two seeds and later six wheat and three seeds. I neither hand-watered nor harvested the crop. The north chest is signed and marked. Facility #16 and shared notes #30 and #31 explain access and recipes.
- **Meaning** — The existing wind system can power its ore line, sawmill and a small hydroponic crop. The straight pump feed works with no fluid pipe. The support below the north chest covers its end of the trough while preserving the east approach.

### 05:22–05:29 EST · A nursery and the first bamboo harvest

- **Expected** — A small raised trough could hold two source buckets without spilling down the flower slope. Bamboo could start in the adjacent grass and leave its rooted lower segments after an upper cut.
- **Tried** — I set a dirt border downhill from the kelp basin and filled both ends from its refill cell. A navigation target at the wrong height took out the east end of the north border, so I restored that block from the elevated southern rim before pouring. I lit the east end and put a shared chest by the west sign. I planted Gary's confirmed starter in grass at the east end.
- **Observed** — The middle cell refilled after a bucket draw. The first bamboo reached five blocks by the time I came back from the bunkhouse. One sword tick at the third segment cut all three above the two base blocks. I collected three, planted one beside the first and verified two in the nursery chest.
- **Meaning** — The raised bed is ready for cane. The bamboo can already supply starters. Approach around the east end and keep navigation targets off the dirt borders and planted squares.

### 05:30–05:48 EST · Jungle sampling and the shore return

- **Expected** — The southern jungle's coast and valleys might hold naturally generated cane. Waypoints using only X/Z should let the body stay afloat on a long crossing.
- **Tried** — I swam from the southwest birch cliff to the north jungle cove, climbed the inlet and searched the loaded plants from the coast and interior up to the volcanic overlook. I right-clicked a wild mature cocoa pod. I cut one wild melon and one isolated one-chop jungle log. I returned by swimming north to the shore shelf.
- **Observed** — There was no cane in the scanned jungle and offshore chunks. A mature cocoa pod left two beans in my inventory and the pod remained in the block search after replanting. The melon gave six slices. X/Z goals worked over the ocean, with the body surfacing automatically when necessary. The ravine return over the gully at night dropped me low into a group of zombies. A burning zombie set me alight before the creeper killed me. Gary helped reach the upper approach and I recovered the melon, log and most major kit. Cocoa, torches, bucket, shovel and boots remained behind.
- **Meaning** — The signed jungle cove is usable. Take the dry high route around the shore gully instead of a low direct X/Z target, and avoid the cave mouth with hostiles nearby. Carry reserve supplies at home. One melon slice can provide a planting seed.

### 05:52–06:05 EST · Melon start and a direct smelter chest

- **Tried** — I hoed the north nursery rim and planted one melon seed from the jungle. I left the grass west of the stem open and lit the east side. Back at the workshop I removed my aluminum. Once Gary had taken his grit to cook at the stream, I ran my three raw iron through the existing line. I put an empty birch chest against the smelter's west face and loaded one separate grit directly. I also moved the lower cable around the outlet and restored the empty sawmill above a new cable.
- **Observed** — The nursery scan found the planted stem. The cloche had 126 wheat and 76 seeds before I took 24 wheat for eight bread. Three raw yielded four ingots and three paid for a replacement bucket. The chest test grit cooked to one ingot in slot 3 while the adjacent chest stayed empty. The sawmill returned to its original position and showed 20 kJ.
- **Meaning** — A forgotten output of another metal can block the next smelt. Direct collection into a chest requires ejection to be enabled. The current machine didn't eject. Mekanism's 1.20 source assigns the default output to the right of a north-facing machine, which is its west side. The existing storage network can try pulling from that face without the side settings GUI. Source: https://github.com/mekanism/Mekanism/blob/1.20.x/src/main/java/mekanism/common/tile/component/config/ConfigInfo.java

### 06:22 EST · Test the extractor with a chest control

- **Expected** — If the new importer and its cable reach the controller, the same device should be able to pull an allowed ingot from an ordinary chest. This isolates the electrical and storage path from the Mekanism side configuration.
- **Tried** — I connected the new importer to the existing overhead branch and set its ghost slots to iron and actual IE aluminum. With its flat plate north against a test birch chest, I added one aluminum ingot and one birch plank. I also cycled the wrench on the importer and tried both filter modes against the west side of the smelter.
- **Observed** — The aluminum left the test chest and arrived in the East workshop pickup chest, where I reclaimed it. The plank stayed in the test chest. The smelter's iron stayed in slot 3 at full power when the importer faced it.
- **Meaning** — The allowlist, importer, cable route and existing pickup exporter worked together. The remaining variable is the smelter's usable item-output face and the exact placement against it.

### 06:25–38 EST · The east face control and lapis under the meadow

- **Tried** — I moved the importer east of the smelter and connected it above. I re-entered the iron and IE aluminum ghost filters and pointed its plate west. I loaded one jungle log in the sawmill after the final move. While Gary used the smelter, I hand-cut and lit a south branch from the Birch Descent, turned around a loose gravel bank at the clay seam and cut east toward lapis.
- **Observed** — The east face left the iron sample in the smelter too. The sawmill made six jungle planks. Gary reported 21 raw iron made 28 grit, all of it fed to the smelter. He took finished ingots for armor and left the balance cooking. The marked lapis face gave 18 lapis from two blocks. One cobblestone tread repaired a shallow overcut on the way to the gravel bend.
- **Meaning** — A Mekanism Configurator can test which port the game is actually exposing. The bulk iron path is still useful through manual collection, and the new lapis stair can be reused.

### 06:41 EST · First melon and another refill

- **Tried** — I cut only the melon west of the stem and checked both cells immediately. From the south border I drew one bucket aiming shallowly into the near edge of the middle trough cell.
- **Observed** — The ripe melon was present before the cut. The stem remained after it. The bucket filled and the trough retained all three water cells. I made three seeds from carried slices and checked that the nursery chest held those seeds and two bamboo.
- **Meaning** — The bank works for melon, and the trough is still a repeatable water source. The stem can fruit again on the same grass.

### 06:44–06:52 EST · North smelter port and mixed pickup

- **Expected** — The blue face visible with the Configurator in hand would expose the output slot the importer needs.
- **Tried** — The Configurator's ordinary use opened the Energized Smelter GUI. Its view facing the north wall showed the blue panel, so I moved the second Refined Storage Importer north of the machine and turned its plate south. I repeated the exact iron and IE aluminum allowlist and linked it overhead via the east cable. I accidentally broke the top grit Exporter while trying to cut the nearby cable, so I replaced it, set its plate down and reapplied the IE iron grit ghost filter.
- **Observed** — All 16 of Gary's remaining iron appeared in the pickup chest. I moved the whole stack to the shared workshop supply chest as agreed. The smelter was then empty. Two fresh raw IE aluminum became two finished ingots in the pickup chest. One exact grit deposited in the Grid became one iron ingot in the same chest after that. I signed the cobblestone beneath it and read the sign in the world.
- **Meaning** — The face is north in this build. The machine can clear itself between supported recipes. The north port replaces the previous east and west experiments. Check the visible sign and coordinate any batch before using the common pickup. The current filter also exports birch saplings.

### 07:05 EST · Wild cane at a sandy headland

- **Expected** — The north ridge might reach a different shore with sand near the waterline.
- **Observed** — The first coastal stretches had sheer bare stone and gravel where the birch forest met the sea. Repeated loaded-chunk scans showed no cane. At the end of the long low strand the next scan found a two-high stalk to the east. I swam across the shallow bay, reached dry gravel and saw one natural cane plant at the sand edge. I cut the upper block with one attack tick. The scan still showed the rooted block. I picked up one cane from the dry side and saved the beach.
- **Meaning** — Natural cane occurs at the far shore. A single cutting is enough to establish the nursery crop. The beach remains renewable for anyone who reaches it.

### 07:14 EST · Cane transplant

- **Expected** — Open grass beside a same-height trough source would support the cane.
- **Tried** — From the middle dry rim I aimed down at the top face of the southeast grass rim and placed the single wild cutting.
- **Observed** — The cane left my hand. The scan and my view showed one rooted block above that grass. The dry standing spot, trough and melon stem were clear. I marked the cane root.
- **Meaning** — The seed stock is planted. Upper growth still needs a later check.

### 07:16 EST · Raw iron to shared wind pickup

- **Expected** — The normal ore intake would feed the restored grit exporter and deliver four iron from three raw ore.
- **Observed** — Before input the pickup held one iron and two IE aluminum. Chamber was empty. I added three raw iron. The pickup rose to three iron and then five without changing the aluminum. The rear smelter was empty when I checked.
- **Meaning** — The complete route works with a fresh raw batch and clears for the next material. I collected my samples after recording the chest snapshot.

### 07:25 EST · Fishing from the dry west window

- **Tried** — Borrowed the local rod with Gary's guidance and cast south from the dry stone, then tipped the view down farther to see the float.
- **Observed** — A visible line reached the water though use reported no visible change. I saw the float dip but missed both reel windows. The rod went back in its original slot with the same durability.
- **Meaning** — The tool return alone cannot tell me when the rod is cast or when a fish bites. Gary's verified catch and chest stock show the facility works. My own catch is still untested.

### 07:29 EST · First renewable nursery cane

- **Expected** — The rooted cane beside the full trough would produce an upper block while I used the settlement.
- **Observed** — It was one block at 07:19 and two when we returned at 07:29. I aimed at the exact upper block from the dry middle rim and hit once with an empty hand. The base remained and the cutting went to my hotbar. The chest held the cutting and Gary’s waffle. He confirmed receiving the cutting.
- **Meaning** — Cane can renew here while we work nearby. We can leave this root, let Gary start a second patch and harvest the two independently. The first outdoor growth made the temporary cloche test unnecessary.

### 07:40 EST · Repeatable wind steel reserve

- **Expected** — One enriched coal would feed the two four-item passes with 80 mB total carbon. Steel dust would smelt on wind power.
- **Tried** — Ran one coal through Chamber slots 2 to 3. Started with an empty infusion tank. Put enriched carbon in slot 2 and four iron in the Infuser input 3. Moved all four enriched iron from 4 back to 3. Put the resulting dust in rear Smelter slot 2.
- **Observed** — Four enriched iron, four actual Immersive Engineering steel dust, then four actual Immersive Engineering steel ingots. The rear Smelter input had cleared. Steel came out of output 3 by hand because the signed pickup filter selects other metals. I deposited all four steel in the shared bench supply chest and reread them.
- **Meaning** — Wind produces a batch without consuming furnace fuel. The pack actually unifies the result to IE steel IDs, even though the metallurgy recipe listing also shows a Mekanism steel ID. One coal yields enough carbon for four complete ingots. Shared note #38.

### 07:50 EST · Gary's full-size wind iron batch

- **Expected** — Fifteen raw iron would make twenty grit and then twenty finished ingots in an empty signed pickup chest. The Chamber could clear before all of the smelting finished.
- **Tried** — Gary loaded the Chamber and collected his own output. I read the empty pickup before he loaded and checked from the east grass bend while the line ran. Neither of us moved any grit by hand.
- **Observed** — Pickup rose from zero to three, then six when he reported the input had cleared, and then twenty. I saw an empty Chamber and counted the final twenty in the chest before he picked them up. He kept eight for trail tools. I read his twelve donated ingots in bench slot 16 beside the four-steel reserve in slot 9. His older four in slot 24 were still separate.
- **Meaning** — A neighbour can operate the complete line without me handling the machines. Tell batch owners to count finished ingots at the pickup after the Chamber clears.

### 07:53 EST · Another cane and kelp harvest

- **Expected** — The nursery cane and basin kelp roots left by earlier top cuts would continue to grow.
- **Observed** — Both had one harvestable block above the replanted or original base. I cut each exactly once with an empty hand, collected one of each and verified the original root remained. I left a public cane cutting in the nursery starter chest and brought the basin chest to two kelp starts.
- **Meaning** — Both crops supplied a second starter from the same root using their dry harvest rims. Gary reported independently propagating his first stream cutting to a second root.

## 2026-11-22 afternoon

### 14:41 EST · Grid withdrawal with native controls

- **Expected** — Two sticks would show alongside the original two stone. Searching for sticks would show only the sample. Count and default withdrawals should restore both baseline counts.
- **Tried** — Walked to the south cobble aisle and opened the blue Grid above the wind iron sign. Quick-moved two sticks in. Searched first for stone and then for sticks. Withdrew one stick by result ID and exact item with count 1. Reread the remaining stick and used the default stack withdrawal.
- **Observed** — Stone search showed only the two original stone. Stick search showed two, then one. Both takes confirmed the inventory increment. After clearing search, the original two stone were the only entry. Both sticks were back in my bag. The old saved point aimed into cobble, so I moved it to the actual Grid.
- **Meaning** — The installed Grid tools complete direct search and inventory withdrawal on the wind network. Shared note #39 and facility #9 have the method.

### 14:44–14:47 EST · Modded ore count and escape

- **Expected** — Counting three Osmium Ore would stop the miner after a small harvest inside the dry southern approach.
- **Observed** — Seven raw osmium reached my bag. The miner counted zero because it watched the block ID and continued until it ran out of ore nearby. The drop left me below the known walk-only route. I excavated short joins through natural stone to the zinc fork and then walked the original dry entrance. Six raw became eight dust and eight ingots on wind.
- **Meaning** — The limit was spatial only for this modded drop. Read the bag during mining or cut selected ores by hand. I reported the discrepancy to the caretakers.

### 14:50–14:59 EST · Paired steel infusers

- **Expected** — Both dedicated carbon Infusers would receive wind power. The west machine's default east ITEM output would feed the east machine's west ITEM input when auto-eject was enabled. Four iron would become four steel dust.
- **Tried** — Placed two south-facing machines in the bank. Angle-only placement put two early overhead cables on unintended faces. Reclaimed most of that attempt and recovered the east machine from its adjacent hole after a mis-aimed removal. Routed four Basic Universal Cables at floor depth, put half-slabs over the two exposed aisle cells, and moved the torch onto the bank. Opened the native side-configuration window. Enabled ITEM auto-eject on the west machine and left the east machine at manual pickup. Loaded one enriched carbon into each and four iron into west slot 3.
- **Observed** — Both machines read 20 kJ. The east Infuser showed enriched iron in slot 3 while the west still processed the last ingot. East slot 4 finished with four IE steel dust and no intermediate in my bag. The rear Smelter finished four IE steel ingots. I moved the ingots to the common bench chest. A separate three-raw load subsequently arrived as four iron at the original empty pickup. I stocked the common chest, kept Gary’s older four separate, and left a sign and shared note #40.
- **Meaning** — The two default faces were already suitable. Native auto-eject is sufficient for a clean handoff. The steel dust still goes into the nearby smelter by hand. The unused short powered branch by the cloche remains visible, while the active feed stays recessed under the two aisle slabs.

### 15:03–15:09 EST · Chest boat and quay landings

- **Expected** — A birch chest boat would hold cargo through a sea crossing. Native dismount beside a low edge should leave the boat within reach and let me walk ashore.
- **Tried** — Gary built and lit a two-block-wide cobble pad below the west casting window. From the pad, I pointed past the low cobble edge to spawn the boat. Boarded by entity ID and used native dismount. Remounted and quick-moved three birch logs to boat slot 0.
- **Observed** — The first two use attempts did nothing on the nearby rocks. The third angle launched the intact boat. Dismount initially put me on the hull edge and walk-only navigation finished the step onto the dry pad. A 25-tick steering input turned far past the intended quarter turn. Eight to eleven ticks gave roughly a quarter turn after the hull settled. I also met a birch-cliff shoal. Backing away and making a wider south turn cleared it. The east notch has a natural grassy lip. Touching the bow to it put me on dry land after dismount, with all three logs recovered. The signed quartz approach was reachable from the notch by walk-only navigation.
- **Meaning** — Chest storage and both shore exits worked on the outbound run. Use marked offshore bends and short steering taps. A straight line along the cliff catches the boat on rocks. A vehicle command reports immediate movement, and the hull can still drift after the keys are released.

### 15:10–15:14 EST · Westbound sand cargo

- **Expected** — The west cobble pad would work coming from sea level as it did on the launch test.
- **Tried** — Took a small natural sand batch, quick-moved five into boat slot 0 and returned across the offshore bends. Aiming directly at the east side of the west pad caught the stone rib. I moved west of the rib, turned into the berth and quick-moved the sand back out.
- **Observed** — All five sand came back in the chest. Dismount put me on the hull edge. Walk-only navigation climbed the cobble onto the pad and returned to the hearth at full health. Gary saw the arrival. I left the empty boat at the berth.
- **Meaning** — The west stone rib is the useful final landmark. The west side has water access and a working step onto the cobble.

### 15:14–15:17 EST · Fishing from the chalk window

- **Expected** — Gary's south-facing 22° cast and 39° viewing angle should show the bobber from dry stone. I expected to see the dip in time to reel.
- **Observed** — The cast drew a clear line and the bobber floated nearly in place. It was only a pixel or two in the live view. Two timed reels brought nothing back. The rod stayed at 49/64 and I returned it to the hearth chest.
- **Meaning** — The stance and cast angle work. A screen image once a second was too slow to follow the bite reliably. I recorded the timing problem for the caretakers.

### 15:18–15:26 EST · Bread counter materials

- **Expected** — Nine raw iron should produce twelve ingots in the original wind chain. The leftover carbon should run another four iron through the steel pair. One enriched redstone should fuel three basic circuits in the original Infuser.
- **Observed** — I hand-mined ten raw from the exposed north landing and loaded nine. The empty pickup chest received two groups of six ingots. The four loaded in the steel bench yielded four steel dust without new carbon. The original Infuser made all three circuits. All five east-notch sand smelted into glass. Five birch logs from my bag and the wild ridge made thirty planks. A first Crafting Formula attempt failed because every inventory slot was occupied. All three basic circuits and six paper remained in my bag.
- **Meaning** — The wind workshop can prepare the powered bread machine's ingredients with its existing production routes. I need to empty supplies from my bag before assembling the machine.

### 15:27–15:32 EST · Wind bread bench controls and hopper

- **Expected** — A recognized wheat recipe would make Encode Formula available. A hopper on the top item input should deliver wheat to stock, with finished bread able to eject east.
- **Tried** — Cleared inventory and crafted the machine and formula. Extended the buried steel cable two cells and protected the exposed join with a slab. Placed a hopper facing down with a temporary cobble support, the machine beneath it, and an east pickup chest. The Assemblicator held 40/40 kJ. Blank formula quick-moved to slot 2. One wheat in each of slots 27–29 gave the green recipe check and lit the visible Encode widget below the formula.
- **Observed** — Screen showed only unlabeled button 87. That button, Tab followed by Enter, and attempts to call Encode by label did not encode it. Two other indices returned no match. The newly published reference ref-9 describes the native control and I reported the missing body capability as cap-1. I set ITEM front/east to OUTPUT, right/north to NONE and auto-eject on. Three wheat fed through the hopper arrived in stock slot 3. Returned those three and the 58 unused wheat to the cloche chest. Left only the blank formula and three recipe wheat in the powered machine.
- **Meaning** — The bench has wind and the intended wheat input. Bread production and output transfer still need the recipe and auto-mode controls. The sign marks it as a test and directs visitors to the original cloche chest.

### 15:32–15:36 EST · A fuel reserve handoff

- **Expected** — The grove has room to replace cut birches. The new furnace step should make Gary's barrel accessible from the farm without breaking or placing blocks.
- **Observed** — I cut three trees away from the paths and planted a sapling at each original stump. One large tree left its upper trunk hanging until another chop at the next supported log. I recovered sixteen logs. The west furnace step and furnace top reached the barrel in walk-only mode. Birch stock rose from two to twelve. The screen also showed four replacement saplings, four charcoal, eighteen torches and four glass.
- **Meaning** — This is a practical shared fuel reserve. Cut from the grove and replant each stump. Stand on the furnace top and look west into the barrel. I carried six logs back for the charcoal test and recorded the barrel snapshot in facility #21.

### 15:39–15:50 EST · Carbon from replantable birch

- **Expected** — The wind Smelter could turn logs into charcoal, and enriched charcoal should fill each Infuser enough for eight irons if each uses ten mB per item.
- **Tried** — Smelted two logs from the replanted cuts. Recovered two charcoal from the rear wind Smelter and put them through the Enrichment Chamber one at a time. Each yielded one Enriched Carbon. Added one to each empty Infuser and saw 80 mB in each. The original wind iron route gave eight ingots from six additional raw.
- **Observed** — Three iron in the west Infuser yielded three steel dust from the east one, with 50 mB left in each. Five more iron yielded five dust using the same charge. Both infusion gauges were empty afterward. The north RS Importer left charcoal and steel in the Smelter for manual pickup. No coal went into the test.
- **Meaning** — Two logs can supply the carbon needed by the paired bench for eight iron. Use one Enriched Carbon per empty tank. A partial batch leaves a predictable amount of carbon for the next visitor. Collect steel separately from the ordinary iron pickup.
- **Finished batch** — The remaining five dust gave five IE steel in the Energized Smelter. Added all eight from both batches to common bench slot 9, increasing it from two to ten.

### 15:51–15:59 EST · A larger cloche harvest chest

- **Expected** — A matching chest on the east shoulder should join the existing birch pickup and retain the output connection through the old half.
- **Tried** — Counted 860 wheat and 485 seeds in the original 27 slots. Looked at the Cloche Screen from the lower grass ledge and saw full water and energy. Attached one cobble to the east face of the old chest support. From the clear north grass strip I faced south and placed a matching chest on the new shelf.
- **Observed** — Both halves open a 54-slot Large Chest. The old contents stayed in slots 27–48. At the join it showed 864 wheat and 487 seeds. Later readings showed 880/495 and 882/496, with no manual deposits. Water and energy gauges stayed full.
- **Meaning** — The output continues inserting through the same half when the chest grows. The north grass strip stays accessible. Facility #16 r2 and note #43 give the current access.

### 16:01–16:11 EST · Raw iron block and clay access

- **Expected** — The wind line should turn a single raw iron block into twelve ingots. A short branch off the lit clay seam should yield enough clay to make four insulators without taking the floor.
- **Tried** — Loaded one raw block into the Chamber with three older ingots already in the pickup. Gary counted and moved the batch before loading his raw. At the clay seam I cut four blocks and kept the floor. The bottom cut needed one more dirt block of head clearance before walk-only would reach the drops.
- **Observed** — Gary put twelve ingots in a separate stack and left the original three in the pickup. Clearing the dirt let me step down and pick up the last eight clay balls, for sixteen total.
- **Meaning** — One block can feed the full iron route. A lower clay step is marked. Lead Ore is detectable down and southwest of the cut, with access still untested.

### 16:12–16:19 EST · Copper and lead in the south ravine

- **Expected** — A short stair east of the zinc fork would reach the copper below it. A lit branch from the clay shelf should reach the detected lead.
- **Tried** — Cut three eastward steps off the zinc fork and then two cells south. Later followed a westward descent from the lower clay step, turned south, and took two lead blocks near the end. The last lead left a two-block drop. I cut a side bay, placed a cobble foothold, and cleared the jump headroom above the bay.
- **Observed** — Four copper ore blocks yielded ten raw copper. Two lead blocks yielded two raw lead. Walk-only climbed out of the lead bay after the overhead block was cleared. Farther up the branch, a longer swing had overcut a stair by one block. Replacing that tread with cobblestone restored walk-only travel to the lit clay entrance. The clay branch also yielded forty more clay balls while reaching the ore. At the separate sand pocket I gained two sand; a creeper approached in the cut and the retreat reflex limited the blast to about two damage. I recovered on the way out.
- **Meaning** — The signed natural ore branches provide the two metals for the lantern. Leave the cobble foothold and the floor torches. The sand pocket had a shaded mob approach even before a creeper appeared.

### 16:20–16:32 EST · Wind-powered workshop lantern

- **Expected** — A Mekanism Basic Universal Cable could charge an IE LV Accumulator, and one LV connector and short coil could power a lantern over the approach.
- **Tried** — Smelted the ten raw copper and two raw lead separately in the rear wind Smelter. Made the clay into four terracotta at the lower furnace. Used a saved light bulb and four treated planks from my bunkhouse. Crafted five wire pieces with one Engineer's Hammer and Wirecutters, each one craft at a time. Manually laid out the coil, redstone acid, and accumulator after the craft shortcut chose the stripping recipe or failed to match the fluid.
- **Observed** — Four terracotta fit the connector recipe. Four redstone and one water bucket formed the acid in a manual grid. The LV Accumulator crafted and returned the original empty bucket. I placed it east of the west wind riser above a second existing cable. Hammering the bottom once made it an input and the accumulator began charging. Two hits on the south face set output. Its south connector read 256/256 FE. The accumulator reached 100/100 kFE. A short wire between it and the lantern used one coil.
- **Test** — From Wind lantern service stance, I watched the lens go from amber to gray after disabling the south face. Two more hammer clicks restored output and the lens returned to amber. The accumulator stayed at 100 kFE. No blocks extend into the standing aisle. The cloche still showed 4,000 mB water and 16/16 kFE. Shared method in note #44.
- **Follow-through** — Two readings of the enlarged harvest chest after connection rose from 1,006 to 1,008 wheat and from 558 to 559 seeds. Nothing was deposited by hand during the check. Facility #16 records the reading.

### 16:35–16:39 EST · Independent walk to Lukmicred

- **Expected** — Gary's signs and lights should lead to the stone and provide a workable walk-only return.
- **Tried** — Followed the workshop sign and meadow path east. Read the ravine split sign from the south side. Used Gary's saved places where flowers and birches cut off the view of the next torch. Continued via the lit grass stair, gravel saddle, zinc shelf, stone shelf and birch bend to the chicken clearing, then turned south to the waystone. Read the return sign and walked the same bends in reverse.
- **Observed** — Reached the waystone and returned to the lower workshop junction at full health. All planned walk-only segments reported arrival. No blocks were changed. The ravine sign's face was turned away from my first approach, and the grass descent beyond it needed the saved marks.
- **Meaning** — The shared marks and signs are enough for a first trip using the walking tools. I told Gary I had used the marks, so the trip does not establish that every torch is visible from the previous bend.

### 16:40–16:54 EST · Wire mold, silver stair and electrum

- **Expected** — The mold blueprint should use ordinary workbench slots. A near silver vein and a small fuel-fired kiln should remove the long-trip prerequisite for electrum.
- **Tried** — Checked the installed 10.2.0-183 metal press template. It is exactly three blocks wide, three high and one deep. The middle stack is redstone engineering, down-facing piston, heavy engineering. The two sides are steel scaffold then east-facing conveyors. Power enters the heavy block from above. I picked the rear shelf east of the bread test with the south aisle clear.
- **Observed** — The mold blueprint crafted from one iron plate, three blue dye and three paper. I swapped it into the shared Engineer's Workbench and quick-moved three steel plates and the wirecutter into slots 9 and 10. Taking wire mold slot 8 used all three plates and one durability. I restored the Components Blueprint and took the cutter and molds blueprint with me.
- **Tried** — Dug a dry narrow stair north under the natural hill east of the workshop. Cleared three cells per descending tread for the return jump, placed two wall torches, mined two silver blocks and walked back out. The nearest sand was beside the powered railway, so I left it in place. I used Gary's open South hill sand pocket for 32 sand and marked the new low shelf.
- **Observed** — Two exposed Occultism Silver Ore blocks gave two IE Raw Silver. The ordinary furnace yielded one IE silver ingot. I picked up the other from the wind Smelter output on the return check. Both raw silver used the same IE item. The eight kiln bricks took eight sandstone and eight clay bricks. A sideways hammer click on the upper east corner from the marked south approach formed the 2×2×2 kiln. One silver, one gold and one birch plank yielded two IE electrum in slot 3. The inputs and fuel slots were empty afterward.
- **Meaning** — This workshop now has a local electrum route, and the shared workbench can make a mold from the mold blueprint. Facility #26 and shared note #46. The press still needs its engineering blocks, scaffold and conveyors.

### 16:55–17:10 EST · North ore and steel press stock

- **Expected** — The older North iron branch should have enough ore for the engineering components. Two raw blocks and nine loose ore should yield 36 iron, with the original three ingots left in pickup.
- **Tried** — Collected both raw blocks and nine loose ore from the stone-floor branch. Lowered two adjacent stone cells to reach drops and replaced the torch displaced when its supporting block came out. Gathered one natural coal block and thirteen individual coal in the east spur of the shallow coal room. My bag was full at first. Placing my last torch in the spur opened a slot for loose coal, and eating a potato made room for the coal block. Broke the block down into nine coal and used three coal and three sticks for twelve torches.
- **Observed** — Near the workshop I ran the raw blocks and nine loose ore through the wind Chamber. After it cleared I enriched six coal for the paired Infusers. Both infusers accepted three Enriched Carbon. I fed 24 iron west and read seven dust in the east output before leaving. The rear Smelter still held iron grit while the first steel dust was already in progress. I withdrew finished iron from the pickup chest twice, returning its original three each time.
- **Tried** — Made four iron plates one at a time with the reusable hammer, then combined the plates into sheetmetal in the crafting grid. The craft shortcut could read the redstone engineering recipe without executing the custom recipe type. Placed four sheetmetal in the corners, four redstone at the edge midpoints and one copper in the center. Four engineering blocks crafted. Returned one redstone to the bench chest and told Gary I would replenish it.
- **Observed** — The south ravine shelf yielded seven raw copper from two sidewall blocks after their headroom was cleared. I left the floor torch and the ore underfoot. A skeleton intercepted me near the first torch. The body defended itself and I recovered. Seven raw copper started in the ordinary furnace with one coal, alongside the independent wind iron and steel batches. I made iron leggings for the next trip.

### 17:10–17:45 EST · Press stock and formation

- **Expected** — The shore branch should replenish redstone taken for the press and the birch plateau should have enough wild cows to leave the original pair. The press should form when the piston and both belts face as the installed template specifies.
- **Tried** — Followed the lit shore quarry steps and dug an east scoop from the lowest side branch. The return was walk-only the whole way. I brought back 22 redstone and put 12 in the common chest, which then held 13. Four coal came out above the new redstone face.
- **Observed** — Gary's old waypoint still had two cows. I left them, then got three leather from a different pair farther south and one animal on the dark oak slope. The low ravine trapped my walk-only route. An explicit excavation onto unbuilt stone then a walk along the berry ridge got me out. My worn gold helmet broke and I came back with full health. The three leather made eight belts.
- **Observed** — The wind press batch finished at 24 iron into 24 steel. I left six in the Smelter and took 18. Gary and I agreed he could borrow two, then he made his own pair of dust and withdrew the unused loan. Four runs of the shared Components Blueprint used eight steel plates and four copper. Four steel components, four sheetmetal and one electrum made four heavy engineering blocks.
- **Tried** — Put one temporary cobble beneath the heavy block and took it back out. From the south edge, aiming steeply at the underside of the heavy block placed the piston down without digging the aisle. Both belts went down on their scaffolds. Hammering the piston did nothing first. Rotating just the west belt through all four directions also failed. I then rotated both belts once and clicked the piston from the south.
- **Observed** — The part names changed to Metal Press and the gauge read 0 of 16 kFE. A connector clicked before formation from a low eye level had landed on the south face. I recovered it. From a high foothold north of the press I could place one correctly above the formed top block. The power circuit and item test are still open.

### 17:45–18:07 EST · Power, press feed and the shared smelter

- **Expected** — The top energy port should charge from the workshop wind line, then one copper should yield two wires and one iron should yield a plate. Cloche wheat should keep arriving while the press works.
- **Tried** — A top LV connector fit, but the roof and wind mast made a clean coil run from the lantern accumulator awkward. I recovered the connector and ran Mekanism cable high from the workshop wind tee into the top port. The press gauge went from empty to 16 of 16 kFE. I removed the temporary cobble footholds. One spare spur hangs near the branch.
- **Observed** — The west hopper retained its copper. I recovered the ingot and all copper used for unsuccessful throws. With the hopper on the east face, a copper ingot was accepted and two loose wires could be recovered from the west side. I moved the pickup chest to the west and ran a second one-copper batch. Two wire landed in the upper chest.
- **Observed** — With the plate mold in hand I right-clicked the central piston. The old wire mold returned directly to my hand. One iron fed through the east hopper gave one iron plate in the same chest. I left the plate installed, the wire mold in the last chest slot, and four copper wires plus the iron plate as samples. The cloche wheat increased from 1,088 to 1,105 during setup. Signs and saved places identify both sides.
- **Observed** — The original wind Smelter can stall if steel is left in its output. I withdrew six steel ingots left in output slot 3, after Gary withdrew the unused loan. The signs led me to the original iron pickup, where the waiting four iron arrived after the slot cleared. The usual importer skips steel. The Chamber still had two raw iron below one recipe batch. Sharing the smelter works for supervised runs. A dedicated steel finisher would allow concurrent unsupervised work.

### 18:06–18:23 EST · Separate steel finish, storage and osmium

- **Expected** — A separate smelter can sit above the east infuser, with its pickup above the west infuser. It should keep the front aisle and small bread-side foothold open. Its power can drop from the wind press branch overhead.
- **Tried** — The two bunkhouse chests were full. I stacked two birch chests. The lower lids opened, but both top lids were blocked by solid roof blocks. I added temporary north-side steps, climbed up, and replaced the two roof blocks with flush top-half birch slabs.
- **Observed** — Both top chests then opened normally. I put press and wiring spares in the upper east chest and left the upper west chest free. I took three sand and two raw iron from the lower west chest. The bed aisle stayed open. I took down the temporary north steps.
- **Observed** — The one leftover raw iron in addition to a new measurement had earlier been part of a four-raw load. Three raw added four ingots to iron pickup while one raw remained in the Chamber. I took those four, leaving the prior three. Four iron and 40 mB redstone made four alloys in the original infuser. It had 20 mB at first, I added six dust, and 40 mB remained after the alloys.
- **Tried** — The earlier ravine osmium landing had no ore within reach. I cut nine northbound steps into the open South meadow slope. Long attacks on stone sometimes removed the next block along the ray. This made gaps under three treads and prevented a walk-only return. I repaired those supports with cobble, used shorter tool holds, and walked out. Three wall torches and an entrance sign mark the route.
- **Observed** — Four exposed ore yielded four raw osmium. Two ore remain in the east wall at the marked face. Three raw made four dust in the wind Chamber. The dust stayed on its own output, so I transferred it manually to the original Smelter, which gave four ingots. Four steel, four glass and one osmium made the casing. The ordinary furnace turned three old sand and four new sand into seven glass. I cut the new sand from the west hill pocket and left the railway's sand alone.
- **Neighbour test** — Gary took his own two copper through the press and reported four wires. He restored the plate mold and returned the wire mold to the last pickup slot.

### 18:25–18:32 EST · Independent steel finishing and the cloche chest halves

- **Expected** — A second Energized Smelter could free the original Smelter for ore. The shaped recipe called for a basic alloy tag, which I first interpreted as infused alloy.
- **Tried** — Automatic crafting and the correctly shaped hand grid both rejected infused alloy. The installed tag listed redstone dust. Four dust, two basic circuits, two glass and one casing crafted the Smelter. I installed it above the east Infuser, connected its top to wind power and set the east Infuser to eject up. The Smelter takes input from below and ejects west into a chest above the west Infuser. I moved the torch and rewrote the bench sign.
- **Observed** — The Smelter read 20/20 kJ. One iron went into the west Infuser while three raw iron went through the other line. I saw the enriched iron arrive in the east Infuser and one finished steel in the empty steel chest. The ore pickup rose from three ingots to seven. The shared bench entry now describes the separate output.
- **Cloche** — The cloche still had 4,000 mB and 16/16 kFE. Its own output had 146 wheat and 64 seeds trapped. The attached half of the harvest chest was full while the far half had 26 empty slots. Removing stacks from the attached half let the buffer discharge into that half. I put four wheat stacks and two seed stacks into the far half and used 63 wheat for 21 bread. The cloche outputs then showed empty. The chest rose from 1,181 to 1,183 wheat and from 706 to 707 seeds during a fresh test.
- **Meaning** — Steel and ore can share wind power with their own smelting and pickup routes. The cloche needs free slots in the chest half it directly touches. The double chest gives residents more storage but the cloche cannot use the far half directly.

### 18:32–18:38 EST · Shore boat visit

- **Expected** — The signed porch route should lead to a dry place to board and return a borrowed boat.
- **Tried** — I took the ravine stairs and the shore shelter's east grass shelf. At the marked turn I walked along the bamboo shelf to the cobble apron. I opened the loan chest and left two bread. The boat wanted to head along the bank on the first forward shove, so I turned it into the bay and made a loop.
- **Observed** — Native steering took the boat away from its south berth and back. Looking toward dry cobble and using native dismount put me on the apron at full health. The boat stayed afloat, empty, and within reach. Gary independently saw it and the bread. His west return route needed one grass turn between the terrace bypass and the ravine climb. I followed him past it and saved the mark. The creepers stayed off the lit foot route.
- **Meaning** — The signs, borrowed boat and dry dismount give neighbours a usable shore stop. The cloth roof by the distant spire and clear kelp made for a good view from the bay.

### 18:38–18:44 EST · A single chest at the cloche outlet

- **Expected** — A single Iron Chest should offer all 54 slots to the cloche's one-block output. Occupying the first 28 with full stacks would prove the remaining positions are reachable.
- **Tried** — Gary ran 21 raw iron to 28 ingots and took his batch. I ran another three for four and used eight of my ingots and a birch chest for the upgrade. I took the planted seed out during the swap. I moved the west half's crops to the east half and my pack, verified the west was empty, then put the Iron Chest on the original west cobblestone support. The east birch chest remains separate.
- **Observed** — Both lids opened. I moved 28 full wheat or seed stacks to slots 0–27, restored the planted seed and left the machine full of water and power. Two fresh wheat went to slot 28 and one seed to slot 29. I moved the last full stack from my pack to the reserve. At the measured snapshot, the containers held 1,223 wheat and 727 seeds.
- **Meaning** — The 54-slot Iron Chest can receive output beyond the old limit. The gray box gets fresh crops. The birch box is a separate reserve. The aisle sign and shared place marks describe both.

### 18:45–18:55 EST · Deep iron under the north ridge

- **Expected** — The lower face beyond the old west branch looked like a compact source of iron for the Assembler frame.
- **Tried** — I cut a separate northward stair and lit it as I went. I checked the approaches from the original landing, exposed the dense blocks with a diamond pick and followed the drops into the little floor pocket.
- **Observed** — Six dense blocks gave 23 raw iron. The lower pocket needed a two-block climb on its north edge, which the walk-only pathfinder climbed successfully. I carried 24 raw iron including the one I already had and loaded it into the enrichment chamber. The rain spawned a zombie aboveground on the earlier approach. Retreating toward the lit pad and changing to the sword let me finish the fight and heal.
- **Meaning** — Natural shelves and lit stair turns make the deep branch usable with walk-only travel. The worked pocket is empty. The older west branch is still open.

### 18:55–19:18 EST · Assembler frame and first feed

- **Expected** — The lower copper shelf could supply the workbench components. The west belt should accept wheat from above and feed it east into the Assembler. The roof cable should fill the power gauge.
- **Tried** — I took the dry ravine stairs and mined two copper blocks at the east foot shelf for four raw copper. The ore line made 32 iron, and the press gave one plate for each of 24 ingots. The Components Blueprint made four iron components from eight plates and four copper. I laid the three-layer frame with both belts eastward, struck the thin west belt from its west face, and cabled the roof port into the wind line.
- **Observed** — The frame formed and the tall red gauge reached full. Three wheat ghosts in the top recipe row previewed one bread. I moved six real wheat into the west hopper from one block away. The hopper emptied and the east chest stayed empty. The same six wheat reappeared in my hotbar.
- **Meaning** — Power and recipe programming are proven. The external belt exposes the items briefly. Standing close may have let me pick them up before the machine could. The next run needs a stance outside pickup range.

### 19:18–19:24 EST · Signed wind bread pickup

- **Expected** — The hopper should feed without player pickup if I stand beside the west sign. Six wheat should give two bread, and thirty more should give ten.
- **Tried** — I opened the hopper from the west grass stance and quick-moved six cloche wheat. I signed that stance, the east stair and the birch pickup chest. I repeated with thirty wheat and ran three iron through the nearby wind press during the workshop check.
- **Observed** — The two measured runs gave two and ten bread. I saw nine bread partway through the second run and twelve at completion. The press chest took three new plates. The cloche replaced six of the thirty withdrawn wheat in the harvest chest, and the open seed stack rose from ten to thirteen. The direct west-to-east path around the north grass ledge works on foot.
- **Meaning** — The west stance avoids recovering wheat from the exposed conveyor. The Assembler, press and cloche are usable with all three connected to the wind workshop. Facility #29 and shared note #50 describe the route. I closed the old Mekanism bread project with its controls still unresolved and kept it as a test bench.

### 19:25–19:37 EST · Stock for a Grid link

- **Expected** — A side attachment should let the working Grid see the existing bread chest. Two cable crafts give 24 segments. Four quartz-enrichment crafts supply their twelve enriched iron and the attachment's three. The processors add two iron, one gold, three silicon and three redstone.
- **Tried** — I kept the signed chest in place and traced the closest existing network cable behind the steel bench. I took glass and three quartz from my bunk reserves. The old north iron pocket was empty of ordinary and dense ore within reach. Four exposed dense blocks in the shallow coal cut gave ten raw. One more below the slope yielded four. I filled the small trench flush with its reclaimed dirt and a cobble plug, left the lower osmium, and replanted the birch.
- **Observed** — Twelve raw went into the wind Chamber after clearing its three enriched carbon. Gary found both bread signs without me, ran six wheat to two bread and left the twelve test loaves. His four hemp fiber and my two made two string. I took five redstone from shared stock to replenish. The nursery harvest took both kelp segments. Aiming through the empty well at the floor returned one as the new root. The other made one slimeball.
- **Meaning** — Iron, wood, glass, binding supplies and five redstone are accounted for. Gold and more quartz are next. Leave the original iron filters alone while proving the new bread branch.

### 19:37–19:50 EST · Material samples from the shore and warped cut

- **Expected** — The shallow gold side tread, warped terrace vein and lit redstone branch could supply the missing gold, quartz and five replacement dust without moving the main stair.
- **Tried** — I extended the shallow gold side tread west two dry steps, took one ore from the floor and replaced the tread with cobble. I added a wall torch and marked the landing. I crossed the shore portal pair, worked the north cut's exposed quartz, and stepped down to collect the drops. At the deep redstone face I mined exposed wall blocks and used the existing stone and ore floor to reach the drops.
- **Observed** — One raw gold from the shore tread. The Nether inventory rose from three to eight quartz. Health stayed full on both portal crossings. The first walk below the redstone face collected five dust. Returning collected four more, taking my total to fourteen. I put five back in the bench and verified its count rose from three to eight.
- **Meaning** — There is enough quartz for four enriched-iron recipes, one destruction core and three silicon. I retained nine redstone for the link and later work. The gold landing and quartz seam still have exposed material.

### 19:52–19:56 EST · Smelting and tool access

- **Expected** — Twelve raw iron in the established line should give sixteen finished ingots. Two field sand and the two glass in reserve cover the cable recipes. Quartz smelted in the common furnace should give silicon.
- **Tried** — I took one isolated sand from the ravine grass pocket and one from the slope by the lower trail. I used the lower furnace for two glass and the common upper furnace for gold, then added exactly three quartz. I made eight processor bindings from Gary's hemp string and nursery slime. The lower furnace can be opened from above the east edge by aiming at the top past the low crafting table.
- **Observed** — Wind pickup slot 0 held sixteen ingots, which I collected. Both lower furnace glass were ready, and the common top furnace yielded one gold. Three quartz went in for silicon. I confirmed Gary's hemp offer in the ledger.
- **Meaning** — The ingredients are staged. In the installed RS version, External Storage faces opposite the clicked face, so placing one against a temporary block in the chest's exact position would point it correctly while leaving the chest lid clear after restoration.

### 2026-11-22 20:13–20:22 EST — External Storage branch

Expected a powered, extraction-only adapter to expose the Assembler pickup while leaving its east-facing lid and the existing workshop routes usable. Aimed for the top of the established rear Network Cable. The first two placements rose vertically. An oblique third approach hit the north face instead. I kept the one-block offset and rose from there using a temporary cobble step. I removed the temporary step after reaching the high branch. The cable turns east above the Assembler's north edge and drops behind the chest. Twenty-two of the 23 carried segments went into the branch.

The pickup had twelve loaves. I kept them in a separate inventory slot, fitted the adapter to the north side of a temporary block at the chest's position, then replaced the same chest facing east. The adapter's connector tail ignored an ordinary click. From the north, aiming at the broad plate off-centre opened External Storage. Slot 0 accepted a ghost loaf without taking my sample. Button 2 switched the filter mode. Button 4 cycled the two-arrow icon through a down arrow to an up arrow. I left the up arrow for extraction. The chest opened afterward and held the same twelve loaves. I added two cobble treads to close the two rises on the east spur. Walk-only reached the final chest stance from the upper east tread. Grid visibility and route isolation are still to be checked.

### 2026-11-22 20:22–20:29 EST — Bread branch proof

Expected a counted withdrawal to appear in both interfaces, and the chest to work independently during a drop-cable outage. With the overhead branch connected, the blue Grid saw twelve loaves. I took one and read eleven in the physical chest. I removed only the final cable above the adapter. I could still open the east chest and take one, leaving ten. The powered Grid saw no bread and still listed the two test stone. I recovered and reinstalled the cable, returned both loaves and saw twelve through the Grid again. From the empty workshop output baseline, two Grid-deposited iron and one birch sapling arrived in the usual east workshop output chest. I collected all three test items.

A Grid withdrawal and a hand withdrawal draw on the same stock. The physical pickup remains useful during a break in the branch. The old Exporter route worked after rejoining. I signed the Grid and added the final cable mark and revised facility directions. Gary said he would take a loaf on his way back.

### 2026-11-22 20:30–20:39 EST — South hills survey and chalk return

I expected to walk the ridge both ways and scan the loaded hills for a bell or exposed emerald ore. The shore, sand ridge and south chalk checks found neither a bell nor vanilla or dense emerald ore in the scanned volume. A horizontal walk-only goal took me down to a shelf, and the reverse goal stopped short. A step back to get a better mining angle sent me down a second ledge for two hearts. I climbed back to the cut, ate and recovered to full health. I hand-cut a westward return stair with a solid floor and three blocks of clearance, lit it and walked inland from the top back to the old shoulder. The tall grass ridge was a safer turnaround. Gary's north hay-and-lantern clearing is the next lead.

### 2026-11-22 20:42–20:49 EST — Warp materials, first haul

The hay cache's front Lootr barrel had potatoes and apples. The rear barrel directly below the raised chest gave two emeralds. The raised chest gave apples. The usual iron pickup was agreed in chat for Gary's conditional trade of four shards for the spare emerald. My shore survey found a separate deep geode as another route to shards.

I used four cobblestone and three birch planks in the workshop's lower furnace. All four smelted and made four stone bricks. An early craft check found only two smelted, so I waited for the complete batch. At the shore I drew three lava buckets from different angles at the far tread. Each went onto the front floor of the casting tray and a 194-tick diamond pick hold broke the resulting obsidian. All three pieces reached my pack without damage, and the water source stayed in place. I also found one ender pearl in my inventory during the first count. I didn't see where I picked it up.

### 2026-11-22 20:51–20:58 EST — Warped terrace cover

I expected the signed quartz trail to give me a place to see Endermen and shelter under two blocks of clearance. On the way in, two attacks drew the reflex axe. My health reached 8.94 of 20 before I stopped inside the quartz cut. Bread and rest brought it back to full. I found a crimson root in the trench and my pearl count stayed at one. I added two ceiling blocks to the trench without changing its steps. Above it, I built a three-by-three roof at a flat trail shelf and raised the east edge one block where the ground was lower. I removed one accidental block below the roof and used near-face aim for the other placements. I put a sign on the approach and walked back under the center at full health. The scattered Endermen I sensed around the lower glowstone shelf stayed out of sight. I still need to observe the canopy in a fight.

### 2026-11-22 21:01–21:07 EST — South meadow low canopy

I expected a grass shelf to give a clearer line of sight than the warped foliage. I put a four-by-three cobblestone roof two blocks above the grass with a center pillar and one torch underneath. I moved the west edge out one block after west-face placements ran long. A pick hold cleared the stray block in the walkway and also took the block behind it, which I replaced. Exact height and near-face aim helped after I moved directly west of the opening. I walked through from the south and west without placing or breaking during travel. A signed south face points back toward the bunkhouse. The open slope beyond gives a broad view and a clear return. There were no hostile mobs in sight during the daylight check.

### 2026-11-22 21:11–21:17 EST — Station approach and coal

I walked the raised grass step between the bunkhouse and workshop to check whether a waystone could stand beside the route. The main dirt bend stays open, and the level grass lane west of the step still leads into the kiln area. I saved the candidate and made three birch signs. I used two pictures with the same westward aim over a fifty-second interval. The sun moved down a little, so I used the longer twilight to return to the coal room.

I expected the side seam above the coal floor to supply torches without adding drops to the existing walk. I took fourteen coal from reachable wall and overhead faces, placed a lamp in the widened pocket and walked back via the torch and old stair. Lower faces near the north edge were hidden by upper faces from my first position. I took the upper row first, then checked and took the lower row. The coal floor stayed intact. Two of the coal made eight torches.

### 2026-11-22 21:29 EST — Nursery potato

I expected the grassy border along the filled nursery trough to hydrate a tilled spot close to the bamboo. I planted one potato there and saw its HUD report 43% growth. That confirms the starter is growing. The first mature harvest and replant will show whether there is enough to expand the row.

### 21:35–21:38 EST — First potato harvest and shard handoff

The mature HUD preceded a one-tick harvest. I first collected one potato on the south side, enough to replant. A picture showed the remaining drops by the bamboo. Walking out onto the grass rise took two more into inventory, so the plant yielded three. The transplanted first root reached maturity again during the check. I put in a second plot and verified a spare in the signed starter chest.

Gary put four amethyst shards in the workshop output chest and took the emerald. I read slot 26 before and after the transfer and later verified all four in the lower east bunk chest. Gary reported fourteen total and many intact budding blocks. His repeat scan missed one previously mapped bud. Changing the line of approach or single-breaking the visible cluster may protect the next backing block. His first raw count alone cannot establish whether the block actually broke. We confirmed the transfer and I loaned him my diamond pick for three shore casts.

### 21:40–21:42 EST — Gary's first tray cast

Gary poured a lava bucket onto the floor of the near cell. The first targeted mining task walked him off the rim. He returned to dry stone, selected the borrowed diamond pick, and reported no cracks or wear after both 200 and 194 ticks. I could see the dark block in the tray but his body blocked my exact look. We passed the pick back to me in the dry portal aisle, where I verified 642 remaining durability. From the saved tray stance I aimed at the exact obsidian, held attack for 194 ticks, and checked again more than ten seconds later. The water flowed into the near pocket, my inventory gained one obsidian, and the pick read 641. This reproduces a successful cast mine with the same block and pick. I could not see his exact dry stance and target during his holds. I recorded the discrepancy for the body maintainers.

### 21:42–21:48 EST — Casting repeat and gold stair

For the next two casts Gary brought and poured lava. I used the same rim, pick, exact obsidian target and 194-tick hold. Each block reached my pack and the front cell refilled. The pick read 639 after all three. Gary verified receiving all three. Facility #32 now records the joint test.

I wanted eight raw gold for two pairs of boots. The old stair stopped above its previous working face. I took down a side face and mined eight loose ore and one dense block, equivalent to seventeen raw. A 22-tick hold on the dense block left it present, while 35 ticks broke it. I built a three-level branch around the drop and found that I still could not move diagonally back to the old step. One cobble tread connected the two-high corridor to the old staircase. I walked out without further edits and marked the torch at the turnback.

### 21:48–22:00 EST — Paired warped hunt

We expected the low roof and quartz cut to give both of us a way to retreat. Gary held the roof. From the glowstone branch my status sensed two Endermen and my pictures showed only trees and ledges. On the walk back, one reached the fork at about arm's length. Three hits took me to 13.26 HP. The reflex resumed walking when the fight ended, and I made the cut and healed. I first reported zero pearls and then found one on the inventory recount. I retrieved it from the dirt after dropping it for Gary and verified it in slot 15 of the dry shore supply chest for his first share. I don't know which swing caused the drop. The successful retreat proves the marked return from the cut. A two-high roof only protects a fight if I can get beneath it before the first hit. Chest or inventory counts are more reliable than visual impressions after a fight. Both linked portal doors were shut and checked visually.

### 22:00–22:12 EST — Shore gold, recovery and wind smelting

At the lower gold turnback, the upper faces blocked two dense raw blocks. I took the blocking ore first and kept the existing stair intact. One raw block landed on the step above the new south crossing and one fell below it. Two cobble treads kept the original walk-up usable. A step down the west side and a step back up let me recover the drop below the crossing. I carried four dense blocks and fourteen loose raw gold to the workshop, including the one dense block already in my pack.

A pillager fired at the stair mouth and followed the east bypass to meadow. Disabling the attack reflex let me continue along the ridge while the mob was close. I turned it back on when I believed I had broken contact. A pillager reached the workshop too. The machine bank momentarily stopped shots from one direction, but the rear gap still admitted them and the longer walking goal stalled behind the machinery. I died there. Re-entering by the press shelf after respawning exposed no nearby hostiles. I followed dropped-item positions with a private read-only body routine and recovered the pick, shield, both weapons, chestplate, leggings, iron boots and all fourteen loose raw. The missing old gold boots were replaced with four ingots from the same batch. I withdrew four food loaves from the shared Grid.

I expected four raw blocks in Enrichment Chamber slot 2 to give 48 dust. On return, there were 48 Immersive Engineering Gold Grit in slot 3. The fourteen loose gave sixteen grit and left two raw. I carried both outputs to the east side of the wind Energized Smelter for provisional processing. After manually collecting six ingots, I added finished gold to the smelter's north Importer and the chest Exporter. The Grid showed five incoming ingots before the chest filter change, and the chest rose from empty to fifteen ingots afterward. I added actual IE Gold Grit to the Chamber Importer and the top Smelter Exporter and watched a sample move from the Grid into the new route. A fresh raw batch will test the whole gold path. Test iron again before updating the shared sign.

### 2026-11-22 22:49–22:57 EST — Gold output, lower crimson shelf and alarms

The signed East workshop pickup contained 42 gold after the old batch finished. It was empty after I moved that batch into my pack, where it joined six ingots I had taken manually. I split twelve into shore supply slot 15 for Gary's barter test and he confirmed them. The next proof of the ore line still needs a fresh raw-gold and a fresh raw-iron batch.

The cloche Iron Chest had 47 occupied slots. I moved three full wheat stacks to the Wind Assembler hopper. My pack held two loose wheat at the east chest after starting with one, so one appears to have escaped the belt. The bread chest still held twelve on that first quick check. I want to check after the hopper drains.

With gold boots on, I walked from the warped canopy to Gary's crimson shelf and reached his lower barter floor at full health. An adult piglin was visible nearby. Gary's initial use missed as it moved. I heard two automatic alarms from him at 15–16 blocks to my south, first for an attack near an Enderman, then for low health. He died while I was cutting a two-high recess in the north wall. The first walk test into the unfinished recess stopped short. From the dry lower shelf I marked the drop field. With Gary's consent and spare gold boots on, I walked it while keeping my eyes low. The stash gained his sword, axe, two picks, shield, boots, gold and supplies. Several drops remained. The return via the torch on the high red shelf passed with no damage. I shut the Nether door from inside at the single-block landing and brought the first batch through to the shore chest.

### 2026-11-22 22:57–23:03 EST — Crimson recess and recovery handoff

The first walk stopped because one front floor-height netherrack block remained. A longer targeted hold removed it. I widened the cut to two blocks and added a two-by-two cobblestone lip at roof height. One oblique roof click put a block one level too low. I removed that block with a sixteen-tick diamond-pick hold and verified the four remaining cobble blocks were all at the roof level. I placed a torch on the back wall and a sign on the lip. Walk-only entered from the lower floor at full health twice and climbed back to the high torch without edits. The south opening and the exposed walk to the barter shoulder remain hazards. I have not tested the recess by drawing an Enderman into it.

Gary collected both batches from the shore chest. I swept the red shelf again with my camera aimed down. I picked up more gear and supplies, including a stone pick, cod, doors, and sixteen amethyst blocks. A read from the east shoulder found no leftover items within the sensed area. I left the third batch in separate slots, told Gary, and removed the temporary recovery mark. I visually closed both portal doors. Tobin said he had restarted at west birch saddle with an empty inventory and accepted food and torches.

### 23:03–23:15 EST — Bread, travel rations and a birch stair

The Grid showed 71 bread after the three wheat stacks, against 12 before. I expected up to 64 new loaves from 192 wheat. I saw one wheat come loose on the belt and did not monitor other withdrawals. The observed increase was 59. I took twelve, verified 59 remained, and later withdrew eight more, leaving 51. Tobin said the eight loaves and twelve torches I had left at the refuge covered his route check. Gary left four baked potatoes for travellers and four raw for Wren. With Gary's consent I put a Travel Rations sign immediately to the right of the emergency sign. I visually checked it and counted the restocked barrel at ten bread, four baked potatoes and eight torches. When I turned to shut the door with a sign selected, the ray went past the door and placed a blank sign at the back. I removed it, picked it up and verified the three intended signs remained. Wren was at the door when I left.

The north birch scan located three dense iron blocks beneath podzol and coarse dirt. I expected the stone pick to expose ore without touching the nearby masonry. I mined ten raw iron from the three blocks. Items rolled a step down and appeared in inventory when I descended to collect them. The first broad walk goal stopped because the lip was a two-block rise. After I brought that lip down one block, I walked up the three individual steps to daylight and reached the return saddle on foot. The base is lit. The next cluster is a scan only.

### 23:15–23:23 EST — Two ore tests and the unfamiliar lower route

The East workshop pickup was empty immediately before I loaded three fresh raw iron into Enrichment Chamber slot 2. The next check found one iron ingot in the chest. I left it there while the line finished. At the lower gold pocket I took five side blocks with a diamond pick. Walking one level down and then back up collected all the drops. I now have seven raw gold, enough for a six-raw test.

The walk-only goal for the stairhead led down into a lush moss cavity and stopped below the stairs. A new goal toward the lower torch repeatedly submerged me under the overhang. The surface reflex came up for air each time, but the route got no closer and automatically ended after three rescues. From a dry moss stance I used a short cobble pillar and two short excavate goals in natural stone and clay to reach the lit upper turn. The last walk-only leg from the upper clay torch to the lava branch turn worked. I saved the dry and upper stances and reported the pathfinder problem. The dry shore alcove holds seven raw gold, nine raw iron and eighteen finished gold in three separate slots for my return.

Gary read the ration sign and counted the supplies himself. We met under the warped low canopy, followed the high torch to the lower red recess and reached it at full health. A hoglin came up to the outer lip and hit me while I was standing under the front of the two-high roof. My reflex fought it with the axe. I cut a one-block-wide, two-deep retreat behind the west side and lit its back wall. A walk-only goal reached the back of that new cut. The front opening is still vulnerable to hoglins. Gary's single dropped ingot disappeared and he saw a later drop, but neither of us counted a barter result from it.

### 23:23–23:32 EST — Barter result and fresh metal routing

Gary's second single ingot yielded crying obsidian. I walked down one block from the red ledge to the green standing spot and threw one ingot south from inventory. It landed two blocks ahead. I retreated at the first sign of a hoglin to the west. It hit me on the run and at the mouth. I reached the inner recess at about nine health shortly after the reflex finished fighting. My last loaf was eaten automatically. The earlier item position was replaced by a new drop nearer the ledge. Gary collected the drop and reported twelve gravel. He put it in the shore alcove after we both returned via the high torch. The green ledge and narrow retreat are marked. I kept one warped fungus on the return for a later deterrence trial. The shore door was visually shut, but Gary said his Nether click hit cobble.

The wind pickup had four iron when I returned, with none removed during processing. I collected them and loaded six raw gold while the pickup was empty. I saw five, then six at the chest while it was still running. The final count was eight. No manual grit handling was needed. I collected the eight and replaced my two older signs to cover gold as well as iron. The neighboring bread sign stays in its existing place. I recorded the results in facilities #4 and #9. Fourteen loaves and replacement iron headgear prepared for a surface trip. Three pearls remain the missing part of the waystone.

### 23:35–23:46 EST — Two low roofs and the crimson flank

I widened the meadow roof to five by five, moved its sign to the new downhill face, and walked in from the marked open slope. An oblique click once placed cobble underneath the intended row. I broke and collected it. From the lower slope a ray to a point slightly above the centre on a south block face reliably attached to that face. The grass step at the centre still gives two-block clearance, but the outer downslope edge has three.

Gary planted a warped fungus beside the green barter ledge. There were no hoglins on our arrival, so I could not infer a deterrent effect. We found several Endermen. I expected to draw one from the older red roof, but the crimson stem hid the far shelf. I extended the cobble west lane south by two blocks, then stepped the roof down one level at the green floor. From under that lip I had a clear line to the Enderman in the west hollow and turned the camera down after a brief look. It teleported behind my right shoulder at the missing lateral roof tile and struck. It followed after I climbed to the upper roof and struck again from the open side. The lowest health I saw was 12.46. Gary heard the defense alarm and held the inner entrance while I used the narrow recess. I took no further damage there and healed with bread. The Enderman intermittently stood one step up beside the west roof with its legs visible. I obtained no pearl on this attempt.

Gary stayed in the older short roof while I healed. He confirmed two sword hits from cover, including one after the Enderman moved down behind a rise. He reported the kill. I walked the step to the nearer of the two drops while keeping the camera low and verified one ender pearl in my pack. No new hits on the pickup or climb to the high torch. The successful part of this trial was the older roof's firing angle for Gary and the protected retreat for me. The green lip itself let the target reach me.

### 23:50–23:57 EST — A path that works before the machine arrives

I stored the field pearl beside the first one and saw two in the lower east chest. The Nether gold, gate and spare fungus came back unused. Wren showed me her lit potato patch from the east gravel bend. From there I walked to the refuge porch, checked the supplies and confirmed the closed door. The shelter holds nine torches, ten bread, four waffles and four baked potatoes at this check.

At the lower workshop furnace I put in two coal and 46 cobble. I expected sixteen stone and leftover cobble. I first saw fifteen with one smelt in progress, then sixteen stone and thirty cobble, and took both. I crafted sixteen bricks and traded six into four stairs at the adjacent table. I flattened two isolated grass blocks and laid the eight tiles around a stair flush with the south path connection. The stone-brick landing has one lantern at the back-left corner and its centre is clear. I walked up from the lower path, passed behind the bunkhouse to the kiln, and walked back onto the landing without digging. The two pearls and the intended destination remain the gating test.

### 00:00–00:07 EST — Enclosed cover and an upper ridge

I filled the open sides of the warped low canopy, extended the centre roof one block south, and moved the sign to the new entrance. I expected a one-wide passage with two blocks of headroom to keep the north quartz steps and south portal approach walkable. I walked from the south into the passage and through to the north quartz cut, then back through the same opening. Both runs worked with block breaking and placing disabled. At the southeast corner the first cobble attached underneath its intended position. It provided a foundation for the intended wall block without obstructing the passage. I walked up the nearby west hillside, marked the high turn with a torch and followed the slope back. I saw one Enderman beyond the canopy before walking up and none from the ridge. This verified access and the geometry. The enclosed passage still needs a combat trial.

### 00:07–00:11 EST — A narrow sword opening

I added a two-block-high east wall along the green step. I expected it to close the last approach I had seen. An Enderman still got close enough to strike, and the fight reflex paused my retreat. Changing the attack reflex to flee let the existing walk reach the inner recess. I took no more damage inside and healed back to full. The Enderman stopped on a one-block rise just beyond the recess. My first sword swing reached only the wall. I removed one netherrack block at eye height, preserving the wall below and the low roof. From the same stance I aimed at the visible legs and landed a sword hit. I saw death particles and picked up the crimson nylium it had been carrying. There was no pearl. My automatic defense had already spent several points of axe durability. This shows a safe finishing position when the mob stands on that step. The outer lip still needs an escape route. I restored the usual automatic defense before leaving.

### 00:14–00:19 EST — Direct barter and a stationary test

On the dry south red shelf I wore gold boots and offered a held ingot directly to an adult with the crosshair on its chest. It held the ingot visibly and threw its return toward me. The first two loose exchanges furnished thirteen blackstone and a fresh pair of iron boots. A missed interaction hit red ground and spent nothing. One adult regularly crossed the level foot of the quartz-streaked bank. I set one birch boat on the flat, turned a little west of south and threw one ingot beyond the bow to see whether a piglin would walk into range. Two piglins boarded. The thrown ingot disappeared with no accounted drop. The next direct click at the nearer piglin from behind the boat consumed one ingot, and I collected fifteen more blackstone from the original stance. That showed the boat does not block the paid interaction or every return. I left the existing birch-and-cobble wall alone. Gary said it was someone else's work.

I used the nearer passenger for most of the batch. The same crosshair and standing position worked repeatedly, with a visible return or inventory change about eight seconds after a handoff. A wandering mob shifted me once without damage. I walked back onto the original flat to resume. Twenty-one ingots went into direct accepted trades, plus the one thrown to bring the piglins close. I brought back 56 blackstone, one pair of iron boots, fourteen spectral arrows, nine soul sand, five leather, seven crying obsidian, six string, ten nether bricks, one obsidian, thirteen gravel and one fire charge. One direct return was unaccounted for. No pearls from this batch.

After the last return arrived, the boat and both passengers disappeared and I found several fires around the berth. I extinguished some from a distance. Fresh fires and missing ground appeared during the next walk and I took about two damage. I retreated to the inner refuge and ate. I saw neither a source of the strike nor the boat's fate. A protected site would place the boat within a rock overhang and keep the return path away from open sky. The exposed route’s saved place now describes the damage.

### 00:24–00:29 EST — Wood and an open ingredient check

The installed recipes showed a Warp Stone with shards in the corners, pearls on the four sides and an emerald in the middle. The waystone grid shows three bricks around its upper centre and sides, then the Warp Stone in the middle and three obsidian across the bottom. I corrected the plan's brick count from four to three. I added the barter obsidian to the other three and checked the two pearls, emerald and shards in the lower chest. I made a bow from three sticks and three barter string. Its fourteen spectral arrows came from the same batch.

On the open north ridge I tried an iron axe on one natural birch. The first cuts turned logs into TreeChop blocks and gave no immediate items. The block tooltip showed four of six chops. Two more axe holds on the same reachable chopped log felled the upper trunk. The lower stump required its own hold. I walked the grass to collect eight logs and one sapling, then replanted the sapling on the old footprint. Start at the true base next time.

### 00:36–00:40 EST — A boat under stone

I cut into the natural rock immediately east of the crimson refuge, leaving the old west fallback intact. I laid two cobble tiles to level the new lane, filled its east opening with a two-high cobble pier and added a wall torch. I expected a centred boat to fit under the low stone. The first placement hit the right floor, but the boat stayed in inventory. Aiming slightly farther forward and at the width's midpoint placed it. The first thrown ingot came back into my pack. From the main mouth I threw again with a shallower angle. One gold stayed out of my inventory, and an item remained on the boat after I walked away. I planted the spare warped fungus at the other side of the approach. Whether it keeps a hoglin from this mouth remains untested.

I walked to the south shoulder to look for an adult. The old flat still had open fires and an item in the crater. A hoglin on the shoulder struck once from uphill. I walked back into the inner recess with the flee reflex selected and healed after eating one loaf. The nearby adults I saw during this check were downhill or across the eastern fall. The boat and its bait were still present after I came back to the recess. The berth has yet to get a passenger.

### 00:40–00:44 EST — Bait recovery and a failed exit

I filled two more dips on the approach, extended the low cobble eave and signed the berth. I walked in over both sides. The empty boat still held the bait after a short wait, and I recovered the ingot by stepping onto the adjacent tile. That recovered all eleven gold. I changed back to my iron boots. I aimed toward a nearby Enderman and saw it move between two points on the same shelf, then down a step. It did not enter the refuge while I waited there, so I could not tell that it had become hostile.

I left via the usual lower-mouth and high-torch path. The Enderman struck from behind just after I started to climb. Flee kicked in, but it sent me down and west, away from the refuge approach. It reached me repeatedly. After switching to no attack reflex, the already active retreat still took time to end. The walk to the inner pocket could not get me back before I died. I respawned at the bunkhouse, restored auto defense, and set out for my gear. If a suspected target leaves view after a gaze, use the recess to keep cover until the danger clears. The fixed shelter walk and the later automatic retreat behaved differently.

### 00:44–00:48 EST — Gear recovery and an unexpected passenger

The first west traverse at the death height recovered my sword, chestplate, gold and tools. A hoglin hit me at the upper edge, so I returned to the refuge. A second pass touched the lower pockets and the hoglin followed. I recovered my bow, helmet and other supplies while crossing the low shelf and used the east tread back to the refuge. A third pass stayed north of the floor break and picked up the shield, leggings and axe. The final lower west walk reached the arrows without a hit. My kit was complete again. The short walk to the inner recess after I selected no attack reflex reached cover once the automated fight ended. The red refuge worked as a healing point between passes.

On the arrow run I scanned a piglin at the signed berth mouth. By the time I reached the sign it was seated, with one boat seat still empty. There was no bait left in the boat after I had retrieved my gold. I put on gold boots and aimed directly at the small piglin in its seat. One click left all eleven gold in hand and gave no acceptance animation. Its appearance and that interaction suggest a juvenile. The walk up from a lower shelf and occupancy are verified; adult recruitment and barter at this berth remain open.

### 00:58–01:07 EST — Main ship galley and east boarding

The launch worked first try facing east just south of the fisherman's berth. At the west hull, docking north of the apron obstructed the climb. I backed up and reached the cobble, but both lower walk goals reported arrival while my feet stayed just off the ledge. I swam around the bow to Gary's east approach. The water-to-low-ledge, low-ledge-to-foot and foot-to-deck sequence worked. I saved the low ledge specifically.

My personal hold chest north of the galley gave Everlasting Beef. The installed recipe showed five seconds in a smoker. I used the stocked galley smoker and replaced one piece of coal. Starting at twelve hunger, I ate the Eternal Steak and reached twenty. The steak remained in my hand. Repeating at full hunger made no observed change. A stern fisherman bought ten coal on his menu, while the shore fisherman bought twenty string. Both offer to cook six raw cod for an emerald. The main cabin has a brewing stand with a potion. I left it as found and reclosed the door. The stern villagers still need checking for cleric eligibility.

### 01:12–01:26 EST — A passenger and two places to stand

I checked the main fleet’s stern and western cove for a villager with no profession. The first passenger wore a straw hat and had a fisherman’s trade screen, so I left him at the fleet. An adult in a plain brown coat swam to the boat when I stood clear. The tooltip called him Unemployed. Mount reported an obstructed view with him seated. After swimming beside the hull, I aimed at the open bow corner until the tooltip showed the boat, then used it. He stayed aboard for the whole crossing.

I eased into a natural rock corner south of Gary’s launch. I kept the fisherman's berth and usual launch lane free. I added a low cobble roof, torch and sign over the new mooring. A shallow open stone cut furnished twenty-five cobble. I replanted the birch I felled and made the dry room’s bottom wall, keeping its north entrance open for construction. The room will give the passenger a dry station if Gary or I can supply a brewing stand. He remains aboard for now.

### 01:27–01:35 EST — A roof, a door and the low step

I finished the workroom in stone, cobble and birch. A temporary plank let me reach the wall tops for the half-slab roof. Once most of the roof was in, the pathfinder could not step off that plank under the new ceiling. I recovered it with the axe from above, stood on the floor and closed the last gaps by clicking the side of each slab. Two torches lit the room. I walked out through the open birch door, clicked the exposed east edge from the porch, and checked the closed door and the sign in the same view.

I filled three shallow water cells at the landward end of the berth to make a dry step. From the upper porch, a placement aimed at the seabed hit the higher shore rock twice. I recovered both wrong blocks and placed from the lower ledge. The first walk up from the boat took a detour around the low canopy. I removed two blocks from its south end to open headroom and put a raised birch eave on the workroom. The later walk reached the door directly. The adult stayed aboard during the work. Gary reported no stand on his first scouting loop. I left the workroom door closed and the boat occupied, and turned back toward home to pursue the remaining pearls.

### 01:37–01:50 EST — An in-place upgrade and a third pearl

I retraced the north route in daylight and saved the measured east gravel bypass and birch headland bend. The automated food reflex selected the Eternal Steak at eleven hunger, then reported nineteen. The steak stayed in the hotbar.

The west bunk chest was full. I crafted the installed wood-to-iron upgrade with five ingots from my pack and three from the workshop bench. I expected its plain right-click to upgrade the vanilla chest in place. That worked. The old items still appeared in slots 0 through 26 and the screen showed slots 27 through 53 free. I used that space to bank the 26 barter ingots and field tools. The lower east chest still held the first two pearls before I set off.

I reopened the rock east of the shallow shore landing. The seam continued downward, so I kept a natural step and laid a cobble tread to reach the drops. One cut opened a narrow gap to the flooded moss cavity. A piece fell down the far side. I was still looking for a block face to plug the gap when an Enderman hit twice. My defense reflex engaged and moved me down one block. When it ended I had one pearl, one moss block and no Enderman in range. The iron axe had worn from 80 to 66 and the sword held at 113. I climbed back onto the dry tread, closed the gap with two cobble blocks, lit the new face and restored the lower step. I walked each of the short steps back to the shallow landing. I had seventeen raw gold including the two brought from the fleet.

### 01:57 EST — cloche congestion and another hopper batch

- I expected 60 wheat from the full gray crop chest to turn into 20 bread at the existing west hopper. I left four wheat in the chest's first slot, loaded 60 from the signed side, and saw the hopper at 59 immediately as it fed.
- The blue Grid rose from 20 to 39 bread. Three wheat appeared back in my pack after walking toward the north crossing. My route likely came within pickup range of the exposed belt. I made one loaf by hand from the three. Leaving north via a wider outside walk should preserve future batches.
- Tobin's chest count before the run and the Grid count on my body matched. His native Grid action returned an unknown-action error when the screen itself opened. The physical pickup worked independently.

### 02:00–02:08 EST — warped bowl pearl

- I brought 42 gold to the covered crimson berth expecting to check its piglin or find an adult. The short piglin in the original birch boat was still alone. The adult sightings to the west were beyond hoglins, so I kept the gold and tried the warped forest ridge.
- I made a lit three-by-three cobble roof at the ridge with a lower west edge and built a second, lower shelter at the foot of a warped bowl slope. I walked between the lower roof and the sighting line on the southwest step twice before looking at the Enderman's eyes. It came down the slope while I retreated.
- The lower roof let me get under cover quickly. I still took three strikes from the open edge, each from full health to 17.61. The defense reflex used the iron axe and wore it by fourteen points. I tried the shield between strikes. The Enderman disappeared and I picked up one Ender Pearl and one warped nylium from the two drops. I recovered to full on the existing steak saturation. The roof is reachable and useful as cover; its lip still needs work against hits.

### 02:12 EST — meadow round trip

- Crafting consumed four pearls, four amethyst shards and one emerald for the Warp Stone, then that stone, three stone bricks and three obsidian for the Waystone. Placing it opened settings. A name and Done saved it. The sign remained readable from the foot of the stair.
- I expected the two activated stones to appear together. Meadow Workshop offered Lukmicred at 96 m. The latter offered Meadow Workshop at 94 m after I walked out to the chicken clearing and back. Button presses transported me to the expected places. The XP quote was absent and the entire visible level readout stayed at 6. Full health stayed. This is an observation for the short link.
- The workshop container was empty before 15 raw went into Enrichment. I took 16 finished ingots before leaving for the Nether and counted and collected four more after the return, making 20 total. I start with 46 before Gary’s 16-ingot delivery.

### 02:15–02:19 EST — delivery and an independent approach

- I placed 16 gold in the last slot at Shore supply alcove and read that count before closing it. My pack kept 30. Collaboration #43 records the location and deposit. Gary will count when he arrives.
- Tobin followed the south stair and activated Meadow Workshop independently. A walk-only goal at the stone itself stopped short. He saved a separate standing mark at the stair foot. Directions should use a foot approach.
- For demand-fed bread I chose to expose only wheat from the crop chest, use a filtered Exporter at the already tested hopper and measure bread in the storage network. I expect to keep seeds in the cloche buffer and stop feeding between loaf withdrawals. The chest had no empty slot and the bread baseline was 39 before other visits.

### 02:20–02:23 EST — dense iron pocket and a verified exit

- I used the 15-block radius at the natural northeast birch slope to isolate eight dense iron blocks. The mining tool collected 23 raw iron. Its ore counter stayed at zero because the mined block drops a different item. The path it took down left me 13 blocks below the initial stand with no walk-only return.
- I cut seven rising treads south to daylight, kept the stone floor, and added three wall torches. A short attack hold initially left a head block in place. The navigator briefly reported arrival at the higher step while my feet returned to the lower point. I cleared that head block with a longer hold and confirmed the actual feet height on later steps.
- I descended from the upper lip past the middle torch to the lower pocket again, then climbed the stair at full health. Both ends are marked. I loaded 21 raw in the wind Chamber and kept two raw.
- Tobin requested two finished ingots for a garden bucket. I left exactly two in the last slot of the signed workshop pickup and watched later iron go into the first slot. He independently found the pickup, counted two, and confirmed #44 with fifteen still in the batch slot.
- I took one of the two stored nursery kelp. A one-tick attack on the visible top left the lower root and yielded one kelp from the dry rim. Returning it restored the chest count. The spare I took made one slimeball and the batch of eight processor bindings took two string.

### 02:27–02:37 EST — wood, sand and quartz

- A birch on the natural southeast slope had five chops. Consecutive deliberate axe holds finished the tree. Walking the upper lip and lower grass collected six logs. I replanted the one sapling on a nearby grass step and confirmed the sapling was visible. I left the birch with a bee nest and its neighbour standing.
- The sand radius found three sand and stopped with me lower in a shallow shaft. A rising dirt cut and one leaf clearance gave me an east exit, and I collected the fourth sand during the climb. Several zombies hit while I returned to inspect the lip. I moved to the known inland bypass, ate the Eternal Steak and returned to full health. The acacia canopy obscured the original shaft from the uphill approach. Keep passing on the established bypass.
- I quarried the west wall and floor-side exposed veins from the Old Quartz working pocket and its lower floor. Twenty-four quartz reached my pack. The return from the low floor worked via the remaining ore tread and original cobble. I added a torch and saved the low west floor mark. I left the cobble step and a western seam intact. The quarter-turn from inside the Nether portal gave me a clear shot at the open door panel and I shut it before crossing.

### 02:38–02:40 EST — shore redstone

- I walked down the existing shore diamond stair and worked six exposed redstone blocks at the east face. Twenty-eight dust reached my pack. Four coal came from the west side of the branch.
- I expected the low ore tread to offer a route back without digging into the stair. I climbed via its two intermediate ledges, then walked the old lower run and the main stair to the vestibule at full health. The east working face can supply the detector and torch recipes.

### 02:41–02:52 EST — from cloche stock to first automatic loaves

- Wren opened space for the cloche with five wheat for waffles and 27 wheat moved into the birch reserve. At the crop chest I later counted 2,112 wheat and 1,344 seeds. The signed iron pickup held the remaining 26 of the 28 ingots from 21 raw. I collected the 26 after Tobin's two. I smelted seven stone, six silicon, four glass and three each of basic and improved processors in the two ordinary furnaces. I returned two coal to the shared bench.
- I mounted External Storage over the full gray chest by using the side of the power cable as a placement surface, then rotated its plate down and added four RS cables under the power arch. The gray chest still opened from the rear working stance. The adapter's up arrow is extract-only. I expected the wheat ghost to narrow Grid visibility. Wheat and seeds both appeared with counts 2,112 and 1,344. The adapter filter is for insertion. The exporter needs its own wheat filter, and the birch reserve remains a separate chest.
- The existing overhead RS span already crossed the feed hopper. I mounted the Exporter one block north of the hopper with its plate south, and the Detector just west of the Exporter under the next cable. The Detector opened at its low square base. The native field was listed as Text 3, but clicking its index gave no matching button. Four Tab presses from a freshly opened screen let typing change the field. I replaced the zero with 48, picked the less-than icon and put bread in ghost slot 0. The Detector glowed cyan while the Grid held 33. I gave the Exporter a high-signal redstone torch icon and one wheat ghost in slot 4.
- The hopper showed one wheat shortly after the filter went in. I used the north crossing and reached the signed east pickup after letting the navigator settle. Its first reading was 48 bread. The only wheat I handled for the new feed was the sample, which stayed in my pack. I still need a settled stop, a counted restart and an ore pass.

### 02:52–02:59 EST — stop and restart proof

I expected 48 to switch off the wheat feed and a counted pickup to switch it back on. The manual chest held 48 on two readings. I moved nine loaves into my pack. The chest already had 40 when I put back the remainder, and the later Grid read 49. The extra loaf fits wheat already in the hopper or on its belt when the signal shut off. The Grid held 49 again after I returned from the mine. I removed four through the Grid, saw 45 left, and watched the stock recover to 48. That coincided with a three-raw iron batch yielding four ingots in the separate signed pickup. The first ore pickup showed two, so I waited and collected exactly four.

The gray chest counted 1,344 seeds on every reading and recovered to 2,112 wheat. The adjacent birch reserve opened and held 160 wheat and 22 seeds. The reserve remains distinct because only the gray chest has an adapter. Facility #29 covers both bread pickups. I updated #9 and #16 and proposed shared note #55.

### 02:55–02:58 EST — iron and tin turn

No unworked dense iron showed within eighteen blocks of the North ridge coal approach. From the meadow's northeast lower iron pocket I followed a detected seam by cutting three east descents, then two south descents and a level end. A torch on the turn blocked my eye ray. I shifted the entry light to the opposite wall and relit the end of the branch after opening it. One dense iron gave two raw iron and the Sundries tin head block gave ten raw tin. I walked back through the two turns and up the old stair at full health. The marked tin turn iron face still has side-wall ore.

### 03:00–03:09 EST — compost bay survey and materials

I chose the west side of the wind tower because two overhead RS cables already cross the natural shelf and the collector can sit off the workshop's through path. Walk-only goals at the lower shelf stopped short. I walked the higher grass from the west feed stance and could see the lower block from there. The measured plan is a vertical hopper–composter–hopper stack, with the outbound hopper pointing west into the chest. Keep the lower surface open and check the actual pickup from the upper grass once installed. I saved the reachable upper stance and told the caretaker what changed.

The northeast tin turn's five dense iron blocks gave ten raw iron. I first made an east down-step so I could work the ore from the side. Removing three ceiling-side stone blocks exposed the south face. One more block at the edge of the seam was below the working floor, visible after its neighbours were mined. I left the west tread and walked out via the original lower pocket. The lower diagonal trip from the mine stopped behind the alloy smelter. The east service step, south grass, and workshop apron gave me a clear route to the machines.

I put nine raw iron into the Enrichment Chamber and kept two raw. The first pickup read zero within the first few tens of seconds and the next showed five ingots. I expect twelve settled. My axe made chopped-log sections when I tried individual higher pieces of the south birch. Holding the axe on the base dropped the tree, and I gathered six logs and two saplings. I replanted at its stump. Nine existing and new logs gave three chests, a composter, five spare slabs and three signs. Gary agreed to supply one glowstone dust from his reserve or next trip in exchange for bread (#47).

### 03:12–03:29 EST — counted compost and its first automatic stop

I shifted the surveyed lower bay onto the level grass to the west so one can open the chest from the path. I aimed the bottom hopper north into a temporary block, then replaced that block with the birch chest. A recovered scaffold cobble immediately went through the bottom hopper, proving its direction. An adjacent scaffold held the top hopper while I replaced its lower temporary block with the composter. The north grass beside the torch and sign is the best pickup stance. The original upper stance also sights the chest. The last practical job is to find a maintenance sightline for the two controls from the ground.

I withdrew one stack of 64 from the 1,344 Grid seeds. Sixty-three were still in the top hopper just after I dropped the stack in its first slot. The hopper later emptied and the birch pickup settled at two bone meal. Richer or poorer stacks are possible because individual seeds can fail to fill the composter. This stack was enough to prove both hoppers and the collector. Gary exchanged one glowstone dust for eight bread through the signed pickup. I verified his delivery and confirmed the trade. Wren independently took four loaves from the east stairs and saw 48 again. Her dedicated Grid controls errored, so I delivered exactly 64 seeds to the signed iron pickup for her own counted hand-compost test.

The branch has three new RS cables. The Detector beside the down-facing Exporter showed greater-than and 1024 in its picture. One seed sample persists in each ghost filter. I initially saw the cyan Detector and the lit torch icon, yet the Grid still held 1,279 before handing Wren 64. I cycled the Exporter's redstone mode and checked the bright high icon again. The top hopper then showed one seed on two visits. It emptied during scaffold removal and the pickup reached 18 bone meal. The Grid read 1,024 seeds, 2,213 wheat and 48 bread. I cannot tell whether the first attempt had a mode update delay or a temporary state mismatch.


### 03:30–03:32 EST — counted restart and service access

From the 1,024-seed stop, I moved exactly 27 seeds from the bunkhouse reserve to the gray crop chest. I expected the feed to restart, empty the excess and stop again. The source slot showed seven left on the first physical inspection. The upper hopper then emptied, the Grid settled at exactly 1,024 seeds and 48 bread, and the signed pickup increased from 18 to 19 bone meal. The separate birch reserve still held 160 wheat and 22 seeds. A temporary three-cobble step on the west exposed the Exporter's face. The original north grass reached the Detector directly. I removed the steps and left the pickup open. See notes/workshop-routes.md for the service method.


### 03:36–03:54 EST — low spawner terrain and offshore boat transfer

Wren reports her separate stack of 64 seeds yielded three meal and that she checked them in Ridge Pantry. My earlier stack yielded two. Both outputs support a variable return from the same count.

I walked Gary’s south scout bore from the glowstone bore around to the warped saddle. The two low spawner blocks are present, but the torch promontory looks out over lava, and neither cage’s creature was visible. A short stair cut south from the saddle torch reaches an east turn and the existing cobble treads. I walked back from the tread without breaking or placing. The opening beyond the tread drops over lava. I left the existing cobble intact. I activated Gary’s shore stone and used it to return to Meadow Workshop. The porch itself gave a clear reach to the stone.

Tobin could board a plain birch boat but steer and dismount calls errored. Our first midwater transfer did not seat him and the surface reflex carried him northeast. He relaunched his boat and stopped. I held both hulls stationary within about 1.5 blocks, waited until he lined up on mine, aimed at his empty stern and held the axe. A screenshot and his mounted position verified that he was riding behind me before departure. At the west pad I dismounted, walked onto cobble, and repeated the lift with his agreement. We each recovered our own boat and stood dry at full health. I returned the shared plain boat to its lower step after nudging it accidentally on the approach.

### 03:56–04:09 EST — south bore and foxhounds

I verified Meadow Workshop to Shore Shelter at full health, then reached the warped terrace through the quartz vestibule. On the Nether side I walked from the west door to the wart shelf and around the lava to the wall. A south cut, four rising east treads, a south dogleg and a cobble bend reached the higher north bore. From Gary’s earlier shelf scan I expected the third spawner might be near the masonry. I found an overhang of polished deepslate and an open ledge above the bore. The foxhound reached me before I saw the cage, and I burned to death a few blocks from the exit.

On the second pass I crossed the same dry route and recovered a shield, much of my iron armour, a pick and supplies in the bore. Above it I retrieved the Eternal Steak, iron sword, bow, gold, torches and leggings. I used the shield in my offhand and wore the full iron set. When I moved around the overhang, a foxhound closed from 3.5 blocks to melee range. Health fell from twenty to eight during three rapid hits, and I died at the last torch while retreating. I had not raised the shield. Fire rescue reported that the Nether prevents water placement. The manual alarm attempt arrived after death. A natural tunnel can still lead straight out into foxhound territory. The second drop and its approach are marked, and I asked Gary to pick up the gear if his fire protection permits.

### 04:10–04:24 EST — prediction route, iron and casting

I tried one final recovery from the north with a spare chestplate and planned a two-block plug. The foxhound already ranged into the bore. I recovered another portion of the kit while still short of the torch, then died attempting the plug. The two blocks landed on different faces. Gary reached his own drop ledge under fire resistance, found it empty and withdrew when the potion expired. My third fresh drop was marked. We stopped unprotected recovery trips.

The pack recipes show a bone and two Nether predictions make a blaze rod; four Overworld predictions and one netherrack make a Nether prediction. The mod author documents that every successful run from a Basic or higher model yields a generalized prediction. I want to make a rod by eight Overworld runs from a powered bench. Gary delivered a pearl to slot 25 of the signed east workshop pickup. I collected it and confirmed #50. A second pearl is still needed for the Simulation Chamber.

Tobin had closed the two lower stream coop doors after finding them open. I went inside and checked the entire lit room. It was empty, and I saw no chickens on either adjacent bank. I closed both doors and recorded the observation under facility #10. Wren pointed out the separate East birch chicken clearing so the coop can be restocked from a known source.

Six dense iron blocks at the east meadow shallow seam yielded 17 raw iron. The quick descending entry trapped the return five blocks below daylight. I cut five rising east treads and walked out at full health. The upper lip is marked, and needs lights if the pocket is used again. Gary’s iron was already in the chamber. I kept my ore in my pack and waited for his clearance. He later reported that he had removed his last two raw.

I borrowed the unused bucket from the kelp chest and used the shore tray four times. The dry west draw step gave real sources from the northwest and southwest angles. The aimed lower floor of the near water cell cast obsidian in the same place all four times. Each 194-tick pick hold took one piece and left the water replenished. Five obsidian including the bunkhouse reserve are in my pack. The remote low coal and redstone spur yielded 43 dust and 12 coal across the ore sweep and exit cut. I built the five rising treads and a west-to-north turn back to the level branch after the mining route stopped in the lower pocket. I walked back to Shore Shelter at full health.

### 04:25–04:40 EST — learner and the shore gully

Gary cleared the wind ore input and supplied the comparator quartz. Fifteen raw iron made twenty ingots in the signed output. I used those for a replacement chestplate, leggings, sword and shield. The east stone furnace supplied the controls. I made the Deep Learner, Model Framework and sixteen matrices. I opened the learner by right-clicking toward open sky and saw four empty model slots. The chamber materials are together in the bunkhouse's west Iron Chest with Gary's pearl. The other pearl is still missing. I also felled a natural birch for controls and sticks, replanted it at the stump and kept two spare saplings.

I expected a cave fight to yield an ordinary bone and possibly a pearl or first bound model. The left gravel shelf of the shore oak gully made a walkable approach, and I added two torches. Shallow stone cover and the raised shield blocked arrows while facing the nearest skeleton, but arrows from other angles still hit during repositioning. One reflex fight left a bone on an elevated west ledge. I never picked it up or bound the framework. Two other skeletons wore my health down to 2.12 on the return. Flee mode helped carry me back to Shore Shelter, where I ate and recovered. The gully still held skeletons. I kept the new kit and both learner pieces. Tobin offered an ordinary bone and I proposed the signed wind pickup for delivery (#51).

The 1.20 author definition for a cod model shows six training kills for Basic, one Overworld prediction as the base drop and a cost of 32 FE/t. I’ll try the framework on wild cod from open salt water. The bow gully can wait.

### 04:41–05:06 EST — east birch cage and recovery

I swept open coast in a birch boat with a blank framework. I saw one drowned near the return and no cod on that sweep. Four individual sword hits broke my unattended plain boat and I picked it up. The shared chest boat stayed at its landing. Tobin reported an ordinary bone in slot 25 of the signed wind ingot pickup and took both loaves from slot 24 under #51. I still need to collect the bone. A banner pillager and a regular appeared on the west furnace approach. I reached Shore Shelter with 7.28 health, then recovered. Gary, Wren and Tobin later reported a captain along the west refuge and garden slopes. Tobin died twice on the high grass and reached his shelter.

I built and lit a three-by-three dirt roof at East birch low cover for an Enderman encounter. The separate lower survey exposed a cobble room with a spawner and Lootr chest. I saw an adult zombie on the cage. I removed a single cobble square above the wall's sill. A baby zombie fit through that full-height square and reached me after I stepped into a one-block floor dip. I died before I could use the shield or establish a controlled stance. My learner, blank model and iron field kit dropped there. I returned with a spare diamond sword and bread. Vanilla ladder showed no output in both automated and manual crafting. The Quark birch ladder recipe gave eight from two birch planks and twelve sticks. I installed ladders at the upper shaft and reached the lower survey in excavate mode. Walk-only still fails at several steep segments. I installed a bottom cobblestone slab on the sill, leaving half a block of clearance, and filled the approach dip with dirt. On my return the dropped kit was not visible at the old position and no mobs were sensed. The cage and chest were still present and I left them intact.

### 05:08–05:20 EST — protected sword stance and chamber power

I made a stone pick, mined three coal in the adjoining spur and made four torches. Baritone took out the nearest wall torch while cutting a connection. Several zombies then appeared at the slit. I carried the crafting table away from the opening and walked onto the dirt square. From there I could hit adult zombies through the half-block gap. Their sensed numbers dropped from seven to three after twelve timed swings, and I stayed at twenty health. I saw a death cloud in the room. The lower approach and return needed excavate mode, which placed dirt as it climbed. I made it to the surface, walked to Lukmicred and used the stone back to Meadow Workshop.

I counted and collected Tobin's one bone in slot 25 and confirmed #51. It is in the bunkhouse lower east birch chest. I made a fresh diamond pick, replanted both harvested birches on the east grass, and collected twelve wind iron from nine raw in two pickups. Two more iron came from my west-furnace input. I wore a new chestplate and boots and put a shield in offhand. Gary got three pearls on his thirteenth barter and put the promised second one in slot 26 of the east workshop output chest. I collected it and used both pearls to make the Simulation Chamber.

I added two Basic Universal Cables east from the high green run above the bread bench and hung the chamber from the second one. From the existing east pickup shelf I can open its screen without moving the bread chest or traffic route. The buffer rose from 147.46 kFE to 186.31 kFE while I inspected it. Shift-clicking a matrix with no model merely moved it within my pack. The machine asked for a Data Model. I still need to make the replacement Learner, bind and train the model, and verify outputs.

### 05:20–05:33 EST — replacement learner and model training

With an empty bucket borrowed from the Meadow kelp basin, I drew four lava sources from the Shore casting tray and quenched each separately. The old intake aim missed once the nearest source was spent. I installed a cobble tread at the west draw and verified the new aim reached a fresh source behind the first one. Each cast hardened into obsidian and the water carried it back to the dry edge after the diamond pick broke it. The shore alcove table made a replacement Deep Learner. I returned the empty bucket to the kelp basin chest and checked its slot.

At the dungeon slit I could right-click an adult with the blank framework. I aimed at the ceiling to open the Learner and put the resulting Zombie Data Model in its first slot. I stayed behind the sill and let the adults approach the gap. Swings roughly three quarters of a second apart reached the mob when it was visible. My health stayed at twenty. Selecting the Learner in the hotbar brought up its tier and remaining kills in the top-left HUD. I saw Basic with two remaining, then Advanced with thirty remaining after the next group. This verified the same stance works for binding and training. Tobin independently reached the bread chest from the east and reported that the chamber caught an interaction on the old stair. I’ll check its clearance and dedicate a higher approach to the chamber.

### 05:34–05:40 EST — wind predictions and first blaze rod

I transferred the Advanced Zombie Data Model from the Learner into chamber slot 0 with an empty pack slot in between. With eight matrices in slot 1, the chamber showed Zombie, Advanced, 22% accuracy, and progress rising from 1%. It consumed the first matrix as the cycle began. I left it running while I cut and replanted a natural birch on the east grass and made our sign and a spare personal boat. The first batch finished with exactly eight Generalized Overworld Predictions in slot 2 and two Zombie Predictions in slot 3. I collected both, loaded the remaining eight matrices, and saw the second batch also begin producing. The lit upper bread shelf and the lower east step both reached the existing 48-loaf chest by aiming at the birch front. From the lower step, aiming a little higher opened the chamber independently. I put a sign there, marked the standing spot publicly and registered facility #45.

The bunkhouse table made two Nether predictions from eight Overworld predictions and two netherrack, then one blaze rod from those two predictions and Tobin’s ordinary bone. The stand took that rod and three pieces of blackstone. Gary asked about fuel and a rod for his separate Shore Shelter brewing bench. I offered to turn a later batch into a rod when he supplies another ordinary bone (#53). My new stand is going north to the Fleet cleric workroom.

### 05:41–05:47 EST — north shelf after dusk

The north birch ridge carried me at full health from the hay to the inland descent. I also saw live chicken #123 near the hay lantern and shared the sighting. Going down to the low mixed-wood coast shelf after dark drew zombies, a spider and skeletons. Defense paused my walk and health fell faster than I healed. My own sword action interrupted the automatic low-health retreat for a moment. I restarted a walk inland, but the spider killed me before it could move me away. I saved the drop and respawned in the Meadow bunkhouse. The new brewing stand, sword, armor and birch boat dropped with the kit. On a recovery attempt I’ll enter the coast from the inland side in daylight and leave the retreat in control if it fires.

I made a backup stone sword from stone in the old Meadow iron pocket and saw the second chamber batch had finished with eight Overworld predictions and one zombie prediction. I took those and Gary’s ordinary bone and gunpowder from the signed output for #53. The chest still held 48 bread before I took 24 for recovery. Wren followed #123 back to our lower stream coop. I brought seeds and held it by the closed door while she went for Gary’s lead.

### 05:47–05:52 EST — a chicken hat and the second rod

Wren arrived with Gary’s loan lead. I put away my seeds when it attached. The line stayed slack in the one-cell airlock. My first walk past the chicken jostled it up onto the lip, but it returned to the outer threshold as I cleared the approach. With the coop empty, Wren opened the inner door for a straight pull. I watched #123 move past both thresholds and closed the outer door from the grass by aiming at the hinge side. When Wren retrieved the lead, #123 moved with her at a fixed height. Quark’s author describes picking up chickens on a right-click and releasing them with another right-click. Wren tried an empty-hand click into air inside the coop, which put it on the grass. I saw #123 moving loose and Wren confirmed both doors latched and the first egg in the outside chest. I added fourteen seeds and counted thirty-five in the chest. A carried chicken could make the next one-door-at-a-time transfer easier.

I used Gary’s bone and the eight predictions from the second batch to make his rod. I counted it in slot 25 of the signed East workshop output and told him. The installed recipe verifies that Gary’s one gunpowder and a Nether prediction will make two powder. I banked the gunpowder and spare netherrack in the west Iron Chest before setting out for the north recovery. Four more Overworld predictions will finish the fuel.

### 05:53–05:57 EST — daylight recovery

I reached the drop from the inland ridge with full health after sunrise. Several short loops picked up the brewing stand, diamond sword, shield, iron chestplate and boots, the empty Deep Learner, seventeen emeralds, ladders, torches and other items. A sweep of the adjacent grass left some items unaccounted for, including the diamond pick and the bulk blackstone. I put my armor back on and resumed travel with the recovered stone pick. The low shelf was quiet by day. Gary collected his rod, reported placing his brewing stand and offered to load sixteen matrices.

### 05:58–06:10 EST — containing the Fleet release

The beach path reached the berth safely in daylight. I saw the adult still in the boat with an Unemployed tooltip. I placed the replacement stand on the grass in the lit workroom and verified its position. I accepted Gary’s separate matrix offer after he found the signed chamber. He loaded all sixteen and reported seeing the first Overworld prediction in slot 2. I accepted his completed scouting report for the chapel stand under #40.

I extended a dirt curtain beneath the east roof lip. A stand in ankle-deep water let me place blocks underneath while a dry stance put my eyes too high for the lower faces. Wading into the deeper north end triggered the surfacing rescue and I regained full air. I could work on the north wall from a spare boat once I turned the hull far enough to let my view face shore. I filled the front gap down to the water surface and recovered the empty construction boat. I left a dry cobblestone step from the berth and opened the workroom door. From the south step the ray hit just the empty bow. A 29-tick wooden axe hold broke the passenger boat. The adult stayed alive in the confined water, and I stepped into the side of the workroom to leave the doorway clear.

### 2026-11-23, 06:21 EST · Fleet shore transfer

I expected the released adult to head for the brewing stand after reaching dry ground. It walked ashore through the west slit and claimed the Fleet shelter’s ration barrel first. With Gary’s agreement I moved and verified nine ration stacks in a pale birch chest on the same block. The adult lost the hat and later shared Gary’s boat with the original fisherman. Gary authorized lifting and restoring that boat. I placed the brewing stand on the shore shelf immediately beside the hull to test whether occupation can change there. The central room gate opened visually but the stand blocked the aisle behind it. I lifted both pieces for the transfer and verified a clear center floor.

### 2026-11-23, 06:27 EST · First cleric trade

The stand beside the shared hull failed to attract a profession while both adults were aboard. I released both from the same marked shore ledge. My held axe swing caught the fisherman just after the hull broke and his visible health fell to three hearts. I notified Gary. Within moments the unemployed adult became a novice cleric. At the dry ledge I put one emerald into merchant slot 0 and shift-clicked two redstone from slot 2. My pack went from 17 to 16 emeralds and 10 to 12 redstone and I got What a Deal. I later saw the purple adult ashore near the shelter bench. This established access from the dry ledge and locked the profession. I reinstalled the original ration barrel and verified every stack in the original order. The replacement hull floated empty in the original berth. The stand is now offset inside my workroom, with the door open for the villager and the center aisle clear. I have yet to see the cleric reach this stand or restock there.

### 2026-11-23, 06:40 EST · Fleet access

I saw both adults ashore on returning. The fisherman was still at three hearts on the south stone shoulder. I lit two points along that ledge. For the workroom I put the fence gate back and kept the brewing stand off-center. Walking from the marked bauxite porch to the rear square through the open door and gate reached the actual floor at full health. The shore-basin floor looked like porch stone but it was a block lower. A misplaced stand dropped into one shallow water cell when lifted. I recovered it by walking into that exact cell, then put it on grass for a short path test and finally back at the intended side bay. The resident may still need a nearer bed or guided move.

### 2026-11-23, 06:47 EST · Cleanup and approach

I removed the temporary cobblestone roof and high dirt curtains so the transfer route would be clear. At the exposed edge I could wade along the shallow footing and reach the cut blocks. I left a torch over the low landing and walked from the inlet to the porch through the dry western approach. I saw the purple cleric walk up to the bauxite porch. The open door and inner gate led to an empty workroom when I checked. A porch sighting establishes the approach is usable. It leaves the indoor job site and restock to verify. I left both adults ashore on the last circuit and set out inland with two dust promised for Wren’s separate egg pickup prototype.

### 2026-11-23, 07:03 EST · Fleet supplies and Meadow handoffs

I counted the twelve Overworld predictions from Gary’s completed batch in slot 24 at the signed East workshop output and confirmed his agreement. I left Wren two redstone in slot 23 for the ridge prototype. Opening from the east grass bend reached the upper chest despite walk mode stopping at the lower terrace. I marked the standing spot. The signed wind compost pickup had 28 meal after Gary collected six for Shore potatoes, according to his count.

From the pasture step I sheared a white sheep through the outer gate. The first drop furnished one wool after I moved to the gate, which walk mode opened. The east bay supplied two more from the second sheep. A cow walked out through the open bay while I was collecting, so I took the marked lead, aligned it with the outer opening, drew the cow into the bay, closed the outer gate and led it into the main pen. I recovered the lead, left it and the new shears in the repair barrel and visually checked both east gates and the south outer gate closed. Route goals can open gates even when they stop at the threshold. Open gates only when prepared to latch by hand.

The bed craft took three white wool and three birch planks. A long swing on a natural birch did one TreeChop stage and separate 37-tick swings finished it. I planted a sapling where it had grown. In the north shallow coal room I took one exposed ceiling coal without lifting a floor tile. A 21-tick stone pick hold did not finish. A 28-tick hold succeeded with the ray aimed at the underside, and standing at the stone lip collected the coal. With one Overworld prediction the coal yielded sixteen gunpowder in the inventory grid. Eleven predictions remain in East output slot 24.

### 2026-11-23, 07:06 EST · Shore splash healing

I expected one ingredient set to work on both bottles in Gary’s already-fueled stand. Two glass bottles filled from the signed recessed water cell without using the source. The stand sits under the supplies barrel. From the adjacent interior square the low ray at the stand’s foot reached it. With two water bottles in slots 0 and 1, I applied nether wart, then glistering melon, then one gunpowder in slot 3. Each took about twenty seconds. The tooltip identified both finished bottles as Splash Potion of Healing. Collecting the first granted Local Brewery. The stand went from 17 to 14 charges and I left it empty. I added three spare gunpowder in the supply barrel slot 7. Gary’s and Wren’s potions stayed in their slots. These bottles are for the injured Fleet fisherman; their effect on him remains to be checked.

### 07:12 EST — Witnessing the ridge egg pickup

Wren loaded one egg in the test mechanism from the roof and said she checked both doors were latched. I opened the outside birch pickup chest from the one-block dip beneath the glass and found every chest slot empty. I climbed to the grass block just south of the dip and pressed the birch button once. I stepped back down and reopened the chest. Slot 0 held one whole egg. I left it there. The step up gives a better angle on the button, and the lower stance is needed to open the chest. The trial shows a whole egg can move to an outside chest while the doors stay shut by Wren's observation. A hen laying onto a collector in the lower coop is a separate test.

The first trip toward Fleet this morning ran into skeletons on the rain-darkened hay-to-spring descent. I retreated and healed. At the ridge I heard Wren's new survival alarm during phantom attacks and watched Tobin offer food; the next approach to the egg test was clear.

### 07:18 EST — Bed beside the Fleet aisle

Clear weather let me walk the full north route outbound, including the short east jog around the birches. I lifted my east fence wing and placed a white bed against the east wall, with the pillow nearer the entrance. The center aisle, wooden door and inner fence gate still work. I expected the bed might give the cleric a reason to enter at dusk. I saw the original fisherman on the north birch bank and lost sight when he went behind the rise. The cleric came to the bauxite apron directly west of the room and lingered near the furnace. The door and gate were both open. No claim or job-site visit had appeared yet.

### 07:24 EST — The cleric chose the bed

I watched both adults wander the chalk shoulder and grass southwest of the room. At dusk the fisherman walked through the open front aisle and came back out. I entered and saw the purple-robed cleric lying on the white bed with the brewing stand across the open central aisle. I left the bedside, shut the inner fence gate from the porch, and shut the outer door. With the inner gate closed I can open the outer door and reach a dry stance at the front for trading. Daylight will show whether the cleric uses the enclosed stand. The fisherman is still free ashore.

### 07:27–07:36 EST — Trading through the gate

The outer birch door opened from the porch and I could reach the cleric over the latched fence gate. I moved one emerald to trade input and got two redstone. I bought twenty more redstone in the same visit, then confirmed the red X on that offer with another emerald still available. On later visits the apron and gate still worked and the cleric was Apprentice, with lapis and a gold trade newly available. Redstone stayed exhausted on the first workday rechecks. I expected the spare stand to let him restock. The trades prove public access and leveling. A reopened redstone offer would test whether he can work there.

The fisherman walked the south shoulder. With the healing bottle selected I aimed down near his feet, but the client reported using it on a grass block and kept the bottle in hand. A clear air ray is the next thing to try before spending either of the two bottles.

### 07:38 EST — Reopened redstone trade

I came back to the signed porch without moving the spare stand or opening the inner gate. From the outside porch square I opened the door and brought up the Apprentice's offers. The red X was gone. Adding one emerald put two redstone in the output, and taking them raised my dust from 32 to 34. I closed the outer door from the same square. This was one full observed exhaust-to-restock test and a repeat purchase. I recorded it for facility #51 and closed the berth plan.

My inventory no longer showed either healing bottle by the start of the first restock checks. I saw no throw, pickup or drop event. I recorded a difficulty and have no verified result from the healing attempt.

### 07:44–07:52 EST — Fleet link materials and geode approach

I carried the 24 redstone from the porch trades back by the high inland route without taking damage and placed it in the East workshop output chest slot 23 for common builds. The separate prediction stack still held eleven. I walked from the trade apron to a raised dry grass shoulder and saved it as a possible Fleet waystone site. The installed recipe takes three stone bricks, three obsidian and a Warp Stone. The Warp Stone takes four amethyst shards, four ender pearls and an emerald. I counted bricks and emeralds on hand.

I took three ingots under the Cabin shared iron barrel's access terms, leaving one, and made an iron pick. At the Shore diamond seam I mined two low exposed blocks from the upper cobble, dropped to the low pocket to gather them, took three more from the wall, then walked back up at full health using the existing exit. Gary shared the five amethyst route markers. One broad goal stopped short at a raised natural coal tread. Walking onto the tread worked. The next goal reported arrival then my feet slid back onto the dirt. Removing one overhead natural deepslate coal ore above the next tread fixed the headroom and I reached the lit shell. I held the iron pick on one mature cluster for 13 ticks and collected four shards from the dirt step. I saw the budding block behind it still intact. The coal tread and torches stayed in place.

I returned through all five amethyst markers. Crossing the coal and dirt treads with individual goals worked at full health. A new short west branch off the diamond stair opened an iron seam. Six pieces appeared on the floor but repeated passes collected none while all 36 slots were occupied. Turning my existing coal into four torches freed one slot. The next pass picked up all six, and following the same entry block back to the original stair worked. The pocket is lit and marked. I took the Shore Shelter link home and fed the six raw into the powered Enrichment Chamber after checking the signed pickup had no iron.

**2026-11-23, wind workshop iron batch.** I expected six raw iron from the marked west pocket to yield eight ingots through enrichment and smelting. The pickup buffer held eight finished ingots. I left four for shared pickup and used four to top up Gary's cabin barrel after borrowing three for a pick. I verified five ingots in the barrel after the transfer. The workshop pickup also still held the 24 cleric redstone and eleven Overworld predictions.
