package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The read by position is how Commons learns that a book or shelf is gone, so each of its five answers must be
 * exact, and an unloaded position must never look like "no shelf" or like an empty shelf.
 */
class LibraryTest {

    private static final Positions.At AT = new Positions.At(Fixtures.OVERWORLD, 4, 66, -1);

    private static BridgeAccess.Slot other(int slot, String item) {
        try {
            return BridgeAccess.Slot.of(slot, BookText.other(slot, item));
        } catch (BookText.Invalid e) {
            throw new AssertionError(e);
        }
    }

    // === the five answers ===

    @Test
    void aChiseledBookshelfIsObservedWithItsBooksAndAnEmptyOneWithNone() {
        Library.ShelfReply shelf = Library.shelf(AT, Fixtures.shelf(Fixtures.written(3, "Bread", "Knead"), Fixtures.written(0, "Rails")));
        assertEquals("observed", shelf.status());
        assertNull(shelf.reason());
        assertEquals("minecraft:chiseled_bookshelf", shelf.block());
        assertEquals(List.of(0, 3), shelf.slots().stream().map(BridgeAccess.BookInfo::slot).toList(), "slot order");
        assertEquals(List.of(4, 66, -1), shelf.pos());

        Library.ShelfReply empty = Library.shelf(AT, Fixtures.shelf());
        assertEquals("observed", empty.status());
        assertTrue(empty.slots().isEmpty());
    }

    @Test
    void aLecternIsObservedWithItsBookInSlotZeroOrNoSlots() {
        Library.ShelfReply holding = Library.shelf(AT, Fixtures.lectern(Fixtures.written(0, "Bread", "Knead")));
        assertEquals("observed", holding.status());
        assertEquals("minecraft:lectern", holding.block());
        assertEquals(0, holding.slots().get(0).slot());
        Library.ShelfReply bare = Library.shelf(AT, Fixtures.lectern());
        assertEquals("observed", bare.status());
        assertTrue(bare.slots().isEmpty(), "a lectern whose book was taken is observed with no slots: the book is gone");
    }

    @Test
    void anythingElseIsNoShelfAndSaysWhatIsThere() {
        for (String block : List.of("minecraft:air", "minecraft:chest", "minecraft:bookshelf", "minecraft:void_air")) {
            Library.ShelfReply r = Library.shelf(AT, BridgeAccess.Place.other(block));
            assertEquals("no_shelf", r.status(), block);
            assertEquals(block, r.block());
            assertTrue(r.slots().isEmpty());
        }
    }

    @Test
    void anUnloadedChunkIsUnknownNeverNoShelfOrAnEmptyShelf() {
        Library.ShelfReply r = Library.shelf(AT, BridgeAccess.Place.unloaded());
        assertEquals("unloaded", r.status());
        assertNotEquals("no_shelf", r.status());
        assertNotEquals("observed", r.status());
        assertNull(r.block(), "nothing is claimed about what stands there");
        assertTrue(r.reason().contains("0,-1"), r.reason());
        Library.BookReply b = Library.book(AT, 0, BridgeAccess.Place.unloaded());
        assertEquals("unloaded", b.status());
        assertNull(b.book());
        // And discovery never lists an unloaded position as anything.
        assertNull(Library.item(Fixtures.OVERWORLD, new BridgeAccess.Found(4, 66, -1, BridgeAccess.Place.unloaded()), 5L));
    }

    @Test
    void aMissingDimensionIsNoLevel() {
        Positions.At nowhere = new Positions.At("mod:gone", 0, 64, 0);
        assertEquals("no_level", Library.shelf(nowhere, BridgeAccess.Place.noLevel()).status());
        assertEquals("no_level", Library.book(nowhere, 0, BridgeAccess.Place.noLevel()).status());
    }

    @Test
    void aShelfThatIsThereButCannotBeListedIsUnknownNotGone() {
        BridgeAccess.Place broken = new BridgeAccess.Place(BridgeAccess.Where.LOADED, "minecraft:lectern",
                BridgeAccess.Holder.LECTERN, List.of(), "minecraft:lectern has no block entity");
        assertEquals("error", Library.shelf(AT, broken).status());
        BridgeAccess.Place oversized = Fixtures.shelf(Fixtures.written(0, "Bread", "Knead"),
                BridgeAccess.Slot.failed(4, "too_large", "page count exceeds maxBookPages"));
        Library.ShelfReply r = Library.shelf(AT, oversized);
        assertEquals("too_large", r.status());
        assertTrue(r.slots().isEmpty(), "no partial list that could pass as complete");
        assertTrue(r.reason().startsWith("slot 4: "));
    }

    // === books ===

    @Test
    void bookReadsByPosition() {
        BridgeAccess.Place shelf = Fixtures.shelf(Fixtures.written(1, "Bread", "Knead", "Bake"), other(2, "patchouli:guide_book"),
                BridgeAccess.Slot.failed(5, "invalid", "pages must be a list tag"));
        Library.BookReply ok = Library.book(AT, 1, shelf);
        assertEquals("observed", ok.status());
        assertEquals(List.of("Knead", "Bake"), ok.pages());
        assertEquals("minecraft:written_book", ok.book().item());
        assertEquals("empty", Library.book(AT, 0, shelf).status());
        Library.BookReply guide = Library.book(AT, 2, shelf);
        assertEquals("not_readable", guide.status());
        assertEquals("other", guide.book().kind());
        assertEquals("patchouli:guide_book", guide.book().item());
        assertEquals("invalid", Library.book(AT, 5, shelf).status());
        assertEquals("no_shelf", Library.book(AT, 0, BridgeAccess.Place.other("minecraft:stone")).status());

        BridgeAccess.Place lectern = Fixtures.lectern(Fixtures.written(0, "Rails", "North"));
        assertEquals("observed", Library.book(AT, 0, lectern).status());
        Library.BookReply second = Library.book(AT, 1, lectern);
        assertEquals("invalid", second.status());
        assertTrue(second.reason().contains("one slot"));
    }

    @Test
    void otherItemsHashByItemIdSoDifferentItemsNeverShareOne() throws Exception {
        String guide = BookText.other(0, "patchouli:guide_book").info().contentHash();
        assertEquals(guide, BookText.other(5, "patchouli:guide_book").info().contentHash());
        assertNotEquals(guide, BookText.other(0, "minecraft:knowledge_book").info().contentHash());
        assertThrows(BookText.Invalid.class, () -> BookText.other(0, "Not An Id"));
    }

    // === discovery ===

    @Test
    void discoveryListsEveryShelfButOnlyLecternsHoldingABook() {
        assertEquals("observed", Library.item(Fixtures.OVERWORLD, new BridgeAccess.Found(1, 2, 3, Fixtures.shelf()), 5L).status(),
                "an empty chiseled bookshelf is listed");
        assertNull(Library.item(Fixtures.OVERWORLD, new BridgeAccess.Found(1, 2, 3, Fixtures.lectern()), 5L),
                "a lectern without a book is not");
        Library.Item lectern = Library.item(Fixtures.OVERWORLD, new BridgeAccess.Found(1, 2, 3,
                Fixtures.lectern(Fixtures.written(0, "Bread", "Knead"))), 5L);
        assertEquals(1, lectern.slots().size());
        assertEquals(5L, lectern.observedAtMs(), "the time its books were read");
        Library.Item odd = Library.item(Fixtures.OVERWORLD, new BridgeAccess.Found(1, 2, 3,
                Fixtures.shelf(BridgeAccess.Slot.failed(0, "too_large", "big"))), 5L);
        assertEquals("too_large", odd.status());
        assertTrue(odd.slots().isEmpty());
    }

    @Test
    void cursorsPageInStableOrderAndSurviveARescan() {
        List<Library.Item> items = new ArrayList<>();
        for (String dim : List.of("minecraft:the_nether", "minecraft:overworld")) {
            for (int x = -3; x <= 3; x++) {
                items.add(new Library.Item(dim, List.of(x, 64, x * 7), "minecraft:chiseled_bookshelf", "observed", null, List.of(), 1L));
            }
        }
        items.sort(Library.ORDER);
        List<Library.Item> seen = new ArrayList<>();
        Library.Item after = null;
        for (int page = 0; page < 10; page++) {
            Library.Page p = Library.page(items, after, 3);
            seen.addAll(p.items());
            if (p.next() == null) break;
            after = Library.fromCursor(p.next());
        }
        assertEquals(items, seen, "every item once, in order");
        assertEquals("minecraft:overworld", seen.get(0).dimension());

        // A rescan between pages: an item before the cursor vanished, a new one after it appeared.
        Library.Page first = Library.page(items, null, 5);
        List<Library.Item> rescanned = new ArrayList<>(items);
        rescanned.remove(0);
        rescanned.add(new Library.Item("minecraft:overworld", List.of(100, 64, 0), "minecraft:lectern", "observed", null, List.of(), 2L));
        rescanned.sort(Library.ORDER);
        Library.Page second = Library.page(rescanned, Library.fromCursor(first.next()), 5);
        assertEquals(items.get(5), second.items().get(0), "paging continues right after the last item seen");

        for (String bad : List.of("", "%%%", "bm90LWEtY3Vyc29y", "bWluZWNyYWZ0Om92ZXJ3b3JsZHwxLDI")) {
            assertThrows(IllegalArgumentException.class, () -> Library.fromCursor(bad), bad);
        }
    }
}
