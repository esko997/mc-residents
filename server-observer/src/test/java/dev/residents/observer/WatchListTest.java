package dev.residents.observer;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** What a push must look like; anything else is refused whole, with a message that says why. */
class WatchListTest {

    private static String invalid(String body) {
        return assertThrows(WatchList.Invalid.class, () -> WatchList.parse(body)).getMessage();
    }

    private static String facilities(int n) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < n; i++) {
            if (i > 0) b.append(',');
            b.append("{\"id\":\"facility-").append(i).append("\",\"pos\":[").append(i).append(",64,0]}");
        }
        return b.toString();
    }

    private static String residents(int n) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < n; i++) {
            if (i > 0) b.append(',');
            b.append(String.format("{\"name\":\"r%d\",\"uuid\":\"00000000-0000-0000-0000-%012d\"}", i, i));
        }
        return b.toString();
    }

    @Test
    void theContractExampleParsesWithDefaults() throws Exception {
        WatchList w = WatchList.parse("{ \"revision\": \"rev-7\", \"residents\": [{ \"name\": \"Gary\", \"uuid\": \"" + Fixtures.GARY + "\" }],"
                + " \"facilities\": [{ \"id\": \"facility-12\", \"label\": \"Bread chest\", \"dimension\": \"minecraft:overworld\","
                + " \"pos\": [226, 5, -67], \"side\": null }, { \"id\": \"facility-13\", \"pos\": [0, -60, 0], \"side\": \"UP\" }] }");
        assertEquals("rev-7", w.revision());
        assertEquals("Gary", w.resident("Gary").name());
        assertNull(w.resident("gary"), "names are exact");
        assertEquals("Gary", w.residentName(Fixtures.GARY));
        assertEquals(226, w.facility("facility-12").x());
        assertEquals("facility-13", w.facility("facility-13").label(), "the label defaults to the id");
        assertEquals("minecraft:overworld", w.facility("facility-13").dimension());
        assertEquals("up", w.facility("facility-13").side());
        assertNull(w.appliedAtMs(), "not applied until the tick swaps it in");
        JsonObject json = w.toJson("boot");
        assertEquals("[226,5,-67]", json.getAsJsonArray("facilities").get(0).getAsJsonObject().get("pos").toString());
        assertEquals("boot", json.get("bootId").getAsString());
    }

    @Test
    void capsAreHardAndOverACapNothingIsTaken() throws Exception {
        assertEquals(WatchList.MAX_FACILITIES, WatchList.parse("{\"revision\":\"a\",\"facilities\":[" + facilities(1024) + "]}")
                .facilities().size());
        assertTrue(invalid("{\"revision\":\"a\",\"facilities\":[" + facilities(1025) + "]}").contains("1024"));
        assertEquals(64, WatchList.parse("{\"revision\":\"a\",\"residents\":[" + residents(64) + "]}").residents().size());
        assertTrue(invalid("{\"revision\":\"a\",\"residents\":[" + residents(65) + "]}").contains("64"));
        // A full-size list stays under the body limit.
        String full = "{\"revision\":\"a\",\"residents\":[" + residents(64) + "],\"facilities\":[" + facilities(1024) + "]}";
        assertTrue(full.length() < WatchList.MAX_BODY_BYTES / 2, "room left for labels: " + full.length());
    }

    @Test
    void theConfigsOldRulesApplyToEveryEntry() {
        String r = "{\"revision\":\"a\",\"residents\":[%s]}";
        invalid(String.format(r, "{\"name\":\"no spaces\",\"uuid\":\"" + Fixtures.GARY + "\"}"));
        invalid(String.format(r, "{\"name\":\"Gary\",\"uuid\":\"not-a-uuid\"}"));
        invalid(String.format(r, "{\"name\":\"Gary\",\"uuid\":\"" + Fixtures.GARY + "\"},{\"name\":\"gary\",\"uuid\":\"" + Fixtures.MARGO + "\"}"));
        invalid(String.format(r, "{\"name\":\"Gary\",\"uuid\":\"" + Fixtures.GARY + "\"},{\"name\":\"Margo\",\"uuid\":\"" + Fixtures.GARY + "\"}"));
        invalid(String.format(r, "{\"name\":\"Gary\",\"uuid\":\"" + Fixtures.GARY + "\",\"op\":true}"));
        String f = "{\"revision\":\"a\",\"facilities\":[%s]}";
        invalid(String.format(f, "{\"id\":\"Bad Id\",\"pos\":[0,64,0]}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64]}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0.5,64,0]}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[40000000,64,0]}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0],\"dimension\":\"Overworld\"}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0],\"side\":\"sideways\"}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0],\"label\":\"" + "x".repeat(81) + "\"}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0]},{\"id\":\"a\",\"pos\":[1,64,0]}"));
        invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0]},{\"id\":\"b\",\"pos\":[0,64,0]}"));
        assertTrue(invalid(String.format(f, "{\"id\":\"a\",\"pos\":[0,64,0],\"library\":true}")).contains("library"),
                "\"library\": true no longer exists");
    }

    @Test
    void onlyStrictJsonOfTheRightShapeIsAccepted() {
        invalid("");
        invalid("[]");
        invalid("{\"residents\":[]}");                                    // no revision
        invalid("{\"revision\":\"\"}");
        invalid("{\"revision\":\"has space\"}");
        invalid("{\"revision\":\"" + "r".repeat(129) + "\"}");
        invalid("{\"revision\":7}");
        invalid("{\"revision\":\"a\",\"extra\":1}");
        invalid("{\"revision\":\"a\"} trailing");
        invalid("{\"revision\":\"a\",}");                                 // trailing comma
        invalid("{revision:\"a\"}");                                      // lenient unquoted name
        invalid("{\"revision\":\"a\"} // comment");
        invalid("{\"revision\":\"a\",\"facilities\":{}}");
        invalid("{\"revision\":\"a\",\"facilities\":[\"x\"]}");
        String bomb = "[".repeat(100_000) + "]".repeat(100_000);
        assertTrue(invalid("{\"revision\":\"a\",\"residents\":" + bomb + "}").contains("nested"));
        assertEquals(1, WatchList.nesting("{\"revision\":\"[[[[\\\"{{\"}"), "brackets inside strings (and escaped quotes) do not count");
    }

    @Test
    void anEmptyListIsValidAndWatchesNothing() throws Exception {
        WatchList w = WatchList.parse("{\"revision\":\"empty\",\"residents\":[],\"facilities\":[]}");
        assertTrue(w.residents().isEmpty());
        assertNull(WatchList.EMPTY.revision());
        assertNull(WatchList.EMPTY.residentName(Fixtures.GARY));
    }
}
