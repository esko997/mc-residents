package dev.residents.observer;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/** Pure, bounded closed-segment supercover with a one-block collision-shape halo. */
final class SightRay {
    record Point(double x, double y, double z) { }
    record Cell(int x, int y, int z) { }
    record Chunk(int x, int z) { }
    record Plan(double distance, String reason, List<Cell> cells, Set<Chunk> chunks) {
        Plan {
            cells = List.copyOf(cells);
            chunks = Set.copyOf(chunks);
        }

        boolean allLoaded(Predicate<Chunk> loaded) {
            // This preflight is independent of collision results: even chunks beyond a blocker count.
            return chunks.stream().allMatch(loaded);
        }
    }

    private SightRay() { }

    static Plan plan(Point from, Point to, int maxDistance) {
        if (maxDistance < 1 || maxDistance > 512) throw new IllegalArgumentException("maxDistance");
        if (!valid(from) || !valid(to)) return new Plan(Double.NaN, "invalid_position", List.of(), Set.of());
        double dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance > maxDistance) return new Plan(distance, "out_of_range", List.of(), Set.of());

        // Split at each grid plane. Midpoints visit every open interval; event points include all
        // adjacent closed cells, including negative coordinates, stationary grid planes and corners.
        List<Double> times = new ArrayList<>();
        times.add(0.0);
        times.add(1.0);
        crossings(times, from.x, to.x);
        crossings(times, from.y, to.y);
        crossings(times, from.z, to.z);
        times.sort(Double::compare);
        Set<Cell> cells = new LinkedHashSet<>();
        double previous = -1;
        for (double t : times) {
            if (t == previous) continue;
            if (previous >= 0) addAt(cells, from, dx, dy, dz, (previous + t) / 2);
            addAt(cells, from, dx, dy, dz, t);
            previous = t;
        }
        Set<Chunk> chunks = new LinkedHashSet<>();
        for (Cell c : cells) chunks.add(new Chunk(Math.floorDiv(c.x, 16), Math.floorDiv(c.z, 16)));
        return new Plan(distance, null, List.copyOf(cells), chunks);
    }

    private static boolean valid(Point p) {
        return p != null && Double.isFinite(p.x) && Double.isFinite(p.y) && Double.isFinite(p.z)
                && Math.abs(p.x) <= 30_000_000 && Math.abs(p.z) <= 30_000_000 && Math.abs(p.y) <= 30_000_000;
    }

    private static void crossings(List<Double> times, double start, double end) {
        if (start == end) return;
        for (int plane = (int) Math.floor(Math.min(start, end)) + 1; plane < Math.max(start, end); plane++) {
            times.add((plane - start) / (end - start));
        }
    }

    private static void addAt(Set<Cell> cells, Point from, double dx, double dy, double dz, double t) {
        double x = from.x + t * dx, y = from.y + t * dy, z = from.z + t * dz;
        // Outward rounding (well below a voxel) only adds candidates; it can never claim false clear.
        int x0 = (int) Math.floor(x - 1e-7) - 1, x1 = (int) Math.floor(x + 1e-7) + 1;
        int y0 = (int) Math.floor(y - 1e-7) - 1, y1 = (int) Math.floor(y + 1e-7) + 1;
        int z0 = (int) Math.floor(z - 1e-7) - 1, z1 = (int) Math.floor(z + 1e-7) + 1;
        for (int cx = x0; cx <= x1; cx++) {
            for (int cy = y0; cy <= y1; cy++) {
                for (int cz = z0; cz <= z1; cz++) cells.add(new Cell(cx, cy, cz));
            }
        }
    }

    /** Closed slab intersection: handles zero-length rays and starting inside a shape. */
    static boolean intersects(Point from, Point to, double minX, double minY, double minZ,
                              double maxX, double maxY, double maxZ) {
        double lo = 0, hi = 1;
        double delta = to.x - from.x;
        if (delta == 0) {
            if (from.x < minX || from.x > maxX) return false;
        } else {
            double a = (minX - from.x) / delta, b = (maxX - from.x) / delta;
            lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
        delta = to.y - from.y;
        if (delta == 0) {
            if (from.y < minY || from.y > maxY) return false;
        } else {
            double a = (minY - from.y) / delta, b = (maxY - from.y) / delta;
            lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
        delta = to.z - from.z;
        if (delta == 0) {
            if (from.z < minZ || from.z > maxZ) return false;
        } else {
            double a = (minZ - from.z) / delta, b = (maxZ - from.z) / delta;
            lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
        return lo <= hi;
    }
}
