package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SamplerTest {

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final List<String> warnings = new ArrayList<>();

    private List<String> eventTypes(Sampler s) {
        return s.events().events().stream().map(Observations.Event::type).toList();
    }

    @Test
    void facilityReadsStayWithinTheTickBudgetAndResumeNextTick() {
        ObserverConfig config = Fixtures.config("\"tickBudgetMicros\":500,\"intervalTicks\":20,", 5);
        world.readCostNanos = 300_000; // 300 us per facility: two fit under 500 us, the third would not start
        Sampler s = Fixtures.sampler(config, world, warnings);

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
        ObserverConfig config = Fixtures.config("\"tickBudgetMicros\":50,\"intervalTicks\":1,", 5);
        world.readCostNanos = 60_000; // one facility per tick, a cycle every tick
        Sampler s = Fixtures.sampler(config, world, warnings);
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
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 0);
        Sampler s = Fixtures.sampler(config, world, warnings);
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
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 1);
        Sampler s = Fixtures.sampler(config, world, warnings);
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
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 3);
        world.throwing.add("f1");
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.onServerTick();
        List<Observations.Facility> fs = s.snapshot().facilities();
        assertEquals(Observations.FacilityStatus.OBSERVED, fs.get(0).status());
        assertEquals(Observations.FacilityStatus.ERROR, fs.get(1).status());
        assertTrue(fs.get(1).detail().contains("capability exploded"));
        assertEquals(Observations.FacilityStatus.OBSERVED, fs.get(2).status());
        assertEquals("ok", s.state(clock.ms).id());
    }

    @Test
    void repeatedTickFailuresTripTheObserverOff() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,\"failureTripCount\":3,", 1);
        Sampler s = Fixtures.sampler(config, world, warnings);
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
    }

    @Test
    void aPausedObserverReadsNothingAndSaysSo() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 2);
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.setPaused(true);
        s.onServerTick();
        s.onServerTick();
        assertTrue(world.reads.isEmpty());
        assertNull(s.snapshot());
        assertEquals("paused", s.state(clock.ms).id());
        s.setPaused(false);
        s.onServerTick();
        assertNotNull(s.snapshot());
    }

    @Test
    void aStoppedServerTickIsReportedAsStalled() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,\"stallSeconds\":10,", 0);
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.onServerTick();
        assertEquals("ok", s.state(clock.ms + 9_000).id());
        Sampler.State stalled = s.state(clock.ms + 11_000);
        assertEquals("stalled", stalled.id());
        assertTrue(stalled.detail().contains("11 s"));
    }

    @Test
    void publishedSnapshotsAreNotChangedByLaterTicks() {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 1);
        Sampler s = Fixtures.sampler(config, world, warnings);
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
        ObserverConfig config = Fixtures.config("\"intervalTicks\":20,", 0);
        Sampler s = Fixtures.sampler(config, world, warnings);
        s.onServerTick();
        long seq = s.snapshot().seq();
        for (int i = 0; i < 19; i++) {
            s.onServerTick();
        }
        assertEquals(seq, s.snapshot().seq(), "no work and no new snapshot between cycles");
        s.onServerTick();
        assertEquals(seq + 1, s.snapshot().seq());
    }
}
