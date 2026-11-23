package dev.residents.observer;

/**
 * The only way the {@link Sampler}'s own reads reach the game. Every method is called on the server
 * thread, from the tick event, and must be read-only and non-loading. The Minecraft
 * implementation is {@link MinecraftWorldAccess}; tests use a stand-in.
 */
public interface WorldAccess {

    /** Overworld game time (monotonic ticks), used to timestamp observations. */
    long gameTime();

    /** The resident's body if that UUID is online now, else {@code null}. */
    Observations.Body readResident(WatchList.ResidentSpec resident, long nowMs, long gameTime);

    /**
     * One capability read of the block entity at a position (a watched facility, or {@code GET /v1/block}).
     * Must return {@code UNLOADED} rather than load any chunk. May throw; the caller turns that into an
     * {@code ERROR} result for this position only.
     */
    Observations.BlockRead read(String dimension, int x, int y, int z, String side);
}
