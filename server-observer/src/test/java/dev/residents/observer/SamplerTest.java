package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SamplerTest {

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final List<String> warnings = new ArrayList<>();

    private List<String> eventTypes(Sampler s) {
        return s.events().events().stream().map(Observations.Event::type).toList();
    }

    private static WatchList list(String revision, WatchList.FacilitySpec... facilities) {
        return new WatchList(revision, List.of(new WatchList.ResidentSpec("Gary", Fixtures.GARY),
                new WatchList.ResidentSpec("Margo", Fixtures.MARGO)), List.of(facilities), null);
    }

    @Test
    void facilityReadsStayWithinTheTickBudgetAndResumeNextTick() {
        ObserverConfig config = Fixtures.config("\"tickBudgetMicros\":500,\"intervalTicks\":20,");
        world.readCostNanos = 300_000; // 300 us per facility: two fit under 500 us, the third would not start
        Sampler s = Fixtures.watched(config, world, warnings, 5);

        s.onServerTick();
        assertEquals(List.of("f0", "f1"), world.reads);
        s.onServerTick();
        assertEquals(List.of("f0", "f1", "f2", "f3"), world.reads);
        s.onServerTick();
        assertEquals(5, world.reads.size());
        // Pass complete: nothing more until the next cycle.
        s.onServerTick();
        assertEquals(5, world.reads.size());
        // The budget decides whether to START another read; a read that overruns is counted, not hidden.
        assertEquals(600, s.status().maxTickMicros());
        assertEquals(2, s.status().overBudgetTicks());
        assertEquals(Observations.FacilityStatus.OBSERVED, s.snapshot().facilities().get(4).status());
    }

    @Test
    void aSlowPassIsReportedAsLagNotHidden() {
        ObserverConfig config = Fixtures.config("\"tickBudgetMicros\":50,\"intervalTicks\":1,");
        world.readCostNanos = 60_000; // one facility per tick, a cycle every tick
        Sampler s = Fixtures.watched(config, world, warnings, 5);
        for (int i = 0; i < 4; i++) {
            s.onServerTick();
        }
        assertTrue(s.status().lagStreak() >= 3, "lagStreak " + s.status().lagStreak());
        assertEquals("degraded", s.state(clock.ms).id());
        // Every facility still gets read, round-robin, rather than the first one forever.
        assertEquals(List.of("f0", "f1", "f2", "f3"), world.reads);
    }

    @Test
    void residentsComeAndGoWithEventsAndLastSeenHistory() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.watched(config, world, warnings, 0);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 10, false));
        s.onServerTick();
        Observations.Resident gary = s.snapshot().residents().get(0);
        assertTrue(gary.online());
        assertNull(gary.lastSeen());
        Observations.Resident margo = s.snapshot().residents().get(1);
        assertFalse(margo.online());
        assertNull(margo.lastSeen(), "never seen this run");

        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:the_nether", 20, false));
        s.onServerTick();
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:the_nether", 20, true));
        s.onServerTick();
        world.online.remove(Fixtures.GARY);
        clock.ms += 1000;
        s.onServerTick();
        gary = s.snapshot().residents().get(0);
        assertFalse(gary.online());
        assertNull(gary.body());
        assertEquals("minecraft:the_nether", gary.lastSeen().dimension());
        assertEquals(clock.ms, gary.checkedAtMs());

        assertEquals(List.of("observer_started", "resident_online", "resident_dimension", "resident_died", "resident_offline"),
                eventTypes(s));
    }

    @Test
    void anUnloadedFacilityKeepsItsLastObservationAsHistoryOnly() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.watched(config, world, warnings, 1);
        world.contents.put("f0", Fixtures.chest("minecraft:iron_ingot", 12));
        s.onServerTick();
        long observedAt = clock.ms;
        Observations.Facility f = s.snapshot().facilities().get(0);
        assertEquals(Observations.FacilityStatus.OBSERVED, f.status());
        assertEquals(12, f.contents().items().get(0).count());

        world.status.put("f0", Observations.FacilityStatus.UNLOADED);
        clock.ms += 5000;
        s.onServerTick();
        f = s.snapshot().facilities().get(0);
        assertEquals(Observations.FacilityStatus.UNLOADED, f.status());
        assertNull(f.contents(), "unloaded never claims current stock");
        assertEquals(12, f.lastKnown().items().get(0).count());
        assertEquals(observedAt, f.lastObservedAtMs());
        assertEquals(clock.ms, f.checkedAtMs());

        // Still unloaded later: the same history, not lost and not refreshed.
        clock.ms += 5000;
        s.onServerTick();
        assertEquals(observedAt, s.snapshot().facilities().get(0).lastObservedAtMs());
        assertTrue(eventTypes(s).contains("facility_status"));
    }

    @Test
    void oneBrokenFacilityDoesNotStopTheOthersOrTheObserver() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        world.throwing.add("f1");
        Sampler s = Fixtures.watched(config, world, warnings, 3);
        s.onServerTick();
        List<Observations.Facility> fs = s.snapshot().facilities();
        assertEquals(Observations.FacilityStatus.OBSERVED, fs.get(0).status());
        assertEquals(Observations.FacilityStatus.ERROR, fs.get(1).status());
        assertTrue(fs.get(1).detail().contains("capability exploded"));
        assertEquals(Observations.FacilityStatus.OBSERVED, fs.get(2).status());
        assertEquals("ok", s.state(clock.ms).id());
    }

    @Test
    void repeatedTickFailuresTripTheObserverOff() throws Exception {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,\"failureTripCount\":3,");
        Sampler s = Fixtures.watched(config, world, warnings, 1);
        s.onServerTick();
        Observations.Snapshot good = s.snapshot();
        world.gameTimeThrows = true;
        s.onServerTick();
        assertEquals("degraded", s.state(clock.ms).id());
        s.onServerTick();
        s.onServerTick();
        assertEquals("tripped", s.state(clock.ms).id());
        world.gameTimeThrows = false;
        int reads = world.reads.size();
        s.onServerTick();
        assertEquals(reads, world.reads.size(), "a tripped observer never reads the world again");
        assertTrue(eventTypes(s).contains("observer_tripped"));
        // The last good snapshot is still served, with the tripped state beside it.
        assertEquals(good, s.snapshot());
        assertFalse(warnings.isEmpty());
        // A tripped observer takes no new watch list either.
        assertThrows(TickRequests.Unavailable.class, () -> s.offerWatch(Fixtures.watch("r2", 0)));
    }

    @Test
    void aPausedObserverReadsNothingAndSaysSoButKeepsAPushedList() throws Exception {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.watched(config, world, warnings, 2);
        s.setPaused(true);
        s.onServerTick();
        s.onServerTick();
        assertTrue(world.reads.isEmpty());
        assertNull(s.snapshot());
        assertEquals("paused", s.state(clock.ms).id());
        assertEquals("r1", s.watch().revision(), "a list pushed while paused is applied (memory only), not lost");
        CompletableFuture<WatchList> later = s.offerWatch(Fixtures.watch("r2", 1));
        s.onServerTick();
        assertEquals("r2", later.get().revision());
        assertTrue(world.reads.isEmpty());
        s.setPaused(false);
        s.onServerTick();
        assertNotNull(s.snapshot());
        assertEquals(1, s.snapshot().facilities().size());
    }

    @Test
    void aStoppedServerTickIsReportedAsStalled() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,\"stallSeconds\":10,");
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.onServerTick();
        assertEquals("ok", s.state(clock.ms + 9_000).id());
        Sampler.State stalled = s.state(clock.ms + 11_000);
        assertEquals("stalled", stalled.id());
        assertTrue(stalled.detail().contains("11 s"));
    }

    @Test
    void publishedSnapshotsAreNotChangedByLaterTicks() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.watched(config, world, warnings, 1);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        s.onServerTick();
        Observations.Snapshot first = s.snapshot();
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 99, false));
        world.status.put("f0", Observations.FacilityStatus.UNLOADED);
        s.onServerTick();
        assertEquals(1.0, first.residents().get(0).body().x());
        assertEquals(Observations.FacilityStatus.OBSERVED, first.facilities().get(0).status());
        assertTrue(s.snapshot().seq() > first.seq());
    }

    @Test
    void residentsAreReadOncePerIntervalNotEveryTick() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":20,");
        Sampler s = Fixtures.watched(config, world, warnings, 0);
        s.onServerTick();
        long seq = s.snapshot().seq();
        for (int i = 0; i < 19; i++) {
            s.onServerTick();
        }
        assertEquals(seq, s.snapshot().seq(), "no work and no new snapshot between cycles");
        s.onServerTick();
        assertEquals(seq + 1, s.snapshot().seq());
    }

    // === the watch list ===

    @Test
    void beforeCommonsPushesNothingIsWatchedAndNothingThrows() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.sampler(config, world, warnings);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        for (int i = 0; i < 5; i++) s.onServerTick();
        assertTrue(s.snapshot().residents().isEmpty());
        assertTrue(s.snapshot().facilities().isEmpty());
        assertTrue(world.reads.isEmpty());
        assertNull(s.watch().revision());
        assertNull(s.watch().appliedAtMs());
        assertEquals("ok", s.state(clock.ms).id());
        assertEquals(0, s.status().consecutiveFailures());
        assertTrue(warnings.isEmpty(), warnings.toString());
        assertNull(s.watching().residentName(Fixtures.GARY), "block listeners attribute nobody");
        assertEquals(s.bootId(), s.status().bootId());
    }

    @Test
    void aKeptFacilityKeepsItsHistoryAndFlowBaselineAndTakesANewLabel() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.offerWatch(list("a", Fixtures.facility("f0", 0), Fixtures.facility("f1", 3)));
        world.contents.put("f0", Fixtures.chest("minecraft:bread", 20));
        s.onServerTick();
        world.status.put("f0", Observations.FacilityStatus.UNLOADED);
        clock.ms += 1000;
        s.onServerTick();
        long observedAt = s.snapshot().facilities().get(0).lastObservedAtMs();

        WatchList.FacilitySpec relabelled = new WatchList.FacilitySpec("f0", "Pantry", Fixtures.OVERWORLD, 0, 64, 0, null);
        s.offerWatch(list("b", relabelled));
        world.status.remove("f0");
        world.contents.put("f0", Fixtures.chest("minecraft:bread", 12));
        clock.ms += 1000;
        s.onServerTick();
        Observations.Facility f = s.snapshot().facilities().get(0);
        assertEquals("Pantry", f.spec().label());
        assertEquals(1, s.snapshot().facilities().size(), "f1 was dropped");
        assertEquals(Observations.FacilityStatus.OBSERVED, f.status());
        Flows.Flow flow = s.flows().entries().get(0).value();
        assertEquals(observedAt, flow.sinceMs(), "the baseline from before the push is still the 'before'");
        assertEquals(20, flow.deltas().get(0).before());
        assertEquals(12, flow.deltas().get(0).after());
    }

    @Test
    void aMovedFacilityStartsOverAndNoFlowSpansTheMove() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.offerWatch(list("a", Fixtures.facility("f0", 0)));
        world.contents.put("f0", Fixtures.chest("minecraft:bread", 20));
        s.onServerTick();
        s.offerWatch(list("b", new WatchList.FacilitySpec("f0", "f0", "minecraft:the_nether", 0, 64, 0, null)));
        world.contents.put("f0", Fixtures.chest("minecraft:bread", 5));
        s.onServerTick();
        Observations.Facility f = s.snapshot().facilities().get(0);
        assertEquals("minecraft:the_nether", f.spec().dimension());
        assertNull(f.lastKnown());
        assertEquals(0, s.flows().entries().size(), "two different containers are never diffed");
    }

    @Test
    void removingAResidentDropsItsObservationAndHourCellsButKeepsTheOthers() throws Exception {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,");
        Sampler s = Fixtures.watched(config, world, warnings, 0);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        world.online.put(Fixtures.MARGO, Fixtures.body(clock.ms, "minecraft:overworld", 2, false));
        s.onServerTick();
        s.blocks().record("Gary", true, Fixtures.OVERWORLD, 0, 64, 0, "minecraft:dirt", clock.ms, 1);
        s.blocks().record("Margo", true, Fixtures.OVERWORLD, 0, 64, 0, "minecraft:dirt", clock.ms, 1);
        world.online.remove(Fixtures.MARGO);
        s.onServerTick();

        CompletableFuture<WatchList> applied = s.offerWatch(new WatchList("only-margo",
                List.of(new WatchList.ResidentSpec("Margo", Fixtures.MARGO)), List.of(), null));
        s.onServerTick();
        assertEquals("only-margo", applied.get().revision());
        assertEquals(clock.ms, applied.get().appliedAtMs());
        assertEquals(List.of("Margo"), s.blocks().hours(0, null, 0, 10).cells().stream().map(BlockLog.Cell::resident).toList());
        Observations.Resident margo = s.snapshot().residents().get(0);
        assertEquals(1, s.snapshot().residents().size());
        assertEquals(2.0, margo.lastSeen().x(), "a kept resident keeps its last-seen body");
        assertNull(s.watching().residentName(Fixtures.GARY));
        assertEquals("Margo", s.watching().residentName(Fixtures.MARGO));
    }

    @Test
    void aListStillWaitingIsSupersededByANewerOne() throws Exception {
        Sampler s = Fixtures.sampler(Fixtures.config(""), world, warnings);
        CompletableFuture<WatchList> first = s.offerWatch(Fixtures.watch("one", 1));
        CompletableFuture<WatchList> second = s.offerWatch(Fixtures.watch("two", 2));
        s.onServerTick();
        ExecutionException e = assertThrows(ExecutionException.class, first::get);
        assertEquals("superseded", ((TickRequests.Unavailable) e.getCause()).code);
        assertEquals("two", second.get().revision());
        assertEquals(2, s.snapshot().facilities().size());
        s.stop();
        assertThrows(TickRequests.Unavailable.class, () -> s.offerWatch(Fixtures.watch("three", 0)));
    }

    /**
     * The list is replaced while ticks run on another thread, as on a live server: every published snapshot must
     * belong to exactly one pushed list (never half of two), every push must end applied or superseded, and no
     * tick may fail.
     */
    @Test
    void replacingTheListUnderConcurrentTicksNeverMixesTwoLists() throws Exception {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,\"tickBudgetMicros\":5000,");
        Fixtures.FakeWorld w = new Fixtures.FakeWorld(new Fixtures.Clock());
        Sampler s = new Sampler(config, w, w, new EventLog(config.eventCapacity()), System::nanoTime,
                System::currentTimeMillis, warnings::add);
        java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean();
        List<String> mixed = java.util.Collections.synchronizedList(new ArrayList<>());
        Thread ticker = new Thread(() -> {
            while (!done.get()) {
                s.onServerTick();
                java.util.concurrent.locks.LockSupport.parkNanos(20_000);
            }
        }, "test-server-tick");
        Thread reader = new Thread(() -> {
            while (!done.get()) {
                Observations.Snapshot snap = s.snapshot();
                if (snap == null || snap.facilities().isEmpty()) continue;
                String family = snap.facilities().get(0).spec().id().split("-")[0];
                for (Observations.Facility f : snap.facilities()) {
                    if (!f.spec().id().startsWith(family + "-")) mixed.add(snap.seq() + ": " + f.spec().id());
                }
                if (snap.facilities().size() != Integer.parseInt(family.substring(1)) % 7 + 1) mixed.add("size " + family);
            }
        }, "test-reader");
        ticker.start();
        reader.start();
        List<CompletableFuture<WatchList>> pushes = new ArrayList<>();
        try {
            for (int k = 0; k < 300; k++) {
                List<WatchList.FacilitySpec> fs = new ArrayList<>();
                for (int j = 0; j <= k % 7; j++) fs.add(new WatchList.FacilitySpec("r" + k + "-" + j, "x", Fixtures.OVERWORLD, j * 3, 64, k, null));
                pushes.add(s.offerWatch(new WatchList("r" + k, List.of(new WatchList.ResidentSpec("Gary", Fixtures.GARY)), fs, null)));
                if (k % 10 == 0) Thread.sleep(1);
            }
            WatchList last = pushes.get(pushes.size() - 1).get(5, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals("r299", last.revision());
        } finally {
            done.set(true);
            ticker.join(5000);
            reader.join(5000);
        }
        int applied = 0;
        for (CompletableFuture<WatchList> p : pushes) {
            assertTrue(p.isDone(), "every push ends applied or superseded");
            try {
                p.get();
                applied++;
            } catch (ExecutionException e) {
                assertEquals("superseded", ((TickRequests.Unavailable) e.getCause()).code);
            }
        }
        assertTrue(applied >= 1);
        assertTrue(mixed.isEmpty(), mixed.toString());
        assertEquals("r299", s.watch().revision());
        assertEquals(0, s.status().consecutiveFailures());
        assertTrue(warnings.isEmpty(), warnings.toString());
    }
}
