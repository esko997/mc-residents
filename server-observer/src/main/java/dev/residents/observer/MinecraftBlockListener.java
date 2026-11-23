package dev.residents.observer;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.event.level.BlockEvent;

import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Attributes block place/break events to configured residents. Registered at the lowest priority
 * without cancelled events, so it sees only changes every other handler let through; it never
 * cancels or changes an event. The first check is a UUID map lookup: other players (humans, the
 * spectator account, mods' fake players) return immediately and nothing about them is kept.
 *
 * <p>What it does not see: blocks changed by explosions, pistons, fluids, mobs or machines; bucket
 * placement (no EntityPlaceEvent); a break another mod aborts after the event (counted as a break).
 */
final class MinecraftBlockListener {

    private final MinecraftServer server;
    private final Sampler sampler;
    private final Map<UUID, String> residents = new HashMap<>();
    // Server thread only. Bounded by the block registry and the number of dimensions.
    private final Map<Block, String> blockIds = new IdentityHashMap<>();
    private final Map<ResourceKey<Level>, String> dimensions = new IdentityHashMap<>();

    MinecraftBlockListener(MinecraftServer server, Sampler sampler, ObserverConfig config) {
        this.server = server;
        this.sampler = sampler;
        for (ObserverConfig.ResidentSpec r : config.residents()) residents.put(r.uuid(), r.name());
    }

    void onBreak(BlockEvent.BreakEvent event) {
        record(event.getPlayer(), event.getLevel(), event.getPos(), event.getState(), false);
    }

    void onPlace(BlockEvent.EntityPlaceEvent event) {
        record(event.getEntity(), event.getLevel(), event.getPos(), event.getPlacedBlock(), true);
    }

    private void record(Entity entity, LevelAccessor accessor, BlockPos pos, BlockState state, boolean place) {
        if (entity == null) return;
        String resident = residents.get(entity.getUUID());
        if (resident == null || !sampler.recording()) return;
        BlockLog log = sampler.blocks();
        if (!server.isSameThread()) {
            log.offThread(); // never expected; the recorder is single-threaded, so only count it
            return;
        }
        long t0 = System.nanoTime();
        try {
            if (!(accessor instanceof Level level) || pos == null || state == null) return;
            String dimension = dimensions.computeIfAbsent(level.dimension(), key -> key.location().toString());
            String block = blockIds.computeIfAbsent(state.getBlock(), b -> BuiltInRegistries.BLOCK.getKey(b).toString());
            log.record(resident, place, dimension, pos.getX(), pos.getY(), pos.getZ(), block,
                    System.currentTimeMillis(), server.overworld().getGameTime());
            sampler.listenerSucceeded();
        } catch (Throwable t) {
            sampler.listenerFailed(t);
        } finally {
            log.addListenerNanos(System.nanoTime() - t0);
        }
    }
}
