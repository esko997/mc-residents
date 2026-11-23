package dev.residents.observer;

import java.util.List;

/** Tick-thread-only bridge. Returned values contain no live game objects. */
public interface BridgeAccess {
    Sight sight(ObserverConfig.ResidentSpec from, ObserverConfig.ResidentSpec to);
    Shelf shelf(ObserverConfig.FacilitySpec facility);
    BookResult book(ObserverConfig.FacilitySpec facility, int slot);

    record Sight(Boolean visible, Double distance, String reason) { }

    record BookInfo(int slot, String kind, String title, String author, Integer generation,
                    int pageCount, String contentHash) { }

    record Shelf(String facility, String status, String reason, List<BookInfo> slots) {
        public Shelf {
            slots = List.copyOf(slots);
        }
    }

    record BookResult(String facility, String status, String reason, BookInfo book, List<String> pages) {
        public BookResult {
            pages = List.copyOf(pages);
        }
    }
}
