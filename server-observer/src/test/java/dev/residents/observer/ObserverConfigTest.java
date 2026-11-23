package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ObserverConfigTest {

    private static final String HASH = "a".repeat(64);

    private static String minimal(String consumers) {
        return "{\"consumers\":[" + consumers + "]}";
    }

    private static ObserverConfig.InvalidConfig rejects(String json) {
        return assertThrows(ObserverConfig.InvalidConfig.class, () -> ObserverConfig.parse(json));
    }

    @Test
    void defaultsAreLoopbackAndBounded() throws Exception {
        ObserverConfig c = ObserverConfig.parse(minimal("{\"name\":\"commons\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}"));
        assertTrue(c.enabled());
        assertEquals("127.0.0.1", c.bind());
        assertEquals(25640, c.port());
        assertEquals(20, c.intervalTicks());
        assertEquals(500, c.tickBudgetMicros());
        assertTrue(c.ignoredKeys().isEmpty());
    }

    @Test
    void theShippedExampleParsesAndListsNoSubjects() throws Exception {
        ObserverConfig c = ObserverConfig.parse(Files.readString(Path.of("config.example.json")));
        assertTrue(c.ignoredKeys().isEmpty(), "the example carries no residents or facilities");
        assertTrue(c.consumers().get(0).has(Scope.WATCH), "the hub's entry can push the watch list");
    }

    /**
     * A 0.2 config with residents and facilities (even invalid ones) still starts the bridge, and nothing from
     * those lists is watched: subjects come only from Commons.
     */
    @Test
    void anOldConfigsSubjectsAreIgnoredNeverRead() throws Exception {
        String old = "{\"residents\":[{\"name\":\"Gary\",\"uuid\":\"" + Fixtures.GARY + "\"},{\"name\":\"bad name!\"}],"
                + "\"facilities\":[{\"id\":\"pantry\",\"pos\":[0,64,0],\"library\":true},\"not even an object\"],"
                + "\"consumers\":[{\"name\":\"commons\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\",\"facilities\"]}]}";
        ObserverConfig c = ObserverConfig.parse(old);
        assertEquals(List.of("residents", "facilities"), c.ignoredKeys());

        Fixtures.Clock clock = new Fixtures.Clock();
        Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 1, false));
        Sampler s = Fixtures.sampler(c, world, new java.util.ArrayList<>());
        s.onServerTick();
        assertTrue(s.snapshot().residents().isEmpty());
        assertTrue(s.snapshot().facilities().isEmpty());
        assertTrue(world.reads.isEmpty());
        assertEquals(0, s.status().residentsWatched());
    }

    @Test
    void refusesToListenOffLoopback() {
        String consumers = "{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}";
        for (String bind : new String[]{"0.0.0.0", "192.168.1.233", "localhost", "::"}) {
            String json = minimal(consumers).replaceFirst("\\{", "{\"bind\":\"" + bind + "\",");
            assertTrue(rejects(json).getMessage().contains("loopback"), bind);
        }
    }

    @Test
    void lanRequiresExplicitOptInAndExactHostNames() throws Exception {
        ObserverConfig c = ObserverConfig.parse(Fixtures.configJson(
                "\"bind\":\"0.0.0.0\",\"allowNonLoopback\":true,\"allowedHosts\":[\"POP-OS\",\"192.168.1.233\"],"));
        assertTrue(c.allowNonLoopback());
        assertTrue(c.allowedHosts().contains("pop-os"));
        assertTrue(c.allowedHosts().contains("localhost"));
        for (String hosts : new String[]{"[\"*.example\"]", "[\"pop-os:25640\"]", "[\"http://pop-os\"]", "[\"\"]", "[1]"}) {
            rejects(Fixtures.configJson("\"allowedHosts\":" + hosts + ","));
        }
        for (String bind : new String[]{"localhost", "server.example", "999.1.2.3", "1.2.3", "fe80::1%eth0"}) {
            rejects(Fixtures.configJson("\"bind\":\"" + bind + "\",\"allowNonLoopback\":true,"));
        }
        assertEquals("::", ObserverConfig.parse(Fixtures.configJson("\"bind\":\"::\",\"allowNonLoopback\":true,")).bind());
    }

    @Test
    void bookLimitsAreRangeCheckedAndSelfNeverReadsTheLibrary() {
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"library\"],\"resident\":\"Gary\"}"));
        for (String setting : new String[]{"\"maxSightDistance\":513", "\"requestQueueCapacity\":0",
                "\"requestTimeoutMs\":0", "\"maxBookPages\":101", "\"maxBookPageChars\":32768", "\"maxBookChars\":262145"}) {
            rejects(Fixtures.configJson(setting + ","));
        }
    }

    @Test
    void aTypoIsAnErrorNotASilentDefault() {
        String json = minimal("{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}")
                .replaceFirst("\\{", "{\"tickBudgetMicro\":100,");
        assertTrue(rejects(json).getMessage().contains("tickBudgetMicro"));
    }

    @Test
    void aResidentCredentialCannotSeeOthersStockOrChangeTheWatchList() throws Exception {
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"residents\"],\"resident\":\"Gary\"}"));
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"facilities\"],\"resident\":\"Gary\"}"));
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"watch\"],\"resident\":\"Gary\"}"));
        // self must name a resident (a Minecraft name; whether it is watched is up to Commons)...
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\"]}"));
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\"],\"resident\":\"not a name\"}"));
        assertEquals("Piper", ObserverConfig.parse(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH
                + "\",\"scopes\":[\"self\"],\"resident\":\"Piper\"}")).consumers().get(0).resident());
        // ...and a resident binding without self would be meaningless.
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"status\"],\"resident\":\"Gary\"}"));
    }

    @Test
    void tokensAreHashesAndNeverShared() {
        // A plaintext token in place of the hash is refused.
        assertTrue(rejects(minimal("{\"name\":\"c\",\"tokenSha256\":\"my-secret-token\",\"scopes\":[\"residents\"]}"))
                .getMessage().contains("sha256"));
        rejects(minimal("{\"name\":\"a\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]},"
                + "{\"name\":\"b\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"status\"]}"));
        rejects(minimal("{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"write\"]}"));
        rejects(minimal("{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[]}"));
        rejects(minimal(""));
    }

    @Test
    void limitsAreRangeChecked() {
        String consumers = "{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}";
        rejects(minimal(consumers).replaceFirst("\\{", "{\"tickBudgetMicros\":100000,"));
        rejects(minimal(consumers).replaceFirst("\\{", "{\"intervalTicks\":0,"));
        rejects(minimal(consumers).replaceFirst("\\{", "{\"port\":80,"));
        rejects(minimal(consumers).replaceFirst("\\{", "{\"enabled\":\"yes\","));
    }

    @Test
    void disabledStillValidates() throws Exception {
        ObserverConfig c = ObserverConfig.parse(minimal("{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}")
                .replaceFirst("\\{", "{\"enabled\":false,"));
        assertFalse(c.enabled());
    }
}
