package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shelf scan: only on demand, bounded per unit and per tick, safe when chunks or levels go away, finishing
 * dense chunks over several slices, usable even when a pass is slow, capped and labelled when cut.
 */
class ShelfScanTest {

    private static final String NETHER = "minecraft:the_nether";
    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final List<String> warnings = new ArrayList<>();

    /** {@code n} chunks in a row along x, a shelf in each holding one book, plus a bookless lectern in chunk 0. */
    private void library(String dimension, int n) {
        for (int i = 0; i < n; i++) {
            world.addHolder(dimension, i * 16 + 3, 64, 5, Fixtures.shelf(Fixtures.written(0, "Book " + i, "page")));
        }
        world.addHolder(dimension, 1, 64, 1, Fixtures.lectern());
    }

    private Sampler sampler(String extra) {
        return Fixtures.sampler(Fixtures.config("\"intervalTicks\":1," + extra), world, warnings);
    }

    private void tickUntilScanned(Sampler s, int maxTicks) {
        for (int i = 0; i < maxTicks && s.shelves().fresh(clock.ms) == null; i++) s.onServerTick();
    }

    @Test
    void withoutADiscoveryRequestNothingIsScanned() {
        library(Fixtures.OVERWORLD, 5);
        Sampler s = sampler("");
        for (int i = 0; i < 50; i++) s.onServerTick();
        assertEquals(0, world.chunksRead);
        assertEquals(0, s.shelves().metrics().scans());
    }

    @Test
    void aScanIsSpreadOverTicksWithinTheBudgetAndListsEveryShelfInOrder() {
        library(Fixtures.OVERWORLD, 40);
        library(NETHER, 3);
        world.chunkCostNanos = 100_000; // a block-entity slice: 100 us
        world.placeCostNanos = 100_000; // reading one shelf's books: 100 us
        Sampler s = sampler("\"tickBudgetMicros\":500,");
        s.shelves().demand(clock.ms);
        int ticks = 0;
        while (s.shelves().fresh(clock.ms) == null && ticks < 400) {
            s.onServerTick();
            ticks++;
            assertTrue(s.status().lastTickMicros() <= 500 + 100, "a tick overruns by at most one unit: " + s.status().lastTickMicros());
        }
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertNotNull(index);
        assertTrue(ticks >= (43 + 45) / 5, "spread over ticks, not one: " + ticks);
        assertEquals(43, index.items().size(), "every shelf; the bookless lecterns are not listed");
        assertFalse(index.truncated());
        List<Library.Item> sorted = new ArrayList<>(index.items());
        sorted.sort(Library.ORDER);
        assertEquals(sorted, index.items());
        assertEquals(Fixtures.OVERWORLD, index.items().get(0).dimension());
        assertEquals(NETHER, index.items().get(42).dimension());
        ShelfScan.Metrics m = s.shelves().metrics();
        assertEquals(1, m.scans());
        assertEquals(2, m.lastLevels());
        assertEquals(40 + 3, m.lastChunks(), "one slice per small chunk, never per block");
        assertEquals(43 + 2, m.lastHolders(), "each shelf and lectern read once, in its own unit");
        assertTrue(m.lastTicks() > 1);
        assertTrue(m.lastMaxUnitMicros() <= 100, "no unit costs more than one slice or one holder: " + m.lastMaxUnitMicros());
        assertEquals(0, s.status().consecutiveFailures());
    }

    /**
     * Regression: a pass that takes longer than 30 s must still produce a usable result once it finishes, and the
     * result must keep each holder's real read time (nothing old is presented as new).
     */
    @Test
    void aScanSlowerThanThirtySecondsIsStillServedWithItsRealReadTimes() {
        library(Fixtures.OVERWORLD, 60);
        world.chunkCostNanos = 300_000;
        world.placeCostNanos = 300_000; // two units per tick at a 500 us budget
        Sampler s = sampler("\"tickBudgetMicros\":500,");
        long began = clock.ms;
        s.shelves().demand(began);
        int ticks = 0;
        while (s.shelves().metrics().scans() == 0 && ticks < 1000) {
            s.onServerTick();
            clock.ms += 1000; // a second per tick: the pass spans about a minute
            ticks++;
        }
        long now = clock.ms;
        ShelfScan.Index index = s.shelves().fresh(now);
        assertNotNull(index, "a slow pass must not be thrown away on completion");
        assertTrue(index.completedAtMs() - index.scannedAtMs() > ShelfScan.MAX_AGE_MS, "the pass really was slow");
        assertEquals(began, index.scannedAtMs(), "scannedAtMs stays the start of the pass");
        Library.Item first = index.items().get(0), last = index.items().get(index.items().size() - 1);
        assertTrue(first.observedAtMs() < last.observedAtMs(), "each item carries its own read time");
        assertTrue(first.observedAtMs() < index.completedAtMs() - ShelfScan.MAX_AGE_MS,
                "an early item keeps its early read time, not the completion time");
        assertEquals(60, index.items().size());

        // Served for 30 s after completion, then not.
        assertNotNull(s.shelves().fresh(index.completedAtMs() + ShelfScan.MAX_AGE_MS));
        assertNull(s.shelves().fresh(index.completedAtMs() + ShelfScan.MAX_AGE_MS + 1));
    }

    @Test
    void aDenseChunkIsFinishedOverSeveralSlicesNotSkipped() {
        for (int i = 0; i < 5000; i++) world.addOther(Fixtures.OVERWORLD, i % 16, i / 256, (i / 16) % 16);
        for (int i = 0; i < 3; i++) {
            world.addHolder(Fixtures.OVERWORLD, i, 100, 0, Fixtures.shelf(Fixtures.written(0, "Late " + i, "p")));
        }
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertEquals(3, index.items().size(), "the shelves after the first 4,096 block entities are found");
        assertFalse(index.truncated());
        assertEquals((5003 + ShelfScan.BLOCK_ENTITIES_PER_SLICE - 1) / ShelfScan.BLOCK_ENTITIES_PER_SLICE, world.slices);
        assertTrue(world.largestSlice <= ShelfScan.BLOCK_ENTITIES_PER_SLICE);
        assertEquals(5003, s.shelves().metrics().lastBlockEntities());
        assertEquals(1, s.shelves().metrics().lastChunks());
    }

    private static BridgeAccess.Place fullShelf() {
        BridgeAccess.Slot[] slots = new BridgeAccess.Slot[6];
        for (int i = 0; i < 6; i++) slots[i] = Fixtures.written(i, "Volume " + i, "page");
        return Fixtures.shelf(slots);
    }

    @Test
    void aShelfOfNewBooksTakesOneUnitPerBookAndIsFreeToRescanWhileUnchanged() {
        world.addHolder(Fixtures.OVERWORLD, 3, 64, 3, fullShelf());
        world.bookCostNanos = 400_000; // one book: 400 us
        Sampler s = sampler("\"tickBudgetMicros\":500,");
        s.shelves().demand(clock.ms);
        for (int i = 0; i < 100 && s.shelves().metrics().scans() == 0; i++) {
            s.onServerTick();
            assertTrue(s.status().lastTickMicros() <= 500 + 400, "at most one book past the budget: " + s.status().lastTickMicros());
        }
        ShelfScan.Index first = s.shelves().fresh(clock.ms);
        assertEquals(6, first.items().get(0).slots().size(), "published only once every slot was read, all six together");
        assertEquals(6, world.bookDecodes);
        assertEquals(6, s.shelves().metrics().lastHolderUnits());
        assertEquals(1, s.shelves().metrics().lastHolders());

        clock.ms += ShelfScan.REFRESH_MS;
        s.shelves().demand(clock.ms);
        for (int i = 0; i < 100 && s.shelves().metrics().scans() == 1; i++) s.onServerTick();
        assertEquals(6, world.bookDecodes, "unchanged books are not decoded again");
        assertEquals(1, s.shelves().metrics().lastHolderUnits());
        assertEquals(first.items().get(0).slots(), s.shelves().fresh(clock.ms).items().get(0).slots());
    }

    @Test
    void aShelfWhoseBooksKeepChangingStillFinishes() {
        world.addHolder(Fixtures.OVERWORLD, 3, 64, 3, fullShelf());
        world.booksAlwaysNew = true;
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        assertEquals(6, s.shelves().fresh(clock.ms).items().get(0).slots().size());
        assertEquals(ShelfScan.MAX_VISITS, s.shelves().metrics().lastHolderUnits(), "bounded: all remaining books on the last visit");
    }

    @Test
    void chunksAndLevelsThatGoAwayMidScanAreSkippedNotErrors() {
        library(Fixtures.OVERWORLD, 6);
        library(NETHER, 2);
        world.unloadBeforeRead.add(Positions.chunkKey(2, 0));
        world.unloadBeforeRead.add(Positions.chunkKey(4, 0));
        world.levelGoneAfterListing.add(NETHER);
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertEquals(4, index.items().size());
        assertFalse(index.truncated(), "an unloaded chunk is simply not loaded; nothing was cut");
        assertEquals(2, s.shelves().metrics().lastChunksGone());
        assertEquals(0, s.shelves().metrics().errors());
        assertTrue(warnings.isEmpty(), warnings.toString());
    }

    @Test
    void aChunkUnloadingBetweenItsSlicesCutsTheList() {
        for (int i = 0; i < 2000; i++) world.addOther(Fixtures.OVERWORLD, i % 16, i / 256, (i / 16) % 16);
        world.addHolder(Fixtures.OVERWORLD, 3, 100, 3, Fixtures.shelf());
        world.unloadAfterFirstSlice.add(Positions.chunkKey(0, 0));
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertTrue(index.truncated(), "part of that chunk was never seen");
        assertTrue(index.items().isEmpty());
    }

    @Test
    void aChunkThatThrowsIsSkippedAndTheListSaysItWasCut() {
        library(Fixtures.OVERWORLD, 4);
        world.holdersThrow.add(Positions.chunkKey(1, 0));
        Sampler s = sampler("\"failureTripCount\":1,");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertEquals(3, index.items().size());
        assertTrue(index.truncated());
        assertEquals(1, s.shelves().metrics().errors());
        assertTrue(s.shelves().metrics().lastError().contains("exploded"));
        assertEquals("ok", s.state(clock.ms).id(), "contained: the observer neither failed a tick nor tripped");
    }

    @Test
    void theChunkListCapCutsTheListAndSaysSo() {
        library(Fixtures.OVERWORLD, 10);
        world.chunkListCap = 4;
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        assertTrue(s.shelves().fresh(clock.ms).truncated());
        assertEquals(4, world.chunksRead);
    }

    @Test
    void theItemCapStopsTheScanWithWhatFits() {
        for (int i = 0; i < ShelfScan.MAX_ITEMS + 10; i++) {
            world.addHolder(Fixtures.OVERWORLD, (i % 64) * 16, 64, (i / 64) * 16, Fixtures.shelf());
        }
        Sampler s = sampler("\"tickBudgetMicros\":5000,");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 10_000);
        ShelfScan.Index index = s.shelves().fresh(clock.ms);
        assertEquals(ShelfScan.MAX_ITEMS, index.items().size());
        assertTrue(index.truncated());
    }

    @Test
    void aScanIsServedForThirtySecondsAndRefreshedWhileRequestsContinue() {
        library(Fixtures.OVERWORLD, 3);
        Sampler s = sampler("");
        s.shelves().demand(clock.ms);
        tickUntilScanned(s, 100);
        ShelfScan.Index done = s.shelves().fresh(clock.ms);
        assertEquals(clock.ms, done.completedAtMs());

        clock.ms += ShelfScan.MAX_AGE_MS;
        assertNotNull(s.shelves().fresh(clock.ms), "30 s after completion it is still served");
        clock.ms += 1;
        assertNull(s.shelves().fresh(clock.ms), "later it is not");

        // Requests keep coming: a new scan starts REFRESH_MS after the last one finished, so one is ready in time.
        Sampler t = sampler("");
        t.shelves().demand(clock.ms);
        tickUntilScanned(t, 100);
        long first = t.shelves().fresh(clock.ms).completedAtMs();
        clock.ms += ShelfScan.REFRESH_MS;
        t.shelves().demand(clock.ms);
        for (int i = 0; i < 100; i++) t.onServerTick();
        assertEquals(clock.ms, t.shelves().fresh(clock.ms).completedAtMs());
        assertTrue(t.shelves().fresh(clock.ms).completedAtMs() > first);

        // Requests stop: after DEMAND_MS no more scans.
        long scans = t.shelves().metrics().scans();
        clock.ms += ShelfScan.DEMAND_MS + 1;
        for (int i = 0; i < 100; i++) t.onServerTick();
        assertEquals(scans, t.shelves().metrics().scans());
    }

    @Test
    void aPausedObserverDoesNotScan() {
        library(Fixtures.OVERWORLD, 3);
        Sampler s = sampler("");
        s.setPaused(true);
        s.shelves().demand(clock.ms);
        for (int i = 0; i < 20; i++) s.onServerTick();
        assertEquals(0, world.chunksRead);
    }
}
