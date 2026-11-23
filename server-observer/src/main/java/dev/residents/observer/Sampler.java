package dev.residents.observer;

import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Runs on the server thread, once per server tick, and is the only code that reads the world.
 *
 * <p>Every {@code intervalTicks} a cycle starts: all configured residents are read (a UUID map
 * lookup each). Registered facilities are read round-robin across ticks while the tick's elapsed
 * observer time is under {@code tickBudgetMicros}; whatever does not fit continues next tick.
 * After any work an immutable {@link Observations.Snapshot} is published for request threads.
 *
 * <p>Failure isolation: a facility read that throws becomes that facility's {@code ERROR} view.
 * A whole tick that throws counts as a failure; {@code failureTripCount} consecutive failures trip
 * the observer off until the server restarts. The game is never affected beyond the budgeted time.
 */
public final class Sampler {

    /** The observer's derived health, as reported to consumers. */
    public record State(String id, String detail) {
    }

    private final ObserverConfig config;
    private final WorldAccess world;
    private final BridgeAccess bridge;
    private final TickRequests requests;
    private final LongSupplier nanos;
    private final LongSupplier wallMs;
    private final EventLog events;
    private final Consumer<String> warn;

    private final Observations.Resident[] residents;
    private final Observations.Facility[] facilities;
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
    private long lastPublishAtMs;
    private final long startedAtMs;

    // Recorders (server thread writes; request threads read published views only).
    private final BlockLog blocks;
    private final SeqRing<Flows.Flow> flows;
    private List<Flows.Candidate> candidates = List.of();
    private volatile long flowsRecorded;
    private int listenerFailures;
    private volatile String recorderProblem;

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
        this.residents = new Observations.Resident[config.residents().size()];
        this.facilities = new Observations.Facility[config.facilities().size()];
        for (int i = 0; i < facilities.length; i++) {
            facilities[i] = Observations.Facility.pending(config.facilities().get(i));
        }
        this.cursor = facilities.length; // "previous pass complete", so the first cycle starts at 0
        this.startedAtMs = wallMs.getAsLong();
        this.blocks = new BlockLog(config.recording(), config.tickBudgetMicros());
        this.flows = new SeqRing<>(config.recording().flowCapacity());
        this.heartbeatAtMs = startedAtMs;
        events.append("observer_started", startedAtMs, 0L, null, null,
                config.residents().size() + " residents, " + config.facilities().size() + " facilities configured");
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
            return;
        }
        if (paused) {
            requests.rejectAll("paused");
            publishStatus(0);
            return;
        }
        long t0 = nanos.getAsLong();
        TickRequests.Ticket<?> eligible = requests.next();
        try {
            ticks++;
            boolean worked = false;
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
            while (cursor < facilities.length && nanos.getAsLong() - t0 < budgetNanos) {
                readFacility(cursor, now, gameTime);
                cursor++;
                worked = true;
            }
            if (worked) {
                snapshot.set(new Observations.Snapshot(++seq, now, gameTime,
                        Arrays.asList(residents.clone()), Arrays.asList(facilities.clone())));
                lastPublishAtMs = now;
            }
            consecutiveFailures = 0;
        } catch (Throwable t) {
            consecutiveFailures++;
            lastError = describe(t);
            warn.accept("tick failed (" + consecutiveFailures + "/" + config.failureTripCount() + "): " + lastError);
            if (consecutiveFailures >= config.failureTripCount()) {
                tripped = true;
                requests.rejectAll("tripped");
                events.append("observer_tripped", now, 0L, null, null, lastError);
                warn.accept("tripped after " + consecutiveFailures + " consecutive failures; observing stops until restart");
            }
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

    private void readResidents(long now, long gameTime) {
        List<ObserverConfig.ResidentSpec> specs = config.residents();
        List<Flows.Candidate> near = new java.util.ArrayList<>(specs.size() * 2);
        for (int i = 0; i < specs.size(); i++) {
            ObserverConfig.ResidentSpec spec = specs.get(i);
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
        ObserverConfig.FacilitySpec spec = prev.spec();
        Observations.Facility fresh;
        try {
            fresh = world.readFacility(spec, now, gameTime);
            if (fresh == null) {
                fresh = Observations.Facility.read(spec, Observations.FacilityStatus.ERROR,
                        "reader returned nothing", now, gameTime, null);
            }
        } catch (Throwable t) {
            fresh = Observations.Facility.read(spec, Observations.FacilityStatus.ERROR, describe(t), now, gameTime, null);
        }
        Observations.Facility cur = fresh.carryingFrom(prev);
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
        status.set(new Observations.Status(startedAtMs, lastPublishAtMs, ticks, lastTickMicros, maxTickMicros,
                config.tickBudgetMicros(), overBudgetTicks, config.intervalTicks(), lagCycles, lagStreak,
                consecutiveFailures, config.failureTripCount(), lastError, tripped, paused,
                residents.length, facilities.length, recorderProblem));
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

    /** HTTP threads may only enqueue. No game object escapes through these immutable results. */
    <T> TickRequests.Ticket<T> request(java.util.function.Function<BridgeAccess, T> read) {
        if (paused || tripped) throw new TickRequests.Unavailable(tripped ? "tripped" : "paused");
        return requests.submit(read);
    }

    public void stop() {
        requests.close();
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
