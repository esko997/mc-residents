package dev.residents.observer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.Comparator;
import java.util.function.Predicate;

/**
 * Serializes published observations for one consumer, filtered by its scopes. Runs on request
 * threads over immutable values only. Pure and unit-tested; the scope filter lives here so the
 * HTTP layer cannot forget it.
 */
public final class JsonViews {

    public static final int SCHEMA = 1;
    public static final String SOURCE = "server-observer";

    private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    private JsonViews() {
    }

    public static String toJson(JsonObject o) {
        return GSON.toJson(o);
    }

    /** Common header: who is asking, what they may see, and the observer's health right now. */
    static JsonObject header(ObserverConfig.ConsumerSpec consumer, Sampler.State state, long nowMs, long heartbeatAtMs) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SCHEMA);
        o.addProperty("source", SOURCE);
        o.addProperty("consumer", consumer.name());
        JsonArray scopes = new JsonArray();
        consumer.scopes().stream().map(Scope::id).sorted().forEach(scopes::add);
        o.add("scopes", scopes);
        o.addProperty("state", state.id());
        o.addProperty("stateDetail", state.detail());
        o.addProperty("servedAtMs", nowMs);
        o.addProperty("heartbeatAtMs", heartbeatAtMs);
        return o;
    }

    /** Tick results contain only immutable bounded DTOs, never game objects or NBT. */
    static JsonObject bridge(ObserverConfig.ConsumerSpec consumer, String key, Object value,
                             Sampler.State state, long nowMs, long heartbeatAtMs) {
        JsonObject o = header(consumer, state, nowMs, heartbeatAtMs);
        o.add(key, GSON.toJsonTree(value));
        return o;
    }

    public static JsonObject snapshot(ObserverConfig.ConsumerSpec consumer, Observations.Snapshot snap,
                                      Sampler.State state, long nowMs, long heartbeatAtMs) {
        JsonObject o = header(consumer, state, nowMs, heartbeatAtMs);
        if (snap == null) {
            o.add("snapshot", JsonNull.INSTANCE);
            return o;
        }
        JsonObject s = new JsonObject();
        s.addProperty("seq", snap.seq());
        s.addProperty("builtAtMs", snap.builtAtMs());
        s.addProperty("gameTime", snap.gameTime());
        JsonArray residents = new JsonArray();
        for (Observations.Resident r : snap.residents()) {
            if (r != null && mayReadResident(consumer, r.name())) {
                residents.add(resident(r));
            }
        }
        s.add("residents", residents);
        JsonArray facilities = new JsonArray();
        if (consumer.has(Scope.FACILITIES)) {
            for (Observations.Facility f : snap.facilities()) {
                facilities.add(facility(f));
            }
        }
        s.add("facilities", facilities);
        o.add("snapshot", s);
        return o;
    }

    public static JsonObject events(ObserverConfig.ConsumerSpec consumer, EventLog.View view, long after, int limit,
                                    Sampler.State state, long nowMs, long heartbeatAtMs) {
        JsonObject o = header(consumer, state, nowMs, heartbeatAtMs);
        EventLog.Page page = EventLog.page(view, after, limit, eventFilter(consumer));
        JsonArray arr = new JsonArray();
        for (Observations.Event e : page.events()) {
            JsonObject j = new JsonObject();
            j.addProperty("seq", e.seq());
            j.addProperty("type", e.type());
            j.addProperty("atMs", e.atMs());
            j.addProperty("gameTime", e.gameTime());
            j.addProperty("resident", e.resident());
            j.addProperty("facility", e.facility());
            j.addProperty("detail", e.detail());
            arr.add(j);
        }
        o.add("events", arr);
        o.addProperty("oldestSeq", page.oldestSeq());
        o.addProperty("latestSeq", page.latestSeq());
        o.addProperty("gap", page.gap());
        return o;
    }

    public static JsonObject status(ObserverConfig.ConsumerSpec consumer, Observations.Status st, EventLog.View events,
                                    Sampler.State state, long nowMs, long heartbeatAtMs) {
        JsonObject o = header(consumer, state, nowMs, heartbeatAtMs);
        if (st == null) {
            o.add("status", JsonNull.INSTANCE);
            return o;
        }
        JsonObject s = new JsonObject();
        s.addProperty("startedAtMs", st.startedAtMs());
        s.addProperty("lastPublishAtMs", st.lastPublishAtMs());
        s.addProperty("ticks", st.ticks());
        s.addProperty("lastTickMicros", st.lastTickMicros());
        s.addProperty("maxTickMicros", st.maxTickMicros());
        s.addProperty("budgetMicros", st.budgetMicros());
        s.addProperty("overBudgetTicks", st.overBudgetTicks());
        s.addProperty("intervalTicks", st.intervalTicks());
        s.addProperty("lagCycles", st.lagCycles());
        s.addProperty("lagStreak", st.lagStreak());
        s.addProperty("consecutiveFailures", st.consecutiveFailures());
        s.addProperty("failureTripCount", st.failureTripCount());
        s.addProperty("lastError", st.lastError());
        s.addProperty("tripped", st.tripped());
        s.addProperty("paused", st.paused());
        s.addProperty("residentsConfigured", st.residentsConfigured());
        s.addProperty("facilitiesConfigured", st.facilitiesConfigured());
        s.addProperty("eventsDropped", events.dropped());
        o.add("status", s);
        return o;
    }

    // === scope policy ===

    static boolean mayReadResident(ObserverConfig.ConsumerSpec consumer, String name) {
        return consumer.has(Scope.RESIDENTS) || (consumer.has(Scope.SELF) && name.equals(consumer.resident()));
    }

    static Predicate<Observations.Event> eventFilter(ObserverConfig.ConsumerSpec consumer) {
        return e -> {
            if (e.resident() != null) {
                return mayReadResident(consumer, e.resident());
            }
            if (e.facility() != null) {
                return consumer.has(Scope.FACILITIES);
            }
            return true; // observer_started / observer_tripped: health, not world data
        };
    }

    // === values ===

    private static JsonObject resident(Observations.Resident r) {
        JsonObject o = new JsonObject();
        o.addProperty("name", r.name());
        o.addProperty("uuid", r.uuid().toString());
        o.addProperty("online", r.online());
        o.addProperty("checkedAtMs", r.checkedAtMs());
        o.add("body", r.body() == null ? JsonNull.INSTANCE : body(r.body()));
        o.add("lastSeen", r.lastSeen() == null ? JsonNull.INSTANCE : body(r.lastSeen()));
        return o;
    }

    private static JsonObject body(Observations.Body b) {
        JsonObject o = new JsonObject();
        o.addProperty("atMs", b.atMs());
        o.addProperty("gameTime", b.gameTime());
        o.addProperty("dimension", b.dimension());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", round1(b.x()));
        pos.addProperty("y", round1(b.y()));
        pos.addProperty("z", round1(b.z()));
        o.add("pos", pos);
        o.addProperty("health", round1(b.health()));
        o.addProperty("maxHealth", round1(b.maxHealth()));
        o.addProperty("food", b.food());
        o.addProperty("air", b.air());
        o.addProperty("maxAir", b.maxAir());
        o.addProperty("gameMode", b.gameMode());
        o.addProperty("dead", b.dead());
        o.addProperty("sleeping", b.sleeping());
        o.addProperty("vehicle", b.vehicle());
        o.addProperty("xpLevel", b.xpLevel());
        return o;
    }

    private static JsonObject facility(Observations.Facility f) {
        ObserverConfig.FacilitySpec spec = f.spec();
        JsonObject o = new JsonObject();
        o.addProperty("id", spec.id());
        o.addProperty("label", spec.label());
        o.addProperty("dimension", spec.dimension());
        JsonArray pos = new JsonArray();
        pos.add(spec.x());
        pos.add(spec.y());
        pos.add(spec.z());
        o.add("pos", pos);
        o.addProperty("side", spec.side());
        o.addProperty("status", f.status().id());
        o.addProperty("detail", f.detail());
        o.addProperty("checkedAtMs", f.checkedAtMs());
        o.addProperty("gameTime", f.gameTime());
        o.add("contents", f.contents() == null ? JsonNull.INSTANCE : contents(f.contents()));
        o.addProperty("lastObservedAtMs", f.lastObservedAtMs());
        o.add("lastKnown", f.lastKnown() == null ? JsonNull.INSTANCE : contents(f.lastKnown()));
        return o;
    }

    private static JsonObject contents(Observations.Contents c) {
        JsonObject o = new JsonObject();
        o.addProperty("block", c.block());
        o.addProperty("slots", c.slots());
        o.addProperty("usedSlots", c.usedSlots());
        o.addProperty("slotsTruncated", c.slotsTruncated());
        JsonArray items = new JsonArray();
        c.items().stream()
                .sorted(Comparator.comparingLong(Observations.ItemCount::count).reversed()
                        .thenComparing(Observations.ItemCount::item))
                .forEach(i -> {
                    JsonObject j = new JsonObject();
                    j.addProperty("item", i.item());
                    j.addProperty("count", i.count());
                    j.addProperty("nbtStacks", i.nbtStacks());
                    items.add(j);
                });
        o.add("items", items);
        o.addProperty("itemsTruncated", c.itemsTruncated());
        if (c.energy() == null) {
            o.add("energy", JsonNull.INSTANCE);
        } else {
            JsonObject e = new JsonObject();
            e.addProperty("stored", c.energy().stored());
            e.addProperty("max", c.energy().max());
            o.add("energy", e);
        }
        JsonArray fluids = new JsonArray();
        for (Observations.FluidAmount fl : c.fluids()) {
            JsonObject j = new JsonObject();
            j.addProperty("fluid", fl.fluid());
            j.addProperty("amount", fl.amount());
            j.addProperty("capacity", fl.capacity());
            fluids.add(j);
        }
        o.add("fluids", fluids);
        o.addProperty("readMicros", c.readMicros());
        return o;
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
