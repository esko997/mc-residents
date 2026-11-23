package dev.residents.observer;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.ChiseledBookShelfBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.ArrayList;
import java.util.List;

/**
 * Called only by the server tick sampler; HTTP must queue work, not call this directly.
 * All chunk reads use getChunkNow; shape callbacks receive a restricted BlockGetter with no
 * level/player/block-entity escape hatch. No Level.clip, capabilities, NBT serialization or writes.
 */
public final class MinecraftBridgeAccess implements BridgeAccess {
    private final MinecraftServer server;
    private final ObserverConfig config;
    private final BookText.Limits bookLimits;

    public MinecraftBridgeAccess(MinecraftServer server, ObserverConfig config) {
        this.server = server;
        this.config = config;
        this.bookLimits = new BookText.Limits(config.maxBookPages(), config.maxBookPageChars(), config.maxBookChars());
    }

    private void requireServerThread() {
        if (!server.isSameThread()) throw new IllegalStateException("bridge world access must run on the server tick thread");
    }

    @Override
    public Sight sight(ObserverConfig.ResidentSpec from, ObserverConfig.ResidentSpec to) {
        requireServerThread();
        if (!config.residents().contains(from) || !config.residents().contains(to)) {
            return new Sight(null, null, "unregistered");
        }
        ServerPlayer a = server.getPlayerList().getPlayer(from.uuid());
        ServerPlayer b = server.getPlayerList().getPlayer(to.uuid());
        if (a == null || b == null) return new Sight(null, null, "offline");
        if (a.level() != b.level()) return new Sight(null, null, "dimension");
        Vec3 av = a.getEyePosition(), bv = b.getEyePosition();
        SightRay.Point start = new SightRay.Point(av.x, av.y, av.z);
        SightRay.Point end = new SightRay.Point(bv.x, bv.y, bv.z);
        SightRay.Plan plan = SightRay.plan(start, end, config.maxSightDistance());
        Double distance = Double.isFinite(plan.distance()) ? plan.distance() : null;
        if (plan.reason() != null) return new Sight(null, distance, plan.reason());
        ServerLevel level = a.serverLevel();
        Long2ObjectOpenHashMap<LevelChunk> loaded = new Long2ObjectOpenHashMap<>(plan.chunks().size());
        // Complete preflight BEFORE looking for blockers; an early hit cannot hide unloaded terrain.
        for (SightRay.Chunk pos : plan.chunks()) {
            LevelChunk chunk = level.getChunkSource().getChunkNow(pos.x(), pos.z());
            if (chunk == null) return new Sight(null, distance, "unloaded");
            loaded.put(chunkKey(pos.x(), pos.z()), chunk);
        }
        LoadedBlocks blocks = new LoadedBlocks(loaded, level.getMinBuildHeight(), level.getHeight());
        ShapeClipper clipper = new ShapeClipper(start, end);
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        try {
            for (SightRay.Cell cell : plan.cells()) {
                pos.set(cell.x(), cell.y(), cell.z());
                BlockState state = blocks.getBlockState(pos);
                if (state.isAir()) continue;
                VoxelShape shape = state.getCollisionShape(blocks, pos, CollisionContext.empty());
                clipper.x = cell.x(); clipper.y = cell.y(); clipper.z = cell.z();
                // Inclusive slab clipping covers grazing, endpoints and rays starting inside a shape.
                // Iterate all candidates even after a hit, because later shape queries can be unknown.
                shape.forAllBoxes(clipper);
            }
        } catch (UnknownShape e) {
            return new Sight(null, distance, e.reason);
        } catch (RuntimeException e) {
            // A mod requiring a Level/Entity/BE rather than BlockGetter is not safe to evaluate here.
            return new Sight(null, distance, blocks.unknown == null ? "unsupported_shape" : blocks.unknown);
        }
        // A mod may swallow a getter exception; unknown access remains sticky.
        if (blocks.unknown != null) return new Sight(null, distance, blocks.unknown);
        return new Sight(!clipper.blocked, distance, clipper.blocked ? "blocked" : "clear");
    }

    @Override
    public Shelf shelf(ObserverConfig.FacilitySpec facility) {
        requireServerThread();
        ShelfAccess access = shelfAccess(facility);
        if (access.shelf == null) return new Shelf(facility.id(), access.status, access.reason, List.of());
        List<BookInfo> slots = new ArrayList<>(6);
        for (int slot = 0; slot < 6; slot++) {
            ItemStack item = access.shelf.getItem(slot);
            if (item.isEmpty()) continue;
            try {
                slots.add(selected(item, slot).info());
            } catch (BookText.Invalid e) {
                // No partial list that could masquerade as a complete shelf; no pages leave this endpoint.
                return new Shelf(facility.id(), e.status(), "slot " + slot + ": " + e.getMessage(), List.of());
            }
        }
        return new Shelf(facility.id(), "observed", null, slots);
    }

    @Override
    public BookResult book(ObserverConfig.FacilitySpec facility, int slot) {
        requireServerThread();
        if (slot < 0 || slot >= 6) return new BookResult(facility.id(), "invalid", "slot must be 0..5", null, List.of());
        ShelfAccess access = shelfAccess(facility);
        if (access.shelf == null) return new BookResult(facility.id(), access.status, access.reason, null, List.of());
        ItemStack item = access.shelf.getItem(slot);
        if (item.isEmpty()) return new BookResult(facility.id(), "empty", "slot is empty", null, List.of());
        try {
            BookText.Selected selected = selected(item, slot);
            if (selected.info().kind().equals("plain") || selected.info().kind().equals("enchanted")) {
                return new BookResult(facility.id(), "not_readable", "book kind has no readable pages", selected.info(), List.of());
            }
            return new BookResult(facility.id(), "observed", null, selected.info(), selected.pages());
        } catch (BookText.Invalid e) {
            return new BookResult(facility.id(), e.status(), e.getMessage(), null, List.of());
        }
    }

    private record ShelfAccess(ChiseledBookShelfBlockEntity shelf, String status, String reason) { }

    private ShelfAccess shelfAccess(ObserverConfig.FacilitySpec f) {
        if (!config.facilities().contains(f) || !f.library()) return new ShelfAccess(null, "unsupported", "not a registered library");
        ResourceLocation dimension = ResourceLocation.tryParse(f.dimension());
        ServerLevel level = dimension == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, dimension));
        if (level == null) return new ShelfAccess(null, "no_level", "configured dimension is unavailable");
        if (level.isOutsideBuildHeight(f.y())) return new ShelfAccess(null, "unsupported", "position is outside build height");
        LevelChunk chunk = level.getChunkSource().getChunkNow(Math.floorDiv(f.x(), 16), Math.floorDiv(f.z(), 16));
        if (chunk == null) return new ShelfAccess(null, "unloaded", "registered shelf chunk is not loaded");
        BlockPos pos = new BlockPos(f.x(), f.y(), f.z());
        if (!chunk.getBlockState(pos).is(Blocks.CHISELED_BOOKSHELF)) {
            return new ShelfAccess(null, "unsupported", "registered position is not a chiseled bookshelf");
        }
        BlockEntity entity = chunk.getBlockEntity(pos, LevelChunk.EntityCreationType.CHECK);
        if (entity == null || entity.isRemoved()) return new ShelfAccess(null, "no_block_entity", "loaded shelf has no existing block entity");
        // Exact vanilla type: do not invoke custom container/capability implementations.
        if (entity.getClass() != ChiseledBookShelfBlockEntity.class) {
            return new ShelfAccess(null, "unsupported", "registered shelf has a non-vanilla block entity");
        }
        return new ShelfAccess((ChiseledBookShelfBlockEntity) entity, "observed", null);
    }

    private BookText.Selected selected(ItemStack stack, int slot) throws BookText.Invalid {
        String kind;
        if (stack.is(Items.WRITTEN_BOOK)) kind = "written";
        else if (stack.is(Items.WRITABLE_BOOK)) kind = "writable";
        else if (stack.is(Items.ENCHANTED_BOOK)) kind = "enchanted";
        else if (stack.is(Items.BOOK)) kind = "plain";
        else throw new BookText.Invalid("unsupported", "unsupported item in bookshelf");
        if (kind.equals("enchanted") || kind.equals("plain")) {
            // Deliberately do not inspect enchantments, custom names or any other NBT.
            return BookText.select(slot, kind, null, null, null, List.of(), bookLimits);
        }
        CompoundTag tag = stack.getTag(); // Existing tag only; never getOrCreateTag or a full tag copy.
        String title = null, author = null;
        Integer generation = null;
        if (kind.equals("written")) {
            if (tag == null) throw BookText.invalid("written book metadata missing");
            title = selectedString(tag.get("title"), BookText.MAX_TITLE_CHARS, "title");
            author = selectedString(tag.get("author"), BookText.MAX_AUTHOR_CHARS, "author");
            Tag rawGeneration = tag.get("generation");
            if (rawGeneration == null) generation = 0; // Vanilla original books may omit generation.
            else if (rawGeneration instanceof IntTag integer) generation = integer.getAsInt();
            else throw BookText.invalid("generation must be an int tag");
        }
        Tag raw = tag == null ? null : tag.get("pages");
        if (raw == null) {
            if (kind.equals("written")) throw BookText.invalid("written book pages missing");
            return BookText.select(slot, kind, title, author, generation, List.of(), bookLimits);
        }
        if (!(raw instanceof ListTag pages)) throw BookText.invalid("pages must be a list tag");
        if (pages.size() > bookLimits.pages()) throw BookText.oversized("page count exceeds maxBookPages");
        if (!pages.isEmpty() && pages.getElementType() != Tag.TAG_STRING) throw BookText.invalid("pages must contain string tags");
        List<String> selected = new ArrayList<>(pages.size());
        int chars = (title == null ? 0 : title.length()) + (author == null ? 0 : author.length());
        for (int i = 0; i < pages.size(); i++) {
            String page = selectedString(pages.get(i), bookLimits.pageChars(), "page");
            chars += page.length();
            if (chars > bookLimits.totalChars()) throw BookText.oversized("selected source exceeds maxBookChars");
            selected.add(page);
        }
        return BookText.select(slot, kind, title, author, generation, selected, bookLimits);
    }

    private static String selectedString(Tag tag, int limit, String field) throws BookText.Invalid {
        if (!(tag instanceof StringTag string)) throw BookText.invalid(field + " must be a string tag");
        String value = string.getAsString();
        BookText.checkString(value, limit, field);
        return value;
    }

    private static long chunkKey(int x, int z) { return (long) x << 32 | (z & 0xffffffffL); }

    private static final class UnknownShape extends RuntimeException {
        private final String reason;
        UnknownShape(String reason) { super(reason, null, false, false); this.reason = reason; }
    }

    /** No ServerLevel field, no chunk provider and no BE references are exposed to shape callbacks. */
    private static final class LoadedBlocks implements BlockGetter {
        private final Long2ObjectOpenHashMap<LevelChunk> chunks;
        private final int minY, height;
        private String unknown;

        LoadedBlocks(Long2ObjectOpenHashMap<LevelChunk> chunks, int minY, int height) {
            this.chunks = chunks; this.minY = minY; this.height = height;
        }

        @Override public BlockState getBlockState(BlockPos pos) {
            LevelChunk chunk = chunks.get(chunkKey(Math.floorDiv(pos.getX(), 16), Math.floorDiv(pos.getZ(), 16)));
            if (chunk == null) { unknown = "unloaded"; throw new UnknownShape(unknown); }
            return pos.getY() < minY || pos.getY() >= minY + height
                    ? Blocks.AIR.defaultBlockState() : chunk.getBlockState(pos);
        }

        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public BlockEntity getBlockEntity(BlockPos pos) {
            // Returning an entity would expose its actual level through getLevel(). Never do that.
            unknown = "unsupported_shape";
            throw new UnknownShape(unknown);
        }
        @Override public int getHeight() { return height; }
        @Override public int getMinBuildHeight() { return minY; }
    }

    private static final class ShapeClipper implements Shapes.DoubleLineConsumer {
        private final SightRay.Point start, end;
        private int x, y, z;
        private boolean blocked;
        ShapeClipper(SightRay.Point start, SightRay.Point end) { this.start = start; this.end = end; }

        @Override public void consume(double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
            // Vanilla collision geometry fits this one-block halo. Unbounded/modded geometry is unknown.
            if (!Double.isFinite(minX) || !Double.isFinite(minY) || !Double.isFinite(minZ)
                    || !Double.isFinite(maxX) || !Double.isFinite(maxY) || !Double.isFinite(maxZ)
                    || minX < -1 || minY < -1 || minZ < -1 || maxX > 2 || maxY > 2 || maxZ > 2
                    || minX > maxX || minY > maxY || minZ > maxZ) throw new UnknownShape("unsupported_shape");
            if (!blocked) blocked = SightRay.intersects(start, end, x + minX, y + minY, z + minZ,
                    x + maxX, y + maxY, z + maxZ);
        }
    }
}
