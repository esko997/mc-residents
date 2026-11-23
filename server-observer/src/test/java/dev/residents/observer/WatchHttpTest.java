package dev.residents.observer;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.AfterEach;
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
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PUT /v1/watch, GET /v1/watch, a server with no list yet, and discovery over the real JDK server. */
class WatchHttpTest {

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final List<String> warnings = new ArrayList<>();
    private Sampler sampler;
    private ObserverHttpServer server;
    private ScheduledExecutorService ticks;

    private record Reply(int status, String head, JsonObject body) {
    }

    private void start(String extra) throws IOException {
        ObserverConfig config = Fixtures.config("\"intervalTicks\":1," + extra);
        sampler = Fixtures.sampler(config, world, warnings);
        server = ObserverHttpServer.start(config, 0, sampler, () -> clock.ms, warnings::add);
    }

    private void tickContinuously() {
        ticks = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "test-server-tick"));
        ticks.scheduleAtFixedRate(sampler::onServerTick, 0, 2, TimeUnit.MILLISECONDS);
    }

    @AfterEach
    void stop() throws InterruptedException {
        if (ticks != null) {
            ticks.shutdownNow();
            assertTrue(ticks.awaitTermination(5, TimeUnit.SECONDS));
        }
        if (server != null) server.stop();
    }

    /** One raw request; {@code body} null sends none. Header lines are sent exactly as given. */
    private Reply send(String method, String path, byte[] body, String... headers) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
            StringBuilder req = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
            boolean host = false, length = false;
            for (String h : headers) {
                host |= h.regionMatches(true, 0, "Host:", 0, 5);
                length |= h.regionMatches(true, 0, "Content-Length:", 0, 15) || h.regionMatches(true, 0, "Transfer-Encoding:", 0, 18);
                req.append(h).append("\r\n");
            }
            if (!host) req.append("Host: 127.0.0.1\r\n");
            if (!length) req.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n");
            req.append("Connection: close\r\n\r\n");
            OutputStream out = socket.getOutputStream();
            out.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            if (body != null) out.write(body);
            out.flush();
            socket.shutdownOutput(); // a server that stops reading early drains to EOF and closes cleanly
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

    private Reply put(String json, String... headers) throws IOException {
        List<String> h = new ArrayList<>(List.of(headers));
        if (h.stream().noneMatch(x -> x.regionMatches(true, 0, "Authorization:", 0, 14))) h.add("Authorization: Bearer " + Fixtures.COMMONS_TOKEN);
        if (h.stream().noneMatch(x -> x.regionMatches(true, 0, "Content-Type:", 0, 13))) h.add("Content-Type: application/json");
        return send("PUT", "/v1/watch", json.getBytes(StandardCharsets.UTF_8), h.toArray(String[]::new));
    }

    private Reply get(String path, String token) throws IOException {
        return send("GET", path, null, "Authorization: Bearer " + token);
    }

    private static String code(Reply r) {
        return r.body().getAsJsonObject("error").get("code").getAsString();
    }

    private String revision() throws IOException {
        var rev = get("/v1/watch", Fixtures.STATUS_TOKEN).body().getAsJsonObject("watch").get("revision");
        return rev.isJsonNull() ? null : rev.getAsString();
    }

    @Test
    void aPushIsAppliedAtTheNextTickAndReportedWithTheBootId() throws Exception {
        start("");
        tickContinuously();
        Reply r = put(Fixtures.watchJson("rev-1", 3));
        assertEquals(200, r.status(), r.body().toString());
        JsonObject w = r.body().getAsJsonObject("watch");
        assertEquals("rev-1", w.get("revision").getAsString());
        assertEquals(2, w.getAsJsonArray("residents").size());
        assertEquals(3, w.getAsJsonArray("facilities").size());
        assertEquals("[3,64,0]", w.getAsJsonArray("facilities").get(1).getAsJsonObject().get("pos").toString());
        assertFalse(w.get("appliedAtMs").isJsonNull());
        String boot = w.get("bootId").getAsString();
        assertEquals(boot, get("/v1/status", Fixtures.STATUS_TOKEN).body().getAsJsonObject("status").get("bootId").getAsString());
        assertEquals("rev-1", revision());
        assertEquals(3, sampler.snapshot().facilities().size());
        // Commons may read it back with its own token too.
        assertEquals(200, get("/v1/watch", Fixtures.COMMONS_TOKEN).status());
    }

    @Test
    void beforeAnyPushEveryEndpointAnswersSensibly() throws Exception {
        start("");
        sampler.onServerTick();
        JsonObject w = get("/v1/watch", Fixtures.STATUS_TOKEN).body().getAsJsonObject("watch");
        assertTrue(w.get("revision").isJsonNull());
        assertTrue(w.get("appliedAtMs").isJsonNull());
        assertEquals(0, w.getAsJsonArray("residents").size());
        assertEquals(sampler.bootId(), w.get("bootId").getAsString());
        JsonObject snap = get("/v1/snapshot", Fixtures.COMMONS_TOKEN).body().getAsJsonObject("snapshot");
        assertEquals(0, snap.getAsJsonArray("residents").size());
        assertEquals(0, snap.getAsJsonArray("facilities").size());
        assertEquals(0, get("/v1/snapshot", Fixtures.GARY_TOKEN).body().getAsJsonObject("snapshot").getAsJsonArray("residents").size());
        Reply sight = get("/v1/sight?from=Gary&to=Margo", Fixtures.COMMONS_TOKEN);
        assertEquals(400, sight.status());
        assertTrue(sight.body().toString().contains("has not pushed"));
        assertEquals(404, get("/v1/query?kind=stats&resident=Gary", Fixtures.COMMONS_TOKEN).status());
        assertEquals(404, get("/v1/query?kind=blocks", Fixtures.GARY_TOKEN).status(), "a self token never falls back to everyone");
        assertEquals(0, get("/v1/queries", Fixtures.COMMONS_TOKEN).body().getAsJsonObject("queries")
                .getAsJsonObject("subjects").getAsJsonArray("residents").size());
        JsonObject status = get("/v1/status", Fixtures.STATUS_TOKEN).body();
        assertEquals("ok", status.get("state").getAsString());
        assertTrue(status.getAsJsonObject("status").get("watchRevision").isJsonNull());
        assertEquals(200, get("/v1/events?after=0", Fixtures.COMMONS_TOKEN).status());
        assertTrue(warnings.isEmpty(), warnings.toString());
    }

    @Test
    void refusalsChangeNothing() throws Exception {
        start("");
        tickContinuously();
        assertEquals(200, put(Fixtures.watchJson("good", 1)).status());
        String body = Fixtures.watchJson("bad", 1);

        Reply r = put(body, "Authorization: Bearer wrong");
        assertEquals(401, r.status());
        assertEquals(403, put(body, "Authorization: Bearer " + Fixtures.STATUS_TOKEN).status(), "status scope cannot push");
        assertEquals(403, put(body, "Authorization: Bearer " + Fixtures.GARY_TOKEN).status(), "self cannot push");
        assertEquals(403, put(body, "Host: evil.example").status());
        assertEquals(403, put(body, "Origin: http://127.0.0.1:8770").status());
        assertEquals(403, put(body, "Sec-Fetch-Site: same-origin").status());
        assertEquals(415, put(body, "Content-Type: text/plain").status());
        assertEquals(415, put(body, "Content-Type: application/json; charset=iso-8859-1").status());
        assertEquals(415, send("PUT", "/v1/watch", body.getBytes(StandardCharsets.UTF_8),
                "Authorization: Bearer " + Fixtures.COMMONS_TOKEN).status(), "no content type");
        assertEquals(400, put("{\"revision\":\"bad\",").status());
        assertEquals(400, put("{\"revision\":\"bad\",\"facilities\":[{\"id\":\"f0\",\"pos\":[0,64,0],\"library\":true}]}").status());
        Reply over = put(Fixtures.watchJson("bad", 1025));
        assertEquals(400, over.status());
        assertTrue(over.body().toString().contains("nothing changed"));
        assertEquals(400, send("PUT", "/v1/watch", new byte[]{'{', '"', (byte) 0xff, '"', '}'},
                "Authorization: Bearer " + Fixtures.COMMONS_TOKEN, "Content-Type: application/json").status(), "not UTF-8");
        assertEquals("good", revision());
        assertEquals(1, sampler.snapshot().facilities().size());
    }

    @Test
    void theBodyLimitHoldsWithAndWithoutAContentLength() throws Exception {
        start("");
        tickContinuously();
        // Declared too large: refused from the header, before any of the body is read.
        Reply declared = send("PUT", "/v1/watch", "{}".getBytes(StandardCharsets.UTF_8),
                "Authorization: Bearer " + Fixtures.COMMONS_TOKEN, "Content-Type: application/json",
                "Content-Length: " + (WatchList.MAX_BODY_BYTES + 1));
        assertEquals(413, declared.status());
        // Chunked: no length to check up front, so the read itself is bounded (4 x 64 KiB + 16 bytes).
        ByteArrayOutputStream chunked = new ByteArrayOutputStream();
        for (int i = 0; i < 4; i++) {
            chunked.write(("10000\r\n").getBytes(StandardCharsets.US_ASCII));
            chunked.write(new byte[0x10000]);
            chunked.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        }
        chunked.write(("10\r\n" + " ".repeat(16) + "\r\n0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        Reply streamed = send("PUT", "/v1/watch", chunked.toByteArray(), "Authorization: Bearer " + Fixtures.COMMONS_TOKEN,
                "Content-Type: application/json", "Transfer-Encoding: chunked");
        assertEquals(413, streamed.status());
        assertNull(revision());
    }

    @Test
    void pushesAreRateLimitedPerConsumer() throws Exception {
        start("");
        tickContinuously();
        int ok = 0;
        Reply last = null;
        for (int i = 0; i < ObserverHttpServer.WATCH_BURST + 2; i++) {
            last = put(Fixtures.watchJson("r" + i, 0));
            if (last.status() == 200) ok++;
        }
        assertEquals(ObserverHttpServer.WATCH_BURST, ok);
        assertEquals(429, last.status());
        assertTrue(last.head().toLowerCase(java.util.Locale.ROOT).contains("retry-after: "));
        assertEquals("rate_limited", code(last));
    }

    @Test
    void onlyGetAndPutAreAcceptedAndPutOnlyHere() throws Exception {
        start("");
        Reply post = send("POST", "/v1/watch", "{}".getBytes(StandardCharsets.UTF_8), "Authorization: Bearer " + Fixtures.COMMONS_TOKEN);
        assertEquals(405, post.status());
        assertTrue(post.head().contains("Allow: GET, PUT"));
        Reply putElsewhere = send("PUT", "/v1/snapshot", "{}".getBytes(StandardCharsets.UTF_8),
                "Authorization: Bearer " + Fixtures.COMMONS_TOKEN, "Content-Type: application/json");
        assertEquals(405, putElsewhere.status());
        assertTrue(putElsewhere.head().contains("Allow: GET\r") || putElsewhere.head().endsWith("Allow: GET"));
    }

    @Test
    void withoutTicksAPushTimesOutAndIsAppliedLater() throws Exception {
        start("\"requestTimeoutMs\":100,");
        Reply r = put(Fixtures.watchJson("late", 1));
        assertEquals(504, r.status());
        assertNull(revision());
        sampler.onServerTick();
        assertEquals("late", revision());
    }

    @Test
    void discoveryAnswersScanningThenServesPagesFromTheScan() throws Exception {
        start("\"requestTimeoutMs\":100,");
        for (int i = 0; i < 5; i++) world.addHolder(Fixtures.OVERWORLD, i * 16, 64, 0, Fixtures.shelf(Fixtures.written(1, "Book " + i, "p")));
        world.addHolder("minecraft:the_nether", 0, 40, 0, Fixtures.lectern(Fixtures.written(0, "Rails", "p")));
        Reply first = get("/v1/library/shelves", Fixtures.COMMONS_TOKEN);
        assertEquals(503, first.status());
        assertEquals("scanning", code(first));
        assertTrue(first.head().toLowerCase(java.util.Locale.ROOT).contains("retry-after: 2"));
        tickContinuously();
        Reply page = null;
        for (int i = 0; i < 50 && (page == null || page.status() != 200); i++) page = get("/v1/library/shelves?limit=4", Fixtures.COMMONS_TOKEN);
        assertEquals(200, page.status());
        JsonObject shelves = page.body().getAsJsonObject("shelves");
        assertEquals(4, shelves.getAsJsonArray("items").size());
        assertTrue(shelves.get("loadedOnly").getAsBoolean());
        assertFalse(shelves.get("truncated").getAsBoolean());
        assertEquals(6, shelves.get("total").getAsInt());
        assertTrue(shelves.get("completedAtMs").getAsLong() >= shelves.get("scannedAtMs").getAsLong());
        assertEquals(clock.ms, shelves.getAsJsonArray("items").get(0).getAsJsonObject().get("observedAtMs").getAsLong());
        JsonObject item = shelves.getAsJsonArray("items").get(0).getAsJsonObject();
        assertEquals("minecraft:overworld", item.get("dimension").getAsString());
        assertEquals("[0,64,0]", item.get("pos").toString());
        assertEquals("Book 0", item.getAsJsonArray("slots").get(0).getAsJsonObject().get("title").getAsString());
        String next = shelves.get("next").getAsString();
        JsonObject rest = get("/v1/library/shelves?limit=4&after=" + next, Fixtures.COMMONS_TOKEN).body().getAsJsonObject("shelves");
        assertEquals(2, rest.getAsJsonArray("items").size());
        assertTrue(rest.get("next").isJsonNull());
        assertEquals("minecraft:the_nether", rest.getAsJsonArray("items").get(1).getAsJsonObject().get("dimension").getAsString());

        for (String bad : List.of("?limit=0", "?limit=201", "?after=%21%21", "?after=bm90LWEtY3Vyc29y", "?facility=f0", "?limit=1&limit=2")) {
            assertEquals(400, get("/v1/library/shelves" + bad, Fixtures.COMMONS_TOKEN).status(), bad);
        }
        assertEquals(403, get("/v1/library/shelves", Fixtures.STATUS_TOKEN).status());
        assertEquals(403, get("/v1/library/shelves", Fixtures.GARY_TOKEN).status());
    }
}
