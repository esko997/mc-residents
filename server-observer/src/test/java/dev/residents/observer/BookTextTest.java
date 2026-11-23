package dev.residents.observer;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class BookTextTest {
    private static final BookText.Limits LIMITS = new BookText.Limits(100, 8192, 65536);

    private static BookText.Selected written(int slot, String... pages) throws BookText.Invalid {
        return BookText.select(slot, "written", "Title", "Author", 0, List.of(pages), LIMITS);
    }

    @Test void literalTextArraysExtrasAndEscapesBecomePlainTextWithoutResolution() throws Exception {
        assertEquals("Hello world\n!", written(0,
                "[{\"text\":\"Hello\",\"extra\":[{\"text\":\" world\"}]},\"\\n!\"]").pages().get(0));
        assertEquals("base extra", written(0,
                "{\"extra\":[{\"text\":\" extra\"}],\"text\":\"base\"}").pages().get(0));
        assertEquals("emoji 😀", written(0, "\"emoji \\ud83d\\ude00\"").pages().get(0));
    }

    @Test void formattingEventsAndJsonFieldOrderDoNotAffectCanonicalHash() throws Exception {
        BookText.Selected one = written(0, "{\"text\":\"base\",\"extra\":[{\"text\":\" extra\"}]}");
        BookText.Selected two = written(5, "{\"extra\":[{\"bold\":true,\"text\":\" extra\"}],"
                + "\"clickEvent\":{\"action\":\"run_command\",\"value\":\"/op nobody\"},"
                + "\"hoverEvent\":{\"action\":\"show_text\",\"contents\":{\"selector\":\"@a\"}},\"text\":\"base\"}");
        assertEquals(one.info().contentHash(), two.info().contentHash());
        assertEquals(List.of("base extra"), two.pages());
        assertEquals(5, two.info().slot());
    }

    @Test void hashHasDocumentedVersionedLengthPrefixedUtf8Representation() throws Exception {
        BookText.Selected selected = written(2, "\"héllo\"");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            for (String field : List.of("resident-book-v1", "written", "Title", "Author", "0")) {
                byte[] utf8 = field.getBytes(StandardCharsets.UTF_8);
                out.writeInt(utf8.length); out.write(utf8);
            }
            out.writeInt(1);
            byte[] utf8 = "héllo".getBytes(StandardCharsets.UTF_8);
            out.writeInt(utf8.length); out.write(utf8);
        }
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())),
                selected.info().contentHash());
        assertEquals(64, selected.info().contentHash().length());
    }

    @Test void hashChangesForSelectedMetadataAndPageBoundariesButNotSlot() throws Exception {
        String hash = written(0, "\"one\"").info().contentHash();
        assertEquals(hash, written(5, "\"one\"").info().contentHash());
        assertNotEquals(hash, written(0, "\"two\"").info().contentHash());
        assertNotEquals(hash, BookText.select(0, "written", "Other", "Author", 0, List.of("\"one\""), LIMITS).info().contentHash());
        assertNotEquals(hash, BookText.select(0, "written", "Title", "Other", 0, List.of("\"one\""), LIMITS).info().contentHash());
        assertNotEquals(hash, BookText.select(0, "written", "Title", "Author", 1, List.of("\"one\""), LIMITS).info().contentHash());
        assertNotEquals(written(0, "\"ab\"", "\"c\"").info().contentHash(),
                written(0, "\"a\"", "\"bc\"").info().contentHash());
    }

    @Test void dynamicComponentsAreInvalidRatherThanResolvedOrSilentlyOmitted() {
        for (String json : List.of("{\"selector\":\"@a\"}", "{\"text\":\"x\",\"nbt\":\"Inventory\",\"entity\":\"@s\"}",
                "{\"translate\":\"chat.type.text\",\"with\":[\"a\",\"b\"]}", "{\"score\":{\"name\":\"x\",\"objective\":\"secret\"}}",
                "{\"keybind\":\"key.forward\"}", "{\"text\":\"ok\",\"extra\":[{\"selector\":\"@a\"}]}")) {
            assertEquals("invalid", assertThrows(BookText.Invalid.class, () -> written(0, json)).status());
        }
    }

    @Test void malformedJsonTypesDuplicateTextAndUnpairedUnicodeFailClosed() {
        for (String json : List.of("not json", "{text:'x'}", "{}", "[]", "null", "true", "123", "\"x\" trailing",
                "{\"text\":12}", "{\"text\":\"a\",\"text\":\"b\"}", "{\"text\":\"a\",\"extra\":[]}",
                "{\"text\":\"\\ud800\"}", "[\"x\",]")) {
            assertEquals("invalid", assertThrows(BookText.Invalid.class, () -> written(0, json)).status());
        }
        assertThrows(BookText.Invalid.class, () -> BookText.select(0, "writable", null, null, null, List.of("\ud800"), LIMITS));
    }

    @Test void strictSourcePageCountCharacterAndAggregateLimitsNeverTruncate() throws Exception {
        BookText.Limits small = new BookText.Limits(2, 4, 6);
        BookText.Selected exact = BookText.select(0, "writable", null, null, null, List.of("abcd", "ef"), small);
        assertEquals(List.of("abcd", "ef"), exact.pages());
        assertEquals(2, exact.info().pageCount());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "writable", null, null, null, List.of("abcde"), small)).status());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "writable", null, null, null, List.of("abcd", "efg"), small)).status());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "writable", null, null, null, List.of("a", "b", "c"), small)).status());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "written", "T", "A", 0, List.of("{\"text\":\"x\"}"), small)).status());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "written", "Title", "Author", 0, List.of(), new BookText.Limits(1, 10, 10))).status());
    }

    @Test void oversizedOrInvalidMetadataIsRejected() {
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "written", "x".repeat(129), "A", 0, List.of(), LIMITS)).status());
        assertEquals("too_large", assertThrows(BookText.Invalid.class,
                () -> BookText.select(0, "written", "T", "x".repeat(65), 0, List.of(), LIMITS)).status());
        assertThrows(BookText.Invalid.class, () -> BookText.select(0, "written", "T", "A", 4, List.of(), LIMITS));
        assertThrows(BookText.Invalid.class, () -> BookText.select(0, "written", null, "A", 0, List.of(), LIMITS));
        assertThrows(BookText.Invalid.class, () -> BookText.select(0, "writable", "T", null, null, List.of(), LIMITS));
        assertThrows(IllegalArgumentException.class, () -> new BookText.Limits(101, 8192, 65536));
        assertThrows(IllegalArgumentException.class, () -> new BookText.Limits(100, 32768, 65536));
        assertThrows(IllegalArgumentException.class, () -> new BookText.Limits(100, 8192, 262145));
    }

    @Test void jsonComplexityIsBoundedIncludingIgnoredEventPayloads() {
        String nested = "[".repeat(40) + "\"x\"" + "]".repeat(40);
        assertThrows(BookText.Invalid.class, () -> written(0, nested));
        assertThrows(BookText.Invalid.class, () -> written(0, "{\"text\":\"x\",\"hoverEvent\":" + nested + "}"));
    }

    @Test void writableTextIsNotJsonInterpretedAndPlainEnchantedHaveNoSelectedNbt() throws Exception {
        String raw = "{\"selector\":\"@a\"}";
        BookText.Selected writable = BookText.select(0, "writable", null, null, null, List.of(raw), LIMITS);
        assertEquals(List.of(raw), writable.pages());
        for (String kind : List.of("plain", "enchanted")) {
            BookText.Selected book = BookText.select(0, kind, null, null, null, List.of(), LIMITS);
            assertEquals(0, book.info().pageCount());
            assertNull(book.info().title());
            assertNull(book.info().author());
            assertNull(book.info().generation());
            assertTrue(book.pages().isEmpty());
            assertThrows(BookText.Invalid.class, () -> BookText.select(0, kind, null, null, null, List.of("hidden"), LIMITS));
        }
    }

    @Test void selectedPagesAreImmutableAndDetachedFromInputList() throws Exception {
        List<String> input = new ArrayList<>(List.of("original"));
        BookText.Selected selected = BookText.select(0, "writable", null, null, null, input, LIMITS);
        input.set(0, "changed");
        assertEquals(List.of("original"), selected.pages());
        assertThrows(UnsupportedOperationException.class, () -> selected.pages().clear());
    }
}
