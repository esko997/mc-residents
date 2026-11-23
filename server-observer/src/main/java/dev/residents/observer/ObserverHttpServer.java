package dev.residents.observer;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Function;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * GET-only HTTP front of the bridge. Handlers serialize immutable observations or enqueue
 * bounded tick reads, never touching game objects. Long polls and tick waits use separate
 * bounded pools, so they cannot consume the normal snapshot/status handler pool.
 */
public final class ObserverHttpServer {

    static {
        // Bound slow requests (headers/body) so a stalled client cannot hold one of the two
        // handler threads. JVM-wide JDK HttpServer setting; only set when nobody else has.
        if (System.getProperty("sun.net.httpserver.maxReqTime") == null) {
            System.setProperty("sun.net.httpserver.maxReqTime", "30");
        }
    }

    public static final int MAX_EVENT_PAGE = 500;
    static final int HANDLER_THREADS = 2;
    static final int HANDLER_QUEUE = 16;
    private static final Set<String> LOOPBACK_HOSTS = Set.of("127.0.0.1", "localhost", "[::1]");

    private final HttpServer server;
    private final ExecutorService executor;
    private final Sampler sampler;
    private final TokenAuth auth;
    private final LongSupplier wallMs;
    private final Consumer<String> warn;
    private final ObserverConfig config;
    private final ExecutorService eventWaiters = waitingExecutor("events", 4);
    private final ExecutorService tickWaiters = waitingExecutor("tick", 4);

    private ObserverHttpServer(HttpServer server, ExecutorService executor, Sampler sampler, TokenAuth auth,
                               LongSupplier wallMs, Consumer<String> warn, ObserverConfig config) {
        this.server = server;
        this.executor = executor;
        this.sampler = sampler;
        this.auth = auth;
        this.wallMs = wallMs;
        this.warn = warn;
        this.config = config;
    }

    /** Binds {@code config.bind():config.port()} (port 0 picks a free port, for tests) and starts serving. */
    public static ObserverHttpServer start(ObserverConfig config, int port, Sampler sampler, LongSupplier wallMs,
                                           Consumer<String> warn) throws IOException {
        InetAddress address = InetAddress.getByName(config.bind()); // a literal: no DNS lookup
        if (!address.isLoopbackAddress() && !config.allowNonLoopback()) {
            throw new IOException("non-loopback bind requires allowNonLoopback=true");
        }
        HttpServer http = HttpServer.create(new InetSocketAddress(address, port), 16);
        ExecutorService pool = boundedExecutor(HANDLER_THREADS, HANDLER_QUEUE);
        ObserverHttpServer s = new ObserverHttpServer(http, pool, sampler, new TokenAuth(config.consumers()), wallMs, warn, config);
        http.createContext("/", s::handle);
        http.setExecutor(pool);
        http.start();
        return s;
    }

    public int port() {
        return server.getAddress().getPort();
    }

    public void stop() {
        sampler.stop();
        eventWaiters.shutdownNow();
        tickWaiters.shutdownNow();
        server.stop(0);
        executor.shutdownNow();
    }

    /**
     * Handler pool with a bounded queue. The JDK server hands every accepted exchange to the
     * executor before authentication, so an unbounded queue would let any local caller grow
     * memory without limit. When threads and queue are full, the exchange runs on the server's
     * dispatcher thread (CallerRunsPolicy): accepting new connections pauses until a handler
     * finishes. That is backpressure, not dropping; handlers are short (no world access, no blocking
     * besides writing a bounded response).
     */
    static ThreadPoolExecutor boundedExecutor(int threads, int queueCapacity) {
        AtomicInteger n = new AtomicInteger(1);
        return new ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), r -> {
                    Thread t = new Thread(r, "resident-observer-http-" + n.getAndIncrement());
                    t.setDaemon(true);
                    return t;
                }, new ThreadPoolExecutor.CallerRunsPolicy());
    }

    /** No queue: a saturated waiting pool returns 503 rather than parking normal handlers. */
    private static ExecutorService waitingExecutor(String kind, int threads) {
        AtomicInteger n = new AtomicInteger();
        return new ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS,
                new SynchronousQueue<>(), r -> {
                    Thread t = new Thread(r, "resident-observer-" + kind + "-" + n.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    private void handle(HttpExchange exchange) {
        int status;
        JsonObject body;
        try {
            Headers h = exchange.getRequestHeaders();
            ObserverConfig.ConsumerSpec consumer;
            if (h.get("Host") == null || h.get("Host").size() != 1
                    || !hostAllowed(h.getFirst("Host"), config.allowedHosts())) {
                status = 403;
                body = error("forbidden", "Host is not in the configured exact hostname allowlist.");
            } else if (h.getFirst("Origin") != null || isBrowserSite(h.getFirst("Sec-Fetch-Site"))) {
                status = 403;
                body = error("forbidden", "Browser requests are not accepted.");
            } else if ((consumer = auth.authenticate(h.getFirst("Authorization"))) == null) {
                status = 401;
                exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                body = error("unauthorized", "Missing or unknown bearer token.");
            } else if (!"GET".equals(exchange.getRequestMethod())) {
                status = 405;
                exchange.getResponseHeaders().set("Allow", "GET");
                body = error("method_not_allowed", "The observer is read-only; only GET is accepted.");
            } else {
                String path = exchange.getRequestURI().getPath();
                String query = exchange.getRequestURI().getRawQuery();
                ExecutorService waiting = null;
                if (path.equals("/v1/events") && queryNumber(query, "wait", 0, 25) > 0) {
                    if (!readsEvents(consumer)) {
                        send(exchange, 403, error("forbidden", "This token has no event scope."));
                        return;
                    }
                    waiting = eventWaiters;
                } else if (path.equals("/v1/sight") || path.equals("/v1/library/shelf") || path.equals("/v1/library/book")) {
                    Scope required = path.equals("/v1/sight") ? Scope.RESIDENTS : Scope.LIBRARY;
                    if (!consumer.has(required)) {
                        send(exchange, 403, error("forbidden", "This token has no " + required.id() + " scope."));
                        return;
                    }
                    waiting = tickWaiters;
                }
                if (waiting != null) {
                    try {
                        waiting.execute(() -> {
                            Response r = routeSafely(consumer, path, query);
                            send(exchange, r.status, r.body);
                        });
                    } catch (RejectedExecutionException e) {
                        send(exchange, 503, error("busy", "The bounded request wait pool is full; retry later."));
                    }
                    return;
                }
                Response r = routeSafely(consumer, path, query);
                status = r.status;
                body = r.body;
            }
        } catch (IllegalArgumentException e) {
            status = 400;
            body = error("bad_request", "Invalid query parameters.");
        } catch (Throwable t) {
            warn.accept("request failed: " + Sampler.describe(t));
            status = 500;
            body = error("internal", "The observer failed to answer; see the server log.");
        }
        send(exchange, status, body);
    }

    private record Response(int status, JsonObject body) {
    }

    private Response routeSafely(ObserverConfig.ConsumerSpec consumer, String path, String query) {
        try {
            return route(consumer, path, query);
        } catch (IllegalArgumentException e) {
            return new Response(400, error("bad_request", "Invalid query parameters."));
        } catch (Throwable t) {
            warn.accept("request failed: " + t.getClass().getSimpleName());
            return new Response(500, error("internal", "The observer failed to answer; see the server log."));
        }
    }

    private static boolean readsEvents(ObserverConfig.ConsumerSpec c) {
        return c.has(Scope.RESIDENTS) || c.has(Scope.FACILITIES) || c.has(Scope.SELF) || c.has(Scope.LIBRARY);
    }

    private Response route(ObserverConfig.ConsumerSpec consumer, String path, String query) {
        long now = wallMs.getAsLong();
        long heartbeat = sampler.heartbeatAtMs();
        Sampler.State state = sampler.state(now);
        switch (path) {
            case "/v1/snapshot" -> {
                if (!consumer.has(Scope.RESIDENTS) && !consumer.has(Scope.FACILITIES) && !consumer.has(Scope.SELF)) {
                    return new Response(403, error("forbidden", "This token has no residents, facilities or self scope."));
                }
                return new Response(200, JsonViews.snapshot(consumer, sampler.snapshot(), state, now, heartbeat));
            }
            case "/v1/events" -> {
                if (!readsEvents(consumer)) {
                    return new Response(403, error("forbidden", "This token has no event scope."));
                }
                long after = queryNumber(query, "after", 0, Long.MAX_VALUE);
                int limit = (int) queryNumber(query, "limit", 100, MAX_EVENT_PAGE);
                int wait = (int) queryNumber(query, "wait", 0, 25);
                if (limit == 0) throw new IllegalArgumentException();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(wait);
                EventLog.View view;
                // Only request threads park. The tick publishes lock-free and is never held by a waiter.
                while (true) {
                    view = sampler.events();
                    long remaining = deadline - System.nanoTime();
                    state = sampler.state(wallMs.getAsLong());
                    if (view.latestSeq() != after || remaining <= 0
                            || state.id().equals("paused") || state.id().equals("tripped")) break;
                    if (Thread.currentThread().isInterrupted()) {
                        return new Response(503, error("stopped", "The observer is stopping."));
                    }
                    LockSupport.parkNanos(Math.min(remaining, TimeUnit.MILLISECONDS.toNanos(100)));
                }
                now = wallMs.getAsLong();
                return new Response(200, JsonViews.events(consumer, view, after, limit,
                        sampler.state(now), now, sampler.heartbeatAtMs()));
            }
            case "/v1/sight" -> {
                if (!consumer.has(Scope.RESIDENTS)) return forbidden("residents");
                ObserverConfig.ResidentSpec from = config.resident(queryValue(query, "from", ""));
                ObserverConfig.ResidentSpec to = config.resident(queryValue(query, "to", ""));
                if (from == null || to == null) {
                    return new Response(400, error("bad_request", "from and to must name configured residents."));
                }
                return tickRead(consumer, "sight", bridge -> bridge.sight(from, to));
            }
            case "/v1/library/shelf", "/v1/library/book" -> {
                if (!consumer.has(Scope.LIBRARY)) return forbidden("library");
                ObserverConfig.FacilitySpec facility = config.facility(queryValue(query, "facility", ""));
                if (facility == null || !facility.library()) {
                    return new Response(404, error("not_found", "No registered library shelf with that id."));
                }
                if (path.equals("/v1/library/shelf")) {
                    return tickRead(consumer, "shelf", bridge -> bridge.shelf(facility));
                }
                int slot = (int) queryNumber(query, "slot", -1, 5);
                if (slot < 0) throw new IllegalArgumentException();
                return tickRead(consumer, "book", bridge -> bridge.book(facility, slot));
            }
            case "/v1/status" -> {
                if (!consumer.has(Scope.STATUS)) return forbidden("status");
                return new Response(200, JsonViews.status(consumer, sampler.status(), sampler.events(), state, now, heartbeat));
            }
            default -> {
                return new Response(404, error("not_found", "Unknown observer endpoint."));
            }
        }
    }

    private static Response forbidden(String scope) {
        return new Response(403, error("forbidden", "This token has no " + scope + " scope."));
    }

    private <T> Response tickRead(ObserverConfig.ConsumerSpec consumer, String key, Function<BridgeAccess, T> read) {
        TickRequests.Ticket<T> ticket = null;
        try {
            ticket = sampler.request(read);
            T value = ticket.result.get(config.requestTimeoutMs(), TimeUnit.MILLISECONDS);
            long now = wallMs.getAsLong();
            return new Response(200, JsonViews.bridge(consumer, key, value, sampler.state(now), now, sampler.heartbeatAtMs()));
        } catch (TickRequests.Unavailable e) {
            return new Response(503, error(e.code, "The tick reader is " + e.code + "."));
        } catch (TimeoutException e) {
            return new Response(504, error("timeout", "No tick result within the configured request timeout."));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Response(503, error("stopped", "The observer is stopping."));
        } catch (ExecutionException e) {
            if (e.getCause() instanceof TickRequests.Unavailable unavailable) {
                return new Response(unavailable.code.equals("timeout") ? 504 : 503,
                        error(unavailable.code, "The tick reader is " + unavailable.code + "."));
            }
            return new Response(500, error("read_failed", "The tick read failed; see the server log."));
        } finally {
            if (ticket != null) ticket.cancel();
        }
    }

    private static JsonObject error(String code, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", JsonViews.SCHEMA);
        o.addProperty("source", JsonViews.SOURCE);
        JsonObject e = new JsonObject();
        e.addProperty("code", code);
        e.addProperty("message", message);
        o.add("error", e);
        return o;
    }

    private void send(HttpExchange exchange, int status, JsonObject body) {
        try {
            byte[] bytes = JsonViews.toJson(body).getBytes(StandardCharsets.UTF_8);
            Headers out = exchange.getResponseHeaders();
            out.set("Content-Type", "application/json; charset=utf-8");
            out.set("Cache-Control", "no-store");
            out.set("X-Content-Type-Options", "nosniff");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        } catch (IOException e) {
            warn.accept("could not write response: " + e);
        } finally {
            exchange.close();
        }
    }

    // === pure guards (unit-tested) ===

    /**
     * Exact Host allowlist, never DNS resolution. The port is not checked: an SSH tunnel
     * may forward a different local port. Names are not suffixes or wildcard patterns.
     */
    static boolean hostAllowed(String host) {
        return hostAllowed(host, LOOPBACK_HOSTS);
    }

    static boolean hostAllowed(String host, Set<String> allowedHosts) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.strip().toLowerCase(Locale.ROOT);
        String name;
        if (h.startsWith("[")) {
            int close = h.indexOf(']');
            if (close < 0) {
                return false;
            }
            name = h.substring(0, close + 1);
            String rest = h.substring(close + 1);
            if (!rest.isEmpty() && !rest.matches(":\\d{1,5}")) {
                return false;
            }
        } else {
            int colon = h.indexOf(':');
            name = colon < 0 ? h : h.substring(0, colon);
            if (colon >= 0 && !h.substring(colon).matches(":\\d{1,5}")) {
                return false;
            }
        }
        return allowedHosts.contains(name);
    }

    static boolean isBrowserSite(String secFetchSite) {
        // Any Sec-Fetch-Site value means a browser made the request; local programs send none.
        return secFetchSite != null;
    }

    /** Decode exactly once; bound parsing and reject ambiguous duplicate parameters. */
    static String queryValue(String rawQuery, String key, String fallback) {
        if (rawQuery == null || rawQuery.isEmpty()) return fallback;
        if (rawQuery.length() > 2048) throw new IllegalArgumentException();
        String[] parts = rawQuery.split("&", -1);
        if (parts.length > 8) throw new IllegalArgumentException();
        String found = null;
        Set<String> seen = new java.util.HashSet<>();
        for (String part : parts) {
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            if (!seen.add(k)) throw new IllegalArgumentException();
            String value = URLDecoder.decode(eq < 0 ? "" : part.substring(eq + 1), StandardCharsets.UTF_8);
            if (k.equals(key)) found = value;
        }
        return found == null ? fallback : found;
    }

    static long queryNumber(String query, String key, long fallback, long max) {
        String value = queryValue(query, key, null);
        if (value == null) return fallback;
        if (!value.matches("[0-9]+")) throw new IllegalArgumentException();
        long parsed = Long.parseLong(value);
        if (parsed > max) throw new IllegalArgumentException();
        return parsed;
    }
}
