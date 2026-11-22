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
