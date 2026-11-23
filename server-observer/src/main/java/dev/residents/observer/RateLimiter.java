package dev.residents.observer;

import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * A token bucket per consumer for {@code /v1/query}: {@code burst} tokens, refilled at
 * {@code perMinute} tokens per minute. Each kind costs its {@link QueryVocabulary.Kind#cost}. At most
 * one bucket per configured consumer, so memory is bounded by the config. Thread-safe and pure.
 */
final class RateLimiter {

    private final double capacity;
    private final double perNano;
    private final LongSupplier nanos;
    private final Map<String, Bucket> buckets = new HashMap<>();

    private static final class Bucket {
        double tokens;
        long lastNanos;
    }

    RateLimiter(int perMinute, int burst, LongSupplier nanos) {
        this.capacity = burst;
        this.perNano = perMinute / 60_000_000_000.0;
        this.nanos = nanos;
    }

    /** 0 when admitted (tokens taken); otherwise whole seconds until {@code cost} tokens are available. */
    synchronized long acquire(String consumer, int cost) {
        long now = nanos.getAsLong();
        Bucket b = buckets.computeIfAbsent(consumer, k -> {
            Bucket fresh = new Bucket();
            fresh.tokens = capacity;
            fresh.lastNanos = now;
            return fresh;
        });
        b.tokens = Math.min(capacity, b.tokens + Math.max(0L, now - b.lastNanos) * perNano);
        b.lastNanos = now;
        double need = Math.min(cost, capacity);
        if (b.tokens >= need) {
            b.tokens -= need;
            return 0;
        }
        return Math.max(1L, (long) Math.ceil((need - b.tokens) / perNano / 1_000_000_000.0));
    }
}
