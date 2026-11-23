package dev.residents.observer;

import com.mojang.logging.LogUtils;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.EventPriority;
import net.minecraftforge.event.OnDatapackSyncEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;
import net.minecraftforge.fml.loading.FMLPaths;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Resident Observer: a server-side view, for Commons and the caretaker, of the residents and facilities
 * Commons asks it to watch, and of any position, shelf or book in loaded chunks. Never changes the world.
 * Dedicated server only; registers nothing clients need. Does nothing at all unless
 * {@code config/resident_observer.json} exists and is valid.
 */
@Mod(ResidentObserverMod.MODID)
public final class ResidentObserverMod {

    public static final String MODID = "resident_observer";
    static final Logger LOGGER = LogUtils.getLogger();
    static final String CONFIG_FILE = "resident_observer.json";
    static final String PAUSE_FILE = "resident_observer.paused";

    /** Owned by the server thread (lifecycle and tick events). */
    private Running running;

    private record Running(Sampler sampler, ObserverHttpServer http, ScheduledExecutorService pauseWatcher,
                           MinecraftBlockListener blocks, AtomicReference<AdvancementCatalog> catalog) {
        void stop() {
            pauseWatcher.shutdownNow();
            http.stop();
        }
    }

    public ResidentObserverMod() {
        if (FMLEnvironment.dist != Dist.DEDICATED_SERVER) {
            return; // Client or integrated server: never observe.
        }
        MinecraftForge.EVENT_BUS.addListener(this::onServerStarted);
        MinecraftForge.EVENT_BUS.addListener(this::onServerStopping);
        MinecraftForge.EVENT_BUS.addListener(this::onServerTick);
        // Lowest priority, cancelled events excluded: only changes every other handler let through.
        MinecraftForge.EVENT_BUS.addListener(EventPriority.LOWEST, false, BlockEvent.BreakEvent.class, this::onBlockBreak);
        MinecraftForge.EVENT_BUS.addListener(EventPriority.LOWEST, false, BlockEvent.EntityPlaceEvent.class, this::onBlockPlace);
        MinecraftForge.EVENT_BUS.addListener(this::onDatapackSync);
    }

    private void onServerStarted(ServerStartedEvent event) {
        Path dir = FMLPaths.CONFIGDIR.get();
        Path file = dir.resolve(CONFIG_FILE);
        if (!Files.isRegularFile(file)) {
            LOGGER.info("[resident_observer] {} not found; observer idle (no socket, no tick work).", file);
            return;
        }
        ObserverConfig config;
        try {
            config = ObserverConfig.parse(Files.readString(file, StandardCharsets.UTF_8));
        } catch (ObserverConfig.InvalidConfig e) {
            LOGGER.error("[resident_observer] {} is invalid, observer not started: {}", file, e.getMessage());
            return;
        } catch (IOException e) {
            LOGGER.error("[resident_observer] could not read {}: {}", file, e.toString());
            return;
        }
        if (!config.enabled()) {
            LOGGER.info("[resident_observer] disabled in {}.", file);
            return;
        }
        if (!config.ignoredKeys().isEmpty()) {
            LOGGER.warn("[resident_observer] {} in {} {} ignored since 0.3.0: Commons pushes the watch list (PUT /v1/watch); "
                            + "remove {} from the file.", String.join(" and ", config.ignoredKeys()), file,
                    config.ignoredKeys().size() == 1 ? "is" : "are", config.ignoredKeys().size() == 1 ? "it" : "them");
        }
        try {
            EventLog events = new EventLog(config.eventCapacity());
            MinecraftWorldAccess world = new MinecraftWorldAccess(event.getServer(),
                    config.maxFacilitySlots(), config.maxItemKinds());
            Sampler sampler = new Sampler(config, world, new MinecraftBridgeAccess(event.getServer(), config, world),
                    events, System::nanoTime, System::currentTimeMillis,
                    msg -> LOGGER.warn("[resident_observer] {}", msg));
            try {
                warmUp(); // server thread, at startup: the first read in a tick does not pay our class loading
            } catch (Throwable t) {
                LOGGER.warn("[resident_observer] warm-up failed (reads still work): {}", t.toString());
            }
            Path pause = dir.resolve(PAUSE_FILE);
            sampler.setPaused(Files.exists(pause));
            AtomicReference<AdvancementCatalog> catalog = new AtomicReference<>(catalog(event.getServer()));
            PlayerFiles files = new PlayerFiles(event.getServer().getWorldPath(LevelResource.PLAYER_STATS_DIR),
                    event.getServer().getWorldPath(LevelResource.PLAYER_ADVANCEMENTS_DIR),
                    config.recording().maxPlayerFileBytes(), catalog::get);
            ObserverHttpServer http = ObserverHttpServer.start(config, config.port(), sampler, files, System::currentTimeMillis,
                    msg -> LOGGER.warn("[resident_observer] {}", msg));
            ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "resident-observer-pause-watch");
                t.setDaemon(true);
                return t;
            });
            // File checks run here, never on the server thread.
            watcher.scheduleWithFixedDelay(() -> sampler.setPaused(Files.exists(pause)), 0, 5, TimeUnit.SECONDS);
            running = new Running(sampler, http, watcher, new MinecraftBlockListener(event.getServer(), sampler), catalog);
            LOGGER.info("[resident_observer] advancement catalog: {} entries in {} us{}; block recording {}, flow recording {}.",
                    catalog.get().entries().size(), catalog.get().buildMicros(),
                    catalog.get().problem() == null ? "" : " (" + catalog.get().problem() + ")",
                    config.recording().recordBlocks() ? "on" : "off", config.recording().recordFlows() ? "on" : "off");
            LOGGER.info("[resident_observer] 0.3: serving on {}:{} for {} consumers (interval {} ticks, budget {} us), boot {}; "
                            + "watching nothing until Commons pushes the watch list. Tokens are stored as hashes only.",
                    config.bind(), http.port(), config.consumers().size(), config.intervalTicks(), config.tickBudgetMicros(),
                    sampler.bootId());
        } catch (Throwable t) {
            LOGGER.error("[resident_observer] failed to start; the game is unaffected: {}", t.toString());
        }
    }

    /**
     * Server start: runs the pure steps of a shelf read and of a facility read once on made-up values (no world
     * access), so our class loading happens here rather than inside the first tick that does such a read.
     */
    private static void warmUp() throws BookText.Invalid {
        Library.warmUp();
        WatchList.FacilitySpec spec = new WatchList.FacilitySpec("warm-up", "warm-up", "minecraft:overworld", 0, 0, 0, null);
        ItemTally tally = new ItemTally(4);
        tally.add("minecraft:bread", 2, false);
        Observations.Contents empty = new Observations.Contents("minecraft:chest", 27, 0, false,
                java.util.List.of(), false, null, java.util.List.of(), 0);
        Observations.Contents bread = new Observations.Contents("minecraft:chest", 27, tally.usedSlots(), false,
                tally.items(), tally.truncated(), null, java.util.List.of(), 0);
        Observations.Facility f = Observations.Facility.read(spec,
                new Observations.BlockRead(Observations.FacilityStatus.OBSERVED, null, "minecraft:chest", bread), 0L, 0L)
                .carryingFrom(Observations.Facility.pending(spec));
        Flows.diff(spec, empty, 0L, true, f.contents(), 1L, 0L, java.util.List.of(), 8, 64);
    }

    /** Server thread, outside the tick sampler. A failure leaves an empty catalog with the reason; the game is unaffected. */
    private static AdvancementCatalog catalog(net.minecraft.server.MinecraftServer server) {
        try {
            return MinecraftAdvancements.build(server, System.currentTimeMillis());
        } catch (Throwable t) {
            LOGGER.warn("[resident_observer] advancement catalog unavailable: {}", t.toString());
            return AdvancementCatalog.unavailable(Sampler.describe(t), System.currentTimeMillis());
        }
    }

    private void onDatapackSync(OnDatapackSyncEvent event) {
        Running r = running;
        if (r != null && event.getPlayer() == null) r.catalog().set(catalog(event.getPlayerList().getServer()));
    }

    private void onBlockBreak(BlockEvent.BreakEvent event) {
        Running r = running;
        if (r == null) return;
        try {
            r.blocks().onBreak(event);
        } catch (Throwable t) {
            LOGGER.error("[resident_observer] unexpected block listener failure: {}", t.toString());
        }
    }

    private void onBlockPlace(BlockEvent.EntityPlaceEvent event) {
        Running r = running;
        if (r == null) return;
        try {
            r.blocks().onPlace(event);
        } catch (Throwable t) {
            LOGGER.error("[resident_observer] unexpected block listener failure: {}", t.toString());
        }
    }

    private void onServerTick(TickEvent.ServerTickEvent event) {
        Running r = running;
        if (r == null || event.phase != TickEvent.Phase.END) {
            return;
        }
        try {
            r.sampler().onServerTick();
        } catch (Throwable t) {
            // Sampler already isolates its own failures; this is a last guard for the game.
            LOGGER.error("[resident_observer] unexpected tick failure: {}", t.toString());
        }
    }

    private void onServerStopping(ServerStoppingEvent event) {
        Running r = running;
        running = null;
        if (r != null) {
            r.stop();
        }
    }
}
