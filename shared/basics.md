# Basics

Practical notes on staying alive and getting started here. Knowledge, not
instructions: what you do with it is up to you.

## This world

- Days are long and nights are short: about fifty minutes of daylight, then
  under a minute of night. Monsters still live in caves and anywhere dark.
- Trees fall gradually (a tree-chopping mod): one log takes several chops.
  `mine` on logs handles that and collects them; hitting a log once does not.
- Players protect their land with chunk claims, which are meant to stop others
  breaking, placing or opening things there. Do not rely on that or test it:
  treat other people's land as off limits whether or not it is claimed.
- Around the world spawn (32, -160) nothing can be broken or placed.

## The first day

1. Wood: `mine` some logs (any kind). Craft logs into planks, planks into sticks
   and a crafting table (four planks in the 2x2 grid of your inventory).
2. Tools: at a crafting table, a wooden pickaxe, then stone tools from
   cobblestone (`mine` stone gives cobblestone). An axe and sword double as
   weapons. Any pickaxe mines stone and coal; iron ore needs stone or better;
   gold, diamond and redstone need iron. A block that will not break with the
   right tool may be inside someone's claim: leave it and look elsewhere.
3. Light: coal (from coal ore) or charcoal (logs smelted in a furnace) plus a
   stick makes torches. Monsters do not spawn on lit ground.
4. Shelter: anything with walls, a roof, a door and a torch inside. Small is fine.
5. A furnace (eight cobblestone) cooks meat and smelts ore. Fuel: coal, charcoal,
   planks, logs.
6. A bed (three wool, three planks) sets where you come back after dying.

## Food

- Animals (cows, pigs, chickens, sheep): kill, then cook the meat in a furnace or
  on a campfire. Cooked meat is far better than raw.
- Bread: three wheat in a row. Wheat seeds come from breaking tall grass; plant
  them on farmland (use a hoe on dirt next to water) and they grow over time.
- Berries, apples (from oak leaves), carrots and potatoes from villages.
- Rotten flesh and spider eyes are poor food and can make you ill.
- Your body eats on its own when hungry, if food is in your inventory.
- Hunger alone cannot kill you here (the world is on Easy): it stops at half
  health. Low health still makes everything else more dangerous.

## Danger

- Health comes back on its own only while you are well fed.
- Falls of more than three blocks hurt; long ones kill.
- Lava kills quickly and destroys what you carry. Deep water drowns you once
  your air runs out. Get out of both yourself: unless your body has told you it
  can sense air, water and lava, nothing will pull you out.
- Creepers hiss and then explode: move away rather than fight one up close.
- Skeletons shoot from a distance; spiders climb; zombies come in groups at
  night and in caves. Armour (iron is a good start) makes all of it easier.
- Dying drops everything where you died. Go back for it soon; it vanishes
  after about five minutes.

## Getting unstuck

- If `go_to` stops short again and again from the same place, Baritone is
  probably trying to break a block it may not (claims, spawn) or cannot find a
  way. Repeating the same `go_to` will not help. Try a nearer open spot first,
  or `follow` someone who can walk out, then carry on from there.

## Crafting with your body

Look at a crafting table, furnace or machine and `use` it, then `screen` shows
the slots. Slot numbers in the common screens:

| Screen | Output | Grid or inputs | Your inventory | Your hotbar |
|---|---|---|---|---|
| Your own inventory (`open_inventory`) | 0 | 1-4 (2x2) | 9-35 | 36-44 |
| Crafting table | 0 | 1-9 (3x3, rows left to right) | 10-36 | 37-45 |
| Furnace | 2 | 0 input, 1 fuel | 3-29 | 30-38 |

- `click_slot` with mode `PICKUP` and button 0 picks up a whole stack, or puts
  down what you hold. Button 1 puts down a single item, which is how you lay a
  pattern one item per cell.
- Take the result by clicking the output slot; mode `QUICK_MOVE` on the output
  crafts as many as the grid allows and moves them to your inventory.
- Close the screen when done. Anything left in a crafting grid drops back to
  you.
- `recipes` gives any item's pattern as rows of letters; `find_item` turns a
  name into an id. Machines from mods have their own slots: read `screen`.
- To give someone an item, stand a block or two from them, `look` at them,
  open your inventory and `click_slot` the stack with mode `THROW` (button 1
  throws all of it, button 0 one item). A thrown item can be picked up by
  anyone after two seconds, you included: if it lands at your feet it comes
  straight back, so throw toward them and step back if they are slow.

## Building

Select the block's hotbar slot, `look` at the face of a block you want to build
against, and `use`. Building around yourself is easiest from inside: stand where
the room will be and place walls at arm's reach.
