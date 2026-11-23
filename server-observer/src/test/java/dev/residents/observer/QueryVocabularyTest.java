package dev.residents.observer;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class QueryVocabularyTest {

    private final ObserverConfig config = Fixtures.config("");
    private final WatchList watch = Fixtures.watch("r1", 2);
    private final ObserverConfig.ConsumerSpec commons = Fixtures.consumer(config, "commons");
    private final ObserverConfig.ConsumerSpec gary = Fixtures.consumer(config, "gary");
    private final ObserverConfig.ConsumerSpec ops = Fixtures.consumer(config, "ops");

    private QueryVocabulary.Refused refused(String query, ObserverConfig.ConsumerSpec who) {
        return refused(query, who, watch);
    }

    private static QueryVocabulary.Refused refused(String query, ObserverConfig.ConsumerSpec who, WatchList list) {
        return assertThrows(QueryVocabulary.Refused.class, () -> QueryVocabulary.parse(query, who, list));
    }

    @Test
    void defaultsAreFilledAndOutOfRangeNumbersAreClampedAndReported() {
        QueryVocabulary.Request r = QueryVocabulary.parse("kind=stats&resident=Gary&limit=999999", commons, watch);
        assertEquals(QueryVocabulary.Kind.STATS, r.kind());
        assertEquals(2000L, r.number("limit"));
        assertEquals(List.of("limit"), r.clamped());
        assertEquals(List.of(), r.list("types"));
        assertEquals("Gary", r.resident().name());

        QueryVocabulary.Request low = QueryVocabulary.parse("kind=blocks&limit=0", commons, watch);
        assertEquals(1L, low.number("limit"));
        assertNull(low.resident(), "absent optional resident means every resident the token may read");
        assertEquals(0L, low.number("after"));
    }

    @Test
    void onlyTheFixedVocabularyIsInterpreted() {
        assertEquals("unknown_kind", refused("kind=scan_world", commons).code);
        assertEquals(400, refused("", commons).status);
        assertEquals("unknown_param", refused("kind=stats&resident=Gary&nbtPath=a.b", commons).code);
        assertEquals(400, refused("kind=stats&resident=Gary&types=minecraft:custom,minecraft:everything", commons).status);
        assertEquals(400, refused("kind=advancements&resident=Gary&include=some", commons).status);
        assertEquals(400, refused("kind=blocks&after=-1", commons).status);
        assertEquals(400, refused("kind=blocks&after=99999999999999999999", commons).status);
        assertEquals(400, refused("kind=blocks&limit=1&limit=2", commons).status);
        assertEquals(400, refused("kind=blocks&a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8", commons).status);
        assertEquals(400, refused("kind=blocks&after=%zz", commons).status);
    }

    @Test
    void subjectsAreOnlyWatchedResidentsAndFacilities() {
        // A human player (or the spectator) is indistinguishable from an unknown name.
        assertEquals(404, refused("kind=stats&resident=spesk01", commons).status);
        assertEquals(404, refused("kind=stats&resident=gary", commons).status, "names are case-sensitive");
        assertEquals(400, refused("kind=stats", commons).status, "stats needs a resident");
        assertEquals(404, refused("kind=flows&facility=not-watched", commons).status);
        assertEquals("f1", QueryVocabulary.parse("kind=flows&facility=f1", commons, watch).facility().id());
        // Before Commons pushes, nobody is a subject.
        assertEquals(404, refused("kind=stats&resident=Gary", commons, WatchList.EMPTY).status);
    }

    @Test
    void scopesDecideWhichKindsAndWhichResidents() {
        assertEquals(403, refused("kind=stats&resident=Gary", ops).status, "status-only token");
        assertEquals(403, refused("kind=flows", gary).status, "self has no facilities");
        assertEquals(403, refused("kind=stats&resident=Margo", gary).status, "self reads only itself");
        QueryVocabulary.Request own = QueryVocabulary.parse("kind=stats", gary, watch);
        assertEquals("Gary", own.resident().name(), "self defaults to its own resident");
        assertEquals("Gary", QueryVocabulary.parse("kind=blocks", gary, watch).resident().name(),
                "self block feeds are filtered to itself");
        assertTrue(QueryVocabulary.parse("kind=advancement_catalog", gary, watch).values().containsKey("limit"));
    }

    @Test
    void aSelfTokenWhoseResidentIsNotWatchedNeverFallsBackToEveryone() {
        WatchList margoOnly = new WatchList("m", List.of(new WatchList.ResidentSpec("Margo", Fixtures.MARGO)), List.of(), null);
        assertEquals("unknown_subject", refused("kind=blocks", gary, margoOnly).code);
        assertEquals("unknown_subject", refused("kind=block_hours", gary, WatchList.EMPTY).code);
    }

    @Test
    void describeListsOnlyUsableKindsAndPermittedSubjects() {
        JsonObject all = QueryVocabulary.describe(commons, config, watch);
        assertEquals(QueryVocabulary.Kind.values().length, all.getAsJsonArray("kinds").size());
        assertEquals(2, all.getAsJsonObject("subjects").getAsJsonArray("residents").size());
        assertEquals(2, all.getAsJsonObject("subjects").getAsJsonArray("facilities").size());

        JsonObject self = QueryVocabulary.describe(gary, config, watch);
        assertEquals(QueryVocabulary.Kind.values().length - 1, self.getAsJsonArray("kinds").size());
        assertEquals("Gary", self.getAsJsonObject("subjects").getAsJsonArray("residents").get(0).getAsString());
        assertEquals(1, self.getAsJsonObject("subjects").getAsJsonArray("residents").size());
        assertEquals(0, self.getAsJsonObject("subjects").getAsJsonArray("facilities").size());
        assertEquals(60, self.getAsJsonObject("limits").get("ratePerMinute").getAsInt());
    }

    @Test
    void newConfigKeysAreOptionalAndBounded() throws Exception {
        assertEquals(ObserverConfig.Recording.DEFAULTS, config.recording());
        ObserverConfig tuned = Fixtures.config("\"queryRatePerMinute\":120,\"recordBlocks\":false,\"flowReach\":4,");
        assertEquals(120, tuned.recording().queryRatePerMinute());
        assertEquals(false, tuned.recording().recordBlocks());
        assertThrows(ObserverConfig.InvalidConfig.class,
                () -> ObserverConfig.parse(Fixtures.configJson("\"blockDetailPerTick\":100000,")));
        assertThrows(ObserverConfig.InvalidConfig.class,
                () -> ObserverConfig.parse(Fixtures.configJson("\"flowReech\":4,")));
    }
}
