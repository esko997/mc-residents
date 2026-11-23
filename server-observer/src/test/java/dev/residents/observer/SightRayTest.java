package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class SightRayTest {
    private static SightRay.Point p(double x, double y, double z) { return new SightRay.Point(x, y, z); }

    @Test void negativeCoordinatesUseFloorNotTruncation() {
        SightRay.Plan plan = SightRay.plan(p(-17.5, 64.5, -0.5), p(-0.5, 64.5, -0.5), 128);
        assertNull(plan.reason());
        assertEquals(17, plan.distance());
        assertTrue(plan.cells().contains(new SightRay.Cell(-18, 64, -1)));
        assertTrue(plan.chunks().contains(new SightRay.Chunk(-2, -1)));
        assertTrue(plan.chunks().contains(new SightRay.Chunk(-1, -1)));
        assertTrue(plan.chunks().contains(new SightRay.Chunk(0, 0))); // conservative shape halo
    }

    @Test void stationaryBoundaryIncludesBothSidesAndTheirShapeNeighbours() {
        SightRay.Plan plan = SightRay.plan(p(16, 64.5, 1.5), p(16, 64.5, 14.5), 128);
        assertTrue(plan.cells().contains(new SightRay.Cell(14, 64, 5)));
        assertTrue(plan.cells().contains(new SightRay.Cell(15, 64, 5)));
        assertTrue(plan.cells().contains(new SightRay.Cell(16, 64, 5)));
        assertTrue(plan.cells().contains(new SightRay.Cell(17, 64, 5)));
        assertTrue(plan.chunks().contains(new SightRay.Chunk(0, 0)));
        assertTrue(plan.chunks().contains(new SightRay.Chunk(1, 0)));
    }

    @Test void diagonalCornerIncludesEveryTouchedCellAndChunks() {
        SightRay.Plan plan = SightRay.plan(p(15.5, 63.5, 15.5), p(16.5, 64.5, 16.5), 128);
        for (int x = 15; x <= 16; x++) for (int y = 63; y <= 64; y++) for (int z = 15; z <= 16; z++) {
            assertTrue(plan.cells().contains(new SightRay.Cell(x, y, z)));
        }
        assertTrue(plan.chunks().containsAll(Set.of(new SightRay.Chunk(0, 0), new SightRay.Chunk(0, 1),
                new SightRay.Chunk(1, 0), new SightRay.Chunk(1, 1))));
    }

    @Test void completePreflightIncludesUnloadedChunkPastBlocker() {
        SightRay.Point from = p(1.5, 64.5, 8.5), to = p(47.5, 64.5, 8.5);
        assertTrue(SightRay.intersects(from, to, 2, 64, 8, 3, 65, 9));
        SightRay.Plan plan = SightRay.plan(from, to, 128);
        assertFalse(plan.allLoaded(chunk -> chunk.x() != 2));
        assertTrue(plan.allLoaded(chunk -> true));
    }

    @Test void unloadedNeighbourTouchingRayIsUnknownEvenWhenRayCellIsLoaded() {
        SightRay.Plan plan = SightRay.plan(p(15.9, 64.5, 8.5), p(15.9, 70.5, 8.5), 128);
        assertFalse(plan.allLoaded(chunk -> chunk.x() == 0));
    }

    @Test void endpointsAndZeroLengthOnCornerRemainConservative() {
        SightRay.Plan plan = SightRay.plan(p(0, 0, 0), p(0, 0, 0), 128);
        assertEquals(0, plan.distance());
        assertTrue(plan.cells().contains(new SightRay.Cell(-1, -1, -1)));
        assertTrue(plan.cells().contains(new SightRay.Cell(0, 0, 0)));
        assertTrue(SightRay.intersects(p(0, 0, 0), p(0, 0, 0), -1, -1, -1, 0, 0, 0));
        assertFalse(SightRay.intersects(p(0, 0, 0), p(0, 0, 0), 1, 1, 1, 2, 2, 2));
    }

    @Test void maximumDistanceIsInclusiveAndRejectsBeforePlanning() {
        assertNull(SightRay.plan(p(0, 0, 0), p(512, 0, 0), 512).reason());
        SightRay.Plan over = SightRay.plan(p(0, 0, 0), p(512.0001, 0, 0), 512);
        assertEquals("out_of_range", over.reason());
        assertTrue(over.cells().isEmpty());
        assertTrue(over.chunks().isEmpty());
        assertEquals("out_of_range", SightRay.plan(p(0, 0, 0), p(129, 0, 0), 128).reason());
        assertEquals("invalid_position", SightRay.plan(p(Double.NaN, 0, 0), p(0, 0, 0), 128).reason());
        assertThrows(IllegalArgumentException.class, () -> SightRay.plan(p(0, 0, 0), p(0, 0, 0), 513));
    }

    @Test void reversingRayPreservesCandidatesIncludingNegativeCorner() {
        SightRay.Point from = p(-32, -3.5, 16), to = p(17, 9, -15);
        SightRay.Plan forward = SightRay.plan(from, to, 128), reverse = SightRay.plan(to, from, 128);
        assertEquals(new HashSet<>(forward.cells()), new HashSet<>(reverse.cells()));
        assertEquals(forward.chunks(), reverse.chunks());
        assertThrows(UnsupportedOperationException.class, () -> forward.cells().clear());
        assertThrows(UnsupportedOperationException.class, () -> forward.chunks().clear());
    }

    @Test void exactVoxelSlabClippingHandlesGrazingInsideAndParallelMisses() {
        assertTrue(SightRay.intersects(p(-1, 1, 1), p(2, 1, 1), 0, 0, 0, 1, 1, 1));
        assertTrue(SightRay.intersects(p(.5, .5, .5), p(2, 2, 2), 0, 0, 0, 1, 1, 1));
        assertTrue(SightRay.intersects(p(2, 2, 2), p(1, 1, 1), 0, 0, 0, 1, 1, 1));
        assertFalse(SightRay.intersects(p(-1, 1.01, .5), p(2, 1.01, .5), 0, 0, 0, 1, 1, 1));
        assertFalse(SightRay.intersects(p(-2, .5, .5), p(-1, .5, .5), 0, 0, 0, 1, 1, 1));
    }
}
