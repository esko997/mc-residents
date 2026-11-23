package dev.residents.observer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The observer's whole configuration, parsed from {@code config/resident_observer.json}.
 * Validation is strict and all-or-nothing: an invalid file means the observer does not start,
 * which is always safe for the game. Pure (no Minecraft types) so it is unit-tested.
 *
 * <p>The config holds no subjects: residents and facilities come from Commons as the watch list
 * ({@code PUT /v1/watch}). A 0.2 config that still lists {@code residents}/{@code facilities} is
 * accepted and those keys are ignored ({@link #ignoredKeys}, logged once at start).
 */
public record ObserverConfig(
        boolean enabled,
        String bind,
        boolean allowNonLoopback,
        Set<String> allowedHosts,
        int maxSightDistance,
        int requestQueueCapacity,
        int requestTimeoutMs,
        int maxBookPages,
        int maxBookPageChars,
        int maxBookChars,
        int port,
        int intervalTicks,
        int tickBudgetMicros,
        int maxFacilitySlots,
        int maxItemKinds,
        int eventCapacity,
        int failureTripCount,
        int stallSeconds,
        Recording recording,
        List<ConsumerSpec> consumers,
        List<String> ignoredKeys) {

    public static final int MAX_CONSUMERS = 32;

    private static final Pattern NAME = Pattern.compile("^\\w{1,16}$");
    private static final Pattern CONSUMER_NAME = Pattern.compile("^[A-Za-z0-9_-]{1,32}$");
    private static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");
    /** Keys of 0.2 configs that 0.3 accepts and ignores: subjects now come from the watch list. */
    static final List<String> SUBJECT_KEYS = List.of("residents", "facilities");
    private static final Set<String> KNOWN_KEYS = Set.of("enabled", "bind", "port", "intervalTicks", "tickBudgetMicros",
            "maxFacilitySlots", "maxItemKinds", "eventCapacity", "failureTripCount", "stallSeconds",
            "residents", "facilities", "consumers", "_comment", "allowNonLoopback", "allowedHosts",
            "maxSightDistance", "requestQueueCapacity", "requestTimeoutMs",
            "maxBookPages", "maxBookPageChars", "maxBookChars",
            "queryRatePerMinute", "queryBurst", "recordBlocks", "blockDetailCapacity", "blockDetailPerTick",
            "blockAggregateCells", "blockAggregateHours", "recordFlows", "flowCapacity", "flowReach",
            "maxPlayerFileBytes");

    /** Declarative query and recorder limits (all optional; defaults need no config change). */
    public record Recording(int queryRatePerMinute, int queryBurst, boolean recordBlocks, int blockDetailCapacity,
                            int blockDetailPerTick, int blockAggregateCells, int blockAggregateHours,
                            boolean recordFlows, int flowCapacity, int flowReach, int maxPlayerFileBytes) {
        public static final Recording DEFAULTS = new Recording(60, 30, true, 4096, 32, 4096, 48, true, 1024, 8, 4 << 20);
    }

    /**
     * One credential. {@code resident} is set only for a {@link Scope#SELF} consumer: the name of the
     * watched resident it may read (it sees nothing while that name is not on the watch list).
     */
    public record ConsumerSpec(String name, String tokenSha256, Set<Scope> scopes, String resident) {
        public ConsumerSpec {
            scopes = Set.copyOf(scopes);
        }

        public boolean has(Scope scope) {
            return scopes.contains(scope);
        }
    }

    public ObserverConfig {
        allowedHosts = Set.copyOf(allowedHosts);
        consumers = List.copyOf(consumers);
        ignoredKeys = List.copyOf(ignoredKeys);
    }

    public static final class InvalidConfig extends Exception {
        public InvalidConfig(String message) {
            super(message);
        }
    }

    public static ObserverConfig parse(String text) throws InvalidConfig {
        JsonElement root;
        try {
            root = JsonParser.parseString(text);
        } catch (RuntimeException e) {
            throw new InvalidConfig("not valid JSON: " + e.getMessage());
        }
        if (root == null || !root.isJsonObject()) {
            throw new InvalidConfig("the top level must be a JSON object");
        }
        JsonObject o = root.getAsJsonObject();
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            if (!KNOWN_KEYS.contains(e.getKey())) {
                // A typo such as "tickBudgetMicro" would otherwise silently keep a default.
                throw new InvalidConfig("unknown key '" + e.getKey() + "'");
            }
        }
        List<String> ignored = new ArrayList<>();
        for (String key : SUBJECT_KEYS) {
            if (o.has(key)) ignored.add(key); // never read: not even validated, so an old list cannot stop the start
        }

        boolean enabled = bool(o, "enabled", true);
        String bind = string(o, "bind", "127.0.0.1");
        boolean allowNonLoopback = bool(o, "allowNonLoopback", false);
        if (!allowNonLoopback && !bind.equals("127.0.0.1") && !bind.equals("::1")) {
            throw new InvalidConfig("bind is loopback only unless allowNonLoopback is explicitly true");
        }
        if (!literalAddress(bind)) {
            throw new InvalidConfig("bind must be a literal IPv4 or IPv6 address, never a hostname");
        }
        Set<String> hosts = new HashSet<>(Set.of("127.0.0.1", "localhost", "[::1]"));
        JsonArray hostArray = array(o, "allowedHosts");
        if (hostArray.size() > 32) {
            throw new InvalidConfig("at most 32 allowedHosts");
        }
        for (JsonElement host : hostArray) {
            if (!host.isJsonPrimitive() || !host.getAsJsonPrimitive().isString()
                    || !validHostName(host.getAsString())) {
                throw new InvalidConfig("allowedHosts entries must be exact hostnames or IP literals, without ports");
            }
            hosts.add(host.getAsString().toLowerCase(Locale.ROOT));
        }
        int sightDistance = integer(o, "maxSightDistance", 128, 1, 512);
        int requestQueue = integer(o, "requestQueueCapacity", 16, 1, 64);
        int requestTimeout = integer(o, "requestTimeoutMs", 2000, 100, 10000);
        int bookPages = integer(o, "maxBookPages", 100, 1, 100);
        int bookPageChars = integer(o, "maxBookPageChars", 8192, 1, 32767);
        int bookChars = integer(o, "maxBookChars", 65536, 1, 262144);
        int port = integer(o, "port", 25640, 1024, 65535);
        int interval = integer(o, "intervalTicks", 20, 1, 1200);
        int budget = integer(o, "tickBudgetMicros", 500, 50, 5000);
        int slots = integer(o, "maxFacilitySlots", 256, 1, 4096);
        int kinds = integer(o, "maxItemKinds", 64, 1, 512);
        int events = integer(o, "eventCapacity", 256, 16, 4096);
        int trip = integer(o, "failureTripCount", 5, 1, 1000);
        int stall = integer(o, "stallSeconds", 10, 2, 600);
        Recording d = Recording.DEFAULTS;
        Recording recording = new Recording(
                integer(o, "queryRatePerMinute", d.queryRatePerMinute(), 6, 600),
                integer(o, "queryBurst", d.queryBurst(), 1, 120),
                bool(o, "recordBlocks", d.recordBlocks()),
                integer(o, "blockDetailCapacity", d.blockDetailCapacity(), 256, 65536),
                integer(o, "blockDetailPerTick", d.blockDetailPerTick(), 1, 256),
                integer(o, "blockAggregateCells", d.blockAggregateCells(), 256, 65536),
                integer(o, "blockAggregateHours", d.blockAggregateHours(), 2, 168),
                bool(o, "recordFlows", d.recordFlows()),
                integer(o, "flowCapacity", d.flowCapacity(), 64, 8192),
                integer(o, "flowReach", d.flowReach(), 1, 32),
                integer(o, "maxPlayerFileBytes", d.maxPlayerFileBytes(), 64 << 10, 32 << 20));

        List<ConsumerSpec> consumers = consumers(array(o, "consumers"));
        if (consumers.isEmpty()) {
            throw new InvalidConfig("at least one consumer is required (nobody could read the observer otherwise)");
        }
        return new ObserverConfig(enabled, bind, allowNonLoopback, hosts, sightDistance, requestQueue,
                requestTimeout, bookPages, bookPageChars, bookChars,
                port, interval, budget, slots, kinds, events, trip, stall, recording, consumers, ignored);
    }

    /** Numeric-only parsing: never resolves operator-supplied names through DNS. */
    static boolean literalAddress(String address) {
        if (address == null || address.isEmpty()) return false;
        if (address.contains(":")) {
            if (!address.matches("[0-9a-fA-F:.]+")) return false;
            try {
                java.net.InetAddress.getByName(address);
                return true;
            } catch (java.net.UnknownHostException e) {
                return false;
            }
        }
        String[] parts = address.split("\\.", -1);
        if (parts.length != 4) return false;
        for (String part : parts) {
            if (!part.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(part) > 255) return false;
        }
        return true;
    }

    static boolean validHostName(String host) {
        if (host == null || host.length() > 253 || host.isEmpty()) return false;
        if (host.startsWith("[") && host.endsWith("]")) {
            String ip = host.substring(1, host.length() - 1);
            return ip.contains(":") && literalAddress(ip);
        }
        for (String label : host.split("\\.", -1)) {
            if (!label.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")) return false;
        }
        return true;
    }

    // === consumers ===

    private static List<ConsumerSpec> consumers(JsonArray arr) throws InvalidConfig {
        if (arr.size() > MAX_CONSUMERS) {
            throw new InvalidConfig("at most " + MAX_CONSUMERS + " consumers");
        }
        List<ConsumerSpec> out = new ArrayList<>();
        Set<String> names = new HashSet<>();
        Set<String> hashes = new HashSet<>();
        for (int i = 0; i < arr.size(); i++) {
            String where = "consumers[" + i + "]";
            JsonObject c = object(arr.get(i), where);
            String name = required(c, "name", where);
            if (!CONSUMER_NAME.matcher(name).matches()) {
                throw new InvalidConfig(where + ".name must be 1-32 of A-Z a-z 0-9 _ -");
            }
            String hash = required(c, "tokenSha256", where).toLowerCase(Locale.ROOT);
            if (!SHA256_HEX.matcher(hash).matches()) {
                throw new InvalidConfig(where + ".tokenSha256 must be 64 hex digits (sha256 of the token; "
                        + "never put the token itself in this file)");
            }
            JsonArray scopeArr = array(c, "scopes");
            if (scopeArr.size() == 0) {
                throw new InvalidConfig(where + ".scopes must list at least one scope");
            }
            Set<Scope> scopes = EnumSet.noneOf(Scope.class);
            for (JsonElement s : scopeArr) {
                Scope scope = s.isJsonPrimitive() ? Scope.byId(s.getAsString()) : null;
                if (scope == null) {
                    throw new InvalidConfig(where + ".scopes: unknown scope " + s
                            + " (known: residents, facilities, library, status, watch, self)");
                }
                scopes.add(scope);
            }
            String resident = c.has("resident") && !c.get("resident").isJsonNull() ? required(c, "resident", where) : null;
            if (scopes.contains(Scope.SELF)) {
                if (resident == null || !NAME.matcher(resident).matches()) {
                    throw new InvalidConfig(where + ": scope 'self' needs \"resident\", a Minecraft name (1-16 letters, digits, _)");
                }
                if (scopes.contains(Scope.RESIDENTS) || scopes.contains(Scope.FACILITIES) || scopes.contains(Scope.LIBRARY)
                        || scopes.contains(Scope.WATCH)) {
                    // A resident's own credential must not see other residents, remote stock or books,
                    // nor decide what the bridge watches.
                    throw new InvalidConfig(where + ": a 'self' consumer cannot also hold 'residents', 'facilities', 'library' or 'watch'");
                }
            } else if (resident != null) {
                throw new InvalidConfig(where + ": \"resident\" is only allowed with scope 'self'");
            }
            if (!names.add(name)) {
                throw new InvalidConfig("consumer '" + name + "' is listed twice");
            }
            if (!hashes.add(hash)) {
                // Two consumers sharing a token would make identity (and scope) ambiguous.
                throw new InvalidConfig(where + " reuses another consumer's token");
            }
            out.add(new ConsumerSpec(name, hash, scopes, resident));
        }
        return out;
    }

    // === primitive helpers ===

    private static JsonObject object(JsonElement el, String where) throws InvalidConfig {
        if (el == null || !el.isJsonObject()) {
            throw new InvalidConfig(where + " must be an object");
        }
        return el.getAsJsonObject();
    }

    private static JsonArray array(JsonObject o, String key) throws InvalidConfig {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return new JsonArray();
        }
        if (!el.isJsonArray()) {
            throw new InvalidConfig(key + " must be an array");
        }
        return el.getAsJsonArray();
    }

    private static String required(JsonObject o, String key, String where) throws InvalidConfig {
        JsonElement el = o.get(key);
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString() || el.getAsString().isBlank()) {
            throw new InvalidConfig(where + "." + key + " is required (a string)");
        }
        return el.getAsString().strip();
    }

    private static String string(JsonObject o, String key, String fallback) throws InvalidConfig {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return fallback;
        }
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
            throw new InvalidConfig(key + " must be a string");
        }
        return el.getAsString().strip();
    }

    private static boolean bool(JsonObject o, String key, boolean fallback) throws InvalidConfig {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return fallback;
        }
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isBoolean()) {
            throw new InvalidConfig(key + " must be true or false");
        }
        return el.getAsBoolean();
    }

    private static int integer(JsonObject o, String key, int fallback, int min, int max) throws InvalidConfig {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return fallback;
        }
        int value = wholeNumber(el, key);
        if (value < min || value > max) {
            throw new InvalidConfig(key + " must be between " + min + " and " + max + ", got " + value);
        }
        return value;
    }

    private static int wholeNumber(JsonElement el, String where) throws InvalidConfig {
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isNumber()) {
            throw new InvalidConfig(where + " must be a whole number");
        }
        double d = el.getAsDouble();
        if (d != Math.rint(d) || Math.abs(d) > Integer.MAX_VALUE) {
            throw new InvalidConfig(where + " must be a whole number");
        }
        return (int) d;
    }
}
