package dev.residents.observer;

import net.minecraft.advancements.Advancement;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.server.MinecraftServer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Builds the {@link AdvancementCatalog} from the server's loaded advancements. Server thread only,
 * at server start and after a datapack reload (never during the tick sampler). Its cost is
 * measured and reported ({@code buildMicros}); it reads static definitions, not any player.
 */
final class MinecraftAdvancements {

    private MinecraftAdvancements() {
    }

    static AdvancementCatalog build(MinecraftServer server, long nowMs) {
        long t0 = System.nanoTime();
        List<AdvancementCatalog.Entry> entries = new ArrayList<>();
        int seen = 0;
        boolean truncated = false;
        for (Advancement a : server.getAdvancements().getAllAdvancements()) {
            seen++;
            DisplayInfo display = a.getDisplay();
            if (display == null) continue; // recipe unlocks and hidden roots without a display
            if (entries.size() >= AdvancementCatalog.MAX_ENTRIES) {
                truncated = true;
                continue;
            }
            Advancement parent = a.getParent();
            entries.add(new AdvancementCatalog.Entry(a.getId().toString(),
                    AdvancementCatalog.title(display.getTitle().getString()),
                    display.getFrame().getName(), display.isHidden(),
                    a.getCriteria().size(), a.getRequirements().length,
                    parent == null ? null : parent.getId().toString()));
        }
        entries.sort(Comparator.comparing(AdvancementCatalog.Entry::id));
        return AdvancementCatalog.of(entries, nowMs, (System.nanoTime() - t0) / 1000L, seen, truncated);
    }
}
