package dev.residents.observer;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

/**
 * A fixed-capacity ring of sequence-numbered records that drops the oldest. Same contract as
 * {@link EventLog}: one writer (the server thread) appends and {@link #publish()}es an immutable
 * view; request threads page through published views only, so neither side ever blocks the other.
 * Sequence numbers are monotonic for the server run; a cursor older than the ring reports a gap.
 */
final class SeqRing<T> {

    record Entry<T>(long seq, T value) {
    }

    /** Published state. {@code entries} is unmodifiable and ordered by seq, contiguous. */
    record View<T>(List<Entry<T>> entries, long oldestSeq, long latestSeq, long dropped) {
    }

    /** {@code nextAfter}: the cursor to send next time (advances past invisible entries when the page is not full). */
    record Page<T>(List<Entry<T>> entries, long oldestSeq, long latestSeq, boolean gap, long nextAfter) {
    }

    private final Object[] buffer;
    private int head;
    private int size;
    private long nextSeq = 1;
    private long dropped;
    private boolean dirty;
    private final AtomicReference<View<T>> view = new AtomicReference<>(new View<>(List.of(), 1, 0, 0));

    SeqRing(int capacity) {
        if (capacity < 1) throw new IllegalArgumentException("capacity must be positive");
        buffer = new Object[capacity];
    }

    /** Writer thread only. Visible to readers after the next {@link #publish()}. */
    long append(T value) {
        long seq = nextSeq++;
        Entry<T> entry = new Entry<>(seq, value);
        if (size == buffer.length) {
            buffer[head] = entry;
            head = (head + 1) % buffer.length;
            dropped++;
        } else {
            buffer[(head + size) % buffer.length] = entry;
            size++;
        }
        dirty = true;
        return seq;
    }

    /** Writer thread only. One array copy of at most {@code capacity} references, and only when something changed. */
    @SuppressWarnings("unchecked")
    void publish() {
        if (!dirty) return;
        dirty = false;
        Object[] copy = new Object[size];
        int first = Math.min(size, buffer.length - head);
        System.arraycopy(buffer, head, copy, 0, first);
        System.arraycopy(buffer, 0, copy, first, size - first);
        List<Entry<T>> entries = (List<Entry<T>>) (List<?>) Collections.unmodifiableList(Arrays.asList(copy));
        long oldest = size == 0 ? nextSeq : entries.get(0).seq();
        view.set(new View<>(entries, oldest, nextSeq - 1, dropped));
    }

    View<T> view() {
        return view.get();
    }

    long dropped() {
        return dropped;
    }

    /** Entries with {@code seq > after} accepted by {@code visible}, oldest first, at most {@code limit}. */
    static <T> Page<T> page(View<T> v, long after, int limit, Predicate<T> visible) {
        List<Entry<T>> all = v.entries();
        List<Entry<T>> out = new ArrayList<>(Math.min(limit, all.size()));
        // Entries are contiguous, so the first candidate is found by arithmetic, not a scan.
        long start = Math.max(0L, after - v.oldestSeq() + 1);
        for (int i = (int) Math.min(start, all.size()); i < all.size() && out.size() < limit; i++) {
            Entry<T> e = all.get(i);
            if (visible.test(e.value())) out.add(e);
        }
        boolean gap = after < v.oldestSeq() - 1;
        long next = out.size() >= limit ? out.get(out.size() - 1).seq() : Math.max(after, v.latestSeq());
        if (after > v.latestSeq()) next = v.latestSeq(); // cursor from an earlier server run
        return new Page<>(out, v.oldestSeq(), v.latestSeq(), gap, next);
    }
}
