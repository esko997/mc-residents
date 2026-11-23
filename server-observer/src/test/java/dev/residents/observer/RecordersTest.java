package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Pure recorder pieces: the sequence ring, block aggregation under bursts, flow diffs, the rate limiter. */
class RecordersTest {

    private static final long HOUR = BlockLog.HOUR_MS;
    private static final long T0 = 1_700_000_000_000L - (1_700_000_000_000L % HOUR); // an hour boundary

    // === SeqRing ===

    @Test
    void ringPagesByCursorAndReportsGapsAfterOverwrite() {
        SeqRing<String> ring = new SeqRing<>(4);
        for (String s : List.of("a", "b", "c")) ring.append(s);
        assertEquals(0, ring.view().latestSeq(), "nothing is visible before publish");
        ring.publish();
        SeqRing.Page<String> page = SeqRing.page(ring.view(), 1, 10, s -> true);
        assertEquals(List.of(2L, 3L), page.entries().stream().map(SeqRing.Entry::seq).toList());
        assertFalse(page.gap());
        assertEquals(3, page.nextAfter());

        for (String s : List.of("d", "e", "f")) ring.append(s); // a, b dropped
        ring.publish();
        SeqRing.Page<String> late = SeqRing.page(ring.view(), 1, 10, s -> true);
        assertTrue(late.gap());
        assertEquals(List.of("c", "d", "e", "f"), late.entries().stream().map(SeqRing.Entry::value).toList());
        assertEquals(2, ring.view().dropped());

        SeqRing.Page<String> full = SeqRing.page(ring.view(), 0, 2, s -> true);
        assertEquals(4, full.nextAfter(), "a full page resumes after its last entry");
        SeqRing.Page<String> filtered = SeqRing.page(ring.view(), 2, 10, s -> s.equals("never"));
        assertEquals(6, filtered.nextAfter(), "invisible entries still advance the cursor");
        assertEquals(6, SeqRing.page(ring.view(), 500, 10, s -> true).nextAfter(), "a cursor from an earlier run resets");
    }

    // === BlockLog ===

    private static BlockLog log(int detailPerTick, int maxCells) {
        return new BlockLog(true, 64, detailPerTick, maxCells, 48, 500);
    }

    @Test
    void aBurstIsCountedCompletelyWhileDetailIsCappedPerTick() {
        BlockLog log = log(4, 1024);
        for (int i = 0; i < 300; i++) log.record("Gary", false, "minecraft:overworld", i % 16, 60, 0, "minecraft:stone", T0 + i, 10);
        log.endTick(T0 + 300);
        BlockLog.HoursPage hours = log.hours(0, null, 0, 100);
        assertEquals(1, hours.cells().size());
        assertEquals(300, hours.cells().get(0).broken(), "the hour cell counts every change");
        assertEquals(4, log.detail().latestSeq(), "only the per-tick detail cap is kept");
        assertEquals(296, log.metrics().detailSkipped());
        // The next tick gets a fresh detail allowance.
        log.record("Gary", true, "minecraft:overworld", 0, 61, 0, "minecraft:dirt", T0 + 400, 11);
        log.endTick(T0 + 400);
        assertEquals(5, log.detail().latestSeq());
        assertEquals("place", log.detail().entries().get(4).value().action());
    }

    @Test
    void detailStopsWhenTheTickListenerBudgetIsSpent() {
        BlockLog log = log(100, 1024);
        log.record("Gary", true, "minecraft:overworld", 0, 64, 0, "minecraft:dirt", T0, 1);
        log.addListenerNanos(600_000); // 600 us > 500 us budget
        log.record("Gary", true, "minecraft:overworld", 1, 64, 0, "minecraft:dirt", T0, 1);
        log.endTick(T0);
        assertEquals(1, log.detail().latestSeq());
        assertEquals(2, log.hours(0, null, 0, 10).cells().get(0).placed());
        assertEquals(1, log.metrics().listenerOverBudgetTicks());
        assertEquals(600, log.metrics().listenerMaxTickMicros());
    }

    @Test
    void cellsSplitByResidentChunkAndHourAndKeepEightBlockKinds() {
        BlockLog log = log(100, 1024);
        log.record("Gary", true, "minecraft:overworld", 15, 64, -1, "minecraft:a", T0, 1);
        log.record("Gary", true, "minecraft:overworld", 16, 64, -1, "minecraft:a", T0, 1);   // next chunk
        log.record("Margo", true, "minecraft:overworld", 15, 64, -1, "minecraft:a", T0, 1);  // other resident
        log.record("Gary", true, "minecraft:overworld", 15, 64, -1, "minecraft:a", T0 + HOUR, 1); // next hour
        for (int k = 0; k < 10; k++) log.record("Gary", k % 2 == 0, "minecraft:the_nether", 0, 64, 0, "mod:b" + k, T0, 1);
        log.endTick(T0 + HOUR);
        List<BlockLog.Cell> cells = log.hours(0, null, 0, 100).cells();
        assertEquals(5, cells.size());
        BlockLog.Cell first = cells.get(0);
        assertEquals(0, first.chunkX());
        assertEquals(-1, first.chunkZ(), "negative coordinates floor to chunk -1");
        BlockLog.Cell nether = cells.stream().filter(c -> c.dimension().equals("minecraft:the_nether")).findFirst().orElseThrow();
        assertEquals(BlockLog.KINDS_PER_CELL, nether.kinds().size());
        assertEquals(2, nether.otherPlaced() + nether.otherBroken());
        assertEquals(5, nether.placed());
        assertEquals(List.of("Margo"), log.hours(0, "Margo", 0, 100).cells().stream().map(BlockLog.Cell::resident).toList());
        assertEquals(1, log.hours(T0 + HOUR, null, 0, 100).cells().size(), "sinceHour filters older cells");
        BlockLog.HoursPage paged = log.hours(0, null, 1, 2);
        assertEquals(2, paged.cells().size());
        assertTrue(paged.more());
        assertEquals(5, paged.total());
    }

    @Test
    void aFullTableEvictsEarlierHoursThenCountsOverflowWithoutPositions() {
        BlockLog log = log(100, 2);
        log.record("Gary", true, "minecraft:overworld", 0, 64, 0, "minecraft:a", T0, 1);
        log.record("Gary", true, "minecraft:overworld", 16, 64, 0, "minecraft:a", T0 + HOUR, 1);
        log.record("Gary", true, "minecraft:overworld", 32, 64, 0, "minecraft:a", T0 + HOUR, 1); // evicts the T0 cell
        log.record("Gary", false, "minecraft:overworld", 48, 64, 0, "minecraft:a", T0 + HOUR, 1); // all current: overflow
        log.endTick(T0 + HOUR);
        BlockLog.HoursPage page = log.hours(0, null, 0, 10);
        assertEquals(2, page.cells().size());
        assertEquals(T0, page.evictedThroughHourMs());
        assertEquals(List.of(new BlockLog.Overflow("Gary", T0 + HOUR, 0, 1)), page.overflow());
        assertEquals(1, log.metrics().cellsEvicted());
        assertEquals(1, log.metrics().overflowChanges());
        assertEquals(4, log.metrics().recorded(), "nothing vanishes without being counted somewhere");
    }

    @Test
    void oldHoursAgeOutAndADisabledLogRecordsNothing() {
        BlockLog log = new BlockLog(true, 64, 10, 100, 2, 500);
        log.record("Gary", true, "minecraft:overworld", 0, 64, 0, "minecraft:a", T0, 1);
        log.endTick(T0 + 2 * HOUR);
        BlockLog.HoursPage page = log.hours(0, null, 0, 10);
        assertTrue(page.cells().isEmpty());
        assertEquals(T0 + HOUR, page.retainedFromHourMs());

        BlockLog off = new BlockLog(false, 64, 10, 100, 2, 500);
        off.record("Gary", true, "minecraft:overworld", 0, 64, 0, "minecraft:a", T0, 1);
        off.endTick(T0);
        assertEquals(0, off.metrics().recorded());
        assertFalse(off.enabled());
    }

    @Test
    void listenerTimeCountsInTheSamplersTickBudgetMetrics() {
        Fixtures.Clock clock = new Fixtures.Clock();
        Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
        Sampler s = Fixtures.watched(Fixtures.config("\"tickBudgetMicros\":500,\"intervalTicks\":1,"), world, new java.util.ArrayList<>(), 1);
        world.readCostNanos = 200_000; // the facility read: 200 us of the tick itself
        s.onServerTick();
        assertEquals(200, s.status().maxTickMicros());
        assertEquals(0, s.status().overBudgetTicks());

        // Between ticks, residents' block events cost 400 us of listener time on the server thread.
        s.blocks().record("Gary", true, "minecraft:overworld", 0, 64, 0, "minecraft:dirt", clock.ms, 1);
        s.blocks().addListenerNanos(400_000);
        s.onServerTick();
        assertEquals(600, s.status().lastTickMicros(), "sampler work plus listener time, measured after publication");
        assertEquals(1, s.status().overBudgetTicks());
        assertEquals(400, s.blocks().metrics().listenerMaxTickMicros());

        s.onServerTick(); // listener time belongs to one tick only
        assertEquals(200, s.status().lastTickMicros());
        assertEquals(1, s.status().overBudgetTicks());
    }

    // === Flows ===

    private static final WatchList.FacilitySpec CHEST =
            new WatchList.FacilitySpec("pantry", "Pantry", "minecraft:overworld", 10, 64, 10, null);

    private static Observations.Contents contents(boolean truncated, Observations.ItemCount... items) {
        return new Observations.Contents("minecraft:chest", 27, items.length, false, List.of(items), truncated, null, List.of(), 3);
    }

    @Test
    void aFlowNamesWhatWentInAndOutAndWhoWasNearAsEvidence() {
        Observations.Contents before = contents(false, new Observations.ItemCount("minecraft:bread", 20, 0),
                new Observations.ItemCount("minecraft:coal", 5, 0));
        Observations.Contents after = contents(false, new Observations.ItemCount("minecraft:bread", 12, 0),
                new Observations.ItemCount("minecraft:iron_ingot", 3, 0), new Observations.ItemCount("minecraft:coal", 5, 0));
        List<Flows.Candidate> near = List.of(
                new Flows.Candidate("Margo", "minecraft:overworld", 13, 64, 10, "now"),
                new Flows.Candidate("Gary", "minecraft:overworld", 11, 64, 10, "previous"),
                new Flows.Candidate("Gary", "minecraft:overworld", 30, 64, 10, "now"),
                new Flows.Candidate("Wren", "minecraft:the_nether", 10, 64, 10, "now"),
                new Flows.Candidate("Tobin", "minecraft:overworld", 40, 64, 10, "now"));
        Flows.Flow flow = Flows.diff(CHEST, before, 1000, true, after, 2000, 7, near, 8, 64);
        assertEquals(List.of(new Flows.Delta("minecraft:bread", 20, 12, 0, 0), new Flows.Delta("minecraft:iron_ingot", 0, 3, 0, 0)),
                flow.deltas());
        assertEquals(Flows.NEAREST, flow.attribution());
        assertEquals("Gary", flow.resident());
        assertEquals(List.of("Gary", "Margo"), flow.nearby().stream().map(Flows.Nearby::resident).toList(),
                "nearest first; out of reach and other dimensions are not candidates");
        assertEquals("previous", flow.nearby().get(0).when());
        assertEquals(1000, flow.sinceMs());
        assertTrue(flow.uncertain().isEmpty());
    }

    @Test
    void unchangedStockIsNoFlowAndIncompleteObservationsAreLabelled() {
        Observations.Contents same = contents(false, new Observations.ItemCount("minecraft:bread", 20, 0));
        assertNull(Flows.diff(CHEST, same, 1, true, same, 2, 1, List.of(), 8, 64));

        Observations.Contents truncated = contents(true, new Observations.ItemCount("minecraft:bread", 19, 1));
        Flows.Flow flow = Flows.diff(CHEST, same, 1, false, truncated, 2, 1, List.of(), 8, 64);
        assertEquals(Flows.NOBODY, flow.attribution());
        assertNull(flow.resident());
        assertTrue(flow.uncertain().containsAll(List.of("item_kinds_truncated", "observation_gap")));

        Observations.Contents nbt = contents(false, new Observations.ItemCount("minecraft:bread", 20, 1));
        assertTrue(Flows.diff(CHEST, same, 1, true, nbt, 2, 1, List.of(), 8, 64).uncertain().contains("nbt_only_change"));

        Observations.Contents many = contents(false, new Observations.ItemCount("a:1", 1, 0),
                new Observations.ItemCount("a:2", 1, 0), new Observations.ItemCount("a:3", 1, 0));
        Flows.Flow capped = Flows.diff(CHEST, contents(false), 1, true, many, 2, 1, List.of(), 8, 2);
        assertEquals(2, capped.deltas().size());
        assertTrue(capped.deltasTruncated());
    }

    // === RateLimiter ===

    @Test
    void theRateLimitIsAPerConsumerTokenBucket() {
        long[] now = {0};
        RateLimiter limiter = new RateLimiter(60, 5, () -> now[0]);
        assertEquals(0, limiter.acquire("commons", 3));
        assertEquals(0, limiter.acquire("commons", 2));
        long wait = limiter.acquire("commons", 3);
        assertEquals(3, wait, "60/min refills one token per second");
        assertEquals(0, limiter.acquire("caretaker", 5), "buckets are per consumer");
        now[0] += 3_000_000_000L;
        assertEquals(0, limiter.acquire("commons", 3));
        now[0] += 3_600_000_000_000L;
        assertEquals(0, limiter.acquire("commons", 5));
        assertTrue(limiter.acquire("commons", 1) > 0, "refill never exceeds the burst");
        assertEquals(0, new RateLimiter(60, 2, () -> 0).acquire("x", 3), "a cost above the burst is charged as the burst");
    }
}
