package dev.residents.observer;

import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class TickRequestsTest {
    private static final WatchList.ResidentSpec GARY = new WatchList.ResidentSpec("Gary", Fixtures.GARY);
    private static final WatchList.ResidentSpec MARGO = new WatchList.ResidentSpec("Margo", Fixtures.MARGO);

    @Test
    void enqueuingDoesNotReadAndOnlyOneRequestRunsPerTick() throws Exception {
        Fixtures.Clock clock = new Fixtures.Clock();
        Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
        ObserverConfig config = Fixtures.config("");
        Sampler sampler = Fixtures.sampler(config, world, new ArrayList<>());
        world.sightResult = new BridgeAccess.Sight(false, 12.0, "blocked");
        var first = sampler.request(b -> b.sight(GARY, MARGO));
        var second = sampler.request(b -> b.sight(GARY, MARGO));
        assertEquals(0, world.bridgeReads);
        assertFalse(first.result.isDone());
        sampler.onServerTick();
        assertEquals(false, first.result.join().visible());
        assertEquals(Thread.currentThread(), world.bridgeThread);
        assertFalse(second.result.isDone());
        sampler.onServerTick();
        assertEquals("blocked", second.result.join().reason());
        assertEquals(2, world.bridgeReads);
    }

    @Test
    void queueFullCancellationAndExpiryNeverTriggerLateWorldReads() {
        long[] nanos = {0};
        TickRequests requests = new TickRequests(1, 100, () -> nanos[0]);
        AtomicInteger reads = new AtomicInteger();
        var first = requests.submit(b -> reads.incrementAndGet());
        assertEquals("busy", assertThrows(TickRequests.Unavailable.class,
                () -> requests.submit(b -> reads.incrementAndGet())).code);
        first.cancel();
        var expired = requests.submit(b -> reads.incrementAndGet());
        nanos[0] = 100_000_000;
        requests.runOne(requests.next(), null);
        CompletionException failure = assertThrows(CompletionException.class, expired.result::join);
        assertEquals("timeout", ((TickRequests.Unavailable) failure.getCause()).code);
        assertEquals(0, reads.get());
        requests.close();
        assertEquals("stopped", assertThrows(TickRequests.Unavailable.class,
                () -> requests.submit(b -> 1)).code);
    }

    @Test
    void arrivalsAfterTickEntryCannotRunInThatTick() {
        TickRequests requests = new TickRequests(2, 100, () -> 0);
        AtomicInteger reads = new AtomicInteger();
        var eligible = requests.next();
        var later = requests.submit(b -> reads.incrementAndGet());
        requests.runOne(eligible, null);
        assertFalse(later.result.isDone());
        requests.runOne(requests.next(), null);
        assertEquals(1, later.result.join());
        var cancelled = requests.submit(b -> reads.incrementAndGet());
        eligible = requests.next();
        cancelled.cancel();
        var replacement = requests.submit(b -> reads.incrementAndGet());
        requests.runOne(eligible, null);
        assertFalse(replacement.result.isDone(), "cancellation must not promote a later arrival into this tick");
    }

    @Test
    void pauseAndTripRejectPendingRequestsWithoutReading() {
        Fixtures.Clock clock = new Fixtures.Clock();
        Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
        ObserverConfig config = Fixtures.config("\"failureTripCount\":1,");
        Sampler sampler = Fixtures.sampler(config, world, new ArrayList<>());
        var pending = sampler.request(b -> b.sight(GARY, MARGO));
        sampler.setPaused(true);
        sampler.onServerTick();
        assertThrows(CompletionException.class, pending.result::join);
        assertEquals(0, world.bridgeReads);
        assertEquals("paused", assertThrows(TickRequests.Unavailable.class,
                () -> sampler.request(b -> 1)).code);
        sampler.setPaused(false);
        world.bridgeThrows = true;
        var failing = sampler.request(b -> b.sight(GARY, MARGO));
        sampler.onServerTick();
        assertThrows(CompletionException.class, failing.result::join);
        assertTrue(sampler.status().tripped());
        assertEquals("tripped", assertThrows(TickRequests.Unavailable.class,
                () -> sampler.request(b -> 1)).code);
    }

    @Test
    void aBridgeReadOverrunIsCountedAndFacilitiesWaitForAnotherTick() {
        Fixtures.Clock clock = new Fixtures.Clock();
        Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
        ObserverConfig config = Fixtures.config("");
        Sampler sampler = Fixtures.watched(config, world, new ArrayList<>(), 1);
        world.readCostNanos = 600_000;
        sampler.request(b -> b.sight(GARY, MARGO));
        sampler.onServerTick();
        assertEquals(1, sampler.status().overBudgetTicks());
        assertEquals(600, sampler.status().lastTickMicros());
        assertTrue(world.reads.isEmpty());
        sampler.onServerTick();
        assertEquals(java.util.List.of("f0"), world.reads);
    }
}
