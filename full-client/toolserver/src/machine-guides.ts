import type { GuideSection } from "./guides-data.ts";

// Body procedures for the Refined Storage Grid and Mekanism side configuration
// tools in src/machines.ts. Written 2026-11-22 from the installed mods' source
// (refinedstorage v1.12.4 GridScreen/GridItemPullMessage/ItemGridHandler;
// Mekanism v1.20.1-10.4.16.80 GuiSideConfiguration/PacketConfigurationUpdate)
// and the Synapse adapters. Reference procedures: NOT yet tested in the world.

/** Sections to append to existing reference guides, keyed by guide id. */
export const machineGuideSections: Readonly<Record<"refined-storage" | "mekanism", readonly GuideSection[]>> = {
  "refined-storage": [
    { id: "grid-access", title: "Taking from and storing through a Grid with this body", aliases: ["grid", "withdraw", "take", "retrieve", "search", "storage grid", "get items", "storage_grid"],
      source: "refinedstorage v1.12.4 GridScreen + Synapse RS Grid adapter (source-read, not world-tested)", paragraphs: [
        "A Grid's stored results are not menu slots: screen and click_slot only reach your own inventory (and crafting slots) in it. Open the Grid by looking at it and using it, then storage_grid lists what it shows, in its display order, with a short id per result; storage_grid {search} narrows it through the Grid's own search box.",
        "storage_grid_take {id, item} takes one stack (up to 64) into your inventory; it arrives only if the whole stack fits, so make room first. amount half takes half; count N takes N one at a time, each confirmed. to cursor puts it on your cursor instead: place it with click_slot before closing. The reply says what actually reached you; if nothing did, check power, your inventory room and the network's Security Manager permissions before trying again.",
        "To store, click_slot one of your own inventory slots with mode QUICK_MOVE while the Grid is open: the Grid inserts it into the network (insert permission applies). Read storage_grid again afterwards to see it counted.",
        "Ids belong to the network's current stock and change when an item leaves and comes back; take using a recent read. Craft-only entries are autocrafting requests, which these tools do not start."
      ] },
  ],
  mekanism: [
    { id: "side-configuration", title: "Side configuration and auto-eject with this body", aliases: ["side config", "side configuration", "sides", "configurator", "eject", "auto eject", "auto-eject", "output side", "input side", "machine_sides"],
      source: "Mekanism v1.20.1-10.4.16.80 GuiSideConfiguration + Synapse Mekanism adapter (source-read, not world-tested)", paragraphs: [
        "Mekanism's side configuration is a tab on the machine's screen that opens its own window; click_button cannot press it. With the machine's screen open, machine_sides opens that window and lists, for each transmission (ITEM, ENERGY, FLUID, GAS...), every side's role and the compass direction it faces. Sides are named from the machine's front (FRONT, BACK, LEFT, RIGHT, TOP, BOTTOM).",
        "machine_sides_set {transmission, side, data} changes one side's role, e.g. ITEM BACK OUTPUT so items can be pulled or pushed out of the back; ENERGY sides accept power. machine_sides_set {transmission, eject} turns auto-eject on or off, which makes the machine push its output out of its OUTPUT sides into whatever is attached there. Stay within 8 blocks of the machine with its screen open; each change is one click, confirmed before the next.",
        "Security remains the machine owner's choice. This body refuses another owner's TRUSTED-mode configuration because Mekanism does not send the trust list to the client and its configuration packets do not recheck permissions. Ask the owner to make that change; do not weaken security to get around the refusal. Owner-operated and public machines use the ordinary checks.",
        "A role on the screen is not working automation. Afterwards put real input in, wait for output and check where it went (the next machine's screen, or the chest). Record the configuration and the observed result where your neighbours can find it."
      ] },
  ],
};
