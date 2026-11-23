package dev.residents.observer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The fixed, read-only vocabulary of {@code GET /v1/query}. A request names one {@link Kind} and
 * parameters from that kind's fixed schema; nothing else is interpreted (no expressions, paths or
 * code). Validation is strict and done here, before any work: unknown kinds or parameters are
 * refused, numbers outside their range are clamped (and reported as clamped), subjects are limited
 * to configured residents and registered facilities, and scopes are checked. Pure and unit-tested.
 *
 * <p>Adding a read is one {@link Kind} constant here plus its executor in {@link QueryService}.
 */
public final class QueryVocabulary {

    private QueryVocabulary() {
    }

    public static final int VERSION = 1;
    static final int MAX_QUERY_CHARS = 2048;
    static final int MAX_PARAMS = 8;

    /** Where a kind's work happens. Every kind reads only already-held data or the server's own player files. */
    public enum Exec {
        /** Player files on a bounded request pool; never the server thread. */
        FILE,
        /** A published, immutable ring view; no game access. */
        RING,
        /** A copy made on the server thread through the budgeted tick queue. */
        TICK,
        /** The immutable advancement catalog built at start/reload. */
        CATALOG
    }

    /** RESIDENTS kinds also admit a {@code self} consumer, restricted to its own resident. */
    public enum Access { RESIDENTS, FACILITIES }

    enum Type { INT, CHOICE, LIST, RESIDENT, FACILITY }

    public record Param(String name, Type type, boolean required, long min, long max, long fallback,
                        List<String> choices, String doc) {
        public Param {
            choices = List.copyOf(choices);
        }
    }

    static Param integer(String name, long min, long max, long fallback, String doc) {
        return new Param(name, Type.INT, false, min, max, fallback, List.of(), doc);
    }

    static Param choice(String name, String doc, String... choices) {
        return new Param(name, Type.CHOICE, false, 0, 0, 0, Arrays.asList(choices), doc);
    }

    static Param list(String name, List<String> choices, String doc) {
        return new Param(name, Type.LIST, false, 0, choices.size(), 0, choices, doc);
    }

    static Param resident(boolean required) {
        return new Param("resident", Type.RESIDENT, required, 0, 0, 0, List.of(),
                "a configured resident name (case-sensitive)" + (required ? "" : "; absent: every resident the token may read"));
    }

    static Param facility() {
        return new Param("facility", Type.FACILITY, false, 0, 0, 0, List.of(),
                "a registered facility id; absent: every registered facility");
    }

    private static final String AFTER = "cursor: entries with a larger seq (use nextAfter from the last reply)";

    public enum Kind {
        STATS("stats", Access.RESIDENTS, Exec.FILE, 3,
                "Vanilla statistics the server keeps for a resident (distance by means, mined/crafted/used/picked up by id, kills, deaths, damage, time played...). As of the server's last save of that player (autosave ~5 min, logout).",
                resident(true),
                list("types", PlayerFiles.STAT_TYPES, "comma-separated statistic types; absent: all"),
                integer("limit", 1, 2000, 1000, "entries per type, largest values first")),
        ADVANCEMENTS("advancements", Access.RESIDENTS, Exec.FILE, 3,
                "Advancement progress of a resident, vanilla and modded trees: done, achieved criteria with times; criteriaTotal/title from the catalog. Not-started advancements are absent (see advancement_catalog).",
                resident(true),
                choice("include", "all | done | progress (started, not done)", "all", "done", "progress"),
                choice("recipes", "include recipe unlocks (ns:recipes/...)", "no", "yes"),
                integer("offset", 0, 100_000, 0, "skip this many matches (sorted by id)"),
                integer("limit", 1, 2000, 1000, "advancements per reply")),
        ADVANCEMENT_CATALOG("advancement_catalog", Access.RESIDENTS, Exec.CATALOG, 1,
                "Every loaded advancement that has a display: id, title, frame, criteria and requirement counts, parent.",
                integer("offset", 0, 100_000, 0, "skip this many (sorted by id)"),
                integer("limit", 1, 2000, 1000, "entries per reply")),
        BLOCKS("blocks", Access.RESIDENTS, Exec.RING, 1,
                "Recent block place/break changes by residents, one per change (bounded detail ring; may skip under bursts, see block_hours for complete counts).",
                resident(false),
                integer("after", 0, Long.MAX_VALUE, 0, AFTER),
                integer("limit", 1, 1000, 500, "changes per reply")),
        BLOCK_HOURS("block_hours", Access.RESIDENTS, Exec.TICK, 2,
                "Place/break counts per resident, dimension, chunk and wall-clock hour, with per-block-id counts; plus per-hour overflow counted without a position.",
                resident(false),
                integer("sinceHour", 0, Long.MAX_VALUE, 0, "epoch ms; cells of this hour and later"),
                integer("offset", 0, 65_536, 0, "skip this many matching cells"),
                integer("limit", 1, 1000, 500, "cells per reply")),
        FLOWS("flows", Access.FACILITIES, Exec.RING, 1,
                "Item count changes in registered facilities between two observations, with the residents within reach at the time (evidence, not proof).",
                facility(),
                integer("after", 0, Long.MAX_VALUE, 0, AFTER),
                integer("limit", 1, 500, 200, "flows per reply"));

        public final String id;
        public final Access access;
        public final Exec exec;
        /** Rate-limit tokens one request of this kind consumes. */
        public final int cost;
        public final String doc;
        public final List<Param> params;

        Kind(String id, Access access, Exec exec, int cost, String doc, Param... params) {
            this.id = id;
            this.access = access;
            this.exec = exec;
            this.cost = cost;
            this.doc = doc;
            this.params = List.of(params);
        }

        static Kind byId(String id) {
            for (Kind k : values()) if (k.id.equals(id)) return k;
            return null;
        }
    }

    /** A refused request: HTTP status, stable code and a message safe to return. */
    public static final class Refused extends RuntimeException {
        public final int status;
        public final String code;

        Refused(int status, String code, String message) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
        }
    }

    /** A validated request. {@code values} holds every parameter's effective value (defaults filled in). */
    public record Request(Kind kind, Map<String, Object> values, List<String> clamped) {
        public Request {
            values = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(values));
            clamped = List.copyOf(clamped);
        }

        public long number(String name) {
            return (Long) values.get(name);
        }

        public String text(String name) {
            return (String) values.get(name);
        }

        @SuppressWarnings("unchecked")
        public List<String> list(String name) {
            return (List<String>) values.get(name);
        }

        public ObserverConfig.ResidentSpec resident() {
            return (ObserverConfig.ResidentSpec) values.get("resident");
        }

        public ObserverConfig.FacilitySpec facility() {
            return (ObserverConfig.FacilitySpec) values.get("facility");
        }

        /** Effective parameters as plain JSON (subjects by name/id), echoed in every reply. */
        public JsonObject echo() {
            JsonObject o = new JsonObject();
            values.forEach((k, v) -> {
                if (v == null) o.add(k, com.google.gson.JsonNull.INSTANCE);
                else if (v instanceof Long n) o.addProperty(k, n);
                else if (v instanceof String s) o.addProperty(k, s);
                else if (v instanceof ObserverConfig.ResidentSpec r) o.addProperty(k, r.name());
                else if (v instanceof ObserverConfig.FacilitySpec f) o.addProperty(k, f.id());
                else if (v instanceof List<?> l) {
                    JsonArray a = new JsonArray();
                    l.forEach(x -> a.add(String.valueOf(x)));
                    o.add(k, a);
                }
            });
            return o;
        }
    }

    /** May this consumer use this kind at all (before subjects are checked)? */
    static boolean allowed(Kind kind, ObserverConfig.ConsumerSpec consumer) {
        return kind.access == Access.FACILITIES ? consumer.has(Scope.FACILITIES)
                : consumer.has(Scope.RESIDENTS) || consumer.has(Scope.SELF);
    }

    /** Decode once, bound size and count, refuse duplicates. Same rules as the other endpoints. */
    static Map<String, String> pairs(String rawQuery) {
        Map<String, String> out = new LinkedHashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) return out;
        if (rawQuery.length() > MAX_QUERY_CHARS) throw new Refused(400, "bad_request", "The query string is too long.");
        String[] parts = rawQuery.split("&", -1);
        if (parts.length > MAX_PARAMS) throw new Refused(400, "bad_request", "Too many parameters.");
        try {
            for (String part : parts) {
                int eq = part.indexOf('=');
                String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
                String v = URLDecoder.decode(eq < 0 ? "" : part.substring(eq + 1), StandardCharsets.UTF_8);
                if (out.put(k, v) != null) throw new Refused(400, "bad_request", "Parameter '" + k + "' is repeated.");
            }
        } catch (IllegalArgumentException e) {
            throw new Refused(400, "bad_request", "The query string is not valid percent-encoding.");
        }
        return out;
    }

    public static Request parse(String rawQuery, ObserverConfig.ConsumerSpec consumer, ObserverConfig config) {
        Map<String, String> given = pairs(rawQuery);
        String kindId = given.remove("kind");
        if (kindId == null || kindId.isEmpty()) throw new Refused(400, "bad_request", "kind is required; see /v1/queries.");
        Kind kind = Kind.byId(kindId);
        if (kind == null) throw new Refused(400, "unknown_kind", "Unknown query kind; see /v1/queries.");
        if (!allowed(kind, consumer)) {
            throw new Refused(403, "forbidden", "This token has no " + (kind.access == Access.FACILITIES ? "facilities" : "residents or self") + " scope.");
        }
        for (String name : given.keySet()) {
            if (kind.params.stream().noneMatch(p -> p.name().equals(name))) {
                throw new Refused(400, "unknown_param", "Parameter '" + clip(name) + "' is not part of " + kind.id + ".");
            }
        }
        Map<String, Object> values = new LinkedHashMap<>();
        List<String> clamped = new ArrayList<>();
        boolean selfOnly = !consumer.has(Scope.RESIDENTS) && consumer.has(Scope.SELF);
        for (Param p : kind.params) {
            String raw = given.get(p.name());
            switch (p.type()) {
                case INT -> {
                    long v = p.fallback();
                    if (raw != null) {
                        if (!raw.matches("[0-9]{1,19}")) throw new Refused(400, "bad_request", p.name() + " must be a whole number.");
                        try {
                            v = Long.parseLong(raw);
                        } catch (NumberFormatException e) {
                            throw new Refused(400, "bad_request", p.name() + " is too large.");
                        }
                        if (v < p.min() || v > p.max()) {
                            v = Math.max(p.min(), Math.min(p.max(), v));
                            clamped.add(p.name());
                        }
                    }
                    values.put(p.name(), v);
                }
                case CHOICE -> {
                    String v = raw == null ? p.choices().get(0) : raw;
                    if (!p.choices().contains(v)) throw new Refused(400, "bad_request", p.name() + " must be one of " + p.choices() + ".");
                    values.put(p.name(), v);
                }
                case LIST -> {
                    Set<String> v = new LinkedHashSet<>();
                    if (raw != null && !raw.isEmpty()) {
                        for (String item : raw.split(",", -1)) {
                            if (!p.choices().contains(item)) throw new Refused(400, "bad_request", p.name() + " items must be among " + p.choices() + ".");
                            v.add(item);
                        }
                    }
                    values.put(p.name(), List.copyOf(v));
                }
                case RESIDENT -> {
                    ObserverConfig.ResidentSpec r;
                    if (raw == null || raw.isEmpty()) {
                        r = selfOnly ? config.resident(consumer.resident()) : null;
                        if (r == null && p.required()) throw new Refused(400, "bad_request", "resident is required.");
                    } else {
                        r = config.resident(raw);
                        // Unknown and unconfigured (human, spectator) names look the same: nothing is revealed.
                        if (r == null) throw new Refused(404, "unknown_subject", "Not a configured resident.");
                        if (selfOnly && !r.name().equals(consumer.resident())) {
                            throw new Refused(403, "forbidden", "A self token reads only its own resident.");
                        }
                    }
                    values.put(p.name(), r);
                }
                case FACILITY -> {
                    ObserverConfig.FacilitySpec f = null;
                    if (raw != null && !raw.isEmpty()) {
                        f = config.facility(raw);
                        if (f == null) throw new Refused(404, "unknown_subject", "Not a registered facility.");
                    }
                    values.put(p.name(), f);
                }
            }
        }
        return new Request(kind, values, clamped);
    }

    /** {@code GET /v1/queries}: the kinds this consumer may use, their parameters, limits and subjects. */
    public static JsonObject describe(ObserverConfig.ConsumerSpec consumer, ObserverConfig config) {
        JsonObject o = new JsonObject();
        o.addProperty("vocabularyVersion", VERSION);
        JsonArray kinds = new JsonArray();
        for (Kind k : Kind.values()) {
            if (!allowed(k, consumer)) continue;
            JsonObject j = new JsonObject();
            j.addProperty("kind", k.id);
            j.addProperty("scope", k.access == Access.FACILITIES ? "facilities" : "residents|self");
            j.addProperty("executes", k.exec.name().toLowerCase(java.util.Locale.ROOT));
            j.addProperty("cost", k.cost);
            j.addProperty("doc", k.doc);
            JsonArray params = new JsonArray();
            for (Param p : k.params) {
                JsonObject q = new JsonObject();
                q.addProperty("name", p.name());
                q.addProperty("type", p.type().name().toLowerCase(java.util.Locale.ROOT));
                q.addProperty("required", p.required());
                if (p.type() == Type.INT) {
                    q.addProperty("min", p.min());
                    q.addProperty("max", p.max());
                    q.addProperty("default", p.fallback());
                }
                if (!p.choices().isEmpty()) {
                    JsonArray c = new JsonArray();
                    p.choices().forEach(c::add);
                    q.add("choices", c);
                }
                q.addProperty("doc", p.doc());
                params.add(q);
            }
            j.add("params", params);
            kinds.add(j);
        }
        o.add("kinds", kinds);
        JsonObject subjects = new JsonObject();
        JsonArray residents = new JsonArray();
        for (ObserverConfig.ResidentSpec r : config.residents()) {
            if (consumer.has(Scope.RESIDENTS) || r.name().equals(consumer.resident())) residents.add(r.name());
        }
        subjects.add("residents", residents);
        JsonArray facilities = new JsonArray();
        if (consumer.has(Scope.FACILITIES)) config.facilities().forEach(f -> facilities.add(f.id()));
        subjects.add("facilities", facilities);
        o.add("subjects", subjects);
        ObserverConfig.Recording r = config.recording();
        JsonObject limits = new JsonObject();
        limits.addProperty("ratePerMinute", r.queryRatePerMinute());
        limits.addProperty("burst", r.queryBurst());
        limits.addProperty("maxReplyBytes", QueryService.MAX_REPLY_BYTES);
        limits.addProperty("recordBlocks", r.recordBlocks());
        limits.addProperty("blockDetailCapacity", r.blockDetailCapacity());
        limits.addProperty("blockDetailPerTick", r.blockDetailPerTick());
        limits.addProperty("blockAggregateCells", r.blockAggregateCells());
        limits.addProperty("blockAggregateHours", r.blockAggregateHours());
        limits.addProperty("recordFlows", r.recordFlows());
        limits.addProperty("flowCapacity", r.flowCapacity());
        limits.addProperty("flowReach", r.flowReach());
        limits.addProperty("maxPlayerFileBytes", r.maxPlayerFileBytes());
        o.add("limits", limits);
        return o;
    }

    private static String clip(String s) {
        return s.length() > 32 ? s.substring(0, 32) + "…" : s;
    }
}
