package dev.residents.observer;

import java.util.Locale;

/**
 * What one consumer credential may do. Every scope except {@link #WATCH} only reads; {@link #WATCH}
 * replaces the bridge's in-memory watch list, never the world.
 *
 * <ul>
 *   <li>{@link #RESIDENTS}: bodies of every watched resident (operator / caretaker / Commons).</li>
 *   <li>{@link #FACILITIES}: watched facility stock and any position's block read (operator / caretaker / Commons).</li>
 *   <li>{@link #LIBRARY}: shelves and lecterns anywhere, their book metadata and bounded book text.</li>
 *   <li>{@link #STATUS}: observer diagnostics ({@code /v1/status}) and the watch list ({@code GET /v1/watch}).</li>
 *   <li>{@link #WATCH}: push the watch list ({@code PUT /v1/watch}); Commons only.</li>
 *   <li>{@link #SELF}: only the bound resident's own body and events; never facilities or others.</li>
 * </ul>
 */
public enum Scope {
    RESIDENTS, FACILITIES, LIBRARY, STATUS, WATCH, SELF;

    public String id() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static Scope byId(String id) {
        for (Scope s : values()) {
            if (s.id().equals(id)) {
                return s;
            }
        }
        return null;
    }
}
