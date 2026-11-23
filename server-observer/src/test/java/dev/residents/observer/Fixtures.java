package dev.residents.observer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Shared test data: a valid config, a watch list, and a stand-in world with a controllable clock. */
final class Fixtures {

    static final String COMMONS_TOKEN = "commons-token-0123456789abcdef";
    static final String GARY_TOKEN = "gary-token-0123456789abcdef";
    static final String STATUS_TOKEN = "status-token-0123456789abcdef";
    static final UUID GARY = UUID.fromString("11111111-1111-1111-1111-111111111111");
    static final UUID MARGO = UUID.fromString("22222222-2222-2222-2222-222222222222");
    static final String OVERWORLD = "minecraft:overworld";

    private Fixtures() {
    }

    static String configJson(String extra) {
        return "{" + extra
                + "\"consumers\":["
                + "{\"name\":\"commons\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(COMMONS_TOKEN) + "\",\"scopes\":[\"residents\",\"facilities\",\"library\",\"status\",\"watch\"]},"
                + "{\"name\":\"gary\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(GARY_TOKEN) + "\",\"scopes\":[\"self\"],\"resident\":\"Gary\"},"
                + "{\"name\":\"ops\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(STATUS_TOKEN) + "\",\"scopes\":[\"status\"]}"
                + "]}";
    }

    static ObserverConfig config(String extra) {
        try {
            return ObserverConfig.parse(configJson(extra));
        } catch (ObserverConfig.InvalidConfig e) {
            throw new AssertionError(e);
        }
    }

    static ObserverConfig.ConsumerSpec consumer(ObserverConfig config, String name) {
        return config.consumers().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }

    /** Gary and Margo, plus facilities f0..f(n-1) at (3i, 64, 0) in the overworld. */
    static String watchJson(String revision, int facilityCount) {
        StringBuilder facilities = new StringBuilder();
        for (int i = 0; i < facilityCount; i++) {
            if (i > 0) facilities.append(',');
            facilities.append("{\"id\":\"f").append(i).append("\",\"dimension\":\"minecraft:overworld\",\"pos\":[")
                    .append(i * 3).append(",64,0]}");
        }
        return "{\"revision\":\"" + revision + "\","
                + "\"residents\":[{\"name\":\"Gary\",\"uuid\":\"" + GARY + "\"},{\"name\":\"Margo\",\"uuid\":\"" + MARGO + "\"}],"
                + "\"facilities\":[" + facilities + "]}";
    }

    static WatchList watch(String revision, int facilityCount) {
        try {
            return WatchList.parse(watchJson(revision, facilityCount));
        } catch (WatchList.Invalid e) {
            throw new AssertionError(e);
        }
    }

    static WatchList.FacilitySpec facility(String id, int x) {
        return new WatchList.FacilitySpec(id, id, OVERWORLD, x, 64, 0, null);
    }

    static Observations.Body body(long at, String dimension, double x, boolean dead) {
        return new Observations.Body(at, 100, dimension, x, 64, 0, dead ? 0 : 20, 20, 18, 300, 300,
                "survival", dead, false, null, 3);
    }

    static Observations.Contents chest(String item, long count) {
        return new Observations.Contents("minecraft:chest", 27, 1, false,
                List.of(new Observations.ItemCount(item, count, 0)), false, null, List.of(), 5);
    }

    static BridgeAccess.Place shelf(BridgeAccess.Slot... slots) {
        return new BridgeAccess.Place(BridgeAccess.Where.LOADED, "minecraft:chiseled_bookshelf", BridgeAccess.Holder.SHELF,
                List.of(slots), null);
    }

    static BridgeAccess.Place lectern(BridgeAccess.Slot... slots) {
        return new BridgeAccess.Place(BridgeAccess.Where.LOADED, "minecraft:lectern", BridgeAccess.Holder.LECTERN,
                List.of(slots), null);
    }

    static BridgeAccess.Slot written(int slot, String title, String... pages) {
        try {
            List<String> json = new ArrayList<>();
            for (String p : pages) json.add("{\"text\":\"" + p + "\"}");
            return BridgeAccess.Slot.of(slot, BookText.select(slot, "written", title, "Wren", 0, json,
                    new BookText.Limits(100, 8192, 65536)));
        } catch (BookText.Invalid e) {
            throw new AssertionError(e);
        }
    }

    /** A clock in nanoseconds and milliseconds that only moves when told to. */
    static final class Clock {
        long nanos;
        long ms = 1_700_000_000_000L;
    }

    /**
     * A world whose residents, facilities, positions and loaded chunks are set by the test. A facility read
     * at (3i, y, z) is facility "f&lt;i&gt;" and costs {@code readCostNanos}; a scanned chunk costs {@code chunkCostNanos}.
     */
    static final class FakeWorld implements WorldAccess, BridgeAccess {
        final Clock clock;
        long readCostNanos;
        long chunkCostNanos;
        long gameTime = 1000;
        boolean gameTimeThrows;
        final Map<UUID, Observations.Body> online = new HashMap<>();
        final Map<String, Observations.FacilityStatus> status = new HashMap<>();
        final Map<String, Observations.Contents> contents = new HashMap<>();
        final java.util.Set<String> throwing = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final List<String> reads = new ArrayList<>();
        Thread bridgeThread;
        int bridgeReads;
        boolean bridgeThrows;
        BridgeAccess.Sight sightResult = new BridgeAccess.Sight(null, null, "offline");
        /** Positions for shelf/book reads, keyed "dimension|x,y,z"; anything else is loaded air. */
        final Map<String, BridgeAccess.Place> places = new HashMap<>();
        /** Loaded chunks per dimension, each with its block entities (shelves, lecterns, and others as Place.other). */
        final Map<String, Map<Long, List<BridgeAccess.Found>>> chunks = new java.util.TreeMap<>();
        /** Chunks that are listed but have unloaded by the time they are read. */
        final java.util.Set<Long> unloadBeforeRead = new java.util.HashSet<>();
        /** Chunks that unload after their first block-entity slice. */
        final java.util.Set<Long> unloadAfterFirstSlice = new java.util.HashSet<>();
        /** Dimensions that disappear after being listed among the levels. */
        final java.util.Set<String> levelGoneAfterListing = new java.util.HashSet<>();
        final java.util.Set<Long> holdersThrow = new java.util.HashSet<>();
        int chunkListCap = Integer.MAX_VALUE;
        int chunksRead;
        int slices;
        long placeCostNanos;
        /** Block entities examined by the largest single slice. */
        int largestSlice;

        FakeWorld(Clock clock) {
            this.clock = clock;
        }

        static String key(String dimension, int x, int y, int z) {
            return dimension + "|" + x + "," + y + "," + z;
        }

        @Override
        public BridgeAccess.Sight sight(WatchList.ResidentSpec from, WatchList.ResidentSpec to) {
            bridgeThread = Thread.currentThread();
            bridgeReads++;
            clock.nanos += readCostNanos;
            if (bridgeThrows) throw new IllegalStateException("bridge failure");
            return sightResult;
        }

        @Override
        public BridgeAccess.Place place(String dimension, int x, int y, int z) {
            bridgeThread = Thread.currentThread();
            bridgeReads++;
            clock.nanos += placeCostNanos;
            BridgeAccess.Place p = places.get(key(dimension, x, y, z));
            return p != null ? p : BridgeAccess.Place.other("minecraft:air");
        }

        @Override
        public Observations.BlockRead block(String dimension, int x, int y, int z) {
            bridgeThread = Thread.currentThread();
            bridgeReads++;
            return read(dimension, x, y, z, null);
        }

        @Override
        public List<String> dimensions() {
            return new ArrayList<>(chunks.keySet());
        }

        @Override
        public BridgeAccess.ChunkList loadedChunks(String dimension, int cap) {
            Map<Long, List<BridgeAccess.Found>> level = chunks.get(dimension);
            if (level == null || levelGoneAfterListing.contains(dimension)) return null;
            int limit = Math.min(cap, chunkListCap);
            long[] keys = level.keySet().stream().mapToLong(Long::longValue).limit(limit).toArray();
            return new BridgeAccess.ChunkList(keys, level.size() > limit);
        }

        /** Book decodes the scan path did; a fake memo remembers (position, slot) like the real one remembers stacks. */
        int bookDecodes;
        long bookCostNanos;
        final java.util.Set<String> decoded = new java.util.HashSet<>();
        /** Every book always looks new (a shelf whose contents keep changing). */
        boolean booksAlwaysNew;

        @Override
        public BridgeAccess.Scanned scanPlace(String dimension, int x, int y, int z, int maxNewBooks) {
            if (booksAlwaysNew) decoded.clear();
            BridgeAccess.Place p = place(dimension, x, y, z);
            int budget = maxNewBooks, pending = 0;
            List<BridgeAccess.Slot> ready = new ArrayList<>();
            for (BridgeAccess.Slot s : p.slots()) {
                String k = key(dimension, x, y, z) + "#" + s.slot();
                if (!decoded.contains(k)) {
                    if (budget <= 0) {
                        pending++;
                        continue;
                    }
                    budget--;
                    bookDecodes++;
                    clock.nanos += bookCostNanos;
                    decoded.add(k);
                }
                ready.add(s);
            }
            return new BridgeAccess.Scanned(new BridgeAccess.Place(p.where(), p.block(), p.holder(), ready, p.problem()), pending);
        }

        @Override
        public BridgeAccess.ChunkHolders holders(String dimension, long chunkKey, int offset, int maxBlockEntities) {
            clock.nanos += chunkCostNanos;
            if (offset == 0) chunksRead++;
            if (holdersThrow.contains(chunkKey)) throw new IllegalStateException("modded block entity exploded");
            Map<Long, List<BridgeAccess.Found>> level = chunks.get(dimension);
            if (level == null || unloadBeforeRead.contains(chunkKey) || !level.containsKey(chunkKey)) return null;
            if (offset > 0 && unloadAfterFirstSlice.contains(chunkKey)) return null;
            slices++;
            List<BridgeAccess.Found> all = level.get(chunkKey);
            int end = Math.min(all.size(), offset + maxBlockEntities);
            List<BridgeAccess.Spot> spots = new ArrayList<>();
            for (BridgeAccess.Found f : all.subList(Math.min(offset, end), end)) {
                if (f.place().holder() != BridgeAccess.Holder.NONE) spots.add(new BridgeAccess.Spot(f.x(), f.y(), f.z()));
            }
            largestSlice = Math.max(largestSlice, end - Math.min(offset, end));
            return new BridgeAccess.ChunkHolders(spots, end - Math.min(offset, end), end < all.size());
        }

        void addHolder(String dimension, int x, int y, int z, BridgeAccess.Place place) {
            long key = Positions.chunkKey(Math.floorDiv(x, 16), Math.floorDiv(z, 16));
            chunks.computeIfAbsent(dimension, d -> new java.util.TreeMap<>())
                    .computeIfAbsent(key, k -> new ArrayList<>()).add(new BridgeAccess.Found(x, y, z, place));
            places.put(key(dimension, x, y, z), place);
        }

        /** A block entity that is neither shelf nor lectern (a cable, a hopper). */
        void addOther(String dimension, int x, int y, int z) {
            long key = Positions.chunkKey(Math.floorDiv(x, 16), Math.floorDiv(z, 16));
            chunks.computeIfAbsent(dimension, d -> new java.util.TreeMap<>())
                    .computeIfAbsent(key, k -> new ArrayList<>()).add(new BridgeAccess.Found(x, y, z, BridgeAccess.Place.other("mod:cable")));
        }

        @Override
        public long gameTime() {
            if (gameTimeThrows) {
                throw new IllegalStateException("world gone");
            }
            return gameTime;
        }

        @Override
        public Observations.Body readResident(WatchList.ResidentSpec resident, long nowMs, long gameTime) {
            return online.get(resident.uuid());
        }

        @Override
        public Observations.BlockRead read(String dimension, int x, int y, int z, String side) {
            clock.nanos += readCostNanos;
            String id = "f" + (x / 3);
            reads.add(id);
            if (throwing.contains(id)) {
                throw new RuntimeException("capability exploded");
            }
            Observations.FacilityStatus s = status.getOrDefault(id, Observations.FacilityStatus.OBSERVED);
            return new Observations.BlockRead(s, s == Observations.FacilityStatus.OBSERVED ? null : "not loaded",
                    "minecraft:chest", contents.getOrDefault(id, chest("minecraft:cobblestone", 64)));
        }
    }

    /** A sampler watching nothing (Commons has not pushed). */
    static Sampler sampler(ObserverConfig config, FakeWorld world, List<String> warnings) {
        return new Sampler(config, world, world, new EventLog(config.eventCapacity()),
                () -> world.clock.nanos, () -> world.clock.ms, warnings::add);
    }

    /** A sampler with Gary, Margo and {@code facilityCount} facilities pushed; the list applies at the first tick. */
    static Sampler watched(ObserverConfig config, FakeWorld world, List<String> warnings, int facilityCount) {
        Sampler s = sampler(config, world, warnings);
        s.offerWatch(watch("r1", facilityCount));
        return s;
    }
}
