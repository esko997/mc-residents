package dev.residents.observer;

import java.util.List;
import java.util.UUID;

/**
 * Immutable observation values. Built on the server thread from plain copies of game values
 * (no references to entities, levels or item stacks) and published whole, so request threads
 * can read and serialize them without touching the game.
 */
public final class Observations {

    private Observations() {
    }

    /** A resident's body as read on one tick. */
    public record Body(long atMs, long gameTime, String dimension, double x, double y, double z,
                       float health, float maxHealth, int food, int air, int maxAir, String gameMode,
                       boolean dead, boolean sleeping, String vehicle, int xpLevel) {
    }

    /**
     * A configured resident. {@code body} is set when online; {@code lastSeen} is the last
     * online body (from this server run) when offline, or {@code null} if never seen.
     */
    public record Resident(String name, UUID uuid, boolean online, long checkedAtMs, Body body, Body lastSeen) {
    }

    public record ItemCount(String item, long count, int nbtStacks) {
    }

    public record FluidAmount(String fluid, long amount, long capacity) {
    }

    public record Energy(long stored, long max) {
    }

    /** What a facility held when it was observed. */
    public record Contents(String block, int slots, int usedSlots, boolean slotsTruncated,
                           List<ItemCount> items, boolean itemsTruncated, Energy energy,
                           List<FluidAmount> fluids, long readMicros) {
        public Contents {
            items = List.copyOf(items);
            fluids = List.copyOf(fluids);
        }
    }

    public enum FacilityStatus {
        /** Not attempted yet in this server run. */
        PENDING,
        /** Read this time; {@code contents} is current as of {@code checkedAtMs}. */
        OBSERVED,
        /** Its chunk (or a neighbouring chunk) is not loaded; the observer never loads chunks. */
        UNLOADED,
        /** The configured dimension does not exist on this server. */
        NO_LEVEL,
        /** Loaded, but there is no block entity at the position (block broken or replaced?). */
        NO_BLOCK_ENTITY,
        /** A block entity exists but exposes no item/energy/fluid capability readable here. */
        UNSUPPORTED,
        /** Reading threw; {@code detail} has the exception class and message. */
        ERROR;

        public String id() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /**
     * One registered facility. {@code contents} only when {@code OBSERVED}; otherwise
     * {@code lastKnown}/{@code lastObservedAtMs} carry the last observation as history.
     */
    public record Facility(ObserverConfig.FacilitySpec spec, FacilityStatus status, String detail,
                           long checkedAtMs, long gameTime, Contents contents,
                           Contents lastKnown, Long lastObservedAtMs) {

        public static Facility pending(ObserverConfig.FacilitySpec spec) {
            return new Facility(spec, FacilityStatus.PENDING, "not read yet", 0L, 0L, null, null, null);
        }

        /** A fresh read result (from the world reader), before history is carried forward. */
        public static Facility read(ObserverConfig.FacilitySpec spec, FacilityStatus status, String detail,
                                    long checkedAtMs, long gameTime, Contents contents) {
            return new Facility(spec, status, detail, checkedAtMs, gameTime,
                    status == FacilityStatus.OBSERVED ? contents : null, null, null);
        }

        /** This read, with the previous view's history kept when this read observed nothing. */
        public Facility carryingFrom(Facility previous) {
            if (status == FacilityStatus.OBSERVED) {
                return new Facility(spec, status, detail, checkedAtMs, gameTime, contents, null, null);
            }
            Contents known = null;
            Long knownAt = null;
            if (previous != null) {
                if (previous.status == FacilityStatus.OBSERVED) {
                    known = previous.contents;
                    knownAt = previous.checkedAtMs;
                } else {
                    known = previous.lastKnown;
                    knownAt = previous.lastObservedAtMs;
                }
            }
            return new Facility(spec, status, detail, checkedAtMs, gameTime, null, known, knownAt);
        }
    }

    /** Everything one publication carries. Lists are immutable copies. */
    public record Snapshot(long seq, long builtAtMs, long gameTime, List<Resident> residents, List<Facility> facilities) {
        public Snapshot {
            residents = List.copyOf(residents);
            facilities = List.copyOf(facilities);
        }
    }

    public record Event(long seq, String type, long atMs, long gameTime, String resident, String facility, String detail) {
    }

    /**
     * Observer health, published alongside snapshots. {@code lagStreak}: cycles in a row that began before the
     * previous facility pass finished. {@code recorderProblem}: non-null once block recording stopped itself.
     */
    public record Status(long startedAtMs, long lastPublishAtMs, long ticks, long lastTickMicros, long maxTickMicros,
                         int budgetMicros, long overBudgetTicks, int intervalTicks, long lagCycles, int lagStreak,
                         int consecutiveFailures, int failureTripCount, String lastError, boolean tripped,
                         boolean paused, int residentsConfigured, int facilitiesConfigured, String recorderProblem) {
    }
}
