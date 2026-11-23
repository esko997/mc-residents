package dev.residents.observer;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** /v1/query end to end over the real JDK server, plus the sampler's flow and listener-failure paths. */
class QueryHttpTest {

    @TempDir
    Path world;

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld fake = new Fixtures.FakeWorld(clock);
    private final List<String> warnings = new ArrayList<>();
    private Sampler sampler;
    private ObserverHttpServer server;
    private ScheduledExecutorService ticks;

    private record Reply(int status, String head, JsonObject body) {
    }

    private void start(String extra) throws IOException {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1," + extra);
        sampler = Fixtures.watched(config, fake, warnings, 1);
        fake.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        sampler.onServerTick();
        Files.createDirectories(world.resolve("stats"));
        Files.writeString(world.resolve("stats").resolve(Fixtures.GARY + ".json"),
                "{\"stats\":{\"minecraft:custom\":{\"minecraft:jump\":12}},\"DataVersion\":3465}");
        PlayerFiles files = new PlayerFiles(world.resolve("stats"), world.resolve("advancements"), 1 << 20,
                () -> AdvancementCatalog.unavailable("test", 0));
        server = ObserverHttpServer.start(config, 0, sampler, files, () -> clock.ms, warnings::add);
    }

    @AfterEach
    void stop() throws InterruptedException {
        if (ticks != null) {
            ticks.shutdownNow();
            assertTrue(ticks.awaitTermination(5, TimeUnit.SECONDS));
        }
        if (server != null) server.stop();
    }

    private Reply get(String path, String token) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
            String req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token
                    + "\r\nConnection: close\r\n\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(req.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            in.transferTo(all);
            String text = all.toString(StandardCharsets.UTF_8);
            int split = text.indexOf("\r\n\r\n");
            String head = text.substring(0, split);
            return new Reply(Integer.parseInt(head.split(" ")[1]), head,
                    JsonParser.parseString(text.substring(split + 4)).getAsJsonObject());
        }
    }

    private static JsonObject result(Reply r) {
        return r.body().getAsJsonObject("query").getAsJsonObject("result");
    }

    @Test
    void theVocabularyIsServedAndOldEndpointsAreUnchanged() throws IOException {
        start("");
        Reply catalog = get("/v1/queries", Fixtures.COMMONS_TOKEN);
        assertEquals(200, catalog.status());
        assertEquals(1, catalog.body().get("schema").getAsInt());
        assertEquals(6, catalog.body().getAsJsonObject("queries").getAsJsonArray("kinds").size());
        assertEquals(403, get("/v1/queries", Fixtures.STATUS_TOKEN).status());
        assertEquals(200, get("/v1/snapshot", Fixtures.COMMONS_TOKEN).status());
        Reply status = get("/v1/status", Fixtures.STATUS_TOKEN);
        assertEquals(200, status.status());
        assertTrue(status.body().getAsJsonObject("queries").has("blocks"));
    }

    @Test
    void statsComeFromPlayerFilesAndSelfTokensSeeOnlyThemselves() throws IOException {
        start("");
        Reply stats = get("/v1/query?kind=stats&resident=Gary&limit=5000", Fixtures.COMMONS_TOKEN);
        assertEquals(200, stats.status());
        assertEquals("observed", result(stats).get("status").getAsString());
        assertEquals(12, result(stats).getAsJsonArray("types").get(0).getAsJsonObject()
                .getAsJsonObject("values").get("minecraft:jump").getAsInt());
        assertEquals("limit", stats.body().getAsJsonObject("query").getAsJsonArray("clamped").get(0).getAsString());
        assertEquals(sampler.startedAtMs(), stats.body().getAsJsonObject("query").get("runStartedAtMs").getAsLong());
        assertEquals("missing", result(get("/v1/query?kind=stats&resident=Margo", Fixtures.COMMONS_TOKEN)).get("status").getAsString());

        assertEquals(403, get("/v1/query?kind=stats&resident=Margo", Fixtures.GARY_TOKEN).status());
        assertEquals(200, get("/v1/query?kind=stats", Fixtures.GARY_TOKEN).status());
        assertEquals(403, get("/v1/query?kind=flows", Fixtures.GARY_TOKEN).status());
        assertEquals(404, get("/v1/query?kind=stats&resident=spesk01", Fixtures.COMMONS_TOKEN).status());
        assertEquals(400, get("/v1/query?kind=stats&resident=Gary&path=..%2F..%2Fops.json", Fixtures.COMMONS_TOKEN).status());
    }

    @Test
    void blockDetailAndHourCellsAreServedWithinTheTickQueue() throws Exception {
        start("");
        sampler.blocks().record("Gary", true, "minecraft:overworld", 5, 64, -3, "minecraft:oak_planks", clock.ms, 1);
        sampler.blocks().record("Margo", false, "minecraft:overworld", 40, 64, 0, "minecraft:stone", clock.ms, 1);
        sampler.onServerTick(); // publishes the detail ring
        Reply blocks = get("/v1/query?kind=blocks&after=0", Fixtures.COMMONS_TOKEN);
        assertEquals(2, result(blocks).getAsJsonArray("changes").size());
        assertEquals(2, result(blocks).get("nextAfter").getAsLong());
        Reply own = get("/v1/query?kind=blocks", Fixtures.GARY_TOKEN);
        assertEquals(1, result(own).getAsJsonArray("changes").size(), "a self token sees only its own changes");

        ticks = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "test-server-tick"));
        ticks.scheduleAtFixedRate(sampler::onServerTick, 0, 5, TimeUnit.MILLISECONDS);
        Reply hours = get("/v1/query?kind=block_hours&sinceHour=0", Fixtures.COMMONS_TOKEN);
        assertEquals(200, hours.status());
        assertEquals(2, result(hours).getAsJsonArray("cells").size());
        assertEquals(1, result(hours).getAsJsonArray("cells").get(0).getAsJsonObject().get("placed").getAsInt());
    }

    @Test
    void theRateLimitAndThePauseSwitchCoverQueries() throws IOException {
        start("\"queryRatePerMinute\":6,\"queryBurst\":2,");
        assertEquals(200, get("/v1/query?kind=blocks", Fixtures.COMMONS_TOKEN).status());
        assertEquals(200, get("/v1/query?kind=blocks", Fixtures.COMMONS_TOKEN).status());
        Reply limited = get("/v1/query?kind=blocks", Fixtures.COMMONS_TOKEN);
        assertEquals(429, limited.status());
        // The JDK server normalizes header names to "Retry-after".
        assertTrue(limited.head().toLowerCase(java.util.Locale.ROOT).matches("(?s).*\r\nretry-after: [1-9][0-9]*\r?.*"));
        assertEquals(200, get("/v1/query?kind=stats", Fixtures.GARY_TOKEN).status(), "another consumer has its own bucket");
        assertEquals(200, get("/v1/snapshot", Fixtures.COMMONS_TOKEN).status(), "other endpoints are not rate limited");

        sampler.setPaused(true);
        sampler.onServerTick();
        assertEquals(503, get("/v1/query?kind=stats", Fixtures.GARY_TOKEN).status());
        assertFalse(sampler.recording(), "paused listeners record nothing");
    }

    @Test
    void flowsAreDerivedFromConsecutiveFacilityReadsWithNearbyResidents() throws IOException {
        start("");
        sampler.onServerTick(); // f0 observed again with the same stock: no flow
        fake.contents.put("f0", Fixtures.chest("minecraft:bread", 5));
        sampler.onServerTick();
        Reply flows = get("/v1/query?kind=flows&facility=f0", Fixtures.COMMONS_TOKEN);
        assertEquals(200, flows.status());
        JsonObject flow = result(flows).getAsJsonArray("flows").get(0).getAsJsonObject();
        assertEquals(1, result(flows).getAsJsonArray("flows").size());
        assertEquals(2, flow.getAsJsonArray("deltas").size());
        assertEquals(Flows.NEAREST, flow.get("attribution").getAsString());
        assertEquals("Gary", flow.get("resident").getAsString());
        assertTrue(result(flows).get("evidence").getAsString().contains("human players"));
    }

    @Test
    void repeatedListenerFailuresStopOnlyBlockRecording() throws IOException {
        start("\"failureTripCount\":3,");
        for (int i = 0; i < 3; i++) sampler.listenerFailed(new IllegalStateException("modded block"));
        assertFalse(sampler.recording());
        sampler.onServerTick();
        assertEquals("degraded", sampler.state(clock.ms).id());
        assertTrue(sampler.events().events().stream().anyMatch(e -> e.type().equals("recorder_stopped")));
        assertEquals(200, get("/v1/snapshot", Fixtures.COMMONS_TOKEN).status(), "observing continues");
    }
}
