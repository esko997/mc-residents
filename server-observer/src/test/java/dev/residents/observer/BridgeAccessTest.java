package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class BridgeAccessTest {
    @Test void placesAndRepliesCopyTheirLists() {
        BridgeAccess.Slot slot = Fixtures.written(0, "Bread", "Knead");
        List<BridgeAccess.Slot> slots = new ArrayList<>(List.of(slot));
        BridgeAccess.Place place = new BridgeAccess.Place(BridgeAccess.Where.LOADED, "minecraft:lectern",
                BridgeAccess.Holder.LECTERN, slots, null);
        List<String> pages = new ArrayList<>(List.of("text"));
        Library.BookReply book = new Library.BookReply(Fixtures.OVERWORLD, List.of(1, 2, 3), "minecraft:lectern", "observed",
                null, slot.book().info(), pages);
        slots.clear(); pages.clear();
        assertEquals(List.of(slot), place.slots());
        assertEquals(List.of("text"), book.pages());
        assertThrows(UnsupportedOperationException.class, () -> place.slots().clear());
        assertThrows(UnsupportedOperationException.class, () -> book.pages().clear());
    }

    @Test void unknownSightHasNullableVisibilityAndDistance() {
        BridgeAccess.Sight offline = new BridgeAccess.Sight(null, null, "offline");
        BridgeAccess.Sight unloaded = new BridgeAccess.Sight(null, 32.0, "unloaded");
        assertNull(offline.visible());
        assertNull(offline.distance());
        assertNull(unloaded.visible());
        assertEquals(32.0, unloaded.distance());
    }
}
