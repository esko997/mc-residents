package dev.residents.observer;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The real JDK server on an ephemeral loopback port, driven with raw requests so every header is ours. */
class ObserverHttpServerTest {

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 1);
    private final List<String> warnings = new ArrayList<>();
    private Sampler sampler;
    private ObserverHttpServer server;

    private record Reply(int status, String headers, JsonObject body) {
    }

    @BeforeEach
    void start() throws IOException {
        sampler = Fixtures.sampler(config, world, warnings);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        sampler.onServerTick();
        server = ObserverHttpServer.start(config, 0, sampler, () -> clock.ms, warnings::add);
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    private Reply request(String method, String path, String... headers) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
            StringBuilder req = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
            boolean hasHost = false;
            for (String h : headers) {
                hasHost |= h.regionMatches(true, 0, "Host:", 0, 5);
                req.append(h).append("\r\n");
            }
            if (!hasHost) {
                req.append("Host: 127.0.0.1:").append(server.port()).append("\r\n");
            }
            req.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
            OutputStream out = socket.getOutputStream();
            out.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            in.transferTo(all);
            String text = all.toString(StandardCharsets.UTF_8);
            int split = text.indexOf("\r\n\r\n");
            String head = text.substring(0, split);
            int status = Integer.parseInt(head.split(" ")[1]);
            return new Reply(status, head, JsonParser.parseString(text.substring(split + 4)).getAsJsonObject());
        }
    }

    private static String bearer(String token) {
        return "Authorization: Bearer " + token;
    }

    @Test
    void anAuthorizedConsumerGetsItsSnapshot() throws IOException {
        Reply r = request("GET", "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN));
        assertEquals(200, r.status());
        assertTrue(r.headers().toLowerCase().contains("cache-control: no-store"));
        assertEquals("commons", r.body().get("consumer").getAsString());
        assertEquals(2, r.body().getAsJsonObject("snapshot").getAsJsonArray("residents").size());
    }

    @Test
    void nobodyGetsInWithoutAValidToken() throws IOException {
        for (String[] headers : new String[][]{{}, {bearer("wrong")}, {"Authorization: Basic abc"}}) {
            Reply r = request("GET", "/v1/snapshot", headers);
            assertEquals(401, r.status());
            assertFalse(r.body().has("snapshot"));
        }
        // Unknown paths are not revealed to strangers either.
        assertEquals(401, request("GET", "/v1/nothing").status());
    }

    @Test
    void scopesAreEnforcedPerEndpoint() throws IOException {
        assertEquals(403, request("GET", "/v1/status", bearer(Fixtures.GARY_TOKEN)).status());
        assertEquals(403, request("GET", "/v1/snapshot", bearer(Fixtures.STATUS_TOKEN)).status());
        assertEquals(200, request("GET", "/v1/status", bearer(Fixtures.STATUS_TOKEN)).status());
        Reply self = request("GET", "/v1/snapshot", bearer(Fixtures.GARY_TOKEN));
        assertEquals(200, self.status());
        assertEquals(1, self.body().getAsJsonObject("snapshot").getAsJsonArray("residents").size());
        assertEquals(0, self.body().getAsJsonObject("snapshot").getAsJsonArray("facilities").size());
    }

    @Test
    void itIsReadOnly() throws IOException {
        for (String method : new String[]{"POST", "PUT", "DELETE", "PATCH"}) {
            Reply r = request(method, "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN));
            assertEquals(405, r.status(), method);
            assertTrue(r.headers().contains("Allow: GET"));
        }
    }

    @Test
    void browsersAndRebindingHostsAreRefused() throws IOException {
        assertEquals(403, request("GET", "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN), "Host: evil.example:25640").status());
        assertEquals(403, request("GET", "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN), "Origin: http://127.0.0.1:8770").status());
        assertEquals(403, request("GET", "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN), "Sec-Fetch-Site: same-origin").status());
        // A tunnel's different local port is fine: only the host name matters.
        assertEquals(200, request("GET", "/v1/snapshot", bearer(Fixtures.COMMONS_TOKEN), "Host: localhost:15640").status());
    }

    @Test
    void eventsPageWithValidation() throws IOException {
        Reply r = request("GET", "/v1/events?after=0&limit=10", bearer(Fixtures.COMMONS_TOKEN));
        assertEquals(200, r.status());
        assertTrue(r.body().getAsJsonArray("events").size() >= 2);
        assertEquals(400, request("GET", "/v1/events?after=-1", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(400, request("GET", "/v1/events?limit=100000", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(400, request("GET", "/v1/events?after=abc", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(404, request("GET", "/v1/command", bearer(Fixtures.COMMONS_TOKEN)).status());
    }

    @Test
    void theHandlerQueueIsBoundedAndOverflowPushesBackOnTheCaller() throws Exception {
        java.util.concurrent.ThreadPoolExecutor pool = ObserverHttpServer.boundedExecutor(1, 2);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch busy = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger ran = new java.util.concurrent.atomic.AtomicInteger();
        try {
            pool.execute(() -> {
                busy.countDown();
                try {
                    release.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                ran.incrementAndGet();
            });
            assertTrue(busy.await(5, java.util.concurrent.TimeUnit.SECONDS));
            pool.execute(ran::incrementAndGet);
            pool.execute(ran::incrementAndGet);
            assertEquals(2, pool.getQueue().size());
            // Thread busy and queue full: the next exchange runs on the submitting (dispatcher) thread
            // instead of growing the queue or being dropped.
            Thread caller = Thread.currentThread();
            Thread[] ranOn = new Thread[1];
            for (int i = 0; i < 50; i++) {
                pool.execute(() -> ranOn[0] = Thread.currentThread());
                assertEquals(caller, ranOn[0]);
                assertTrue(pool.getQueue().size() <= 2);
            }
            assertEquals(2, pool.getQueue().remainingCapacity() + pool.getQueue().size());
        } finally {
            release.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        }
        assertEquals(3, ran.get(), "queued work still completes once the handler frees up");
    }

    @Test
    void hostGuardIsStrictAboutNames() {
        assertTrue(ObserverHttpServer.hostAllowed("127.0.0.1:25640"));
        assertTrue(ObserverHttpServer.hostAllowed("LOCALHOST:1"));
        assertTrue(ObserverHttpServer.hostAllowed("[::1]:25640"));
        assertTrue(ObserverHttpServer.hostAllowed("127.0.0.1"));
        assertFalse(ObserverHttpServer.hostAllowed(null));
        assertFalse(ObserverHttpServer.hostAllowed("127.0.0.1.evil.example:25640"));
        assertFalse(ObserverHttpServer.hostAllowed("localhost:abc"));
        assertFalse(ObserverHttpServer.hostAllowed("[::1]x"));
        assertFalse(ObserverHttpServer.hostAllowed("192.168.1.233:25640"));
    }

    @Test
    void configuredHostsAreExactAndNeverReplaceBearerAuthorization() throws Exception {
        assertTrue(ObserverHttpServer.hostAllowed("POP-OS:25640", java.util.Set.of("pop-os")));
        assertFalse(ObserverHttpServer.hostAllowed("pop-os.evil:25640", java.util.Set.of("pop-os")));
        assertFalse(ObserverHttpServer.hostAllowed("pop-os@evil", java.util.Set.of("pop-os")));
        server.stop();
        ObserverConfig lan = Fixtures.config("\"allowedHosts\":[\"pop-os\",\"192.168.1.233\"],", 0);
        sampler = Fixtures.sampler(lan, world, warnings);
        server = ObserverHttpServer.start(lan, 0, sampler, () -> clock.ms, warnings::add);
        assertEquals(401, request("GET", "/v1/status", "Host: pop-os:25640").status());
        assertEquals(200, request("GET", "/v1/status", "Host: pop-os:25640", bearer(Fixtures.COMMONS_TOKEN)).status());
    }

    @Test
    void bridgeScopesQueriesRegistrationPauseAndTimeoutAreEnforced() throws Exception {
        assertEquals(401, request("GET", "/v1/sight?from=Gary&to=Margo").status());
        assertEquals(403, request("GET", "/v1/sight?from=Gary&to=Margo", bearer(Fixtures.GARY_TOKEN)).status());
        assertEquals(403, request("GET", "/v1/library/shelf?facility=f0", bearer(Fixtures.GARY_TOKEN)).status());
        assertEquals(400, request("GET", "/v1/sight?from=Gary&to=Nobody", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(400, request("GET", "/v1/sight?from=Gary&from=Margo&to=Gary", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(404, request("GET", "/v1/library/shelf?facility=f0", bearer(Fixtures.COMMONS_TOKEN)).status(),
                "an ordinary registered facility must not grant book access");
        sampler.setPaused(true);
        assertEquals(503, request("GET", "/v1/sight?from=Gary&to=Margo", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(0, world.bridgeReads);
        server.stop();
        ObserverConfig fast = Fixtures.config("\"requestTimeoutMs\":100,", 0);
        sampler = Fixtures.sampler(fast, world, warnings);
        server = ObserverHttpServer.start(fast, 0, sampler, () -> clock.ms, warnings::add);
        assertEquals(504, request("GET", "/v1/sight?from=Gary&to=Margo", bearer(Fixtures.COMMONS_TOKEN)).status());
        sampler.onServerTick();
        assertEquals(0, world.bridgeReads, "a timed-out request is removed before a later tick");
    }

    @Test
    void sightAndLibraryResultsComeFromTicksNotHttpThreads() throws Exception {
        server.stop();
        ObserverConfig library = ObserverConfig.parse(Fixtures.configJson("", 1)
                .replace("\"pos\":[0,64,0]", "\"pos\":[0,64,0],\"library\":true"));
        sampler = Fixtures.sampler(library, world, warnings);
        server = ObserverHttpServer.start(library, 0, sampler, () -> clock.ms, warnings::add);
        assertEquals(400, request("GET", "/v1/library/book?facility=f0&slot=6", bearer(Fixtures.COMMONS_TOKEN)).status());
        assertEquals(400, request("GET", "/v1/library/book?facility=f0", bearer(Fixtures.COMMONS_TOKEN)).status());
        world.sightResult = new BridgeAccess.Sight(null, 42.0, "unloaded");
        java.util.concurrent.ScheduledExecutorService ticks = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
                r -> new Thread(r, "test-server-tick"));
        try {
            ticks.scheduleAtFixedRate(sampler::onServerTick, 0, 5, java.util.concurrent.TimeUnit.MILLISECONDS);
            Reply sight = request("GET", "/v1/sight?from=%47ary&to=Margo", bearer(Fixtures.COMMONS_TOKEN));
            assertEquals(200, sight.status());
            assertTrue(sight.body().getAsJsonObject("sight").get("visible").isJsonNull());
            assertEquals("unloaded", sight.body().getAsJsonObject("sight").get("reason").getAsString());
            Reply shelf = request("GET", "/v1/library/shelf?facility=f0", bearer(Fixtures.COMMONS_TOKEN));
            assertEquals("observed", shelf.body().getAsJsonObject("shelf").get("status").getAsString());
            Reply book = request("GET", "/v1/library/book?facility=f0&slot=0", bearer(Fixtures.COMMONS_TOKEN));
            assertEquals("empty", book.body().getAsJsonObject("book").get("status").getAsString());
            assertEquals("test-server-tick", world.bridgeThread.getName());
        } finally {
            ticks.shutdownNow();
            assertTrue(ticks.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }

    @Test
    void eventWaitIsBoundedAndDoesNotBlockStatusRequests() throws Exception {
        long after = sampler.events().latestSeq();
        java.util.concurrent.ExecutorService callers = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            long started = System.nanoTime();
            var pending = callers.submit(() -> request("GET", "/v1/events?after=" + after + "&wait=1", bearer(Fixtures.COMMONS_TOKEN)));
            assertEquals(200, request("GET", "/v1/status", bearer(Fixtures.STATUS_TOKEN)).status());
            Reply reply = pending.get(5, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals(200, reply.status());
            assertEquals(0, reply.body().getAsJsonArray("events").size());
            assertTrue(System.nanoTime() - started >= 900_000_000L, "empty page should wait for the deadline");
            // A committed event page is immediate even when a long wait is requested.
            Reply available = request("GET", "/v1/events?after=0&wait=25", bearer(Fixtures.COMMONS_TOKEN));
            assertTrue(available.body().getAsJsonArray("events").size() >= 2);
            assertEquals(400, request("GET", "/v1/events?wait=26", bearer(Fixtures.COMMONS_TOKEN)).status());
            assertEquals(400, request("GET", "/v1/events?wait=-1", bearer(Fixtures.COMMONS_TOKEN)).status());
            assertEquals(400, request("GET", "/v1/events?wait=1&wait=2", bearer(Fixtures.COMMONS_TOKEN)).status());
        } finally {
            callers.shutdownNow();
            assertTrue(callers.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }

    @Test
    void publishedEventsEndALongPollWithFreshEnvelopeTimes() throws Exception {
        long after = sampler.events().latestSeq();
        world.online.put(Fixtures.MARGO, Fixtures.body(clock.ms, "minecraft:overworld", 8, false));
        long served = clock.ms + 5000;
        java.util.concurrent.ScheduledExecutorService tick = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        java.util.concurrent.ExecutorService callers = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            var pending = callers.submit(() -> request("GET", "/v1/events?after=" + after + "&wait=25", bearer(Fixtures.COMMONS_TOKEN)));
            tick.schedule(() -> {
                clock.ms = served;
                sampler.onServerTick();
            }, 100, java.util.concurrent.TimeUnit.MILLISECONDS);
            Reply reply = pending.get(5, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals(200, reply.status());
            assertEquals(served, reply.body().get("servedAtMs").getAsLong());
            assertEquals("Margo", reply.body().getAsJsonArray("events").get(0).getAsJsonObject().get("resident").getAsString());
        } finally {
            tick.shutdownNow();
            callers.shutdownNow();
            assertTrue(tick.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
            assertTrue(callers.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }
}
