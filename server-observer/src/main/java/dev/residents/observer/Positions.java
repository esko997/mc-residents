package dev.residents.observer;

import com.google.gson.JsonArray;

import java.util.List;
import java.util.regex.Pattern;

/** Block positions and dimension ids as they arrive in requests and leave in replies. Pure. */
final class Positions {
    static final int MAX_XZ = 30_000_000;
    static final int MAX_Y = 2048;
    private static final Pattern DIMENSION = Pattern.compile("^[a-z0-9_.-]+:[a-z0-9_./-]+$");
    private static final Pattern POS = Pattern.compile("^(-?[0-9]{1,8}),(-?[0-9]{1,8}),(-?[0-9]{1,8})$");

    private Positions() {
    }

    /** A dimension id and a block position, validated. */
    record At(String dimension, int x, int y, int z) {
        List<Integer> pos() {
            return List.of(x, y, z);
        }
    }

    /** {@code dimension=<id>&pos=x,y,z}; IllegalArgumentException (HTTP 400) when malformed or out of range. */
    static At parse(String dimension, String pos) {
        if (dimension == null || dimension.length() > 128 || !DIMENSION.matcher(dimension).matches()) {
            throw new IllegalArgumentException("dimension");
        }
        var m = pos == null ? null : POS.matcher(pos);
        if (m == null || !m.matches()) throw new IllegalArgumentException("pos");
        int x = Integer.parseInt(m.group(1)), y = Integer.parseInt(m.group(2)), z = Integer.parseInt(m.group(3));
        if (Math.abs(x) > MAX_XZ || Math.abs(z) > MAX_XZ || Math.abs(y) > MAX_Y) throw new IllegalArgumentException("pos range");
        return new At(dimension, x, y, z);
    }

    static JsonArray json(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(x);
        a.add(y);
        a.add(z);
        return a;
    }

    static long chunkKey(int chunkX, int chunkZ) {
        return (long) chunkX << 32 | (chunkZ & 0xffffffffL);
    }

    static int chunkX(long key) {
        return (int) (key >> 32);
    }

    static int chunkZ(long key) {
        return (int) key;
    }
}
