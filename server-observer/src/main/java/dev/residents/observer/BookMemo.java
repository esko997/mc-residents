package dev.residents.observer;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;

import java.util.Map;
import java.util.WeakHashMap;

/**
 * The shelf scan's memory of books it has already selected: an item stack's {@link BridgeAccess.BookInfo}, valid
 * while the stack still holds the same tag objects for everything selection read (the tag, title, author,
 * generation, the pages list and each page). NBT values are replaced, not edited, when a book changes (StringTag
 * is immutable; a page edit puts a new element; the item of a stack is final), so identity is a complete check.
 *
 * <p>Bounded work: only successful selections are kept, and a success has at most {@code maxPages} pages, so a
 * check compares at most that many elements (a list whose size changed fails on the size alone). Failed or
 * oversized books are never kept: they are tried again, within the book limits. Kinds whose NBT selection never
 * reads (plain, enchanted, other items) keep no tag at all and are valid for the life of the stack.
 *
 * <p>Server thread only. Keys are held weakly (an item stack does not override equals/hashCode), so an entry goes
 * with its stack; at most {@link #MAX_ENTRIES}, beyond which the memo starts over.
 */
final class BookMemo {

    static final int MAX_ENTRIES = 32_768;

    private record Entry(boolean tagless, CompoundTag tag, Tag title, Tag author, Tag generation, Tag pages,
                         Tag[] pageTags, BridgeAccess.BookInfo info) {
    }

    private final Map<Object, Entry> entries = new WeakHashMap<>();
    private final int maxPages;

    BookMemo(int maxPages) {
        this.maxPages = maxPages;
    }

    /** The remembered BookInfo (at slot {@code slot}) if {@code stack} still holds {@code tag} as when selected, else null. */
    BridgeAccess.BookInfo get(Object stack, CompoundTag tag, int slot) {
        Entry e = entries.get(stack);
        if (e == null || !(e.tagless || matches(e, tag))) return null;
        BridgeAccess.BookInfo i = e.info;
        return i.slot() == slot ? i : new BridgeAccess.BookInfo(slot, i.kind(), i.item(), i.title(), i.author(),
                i.generation(), i.pageCount(), i.contentHash());
    }

    /** Remembers a successful selection; returns false (nothing kept) when the pages exceed the cap. */
    boolean put(Object stack, CompoundTag tag, BridgeAccess.BookInfo info) {
        boolean text = info.kind().equals("written") || info.kind().equals("writable");
        if (!text) return store(stack, new Entry(true, null, null, null, null, null, null, info));
        Tag pages = tag == null ? null : tag.get("pages");
        Tag[] each = new Tag[0];
        if (pages instanceof ListTag list) {
            if (list.size() > maxPages) return false;
            each = new Tag[list.size()];
            for (int i = 0; i < each.length; i++) each[i] = list.get(i);
        } else if (pages != null) {
            return false;
        }
        return store(stack, new Entry(false, tag, tag == null ? null : tag.get("title"), tag == null ? null : tag.get("author"),
                tag == null ? null : tag.get("generation"), pages, each, info));
    }

    int size() {
        return entries.size();
    }

    private boolean store(Object stack, Entry e) {
        if (entries.size() >= MAX_ENTRIES) entries.clear();
        entries.put(stack, e);
        return true;
    }

    private static boolean matches(Entry e, CompoundTag now) {
        if (now != e.tag) return false;
        if (now == null) return true;
        if (now.get("title") != e.title || now.get("author") != e.author || now.get("generation") != e.generation) return false;
        Tag p = now.get("pages");
        if (p != e.pages) return false;
        if (p instanceof ListTag list) {
            if (list.size() != e.pageTags.length) return false; // bounded: a kept list has at most maxPages elements
            for (int i = 0; i < e.pageTags.length; i++) if (list.get(i) != e.pageTags[i]) return false;
        }
        return true;
    }
}
