package dev.residents.observer;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Pure selected-book validation; never uses Minecraft's component deserializer/resolver. */
final class BookText {
    static final int MAX_TITLE_CHARS = 128;
    static final int MAX_AUTHOR_CHARS = 64;
    private static final int MAX_JSON_DEPTH = 32;
    private static final int MAX_JSON_NODES = 4096;
    /** Vanilla book kinds and their exact item ids; every other item on a shelf or lectern is kind "other". */
    private static final java.util.Map<String, String> KINDS = java.util.Map.of("written", "minecraft:written_book",
            "writable", "minecraft:writable_book", "enchanted", "minecraft:enchanted_book", "plain", "minecraft:book");
    private static final Pattern ITEM_ID = Pattern.compile("^[a-z0-9_.-]+:[a-z0-9_./-]+$");
    private static final Set<String> STYLE_FIELDS = Set.of("bold", "italic", "underlined", "strikethrough",
            "obfuscated", "color", "font", "insertion", "clickEvent", "hoverEvent");

    record Limits(int pages, int pageChars, int totalChars) {
        Limits {
            if (pages < 1 || pages > 100 || pageChars < 1 || pageChars > 32767
                    || totalChars < 1 || totalChars > 262144) throw new IllegalArgumentException("book limits");
        }
    }

    record Selected(BridgeAccess.BookInfo info, List<String> pages) {
        Selected { pages = List.copyOf(pages); }
    }

    static final class Invalid extends Exception {
        private final String status;
        Invalid(String status, String reason) { super(reason); this.status = status; }
        String status() { return status; }
    }

    private BookText() { }

    /**
     * An item that is not a vanilla book (a knowledge book, a mod's guide book, an album): no metadata, no
     * pages. Its hash uses the item id in the title's place, so different items do not share one hash.
     */
    static Selected other(int slot, String item) throws Invalid {
        if (item == null || item.length() > MAX_TITLE_CHARS || !ITEM_ID.matcher(item).matches()) throw invalid("unknown item id");
        return new Selected(new BridgeAccess.BookInfo(slot, "other", item, null, null, null, 0,
                hash("other", item, null, null, List.of())), List.of());
    }

    static Selected select(int slot, String kind, String title, String author, Integer generation,
                           List<String> rawPages, Limits limits) throws Invalid {
        if (kind == null || !KINDS.containsKey(kind)) {
            throw invalid("unsupported book kind");
        }
        if (kind.equals("written")) {
            if (title == null || author == null || generation == null || generation < 0 || generation > 3) {
                throw invalid("written book requires title, author and generation 0..3");
            }
        } else if (title != null || author != null || generation != null) {
            throw invalid("only written books have selected title, author and generation");
        }
        checkString(title, MAX_TITLE_CHARS, "title");
        checkString(author, MAX_AUTHOR_CHARS, "author");
        if (rawPages == null) throw invalid("pages missing");
        if ((!kind.equals("written") && !kind.equals("writable")) && !rawPages.isEmpty()) {
            throw invalid("this book kind has no selected pages");
        }
        if (rawPages.size() > limits.pages) throw oversized("page count exceeds maxBookPages");
        int rawChars = length(title) + length(author);
        for (String page : rawPages) {
            if (page == null) throw invalid("page is not a string");
            checkString(page, limits.pageChars, "page");
            rawChars += page.length();
            if (rawChars > limits.totalChars) throw oversized("selected source exceeds maxBookChars");
        }
        if (rawChars > limits.totalChars) throw oversized("metadata exceeds maxBookChars");
        List<String> pages = new ArrayList<>(rawPages.size());
        int textChars = length(title) + length(author);
        for (String raw : rawPages) {
            String text = kind.equals("written") ? plainText(raw, limits.pageChars) : raw;
            textChars += text.length();
            if (textChars > limits.totalChars) throw oversized("selected text exceeds maxBookChars");
            pages.add(text);
        }
        String hash = hash(kind, title, author, generation, pages);
        return new Selected(new BridgeAccess.BookInfo(slot, kind, KINDS.get(kind), title, author, generation, pages.size(), hash), pages);
    }

    /**
     * Content hash v1: SHA-256 of length-prefixed UTF-8 strings (signed big-endian int byte length;
     * -1 for null), in order: "resident-book-v1", kind, title, author, generation as decimal/null,
     * then big-endian int page count and each plain-text page. Slot/facility, style/events, enchantment
     * details, filtered pages, resolved flags and every other NBT field are deliberately excluded.
     * Shelf and book use this same projection; this is NOT a hash of the original item/NBT.
     * Limits count UTF-16 code units and apply to BOTH selected source and decoded text, never truncate.
     */
    private static String hash(String kind, String title, String author, Integer generation, List<String> pages) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            field(digest, "resident-book-v1");
            field(digest, kind); field(digest, title); field(digest, author);
            field(digest, generation == null ? null : generation.toString());
            integer(digest, pages.size());
            for (String page : pages) field(digest, page);
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JDK lacks SHA-256", e);
        }
    }

    private static void field(MessageDigest digest, String value) {
        if (value == null) { integer(digest, -1); return; }
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        integer(digest, bytes.length);
        digest.update(bytes);
    }

    private static void integer(MessageDigest digest, int value) {
        digest.update((byte) (value >>> 24)); digest.update((byte) (value >>> 16));
        digest.update((byte) (value >>> 8)); digest.update((byte) value);
    }

    static String plainText(String json, int maxChars) throws Invalid {
        checkString(json, maxChars, "page");
        if (json == null) throw invalid("page is not a string");
        StringBuilder out = new StringBuilder(Math.min(json.length(), maxChars));
        try (JsonReader reader = new JsonReader(new StringReader(json))) {
            reader.setLenient(false);
            new TextReader(reader, out, maxChars).component(0);
            if (reader.peek() != JsonToken.END_DOCUMENT) throw invalid("trailing written-page JSON");
        } catch (IOException | IllegalStateException e) {
            throw invalid("invalid written-page JSON");
        }
        String text = out.toString();
        checkString(text, maxChars, "plain-text page");
        return text;
    }

    private static final class TextReader {
        private final JsonReader reader;
        private final StringBuilder out;
        private final int maxChars;
        private int nodes;

        TextReader(JsonReader reader, StringBuilder out, int maxChars) {
            this.reader = reader; this.out = out; this.maxChars = maxChars;
        }

        void component(int depth) throws IOException, Invalid {
            if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) throw invalid("written-page JSON complexity limit");
            switch (reader.peek()) {
                case STRING -> append(reader.nextString());
                case BEGIN_ARRAY -> {
                    reader.beginArray();
                    if (!reader.hasNext()) throw invalid("empty component array");
                    while (reader.hasNext()) component(depth + 1);
                    reader.endArray();
                }
                case BEGIN_OBJECT -> {
                    reader.beginObject();
                    boolean text = false, extra = false;
                    // Field order must not affect text or hash: extras always follow the main text.
                    String main = null;
                    int extrasStart = out.length();
                    while (reader.hasNext()) {
                        String key = reader.nextName();
                        switch (key) {
                            case "text" -> {
                                if (text || reader.peek() != JsonToken.STRING) throw invalid("invalid text component");
                                text = true;
                                main = reader.nextString();
                            }
                            case "extra" -> {
                                if (extra || reader.peek() != JsonToken.BEGIN_ARRAY) throw invalid("invalid extra components");
                                extra = true;
                                reader.beginArray();
                                if (!reader.hasNext()) throw invalid("empty extra components");
                                while (reader.hasNext()) component(depth + 1);
                                reader.endArray();
                            }
                            default -> {
                                // In particular selector, score, nbt, translate and keybind fail closed.
                                // Styling and event payloads are ignored, never interpreted or exposed.
                                if (!STYLE_FIELDS.contains(key)) throw invalid("unsupported written-page component: " + key);
                                skip(depth + 1);
                            }
                        }
                    }
                    reader.endObject();
                    if (!text) throw invalid("written-page object has no literal text");
                    if (main.length() > maxChars - out.length()) throw oversized("plain-text page exceeds maxBookPageChars");
                    out.insert(extrasStart, main);
                }
                default -> throw invalid("written-page component is not literal text");
            }
        }

        private void skip(int depth) throws IOException, Invalid {
            if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) throw invalid("written-page JSON complexity limit");
            switch (reader.peek()) {
                case BEGIN_OBJECT -> {
                    reader.beginObject();
                    while (reader.hasNext()) { reader.nextName(); skip(depth + 1); }
                    reader.endObject();
                }
                case BEGIN_ARRAY -> {
                    reader.beginArray();
                    while (reader.hasNext()) skip(depth + 1);
                    reader.endArray();
                }
                default -> reader.skipValue();
            }
        }

        private void append(String text) throws Invalid {
            if (text.length() > maxChars - out.length()) throw oversized("plain-text page exceeds maxBookPageChars");
            out.append(text);
        }
    }

    static void checkString(String value, int limit, String field) throws Invalid {
        if (value == null) return;
        if (value.length() > limit) throw oversized(field + " exceeds character limit " + limit);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i))) throw invalid(field + " has invalid Unicode");
            } else if (Character.isLowSurrogate(c)) throw invalid(field + " has invalid Unicode");
        }
    }

    private static int length(String value) { return value == null ? 0 : value.length(); }
    static Invalid invalid(String reason) { return new Invalid("invalid", reason); }
    static Invalid oversized(String reason) { return new Invalid("too_large", reason); }
}
