package dev.residents.observer;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;

/**
 * Maps a presented bearer token to its consumer. Only SHA-256 digests are configured, so the
 * server's config never holds a usable credential. Every consumer is compared (no early exit)
 * in constant time so timing does not reveal which, if any, matched.
 */
public final class TokenAuth {

    private final List<ObserverConfig.ConsumerSpec> consumers;
    private final List<byte[]> digests;

    public TokenAuth(List<ObserverConfig.ConsumerSpec> consumers) {
        this.consumers = List.copyOf(consumers);
        this.digests = this.consumers.stream().map(c -> HexFormat.of().parseHex(c.tokenSha256())).toList();
    }

    /** The consumer for an {@code Authorization} header value, or {@code null}. */
    public ObserverConfig.ConsumerSpec authenticate(String authorizationHeader) {
        String token = bearer(authorizationHeader);
        if (token == null) {
            return null;
        }
        byte[] presented = sha256(token);
        ObserverConfig.ConsumerSpec match = null;
        for (int i = 0; i < consumers.size(); i++) {
            if (MessageDigest.isEqual(presented, digests.get(i)) && match == null) {
                match = consumers.get(i);
            }
        }
        return match;
    }

    /** The token in {@code Bearer <token>}, or {@code null} when absent/malformed. */
    static String bearer(String header) {
        if (header == null) {
            return null;
        }
        String h = header.strip();
        if (h.length() < 8 || !h.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return null;
        }
        String token = h.substring(7).strip();
        return token.isEmpty() || token.length() > 512 ? null : token;
    }

    public static String sha256Hex(String token) {
        return HexFormat.of().formatHex(sha256(token));
    }

    private static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
