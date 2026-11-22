package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ItemTallyTest {

    @Test
    void stacksOfTheSameItemAddUpAndNbtIsOnlyCounted() {
        ItemTally t = new ItemTally(8);
        t.add("minecraft:cobblestone", 64, false);
        t.add("minecraft:cobblestone", 10, false);
        t.add("minecraft:written_book", 1, true);
        t.add("minecraft:written_book", 1, true);
        t.add("minecraft:air", 0, false);
        assertEquals(4, t.usedSlots());
        assertEquals(List.of(new Observations.ItemCount("minecraft:cobblestone", 74, 0),
                new Observations.ItemCount("minecraft:written_book", 2, 2)), t.items());
        assertFalse(t.truncated());
    }

    @Test
    void tooManyKindsAreCutAndSaidSo() {
        ItemTally t = new ItemTally(2);
        t.add("a:a", 1, false);
        t.add("b:b", 1, false);
        t.add("c:c", 5, false);
        t.add("a:a", 1, false);
        assertEquals(2, t.items().size());
        assertEquals(2, t.items().get(0).count());
        assertTrue(t.truncated());
        assertEquals(4, t.usedSlots(), "slots are still counted when their kind is cut");
    }
}
