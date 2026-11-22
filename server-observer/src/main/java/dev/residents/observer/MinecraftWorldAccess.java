package dev.residents.observer;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerChunkCache;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraftforge.common.capabilities.ForgeCapabilities;
import net.minecraftforge.energy.IEnergyStorage;
import net.minecraftforge.fluids.FluidStack;
import net.minecraftforge.fluids.capability.IFluidHandler;
import net.minecraftforge.items.IItemHandler;

import java.util.ArrayList;
import java.util.List;

/**
 * Read-only, non-loading access to the running server. Called only on the server thread.
 *
 * <p>Chunk access goes exclusively through {@link ServerChunkCache#getChunkNow(int, int)}, which
 * returns {@code null} for any chunk that is not already fully loaded and never schedules a load
 * or adds a ticket. {@code Level#getBlockEntity}/{@code getBlockState} are deliberately avoided:
 * on the server thread they load the chunk. Because some capability implementations look at
 * neighbouring blocks (a vanilla double chest asks for its other half through the level), a
 * facility is only read when its whole 3×3 chunk neighbourhood is loaded.
 */
public final class MinecraftWorldAccess implements WorldAccess {

    private static final int MAX_TANKS = 16;

    private final MinecraftServer server;
    private final int maxSlots;
    private final int maxItemKinds;

    public MinecraftWorldAccess(MinecraftServer server, int maxSlots, int maxItemKinds) {
        this.server = server;
        this.maxSlots = maxSlots;
        this.maxItemKinds = maxItemKinds;
    }

    @Override
    public long gameTime() {
        return server.overworld().getGameTime();
    }

    @Override
    public Observations.Body readResident(ObserverConfig.ResidentSpec resident, long nowMs, long gameTime) {
        ServerPlayer p = server.getPlayerList().getPlayer(resident.uuid());
        if (p == null) {
            return null;
        }
        Entity vehicle = p.getVehicle();
        return new Observations.Body(nowMs, gameTime,
                p.level().dimension().location().toString(),
                p.getX(), p.getY(), p.getZ(),
                p.getHealth(), p.getMaxHealth(),
                p.getFoodData().getFoodLevel(), p.getAirSupply(), p.getMaxAirSupply(),
                p.gameMode.getGameModeForPlayer().getName(),
                p.isDeadOrDying(), p.isSleeping(),
                vehicle == null ? null : EntityType.getKey(vehicle.getType()).toString(),
                p.experienceLevel);
    }

    @Override
    public Observations.Facility readFacility(ObserverConfig.FacilitySpec f, long nowMs, long gameTime) {
        ResourceLocation dimension = ResourceLocation.tryParse(f.dimension());
        ServerLevel level = dimension == null ? null
                : server.getLevel(ResourceKey.create(Registries.DIMENSION, dimension));
        if (level == null) {
            return result(f, Observations.FacilityStatus.NO_LEVEL, "dimension " + f.dimension() + " does not exist here",
                    nowMs, gameTime, null);
        }
        if (level.isOutsideBuildHeight(f.y())) {
            return result(f, Observations.FacilityStatus.NO_BLOCK_ENTITY, "y " + f.y() + " is outside the build height",
                    nowMs, gameTime, null);
        }

        int cx = SectionPos.blockToSectionCoord(f.x());
        int cz = SectionPos.blockToSectionCoord(f.z());
        ServerChunkCache chunks = level.getChunkSource();
        LevelChunk chunk = null;
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                LevelChunk c = chunks.getChunkNow(cx + dx, cz + dz);
                if (c == null) {
                    String which = dx == 0 && dz == 0 ? "its chunk" : "neighbouring chunk";
                    return result(f, Observations.FacilityStatus.UNLOADED,
                            which + " " + (cx + dx) + "," + (cz + dz) + " is not loaded (the observer never loads chunks)",
                            nowMs, gameTime, null);
                }
                if (dx == 0 && dz == 0) {
                    chunk = c;
                }
            }
        }

        BlockPos pos = new BlockPos(f.x(), f.y(), f.z());
        BlockState state = chunk.getBlockState(pos);
        String block = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        BlockEntity be = chunk.getBlockEntity(pos, LevelChunk.EntityCreationType.CHECK);
        if (be == null || be.isRemoved()) {
            return result(f, Observations.FacilityStatus.NO_BLOCK_ENTITY, "the block there is " + block + " (no block entity)",
                    nowMs, gameTime, null);
        }

        long t0 = System.nanoTime();
        Direction side = f.side() == null ? null : Direction.byName(f.side());
        IItemHandler items = be.getCapability(ForgeCapabilities.ITEM_HANDLER, side).resolve().orElse(null);
        IEnergyStorage energy = be.getCapability(ForgeCapabilities.ENERGY, side).resolve().orElse(null);
        IFluidHandler fluids = be.getCapability(ForgeCapabilities.FLUID_HANDLER, side).resolve().orElse(null);
        if (items == null && energy == null && fluids == null) {
            ResourceLocation type = BlockEntityType.getKey(be.getType());
            return result(f, Observations.FacilityStatus.UNSUPPORTED, (type == null ? block : type.toString())
                            + " exposes no item, energy or fluid capability" + (side == null ? "" : " on side " + f.side())
                            + "; mod-specific reading is not implemented",
                    nowMs, gameTime, null);
        }

        ItemTally tally = new ItemTally(maxItemKinds);
        int slots = 0;
        boolean slotsTruncated = false;
        if (items != null) {
            slots = items.getSlots();
            int limit = Math.min(slots, maxSlots);
            slotsTruncated = slots > maxSlots;
            for (int i = 0; i < limit; i++) {
                // getStackInSlot's contract: callers must not modify the returned stack. Only read it.
                ItemStack stack = items.getStackInSlot(i);
                if (!stack.isEmpty()) {
                    tally.add(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount(), stack.hasTag());
                }
            }
        }
        List<Observations.FluidAmount> tanks = new ArrayList<>();
        if (fluids != null) {
            int n = Math.min(fluids.getTanks(), MAX_TANKS);
            for (int i = 0; i < n; i++) {
                FluidStack fs = fluids.getFluidInTank(i);
                String id = fs.isEmpty() ? "minecraft:empty" : BuiltInRegistries.FLUID.getKey(fs.getFluid()).toString();
                tanks.add(new Observations.FluidAmount(id, fs.isEmpty() ? 0 : fs.getAmount(), fluids.getTankCapacity(i)));
            }
        }
        Observations.Energy power = energy == null ? null
                : new Observations.Energy(energy.getEnergyStored(), energy.getMaxEnergyStored());
        long micros = (System.nanoTime() - t0) / 1000L;
        Observations.Contents contents = new Observations.Contents(block, slots, tally.usedSlots(), slotsTruncated,
                tally.items(), tally.truncated(), power, tanks, micros);
        return result(f, Observations.FacilityStatus.OBSERVED, null, nowMs, gameTime, contents);
    }

    private static Observations.Facility result(ObserverConfig.FacilitySpec f, Observations.FacilityStatus status,
                                                String detail, long nowMs, long gameTime, Observations.Contents contents) {
        return Observations.Facility.read(f, status, detail, nowMs, gameTime, contents);
    }
}
