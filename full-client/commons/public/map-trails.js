// Display geometry only: four-block grid edges merge nearby routes within each
// resident's trail. Weight is sampling overlap, never an exact traversal count.
export function mergeMapTrail(points) {
  const grid = 4, edges = new Map();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (![...a, ...b].every(Number.isFinite)) continue;
    const elapsed = b[0] - a[0], distance = Math.hypot(b[1] - a[1], b[2] - a[2]);
    // Conservative gaps: don't invent routes through offline intervals, teleports
    // or widely thinned samples. At most 64 grid steps per accepted pair.
    if (elapsed <= 0 || elapsed > 60_000 || distance > 256 ||
        (distance > 64 && distance / Math.max(1, elapsed / 1000) > 12)) continue;
    let x = Math.round(a[1] / grid), z = Math.round(a[2] / grid);
    let endX = Math.round(b[1] / grid), endZ = Math.round(b[2] / grid);
    // Canonical direction makes the same line rasterize identically both ways.
    if (x > endX || (x === endX && z > endZ)) {
      [x, endX] = [endX, x]; [z, endZ] = [endZ, z];
    }
    const dx = Math.abs(endX - x), dz = Math.abs(endZ - z);
    const sx = x < endX ? 1 : -1, sz = z < endZ ? 1 : -1;
    let error = dx - dz;
    while (x !== endX || z !== endZ) {
      const fromX = x, fromZ = z, twice = error * 2;
      if (twice > -dz) { error -= dz; x += sx; }
      if (twice < dx) { error += dx; z += sz; }
      const key = `${fromX},${fromZ}:${x},${z}`;
      const edge = edges.get(key);
      if (edge) edge.weight = Math.min(16, edge.weight + 1);
      else edges.set(key, { x1: fromX * grid, z1: fromZ * grid, x2: x * grid, z2: z * grid, weight: 1 });
    }
  }
  return [...edges.values()].map(edge => ({ ...edge, width: Math.min(5, 1.5 + Math.log2(edge.weight)) }));
}
