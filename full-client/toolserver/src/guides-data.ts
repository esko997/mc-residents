export interface GuideSection {
  id: string;
  title: string;
  aliases?: readonly string[];
  source?: string;
  paragraphs: readonly string[];
}

export interface ReferenceGuide {
  id: string;
  title: string;
  aliases: readonly string[];
  scope: string;
  source: string;
  sections: readonly GuideSection[];
}

// Researched 2026-11-21. These are reference procedures, not live-tested skills.
// IDs and recipe kinds checked against .cache/knowledge.sqlite and cached mod jars.
// URLs are provenance, never fetched at lookup time. Keep version caveats in output.
const breeding = "https://minecraft.wiki/w/Breeding";
const mekanism = "https://wiki.aidancbrady.com/wiki/Tutorials/Getting_Started";
const refined = "https://refinedmods.com/refined-storage/v1.13.0-beta.4/";
const engineering = "installed immersiveengineering:manual (10.2.0-183)";
const timers = "After breeding, adults have a 5-minute cooldown; babies take about 20 minutes to grow while ticking. Babies cannot breed. Feeding babies speeds growth, not breeding. Preserve at least two adults of each species; harvest only surplus adults after replacements grow.";
const feeding = "Body: status gives nearby animal positions. Move within reach, select_hotbar with the food, look toward the animal's current coordinates, then use once on each adult. Coordinate look aims at a block centre, not an entity lock: picture/yaw/pitch may be needed for small or moving animals. Never attack to feed. Confirm food consumption and a baby, not just 'Used'.";

export const referenceGuides: readonly ReferenceGuide[] = [
  {
    id: "husbandry", title: "Breeding and renewable animal products",
    aliases: ["animals", "animal farming", "breeding", "breed", "husbandry", "livestock", "cow", "cows", "cattle", "sheep", "wool", "pig", "pigs", "chicken", "chickens"],
    scope: "Java 1.20.1; vanilla mechanics, not newer animal variants",
    source: breeding,
    sections: [
      { id: "overview", title: "Start a breeding herd", paragraphs: [
        "Build a fenced pen with a gate before luring two adults of the SAME species. Hold their breeding food and walk slowly; close the gate after both enter. Feed one item to each adult with use, not dropped items. Cows/sheep: wheat (not seeds); pigs: carrots, potatoes or beetroot; chickens: wheat, melon, pumpkin or beetroot seeds.",
        timers,
        "Read the species section for its food/product loop; feeding for body targeting. Related query=crops for renewable feed."
      ] },
      { id: "cows", title: "Cows: wheat, calves, milk and surplus meat", aliases: ["cow", "cows", "cattle", "calf", "milk", "beef", "leather"], paragraphs: [
        "1. Reserve wheat from a replanted wheat field. Fence two adult cows together and lure them with wheat. Seeds and bread do not breed cows.",
        "2. Select wheat on the hotbar, aim at one reachable adult and use; repeat on the other. Both must be close enough to meet. A calf confirms success. See section=feeding for aiming with this body.",
        timers,
        "3. Keep the breeding pair safe. Cows do not need grass to breed and do not starve. An empty bucket used on an adult yields renewable milk; beef/leather require killing surplus adults. Never treat the last pair as emergency meat."
      ] },
      { id: "sheep", title: "Sheep: wheat, grass and renewable wool", aliases: ["sheep", "wool", "shear", "shearing", "grass", "lamb"], source: "https://minecraft.wiki/w/Sheep", paragraphs: [
        "1. Lure and breed two adult sheep with wheat, using one item on each; wheat seeds do not work. Keep them penned on grass with room for regrowth. See section=feeding for body aiming.",
        timers,
        "2. recipes {item:'minecraft:shears'} gives the pack recipe. Use shears on an adult sheep to collect wool without killing it. A sheared sheep regrows wool by grazing grass, NOT by eating wheat from your hand. Leave nearby grass outside their reach to spread back over grazed dirt, with light and no solid cover.",
        "3. Dirt-only or stone pens cannot renew wool without grass. mobGriefing=false does not prevent wool regrowth. For a bed, gather matching-colour wool; recipes for your chosen bed gives its exact ingredients."
      ] },
      { id: "pigs", title: "Pigs: root crops and surplus pork", aliases: ["pig", "pigs", "pork", "piglet"], paragraphs: [
        "1. Grow and replant carrots, potatoes or beetroot. Any of these breeds pigs; wheat, beetroot seeds and a carrot on a stick do not.",
        "2. Lure two adults into a secure pen while holding the crop, shut the gate, then use one crop on each adult. See section=feeding. Confirm a piglet before assuming the herd grew.",
        timers,
        "3. Replant before spending crops on feed. Keep the adults and babies alive; cook pork only from surplus grown pigs. Pigs need neither daily feeding nor grass for breeding."
      ] },
      { id: "chickens", title: "Chickens: seeds, chicks and eggs", aliases: ["chicken", "chickens", "chick", "chicks", "eggs", "egg"], paragraphs: [
        "1. Save wheat, melon, pumpkin or beetroot seeds. Hold seeds to lure two adult chickens into an enclosed pen, then use seeds on each. Wheat itself does not breed them. See section=feeding for aiming at small animals.",
        timers,
        "2. Breeding produces a chick directly, not an egg. Adults also lay eggs periodically without feeding; thrown eggs only have a chance to hatch, so do not rely on one egg to replace your breeding pair.",
        "3. Reserve replanting seeds first. Keep chicks away from predators and escape gaps; collect eggs and harvest only surplus adults for meat/feathers. Cook chicken before eating."
      ] },
      { id: "feeding", title: "Feeding through body tools", aliases: ["feed", "feeding", "aim", "target"], source: "src/tools.ts body schema + https://minecraft.wiki/w/Breeding", paragraphs: [
        feeding,
        "Food not on the hotbar: open_inventory, screen, then click_slot using the SCREEN menu indexes to move it; close_screen with an empty cursor. inventory H slots 0..8 identify selectable hotbar positions, not menu slots.",
        "If nothing happens, check adult vs baby, correct food, cooldown, reach and aim. Hearts alone are not proof a baby appeared. Do useful nearby work during cooldown/growth; do not repeatedly feed the same unavailable adult."
      ] },
    ],
  },
  {
    id: "crops", title: "Renewable crops and feed", aliases: ["crops", "crop", "wheat", "seeds", "farm", "farming", "food", "carrots", "potatoes", "beetroot", "renewable food"],
    scope: "Java 1.20.1; vanilla crops", source: "https://minecraft.wiki/w/Farmland",
    sections: [
      { id: "overview", title: "Plant before consuming the seed stock", paragraphs: [
        "Choose a safe, lit patch near home. Hoe dirt/grass, keep water within four blocks horizontally (same level or one above farmland), and plant immediately. One central water source can hydrate a 9x9 square. Protect the field from jumping/trampling.",
        "Use wheat/beetroot seeds on farmland; plant carrots/potatoes themselves. Harvest mature crops, pick up drops, and replant BEFORE eating or breeding. Keep a reserve of seed crops in a labelled chest. Wheat supports bread and cows/sheep; spare seeds support chickens; roots support pigs.",
        "A growing field is not food ready now. Carry a meal while it grows, and keep production within regularly loaded/ticking land. Read planting for body actions and harvest for maturity."
      ] },
      { id: "planting", title: "Hoe and plant with this body", aliases: ["plant", "planting", "hoe", "water", "hydrate"], source: "src/tools.ts + https://minecraft.wiki/w/Tutorial:Crop_farming", paragraphs: [
        "1. recipes for a hoe; craft it. Use an open, reachable dirt/grass block with the hoe selected. look {x,y,z} aims at the block centre; read what was actually hit. use should till it. Ensure air above the soil.",
        "2. Select seeds/carrots/potatoes, look at the farmland and use to plant. Inspect the crop and inventory change; merely carrying seeds never grows a field. Repeat for a useful patch, not a lone plant.",
        "3. Water hydrates up to four horizontal blocks including diagonals. Light the crop area for growth at night; wheat/root crops need light level 9 or more at the plant block to grow. Do not jump onto farmland. Keep paths beside planting beds, not over crops."
      ] },
      { id: "harvest", title: "Maturity and a repeatable harvest", aliases: ["harvest", "mature", "replant", "bread"], source: "https://minecraft.wiki/w/Tutorial:Crop_farming", paragraphs: [
        "Wheat, carrots and potatoes mature at age 7; beetroot at age 3. Use visible appearance/picture or available block state, not elapsed time alone. Harvest mature plants and collect their drops; early harvesting wastes yield. Crops do not mature while their area is not ticking.",
        "Replant each harvested spot immediately. Keep enough seed/crop items for the entire field plus a reserve before allocating surplus to meals or animals. recipes {item:'minecraft:bread'} and recipes {item:'minecraft:baked_potato'} show the pack's crafting/cooking routes.",
        "Shared harvest: leave the field replanted and record where the food and reserve seeds are. Check an actual second harvest before calling the supply renewable and dependable."
      ] },
    ],
  },
  {
    id: "shelter", title: "A usable bed and safe home", aliases: ["shelter", "bed", "beds", "house", "home", "sleep", "respawn"],
    scope: "Java 1.20.1; Overworld", source: "https://minecraft.wiki/w/Bed",
    sections: [
      { id: "overview", title: "Make the home usable", paragraphs: [
        "Build a small enclosed, lit shelter with a roof, closable doorway, safe floor and reachable chest/work area. A grand building is unnecessary before food and a bed work. Light the interior and approach; do not leave a hostile-sized opening.",
        "Get wool without destroying the last breeding sheep: guide {query:'husbandry',section:'sheep'}. recipes {item:'minecraft:white_bed'} gives the installed recipe; choose the bed colour matching your wool. craft needs a usable 3x3 table for the bed recipe.",
        "Place the bed with room around it, then look at it and use. In the Overworld this sets respawn even by day. Keep the bed present and a safe exit unobstructed. Never use a bed in the Nether or End: it explodes. Sleeping through night also depends on server/player conditions."
      ] },
      { id: "access", title: "Reliable access, not duplicate ownership", aliases: ["share", "shared", "access"], paragraphs: [
        "Each resident needs dependable access to shelter, a usable respawn bed, food and essential tools; these need not all be personally owned. Check that the route, chest and work area really work for the intended person and that reserves remain available.",
        "Name the home and supply locations with place_save. Label storage, agree who replenishes it, and leave emergency food/tools reachable without a powered storage network. A borrowed bed is only reliable while it remains in place and available."
      ] },
    ],
  },
  {
    id: "mekanism", title: "Mekanism: first machines and useful branches", aliases: ["mekanism", "mek", "metallurgic infuser", "osmium", "infused alloy", "enrichment chamber", "digital miner"],
    scope: "Java 1.20.1; Mekanism/Generators 10.4.16.80; wiki spans versions",
    source: mekanism,
    sections: [
      { id: "overview", title: "A working first infuser", paragraphs: [
        "Start with iron, redstone, osmium and a furnace. Look up recipes {item:'mekanism:metallurgic_infuser'} and recipes {item:'mekanismgenerators:heat_generator'}. Generators is installed here. Craft both, place the generator beside the infuser's energy-input side, fuel it and verify the infuser gains energy; this bootstraps before steel cables.",
        "The infuser unlocks steel, alloys and circuits. First demonstrate one output before building more machines. Read components for steel/alloys, power for connections, and branches for goal-driven expansion; these are options, not a universal linear tech tree."
      ] },
      { id: "components", title: "Steel, alloy and circuit dependencies", aliases: ["steel", "alloy", "alloys", "circuit", "circuits", "infuser"], paragraphs: [
        "1. Infuser needs energy, a primary item and the correct infusion material. Coal/charcoal supplies carbon. Infuse iron into mekanism:enriched_iron, infuse that again with carbon into mekanism:dust_steel, then smelt the dust. recipes on each output gives quantities/type, not a crafting-table recipe.",
        "2. Redstone infusion + iron makes mekanism:alloy_infused; redstone infusion + osmium makes mekanism:basic_control_circuit. Look up each recipe first. The infusion buffer holds one type: avoid loading carbon when you need redstone. Dumping discards the buffer; separate infusers can avoid waste.",
        "3. Verified index recipe IDs: mekanism:processing/iron/enriched; mekanism:processing/steel/enriched_iron_to_dust; mekanism:metallurgic_infusing/alloy/infused; mekanism:control_circuit/basic. Quantities are infusion units, not necessarily counts of coal/redstone items."
      ] },
      { id: "power", title: "Power and diagnosing idle machines", aliases: ["power", "energy", "generator", "cable", "configuration"], paragraphs: [
        "Heat Generator burns fuel or uses adjacent lava heat; isolate lava safely. Once steel exists, recipes {item:'mekanism:basic_universal_cable'} enables a wider energy network. A powered energy cube buffers energy; it does not generate any. Wind/solar are expansion choices; check output and demand rather than assuming one generator is enough.",
        "An idle machine: inspect stored energy, recipe inputs, infusion/fluid/gas supply, free output space, redstone control and side configuration. Item, energy and chemical connections are different. Use screen/picture to identify actual slots; never copy wiki screen coordinates. For machine side controls the official configuration page warns it is outdated, so trust the installed UI.",
        "Craft only handles crafting grids, not infusing or machine processing. Use the machine's observed UI and verify an output item; record a proven body sequence only after that evidence."
      ] },
      { id: "branches", title: "Choose a useful technology branch", aliases: ["progression", "tech tree", "technology", "branches", "ore", "factory", "factories"], paragraphs: [
        "Materials branch: recipes {item:'mekanism:enrichment_chamber'} for enriched infusion materials/ore processing, then smelting. Factories add parallel processing; they also demand more power. Raw ores, ore blocks and processing tiers have different yields: inspect recipes/uses, do not assume every input doubles or triples.",
        "Oxygen processing branch: Electrolytic Separator supplies oxygen to a Purification Chamber, then Crusher -> Enrichment Chamber -> smelting for supported inputs. More advanced processing adds chemical supply chains; choose it only when throughput/resources justify them.",
        "Utility branch: better tools, a Digital Miner or power storage may help more than another ore tier. Advanced fission/polonium gear, QIO, fusion and antimatter are separate large projects, not prerequisites for a useful workshop. Fission introduces radiation and meltdown risk: this starter guide is not reactor safety instructions."
      ] },
    ],
  },
  {
    id: "refined-storage", title: "Refined Storage: useful storage before automation", aliases: ["refined storage", "refinedstorage", "rs", "storage network", "disk drive", "autocrafting", "pattern grid"],
    scope: "Java 1.20.1; installed RS 1.12.4; reference docs 1.13 beta (1.x), NOT RS 2/3",
    source: refined + "getting-started.html",
    sections: [
      { id: "overview", title: "First usable network", paragraphs: [
        "Use recipes for refinedstorage:controller, refinedstorage:grid, refinedstorage:disk_drive and refinedstorage:1k_storage_disk. Trace ingredients with recipes, especially quartz-enriched iron, silicon and processors. Crafting a controller alone gives no usable storage.",
        "Supply continuous FE/RF from another mod to ONE Controller. Connect Grid and Disk Drive directly adjacent or by RS cable; insert the storage disk into the drive. Open Grid, deposit a harmless item, retrieve it and verify inventory. A storage block or External Storage on a chest is an alternative storage backend.",
        "Keep essentials in a normal chest until the network is dependable. Read power, storage and automation independently; autocrafting is not needed for a useful searchable warehouse."
      ] },
      { id: "power", title: "Network power and component production", aliases: ["power", "controller", "processor", "processors", "silicon"], source: refined + "networking/controller.html", paragraphs: [
        "RS 1.x does not generate energy. Feed the Controller from an FE-compatible generator; a Mekanism energy cable is not an RS data cable. There can be only one Controller per 1.x network. Newer RS documentation allowing multiple controllers does not apply here.",
        "Controller UI shows energy consumption. If power runs out, the network shuts down and stored items become inaccessible until power returns. Increase sustained generation as devices are added; a battery only delays depletion.",
        "recipes {item:'refinedstorage:raw_basic_processor'} shows the indexed raw processor recipe; then inspect the finished processor recipe for its cooking step. Repeat for improved/advanced tiers only as needed. Do not substitute newer-version soldering instructions for this pack's recipes."
      ] },
      { id: "storage", title: "Disks, external chests and item movement", aliases: ["disk", "disks", "external", "importer", "exporter", "storage"], source: refined + "input-and-output/getting-items-in-and-out.html", paragraphs: [
        "Disk Drive must contain an item storage disk; an empty drive cannot store items. Grid is the access interface, not the storage. Check free capacity before bulk transfers. Storage blocks are another backend; External Storage exposes an attached chest without first emptying it into a disk.",
        "recipes {item:'refinedstorage:external_storage'} / importer / exporter: External Storage exposes an inventory; Importer transfers FROM an adjacent inventory INTO the network; Exporter transfers selected items FROM network TO an inventory. Configure filters before connecting valuable stock.",
        "Power/connectivity, redstone modes, capacity, filters and machine-side insertion/extraction rules can all block transfer. Prove one item round trip first. Never dismantle or discard disks holding goods; preserve a nonpowered emergency chest."
      ] },
      { id: "automation", title: "Patterns and processing returns", aliases: ["automation", "autocrafting", "crafting", "pattern", "patterns", "crafter", "tech tree", "progression"], source: refined + "autocrafting/processing-recipes.html", paragraphs: [
        "1. After storage works, recipes {item:'refinedstorage:pattern_grid'} and recipes {item:'refinedstorage:crafter'}. Encode a supported crafting recipe on a Pattern in Pattern Grid; put it in a connected Crafter. Stock its ingredients and request a small job from Grid.",
        "2. Machine work uses a PROCESSING pattern: list the real input and expected output quantities from installed recipes. Face the Crafter into a valid machine input. Keep the machine powered/fuelled. Return products through an Importer or Interface; without their return, RS cannot know the job completed.",
        "3. Verify one full job and net output before scaling or chaining jobs. Filters/side rules and fluid/gas supplies need explicit design. A Crafting Grid is convenient manual crafting, not automatic production by itself. Keep complex or dangerous machine workflows manual until proven."
      ] },
    ],
  },
  {
    id: "immersive-engineering", title: "Immersive Engineering: coke, steel and power", aliases: ["immersive engineering", "immersiveengineering", "ie", "coke", "coke oven", "blast furnace", "creosote", "waterwheel", "windmill"],
    scope: "Java 1.20.1; IE 10.2.0-183 installed manual",
    source: engineering,
    sections: [
      { id: "overview", title: "First coke and steel", paragraphs: [
        "Start with recipes {item:'immersiveengineering:cokebrick'}, blastbrick and hammer (same namespace). Build a Coke Oven to turn coal into coal coke plus creosote. Use coke with iron in a Crude Blast Furnace for steel. These machines need no electrical power, but require the correct multiblock and manual input/output handling.",
        "Read coke and steel for assembly/operation; power for the independent electrical branch. This pack's recipe index misses some IE machine-processing outputs, so 'no recipe' does not mean impossible. The installed Engineer's Manual/JEI is authoritative for those recipes, fuels and multiblock diagrams."
      ] },
      { id: "coke", title: "Coke Oven and treated wood", aliases: ["coke", "cokebrick", "creosote", "treated wood"], paragraphs: [
        "1. recipes {item:'immersiveengineering:cokebrick'} and recipes {item:'immersiveengineering:hammer'}. The installed manual specifies a SOLID 3x3x3 of Coke Bricks (27 blocks); use Engineer's Hammer on the centre block of a side to form it. This is a structure size, not a recipe quantity.",
        "2. Open the formed oven and insert coal; it slowly produces coal coke and creosote oil without FE or extra furnace fuel. Logs instead give charcoal and less creosote. Empty the output and drain creosote into suitable containers/storage so a full tank does not halt production.",
        "3. Creosote enables treated wood for IE construction. Look up the installed treated-wood recipe/JEI. Save coke for steel rather than burning your entire first batch for ordinary cooking. Use screen/picture: manual diagrams do not tell you body menu slot indexes."
      ] },
      { id: "steel", title: "Crude then improved steel production", aliases: ["steel", "blast", "blast furnace", "blastbrick"], paragraphs: [
        "1. recipes {item:'immersiveengineering:blastbrick'} shows the materials (including Nether dependencies in the standard recipe). Build a SOLID 3x3x3 of Blast Bricks and use Engineer's Hammer on a side's centre. Do not confuse it with vanilla minecraft:blast_furnace, which does not make IE steel.",
        "2. Insert iron and a valid blast-furnace fuel such as coal coke. Remove BOTH steel and slag outputs or it stops. The Crude Blast Furnace is not automatable: operate through its GUI. Check installed manual/JEI for valid fuels when indexed recipes are incomplete.",
        "3. Improved Blast Furnace is a later steel investment for automation: reinforced bricks plus a hopper, assembled per the manual. Feed iron/coke from top; steel exits front, slag back. Optional powered preheaters increase speed, not a prerequisite for your first steel."
      ] },
      { id: "power", title: "From rotation to a powered workshop", aliases: ["power", "energy", "waterwheel", "windmill", "dynamo", "diesel"], paragraphs: [
        "1. recipes {item:'immersiveengineering:dynamo'} plus windmill or watermill (same namespace). Connect the rotating wheel/mill to a Kinetic Dynamo. Water wheels need correctly directed flowing water; windmills need clear airflow. Manual Power Generation explains orientation; visual rotation alone is not proof a consumer receives FE.",
        "2. Transfer energy with matching-voltage connectors and wire coils; use relays for routing. An LV capacitor buffers energy; configure input/output faces. Check a consumer's energy and completed work. Keep exposed electrical wires away from walkways; insulation/safe routing matters.",
        "3. Expand toward powered processing machines when useful; larger demand can justify a Diesel Generator with a reliable biodiesel supply chain (Squeezer/Fermenter/Refinery). These are options, not a mandatory ladder. Consult installed multiblock diagrams before construction; this guide is not a block-by-block build schematic."
      ] },
    ],
  },
  {
    id: "settlement", title: "Shared production that compounds", aliases: ["settlement", "civilization", "civilisation", "shared production", "planning", "collaboration", "community", "production", "shared essentials"],
    scope: "Resident planning practice, 2026-11-21; not a Minecraft mechanic",
    source: "owner-approved resident aims + local body tool contracts",
    sections: [
      { id: "overview", title: "Build reliable access together", paragraphs: [
        "Start with reliable access to meals, a bed/shelter, tools and safe routes. Shared supplies count when you can actually reach/use them and somebody replenishes them; duplicate ownership is not the goal. Inspect existing production before building another copy.",
        "Choose one durable improvement and its visible acceptance: e.g. a replanted field plus food reserve, or a powered network with a tested deposit/retrieval. Break it into a small project, current milestone and immediate steps. Record the dependency blocking progress, not a long speculative to-do list.",
        "Gary's settlement and Margo's technology can reinforce each other: food/materials support experiments; proven tools and automation make reliable supplies cheaper. Choose the next bottleneck by evidence and useful demand."
      ] },
      { id: "production", title: "Inputs, output, access and maintenance", aliases: ["supply", "supply chain", "production", "maintenance", "access"], paragraphs: [
        "For each shared service name: input supply, producer, output location, reserve floor, replenishment responsibility and intended users. Include power/fuel and byproducts for machines. Label storage and save places/routes so another resident can use it without you.",
        "Prove the loop: harvest/replant/harvest, breed/grow/preserve breeders, or insert/process/retrieve. Check that output exceeds upkeep and that the intended user can reach it. A stocked chest from one donation is useful but not renewable production.",
        "Share results in Shared Knowledge with source, location, exact observed result and limitations. Distinguish an external reference from a personally tested body procedure. Improve a reusable skill only after actual success; record failures so neighbours do not repeat them."
      ] },
    ],
  },
  {
    id: "body-ui", title: "Translate human tutorials into body actions", aliases: ["body", "body ui", "ui", "controls", "right click", "left click", "shift click", "inventory key", "feeding controls", "machine ui"],
    scope: "Local Synapse body tool contracts, 2026-11-21; Java 1.20.1 client",
    source: "full-client/toolserver/src/tools.ts; src/craft.ts",
    sections: [
      { id: "overview", title: "Keys are not tool names", paragraphs: [
        "Human right-click = use; left-click = attack (damages animals!); inventory key E = open_inventory. look {x,y,z} targets the centre of the containing block, not arbitrary exact coordinates or an entity id. look {yaw,pitch} can refine aim. status/picture helps locate nearby animals; query=husbandry section=feeding explains breeding.",
        "Select items with select_hotbar {slot:0..8}. screen reports menu slot/button indexes; these are NOT inventory indexes. Shift-click a menu stack = click_slot {slot,mode:'QUICK_MOVE'}. Never use THROW for moving between inventory/container slots.",
        "Prefer recipes then craft for crafting-table recipes. craft does not operate furnaces or mod machines. Read machine and slots for those workflows."
      ] },
      { id: "slots", title: "Move items without losing the cursor stack", aliases: ["slot", "slots", "inventory", "shift click", "cursor"], paragraphs: [
        "Open the actual container (look at reachable block, use), then screen. click_slot uses that menu's indexes; mode PICKUP moves through the cursor, QUICK_MOVE tries the menu's quick-transfer rules. Re-read the result/cursor after moving. Do not assume the first slot is input or that machine layouts share indexes.",
        "Before close_screen, put any carried cursor stack into a known free slot; closing can drop it into the world. select_hotbar still takes hotbar 0..8, not menu slot numbers. A full inventory or incompatible slot can prevent transfer; check state rather than repeating the same click.",
        "Buttons: click_button with an observed label or widget index. Text: type_text into an actual focused field. press_key supports only its listed keys, not arbitrary shortcuts such as E or Ctrl-click. picture is for visual evidence, not a promise every visible custom widget is exposed to tools."
      ] },
      { id: "machine", title: "Recipe to observed machine operation", aliases: ["machine", "furnace", "smelt", "processing", "recipe"], paragraphs: [
        "recipes {item:'namespace:output'} supplies ingredients, recipe type and any indexed notes. A crafting type can use craft with the right grid; smelting/infusing/crushing require that machine, appropriate power/fuel and correct slots. craft count means recipe operations, not output item count.",
        "Open the machine and inspect screen/picture; supply a small batch. Watch energy/fuel, progress, input consumption and output. Retrieve the output and verify inventory. If it stalls, check the actual recipe, side configuration, redstone mode and blocked output before changing the setup.",
        "Installed recipes/JEI and manual override generic web quantities. The offline index is extracted from jars, not a live server datapack dump; omitted/custom recipes may need the installed UI. Reference steps are not live-test evidence. Save a reusable skill only once its exact body sequence has succeeded."
      ] },
    ],
  },
];
