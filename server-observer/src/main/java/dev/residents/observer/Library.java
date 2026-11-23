package dev.residents.observer;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;

/**
 * The library by position: what a shelf or book read answers for one {@link BridgeAccess.Place}, and the
 * discovery list's items, order and cursor. Pure and unit-tested; the Minecraft side only says what stands
 * at a position ({@link MinecraftBridgeAccess#place}).
 *
 * <p>Shelf statuses, which Commons relies on to learn that a book or a shelf is gone:
 * {@code observed} (a chiseled bookshelf or a lectern; its books, possibly none), {@code no_shelf}
 * (anything else stands there, named in {@code block}), {@code unloaded} (unknown: the chunk is not loaded),
 * {@code no_level} (no such dimension). A shelf or lectern that is there but cannot be listed completely says
 * why instead ({@code invalid|too_large|error}); that means "unknown", never "gone".
 */
final class Library {

    static final int SHELF_SLOTS = 6;

    private Library() {
    }

    record ShelfReply(String dimension, List<Integer> pos, String block, String status, String reason,
                      List<BridgeAccess.BookInfo> slots) {
        ShelfReply {
            slots = List.copyOf(slots);
        }
    }

    record BookReply(String dimension, List<Integer> pos, String block, String status, String reason,
                     BridgeAccess.BookInfo book, List<String> pages) {
        BookReply {
            pages = List.copyOf(pages);
        }
    }

    /**
     * One discovered shelf or book-holding lectern. {@code observedAtMs}: when this holder's books were read (a
     * scan reads holders one at a time over several ticks, so items of one scan carry different times).
     */
    record Item(String dimension, List<Integer> pos, String block, String status, String reason,
                List<BridgeAccess.BookInfo> slots, long observedAtMs) {
        Item {
            pos = List.copyOf(pos);
            slots = List.copyOf(slots);
        }
    }

    static final Comparator<Item> ORDER = Comparator.comparing(Item::dimension)
            .thenComparingInt(i -> i.pos().get(0)).thenComparingInt(i -> i.pos().get(1)).thenComparingInt(i -> i.pos().get(2));

    // === read by position ===

    static ShelfReply shelf(Positions.At at, BridgeAccess.Place p) {
        Unknown u = unknown(at, p);
        if (u != null) return new ShelfReply(at.dimension(), at.pos(), p.block(), u.status, u.reason, List.of());
        Listing l = listing(p);
        return new ShelfReply(at.dimension(), at.pos(), p.block(), l.status, l.reason, l.books);
    }

    static BookReply book(Positions.At at, int slot, BridgeAccess.Place p) {
        Unknown u = unknown(at, p);
        if (u != null) return new BookReply(at.dimension(), at.pos(), p.block(), u.status, u.reason, null, List.of());
        if (slot < 0 || slot >= SHELF_SLOTS || (p.holder() == BridgeAccess.Holder.LECTERN && slot != 0)) {
            return book(at, p, "invalid", p.holder() == BridgeAccess.Holder.LECTERN ? "a lectern has one slot (0)" : "slot must be 0..5",
                    null, List.of());
        }
        BridgeAccess.Slot s = p.slots().stream().filter(x -> x.slot() == slot).findFirst().orElse(null);
        if (s == null) return book(at, p, "empty", "slot is empty", null, List.of());
        if (s.book() == null) return book(at, p, s.status(), s.reason(), null, List.of());
        BridgeAccess.BookInfo info = s.book().info();
        if (!info.kind().equals("written") && !info.kind().equals("writable")) {
            return book(at, p, "not_readable", "book kind has no readable pages", info, List.of());
        }
        return book(at, p, "observed", null, info, s.book().pages());
    }

    private static BookReply book(Positions.At at, BridgeAccess.Place p, String status, String reason,
                                  BridgeAccess.BookInfo info, List<String> pages) {
        return new BookReply(at.dimension(), at.pos(), p.block(), status, reason, info, pages);
    }

    private record Unknown(String status, String reason) { }

    /** The answers that are not a listing: no level, unloaded, a broken shelf/lectern, nothing that holds books. */
    private static Unknown unknown(Positions.At at, BridgeAccess.Place p) {
        return switch (p.where()) {
            case NO_LEVEL -> new Unknown("no_level", "dimension " + at.dimension() + " does not exist here");
            case UNLOADED -> new Unknown("unloaded", "chunk " + Math.floorDiv(at.x(), 16) + "," + Math.floorDiv(at.z(), 16)
                    + " is not loaded (the bridge never loads chunks)");
            case LOADED -> p.problem() != null ? new Unknown("error", p.problem())
                    : p.holder() == BridgeAccess.Holder.NONE ? new Unknown("no_shelf", "no chiseled bookshelf or lectern here")
                    : null;
        };
    }

    private record Listing(String status, String reason, List<BridgeAccess.BookInfo> books) { }

    /** All occupied slots, or the first slot that could not be read (no partial list that could pass as complete). */
    private static Listing listing(BridgeAccess.Place p) {
        List<BridgeAccess.BookInfo> books = new ArrayList<>(p.slots().size());
        for (BridgeAccess.Slot s : p.slots()) {
            if (s.book() == null) return new Listing(s.status(), "slot " + s.slot() + ": " + s.reason(), List.of());
            books.add(s.book().info());
        }
        books.sort(Comparator.comparingInt(BridgeAccess.BookInfo::slot));
        return new Listing("observed", null, books);
    }

    // === discovery ===

    /** The discovery entry for a found holder read at {@code atMs}, or null when it is not listed (a lectern without a book). */
    static Item item(String dimension, BridgeAccess.Found f, long atMs) {
        BridgeAccess.Place p = f.place();
        if (p.where() != BridgeAccess.Where.LOADED || p.holder() == BridgeAccess.Holder.NONE) return null;
        if (p.holder() == BridgeAccess.Holder.LECTERN && p.slots().isEmpty() && p.problem() == null) return null;
        List<Integer> pos = List.of(f.x(), f.y(), f.z());
        if (p.problem() != null) return new Item(dimension, pos, p.block(), "error", p.problem(), List.of(), atMs);
        Listing l = listing(p);
        return new Item(dimension, pos, p.block(), l.status, l.reason, l.books, atMs);
    }

    /** Opaque, URL-safe: the last item's dimension and position. Paging is by key, so it survives a rescan. */
    static String cursor(Item i) {
        String key = i.dimension() + "|" + i.pos().get(0) + "," + i.pos().get(1) + "," + i.pos().get(2);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(key.getBytes(StandardCharsets.UTF_8));
    }

    /** IllegalArgumentException (HTTP 400) for anything {@link #cursor} could not have produced. */
    static Item fromCursor(String cursor) {
        if (cursor == null || cursor.length() > 256) throw new IllegalArgumentException("cursor");
        String key = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        int bar = key.indexOf('|');
        if (bar < 0) throw new IllegalArgumentException("cursor");
        Positions.At at = Positions.parse(key.substring(0, bar), key.substring(bar + 1));
        return new Item(at.dimension(), at.pos(), null, null, null, List.of(), 0L);
    }

    /**
     * Server start: runs every pure step of a shelf read once (book selection and its SHA-256, discovery item,
     * ordering, cursor), so class loading and linking happen at startup rather than inside the first tick that
     * reads a shelf (on the isolated server the first scan's longest unit went from 13 ms to about 2 ms). No world.
     */
    static void warmUp() throws BookText.Invalid {
        BookText.Limits limits = new BookText.Limits(1, 64, 256);
        BridgeAccess.Place place = new BridgeAccess.Place(BridgeAccess.Where.LOADED, "minecraft:chiseled_bookshelf",
                BridgeAccess.Holder.SHELF, List.of(
                BridgeAccess.Slot.of(0, BookText.select(0, "written", "t", "a", 0, List.of("{\"text\":\"x\"}"), limits)),
                BridgeAccess.Slot.of(1, BookText.select(1, "writable", null, null, null, List.of("x"), limits)),
                BridgeAccess.Slot.of(2, BookText.other(2, "minecraft:knowledge_book"))), null);
        Positions.At at = new Positions.At("minecraft:overworld", 0, 0, 0);
        Item item = item(at.dimension(), new BridgeAccess.Found(0, 0, 0, place), 0L);
        java.util.TreeSet<Item> sorted = new java.util.TreeSet<>(ORDER);
        sorted.add(item);
        page(new ArrayList<>(sorted), fromCursor(cursor(item)), 1);
        shelf(at, place);
        book(at, 0, place);
    }

    record Page(List<Item> items, String next) {
        Page {
            items = List.copyOf(items);
        }
    }

    /** Items strictly after {@code after} (null: from the start) in {@link #ORDER}; {@code sorted} must be in that order. */
    static Page page(List<Item> sorted, Item after, int limit) {
        int start = 0;
        if (after != null) {
            int lo = 0, hi = sorted.size();
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (ORDER.compare(sorted.get(mid), after) <= 0) lo = mid + 1;
                else hi = mid;
            }
            start = lo;
        }
        int end = Math.min(sorted.size(), start + limit);
        List<Item> items = sorted.subList(start, end);
        return new Page(items, end < sorted.size() ? cursor(sorted.get(end - 1)) : null);
    }
}
