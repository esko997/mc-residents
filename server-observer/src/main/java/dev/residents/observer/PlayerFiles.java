package dev.residents.observer;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Statistics and advancement progress of configured residents, read from the files the server
 * already writes ({@code <world>/stats/<uuid>.json}, {@code <world>/advancements/<uuid>.json}).
 * Runs on a request thread, never the server thread, so a large or slow file cannot cost a tick.
 *
 * <p>Paths are built only from configured UUIDs; symlinks are refused and size is capped before
 * reading. The server saves these files at its autosave (every ~5 minutes) and when a player logs
 * out, writing them in place: a read can catch a half-written file, which fails to parse and is
 * then answered from the previous good read as {@code stale}. Parsed files are cached by
 * modification time and size, so repeated queries cost a {@code stat} call.
 */
public final class PlayerFiles {

    /** The vanilla statistic types. Mods add their own counters under {@code minecraft:custom}. */
    public static final List<String> STAT_TYPES = List.of("minecraft:custom", "minecraft:mined", "minecraft:crafted",
            "minecraft:used", "minecraft:broken", "minecraft:picked_up", "minecraft:dropped", "minecraft:killed",
            "minecraft:killed_by");
    static final int MAX_PARSED_STATS = 50_000;
    static final int MAX_PARSED_ADVANCEMENTS = 20_000;
    static final int MAX_CRITERIA = 64;
    private static final Pattern ID = Pattern.compile("^[a-z0-9_.-]+:[a-z0-9_./-]+$");
    private static final DateTimeFormatter CRITERION_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss Z", Locale.ROOT);

    public record StatEntry(String key, long value) {
    }

    public record StatType(String type, int total, boolean truncated, List<StatEntry> entries) {
        public StatType {
            entries = List.copyOf(entries);
        }
    }

    /**
     * {@code status}: observed | stale (this read failed; values are from {@code savedAtMs}'s earlier read)
     * | missing (never saved yet) | too_large | unreadable | unavailable. {@code skipped}: malformed entries ignored.
     */
    public record StatsResult(String resident, String status, String reason, Long savedAtMs, Integer dataVersion,
                              List<StatType> types, int skipped) {
        public StatsResult {
            types = List.copyOf(types);
        }
    }

    public record Criterion(String name, Long atMs) {
    }

    public record Progress(String id, boolean done, int criteriaDone, Integer criteriaTotal, String title, String frame,
                           boolean criteriaTruncated, List<Criterion> criteria) {
        public Progress {
            criteria = List.copyOf(criteria);
        }
    }

    /** {@code total}/{@code done}: over every advancement the file has progress for, after the recipe filter. */
    public record AdvancementsResult(String resident, String status, String reason, Long savedAtMs, int total, int done,
                                     int matched, int offset, boolean more, List<Progress> advancements) {
        public AdvancementsResult {
            advancements = List.copyOf(advancements);
        }
    }

    public record Metrics(long fileReads, long cacheHits, long parseFailures, long refused) {
    }

    record ParsedStats(Integer dataVersion, Map<String, List<StatEntry>> types, int skipped) {
    }

    record Adv(String id, boolean done, int criteriaDone, boolean truncated, List<Criterion> criteria) {
    }

    private record Cached(long modifiedMs, long size, Object value) {
    }

    private record Read<T>(String status, String reason, Long savedAtMs, T value) {
    }

    private final Path statsDir;
    private final Path advancementsDir;
    private final int maxBytes;
    private final Supplier<AdvancementCatalog> catalog;
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();
    private final AtomicLong fileReads = new AtomicLong(), cacheHits = new AtomicLong(),
            parseFailures = new AtomicLong(), refused = new AtomicLong();

    public PlayerFiles(Path statsDir, Path advancementsDir, int maxBytes, Supplier<AdvancementCatalog> catalog) {
        this.statsDir = statsDir;
        this.advancementsDir = advancementsDir;
        this.maxBytes = maxBytes;
        this.catalog = catalog;
    }

    public AdvancementCatalog catalog() {
        return catalog.get();
    }

    public Metrics metrics() {
        return new Metrics(fileReads.get(), cacheHits.get(), parseFailures.get(), refused.get());
    }

    // === stats ===

    public StatsResult stats(ObserverConfig.ResidentSpec resident, List<String> types, int limit) {
        Read<ParsedStats> read = read(statsDir, resident.uuid(), "stats", PlayerFiles::parseStats);
        if (read.value() == null) {
            return new StatsResult(resident.name(), read.status(), read.reason(), read.savedAtMs(), null, List.of(), 0);
        }
        List<StatType> out = new ArrayList<>();
        for (Map.Entry<String, List<StatEntry>> e : read.value().types().entrySet()) {
            if (!types.isEmpty() && !types.contains(e.getKey())) continue;
            List<StatEntry> all = e.getValue();
            out.add(new StatType(e.getKey(), all.size(), all.size() > limit, all.subList(0, Math.min(limit, all.size()))));
        }
        return new StatsResult(resident.name(), read.status(), read.reason(), read.savedAtMs(),
                read.value().dataVersion(), out, read.value().skipped());
    }

    static ParsedStats parseStats(JsonObject root) {
        JsonElement statsEl = root.get("stats");
        if (statsEl == null || !statsEl.isJsonObject()) throw new IllegalArgumentException("no stats object");
        Integer dataVersion = root.get("DataVersion") instanceof JsonPrimitive p && p.isNumber() ? p.getAsInt() : null;
        Map<String, List<StatEntry>> types = new LinkedHashMap<>();
        int skipped = 0, kept = 0;
        for (Map.Entry<String, JsonElement> type : statsEl.getAsJsonObject().entrySet()) {
            if (!ID.matcher(type.getKey()).matches() || !type.getValue().isJsonObject()) {
                skipped++;
                continue;
            }
            List<StatEntry> entries = new ArrayList<>();
            for (Map.Entry<String, JsonElement> stat : type.getValue().getAsJsonObject().entrySet()) {
                JsonElement v = stat.getValue();
                if (kept >= MAX_PARSED_STATS || !ID.matcher(stat.getKey()).matches() || !(v instanceof JsonPrimitive p)
                        || !p.isNumber() || p.getAsDouble() != Math.rint(p.getAsDouble())) {
                    skipped++;
                    continue;
                }
                entries.add(new StatEntry(stat.getKey(), p.getAsLong()));
                kept++;
            }
            entries.sort(Comparator.comparingLong(StatEntry::value).reversed().thenComparing(StatEntry::key));
            types.put(type.getKey(), List.copyOf(entries));
        }
        return new ParsedStats(dataVersion, types, skipped);
    }

    // === advancements ===

    /** {@code include}: all | done | progress (started, not done). Recipe unlocks ({@code ns:recipes/...}) only when asked. */
    public AdvancementsResult advancements(ObserverConfig.ResidentSpec resident, String include, boolean recipes,
                                           int offset, int limit) {
        Read<List<Adv>> read = read(advancementsDir, resident.uuid(), "advancements", PlayerFiles::parseAdvancements);
        if (read.value() == null) {
            return new AdvancementsResult(resident.name(), read.status(), read.reason(), read.savedAtMs(), 0, 0, 0,
                    offset, false, List.of());
        }
        AdvancementCatalog known = catalog.get();
        int total = 0, done = 0, matched = 0;
        List<Progress> out = new ArrayList<>(Math.min(limit, 256));
        for (Adv a : read.value()) {
            if (!recipes && isRecipe(a.id())) continue;
            total++;
            if (a.done()) done++;
            if (include.equals("done") && !a.done() || include.equals("progress") && a.done()) continue;
            if (matched >= offset && out.size() < limit) {
                AdvancementCatalog.Entry entry = known == null ? null : known.byId().get(a.id());
                out.add(new Progress(a.id(), a.done(), a.criteriaDone(), entry == null ? null : entry.criteria(),
                        entry == null ? null : entry.title(), entry == null ? null : entry.frame(),
                        a.truncated(), a.criteria()));
            }
            matched++;
        }
        return new AdvancementsResult(resident.name(), read.status(), read.reason(), read.savedAtMs(), total, done,
                matched, offset, offset + out.size() < matched, out);
    }

    static boolean isRecipe(String id) {
        int colon = id.indexOf(':');
        return id.startsWith("recipes/", colon + 1);
    }

    static List<Adv> parseAdvancements(JsonObject root) {
        List<Adv> out = new ArrayList<>();
        for (Map.Entry<String, JsonElement> e : root.entrySet()) {
            if (!ID.matcher(e.getKey()).matches() || !e.getValue().isJsonObject()) continue; // DataVersion, junk
            if (out.size() >= MAX_PARSED_ADVANCEMENTS) break;
            JsonObject a = e.getValue().getAsJsonObject();
            boolean done = a.get("done") instanceof JsonPrimitive p && p.isBoolean() && p.getAsBoolean();
            List<Criterion> criteria = new ArrayList<>();
            int count = 0;
            if (a.get("criteria") instanceof JsonObject c) {
                for (Map.Entry<String, JsonElement> criterion : c.entrySet()) {
                    count++;
                    criteria.add(new Criterion(clip(criterion.getKey(), 128), time(criterion.getValue())));
                }
            }
            criteria.sort(Comparator.comparing(Criterion::name));
            boolean truncated = criteria.size() > MAX_CRITERIA;
            out.add(new Adv(e.getKey(), done, count, truncated,
                    List.copyOf(truncated ? criteria.subList(0, MAX_CRITERIA) : criteria)));
        }
        out.sort(Comparator.comparing(Adv::id));
        return out;
    }

    static Long time(JsonElement el) {
        if (!(el instanceof JsonPrimitive p) || !p.isString()) return null;
        try {
            return ZonedDateTime.parse(p.getAsString(), CRITERION_TIME).toInstant().toEpochMilli();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String clip(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    // === bounded, cached file reads ===

    @SuppressWarnings("unchecked")
    private <T> Read<T> read(Path dir, UUID uuid, String kind, Function<JsonObject, T> parse) {
        if (dir == null) return new Read<>("unavailable", "the server's " + kind + " directory is unknown", null, null);
        Path file = dir.resolve(uuid.toString() + ".json");
        String key = kind + "/" + uuid;
        BasicFileAttributes attrs;
        try {
            attrs = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            return new Read<>("missing", "no " + kind + " file yet (written at autosave or logout)", null, null);
        } catch (IOException e) {
            return new Read<>("unreadable", e.getClass().getSimpleName(), null, null);
        }
        long modified = attrs.lastModifiedTime().toMillis();
        if (!attrs.isRegularFile()) {
            refused.incrementAndGet();
            return new Read<>("unreadable", "not a regular file (links are refused)", modified, null);
        }
        if (attrs.size() > maxBytes) {
            refused.incrementAndGet();
            return new Read<>("too_large", attrs.size() + " bytes exceeds maxPlayerFileBytes " + maxBytes, modified, null);
        }
        Cached cached = cache.get(key);
        if (cached != null && cached.modifiedMs() == modified && cached.size() == attrs.size()) {
            cacheHits.incrementAndGet();
            return new Read<>("observed", null, modified, (T) cached.value());
        }
        fileReads.incrementAndGet();
        try {
            String text = new String(readBounded(file), StandardCharsets.UTF_8);
            T value = parse.apply(JsonParser.parseString(text).getAsJsonObject());
            cache.put(key, new Cached(modified, attrs.size(), value));
            return new Read<>("observed", null, modified, value);
        } catch (IOException | RuntimeException e) {
            parseFailures.incrementAndGet();
            String reason = "could not read or parse (the server may be writing it): " + e.getClass().getSimpleName();
            if (cached != null) return new Read<>("stale", reason, cached.modifiedMs(), (T) cached.value());
            return new Read<>("unreadable", reason, modified, null);
        }
    }

    private byte[] readBounded(Path file) throws IOException {
        try (InputStream in = Channels.newInputStream(Files.newByteChannel(file,
                Set.<java.nio.file.OpenOption>of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)))) {
            byte[] bytes = in.readNBytes(maxBytes + 1);
            if (bytes.length > maxBytes) throw new IOException("grew beyond maxPlayerFileBytes while reading");
            return bytes;
        }
    }
}
