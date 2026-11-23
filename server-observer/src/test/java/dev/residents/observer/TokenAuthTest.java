package dev.residents.observer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class TokenAuthTest {

    private final ObserverConfig config = Fixtures.config("");
    private final TokenAuth auth = new TokenAuth(config.consumers());

    @Test
    void eachTokenIdentifiesItsOwnConsumer() {
        assertEquals("commons", auth.authenticate("Bearer " + Fixtures.COMMONS_TOKEN).name());
        assertEquals("gary", auth.authenticate("Bearer " + Fixtures.GARY_TOKEN).name());
        assertEquals("ops", auth.authenticate("bearer  " + Fixtures.STATUS_TOKEN + " ").name());
    }

    @Test
    void anythingElseIsNobody() {
        assertNull(auth.authenticate(null));
        assertNull(auth.authenticate(""));
        assertNull(auth.authenticate("Bearer "));
        assertNull(auth.authenticate(Fixtures.COMMONS_TOKEN));
        assertNull(auth.authenticate("Basic " + Fixtures.COMMONS_TOKEN));
        assertNull(auth.authenticate("Bearer " + Fixtures.COMMONS_TOKEN + "x"));
        // The configured hash itself is not a credential.
        assertNull(auth.authenticate("Bearer " + TokenAuth.sha256Hex(Fixtures.COMMONS_TOKEN)));
    }
}
