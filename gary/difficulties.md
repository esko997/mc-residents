
## 2026-11-21T03:07:01.600Z
Mining minecraft:tall_grass count 6 from near 115,118,-205 sent me about 49 blocks away to 113.75,103,-156.76, then reported stopped_short without collecting any seeds. Status still says the mining action arrived/stopped. I cannot tell how mine chooses its target radius or why it stopped.
Position: 113.75, 103, -156.76 (minecraft:overworld)
Last tool error: none

## 2026-11-21T03:08:44.395Z
The eat tool only accepts food in the hotbar. My two rotten flesh are in inventory slot 19, but the available press_key options do not include the inventory key, and click_slot requires an already open screen. I cannot see how to move the food into the hotbar to eat it.
Position: 110.5, 120, -204.5 (minecraft:overworld)
Last tool error: No matching food in hotbar; move food there with click_slot first.

## 2026-11-21T03:09:25.181Z
Correction: I found a workaround after recording that. I can open my barrel, then click_slot on inventory slot 37 with mode SWAP and button 3 to move the rotten flesh to hotbar slot H3. The earlier note was incomplete; inventory management through a container works.
Position: 110.5, 120, -207.59 (minecraft:overworld)
Last tool error: No matching food in hotbar; move food there with click_slot first.

## 2026-11-21T03:14:41.748Z
After using the crafting table, close_screen reported “Closed screen” twice, but status and picture still showed CraftingScreen even while goto continued. Pressing ESCAPE then actually cleared the screen. I used press_key to recover.
Position: 110.5, 122, -213.31 (minecraft:overworld)
Last tool error: No matching food in hotbar; move food there with click_slot first.

## 2026-11-21T03:35:05.950Z
Two short go_to attempts near my own cabin stopped several blocks short while I remained healthy and no hostiles were nearby: x122,z-205 stopped 6.8 blocks away, and x109,z-202 stopped 5.8 blocks away. status stayed at 117.24,120,-209.79 for the first and 110.5,120,-207.64 for the second; pictures showed a steep dirt/grass slope. I did not retry or alter terrain. It is unclear whether the pathfinder treats this slope as impassable or stopped for another reason.
Position: 110.5, 120, -207.64 (minecraft:overworld)
Last tool error: x: Expected integer, received float; z: Expected integer, received float

## 2026-11-21T03:42:52.616Z
At home, use on the crafting table opened a CraftingScreen. `press_key(ESCAPE)` and `close_screen` each reported success, but subsequent `screen`/`status` still showed the CraftingScreen. I moved 30 minecraft:bread from main inventory to H3 via click_slot SWAP, then `eat(item=minecraft:bread)` reported 'Ate ...; food 6 -> 6 (no increase observed)' and the bread count remained 30. Screen still appears open. Unsure whether eating is being blocked by the open screen or the tool result/state is stale.
Position: 110.5, 120, -207.64 (minecraft:overworld)
Last tool error: No matching food in hotbar; move food there with click_slot first.

## 2026-11-21T05:09:20.047Z
I could not reach Margo at the cabin entrance. From 111.18,120,-205.49, go_to 111.18,120,-203.5 reported arrival without changing position; go_to 112,120,-203 stopped 2.6 blocks short. The closed doorway may have blocked the path. Margo could not reach bread I dropped inside, so spesk01 gave her food.
Position: 111.18, 120, -205.49 (minecraft:overworld)
Last tool error: text: String must contain at most 256 character(s)
## Resolved body issues (2026-11-20 onward)
The entries below document earlier behavior, not current limitations. After the repair, `eat` can take food from anywhere in my inventory, meals no longer interact with the block ahead, `open_inventory` is available, and `close_screen` reports the verified result. `go_to` accepts the decimal coordinates from `status`; when it stops short it reports the distance and pathfinder message. I confirmed inventory opening/closing, decimal-coordinate navigation, and a stopped-short distance report in play. The old food/UI/coordinate errors below are retained as history. The 05:09 doorway obstruction is a separate current navigation difficulty.


## 2026-11-21T05:25:55.292Z
At 108,93,-111, spesk01 had explicitly said I may mine the coal; `mine minecraft:coal_ore count=1` stopped without a drop, and holding attack on the visible ore once did not break it or change pick durability. The exact cause is unclear; no ore was removed.
Position: 107.06, 93, -110.49 (minecraft:overworld)
Last tool error: text: String must contain at most 256 character(s)

## 2026-11-21T06:20:09.069Z
Near 222,101,-237, `go_to` repeatedly stops short inside a narrow stone passage. Mining a natural stone vein appears to have left me in a dead-end tunnel with no pickaxe. I cannot path back to the surface or nearby earlier waypoint even after several different targets; no damage taken. I'll avoid further guesses until I can find an exit.
Position: 222.48, 102, -238.29 (minecraft:overworld)
Last tool error: input: Invalid input. click_button: Press a screen button by label or widget index.

## 2026-11-21T06:42:58.557Z
At home, the recorded crafting-table location (109,120,-209) looked like birch_planks from multiple nearby positions; right-click did not open a crafting screen. I could not find the table or craft the stone hoe. I did not break or replace any cabin blocks.
Position: 110.22, 120, -209.18 (minecraft:overworld)
Last tool error: none

## 2026-11-21T07:09:36.215Z
2026-11-21: At 125,120,-225, Baritone stopped inside a tight dirt-and-stone tunnel while traveling through the nearby forest. This has happened during earlier travel too; it is hard to tell whether it is natural terrain or a passage Baritone dug. I had to reorient and route back to open ground.
Position: 125.39, 120, -224.4 (minecraft:overworld)
Last tool error: none

## 2026-11-21T07:33:02.347Z
At 95,74,-89, while trying to reach the open hillside at 110,80,-100 from the ocean ledge, Baritone stopped 18.9 blocks short without leaving the ledge. The nearby passage is a narrow cliff above water; I couldn't tell which existing stone steps give access to the hillside.
Position: 95.3, 74, -89.33 (minecraft:overworld)
Last tool error: none

## 2026-11-21T08:04:00.852Z
Baritone pathing to y90 near (361,-230) built a long cobblestone bridge over a river and dropped me into water; further travel dug a narrow vertical tunnel I could not climb out of for several minutes. I escaped by navigating sideways toward (330,80,-205), then up to y90.
Position: 300.73, 104, -179.73 (minecraft:overworld)
Last tool error: none

## 2026-11-21T08:16:17.052Z
At the coastal dirt path near (94,79,-72), Baritone made almost no progress toward points only 6–20 blocks away over multiple minutes; the path is a narrow strip above water and it seems unable to step onto nearby land. I stopped and retried a closer goal without meaningful movement.
Position: 94.5, 80, -71.69 (minecraft:overworld)
Last tool error: none

## 2026-11-21T08:48:22.073Z
Baritone exploration from the birch woods traveled hundreds of blocks to a snowy coast and entered the ocean; a goto then left me underwater at (400,60,-621). The surface reflex helped once, but the active path resumed into water. I reached shore by navigating to (380,70,-620).
Position: 387.94, 65, -619.3 (minecraft:overworld)
Last tool error: none
