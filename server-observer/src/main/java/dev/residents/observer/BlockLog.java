package dev.residents.observer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Block place/break changes attributed to watched residents, in two bounded forms. Pure and
 * single-threaded: only the server thread calls it (listeners, the sampler tick and tick-queued reads).
 *
 * <ul>
 *   <li><b>Hour cells</b> count every accepted change: one cell per (resident, dimension, chunk,
 *   wall-clock hour) with placed/broken totals per block id for the first {@value #KINDS_PER_CELL}
 *   distinct ids seen in that cell (later ids are summed as "other"). At most {@code maxCells} cells; when full, the oldest cell
 *   of an earlier hour is evicted, and if every cell is from the current hour the change is counted
 *   only in that resident's hour overflow (no position). Cells older than {@code hours} are dropped.</li>
 *   <li><b>Detail</b> keeps each change (position, block id, times) in a ring of
 *   {@code detailCapacity}, at most {@code detailPerTick} per server tick and none once the tick's
 *   listener time exceeds the budget; skipped details are still counted in their hour cell.</li>
 * </ul>
 */
public final class BlockLog {

    public static final long HOUR_MS = 3_600_000L;
    public static final int KINDS_PER_CELL = 8;

    public record Change(String resident, String action, String dimension, int x, int y, int z, String block,
                         long atMs, long gameTime) {
    }

    public record Kind(String block, long placed, long broken) {
    }

    public record Cell(String resident, String dimension, int chunkX, int chunkZ, long hourMs, long placed, long broken,
                       List<Kind> kinds, long otherPlaced, long otherBroken, long firstAtMs, long lastAtMs) {
        public Cell {
            kinds = List.copyOf(kinds);
        }
    }

    /** Changes counted without a position because the cell table was full of current-hour cells. */
    public record Overflow(String resident, long hourMs, long placed, long broken) {
    }

    /**
     * One page of hour cells with {@code hourMs >= sinceHourMs}. {@code retainedFromHourMs}: older
     * hours were dropped by age. {@code evictedThroughHourMs}: cells up to this hour may have been
     * evicted early because the table was full (0 if never).
     */
    public record HoursPage(List<Cell> cells, List<Overflow> overflow, int offset, int total, boolean more,
                            long sinceHourMs, long retainedFromHourMs, long evictedThroughHourMs) {
        public HoursPage {
            cells = List.copyOf(cells);
            overflow = List.copyOf(overflow);
        }
    }

    public record Metrics(boolean enabled, long recorded, long placed, long broken, long detailKept, long detailSkipped,
                          long detailDropped, int cells, int maxCells, long cellsEvicted, long overflowChanges,
                          long offThread, long listenerMaxTickMicros, long listenerOverBudgetTicks, long listenerTotalMicros) {
    }

    private record Key(String resident, String dimension, int chunkX, int chunkZ, long hourMs) {
    }

    private static final class Acc {
        long placed, broken, otherPlaced, otherBroken, firstAtMs, lastAtMs;
        final LinkedHashMap<String, long[]> kinds = new LinkedHashMap<>(4);
    }

    private record OverflowKey(String resident, long hourMs) {
    }

    private final boolean enabled;
    private final int detailPerTick;
    private final int maxCells;
    private final long retentionMs;
    private final long budgetNanos;
    private final SeqRing<Change> detail;
    private final LinkedHashMap<Key, Acc> cells = new LinkedHashMap<>();
    private final Map<OverflowKey, long[]> overflow = new HashMap<>();
    private long currentHour = Long.MIN_VALUE;
    private long retainedFromHour;
    private long evictedThroughHour;

    private int detailThisTick;
    private long nanosThisTick;
    private long recorded, placed, broken, detailKept, detailSkipped, cellsEvicted, overflowChanges;
    private final java.util.concurrent.atomic.AtomicLong offThread = new java.util.concurrent.atomic.AtomicLong();
    private long listenerMaxTickMicros, listenerOverBudgetTicks, listenerTotalNanos;
    private volatile Metrics metrics;

    public BlockLog(ObserverConfig.Recording r, int budgetMicros) {
        this(r.recordBlocks(), r.blockDetailCapacity(), r.blockDetailPerTick(), r.blockAggregateCells(),
                r.blockAggregateHours(), budgetMicros);
    }

    BlockLog(boolean enabled, int detailCapacity, int detailPerTick, int maxCells, int hours, int budgetMicros) {
        this.enabled = enabled;
        this.detailPerTick = detailPerTick;
        this.maxCells = maxCells;
        this.retentionMs = hours * HOUR_MS;
        this.budgetNanos = budgetMicros * 1000L;
        this.detail = new SeqRing<>(detailCapacity);
        publishMetrics();
    }

    public boolean enabled() {
        return enabled;
    }

    /** Server thread. One accepted change by a watched resident. */
    public void record(String resident, boolean place, String dimension, int x, int y, int z, String block,
                       long nowMs, long gameTime) {
        if (!enabled) return;
        long hour = Math.floorDiv(nowMs, HOUR_MS) * HOUR_MS;
        if (hour != currentHour) rollHour(hour);
        recorded++;
        if (place) placed++; else broken++;
        count(resident, place, dimension, x >> 4, z >> 4, hour, block, nowMs);
        if (detailThisTick < detailPerTick && nanosThisTick <= budgetNanos) {
            detailThisTick++;
            detailKept++;
            detail.append(new Change(resident, place ? "place" : "break", dimension, x, y, z, block, nowMs, gameTime));
        } else {
            detailSkipped++;
        }
    }

    /** Server thread: the listener's own measured time for one event (including work that returned early). */
    public void addListenerNanos(long nanos) {
        nanosThisTick += Math.max(0L, nanos);
    }

    /** Any thread: a change arrived off the server thread and was ignored (never expected in vanilla/Forge). */
    public void offThread() {
        offThread.incrementAndGet();
    }

    /**
     * Server thread, once per tick (from the sampler): close the tick's listener budget and publish.
     * Returns the listener time spent since the previous tick, so the sampler can count it in its own
     * tick timing.
     */
    public long endTick(long nowMs) {
        long listenerNanos = nanosThisTick;
        if (listenerNanos > 0) {
            long micros = listenerNanos / 1000L;
            listenerTotalNanos += listenerNanos;
            listenerMaxTickMicros = Math.max(listenerMaxTickMicros, micros);
            if (listenerNanos > budgetNanos) listenerOverBudgetTicks++;
        }
        boolean changed = detailThisTick > 0 || listenerNanos > 0;
        detailThisTick = 0;
        nanosThisTick = 0;
        long hour = Math.floorDiv(nowMs, HOUR_MS) * HOUR_MS;
        if (hour != currentHour && currentHour != Long.MIN_VALUE) {
            rollHour(hour);
            changed = true;
        }
        detail.publish();
        if (changed) publishMetrics();
        return listenerNanos;
    }

    public SeqRing.View<Change> detail() {
        return detail.view();
    }

    public Metrics metrics() {
        return metrics;
    }

    /** Server thread (a tick-queued read): a bounded copy, never a live reference. */
    public HoursPage hours(long sinceHourMs, String resident, int offset, int limit) {
        List<Cell> out = new ArrayList<>(Math.min(limit, cells.size()));
        int total = 0;
        for (Map.Entry<Key, Acc> e : cells.entrySet()) {
            Key k = e.getKey();
            if (k.hourMs() < sinceHourMs || (resident != null && !resident.equals(k.resident()))) continue;
            if (total >= offset && out.size() < limit) out.add(cell(k, e.getValue()));
            total++;
        }
        List<Overflow> over = new ArrayList<>();
        for (Map.Entry<OverflowKey, long[]> e : overflow.entrySet()) {
            OverflowKey k = e.getKey();
            if (k.hourMs() < sinceHourMs || (resident != null && !resident.equals(k.resident()))) continue;
            over.add(new Overflow(k.resident(), k.hourMs(), e.getValue()[0], e.getValue()[1]));
        }
        over.sort(Comparator.comparingLong(Overflow::hourMs).thenComparing(Overflow::resident));
        return new HoursPage(out, over, offset, total, offset + out.size() < total, sinceHourMs,
                retainedFromHour, evictedThroughHour);
    }

    /**
     * Server thread, when a new watch list is applied: hour cells and overflow of residents no longer watched
     * are dropped; those still watched keep theirs. The detail ring is a log and keeps its entries until they
     * are overwritten.
     */
    public void retainResidents(java.util.Set<String> names) {
        boolean removed = cells.keySet().removeIf(k -> !names.contains(k.resident()));
        removed |= overflow.keySet().removeIf(k -> !names.contains(k.resident()));
        if (removed) publishMetrics();
    }

    private void count(String resident, boolean place, String dimension, int chunkX, int chunkZ, long hour,
                       String block, long nowMs) {
        Key key = new Key(resident, dimension, chunkX, chunkZ, hour);
        Acc acc = cells.get(key);
        if (acc == null) {
            if (cells.size() >= maxCells && !evictOldestEarlierHour(hour)) {
                long[] o = overflow.computeIfAbsent(new OverflowKey(resident, hour), k -> new long[2]);
                o[place ? 0 : 1]++;
                overflowChanges++;
                return;
            }
            acc = new Acc();
            acc.firstAtMs = nowMs;
            cells.put(key, acc);
        }
        acc.lastAtMs = nowMs;
        if (place) acc.placed++; else acc.broken++;
        long[] kind = acc.kinds.get(block);
        if (kind == null && acc.kinds.size() < KINDS_PER_CELL) {
            kind = new long[2];
            acc.kinds.put(block, kind);
        }
        if (kind != null) kind[place ? 0 : 1]++;
        else if (place) acc.otherPlaced++;
        else acc.otherBroken++;
    }

    private boolean evictOldestEarlierHour(long hour) {
        Iterator<Map.Entry<Key, Acc>> it = cells.entrySet().iterator();
        if (!it.hasNext()) return false;
        Map.Entry<Key, Acc> oldest = it.next();
        if (oldest.getKey().hourMs() >= hour) return false;
        evictedThroughHour = Math.max(evictedThroughHour, oldest.getKey().hourMs());
        it.remove();
        cellsEvicted++;
        return true;
    }

    private void rollHour(long hour) {
        currentHour = hour;
        long floor = hour - retentionMs + HOUR_MS;
        if (floor > retainedFromHour) {
            retainedFromHour = floor;
            cells.keySet().removeIf(k -> k.hourMs() < floor);
            overflow.keySet().removeIf(k -> k.hourMs() < floor);
        }
    }

    private static Cell cell(Key k, Acc a) {
        List<Kind> kinds = new ArrayList<>(a.kinds.size());
        for (Map.Entry<String, long[]> e : a.kinds.entrySet()) {
            kinds.add(new Kind(e.getKey(), e.getValue()[0], e.getValue()[1]));
        }
        kinds.sort(Comparator.comparingLong((Kind kind) -> kind.placed() + kind.broken()).reversed()
                .thenComparing(Kind::block));
        return new Cell(k.resident(), k.dimension(), k.chunkX(), k.chunkZ(), k.hourMs(), a.placed, a.broken, kinds,
                a.otherPlaced, a.otherBroken, a.firstAtMs, a.lastAtMs);
    }

    private void publishMetrics() {
        metrics = new Metrics(enabled, recorded, placed, broken, detailKept, detailSkipped, detail.dropped(),
                cells.size(), maxCells, cellsEvicted, overflowChanges, offThread.get(), listenerMaxTickMicros,
                listenerOverBudgetTicks, listenerTotalNanos / 1000L);
    }
}
