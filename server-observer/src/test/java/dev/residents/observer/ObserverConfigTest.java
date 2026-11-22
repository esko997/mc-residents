package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ObserverConfigTest {

    private static final String HASH = "a".repeat(64);

    private static String minimal(String consumers) {
        return "{\"residents\":[{\"name\":\"Gary\",\"uuid\":\"" + Fixtures.GARY + "\"}],\"consumers\":[" + consumers + "]}";
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
        assertEquals(1, c.residents().size());
        assertTrue(c.facilities().isEmpty());
    }

    @Test
    void theShippedExampleParses() throws Exception {
        Path example = Path.of("config.example.json");
        ObserverConfig c = ObserverConfig.parse(Files.readString(example));
        assertEquals(2, c.residents().size());
        assertEquals("commons-chest", c.facilities().get(0).id());
        assertNull(c.facilities().get(0).side());
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
    void aTypoIsAnErrorNotASilentDefault() {
        String json = minimal("{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"residents\"]}")
                .replaceFirst("\\{", "{\"tickBudgetMicro\":100,");
        assertTrue(rejects(json).getMessage().contains("tickBudgetMicro"));
    }

    @Test
    void aResidentCredentialCannotSeeOthersOrStock() {
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"residents\"],\"resident\":\"Gary\"}"));
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\",\"facilities\"],\"resident\":\"Gary\"}"));
        // self must name a configured resident...
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\"]}"));
        rejects(minimal("{\"name\":\"g\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"self\"],\"resident\":\"Nobody\"}"));
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
    void facilitiesAreValidatedSpecifically() {
        String consumers = "{\"name\":\"c\",\"tokenSha256\":\"" + HASH + "\",\"scopes\":[\"facilities\"]}";
        String base = "{\"consumers\":[" + consumers + "],\"facilities\":[%s]}";
        rejects(String.format(base, "{\"id\":\"Bad Id\",\"pos\":[0,64,0]}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0,64]}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0.5,64,0]}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[40000000,64,0]}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0,64,0],\"dimension\":\"Overworld\"}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0,64,0],\"side\":\"sideways\"}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0,64,0]},{\"id\":\"a\",\"pos\":[1,64,0]}"));
        rejects(String.format(base, "{\"id\":\"a\",\"pos\":[0,64,0]},{\"id\":\"b\",\"pos\":[0,64,0]}"));
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
