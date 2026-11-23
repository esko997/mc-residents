package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class BridgeAccessTest {
    @Test void shelfAndBookResultsCopyTheirLists() {
        BridgeAccess.BookInfo info = new BridgeAccess.BookInfo(0, "writable", null, null, null, 1, "hash");
        List<BridgeAccess.BookInfo> slots = new ArrayList<>(List.of(info));
        List<String> pages = new ArrayList<>(List.of("text"));
        BridgeAccess.Shelf shelf = new BridgeAccess.Shelf("library", "observed", null, slots);
        BridgeAccess.BookResult book = new BridgeAccess.BookResult("library", "observed", null, info, pages);
        slots.clear(); pages.clear();
        assertEquals(List.of(info), shelf.slots());
        assertEquals(List.of("text"), book.pages());
        assertThrows(UnsupportedOperationException.class, () -> shelf.slots().clear());
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
