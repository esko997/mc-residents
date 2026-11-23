package dev.residents.observer;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * The server's loaded advancements that have a display (vanilla and modded trees; recipe
 * unlocks have none and are left out), copied once on the server thread at start and after a
 * datapack reload. Immutable, so request threads read it freely. Titles are plain text capped at
 * {@value #MAX_TITLE} characters; whatever the server's language resolves (English or the key).
 */
public record AdvancementCatalog(List<Entry> entries, Map<String, Entry> byId, long builtAtMs, long buildMicros,
                                 int seen, boolean truncated, String problem) {

    public static final int MAX_ENTRIES = 8192;
    public static final int MAX_TITLE = 128;

    /** {@code criteria}: number of criteria; {@code requirements}: groups that must each have one criterion done. */
    public record Entry(String id, String title, String frame, boolean hidden, int criteria, int requirements,
                        String parent) {
    }

    public AdvancementCatalog {
        entries = List.copyOf(entries);
        byId = Map.copyOf(byId);
    }

    public static AdvancementCatalog of(List<Entry> sortedEntries, long builtAtMs, long buildMicros, int seen,
                                        boolean truncated) {
        return new AdvancementCatalog(sortedEntries,
                sortedEntries.stream().collect(Collectors.toMap(Entry::id, Function.identity(), (a, b) -> a)),
                builtAtMs, buildMicros, seen, truncated, null);
    }

    public static AdvancementCatalog unavailable(String problem, long atMs) {
        return new AdvancementCatalog(List.of(), Map.of(), atMs, 0, 0, false, problem);
    }

    static String title(String raw) {
        if (raw == null) return null;
        String plain = raw.replaceAll("\\p{Cntrl}", " ").strip();
        return plain.length() > MAX_TITLE ? plain.substring(0, MAX_TITLE - 1) + "…" : plain;
    }
}
