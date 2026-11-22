package dev.residents.observer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Adds up slot contents by item id with hard limits, so one large inventory cannot make a
 * snapshot (or a tick) unbounded. NBT is never copied: stacks carrying NBT are only counted,
 * so book text, named items and container contents stay private.
 */
public final class ItemTally {

    private final int maxKinds;
    private final Map<String, long[]> counts = new LinkedHashMap<>();
    private int usedSlots;
    private boolean truncated;

    public ItemTally(int maxKinds) {
        this.maxKinds = maxKinds;
    }

    /** One non-empty slot. */
    public void add(String item, long count, boolean hasNbt) {
        if (count <= 0) {
            return;
        }
        usedSlots++;
        long[] c = counts.get(item);
        if (c == null) {
            if (counts.size() >= maxKinds) {
                truncated = true;
                return;
            }
            c = new long[2];
            counts.put(item, c);
        }
        c[0] += count;
        if (hasNbt) {
            c[1]++;
        }
    }

    public int usedSlots() {
        return usedSlots;
    }

    /** True when more distinct items existed than {@code maxKinds}; their counts are omitted. */
    public boolean truncated() {
        return truncated;
    }

    public List<Observations.ItemCount> items() {
        List<Observations.ItemCount> out = new ArrayList<>(counts.size());
        for (Map.Entry<String, long[]> e : counts.entrySet()) {
            out.add(new Observations.ItemCount(e.getKey(), e.getValue()[0], (int) e.getValue()[1]));
        }
        return out;
    }
}
