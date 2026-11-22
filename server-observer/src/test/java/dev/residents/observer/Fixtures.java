package dev.residents.observer;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Shared test data: a valid config, and a stand-in world with a controllable clock. */
final class Fixtures {

    static final String COMMONS_TOKEN = "commons-token-0123456789abcdef";
    static final String GARY_TOKEN = "gary-token-0123456789abcdef";
    static final String STATUS_TOKEN = "status-token-0123456789abcdef";
    static final UUID GARY = UUID.fromString("11111111-1111-1111-1111-111111111111");
    static final UUID MARGO = UUID.fromString("22222222-2222-2222-2222-222222222222");

    private Fixtures() {
    }

    static String configJson(String extra, int facilityCount) {
        StringBuilder facilities = new StringBuilder();
        for (int i = 0; i < facilityCount; i++) {
            if (i > 0) {
                facilities.append(',');
            }
            facilities.append("{\"id\":\"f").append(i).append("\",\"dimension\":\"minecraft:overworld\",\"pos\":[")
                    .append(i * 3).append(",64,0]}");
        }
        return "{" + extra
                + "\"residents\":[{\"name\":\"Gary\",\"uuid\":\"" + GARY + "\"},{\"name\":\"Margo\",\"uuid\":\"" + MARGO + "\"}],"
                + "\"facilities\":[" + facilities + "],"
                + "\"consumers\":["
                + "{\"name\":\"commons\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(COMMONS_TOKEN) + "\",\"scopes\":[\"residents\",\"facilities\",\"status\"]},"
                + "{\"name\":\"gary\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(GARY_TOKEN) + "\",\"scopes\":[\"self\"],\"resident\":\"Gary\"},"
                + "{\"name\":\"ops\",\"tokenSha256\":\"" + TokenAuth.sha256Hex(STATUS_TOKEN) + "\",\"scopes\":[\"status\"]}"
                + "]}";
    }

    static ObserverConfig config(String extra, int facilityCount) {
        try {
            return ObserverConfig.parse(configJson(extra, facilityCount));
        } catch (ObserverConfig.InvalidConfig e) {
            throw new AssertionError(e);
        }
    }

    static ObserverConfig.ConsumerSpec consumer(ObserverConfig config, String name) {
        return config.consumers().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }

    static Observations.Body body(long at, String dimension, double x, boolean dead) {
        return new Observations.Body(at, 100, dimension, x, 64, 0, dead ? 0 : 20, 20, 18, 300, 300,
                "survival", dead, false, null, 3);
    }

    static Observations.Contents chest(String item, long count) {
        return new Observations.Contents("minecraft:chest", 27, 1, false,
                List.of(new Observations.ItemCount(item, count, 0)), false, null, List.of(), 5);
    }

    /** A clock in nanoseconds and milliseconds that only moves when told to. */
    static final class Clock {
        long nanos;
        long ms = 1_700_000_000_000L;
    }

    /** A world whose residents/facilities are set by the test; each facility read costs {@code readCostNanos}. */
    static final class FakeWorld implements WorldAccess {
        final Clock clock;
        long readCostNanos;
        long gameTime = 1000;
        boolean gameTimeThrows;
        final java.util.Map<UUID, Observations.Body> online = new java.util.HashMap<>();
        final java.util.Map<String, Observations.FacilityStatus> status = new java.util.HashMap<>();
        final java.util.Map<String, Observations.Contents> contents = new java.util.HashMap<>();
        final java.util.Set<String> throwing = new java.util.HashSet<>();
        final List<String> reads = new ArrayList<>();

        FakeWorld(Clock clock) {
            this.clock = clock;
        }

        @Override
        public long gameTime() {
            if (gameTimeThrows) {
                throw new IllegalStateException("world gone");
            }
            return gameTime;
        }

        @Override
        public Observations.Body readResident(ObserverConfig.ResidentSpec resident, long nowMs, long gameTime) {
            return online.get(resident.uuid());
        }

        @Override
        public Observations.Facility readFacility(ObserverConfig.FacilitySpec f, long nowMs, long gameTime) {
            clock.nanos += readCostNanos;
            reads.add(f.id());
            if (throwing.contains(f.id())) {
                throw new RuntimeException("capability exploded");
            }
            Observations.FacilityStatus s = status.getOrDefault(f.id(), Observations.FacilityStatus.OBSERVED);
            return Observations.Facility.read(f, s, s == Observations.FacilityStatus.OBSERVED ? null : "not loaded",
                    nowMs, gameTime, contents.getOrDefault(f.id(), chest("minecraft:cobblestone", 64)));
        }
    }

    static Sampler sampler(ObserverConfig config, FakeWorld world, List<String> warnings) {
        return new Sampler(config, world, new EventLog(config.eventCapacity()),
                () -> world.clock.nanos, () -> world.clock.ms, warnings::add);
    }
}
