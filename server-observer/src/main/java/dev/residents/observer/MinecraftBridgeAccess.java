package dev.residents.observer;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkHolder;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.ChiseledBookShelfBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Called only by the server tick sampler; HTTP must queue work, not call this directly.
 * All chunk reads use getChunkNow (or chunk holders' already-complete futures); shape callbacks receive
 * a restricted BlockGetter with no level/player/block-entity escape hatch. No Level.clip, NBT
 * serialization or writes. Shelves and lecterns are read through their block entities' plain getters.
 */
public final class MinecraftBridgeAccess implements BridgeAccess {
    private final MinecraftServer server;
    private final ObserverConfig config;
    private final WorldAccess world;
    private final BookText.Limits bookLimits;

    public MinecraftBridgeAccess(MinecraftServer server, ObserverConfig config, WorldAccess world) {
        this.server = server;
        this.config = config;
        this.world = world;
        this.bookLimits = new BookText.Limits(config.maxBookPages(), config.maxBookPageChars(), config.maxBookChars());
    }

    private void requireServerThread() {
        if (!server.isSameThread()) throw new IllegalStateException("bridge world access must run on the server tick thread");
    }

    @Override
    public Sight sight(WatchList.ResidentSpec from, WatchList.ResidentSpec to) {
        requireServerThread();
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
            loaded.put(Positions.chunkKey(pos.x(), pos.z()), chunk);
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

    // === library ===

    @Override
    public Place place(String dimension, int x, int y, int z) {
        requireServerThread();
        return readPlace(dimension, x, y, z, null);
    }

    @Override
    public Scanned scanPlace(String dimension, int x, int y, int z, int maxNewBooks) {
        requireServerThread();
        int[] budget = {maxNewBooks, 0}; // books this call may still decode, books left pending
        Place place = readPlace(dimension, x, y, z, budget);
        return new Scanned(place, budget[1]);
    }

    /** {@code scan}: null for a full read with pages; else the scan's decode budget (memo used, no pages). */
    private Place readPlace(String dimension, int x, int y, int z, int[] scan) {
        ServerLevel level = MinecraftWorldAccess.level(server, dimension);
        if (level == null) return Place.noLevel();
        if (level.isOutsideBuildHeight(y)) return Place.other("minecraft:void_air"); // no shelf can ever stand there
        // Only the position's own chunk: shelf and lectern getters never look at neighbours.
        LevelChunk chunk = level.getChunkSource().getChunkNow(Math.floorDiv(x, 16), Math.floorDiv(z, 16));
        if (chunk == null) return Place.unloaded();
        BlockPos pos = new BlockPos(x, y, z);
        BlockState state = chunk.getBlockState(pos);
        return holderPlace(state, chunk.getBlockEntity(pos, LevelChunk.EntityCreationType.CHECK), scan);
    }

    @Override
    public Observations.BlockRead block(String dimension, int x, int y, int z) {
        requireServerThread();
        return world.read(dimension, x, y, z, null);
    }

    @Override
    public List<String> dimensions() {
        requireServerThread();
        List<String> out = new ArrayList<>();
        for (ServerLevel level : server.getAllLevels()) out.add(level.dimension().location().toString());
        return out;
    }

    /**
     * One pass over the level's chunk holders (ChunkMap#getChunks, made public by this mod's access transformer):
     * keys of holders whose full chunk is present now. Reads completed futures only; schedules nothing.
     */
    @Override
    public ChunkList loadedChunks(String dimension, int cap) {
        requireServerThread();
        ServerLevel level = MinecraftWorldAccess.level(server, dimension);
        if (level == null) return null;
        ChunkMap map = level.getChunkSource().chunkMap;
        long[] keys = new long[Math.max(0, Math.min(cap, map.size()))];
        int n = 0;
        boolean truncated = false;
        for (ChunkHolder holder : map.getChunks()) {
            if (holder.getFullChunk() == null) continue;
            if (n == keys.length) {
                if (n >= cap) {
                    truncated = true;
                    break;
                }
                keys = Arrays.copyOf(keys, Math.min(cap, Math.max(16, n * 2)));
            }
            keys[n++] = Positions.chunkKey(holder.getPos().x, holder.getPos().z);
        }
        return new ChunkList(n == keys.length ? keys : Arrays.copyOf(keys, n), truncated);
    }

    @Override
    public ChunkHolders holders(String dimension, long chunkKey, int offset, int maxBlockEntities) {
        requireServerThread();
        ServerLevel level = MinecraftWorldAccess.level(server, dimension);
        if (level == null) return null;
        LevelChunk chunk = level.getChunkSource().getChunkNow(Positions.chunkX(chunkKey), Positions.chunkZ(chunkKey));
        if (chunk == null) return null;
        List<Spot> spots = new ArrayList<>();
        int index = 0, examined = 0;
        boolean more = false;
        // The chunk's own block entity map, iterated within this one call (never held across ticks). A later slice
        // starts again from the beginning and skips `offset` entries: a pointer step each, no reads.
        for (BlockEntity be : chunk.getBlockEntities().values()) {
            if (index++ < offset) continue;
            if (examined >= maxBlockEntities) {
                more = true;
                break;
            }
            examined++;
            if (be.isRemoved()) continue;
            if (be instanceof ChiseledBookShelfBlockEntity || (be instanceof LecternBlockEntity lectern && lectern.hasBook())) {
                BlockPos p = be.getBlockPos();
                spots.add(new Spot(p.getX(), p.getY(), p.getZ()));
            }
        }
        return new ChunkHolders(spots, examined, more);
    }

    /** A loaded position: a chiseled bookshelf, a lectern, a shelf/lectern block missing its entity, or anything else. */
    private Place holderPlace(BlockState state, BlockEntity be, int[] scan) {
        String block = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if (be != null && !be.isRemoved()) {
            if (be instanceof ChiseledBookShelfBlockEntity shelf) {
                List<Slot> slots = new ArrayList<>(Library.SHELF_SLOTS);
                for (int slot = 0; slot < Library.SHELF_SLOTS; slot++) {
                    Slot s = slot(shelf.getItem(slot), slot, scan);
                    if (s != null) slots.add(s);
                }
                return new Place(Where.LOADED, block, Holder.SHELF, slots, null);
            }
            if (be instanceof LecternBlockEntity lectern) {
                Slot s = slot(lectern.getBook(), 0, scan);
                return new Place(Where.LOADED, block, Holder.LECTERN, s == null ? List.of() : List.of(s), null);
            }
        }
        if (state.is(Blocks.CHISELED_BOOKSHELF) || state.is(Blocks.LECTERN)) {
            // The block is there but its entity is not: unknown contents, never "no shelf".
            return new Place(Where.LOADED, block, state.is(Blocks.LECTERN) ? Holder.LECTERN : Holder.SHELF, List.of(),
                    block + " has no block entity");
        }
        return Place.other(block);
    }

    /**
     * One slot's item, or null when empty (or, in a scan, not decoded yet for lack of budget: counted pending).
     * A slot that cannot be read says why; the others are unaffected.
     */
    private Slot slot(ItemStack item, int slot, int[] scan) {
        if (item == null || item.isEmpty()) return null;
        if (scan != null) {
            Memo m = memos.get(item);
            if (m != null && m.matches(item)) return m.slot(slot);
            if (scan[0] <= 0) {
                scan[1]++;
                return null;
            }
            scan[0]--;
        }
        Slot s;
        try {
            s = Slot.of(slot, selected(item, slot));
        } catch (BookText.Invalid e) {
            s = Slot.failed(slot, e.status(), e.getMessage());
        } catch (RuntimeException e) {
            s = Slot.failed(slot, "error", Sampler.describe(e));
        }
        if (scan != null) {
            if (memos.size() >= MAX_MEMOS) memos.clear();
            memos.put(item, Memo.of(item, s));
            if (s.book() != null) s = Slot.of(slot, new BookText.Selected(s.book().info(), List.of())); // no pages kept
        }
        return s;
    }

    /** Scan memos (server thread only): weakly keyed by item stack, so they go when the stack goes. */
    private final java.util.Map<ItemStack, Memo> memos = new java.util.WeakHashMap<>();
    static final int MAX_MEMOS = 32_768;

    /**
     * What one book stack selected to (its BookInfo, or why it failed), valid while the stack still holds the same
     * tag objects for everything {@link #selected} reads: the tag, title, author, generation, the pages list and
     * each page. Tags are replaced, not edited, when a book changes (StringTag is immutable; a page edit puts a
     * new element), so identity is a complete check of what was read. Pages are not kept.
     */
    private record Memo(CompoundTag tag, Tag title, Tag author, Tag generation, Tag pages, Tag[] pageTags,
                        BookInfo info, String status, String reason) {
        static Memo of(ItemStack stack, Slot s) {
            CompoundTag tag = stack.getTag();
            Tag pages = tag == null ? null : tag.get("pages");
            Tag[] each = new Tag[0];
            if (pages instanceof ListTag list) {
                each = new Tag[list.size()];
                for (int i = 0; i < each.length; i++) each[i] = list.get(i);
            }
            return new Memo(tag, tag == null ? null : tag.get("title"), tag == null ? null : tag.get("author"),
                    tag == null ? null : tag.get("generation"), pages, each,
                    s.book() == null ? null : s.book().info(), s.status(), s.reason());
        }

        boolean matches(ItemStack stack) {
            CompoundTag now = stack.getTag();
            if (now != tag) return false;
            if (now == null) return true;
            if (now.get("title") != title || now.get("author") != author || now.get("generation") != generation) return false;
            Tag p = now.get("pages");
            if (p != pages) return false;
            if (p instanceof ListTag list) {
                if (list.size() != pageTags.length) return false;
                for (int i = 0; i < pageTags.length; i++) if (list.get(i) != pageTags[i]) return false;
            }
            return true;
        }

        /** The memo as a slot at {@code slot} (a stack moved within a shelf keeps its book; the hash ignores slots). */
        Slot slot(int slot) {
            if (info == null) return Slot.failed(slot, status, reason);
            BookInfo at = new BookInfo(slot, info.kind(), info.item(), info.title(), info.author(), info.generation(),
                    info.pageCount(), info.contentHash());
            return Slot.of(slot, new BookText.Selected(at, List.of()));
        }
    }

    private BookText.Selected selected(ItemStack stack, int slot) throws BookText.Invalid {
        String kind;
        if (stack.is(Items.WRITTEN_BOOK)) kind = "written";
        else if (stack.is(Items.WRITABLE_BOOK)) kind = "writable";
        else if (stack.is(Items.ENCHANTED_BOOK)) kind = "enchanted";
        else if (stack.is(Items.BOOK)) kind = "plain";
        // A knowledge book, a mod's guide book or album: listed by item id; its data is not interpreted.
        else return BookText.other(slot, BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
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
            LevelChunk chunk = chunks.get(Positions.chunkKey(Math.floorDiv(pos.getX(), 16), Math.floorDiv(pos.getZ(), 16)));
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
