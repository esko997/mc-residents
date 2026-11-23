package dev.residents.observer;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Runs on the server thread, once per server tick, and is the only code that reads the world.
 *
 * <p>What it watches is the {@link WatchList} Commons pushes; it starts empty. A push is validated on the
 * request thread, then swapped in whole at the start of the next tick, on the server thread, where every
 * user of the list (resident reads, the facility round-robin, the flow tracker, block listeners) also runs,
 * so none of them can see half of two lists. Request threads see the published list.
 *
 * <p>Every {@code intervalTicks} a cycle starts: all watched residents are read (a UUID map lookup each).
 * Watched facilities are read round-robin across ticks while the tick's elapsed observer time is under
 * {@code tickBudgetMicros}; whatever does not fit continues next tick. The shelf scan ({@link ShelfScan}),
 * when wanted, gets the first quarter of the budget and whatever the facilities leave. After any work an
 * immutable {@link Observations.Snapshot} is published for request threads.
 *
 * <p>Failure isolation: a facility read that throws becomes that facility's {@code ERROR} view.
 * A whole tick that throws counts as a failure; {@code failureTripCount} consecutive failures trip
 * the observer off until the server restarts. The game is never affected beyond the budgeted time.
 */
public final class Sampler {

    /** The observer's derived health, as reported to consumers. */
    public record State(String id, String detail) {
    }

    private record PendingWatch(WatchList list, CompletableFuture<WatchList> applied) {
    }

    private final ObserverConfig config;
    private final WorldAccess world;
    private final BridgeAccess bridge;
    private final TickRequests requests;
    private final LongSupplier nanos;
    private final LongSupplier wallMs;
    private final EventLog events;
    private final Consumer<String> warn;
    private final String bootId = UUID.randomUUID().toString();

    // Server thread: the list in use and the observations aligned with it.
    private WatchList watch = WatchList.EMPTY;
    private Observations.Resident[] residents = new Observations.Resident[0];
    private Observations.Facility[] facilities = new Observations.Facility[0];
    private final AtomicReference<PendingWatch> pendingWatch = new AtomicReference<>();
    private volatile WatchList publishedWatch = WatchList.EMPTY;

    private int cursor;
    private int ticksIntoCycle;
    private long seq;
    private long ticks;
    private long maxTickMicros;
    private long overBudgetTicks;
    private long lagCycles;
    private int lagStreak;
    private int consecutiveFailures;
    private String lastError;
    private volatile boolean tripped;
    private volatile boolean stopped;
    private long lastPublishAtMs;
    private final long startedAtMs;

    // Recorders (server thread writes; request threads read published views only).
    private final BlockLog blocks;
    private final SeqRing<Flows.Flow> flows;
    private List<Flows.Candidate> candidates = List.of();
    private volatile long flowsRecorded;
    private int listenerFailures;
    private volatile String recorderProblem;
    private final ShelfScan shelves = new ShelfScan();

    private final AtomicReference<Observations.Snapshot> snapshot = new AtomicReference<>();
    private final AtomicReference<Observations.Status> status = new AtomicReference<>();
    private volatile long heartbeatAtMs;
    private volatile boolean paused;

    public Sampler(ObserverConfig config, WorldAccess world, BridgeAccess bridge, EventLog events,
                   LongSupplier nanos, LongSupplier wallMs, Consumer<String> warn) {
        this.config = config;
        this.world = world;
        this.bridge = bridge;
        this.requests = new TickRequests(config.requestQueueCapacity(), config.requestTimeoutMs(), nanos);
        this.events = events;
        this.nanos = nanos;
        this.wallMs = wallMs;
        this.warn = warn;
        this.startedAtMs = wallMs.getAsLong();
        this.blocks = new BlockLog(config.recording(), config.tickBudgetMicros());
        this.flows = new SeqRing<>(config.recording().flowCapacity());
        this.heartbeatAtMs = startedAtMs;
        events.append("observer_started", startedAtMs, 0L, null, null,
                "boot " + bootId + "; watching nothing until Commons pushes the watch list");
        events.publish();
        publishStatus(0);
    }

    // === server thread ===

    /** Call from the server tick (END phase). Never call from any other thread. */
    public void onServerTick() {
        long now = wallMs.getAsLong();
        heartbeatAtMs = now;
        if (tripped) {
            requests.rejectAll("tripped");
            rejectPendingWatch("tripped");
            return;
        }
        long t0 = nanos.getAsLong();
        if (paused) {
            requests.rejectAll("paused");
            try {
                applyPendingWatch(now); // memory only, no world access: a list pushed while paused is not lost
            } catch (Throwable t) {
                failed(t, now);
            }
            publishStatus(0);
            return;
        }
        TickRequests.Ticket<?> eligible = requests.next();
        try {
            ticks++;
            boolean worked = applyPendingWatch(now);
            long gameTime = world.gameTime();
            if (ticksIntoCycle == 0) {
                if (cursor < facilities.length) {
                    lagCycles++;
                    lagStreak++;
                } else {
                    cursor = 0;
                    lagStreak = 0;
                }
                readResidents(now, gameTime);
                worked = true;
            }
            ticksIntoCycle = (ticksIntoCycle + 1) % config.intervalTicks();

            long budgetNanos = config.tickBudgetMicros() * 1000L;
            if (nanos.getAsLong() - t0 < budgetNanos) requests.runOne(eligible, bridge);
            scan(t0, budgetNanos / 4, now);
            while (cursor < facilities.length && nanos.getAsLong() - t0 < budgetNanos) {
                readFacility(cursor, now, gameTime);
                cursor++;
                worked = true;
            }
            scan(t0, budgetNanos, now);
            if (worked) publishSnapshot(now, gameTime);
            consecutiveFailures = 0;
        } catch (Throwable t) {
            failed(t, now);
        } finally {
            // Recorder publication (ring copies, hour roll-over) runs before the measurement, and the
            // block listeners' time since the previous tick is added: the budget metrics cover all observer work.
            long listenerNanos = blocks.endTick(now);
            flows.publish();
            events.publish();
            long micros = Math.max(0L, (nanos.getAsLong() - t0 + listenerNanos) / 1000L);
            if (micros > config.tickBudgetMicros()) {
                overBudgetTicks++;
            }
            maxTickMicros = Math.max(maxTickMicros, micros);
            publishStatus(micros);
        }
    }

    private void failed(Throwable t, long now) {
        consecutiveFailures++;
        lastError = describe(t);
        warn.accept("tick failed (" + consecutiveFailures + "/" + config.failureTripCount() + "): " + lastError);
        if (consecutiveFailures >= config.failureTripCount()) {
            tripped = true;
            requests.rejectAll("tripped");
            rejectPendingWatch("tripped");
            events.append("observer_tripped", now, 0L, null, null, lastError);
            warn.accept("tripped after " + consecutiveFailures + " consecutive failures; observing stops until restart");
        }
    }

    /** Shelf scan units while the tick's observer time is under {@code limitNanos} and a scan is wanted. */
    private void scan(long t0, long limitNanos, long now) {
        while (nanos.getAsLong() - t0 < limitNanos && shelves.wantsWork(now)) {
            shelves.step(bridge, now, ticks, nanos);
        }
    }

    /**
     * Swaps in a pushed list, if any. Residents keep their observation when name and UUID are unchanged;
     * a facility keeps its observation, history and flow baseline when its id, dimension, position and side
     * are unchanged (a new label is taken over), otherwise it starts as pending. Removed facilities' observations
     * and removed residents' observations and block hour cells are dropped. Returns whether a list was applied.
     */
    private boolean applyPendingWatch(long now) {
        PendingWatch p = pendingWatch.getAndSet(null);
        if (p == null) return false;
        try {
            WatchList next = p.list().appliedAt(now);
            Map<WatchList.ResidentSpec, Observations.Resident> oldResidents = new HashMap<>(residents.length * 2);
            for (Observations.Resident r : residents) {
                if (r != null) oldResidents.put(new WatchList.ResidentSpec(r.name(), r.uuid()), r);
            }
            Observations.Resident[] nr = new Observations.Resident[next.residents().size()];
            Set<String> names = new HashSet<>();
            for (int i = 0; i < nr.length; i++) {
                WatchList.ResidentSpec spec = next.residents().get(i);
                nr[i] = oldResidents.get(spec);
                names.add(spec.name());
            }
            Map<String, Observations.Facility> oldFacilities = new HashMap<>(facilities.length * 2);
            for (Observations.Facility f : facilities) oldFacilities.put(f.spec().id(), f);
            Observations.Facility[] nf = new Observations.Facility[next.facilities().size()];
            for (int i = 0; i < nf.length; i++) {
                WatchList.FacilitySpec spec = next.facilities().get(i);
                Observations.Facility old = oldFacilities.get(spec.id());
                nf[i] = old != null && old.spec().samePlace(spec) ? old.withSpec(spec) : Observations.Facility.pending(spec);
            }
            if (!names.containsAll(watch.byName().keySet())) blocks.retainResidents(names);
            candidates = candidates.stream().filter(c -> names.contains(c.resident())).toList();
            watch = next;
            residents = nr;
            facilities = nf;
            // A new cycle starts with the next resident read (this tick unless paused): new residents are read before
            // any snapshot can show them, and the new facilities are read from the start without counting as lag.
            cursor = nf.length;
            ticksIntoCycle = 0;
            publishedWatch = next;
            p.applied().complete(next);
            return true;
        } catch (Throwable t) {
            p.applied().completeExceptionally(t);
            throw t;
        }
    }

    private void rejectPendingWatch(String reason) {
        PendingWatch p = pendingWatch.getAndSet(null);
        if (p != null) p.applied().completeExceptionally(new TickRequests.Unavailable(reason));
    }

    private void publishSnapshot(long now, long gameTime) {
        snapshot.set(new Observations.Snapshot(++seq, now, gameTime,
                Arrays.asList(residents.clone()), Arrays.asList(facilities.clone())));
        lastPublishAtMs = now;
    }

    private void readResidents(long now, long gameTime) {
        List<WatchList.ResidentSpec> specs = watch.residents();
        List<Flows.Candidate> near = new java.util.ArrayList<>(specs.size() * 2);
        for (int i = 0; i < specs.size(); i++) {
            WatchList.ResidentSpec spec = specs.get(i);
            Observations.Resident prev = residents[i];
            Observations.Body body = world.readResident(spec, now, gameTime);
            Observations.Body lastSeen = body != null ? null
                    : prev == null ? null : prev.online() ? prev.body() : prev.lastSeen();
            Observations.Resident cur = new Observations.Resident(spec.name(), spec.uuid(), body != null, now, body, lastSeen);
            residents[i] = cur;
            residentEvents(prev, cur, now, gameTime);
            // Flow evidence: where each resident was at this sample and the one before it.
            if (body != null) near.add(candidate(spec.name(), body, "now"));
            if (prev != null && prev.online()) near.add(candidate(spec.name(), prev.body(), "previous"));
        }
        candidates = near;
    }

    private static Flows.Candidate candidate(String name, Observations.Body b, String when) {
        return new Flows.Candidate(name, b.dimension(), b.x(), b.y(), b.z(), when);
    }

    private void residentEvents(Observations.Resident prev, Observations.Resident cur, long now, long gameTime) {
        boolean wasOnline = prev != null && prev.online();
        if (cur.online() && !wasOnline) {
            events.append("resident_online", now, gameTime, cur.name(), null, cur.body().dimension());
        } else if (!cur.online() && wasOnline) {
            events.append("resident_offline", now, gameTime, cur.name(), null, null);
        }
        if (cur.online() && wasOnline) {
            Observations.Body before = prev.body();
            Observations.Body after = cur.body();
            if (!Objects.equals(before.dimension(), after.dimension())) {
                events.append("resident_dimension", now, gameTime, cur.name(), null,
                        before.dimension() + " -> " + after.dimension());
            }
            if (after.dead() && !before.dead()) {
                events.append("resident_died", now, gameTime, cur.name(), null, after.dimension());
            }
        } else if (cur.online() && cur.body().dead()) {
            events.append("resident_died", now, gameTime, cur.name(), null, cur.body().dimension());
        }
    }

    private void readFacility(int i, long now, long gameTime) {
        Observations.Facility prev = facilities[i];
        WatchList.FacilitySpec spec = prev.spec();
        Observations.BlockRead read;
        try {
            read = world.read(spec.dimension(), spec.x(), spec.y(), spec.z(), spec.side());
            if (read == null) read = new Observations.BlockRead(Observations.FacilityStatus.ERROR, "reader returned nothing", null, null);
        } catch (Throwable t) {
            read = new Observations.BlockRead(Observations.FacilityStatus.ERROR, describe(t), null, null);
        }
        Observations.Facility cur = Observations.Facility.read(spec, read, now, gameTime).carryingFrom(prev);
        facilities[i] = cur;
        if (cur.status() != prev.status()) {
            events.append("facility_status", now, gameTime, null, spec.id(),
                    prev.status().id() + " -> " + cur.status().id() + (cur.detail() == null ? "" : ": " + cur.detail()));
        }
        if (config.recording().recordFlows() && cur.status() == Observations.FacilityStatus.OBSERVED) {
            boolean continuous = prev.status() == Observations.FacilityStatus.OBSERVED;
            Observations.Contents before = continuous ? prev.contents() : prev.lastKnown();
            Long beforeAt = continuous ? Long.valueOf(prev.checkedAtMs()) : prev.lastObservedAtMs();
            if (before != null && beforeAt != null) {
                Flows.Flow flow = Flows.diff(spec, before, beforeAt, continuous, cur.contents(), now, gameTime,
                        candidates, config.recording().flowReach(), config.maxItemKinds());
                if (flow != null) {
                    flows.append(flow);
                    flowsRecorded++;
                }
            }
        }
    }

    // === recorders: block listeners call these on the server thread ===

    /** True when listeners may record: not paused, not tripped, and the block recorder has not stopped itself. */
    public boolean recording() {
        return !paused && !tripped && recorderProblem == null && blocks.enabled();
    }

    /** Server thread: the list in use right now (listeners map a player UUID to a watched resident with it). */
    public WatchList watching() {
        return watch;
    }

    public BlockLog blocks() {
        return blocks;
    }

    /** Server thread. A listener completed normally. */
    public void listenerSucceeded() {
        listenerFailures = 0;
    }

    /** Server thread. Repeated listener failures stop block recording (only) until restart; the game is unaffected. */
    public void listenerFailed(Throwable t) {
        listenerFailures++;
        String error = describe(t);
        warn.accept("block listener failed (" + listenerFailures + "/" + config.failureTripCount() + "): " + error);
        if (listenerFailures >= config.failureTripCount() && recorderProblem == null) {
            recorderProblem = "block recording stopped after " + listenerFailures + " consecutive listener failures: " + error;
            events.append("recorder_stopped", wallMs.getAsLong(), 0L, null, null, recorderProblem);
            warn.accept(recorderProblem);
        }
    }

    public SeqRing.View<Flows.Flow> flows() {
        return flows.view();
    }

    public long flowsRecorded() {
        return flowsRecorded;
    }

    public long startedAtMs() {
        return startedAtMs;
    }

    private void publishStatus(long lastTickMicros) {
        WatchList w = publishedWatch;
        status.set(new Observations.Status(startedAtMs, bootId, lastPublishAtMs, ticks, lastTickMicros, maxTickMicros,
                config.tickBudgetMicros(), overBudgetTicks, config.intervalTicks(), lagCycles, lagStreak,
                consecutiveFailures, config.failureTripCount(), lastError, tripped, paused,
                w.revision(), w.appliedAtMs(), w.residents().size(), w.facilities().size(), recorderProblem,
                shelves.metrics()));
    }

    static String describe(Throwable t) {
        String message = t.getMessage();
        String text = t.getClass().getSimpleName() + (message == null ? "" : ": " + message);
        return text.length() > 240 ? text.substring(0, 239) + "…" : text;
    }

    // === any thread ===

    /** Set from the pause-file watcher. Takes effect at the next tick. */
    public void setPaused(boolean value) {
        paused = value;
    }

    /** Random per server start; Commons re-pushes the watch list when it changes. */
    public String bootId() {
        return bootId;
    }

    /** The watch list request threads use (the one the tick last applied). */
    public WatchList watch() {
        return publishedWatch;
    }

    /**
     * Request thread: queue a validated list for the next tick. A list still waiting is replaced (its future
     * fails with "superseded"). The future completes when the tick has swapped the list in.
     */
    CompletableFuture<WatchList> offerWatch(WatchList list) {
        if (tripped || stopped) throw new TickRequests.Unavailable(tripped ? "tripped" : "stopped");
        PendingWatch p = new PendingWatch(list, new CompletableFuture<>());
        PendingWatch old = pendingWatch.getAndSet(p);
        if (old != null) old.applied().completeExceptionally(new TickRequests.Unavailable("superseded"));
        if (stopped) rejectPendingWatch("stopped");
        return p.applied();
    }

    /** HTTP threads may only enqueue. No game object escapes through these immutable results. */
    <T> TickRequests.Ticket<T> request(java.util.function.Function<BridgeAccess, T> read) {
        if (paused || tripped) throw new TickRequests.Unavailable(tripped ? "tripped" : "paused");
        return requests.submit(read);
    }

    ShelfScan shelves() {
        return shelves;
    }

    public void stop() {
        stopped = true;
        requests.close();
        rejectPendingWatch("stopped");
    }

    public Observations.Snapshot snapshot() {
        return snapshot.get();
    }

    public Observations.Status status() {
        return status.get();
    }

    public long heartbeatAtMs() {
        return heartbeatAtMs;
    }

    public EventLog.View events() {
        return events.view();
    }

    public State state(long nowMs) {
        return deriveState(status.get(), snapshot.get(), heartbeatAtMs, nowMs, config.stallSeconds() * 1000L);
    }

    /** Pure: what consumers are told about the observer's health. Order matters: worst first. */
    static State deriveState(Observations.Status st, Observations.Snapshot snap, long heartbeatAtMs, long nowMs, long stallMs) {
        if (st != null && st.tripped()) {
            return new State("tripped", "stopped after " + st.consecutiveFailures() + " consecutive failures: " + st.lastError());
        }
        if (nowMs - heartbeatAtMs > stallMs) {
            return new State("stalled", "the server tick has not run for " + (nowMs - heartbeatAtMs) / 1000 + " s");
        }
        if (st != null && st.paused()) {
            return new State("paused", "paused by config/resident_observer.paused");
        }
        if (snap == null) {
            return new State("starting", "no snapshot yet");
        }
        if (st != null && st.consecutiveFailures() > 0) {
            return new State("degraded", "last tick failed: " + st.lastError());
        }
        if (st != null && st.lagStreak() >= 3) {
            return new State("degraded", "facility reads are not finishing within the interval ("
                    + st.lagStreak() + " cycles behind); facility times are older than the interval");
        }
        if (st != null && st.recorderProblem() != null) {
            return new State("degraded", st.recorderProblem());
        }
        return new State("ok", null);
    }
}
