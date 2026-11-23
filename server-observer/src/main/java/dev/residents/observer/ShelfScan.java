package dev.residents.observer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

/**
 * Discovery of every chiseled bookshelf and book-holding lectern in loaded chunks, all dimensions, as a
 * state machine the server tick advances one small unit at a time while its budget allows.
 *
 * <p>It never walks blocks. Units, each bounded:
 * <ul>
 *   <li><b>level</b>: copy the keys of the chunks the server holds for one level (one pass over its chunk map,
 *   at most {@link #MAX_CHUNKS_PER_LEVEL});</li>
 *   <li><b>slice</b>: examine at most {@link #BLOCK_ENTITIES_PER_SLICE} of one chunk's block entities and note
 *   where the shelves and book-holding lecterns are (no book is read); a chunk with more block entities takes
 *   further slices, so a dense chunk is finished over several units, never skipped;</li>
 *   <li><b>holder</b>: read one noted shelf or lectern at its position, decoding at most
 *   {@link #NEW_BOOKS_PER_UNIT} book not already seen unchanged (the bridge remembers each book stack's result
 *   while the stack and its tags are the same objects). A shelf of new books is revisited until all its slots
 *   are known and is then published from that one read; a shelf whose books keep changing gets its remaining
 *   books in its {@link #MAX_VISITS}th unit, so it always ends. It may have changed or gone since it was noted.</li>
 * </ul>
 * Nothing is held across ticks except plain keys, positions and immutable results (the bridge's book memo is
 * keyed weakly by item stack), so a chunk or level that disappears mid-scan is simply not there. Each item keeps
 * the time its books were read. A finished scan is published whole, sorted by dimension then position.
 *
 * <p>Freshness counts from when a scan <i>finished</i>: it is served for {@link #MAX_AGE_MS} after that, however
 * long the scan took, so a slow pass (a busy server, a huge loaded area) still yields a usable result. Times are
 * never rewritten: {@code scannedAtMs} is when it began, and every item says when it was read. A scan runs only
 * on demand: while a discovery request came within {@link #DEMAND_MS}, a new one starts {@link #REFRESH_MS}
 * after the previous one finished. With no requests it does nothing. Every cap that cuts the list sets
 * {@code truncated}.
 *
 * <p>Threads: {@link #step} and {@link #wantsWork} on the server thread only; {@link #demand},
 * {@link #fresh} and {@link #metrics} from any thread.
 */
final class ShelfScan {

    static final long MAX_AGE_MS = 30_000;
    static final long REFRESH_MS = 20_000;
    static final long DEMAND_MS = 300_000;
    static final int MAX_ITEMS = 4096;
    static final int MAX_CHUNKS_PER_LEVEL = 32_768;
    static final int BLOCK_ENTITIES_PER_SLICE = 1024;
    /** Books a holder unit may decode that it has not seen unchanged before. */
    static final int NEW_BOOKS_PER_UNIT = 1;
    /** A holder whose books keep changing gets all its remaining books decoded in its eighth unit, so it ends. */
    static final int MAX_VISITS = 8;

    /** A finished scan: began at {@code scannedAtMs}, finished at {@code completedAtMs}. */
    record Index(List<Library.Item> items, long scannedAtMs, long completedAtMs, boolean truncated) {
        Index {
            items = List.copyOf(items);
        }
    }

    /**
     * Cost and size of the last finished scan, plus totals. {@code lastWorkMicros}: tick time the scan's units
     * took in all; {@code lastTicks}: ticks it spanned; {@code lastMaxUnitMicros}/{@code maxUnitMicros}: the
     * longest single unit in the last scan / ever; {@code lastSlices}: block-entity slices; {@code lastHolders}:
     * shelves and lecterns read; {@code lastHolderUnits}: units spent on them (more than one each while their
     * books are new: one new book per unit); {@code lastChunksGone}: chunks unloaded between listing and reading;
     * {@code errors}: units that threw (that chunk, holder or level is skipped, the list is cut).
     */
    record Metrics(boolean running, long scans, long lastScannedAtMs, long lastCompletedAtMs, long lastWorkMicros,
                   long lastTicks, long lastLevels, long lastChunks, long lastChunksGone, long lastSlices,
                   long lastBlockEntities, long lastHolders, long lastHolderUnits, int lastItems, boolean lastTruncated,
                   long lastMaxUnitMicros, long maxUnitMicros, long errors, String lastError) {
    }

    private final AtomicReference<Index> published = new AtomicReference<>();
    private volatile long lastDemandMs = Long.MIN_VALUE;
    private volatile Metrics metrics = new Metrics(false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0, 0, null);

    // Server thread only.
    private boolean running;
    private List<String> levels;
    private int level;
    private long[] chunks;
    private int chunk;          // next chunk to slice
    private int chunkOffset;    // block entities of chunks[chunk] already examined
    private final ArrayDeque<BridgeAccess.Spot> holders = new ArrayDeque<>();
    private TreeSet<Library.Item> found;
    private boolean truncated;
    private long startedAtMs;
    private long workNanos, ticks, lastTick = Long.MIN_VALUE, chunksRead, chunksGone, slices, blockEntities,
            holdersRead, holderUnits, levelsRead;
    private BridgeAccess.Spot lastSpot;
    private int visits;
    private long scans, maxUnitNanos, scanMaxUnitNanos, errors;
    private String lastError;

    // === any thread ===

    /** A discovery request arrived: keep scans fresh for the next {@link #DEMAND_MS}. */
    void demand(long nowMs) {
        lastDemandMs = nowMs;
    }

    /** The published scan if it finished at most {@link #MAX_AGE_MS} ago, else null. */
    Index fresh(long nowMs) {
        Index i = published.get();
        return i != null && nowMs - i.completedAtMs() <= MAX_AGE_MS ? i : null;
    }

    Metrics metrics() {
        return metrics;
    }

    // === server thread ===

    boolean wantsWork(long nowMs) {
        if (running) return true;
        if (lastDemandMs == Long.MIN_VALUE || nowMs - lastDemandMs > DEMAND_MS) return false;
        Index i = published.get();
        return i == null || nowMs - i.completedAtMs() >= REFRESH_MS;
    }

    /**
     * One unit (see the class comment). {@code tick} counts the ticks a scan spans. Failures of a unit are
     * contained here (counted, the list marked cut); the scan continues.
     */
    void step(BridgeAccess bridge, long nowMs, long tick, LongSupplier nanos) {
        long t0 = nanos.getAsLong();
        boolean boundary = false;
        try {
            if (!running) {
                start(bridge, nowMs);
                boundary = true;
            } else if (!holders.isEmpty()) {
                readHolder(bridge, holders.poll(), nowMs);
            } else if (level >= levels.size()) {
                finish(nowMs);
                boundary = true;
            } else if (chunks == null) {
                listLevel(bridge);
                boundary = true;
            } else if (chunk < chunks.length) {
                slice(bridge, levels.get(level), chunks[chunk]);
            } else {
                chunks = null;
                level++;
            }
        } catch (RuntimeException e) {
            errors++;
            lastError = Sampler.describe(e);
            truncated = true;
            if (running && chunks == null && levels != null && level < levels.size()) level++; // listing failed: skip it
            else if (running && chunks != null && holders.isEmpty() && chunk < chunks.length) nextChunk(); // slice failed
        } finally {
            long spent = nanos.getAsLong() - t0;
            workNanos += spent;
            maxUnitNanos = Math.max(maxUnitNanos, spent);
            scanMaxUnitNanos = Math.max(scanMaxUnitNanos, spent);
            if (tick != lastTick) {
                ticks++;
                lastTick = tick;
            }
            if (boundary || !running) publishMetrics(); // at start, per level and at the end, not per unit
        }
    }

    private void start(BridgeAccess bridge, long nowMs) {
        List<String> dims = new ArrayList<>(bridge.dimensions());
        dims.sort(null);
        levels = dims;
        level = 0;
        chunks = null;
        chunk = 0;
        chunkOffset = 0;
        holders.clear();
        found = new TreeSet<>(Library.ORDER);
        truncated = false;
        startedAtMs = nowMs;
        workNanos = 0;
        scanMaxUnitNanos = 0;
        ticks = 0;
        lastTick = Long.MIN_VALUE;
        chunksRead = chunksGone = slices = blockEntities = holdersRead = holderUnits = levelsRead = 0;
        lastSpot = null;
        visits = 0;
        running = true;
    }

    private void listLevel(BridgeAccess bridge) {
        BridgeAccess.ChunkList list = bridge.loadedChunks(levels.get(level), MAX_CHUNKS_PER_LEVEL);
        if (list == null) { // the level is gone: nothing of it is loaded
            level++;
            return;
        }
        levelsRead++;
        truncated |= list.truncated();
        chunks = list.keys();
        chunk = 0;
        chunkOffset = 0;
    }

    private void slice(BridgeAccess bridge, String dimension, long key) {
        // The slice is the unit: whatever happens below, the chunk pointer moves on or the offset grows.
        BridgeAccess.ChunkHolders h = bridge.holders(dimension, key, chunkOffset, BLOCK_ENTITIES_PER_SLICE);
        if (h == null) {
            if (chunkOffset == 0) chunksGone++;
            else truncated = true; // unloaded between two slices of one chunk: the rest of it was not seen
            nextChunk();
            return;
        }
        slices++;
        if (chunkOffset == 0) chunksRead++;
        blockEntities += h.examined();
        holders.addAll(h.spots());
        if (h.more() && h.examined() > 0) {
            chunkOffset += h.examined();
        } else {
            nextChunk();
        }
    }

    private void nextChunk() {
        chunk++;
        chunkOffset = 0;
    }

    private void readHolder(BridgeAccess bridge, BridgeAccess.Spot s, long nowMs) {
        holderUnits++;
        visits = s.equals(lastSpot) ? visits + 1 : 1;
        lastSpot = s;
        // One book not seen unchanged before is decoded per unit; a shelf of new books takes several units, and is
        // published from the unit in which every slot was available, so its listing is one consistent read.
        int allowance = visits >= MAX_VISITS ? Library.SHELF_SLOTS : NEW_BOOKS_PER_UNIT;
        BridgeAccess.Scanned scanned = bridge.scanPlace(levels.get(level), s.x(), s.y(), s.z(), allowance);
        if (scanned.pending() > 0) {
            holders.addFirst(s);
            return;
        }
        holdersRead++;
        Library.Item item = Library.item(levels.get(level), new BridgeAccess.Found(s.x(), s.y(), s.z(), scanned.place()), nowMs);
        if (item == null) return; // gone, unloaded or a bookless lectern since it was noted
        if (found.size() >= MAX_ITEMS) {
            truncated = true;
            holders.clear();
            level = levels.size(); // full: finish with what fits
            return;
        }
        found.add(item);
    }

    private void finish(long nowMs) {
        published.set(new Index(new ArrayList<>(found), startedAtMs, nowMs, truncated));
        scans++;
        running = false;
        found = null;
        chunks = null;
    }

    /** While a scan runs, the {@code last*} fields keep describing the last finished one. */
    private void publishMetrics() {
        Index last = published.get();
        Metrics previous = metrics;
        metrics = running
                ? new Metrics(true, scans, previous.lastScannedAtMs(), previous.lastCompletedAtMs(), previous.lastWorkMicros(),
                previous.lastTicks(), previous.lastLevels(), previous.lastChunks(), previous.lastChunksGone(),
                previous.lastSlices(), previous.lastBlockEntities(), previous.lastHolders(), previous.lastHolderUnits(),
                previous.lastItems(),
                previous.lastTruncated(), previous.lastMaxUnitMicros(), maxUnitNanos / 1000L, errors, lastError)
                : new Metrics(false, scans, startedAtMs, last == null ? 0 : last.completedAtMs(), workNanos / 1000L, ticks,
                levelsRead, chunksRead, chunksGone, slices, blockEntities, holdersRead, holderUnits,
                last == null ? 0 : last.items().size(),
                truncated, scanMaxUnitNanos / 1000L, maxUnitNanos / 1000L, errors, lastError);
    }
}
