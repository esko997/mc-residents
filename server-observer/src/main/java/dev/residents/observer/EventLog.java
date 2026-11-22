package dev.residents.observer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

/**
 * A bounded event ring that drops the oldest entries. The single writer (the server thread)
 * appends and then {@link #publish()}es an immutable view; request threads only read the view,
 * so neither side ever blocks the other. Sequence numbers are monotonic for the server run so a
 * consumer can resume with {@code after=<seq>} and detect a gap after a long absence.
 */
public final class EventLog {

    /** An immutable published state of the ring. */
    public record View(List<Observations.Event> events, long oldestSeq, long latestSeq, long dropped) {
        public View {
            events = List.copyOf(events);
        }
    }

    /** One page for a consumer. {@code gap} is true when events after {@code after} were already dropped. */
    public record Page(List<Observations.Event> events, long oldestSeq, long latestSeq, boolean gap) {
    }

    private final int capacity;
    private final ArrayDeque<Observations.Event> ring;
    private final AtomicReference<View> view = new AtomicReference<>(new View(List.of(), 1, 0, 0));
    private long nextSeq = 1;
    private long dropped;
    private boolean dirty;

    public EventLog(int capacity) {
        if (capacity < 1) {
            throw new IllegalArgumentException("capacity must be positive");
        }
        this.capacity = capacity;
        this.ring = new ArrayDeque<>(capacity);
    }

    /** Server thread only. Becomes visible to readers at the next {@link #publish()}. */
    public void append(String type, long atMs, long gameTime, String resident, String facility, String detail) {
        if (ring.size() == capacity) {
            ring.removeFirst();
            dropped++;
        }
        ring.addLast(new Observations.Event(nextSeq++, type, atMs, gameTime, resident, facility, detail));
        dirty = true;
    }

    /** Server thread only. Cheap when nothing was appended. */
    public void publish() {
        if (!dirty) {
            return;
        }
        dirty = false;
        long oldest = ring.isEmpty() ? nextSeq : ring.peekFirst().seq();
        view.set(new View(new ArrayList<>(ring), oldest, nextSeq - 1, dropped));
    }

    public View view() {
        return view.get();
    }

    /**
     * Events with {@code seq > after} that {@code visible} accepts, at most {@code limit}, oldest first.
     * The gap flag is computed over the whole ring, not just visible events: a consumer that missed
     * any event it might have been allowed to see is told so.
     */
    public static Page page(View v, long after, int limit, Predicate<Observations.Event> visible) {
        List<Observations.Event> out = new ArrayList<>();
        for (Observations.Event e : v.events()) {
            if (e.seq() > after && visible.test(e)) {
                out.add(e);
                if (out.size() >= limit) {
                    break;
                }
            }
        }
        boolean gap = after < v.oldestSeq() - 1;
        return new Page(out, v.oldestSeq(), v.latestSeq(), gap);
    }
}
