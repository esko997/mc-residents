package dev.residents.observer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicLongArray;
import java.util.function.Function;

/**
 * Executes validated {@link QueryVocabulary.Request}s. Never touches the game from a request
 * thread: RING and CATALOG kinds read published immutable values, FILE kinds read the server's
 * player files (a bounded request pool), and TICK kinds hand a bounded copy job to the sampler's
 * budgeted tick queue through {@link TickReader}. Every result is bounded by its kind's limits.
 */
public final class QueryService {

    public static final int MAX_REPLY_BYTES = 4 << 20;
    private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    /** Runs a read on the server tick and waits for it; failures are thrown as {@link QueryVocabulary.Refused}. */
    public interface TickReader {
        <T> T read(Function<BridgeAccess, T> job);
    }

    private final Sampler sampler;
    private final PlayerFiles files;
    private final AtomicLongArray served = new AtomicLongArray(QueryVocabulary.Kind.values().length);
    private final AtomicLong refused = new AtomicLong(), rateLimited = new AtomicLong(), tooLarge = new AtomicLong();

    public QueryService(Sampler sampler, PlayerFiles files) {
        this.sampler = sampler;
        this.files = files;
    }

    public JsonObject answer(QueryVocabulary.Request r, TickReader tick) {
        JsonElement result = switch (r.kind()) {
            case STATS -> stats(r);
            case ADVANCEMENTS -> advancements(r);
            case ADVANCEMENT_CATALOG -> catalog(r);
            case BLOCKS -> blocks(r);
            case BLOCK_HOURS -> hours(r, tick);
            case FLOWS -> flows(r);
        };
        served.incrementAndGet(r.kind().ordinal());
        JsonObject q = new JsonObject();
        q.addProperty("kind", r.kind().id);
        q.addProperty("vocabularyVersion", QueryVocabulary.VERSION);
        q.addProperty("runStartedAtMs", sampler.startedAtMs());
        q.add("params", r.echo());
        JsonArray clamped = new JsonArray();
        r.clamped().forEach(clamped::add);
        q.add("clamped", clamped);
        q.add("result", result);
        return q;
    }

    void countRefused() {
        refused.incrementAndGet();
    }

    void countRateLimited() {
        rateLimited.incrementAndGet();
    }

    void countTooLarge() {
        tooLarge.incrementAndGet();
    }

    private PlayerFiles files() {
        if (files == null) throw new QueryVocabulary.Refused(503, "unavailable", "Player files are not available on this server.");
        return files;
    }

    private JsonElement stats(QueryVocabulary.Request r) {
        PlayerFiles.StatsResult s = files().stats(r.resident(), r.list("types"), (int) r.number("limit"));
        JsonObject o = new JsonObject();
        o.addProperty("resident", s.resident());
        o.addProperty("status", s.status());
        o.addProperty("reason", s.reason());
        o.addProperty("savedAtMs", s.savedAtMs());
        o.addProperty("dataVersion", s.dataVersion());
        o.addProperty("skipped", s.skipped());
        JsonArray types = new JsonArray();
        for (PlayerFiles.StatType t : s.types()) {
            JsonObject j = new JsonObject();
            j.addProperty("type", t.type());
            j.addProperty("total", t.total());
            j.addProperty("truncated", t.truncated());
            JsonObject values = new JsonObject(); // largest first; JSON object keeps that order
            for (PlayerFiles.StatEntry e : t.entries()) values.addProperty(e.key(), e.value());
            j.add("values", values);
            types.add(j);
        }
        o.add("types", types);
        return o;
    }

    private JsonElement advancements(QueryVocabulary.Request r) {
        PlayerFiles.AdvancementsResult a = files().advancements(r.resident(), r.text("include"),
                r.text("recipes").equals("yes"), (int) r.number("offset"), (int) r.number("limit"));
        return GSON.toJsonTree(a);
    }

    private JsonElement catalog(QueryVocabulary.Request r) {
        AdvancementCatalog c = files == null ? null : files.catalog();
        JsonObject o = new JsonObject();
        if (c == null) c = AdvancementCatalog.unavailable("no catalog on this server", 0L);
        int offset = (int) Math.min(r.number("offset"), c.entries().size());
        int end = (int) Math.min(c.entries().size(), offset + r.number("limit"));
        o.addProperty("builtAtMs", c.builtAtMs());
        o.addProperty("buildMicros", c.buildMicros());
        o.addProperty("seen", c.seen());
        o.addProperty("total", c.entries().size());
        o.addProperty("truncated", c.truncated());
        o.addProperty("problem", c.problem());
        o.addProperty("offset", offset);
        o.addProperty("more", end < c.entries().size());
        o.add("entries", GSON.toJsonTree(c.entries().subList(offset, end)));
        return o;
    }

    private JsonElement blocks(QueryVocabulary.Request r) {
        ObserverConfig.ResidentSpec only = r.resident();
        SeqRing.Page<BlockLog.Change> page = SeqRing.page(sampler.blocks().detail(), r.number("after"),
                (int) r.number("limit"), c -> only == null || only.name().equals(c.resident()));
        JsonObject o = pageHeader(page);
        JsonArray changes = new JsonArray();
        for (SeqRing.Entry<BlockLog.Change> e : page.entries()) {
            JsonObject j = GSON.toJsonTree(e.value()).getAsJsonObject();
            j.addProperty("seq", e.seq());
            changes.add(j);
        }
        o.add("changes", changes);
        o.add("recorder", GSON.toJsonTree(sampler.blocks().metrics()));
        return o;
    }

    private JsonElement hours(QueryVocabulary.Request r, TickReader tick) {
        ObserverConfig.ResidentSpec only = r.resident();
        long since = r.number("sinceHour");
        int offset = (int) r.number("offset"), limit = (int) r.number("limit");
        BlockLog log = sampler.blocks();
        // The copy runs on the server thread through the budgeted queue; only immutable records come back.
        BlockLog.HoursPage page = tick.read(bridge -> log.hours(since, only == null ? null : only.name(), offset, limit));
        JsonObject o = GSON.toJsonTree(page).getAsJsonObject();
        o.add("recorder", GSON.toJsonTree(log.metrics()));
        return o;
    }

    private JsonElement flows(QueryVocabulary.Request r) {
        ObserverConfig.FacilitySpec only = r.facility();
        SeqRing.View<Flows.Flow> view = sampler.flows();
        SeqRing.Page<Flows.Flow> page = SeqRing.page(view, r.number("after"), (int) r.number("limit"),
                f -> only == null || only.id().equals(f.facility()));
        JsonObject o = pageHeader(page);
        o.addProperty("dropped", view.dropped());
        o.addProperty("evidence", "proximity of configured residents only; human players, hoppers, pipes and machines are not observed");
        JsonArray flows = new JsonArray();
        for (SeqRing.Entry<Flows.Flow> e : page.entries()) {
            JsonObject j = GSON.toJsonTree(e.value()).getAsJsonObject();
            j.addProperty("seq", e.seq());
            flows.add(j);
        }
        o.add("flows", flows);
        return o;
    }

    private static JsonObject pageHeader(SeqRing.Page<?> page) {
        JsonObject o = new JsonObject();
        o.addProperty("oldestSeq", page.oldestSeq());
        o.addProperty("latestSeq", page.latestSeq());
        o.addProperty("gap", page.gap());
        o.addProperty("nextAfter", page.nextAfter());
        return o;
    }

    /** For {@code /v1/status}: counters of this service and the recorders it reads. */
    public JsonObject metrics() {
        JsonObject o = new JsonObject();
        JsonObject kinds = new JsonObject();
        for (QueryVocabulary.Kind k : QueryVocabulary.Kind.values()) kinds.addProperty(k.id, served.get(k.ordinal()));
        o.add("served", kinds);
        o.addProperty("refused", refused.get());
        o.addProperty("rateLimited", rateLimited.get());
        o.addProperty("tooLarge", tooLarge.get());
        o.add("files", files == null ? com.google.gson.JsonNull.INSTANCE : GSON.toJsonTree(files.metrics()));
        o.add("blocks", GSON.toJsonTree(sampler.blocks().metrics()));
        JsonObject flows = new JsonObject();
        flows.addProperty("recorded", sampler.flowsRecorded());
        flows.addProperty("dropped", sampler.flows().dropped());
        o.add("flows", flows);
        AdvancementCatalog c = files == null ? null : files.catalog();
        if (c != null) {
            JsonObject cat = new JsonObject();
            cat.addProperty("entries", c.entries().size());
            cat.addProperty("builtAtMs", c.builtAtMs());
            cat.addProperty("buildMicros", c.buildMicros());
            cat.addProperty("problem", c.problem());
            o.add("advancementCatalog", cat);
        }
        return o;
    }
}
