package dev.residents.observer;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
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
 * HTTP front of the bridge. Handlers serialize immutable observations or enqueue bounded tick reads,
 * never touching game objects. Long polls and tick waits use separate bounded pools, so they cannot
 * consume the normal snapshot/status handler pool. Every endpoint is GET except {@code PUT /v1/watch},
 * which replaces the bridge's in-memory watch list (never the world).
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
    public static final int MAX_SHELF_PAGE = 200;
    static final int HANDLER_THREADS = 2;
    static final int HANDLER_QUEUE = 16;
    /** Watch pushes: a token bucket per consumer, separate from the query budget. */
    static final int WATCH_BURST = 10;
    static final int WATCH_PER_MINUTE = 30;
    private static final Set<String> LOOPBACK_HOSTS = Set.of("127.0.0.1", "localhost", "[::1]");
    private static final Set<String> TICK_PATHS = Set.of("/v1/sight", "/v1/library/shelf", "/v1/library/book",
            "/v1/library/shelves", "/v1/block");

    private final HttpServer server;
    private final ExecutorService executor;
    private final Sampler sampler;
    private final TokenAuth auth;
    private final LongSupplier wallMs;
    private final Consumer<String> warn;
    private final ObserverConfig config;
    private final ExecutorService eventWaiters = waitingExecutor("events", 4);
    private final ExecutorService tickWaiters = waitingExecutor("tick", 4);
    /** Player-file queries: one at a time, no queue, so a large file cannot occupy the normal handlers. */
    private final ExecutorService fileWaiters = waitingExecutor("files", 1);
    private final QueryService queries;
    private final RateLimiter limiter;
    private final RateLimiter watchLimiter;

    private ObserverHttpServer(HttpServer server, ExecutorService executor, Sampler sampler, TokenAuth auth,
                               LongSupplier wallMs, Consumer<String> warn, ObserverConfig config, PlayerFiles files) {
        this.server = server;
        this.executor = executor;
        this.sampler = sampler;
        this.auth = auth;
        this.wallMs = wallMs;
        this.warn = warn;
        this.config = config;
        this.queries = new QueryService(sampler, files);
        this.limiter = new RateLimiter(config.recording().queryRatePerMinute(), config.recording().queryBurst(), System::nanoTime);
        this.watchLimiter = new RateLimiter(WATCH_PER_MINUTE, WATCH_BURST, System::nanoTime);
    }

    /** Binds {@code config.bind():config.port()} (port 0 picks a free port, for tests) and starts serving. */
    public static ObserverHttpServer start(ObserverConfig config, int port, Sampler sampler, LongSupplier wallMs,
                                           Consumer<String> warn) throws IOException {
        return start(config, port, sampler, null, wallMs, warn);
    }

    /** As above; {@code files} serves the player-file query kinds (null: those kinds answer 503). */
    public static ObserverHttpServer start(ObserverConfig config, int port, Sampler sampler, PlayerFiles files,
                                           LongSupplier wallMs, Consumer<String> warn) throws IOException {
        InetAddress address = InetAddress.getByName(config.bind()); // a literal: no DNS lookup
        if (!address.isLoopbackAddress() && !config.allowNonLoopback()) {
            throw new IOException("non-loopback bind requires allowNonLoopback=true");
        }
        HttpServer http = HttpServer.create(new InetSocketAddress(address, port), 16);
        ExecutorService pool = boundedExecutor(HANDLER_THREADS, HANDLER_QUEUE);
        ObserverHttpServer s = new ObserverHttpServer(http, pool, sampler, new TokenAuth(config.consumers()), wallMs, warn,
                config, files);
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
        fileWaiters.shutdownNow();
        server.stop(0);
        executor.shutdownNow();
    }

    /**
     * Handler pool with a bounded queue. The JDK server hands every accepted exchange to the
     * executor before authentication, so an unbounded queue would let any local caller grow
     * memory without limit. When threads and queue are full, the exchange runs on the server's
     * dispatcher thread (CallerRunsPolicy): accepting new connections pauses until a handler
     * finishes. That is backpressure, not dropping; handlers are short (no world access, no blocking
     * besides reading a bounded body and writing a bounded response).
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
        Response response;
        try {
            Headers h = exchange.getRequestHeaders();
            ObserverConfig.ConsumerSpec consumer;
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if (h.get("Host") == null || h.get("Host").size() != 1
                    || !hostAllowed(h.getFirst("Host"), config.allowedHosts())) {
                response = new Response(403, error("forbidden", "Host is not in the configured exact hostname allowlist."));
            } else if (h.getFirst("Origin") != null || isBrowserSite(h.getFirst("Sec-Fetch-Site"))) {
                response = new Response(403, error("forbidden", "Browser requests are not accepted."));
            } else if ((consumer = auth.authenticate(h.getFirst("Authorization"))) == null) {
                exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                response = new Response(401, error("unauthorized", "Missing or unknown bearer token."));
            } else if ("PUT".equals(method) && path.equals("/v1/watch")) {
                response = putWatch(exchange, consumer);
                if (response == null) return; // answered from the tick-wait pool
            } else if (!"GET".equals(method)) {
                exchange.getResponseHeaders().set("Allow", path.equals("/v1/watch") ? "GET, PUT" : "GET");
                response = new Response(405, error("method_not_allowed",
                        "Only GET is accepted here" + (path.equals("/v1/watch") ? ", and PUT." : "; the bridge never changes the world.")));
            } else {
                String query = exchange.getRequestURI().getRawQuery();
                if (path.equals("/v1/query")) {
                    handleQuery(exchange, consumer, query);
                    return;
                }
                ExecutorService waiting = null;
                if (path.equals("/v1/events") && queryNumber(query, "wait", 0, 25) > 0) {
                    if (!readsEvents(consumer)) {
                        send(exchange, forbidden("events"));
                        return;
                    }
                    waiting = eventWaiters;
                } else if (TICK_PATHS.contains(path)) {
                    Scope required = path.equals("/v1/sight") ? Scope.RESIDENTS
                            : path.equals("/v1/block") ? Scope.FACILITIES : Scope.LIBRARY;
                    if (!consumer.has(required)) {
                        send(exchange, forbidden(required.id()));
                        return;
                    }
                    waiting = tickWaiters;
                }
                if (waiting != null) {
                    try {
                        waiting.execute(() -> send(exchange, routeSafely(consumer, path, query)));
                    } catch (RejectedExecutionException e) {
                        send(exchange, new Response(503, error("busy", "The bounded request wait pool is full; retry later.")));
                    }
                    return;
                }
                response = routeSafely(consumer, path, query);
            }
        } catch (IllegalArgumentException e) {
            response = new Response(400, error("bad_request", "Invalid query parameters."));
        } catch (Throwable t) {
            warn.accept("request failed: " + Sampler.describe(t));
            response = new Response(500, error("internal", "The observer failed to answer; see the server log."));
        }
        send(exchange, response);
    }

    /** {@code retryAfter}: seconds for a Retry-After header, or 0 for none. */
    private record Response(int status, JsonObject body, long retryAfter) {
        Response(int status, JsonObject body) {
            this(status, body, 0);
        }
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
                if (!readsEvents(consumer)) return forbidden("events");
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
                Map<String, String> p = strictParams(query, "from", "to");
                WatchList watch = sampler.watch();
                WatchList.ResidentSpec from = watch.resident(p.get("from"));
                WatchList.ResidentSpec to = watch.resident(p.get("to"));
                if (from == null || to == null) {
                    return new Response(400, error("bad_request", "from and to must name watched residents"
                            + (watch.revision() == null ? " (Commons has not pushed a watch list since the server started)." : ".")));
                }
                return tickRead(consumer, "sight", bridge -> bridge.sight(from, to));
            }
            case "/v1/block" -> {
                if (!consumer.has(Scope.FACILITIES)) return forbidden("facilities");
                Map<String, String> p = strictParams(query, "dimension", "pos");
                Positions.At at = Positions.parse(p.get("dimension"), p.get("pos"));
                Observations.BlockRead read;
                try {
                    read = awaitTick(bridge -> {
                        try {
                            return bridge.block(at.dimension(), at.x(), at.y(), at.z());
                        } catch (RuntimeException e) { // a modded capability's failure is this read's answer, not a tick failure
                            return new Observations.BlockRead(Observations.FacilityStatus.ERROR, Sampler.describe(e), null, null);
                        }
                    });
                } catch (QueryVocabulary.Refused e) {
                    return new Response(e.status, error(e.code, e.getMessage()));
                }
                now = wallMs.getAsLong();
                return new Response(200, JsonViews.block(consumer, at, read, sampler.state(now), now, sampler.heartbeatAtMs()));
            }
            case "/v1/library/shelf" -> {
                if (!consumer.has(Scope.LIBRARY)) return forbidden("library");
                Map<String, String> p = strictParams(query, "dimension", "pos");
                Positions.At at = Positions.parse(p.get("dimension"), p.get("pos"));
                return tickRead(consumer, "shelf", bridge -> Library.shelf(at, place(bridge, at, false)));
            }
            case "/v1/library/book" -> {
                if (!consumer.has(Scope.LIBRARY)) return forbidden("library");
                Map<String, String> p = strictParams(query, "dimension", "pos", "slot");
                Positions.At at = Positions.parse(p.get("dimension"), p.get("pos"));
                String rawSlot = p.get("slot");
                if (rawSlot == null || !rawSlot.matches("[0-5]")) throw new IllegalArgumentException("slot");
                int slot = Integer.parseInt(rawSlot);
                return tickRead(consumer, "book", bridge -> Library.book(at, slot, place(bridge, at, true)));
            }
            case "/v1/library/shelves" -> {
                if (!consumer.has(Scope.LIBRARY)) return forbidden("library");
                return shelves(consumer, query);
            }
            case "/v1/watch" -> {
                if (!consumer.has(Scope.STATUS) && !consumer.has(Scope.WATCH)) return forbidden("status");
                return new Response(200, JsonViews.watch(consumer, sampler.watch(), sampler.bootId(), state, now, heartbeat));
            }
            case "/v1/queries" -> {
                if (!consumer.has(Scope.RESIDENTS) && !consumer.has(Scope.FACILITIES) && !consumer.has(Scope.SELF)) {
                    return new Response(403, error("forbidden", "This token has no residents, facilities or self scope."));
                }
                JsonObject o = JsonViews.header(consumer, state, now, heartbeat);
                o.add("queries", QueryVocabulary.describe(consumer, config, sampler.watch()));
                return new Response(200, o);
            }
            case "/v1/status" -> {
                if (!consumer.has(Scope.STATUS)) return forbidden("status");
                JsonObject o = JsonViews.status(consumer, sampler.status(), sampler.events(), state, now, heartbeat);
                o.add("queries", queries.metrics());
                return new Response(200, o);
            }
            default -> {
                return new Response(404, error("not_found", "Unknown observer endpoint."));
            }
        }
    }

    /**
     * Tick thread: what stands at a position; an unexpected failure is that read's {@code error}, not a tick failure.
     * {@code pages}: a book read needs page text; a shelf read needs only each book's metadata, so it uses the scan's
     * memo (books seen unchanged are not decoded again; new ones are, all six at most, in this one read).
     */
    private static BridgeAccess.Place place(BridgeAccess bridge, Positions.At at, boolean pages) {
        try {
            return pages ? bridge.place(at.dimension(), at.x(), at.y(), at.z())
                    : bridge.scanPlace(at.dimension(), at.x(), at.y(), at.z(), Library.SHELF_SLOTS).place();
        } catch (RuntimeException e) {
            return new BridgeAccess.Place(BridgeAccess.Where.LOADED, null, BridgeAccess.Holder.NONE, List.of(),
                    "read failed: " + Sampler.describe(e));
        }
    }

    /**
     * {@code GET /v1/library/shelves}: a page of the latest scan if it is at most {@link ShelfScan#MAX_AGE_MS}
     * old. Otherwise the request asks for a scan and waits (on the tick-wait pool) up to the request timeout;
     * a scan still running then answers 503 {@code scanning} with Retry-After. Age counts from the scan's end.
     */
    private Response shelves(ObserverConfig.ConsumerSpec consumer, String query) {
        Map<String, String> p = strictParams(query, "after", "limit");
        String rawLimit = p.get("limit");
        if (rawLimit != null && !rawLimit.matches("[0-9]{1,3}")) throw new IllegalArgumentException("limit");
        int limit = rawLimit == null ? 100 : Integer.parseInt(rawLimit);
        if (limit < 1 || limit > MAX_SHELF_PAGE) throw new IllegalArgumentException("limit");
        Library.Item after = p.get("after") == null ? null : Library.fromCursor(p.get("after"));
        ShelfScan scan = sampler.shelves();
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(config.requestTimeoutMs());
        ShelfScan.Index index;
        while (true) {
            long now = wallMs.getAsLong();
            scan.demand(now);
            index = scan.fresh(now);
            String state = sampler.state(now).id();
            if (index != null) break;
            if (state.equals("paused") || state.equals("tripped")) {
                return new Response(503, error(state, "The observer is " + state + "; shelves are not scanned."));
            }
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                return new Response(503, error("scanning", "No shelf scan finished in the last " + ShelfScan.MAX_AGE_MS / 1000
                        + " s; one is running. Retry shortly."), 2);
            }
            if (Thread.currentThread().isInterrupted()) return new Response(503, error("stopped", "The observer is stopping."));
            LockSupport.parkNanos(Math.min(remaining, TimeUnit.MILLISECONDS.toNanos(50)));
        }
        long now = wallMs.getAsLong();
        return new Response(200, JsonViews.shelves(consumer, index, Library.page(index.items(), after, limit),
                sampler.state(now), now, sampler.heartbeatAtMs()));
    }

    private static Response forbidden(String scope) {
        return new Response(403, error("forbidden", "This token has no " + scope + " scope."));
    }

    private <T> Response tickRead(ObserverConfig.ConsumerSpec consumer, String key, Function<BridgeAccess, T> read) {
        T value;
        try {
            value = awaitTick(read);
        } catch (QueryVocabulary.Refused e) {
            return new Response(e.status, error(e.code, e.getMessage()));
        }
        long now = wallMs.getAsLong();
        return new Response(200, JsonViews.bridge(consumer, key, value, sampler.state(now), now, sampler.heartbeatAtMs()));
    }

    // === PUT /v1/watch ===

    /**
     * Scope, content type, size, rate, then strict parsing on this handler thread; the swap itself happens at
     * the next tick, awaited on the tick-wait pool. Returns null when the reply is sent from that pool.
     */
    private Response putWatch(HttpExchange exchange, ObserverConfig.ConsumerSpec consumer) throws IOException {
        if (!consumer.has(Scope.WATCH)) return forbidden("watch");
        if (!jsonContentType(exchange.getRequestHeaders().getFirst("Content-Type"))) {
            return new Response(415, error("unsupported_media_type", "The watch list must be sent as application/json (UTF-8)."));
        }
        String length = exchange.getRequestHeaders().getFirst("Content-Length");
        if (length != null && (!length.matches("[0-9]{1,12}") || Long.parseLong(length) > WatchList.MAX_BODY_BYTES)) {
            return new Response(413, error("too_large", "The watch list may be at most " + WatchList.MAX_BODY_BYTES + " bytes."));
        }
        long retryAfter = watchLimiter.acquire(consumer.name(), 1);
        if (retryAfter > 0) {
            return new Response(429, error("rate_limited", "Watch pushes are limited; retry after " + retryAfter + " s."), retryAfter);
        }
        byte[] bytes;
        try (InputStream in = exchange.getRequestBody()) {
            bytes = in.readNBytes(WatchList.MAX_BODY_BYTES + 1);
        }
        if (bytes.length > WatchList.MAX_BODY_BYTES) {
            return new Response(413, error("too_large", "The watch list may be at most " + WatchList.MAX_BODY_BYTES + " bytes."));
        }
        WatchList list;
        try {
            list = WatchList.parse(utf8(bytes));
        } catch (WatchList.Invalid e) {
            return new Response(400, error("bad_request", "Watch list refused, nothing changed: " + e.getMessage()));
        }
        CompletableFuture<WatchList> applied;
        try {
            applied = sampler.offerWatch(list);
        } catch (TickRequests.Unavailable e) {
            return new Response(503, error(e.code, "The observer is " + e.code + "; the watch list was not taken."));
        }
        try {
            tickWaiters.execute(() -> send(exchange, awaitWatch(consumer, applied)));
        } catch (RejectedExecutionException e) {
            // The list stays queued and is applied at the next tick; only the wait for it is refused.
            return new Response(202, JsonViews.watch(consumer, sampler.watch(), sampler.bootId(),
                    sampler.state(wallMs.getAsLong()), wallMs.getAsLong(), sampler.heartbeatAtMs()));
        }
        return null;
    }

    private Response awaitWatch(ObserverConfig.ConsumerSpec consumer, CompletableFuture<WatchList> applied) {
        try {
            WatchList list = applied.get(config.requestTimeoutMs(), TimeUnit.MILLISECONDS);
            long now = wallMs.getAsLong();
            return new Response(200, JsonViews.watch(consumer, list, sampler.bootId(), sampler.state(now), now, sampler.heartbeatAtMs()));
        } catch (TimeoutException e) {
            return new Response(504, error("timeout", "Taken but not applied within the request timeout; it is applied at the "
                    + "next tick unless a newer list replaces it. Check GET /v1/watch."));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Response(503, error("stopped", "The observer is stopping."));
        } catch (ExecutionException e) {
            if (e.getCause() instanceof TickRequests.Unavailable u) {
                return u.code.equals("superseded")
                        ? new Response(409, error("superseded", "A newer watch list arrived before this one was applied."))
                        : new Response(503, error(u.code, "The observer is " + u.code + "; the watch list was not applied."));
            }
            return new Response(500, error("apply_failed", "Applying the watch list failed; see the server log."));
        }
    }

    static boolean jsonContentType(String header) {
        if (header == null) return false;
        String[] parts = header.split(";");
        if (!parts[0].strip().equalsIgnoreCase("application/json")) return false;
        for (int i = 1; i < parts.length; i++) {
            String param = parts[i].strip().toLowerCase(Locale.ROOT);
            if (param.startsWith("charset=") && !param.equals("charset=utf-8") && !param.equals("charset=\"utf-8\"")) return false;
        }
        return true;
    }

    /** Strict UTF-8: malformed bytes are refused, never replaced. */
    private static String utf8(byte[] bytes) throws WatchList.Invalid {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new WatchList.Invalid("the body is not valid UTF-8");
        }
    }

    // === /v1/query: validate, rate-limit, then run on the pool its kind needs ===

    private void handleQuery(HttpExchange exchange, ObserverConfig.ConsumerSpec consumer, String rawQuery) {
        QueryVocabulary.Request request;
        try {
            request = QueryVocabulary.parse(rawQuery, consumer, sampler.watch());
        } catch (QueryVocabulary.Refused e) {
            queries.countRefused();
            limiter.acquire(consumer.name(), 1); // refused requests still spend the caller's budget
            send(exchange, new Response(e.status, error(e.code, e.getMessage())));
            return;
        }
        String state = sampler.state(wallMs.getAsLong()).id();
        if (state.equals("paused") || state.equals("tripped")) {
            send(exchange, new Response(503, error(state, "The observer is " + state + "; queries are off.")));
            return;
        }
        long retryAfter = limiter.acquire(consumer.name(), request.kind().cost);
        if (retryAfter > 0) {
            queries.countRateLimited();
            send(exchange, new Response(429, error("rate_limited", "Query rate limit reached; retry after " + retryAfter + " s."), retryAfter));
            return;
        }
        ExecutorService pool = switch (request.kind().exec) {
            case TICK -> tickWaiters;
            case FILE -> fileWaiters;
            case RING, CATALOG -> null;
        };
        Runnable work = () -> send(exchange, answerQuery(consumer, request));
        if (pool == null) {
            work.run();
            return;
        }
        try {
            pool.execute(work);
        } catch (RejectedExecutionException e) {
            send(exchange, new Response(503, error("busy", "The bounded query pool is full; retry later.")));
        }
    }

    private Response answerQuery(ObserverConfig.ConsumerSpec consumer, QueryVocabulary.Request request) {
        try {
            JsonObject query = queries.answer(request, this::awaitTick);
            long now = wallMs.getAsLong();
            JsonObject body = JsonViews.header(consumer, sampler.state(now), now, sampler.heartbeatAtMs());
            body.add("query", query);
            String text = JsonViews.toJson(body);
            if (text.length() > QueryService.MAX_REPLY_BYTES / 2 && text.getBytes(StandardCharsets.UTF_8).length > QueryService.MAX_REPLY_BYTES) {
                queries.countTooLarge();
                return new Response(413, error("too_large", "The reply would exceed " + QueryService.MAX_REPLY_BYTES + " bytes; lower limit."));
            }
            return new Response(200, body);
        } catch (QueryVocabulary.Refused e) {
            return new Response(e.status, error(e.code, e.getMessage()));
        } catch (Throwable t) {
            warn.accept("query failed: " + Sampler.describe(t));
            return new Response(500, error("internal", "The query failed; see the server log."));
        }
    }

    /** The bounded tick queue, its timeout and failure policy, for every tick-thread read. Failures are {@link QueryVocabulary.Refused}. */
    private <T> T awaitTick(Function<BridgeAccess, T> job) {
        TickRequests.Ticket<T> ticket = null;
        try {
            ticket = sampler.request(job);
            return ticket.result.get(config.requestTimeoutMs(), TimeUnit.MILLISECONDS);
        } catch (TickRequests.Unavailable e) {
            throw new QueryVocabulary.Refused(e.code.equals("timeout") ? 504 : 503, e.code, "The tick reader is " + e.code + ".");
        } catch (TimeoutException e) {
            throw new QueryVocabulary.Refused(504, "timeout", "No tick result within the configured request timeout.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new QueryVocabulary.Refused(503, "stopped", "The observer is stopping.");
        } catch (ExecutionException e) {
            if (e.getCause() instanceof TickRequests.Unavailable u) {
                throw new QueryVocabulary.Refused(u.code.equals("timeout") ? 504 : 503, u.code, "The tick reader is " + u.code + ".");
            }
            throw new QueryVocabulary.Refused(500, "read_failed", "The tick read failed; see the server log.");
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

    private void send(HttpExchange exchange, Response r) {
        try {
            byte[] bytes = JsonViews.toJson(r.body()).getBytes(StandardCharsets.UTF_8);
            Headers out = exchange.getResponseHeaders();
            out.set("Content-Type", "application/json; charset=utf-8");
            out.set("Cache-Control", "no-store");
            out.set("X-Content-Type-Options", "nosniff");
            if (r.retryAfter() > 0) out.set("Retry-After", Long.toString(r.retryAfter()));
            exchange.sendResponseHeaders(r.status(), bytes.length);
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

    /** Like {@link #queryValue}, and any parameter not in {@code allowed} is refused (so a removed form fails loudly). */
    static Map<String, String> strictParams(String rawQuery, String... allowed) {
        Map<String, String> out = new HashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) return out;
        if (rawQuery.length() > 2048) throw new IllegalArgumentException();
        String[] parts = rawQuery.split("&", -1);
        if (parts.length > 8) throw new IllegalArgumentException();
        List<String> names = List.of(allowed);
        for (String part : parts) {
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            if (!names.contains(k)) throw new IllegalArgumentException("unknown parameter");
            String value = URLDecoder.decode(eq < 0 ? "" : part.substring(eq + 1), StandardCharsets.UTF_8);
            if (out.put(k, value) != null) throw new IllegalArgumentException("repeated parameter");
        }
        return out;
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
