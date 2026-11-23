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
 * Resident Observer: a read-only, server-side view of configured residents and registered
 * facilities for Commons and the caretaker. Dedicated server only; registers nothing clients
 * need. Does nothing at all unless {@code config/resident_observer.json} exists and is valid.
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
        try {
            EventLog events = new EventLog(config.eventCapacity());
            MinecraftWorldAccess world = new MinecraftWorldAccess(event.getServer(),
                    config.maxFacilitySlots(), config.maxItemKinds());
            Sampler sampler = new Sampler(config, world, new MinecraftBridgeAccess(event.getServer(), config),
                    events, System::nanoTime, System::currentTimeMillis,
                    msg -> LOGGER.warn("[resident_observer] {}", msg));
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
            running = new Running(sampler, http, watcher, new MinecraftBlockListener(event.getServer(), sampler, config), catalog);
            LOGGER.info("[resident_observer] advancement catalog: {} entries in {} us{}; block recording {}, flow recording {}.",
                    catalog.get().entries().size(), catalog.get().buildMicros(),
                    catalog.get().problem() == null ? "" : " (" + catalog.get().problem() + ")",
                    config.recording().recordBlocks() ? "on" : "off", config.recording().recordFlows() ? "on" : "off");
            LOGGER.info("[resident_observer] serving {} residents and {} facilities on {}:{} for {} consumers "
                            + "(interval {} ticks, budget {} us). Tokens are stored as hashes only.",
                    config.residents().size(), config.facilities().size(), config.bind(), http.port(),
                    config.consumers().size(), config.intervalTicks(), config.tickBudgetMicros());
        } catch (Throwable t) {
            LOGGER.error("[resident_observer] failed to start; the game is unaffected: {}", t.toString());
        }
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
