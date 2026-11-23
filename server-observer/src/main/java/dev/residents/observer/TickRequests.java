package dev.residents.observer;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import java.util.function.LongSupplier;

/** Bounded hand-off. Producers enqueue immutable arguments; only the tick calls runOne. */
final class TickRequests {
    static final class Unavailable extends RuntimeException {
        final String code;
        Unavailable(String code) { super(code); this.code = code; }
    }

    final class Ticket<T> {
        final CompletableFuture<T> result = new CompletableFuture<>();
        private final Function<BridgeAccess, T> read;
        private final long deadline;

        private Ticket(Function<BridgeAccess, T> read) {
            this.read = read;
            this.deadline = nanos.getAsLong() + timeoutNanos;
        }

        void cancel() {
            result.cancel(false);
            queue.remove(this);
        }

        private void run(BridgeAccess world) {
            if (result.isDone()) return;
            if (nanos.getAsLong() - deadline >= 0) {
                result.completeExceptionally(new Unavailable("timeout"));
                return;
            }
            try {
                result.complete(read.apply(world));
            } catch (Throwable failure) {
                result.completeExceptionally(failure);
                // Isolate the caller, but let the sampler's existing failure/trip policy see it.
                throw failure;
            }
        }
    }

    private final ArrayBlockingQueue<Ticket<?>> queue;
    private final LongSupplier nanos;
    private final long timeoutNanos;
    private volatile boolean closed;

    TickRequests(int capacity, int timeoutMs, LongSupplier nanos) {
        this.queue = new ArrayBlockingQueue<>(capacity);
        this.nanos = nanos;
        this.timeoutNanos = timeoutMs * 1_000_000L;
    }

    <T> Ticket<T> submit(Function<BridgeAccess, T> read) {
        Ticket<T> ticket = new Ticket<>(read);
        if (closed || !queue.offer(ticket)) throw new Unavailable(closed ? "stopped" : "busy");
        if (closed && queue.remove(ticket)) ticket.result.completeExceptionally(new Unavailable("stopped"));
        return ticket;
    }

    Ticket<?> next() {
        return queue.peek();
    }

    /** Only the ticket present at tick entry may run; later arrivals wait for the next tick. */
    void runOne(Ticket<?> eligible, BridgeAccess world) {
        if (eligible != null && queue.remove(eligible)) eligible.run(world);
    }

    void rejectAll(String reason) {
        Ticket<?> ticket;
        while ((ticket = queue.poll()) != null) ticket.result.completeExceptionally(new Unavailable(reason));
    }

    void close() {
        closed = true;
        rejectAll("stopped");
    }
}
