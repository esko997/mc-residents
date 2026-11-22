package dev.residents.observer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EventLogTest {

    @Test
    void readersSeeNothingUntilPublished() {
        EventLog log = new EventLog(4);
        log.append("a", 1, 1, null, null, null);
        assertTrue(log.view().events().isEmpty());
        log.publish();
        assertEquals(1, log.view().events().size());
    }

    @Test
    void theRingDropsOldestAndReportsGapsToLateReaders() {
        EventLog log = new EventLog(3);
        for (int i = 0; i < 5; i++) {
            log.append("e" + i, i, i, null, null, null);
        }
        log.publish();
        EventLog.View v = log.view();
        assertEquals(3, v.events().size());
        assertEquals(3, v.oldestSeq());
        assertEquals(5, v.latestSeq());
        assertEquals(2, v.dropped());

        // A reader that had seen up to 1 missed seq 2: gap.
        EventLog.Page late = EventLog.page(v, 1, 100, e -> true);
        assertTrue(late.gap());
        assertEquals(3, late.events().get(0).seq());
        // A reader that had seen up to 2 missed nothing.
        assertFalse(EventLog.page(v, 2, 100, e -> true).gap());
        assertEquals(0, EventLog.page(v, 5, 100, e -> true).events().size());
    }

    @Test
    void pagesRespectLimitAndFilter() {
        EventLog log = new EventLog(10);
        for (int i = 0; i < 6; i++) {
            log.append("e", i, i, i % 2 == 0 ? "Gary" : "Margo", null, null);
        }
        log.publish();
        EventLog.Page page = EventLog.page(log.view(), 0, 2, e -> "Gary".equals(e.resident()));
        assertEquals(2, page.events().size());
        assertEquals(1, page.events().get(0).seq());
        assertEquals(3, page.events().get(1).seq());
        assertFalse(page.gap());
    }

    @Test
    void anEmptyLogHasNoGap() {
        EventLog log = new EventLog(4);
        assertFalse(EventLog.page(log.view(), 0, 10, e -> true).gap());
    }
}
