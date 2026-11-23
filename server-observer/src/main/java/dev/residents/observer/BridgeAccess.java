package dev.residents.observer;

import java.util.List;

/**
 * Tick-thread-only reads for queued requests and the shelf scan. Returned values contain no live game
 * objects. Every method reads only already-loaded chunks and never changes the world.
 */
public interface BridgeAccess {
    Sight sight(WatchList.ResidentSpec from, WatchList.ResidentSpec to);

    /** What stands at one position, for the shelf and book reads. Only that position's own chunk is looked at. */
    Place place(String dimension, int x, int y, int z);

    /** A capability read at any position, as a facility is read (its 3×3 chunk neighbourhood must be loaded). */
    Observations.BlockRead block(String dimension, int x, int y, int z);

    /** Ids of the levels the server has now, in any order. */
    List<String> dimensions();

    /**
     * Keys ({@link Positions#chunkKey}) of the chunks this level holds now, at most {@code cap} (the rest
     * are reported as cut). Null when the level no longer exists.
     */
    ChunkList loadedChunks(String dimension, int cap);

    /**
     * Positions of the chiseled bookshelves and lecterns among one chunk's block entities, examining those at
     * iteration positions {@code offset .. offset+maxBlockEntities-1} only; {@code more} says there are further
     * block entities to examine with a larger offset. Reads no books (that is {@link #place}, one holder at a
     * time). Null when the chunk (or its level) is not loaded now.
     */
    ChunkHolders holders(String dimension, long chunkKey, int offset, int maxBlockEntities);

    /**
     * For the shelf scan: {@link #place} without pages, where a book already selected and unchanged since (the same
     * item stack and the same tag objects) is not decoded again, and at most {@code maxNewBooks} other books are.
     * {@code pending} counts the books left undecoded; while it is above zero the place's slots are incomplete
     * and must not be published.
     */
    Scanned scanPlace(String dimension, int x, int y, int z, int maxNewBooks);

    record Scanned(Place place, int pending) { }

    record Sight(Boolean visible, Double distance, String reason) { }

    /** {@code item}: the registry id. {@code kind}: written|writable|enchanted|plain|other. */
    record BookInfo(int slot, String kind, String item, String title, String author, Integer generation,
                    int pageCount, String contentHash) { }

    /** One occupied slot as read: the selected book, or why it could not be selected (status, reason). */
    record Slot(int slot, BookText.Selected book, String status, String reason) {
        static Slot of(int slot, BookText.Selected book) {
            return new Slot(slot, book, null, null);
        }

        static Slot failed(int slot, String status, String reason) {
            return new Slot(slot, null, status, reason);
        }
    }

    enum Holder {
        /** A chiseled bookshelf block entity: slots 0..5. */
        SHELF,
        /** A lectern block entity: slot 0. */
        LECTERN,
        /** Anything else: air, another block, another block entity. */
        NONE
    }

    enum Where { NO_LEVEL, UNLOADED, LOADED }

    /**
     * What one position holds. {@code block}: the block id when loaded. {@code slots}: occupied slots only.
     * {@code problem}: a shelf or lectern block whose block entity is missing (an error, never "no shelf").
     */
    record Place(Where where, String block, Holder holder, List<Slot> slots, String problem) {
        public Place {
            slots = List.copyOf(slots);
        }

        static Place noLevel() {
            return new Place(Where.NO_LEVEL, null, Holder.NONE, List.of(), null);
        }

        static Place unloaded() {
            return new Place(Where.UNLOADED, null, Holder.NONE, List.of(), null);
        }

        static Place other(String block) {
            return new Place(Where.LOADED, block, Holder.NONE, List.of(), null);
        }
    }

    record ChunkList(long[] keys, boolean truncated) { }

    /** One shelf or lectern as read for discovery: its position and what it holds now. */
    record Found(int x, int y, int z, Place place) { }

    /** A block position. */
    record Spot(int x, int y, int z) { }

    record ChunkHolders(List<Spot> spots, int examined, boolean more) {
        public ChunkHolders {
            spots = List.copyOf(spots);
        }
    }
}
