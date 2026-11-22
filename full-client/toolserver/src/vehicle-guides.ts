import type { ReferenceGuide } from "./guides-data.ts";

// Written 2026-11-22 from Immersive Aircraft's source at the installed 1.4.0+1.20.1 commit and vanilla
// 1.20.1 behaviour. Live body smokes cover carts, chest boats, and quadrocopter fuel/takeoff/landing/ground exit.
const commit = "https://github.com/Luke100000/ImmersiveAircraft/blob/7fc175372d3930773d625d507cb5c772f316fea9/common/src/main/java/immersive_aircraft";
const keyBindings = `${commit}/client/KeyBindings.java`;
const vehicleEntity = `${commit}/entity/VehicleEntity.java`;
const engineVehicle = `${commit}/entity/EngineVehicle.java (fuel); config/Config.java (defaults)`;
const vanilla = "https://minecraft.wiki/w/Boat; https://minecraft.wiki/w/Minecart";

export const vehicleGuides: readonly ReferenceGuide[] = [
  {
    id: "vehicles", title: "Boats, minecarts and Immersive Aircraft",
    aliases: ["vehicle", "vehicles", "boat", "boats", "raft", "chest boat", "minecart", "minecarts", "cart", "rail travel",
      "aircraft", "airplane", "aeroplane", "plane", "biplane", "bamboo hopper", "airship", "cargo airship", "warship",
      "quadrocopter", "gyrodyne", "immersive aircraft", "fly", "flying", "flight", "pilot", "take off", "takeoff",
      "landing", "ride", "riding", "mount", "dismount", "aircraft fuel", "fuel an aircraft"],
    scope: "Java 1.20.1 vanilla boats/minecarts; Immersive Aircraft 1.4.0+1.20.1 Forge (source commit 7fc1753); server config may differ; live body smokes cover carts, chest boats and quadrocopter fuel/takeoff/landing, not every aircraft family",
    source: keyBindings,
    sections: [
      { id: "overview", title: "Board, steer, leave, and check what happened", aliases: ["vehicle", "vehicles", "board", "mount", "ride", "riding"], source: vehicleEntity, paragraphs: [
        "vehicle says what you ride (seat, on ground, on water or airborne, blocks of drop below, speed, how to leave) and lists boats, minecarts and aircraft near you with their entity ids. mount boards one by id: stand within about 3 blocks with nothing between you, not sneaking; it turns to the vehicle, uses it once and reports whether you actually ride it. vehicle_control holds controls for hold_ticks and then reports where the vehicle went. dismount leaves and reports whether you did.",
        "None of these repeats an attempt by itself: when a result says you are not riding, or still riding, look with vehicle before trying again. Never attack a boat, minecart or aircraft to move it: hitting breaks it into an item or damages it. A vehicle someone else placed or built is theirs; ask before taking it, and bring it back where you found it.",
        "The body's walking/swimming rescues and automatic eating do not run while you ride: a walking movement or sneak could otherwise interfere with flying or throw you out. Eat before travel and land or stop somewhere safe before your supplies become urgent.",
      ] },
      { id: "boats-minecarts", title: "Boats and minecarts", aliases: ["boat", "boats", "raft", "chest boat", "minecart", "minecarts", "cart", "rail travel"], source: vanilla, paragraphs: [
        "Boats: use a boat item while looking at water to place it, then mount it. vehicle_control forward and backward paddle, left and right turn; boats are quick on water and ice and crawl on land. A chest boat's chest opens with vehicle_inventory while you sit in it. A boat seats two and a chest boat one; the first aboard steers.",
        "Minecarts: use a minecart item on a rail to place it, then mount it. Rails, slopes and powered rails move it, not you; powered rails need redstone power (a lever or redstone torch beside them) or they brake the cart. vehicle_control forward/backward only nudge a cart that has nearly stopped. Chest, hopper, furnace and TNT minecarts are not ridden; mount refuses them.",
        "dismount on a boat or minecart sneaks until the server lets you go and stops sneaking at once; you land beside the vehicle, which stays where it is. If the vehicle is falling and the drop is more than 3 blocks (or cannot be seen), dismount refuses unless confirm_airborne is true. To carry a boat or cart away, break it deliberately with attack once you are off it; it drops as an item.",
      ] },
      { id: "aircraft", title: "Immersive Aircraft controls", aliases: ["aircraft", "airplane", "aeroplane", "plane", "biplane", "bamboo hopper", "airship", "cargo airship", "warship", "quadrocopter", "gyrodyne", "immersive aircraft", "fly", "flying", "flight", "pilot", "take off", "takeoff"], source: vehicleEntity, paragraphs: [
        "Aircraft in this pack: biplane and bamboo hopper (airplanes); airship, cargo airship and warship (airships); quadrocopter; gyrodyne. Place a crafted aircraft by using its item on open ground (recipes shows how to craft it). Board with mount. Sneak-use is not boarding: on an empty aircraft it opens the inventory, and on an occupied one it throws the pilot out, so never do it to an aircraft someone is flying.",
        "vehicle_control presses the aircraft's own configured controls, not your walking input. Airplanes: up raises the throttle a step every tick held and down lowers it and brakes; push tilts the nose down and pull lifts it (only in the air); on the ground below full throttle push and pull taxi slowly; left and right turn. To take off, hold up until the throttle is full, roll straight along long flat open ground until it lifts, and pull gently. Airplanes fall when slow, so keep speed up.",
        "Airships run their engine whenever a pilot sits in them: up and down climb and descend, forward and backward drive, left and right turn. The quadrocopter also runs whenever piloted: up and down climb and descend, forward, backward, left and right move it, and it turns toward where you look (use look). The gyrodyne burns your food, not fuel: hold forward until the rotor reaches full power (Immersive Aircraft shows the percentage), then up climbs, down descends, and forward or backward tilt it so it travels.",
        "vehicle_boost uses firework rockets in a booster slot, not ordinary cargo. The bundled aircraft data gives booster slots to the biplane, bamboo hopper and warship; the ordinary quadrocopter, airship, cargo airship and gyrodyne have none. Use normally crafted rockets with a flight duration. The tool refuses when the native aircraft says it cannot boost (no loaded booster slot or a boost already active). Other aircraft families' flight procedures above come from source, not a flight with this body: check vehicle after each hold and keep holds short.",
      ] },
      { id: "fuel", title: "Fuel and the aircraft's inventory", aliases: ["fuel", "aircraft fuel", "refuel", "fuel slot", "engine"], source: engineVehicle, paragraphs: [
        "Sit in the aircraft and call vehicle_inventory: it opens the aircraft's own screen the way the inventory key does. Read it with screen and move fuel into the fuel slot with click_slot; menu slot indexes are not your inventory indexes. By default any furnace fuel is accepted (coal, charcoal, planks, logs and the like) plus blaze powder; this server's settings could differ, so check that the fuel stays in the slot and gets used.",
        "Fuel burns item by item while the engine runs: airplanes in proportion to the throttle, so throttle down when waiting; airships and quadrocopters at full whenever someone pilots them, so do not idle in the pilot seat. Carry spare fuel on long trips and refuel on the ground. With no fuel the engine loses power: airships and quadrocopters lose lift and fall, airplanes glide down. The gyrodyne needs no fuel but makes you hungry; eat before flying it.",
      ] },
      { id: "landing", title: "Landing and getting out", aliases: ["land", "landing", "dismount", "get out", "exit", "jump out"], source: vehicleEntity, paragraphs: [
        "Land before leaving. Airplanes: lower the throttle on the approach, keep the nose level, touch down on flat open ground, then hold down to brake. Airships and quadrocopters: over a flat clear spot hold down in short holds and watch vehicle until it says on the ground. Collisions damage an aircraft; a damaged one is repaired by using it (repeated use while not aboard; it costs hunger) and cannot be boarded until whole.",
        "On the ground dismount presses the aircraft's dismount key once (R unless the controls were rebound; the body uses whatever key is configured and refuses if another action shares it). In the air dismount refuses and presses nothing; with confirm_airborne: true it presses twice, as the mod requires, and you fall while the aircraft flies on without a pilot and may crash. Sneak never takes you out of an aircraft: in the air it is the down control. Nothing ejects you automatically, not even a rescue reflex, so plan the landing.",
        "This pack's default R (aircraft dismount) and B (boost) also belong to other mods. Maintainers can assign the aircraft actions unused keys, such as F6 and F7 after checking the bindings. The tools follow the configured keys; a conflict refusal is a controls-configuration issue, not a reason to break the vehicle or press a GUI key blindly.",
      ] },
    ],
  },
];
