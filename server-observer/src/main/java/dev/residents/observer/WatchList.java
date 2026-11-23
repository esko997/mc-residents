package dev.residents.observer;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * What the bridge watches: the residents and facilities Commons pushes with {@code PUT /v1/watch}.
 * Held in memory only; empty after a server start until Commons pushes. Immutable: a push builds a
 * new list and the server tick swaps it in whole. Parsing is strict and all-or-nothing, so an
 * invalid push changes nothing. Pure (no Minecraft types) and unit-tested.
 */
public record WatchList(String revision, List<ResidentSpec> residents, List<FacilitySpec> facilities,
                        Long appliedAtMs, Map<String, ResidentSpec> byName, Map<UUID, ResidentSpec> byUuid,
                        Map<String, FacilitySpec> byId) {

    public static final int MAX_RESIDENTS = 64;
    public static final int MAX_FACILITIES = 1024;
    public static final int MAX_BODY_BYTES = 256 << 10;
    static final int MAX_REVISION_CHARS = 128;
    private static final int MAX_JSON_DEPTH = 8;

    /** Before Commons pushes: no revision, nothing watched. */
    public static final WatchList EMPTY = new WatchList(null, List.of(), List.of(), null);

    private static final Pattern NAME = Pattern.compile("^\\w{1,16}$");
    private static final Pattern FACILITY_ID = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,47}$");
    private static final Pattern RESOURCE_LOCATION = Pattern.compile("^[a-z0-9_.-]+:[a-z0-9_./-]+$");
    private static final Pattern REVISION = Pattern.compile("^[\\x21-\\x7e]{1," + MAX_REVISION_CHARS + "}$");
    private static final Set<String> SIDES = Set.of("down", "up", "north", "south", "west", "east");
    private static final Set<String> TOP_KEYS = Set.of("revision", "residents", "facilities");
    private static final Set<String> RESIDENT_KEYS = Set.of("name", "uuid");
    private static final Set<String> FACILITY_KEYS = Set.of("id", "label", "dimension", "pos", "side");

    public record ResidentSpec(String name, UUID uuid) {
    }

    /** One watched facility: a block position whose block entity is read when its chunks are loaded. */
    public record FacilitySpec(String id, String label, String dimension, int x, int y, int z, String side) {
        /** Same place: history and the flow baseline carry over only when this matches (the label may change). */
        boolean samePlace(FacilitySpec o) {
            return id.equals(o.id) && dimension.equals(o.dimension) && x == o.x && y == o.y && z == o.z
                    && java.util.Objects.equals(side, o.side);
        }
    }

    public static final class Invalid extends Exception {
        public Invalid(String message) {
            super(message, null, false, false);
        }
    }

    public WatchList(String revision, List<ResidentSpec> residents, List<FacilitySpec> facilities, Long appliedAtMs) {
        this(revision, List.copyOf(residents), List.copyOf(facilities), appliedAtMs,
                index(residents, ResidentSpec::name), index(residents, ResidentSpec::uuid), index(facilities, FacilitySpec::id));
    }

    private static <K, V> Map<K, V> index(List<V> values, java.util.function.Function<V, K> key) {
        Map<K, V> m = new HashMap<>(values.size() * 2);
        for (V v : values) m.put(key.apply(v), v);
        return Collections.unmodifiableMap(m);
    }

    /** The same list, marked as applied by the tick at {@code atMs}. */
    WatchList appliedAt(long atMs) {
        return new WatchList(revision, residents, facilities, atMs, byName, byUuid, byId);
    }

    /** A watched resident by exact (case-sensitive) name, or null. */
    public ResidentSpec resident(String name) {
        return name == null ? null : byName.get(name);
    }

    /** A watched facility by id, or null. */
    public FacilitySpec facility(String id) {
        return id == null ? null : byId.get(id);
    }

    /** Resident name for a player UUID, or null when that player is not watched (humans, the spectator). */
    public String residentName(UUID uuid) {
        ResidentSpec r = uuid == null ? null : byUuid.get(uuid);
        return r == null ? null : r.name();
    }

    // === parsing a push ===

    /** Strict JSON (no comments, no trailing data, bounded nesting), then the same rules the 0.2 config applied. */
    public static WatchList parse(String body) throws Invalid {
        if (body == null || body.isBlank()) throw new Invalid("the body must be a JSON object");
        if (nesting(body) > MAX_JSON_DEPTH) throw new Invalid("the JSON is nested too deeply");
        JsonElement root;
        try (JsonReader reader = new JsonReader(new StringReader(body))) {
            reader.setLenient(false);
            root = new Gson().getAdapter(JsonElement.class).read(reader);
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new Invalid("trailing data after the JSON object");
        } catch (IOException | RuntimeException e) {
            throw new Invalid("not valid JSON");
        }
        if (root == null || !root.isJsonObject()) throw new Invalid("the body must be a JSON object");
        JsonObject o = root.getAsJsonObject();
        for (String key : o.keySet()) {
            if (!TOP_KEYS.contains(key)) throw new Invalid("unknown key '" + clip(key) + "'");
        }
        JsonElement rev = o.get("revision");
        if (rev == null || !rev.isJsonPrimitive() || !rev.getAsJsonPrimitive().isString()
                || !REVISION.matcher(rev.getAsString()).matches()) {
            throw new Invalid("revision is required: 1-" + MAX_REVISION_CHARS + " printable ASCII characters, no spaces");
        }
        List<ResidentSpec> residents = residents(array(o, "residents"));
        List<FacilitySpec> facilities = facilities(array(o, "facilities"));
        return new WatchList(rev.getAsString(), residents, facilities, null);
    }

    /** Deepest bracket nesting outside strings: a cheap guard before a recursive parser sees the text. */
    static int nesting(String text) {
        int depth = 0, max = 0;
        boolean inString = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) {
                if (c == '\\') i++;
                else if (c == '"') inString = false;
            } else if (c == '"') inString = true;
            else if (c == '[' || c == '{') max = Math.max(max, ++depth);
            else if (c == ']' || c == '}') depth--;
        }
        return max;
    }

    private static List<ResidentSpec> residents(JsonArray arr) throws Invalid {
        if (arr.size() > MAX_RESIDENTS) throw new Invalid("at most " + MAX_RESIDENTS + " residents");
        List<ResidentSpec> out = new ArrayList<>(arr.size());
        Set<String> names = new HashSet<>();
        Set<UUID> uuids = new HashSet<>();
        for (int i = 0; i < arr.size(); i++) {
            String where = "residents[" + i + "]";
            JsonObject r = object(arr.get(i), where);
            for (String key : r.keySet()) {
                if (!RESIDENT_KEYS.contains(key)) throw new Invalid(where + ": unknown key '" + clip(key) + "'");
            }
            String name = required(r, "name", where);
            if (!NAME.matcher(name).matches()) throw new Invalid(where + ".name must be a Minecraft name (1-16 letters, digits, _)");
            UUID uuid;
            try {
                uuid = UUID.fromString(required(r, "uuid", where));
            } catch (IllegalArgumentException e) {
                throw new Invalid(where + ".uuid is not a UUID");
            }
            if (!names.add(name.toLowerCase(Locale.ROOT)) || !uuids.add(uuid)) {
                throw new Invalid("resident '" + name + "' (or its UUID) is listed twice");
            }
            out.add(new ResidentSpec(name, uuid));
        }
        return out;
    }

    private static List<FacilitySpec> facilities(JsonArray arr) throws Invalid {
        if (arr.size() > MAX_FACILITIES) throw new Invalid("at most " + MAX_FACILITIES + " facilities");
        List<FacilitySpec> out = new ArrayList<>(arr.size());
        Set<String> ids = new HashSet<>();
        Set<String> places = new HashSet<>();
        for (int i = 0; i < arr.size(); i++) {
            String where = "facilities[" + i + "]";
            JsonObject f = object(arr.get(i), where);
            for (String key : f.keySet()) {
                if (!FACILITY_KEYS.contains(key)) throw new Invalid(where + ": unknown key '" + clip(key) + "'");
            }
            String id = required(f, "id", where);
            if (!FACILITY_ID.matcher(id).matches()) {
                throw new Invalid(where + ".id must be 1-48 of a-z 0-9 _ - (starting with a letter or digit)");
            }
            String label = optionalString(f, "label", id, where);
            if (label.length() > 80) throw new Invalid(where + ".label is longer than 80 characters");
            String dimension = optionalString(f, "dimension", "minecraft:overworld", where);
            if (!RESOURCE_LOCATION.matcher(dimension).matches()) {
                throw new Invalid(where + ".dimension must look like minecraft:overworld");
            }
            JsonElement posEl = f.get("pos");
            if (posEl == null || !posEl.isJsonArray() || posEl.getAsJsonArray().size() != 3) {
                throw new Invalid(where + ".pos must be [x, y, z]");
            }
            JsonArray pos = posEl.getAsJsonArray();
            int x = coordinate(pos.get(0), where + ".pos[0]", Positions.MAX_XZ);
            int y = coordinate(pos.get(1), where + ".pos[1]", Positions.MAX_Y);
            int z = coordinate(pos.get(2), where + ".pos[2]", Positions.MAX_XZ);
            String side = null;
            JsonElement sideEl = f.get("side");
            if (sideEl != null && !sideEl.isJsonNull()) {
                side = sideEl.isJsonPrimitive() && sideEl.getAsJsonPrimitive().isString()
                        ? sideEl.getAsString().toLowerCase(Locale.ROOT) : "";
                if (!SIDES.contains(side)) throw new Invalid(where + ".side must be null or one of " + SIDES);
            }
            if (!ids.add(id)) throw new Invalid("facility id '" + id + "' is listed twice");
            if (!places.add(dimension + " " + x + " " + y + " " + z + " " + side)) {
                throw new Invalid(where + " repeats another facility's position and side");
            }
            out.add(new FacilitySpec(id, label, dimension, x, y, z, side));
        }
        return out;
    }

    private static JsonArray array(JsonObject o, String key) throws Invalid {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) return new JsonArray();
        if (!el.isJsonArray()) throw new Invalid(key + " must be an array");
        return el.getAsJsonArray();
    }

    private static JsonObject object(JsonElement el, String where) throws Invalid {
        if (el == null || !el.isJsonObject()) throw new Invalid(where + " must be an object");
        return el.getAsJsonObject();
    }

    private static String required(JsonObject o, String key, String where) throws Invalid {
        JsonElement el = o.get(key);
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString() || el.getAsString().isBlank()) {
            throw new Invalid(where + "." + key + " is required (a string)");
        }
        return el.getAsString().strip();
    }

    private static String optionalString(JsonObject o, String key, String fallback, String where) throws Invalid {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) return fallback;
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) throw new Invalid(where + "." + key + " must be a string");
        return el.getAsString().strip();
    }

    private static int coordinate(JsonElement el, String where, int limit) throws Invalid {
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isNumber()) {
            throw new Invalid(where + " must be a whole number");
        }
        double d = el.getAsDouble();
        if (d != Math.rint(d) || Math.abs(d) > limit) throw new Invalid(where + " must be a whole number within ±" + limit);
        return (int) d;
    }

    private static String clip(String s) {
        return s.length() > 32 ? s.substring(0, 32) + "…" : s;
    }

    // === views ===

    /** {@code watch:{revision, residents, facilities, appliedAtMs, bootId}} */
    JsonObject toJson(String bootId) {
        JsonObject o = new JsonObject();
        o.addProperty("revision", revision);
        JsonArray rs = new JsonArray();
        for (ResidentSpec r : residents) {
            JsonObject j = new JsonObject();
            j.addProperty("name", r.name());
            j.addProperty("uuid", r.uuid().toString());
            rs.add(j);
        }
        o.add("residents", rs);
        JsonArray fs = new JsonArray();
        for (FacilitySpec f : facilities) {
            JsonObject j = new JsonObject();
            j.addProperty("id", f.id());
            j.addProperty("label", f.label());
            j.addProperty("dimension", f.dimension());
            j.add("pos", Positions.json(f.x(), f.y(), f.z()));
            j.addProperty("side", f.side());
            fs.add(j);
        }
        o.add("facilities", fs);
        o.addProperty("appliedAtMs", appliedAtMs);
        o.addProperty("bootId", bootId);
        return o;
    }
}
