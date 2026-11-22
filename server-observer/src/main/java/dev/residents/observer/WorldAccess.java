package dev.residents.observer;

/**
 * The only way the {@link Sampler} reaches the game. Every method is called on the server
 * thread, from the tick event, and must be read-only and non-loading. The Minecraft
 * implementation is {@link MinecraftWorldAccess}; tests use a stand-in.
 */
public interface WorldAccess {

    /** Overworld game time (monotonic ticks), used to timestamp observations. */
    long gameTime();

    /** The resident's body if that UUID is online now, else {@code null}. */
    Observations.Body readResident(ObserverConfig.ResidentSpec resident, long nowMs, long gameTime);

    /**
     * One read of a registered facility. Must return {@code UNLOADED} rather than load any chunk.
     * May throw; the sampler turns that into an {@code ERROR} view for this facility only.
     */
    Observations.Facility readFacility(ObserverConfig.FacilitySpec facility, long nowMs, long gameTime);
}
