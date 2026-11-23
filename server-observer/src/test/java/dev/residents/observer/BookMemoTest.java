package dev.residents.observer;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The real scan memo over real NBT objects (the item stack is only an identity key, so a plain object stands in). */
class BookMemoTest {

    private static final BridgeAccess.BookInfo WRITTEN =
            new BridgeAccess.BookInfo(2, "written", "minecraft:written_book", "Bread", "Wren", 0, 2, "hash");

    private static CompoundTag book(int pages) {
        CompoundTag tag = new CompoundTag();
        tag.put("title", StringTag.valueOf("Bread"));
        tag.put("author", StringTag.valueOf("Wren"));
        tag.put("generation", IntTag.valueOf(0));
        ListTag list = new ListTag();
        for (int i = 0; i < pages; i++) list.add(StringTag.valueOf("{\"text\":\"page " + i + "\"}"));
        tag.put("pages", list);
        return tag;
    }

    @Test
    void anUnchangedBookIsRememberedAndAnyChangeToWhatWasReadForgetsIt() {
        BookMemo memo = new BookMemo(100);
        Object stack = new Object();
        CompoundTag tag = book(2);
        assertTrue(memo.put(stack, tag, WRITTEN));
        BridgeAccess.BookInfo moved = memo.get(stack, tag, 5);
        assertNotNull(moved);
        assertEquals(5, moved.slot(), "a stack moved to another slot keeps its book, reported at the new slot");
        assertNull(memo.get(new Object(), tag, 2), "another stack is another book");
        assertNull(memo.get(stack, book(2), 2), "an equal but different tag object is not trusted");

        ((ListTag) tag.get("pages")).set(1, StringTag.valueOf("{\"text\":\"edited\"}"));
        assertNull(memo.get(stack, tag, 2), "a replaced page");

        CompoundTag retitled = book(2);
        memo.put(stack, retitled, WRITTEN);
        retitled.put("title", StringTag.valueOf("Rye"));
        assertNull(memo.get(stack, retitled, 2), "a replaced title");

        CompoundTag longer = book(2);
        memo.put(stack, longer, WRITTEN);
        ((ListTag) longer.get("pages")).add(StringTag.valueOf("{\"text\":\"more\"}"));
        assertNull(memo.get(stack, longer, 2), "a page added");
    }

    @Test
    void fingerprintWorkIsBoundedByThePageCap() {
        BookMemo memo = new BookMemo(100);
        Object stack = new Object();
        CompoundTag huge = book(200_000); // far beyond the cap, as a mod item or a hand-made tag could be
        assertFalse(memo.put(stack, huge, WRITTEN), "nothing is kept for a page list over the cap");
        assertNull(memo.get(stack, huge, 2));
        assertEquals(0, memo.size());

        CompoundTag odd = new CompoundTag();
        odd.put("pages", StringTag.valueOf("not a list"));
        assertFalse(memo.put(stack, odd, WRITTEN), "pages that are not a list are not fingerprinted either");
    }

    @Test
    void kindsWhoseNbtIsNeverReadKeepNoTagAtAll() {
        BookMemo memo = new BookMemo(100);
        Object guide = new Object();
        CompoundTag modData = book(200_000); // a guide book's own data: never selected, never compared
        BridgeAccess.BookInfo other = new BridgeAccess.BookInfo(0, "other", "patchouli:guide_book", null, null, null, 0, "h");
        assertTrue(memo.put(guide, modData, other));
        modData.put("anything", StringTag.valueOf("changed"));
        assertNotNull(memo.get(guide, modData, 0), "valid for the life of the stack (its item is final)");
        assertNotNull(memo.get(guide, null, 0));
    }
}
