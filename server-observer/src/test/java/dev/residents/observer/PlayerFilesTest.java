package dev.residents.observer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Player files as the server writes them: real JSON shapes, half-written rewrites, links, size caps. */
class PlayerFilesTest {

    @TempDir
    Path world;

    private final ObserverConfig.ResidentSpec gary = new ObserverConfig.ResidentSpec("Gary", Fixtures.GARY);

    private static final String STATS = """
            {"stats":{"minecraft:custom":{"minecraft:walk_one_cm":123456,"minecraft:deaths":2,"minecraft:play_time":72000,
            "minecraft:damage_dealt":340,"create:some_mod_counter":4},
            "minecraft:mined":{"minecraft:stone":300,"minecraft:oak_log":42,"mekanism:osmium_ore":7},
            "minecraft:crafted":{"minecraft:oak_planks":64},"NotAnId":{"x":1},
            "minecraft:killed":{"minecraft:zombie":3,"minecraft:bad":"many"}},"DataVersion":3465}
            """;

    private static final String ADVANCEMENTS = """
            {"minecraft:story/root":{"criteria":{"crafting_table":"2026-11-20 14:03:22 -0500"},"done":true},
             "minecraft:story/mine_stone":{"criteria":{"get_stone":"2026-11-20 14:10:00 -0500"},"done":true},
             "minecraft:adventure/adventuring_time":{"criteria":{"minecraft:plains":"2026-11-21 10:00:00 +0000",
               "minecraft:forest":"garbage"},"done":false},
             "minecraft:recipes/misc/charcoal":{"criteria":{"has_log":"2026-11-20 14:01:00 -0500"},"done":true},
             "mekanism:metallurgic_infuser":{"criteria":{"x":"2026-11-22 09:00:00 -0500"},"done":true},
             "DataVersion":3465}
            """;

    private PlayerFiles files(AdvancementCatalog catalog, int maxBytes) throws IOException {
        Files.createDirectories(world.resolve("stats"));
        Files.createDirectories(world.resolve("advancements"));
        return new PlayerFiles(world.resolve("stats"), world.resolve("advancements"), maxBytes, () -> catalog);
    }

    private Path write(String dir, String text, long modifiedMs) throws IOException {
        Path p = world.resolve(dir).resolve(Fixtures.GARY + ".json");
        Files.writeString(p, text);
        Files.setLastModifiedTime(p, FileTime.fromMillis(modifiedMs));
        return p;
    }

    @Test
    void statsAreReadByTypeLargestFirstAndMalformedEntriesAreCounted() throws IOException {
        PlayerFiles f = files(null, 1 << 20);
        write("stats", STATS, 1_000_000L);
        PlayerFiles.StatsResult s = f.stats(gary, List.of(), 2);
        assertEquals("observed", s.status());
        assertEquals(1_000_000L, s.savedAtMs());
        assertEquals(3465, s.dataVersion());
        PlayerFiles.StatType custom = s.types().stream().filter(t -> t.type().equals("minecraft:custom")).findFirst().orElseThrow();
        assertEquals(5, custom.total());
        assertTrue(custom.truncated());
        assertEquals(List.of("minecraft:walk_one_cm", "minecraft:play_time"), custom.entries().stream().map(PlayerFiles.StatEntry::key).toList());
        assertEquals(2, s.skipped(), "one non-id type, one non-number value");

        PlayerFiles.StatsResult mined = f.stats(gary, List.of("minecraft:mined"), 1000);
        assertEquals(1, mined.types().size());
        assertEquals(new PlayerFiles.StatEntry("mekanism:osmium_ore", 7), mined.types().get(0).entries().get(2));
        assertEquals(1, f.metrics().fileReads(), "unchanged files are served from the cache");
        assertEquals(1, f.metrics().cacheHits());
    }

    @Test
    void aHalfWrittenFileFallsBackToThePreviousReadAsStale() throws IOException {
        PlayerFiles f = files(null, 1 << 20);
        write("stats", STATS, 1_000_000L);
        assertEquals("observed", f.stats(gary, List.of(), 10).status());
        write("stats", STATS.substring(0, 80), 2_000_000L); // the server is rewriting it in place
        PlayerFiles.StatsResult stale = f.stats(gary, List.of(), 10);
        assertEquals("stale", stale.status());
        assertEquals(1_000_000L, stale.savedAtMs(), "times belong to the values shown");
        assertFalse(stale.types().isEmpty());
        assertEquals(1, f.metrics().parseFailures());
    }

    @Test
    void missingOversizedAndLinkedFilesAreRefusedWithoutReading() throws IOException {
        PlayerFiles f = files(null, 100);
        assertEquals("missing", f.stats(gary, List.of(), 10).status());
        write("stats", STATS, 1L);
        PlayerFiles.StatsResult big = f.stats(gary, List.of(), 10);
        assertEquals("too_large", big.status());
        assertTrue(big.types().isEmpty());

        PlayerFiles g = files(null, 1 << 20);
        Path secret = world.resolve("secret.json");
        Files.writeString(secret, STATS);
        Path link = world.resolve("advancements").resolve(Fixtures.GARY + ".json");
        Files.createSymbolicLink(link, secret);
        assertEquals("unreadable", g.advancements(gary, "all", false, 0, 10).status());
        assertEquals("unavailable", new PlayerFiles(null, null, 100, () -> null).stats(gary, List.of(), 1).status());
    }

    @Test
    void advancementsFilterRecipesAndProgressAndUseTheCatalog() throws IOException {
        AdvancementCatalog catalog = AdvancementCatalog.of(List.of(
                new AdvancementCatalog.Entry("minecraft:adventure/adventuring_time", "Adventuring Time", "challenge", false, 53, 53,
                        "minecraft:adventure/sleep_in_bed")), 0, 0, 1, false);
        PlayerFiles f = files(catalog, 1 << 20);
        write("advancements", ADVANCEMENTS, 5L);

        PlayerFiles.AdvancementsResult all = f.advancements(gary, "all", false, 0, 100);
        assertEquals(4, all.total(), "recipe unlocks are left out unless asked for");
        assertEquals(3, all.done());
        assertEquals(List.of("mekanism:metallurgic_infuser", "minecraft:adventure/adventuring_time",
                "minecraft:story/mine_stone", "minecraft:story/root"), all.advancements().stream().map(PlayerFiles.Progress::id).toList());

        PlayerFiles.Progress started = f.advancements(gary, "progress", false, 0, 100).advancements().get(0);
        assertEquals("minecraft:adventure/adventuring_time", started.id());
        assertEquals(2, started.criteriaDone());
        assertEquals(53, started.criteriaTotal());
        assertEquals("Adventuring Time", started.title());
        assertNull(started.criteria().get(0).atMs(), "an unparseable time stays unknown");
        assertEquals(1_795_255_200_000L, started.criteria().get(1).atMs(), "2026-11-21 10:00:00 +0000");

        assertEquals(5, f.advancements(gary, "all", true, 0, 100).total());
        PlayerFiles.AdvancementsResult page = f.advancements(gary, "done", false, 1, 1);
        assertEquals(3, page.matched());
        assertEquals(1, page.advancements().size());
        assertTrue(page.more());
        assertNull(page.advancements().get(0).criteriaTotal(), "not in the catalog: total unknown, not zero");
    }
}
