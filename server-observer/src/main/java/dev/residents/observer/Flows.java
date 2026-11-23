package dev.residents.observer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Item flows in watched facilities, derived by comparing two consecutive observations of the
 * same container (the sampler's own reads; no extra world access). Pure and unit-tested.
 *
 * <p>Who was there is <b>evidence, not proof</b>: watched residents whose bodies were within
 * {@code reach} blocks of the container when the change was detected, or at their previous sample.
 * Human players are never considered or reported, so a change with a resident nearby may still
 * have been made by a person, a hopper, a pipe or a machine.
 */
public final class Flows {

    private Flows() {
    }

    public static final String NEAREST = "nearest_resident_within_reach";
    public static final String NOBODY = "no_resident_within_reach";

    /** Count of one item id before and after (sum over slots; NBT-carrying stacks counted, never read). */
    public record Delta(String item, long before, long after, int nbtBefore, int nbtAfter) {
    }

    /** {@code when}: "now" (the sample that detected the change) or "previous" (the sample before). */
    public record Nearby(String resident, double distance, String when) {
    }

    /** A resident body position offered as a candidate. */
    public record Candidate(String resident, String dimension, double x, double y, double z, String when) {
    }

    /**
     * One detected change. {@code sinceMs}: when the earlier observation was made; the change
     * happened somewhere in (sinceMs, atMs]. {@code uncertain}: reasons the deltas may be incomplete.
     */
    public record Flow(String facility, String dimension, long atMs, long gameTime, long sinceMs, boolean continuous,
                       List<Delta> deltas, boolean deltasTruncated, List<String> uncertain,
                       String attribution, String resident, List<Nearby> nearby) {
        public Flow {
            deltas = List.copyOf(deltas);
            uncertain = List.copyOf(uncertain);
            nearby = List.copyOf(nearby);
        }
    }

    public static final int MAX_NEARBY = 4;

    /**
     * The change between {@code before} (observed at {@code beforeAtMs}) and {@code after}, or null
     * when nothing an item count can show changed. {@code continuous}: {@code before} was the
     * immediately preceding read (false when the container was unreadable in between).
     */
    public static Flow diff(WatchList.FacilitySpec facility, Observations.Contents before, long beforeAtMs,
                            boolean continuous, Observations.Contents after, long nowMs, long gameTime,
                            List<Candidate> candidates, double reach, int maxDeltas) {
        if (before == null || after == null) return null;
        Map<String, long[]> counts = new TreeMap<>();
        for (Observations.ItemCount i : before.items()) {
            long[] c = counts.computeIfAbsent(i.item(), k -> new long[4]);
            c[0] += i.count();
            c[2] += i.nbtStacks();
        }
        for (Observations.ItemCount i : after.items()) {
            long[] c = counts.computeIfAbsent(i.item(), k -> new long[4]);
            c[1] += i.count();
            c[3] += i.nbtStacks();
        }
        List<Delta> deltas = new ArrayList<>();
        boolean truncated = false;
        for (Map.Entry<String, long[]> e : counts.entrySet()) {
            long[] c = e.getValue();
            if (c[0] == c[1] && c[2] == c[3]) continue;
            if (deltas.size() >= maxDeltas) {
                truncated = true;
                break;
            }
            deltas.add(new Delta(e.getKey(), c[0], c[1], (int) c[2], (int) c[3]));
        }
        if (deltas.isEmpty()) return null;

        List<String> uncertain = new ArrayList<>();
        if (before.itemsTruncated() || after.itemsTruncated()) uncertain.add("item_kinds_truncated");
        if (before.slotsTruncated() || after.slotsTruncated()) uncertain.add("slots_truncated");
        if (!continuous) uncertain.add("observation_gap");
        if (!same(before.block(), after.block())) uncertain.add("block_changed");
        if (deltas.stream().anyMatch(d -> d.before() == d.after())) uncertain.add("nbt_only_change");

        List<Nearby> nearby = nearby(facility, candidates, reach);
        String attribution = nearby.isEmpty() ? NOBODY : NEAREST;
        String resident = nearby.isEmpty() ? null : nearby.get(0).resident();
        return new Flow(facility.id(), facility.dimension(), nowMs, gameTime, beforeAtMs, continuous, deltas, truncated,
                uncertain, attribution, resident, nearby);
    }

    /** Residents within reach of the block centre, nearest first, one entry per resident (its closest sample). */
    static List<Nearby> nearby(WatchList.FacilitySpec f, List<Candidate> candidates, double reach) {
        double cx = f.x() + 0.5, cy = f.y() + 0.5, cz = f.z() + 0.5;
        Map<String, Nearby> best = new TreeMap<>();
        for (Candidate c : candidates) {
            if (c == null || !f.dimension().equals(c.dimension())) continue;
            double d = Math.sqrt((c.x() - cx) * (c.x() - cx) + (c.y() - cy) * (c.y() - cy) + (c.z() - cz) * (c.z() - cz));
            if (!(d <= reach)) continue;
            double rounded = Math.round(d * 10.0) / 10.0;
            Nearby prior = best.get(c.resident());
            if (prior == null || rounded < prior.distance()) best.put(c.resident(), new Nearby(c.resident(), rounded, c.when()));
        }
        List<Nearby> out = new ArrayList<>(best.values());
        out.sort(Comparator.comparingDouble(Nearby::distance).thenComparing(Nearby::resident));
        return out.size() > MAX_NEARBY ? out.subList(0, MAX_NEARBY) : out;
    }

    private static boolean same(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
