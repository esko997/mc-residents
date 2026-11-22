package dev.residents.observer;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Loopback-only, GET-only HTTP front of the observer. Handlers never touch the game: they read
 * the {@link Sampler}'s published immutable values and serialize them for the caller's scopes.
 * There is deliberately no endpoint that writes, runs a command, or reaches the world.
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

    private ObserverHttpServer(HttpServer server, ExecutorService executor, Sampler sampler, TokenAuth auth,
                               LongSupplier wallMs, Consumer<String> warn) {
        this.server = server;
        this.executor = executor;
        this.sampler = sampler;
        this.auth = auth;
        this.wallMs = wallMs;
        this.warn = warn;
    }

    /** Binds {@code config.bind():config.port()} (port 0 picks a free port, for tests) and starts serving. */
    public static ObserverHttpServer start(ObserverConfig config, int port, Sampler sampler, LongSupplier wallMs,
                                           Consumer<String> warn) throws IOException {
        InetAddress address = InetAddress.getByName(config.bind()); // a literal: no DNS lookup
        if (!address.isLoopbackAddress()) {
            throw new IOException("refusing non-loopback bind " + config.bind());
        }
        HttpServer http = HttpServer.create(new InetSocketAddress(address, port), 16);
        ExecutorService pool = boundedExecutor(HANDLER_THREADS, HANDLER_QUEUE);
        ObserverHttpServer s = new ObserverHttpServer(http, pool, sampler, new TokenAuth(config.consumers()), wallMs, warn);
        http.createContext("/", s::handle);
        http.setExecutor(pool);
        http.start();
        return s;
    }

    public int port() {
        return server.getAddress().getPort();
    }

    public void stop() {
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

    private void handle(HttpExchange exchange) {
        int status;
        JsonObject body;
        try {
            Headers h = exchange.getRequestHeaders();
            ObserverConfig.ConsumerSpec consumer;
            if (!hostAllowed(h.getFirst("Host"))) {
                status = 403;
                body = error("forbidden", "Host must be a loopback name (127.0.0.1, localhost, [::1]); this blocks DNS rebinding.");
            } else if (h.getFirst("Origin") != null || isBrowserSite(h.getFirst("Sec-Fetch-Site"))) {
                status = 403;
                body = error("forbidden", "Browser requests are not accepted; the observer is for local programs.");
            } else if ((consumer = auth.authenticate(h.getFirst("Authorization"))) == null) {
                status = 401;
                exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                body = error("unauthorized", "Missing or unknown bearer token.");
            } else if (!"GET".equals(exchange.getRequestMethod())) {
                status = 405;
                exchange.getResponseHeaders().set("Allow", "GET");
                body = error("method_not_allowed", "The observer is read-only; only GET is accepted.");
            } else {
                Response r = route(consumer, exchange.getRequestURI().getPath(), exchange.getRequestURI().getRawQuery());
                status = r.status;
                body = r.body;
            }
        } catch (Throwable t) {
            warn.accept("request failed: " + Sampler.describe(t));
            status = 500;
            body = error("internal", "The observer failed to answer; see the server log.");
        }
        send(exchange, status, body);
    }

    private record Response(int status, JsonObject body) {
    }

    private Response route(ObserverConfig.ConsumerSpec consumer, String path, String query) {
        long now = wallMs.getAsLong();
        long heartbeat = sampler.heartbeatAtMs();
        Sampler.State state = sampler.state(now);
        boolean readsWorld = consumer.has(Scope.RESIDENTS) || consumer.has(Scope.FACILITIES) || consumer.has(Scope.SELF);
        switch (path) {
            case "/v1/snapshot" -> {
                if (!readsWorld) {
                    return new Response(403, error("forbidden", "This token has no residents, facilities or self scope."));
                }
                return new Response(200, JsonViews.snapshot(consumer, sampler.snapshot(), state, now, heartbeat));
            }
            case "/v1/events" -> {
                if (!readsWorld) {
                    return new Response(403, error("forbidden", "This token has no residents, facilities or self scope."));
                }
                long after;
                int limit;
                try {
                    after = Long.parseLong(queryValue(query, "after", "0"));
                    limit = Integer.parseInt(queryValue(query, "limit", "100"));
                } catch (NumberFormatException e) {
                    return new Response(400, error("bad_request", "after and limit must be whole numbers."));
                }
                if (after < 0 || limit < 1 || limit > MAX_EVENT_PAGE) {
                    return new Response(400, error("bad_request", "after must be >= 0 and limit 1.." + MAX_EVENT_PAGE + "."));
                }
                return new Response(200, JsonViews.events(consumer, sampler.events(), after, limit, state, now, heartbeat));
            }
            case "/v1/status" -> {
                if (!consumer.has(Scope.STATUS)) {
                    return new Response(403, error("forbidden", "This token has no status scope."));
                }
                return new Response(200, JsonViews.status(consumer, sampler.status(), sampler.events(), state, now, heartbeat));
            }
            default -> {
                return new Response(404, error("not_found", "Unknown path. Endpoints: /v1/snapshot, /v1/events, /v1/status."));
            }
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
     * The Host header must name a loopback host. The port is not checked: an SSH tunnel may
     * forward a different local port, and DNS rebinding is defeated by the host name alone.
     */
    static boolean hostAllowed(String host) {
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
        return LOOPBACK_HOSTS.contains(name);
    }

    static boolean isBrowserSite(String secFetchSite) {
        // Any Sec-Fetch-Site value means a browser made the request; local programs send none.
        return secFetchSite != null && !secFetchSite.isBlank();
    }

    /** The decoded-free value of {@code key} in a raw query; only digits are ever expected here. */
    static String queryValue(String rawQuery, String key, String fallback) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return fallback;
        }
        for (String part : rawQuery.split("&")) {
            int eq = part.indexOf('=');
            String k = eq < 0 ? part : part.substring(0, eq);
            if (k.equals(key)) {
                return eq < 0 ? "" : part.substring(eq + 1);
            }
        }
        return fallback;
    }
}
