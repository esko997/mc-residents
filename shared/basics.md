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

- Cooked meat is good food, but preserve at least two of each kind of animal
  for breeding. Pen and breed them first; slaughter only surplus adults.
- Bread: three wheat in a row. Wheat seeds come from breaking tall grass; plant
  them on farmland (use a hoe on dirt next to water) and they grow over time.
- Berries, apples (from oak leaves), carrots and potatoes from villages.
- Rotten flesh and spider eyes are poor food and can make you ill.
- Your body eats on its own when hungry, if food is in your inventory.
- Hunger alone cannot kill you here (the world is on Easy): it stops at half
  health. Low health still makes everything else more dangerous.

## Settling in

Players who last here usually spend their first days making a small home with
its own food supply, so that hunger and nights stop being emergencies.

- Where: open, unclaimed land of your own, not inside or beside someone else's
  base. Near water and trees is handy. Light it well with torches; a bed there
  makes it where you come back after dying.
- Wheat: break tall grass for seeds, make a hoe (two planks or cobblestone and
  two sticks), `use` the hoe on dirt or grass within four blocks of water, then
  `use` seeds on the farmland. Wheat is ripe when golden; breaking it gives wheat
  and more seeds to replant. Bone meal (from skeleton bones) makes it grow at once.
- Berries: `use` sweet berries on grass near home to plant a bush that keeps
  fruiting.
- Animals: hold wheat (cows, sheep), seeds (chickens) or carrots and potatoes
  (pigs) and they follow you; walk them into a fenced pen (fences and a gate
  from planks and sticks) so they stay. Two of the same kind fed that food make
  a baby, which grows up in about twenty minutes; each parent can breed again
  after five. Keep at least two of every kind and eat only the extras: a pen
  that keeps breeding feeds you for good, an emptied one never comes back.
- Wool: shears (two iron ingots in a diagonal) take one to three wool from a
  sheep without harming it, and it grows back after the sheep eats grass, so a
  pair of sheep on grass is a wool supply. Killing a sheep gives one wool, once.
  Twelve string (from spiders, or from plant fibre some mods add) also make
  three wool. Sheep are rare in the wild here; ones you find are worth keeping.
- Fish: a fishing rod (three sticks, two string from spiders) works in any water.
- Cook on a campfire (three sticks, three logs, one coal or charcoal) or in a
  furnace, and keep spare food in a chest at home.

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

## Water and swimming

- You hold fifteen seconds of air. It runs down while your head is under water
  and refills within a few seconds once your head is out. With none left you
  lose a heart every second until you breathe. `status` shows your air whenever
  it is not full.
- In water you rise and float by swimming up; your body does that when it moves
  through water, so `go_to` can cross lakes and rivers. Swimming is about half
  as fast as walking, and a long crossing takes several breaths.
- When your air falls below half your body comes up for a breath on its own and
  says so in a reflex line. If it also had to stop your trip, it tells you why
  and how far was left. That is information, not a ban: you can go on, go
  around, or cross where the water is narrower.
- For a trip across water give `go_to` only x and z. A height below the surface
  sends you diving for it.
- Falling into water does not hurt, whatever the height. Flowing water pushes
  you along; you can climb a waterfall by swimming up it.
- What you drop when you drown floats up: look for it at the surface, not on
  the bottom. A current can carry it away from where you died.
- Drowned (zombies that live in water) come out in rivers and seas at night.

## Getting unstuck

- If `go_to` stops short again and again from the same place, Baritone is
  probably trying to break a block it may not (claims, spawn) or cannot find a
  way. Repeating the same `go_to` will not help. Try a nearer open spot first,
  or `follow` someone who can walk out, then carry on from there.
- `mine` is local gathering: it stops if its route or next target goes beyond
  the radius around where you started (default 32 blocks, maximum 96).
  `find_block` searches the client-loaded terrain without moving or digging;
  finding a block does not mean there is a safe route to it. Travel deliberately
  toward a chosen resource, then mine nearby.
- A mine count measures gained target items or known vanilla drops, not blocks
  broken. Unknown modded drops may not count: check inventory and `stop` when
  you have enough. Do not send mining trips through buildings.

## Crafting with your body

For a known recipe use `craft`: one call lays the pattern and takes the result,
at an open crafting table or, for 2x2 recipes, with no screen open.

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
- A screen stays open until you close it and can block eating and movement.
  Close it as soon as you are done. A furnace keeps smelting with its screen
  closed: put in input and fuel, close it, and return for the result. Put down
  any stack on your cursor first; closing with it held can drop it. Crafting-grid
  items return to your inventory (or drop if there is no room).
  At food 6 or below, your body can close an idle screen after thirty seconds
  without screen actions to eat, but only with an empty cursor.
- Some mods replace a vanilla result with their own version: here a chest made
  from birch planks comes out as a birch chest, which works as a chest. `craft`
  says when that happens.
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

## Jobs with several steps

Your working memory is short, and a new session starts with nothing in mind. A
job that takes an hour (a wheat field, a house, iron tools) survives that only
if it is written down as a plan before it starts.

- `plan_set` writes a plan: a short name, the goal in one sentence, and the
  steps in order. `plan_step` marks a step doing, done, blocked (with a note
  saying why) or dropped. When no step is left open the plan is finished.
- `status` shows the current step of your plan every time, also after a
  restart, and says when no step has moved for more than twenty minutes.
- Up to three plans can exist at once. `status` shows the one in focus;
  `plan_focus` changes which, `plan_show` lists them all.
- `what_next` lists what your body can see is missing or unused, with the
  numbers: seeds carried and not planted, cobblestone and no furnace, no bed
  after dying, no armour, a better pickaxe within reach. It starts with your
  own current step. These are observations, not orders.
- `what_next` knows of a bed, a furnace or a chest only from the names and
  notes of saved places. One that is not saved with `place_save` counts as
  missing.
- Keep plan-step and saved-place notes to one short sentence: the result, the
  blocker, or the next concrete action. Put detailed history in your journal.

## Skills and shared notes

A skill is a routine you wrote once and can run again in one call. It is worth
making one for anything that took you several steps to work out and that you
will need again: making tools from logs, cooking a stack of meat, walking home
and emptying your pockets into the chest. Skills stay between sessions, and
the other residents can use the ones that are proven.

- `skill_find` before you work something out: someone may already have a skill
  for it. `skill_show` gives its code and its record.
- `skill_save` when a sequence of tool calls worked. The code is those same
  calls written as JavaScript, each as `await body.<tool>(args)`. Give it
  `expect`, a check of what must be true afterwards: items gained or used up,
  where you end, which screen is open. The first run that passes the check
  makes the skill verified, and then the others can find it.
- `skill_run` runs it and says what really happened: the check with the numbers
  observed, what changed in your inventory, and why it stopped if it did. A
  skill that fails is yours to fix: save it again under the same name, as
  often as you like.
- A skill that lasts checks before it acts and reads back afterwards: it looks
  at `state()` for what you carry and what is open, and ends with a clear `log`
  line when something it needs is missing, rather than clicking on.
- `feedback` after you used someone else's skill or shared note: say whether it
  worked for you. Everyone sees the count beside the skill.
- `note_share` offers a fact or a method to the others. They see it once it is
  accepted, usually within a minute, and a caretaker may later edit or remove
  it; `notes_shared` searches what is there.

An example, sticks from planks:

    name: make_sticks
    description: Crafts sticks from planks, no table needed. args.crafts is the number of crafts, 4 sticks each.
    params: {"crafts": "how many crafts, default 1"}
    expect: {"gain": {"minecraft:stick": 4}, "screen": "none"}
    code:
      const crafts = args.crafts ?? 1;
      const before = (await state()).inventory["minecraft:stick"] ?? 0;
      log(await body.craft({ item: "minecraft:stick", count: crafts }));
      await body.close_screen();
      const made = ((await state()).inventory["minecraft:stick"] ?? 0) - before;
      log("made " + made + " sticks");
      return made;
