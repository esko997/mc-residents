package dev.residents.observer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonViewsTest {

    private final Fixtures.Clock clock = new Fixtures.Clock();
    private final Fixtures.FakeWorld world = new Fixtures.FakeWorld(clock);
    private final ObserverConfig config = Fixtures.config("\"intervalTicks\":1,", 2);
    private final Sampler sampler = Fixtures.sampler(config, world, new ArrayList<>());

    private JsonObject snapshotFor(String consumer) {
        String text = JsonViews.toJson(JsonViews.snapshot(Fixtures.consumer(config, consumer), sampler.snapshot(),
                sampler.state(clock.ms), clock.ms, sampler.heartbeatAtMs()));
        return JsonParser.parseString(text).getAsJsonObject();
    }

    private void tickWithBothOnline() {
        world.online.put(Fixtures.GARY, Fixtures.body(clock.ms, "minecraft:overworld", 10.04, false));
        world.online.put(Fixtures.MARGO, Fixtures.body(clock.ms, "minecraft:overworld", 50, false));
        sampler.onServerTick();
    }

    @Test
    void theOperatorSeesEveryResidentAndFacilityWithTimes() {
        tickWithBothOnline();
        JsonObject o = snapshotFor("commons");
        assertEquals(1, o.get("schema").getAsInt());
        assertEquals("server-observer", o.get("source").getAsString());
        assertEquals("ok", o.get("state").getAsString());
        JsonObject snap = o.getAsJsonObject("snapshot");
        assertEquals(clock.ms, snap.get("builtAtMs").getAsLong());
        JsonArray residents = snap.getAsJsonArray("residents");
        assertEquals(2, residents.size());
        JsonObject gary = residents.get(0).getAsJsonObject();
        assertEquals("Gary", gary.get("name").getAsString());
        assertEquals(10.0, gary.getAsJsonObject("body").getAsJsonObject("pos").get("x").getAsDouble());
        assertTrue(gary.get("lastSeen").isJsonNull());
        JsonObject facility = snap.getAsJsonArray("facilities").get(0).getAsJsonObject();
        assertEquals("observed", facility.get("status").getAsString());
        assertEquals("minecraft:cobblestone",
                facility.getAsJsonObject("contents").getAsJsonArray("items").get(0).getAsJsonObject().get("item").getAsString());
        assertTrue(facility.get("lastKnown").isJsonNull());
    }

    @Test
    void aResidentTokenSeesOnlyItselfAndNoStock() {
        tickWithBothOnline();
        JsonObject o = snapshotFor("gary");
        JsonArray residents = o.getAsJsonObject("snapshot").getAsJsonArray("residents");
        assertEquals(1, residents.size());
        assertEquals("Gary", residents.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals(0, o.getAsJsonObject("snapshot").getAsJsonArray("facilities").size());
        assertFalse(o.toString().contains("Margo"));
        assertFalse(o.toString().contains(Fixtures.MARGO.toString()));
    }

    @Test
    void aResidentTokenGetsOnlyItsOwnEventsPlusObserverHealth() {
        tickWithBothOnline();
        world.status.put("f0", Observations.FacilityStatus.UNLOADED);
        sampler.onServerTick();
        JsonObject o = JsonViews.events(Fixtures.consumer(config, "gary"), sampler.events(), 0, 100,
                sampler.state(clock.ms), clock.ms, sampler.heartbeatAtMs());
        for (JsonElement e : o.getAsJsonArray("events")) {
            JsonObject event = e.getAsJsonObject();
            assertTrue(event.get("facility").isJsonNull(), "no facility events for a resident token");
            assertTrue(event.get("resident").isJsonNull() || "Gary".equals(event.get("resident").getAsString()));
        }
        assertTrue(o.toString().contains("observer_started"));
        assertTrue(o.toString().contains("resident_online"));
        assertFalse(o.get("gap").getAsBoolean());

        JsonObject all = JsonViews.events(Fixtures.consumer(config, "commons"), sampler.events(), 0, 100,
                sampler.state(clock.ms), clock.ms, sampler.heartbeatAtMs());
        assertTrue(all.toString().contains("facility_status"));
        assertTrue(all.toString().contains("Margo"));
    }

    @Test
    void beforeTheFirstTickThereIsAStateButNoSnapshot() {
        JsonObject o = snapshotFor("commons");
        assertTrue(o.get("snapshot").isJsonNull());
        assertEquals("starting", o.get("state").getAsString());
    }

    @Test
    void historyIsLabelledAsSuchWhenAFacilityUnloads() {
        tickWithBothOnline();
        world.status.put("f0", Observations.FacilityStatus.UNLOADED);
        clock.ms += 2000;
        sampler.onServerTick();
        JsonObject f = snapshotFor("commons").getAsJsonObject("snapshot").getAsJsonArray("facilities").get(0).getAsJsonObject();
        assertEquals("unloaded", f.get("status").getAsString());
        assertTrue(f.get("contents").isJsonNull());
        assertFalse(f.get("lastKnown").isJsonNull());
        assertEquals(clock.ms - 2000, f.get("lastObservedAtMs").getAsLong());
    }

    @Test
    void statusReportsBudgetAndCountersWithoutSecrets() {
        sampler.onServerTick();
        JsonObject o = JsonViews.status(Fixtures.consumer(config, "ops"), sampler.status(), sampler.events(),
                sampler.state(clock.ms), clock.ms, sampler.heartbeatAtMs());
        JsonObject st = o.getAsJsonObject("status");
        assertEquals(500, st.get("budgetMicros").getAsInt());
        assertEquals(2, st.get("residentsConfigured").getAsInt());
        String text = o.toString();
        for (ObserverConfig.ConsumerSpec c : config.consumers()) {
            assertFalse(text.contains(c.tokenSha256()), "no token hashes in output");
        }
    }
}
