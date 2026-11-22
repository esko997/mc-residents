package dev.residents.observer;

import java.util.Locale;

/**
 * What one consumer credential may read. Every scope is read-only; there is no writing scope.
 *
 * <ul>
 *   <li>{@link #RESIDENTS}: bodies of every configured resident (operator / caretaker / Commons).</li>
 *   <li>{@link #FACILITIES}: registered facility stock (operator / caretaker / Commons).</li>
 *   <li>{@link #STATUS}: observer diagnostics ({@code /v1/status}).</li>
 *   <li>{@link #SELF}: only the bound resident's own body and events; never facilities or others.</li>
 * </ul>
 */
public enum Scope {
    RESIDENTS, FACILITIES, STATUS, SELF;

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
