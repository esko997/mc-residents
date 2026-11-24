// Library panel: every book in the residents' catalogue, read in full here (api/library, api/library-book).
// Residents read a book only at its shelf; this page is for the people watching them.
const KEY = "commons.library";
const GENERATIONS = ["original", "copy of original", "copy of a copy", "tattered"];
const where = place => `the ${place.holder} at ${place.x}, ${place.y}, ${place.z}${place.holder === "chiseled bookshelf" && place.slot !== null ? ` (slot ${place.slot + 1} of 6)` : ""}${place.dimension === "minecraft:overworld" ? "" : ` in ${place.dimension.replace(/^minecraft:/, "").replace(/_/g, " ")}`}${place.near ? `, by ${place.near}` : ""}`;

export function createLibraryView(root, { html, setHtml, get, stamp, ago, colour }) {
  const find = selector => root.querySelector(selector);
  const view = { list: null, book: null, problem: "", query: "", selected: Number(localStorage.getItem(KEY)) || null, asked: 0 };
  const title = book => book.kind === "written" ? book.title : "Unsigned book and quill";
  const byline = book => book.kind === "written" ? html`by <b style="color:${colour(book.author)}">${book.author}</b>` : html`<span class="meta">a draft, not yet signed</span>`;
  const matches = book => {
    const words = view.query.toLowerCase().split(/\s+/).filter(Boolean);
    const text = [book.title, book.author, ...book.subjects, book.note].join(" ").toLowerCase();
    return words.every(word => text.includes(word));
  };

  function renderList() {
    const list = view.list;
    if (!list) { setHtml(find("#library-list"), html`<p class="empty">${view.problem || "Reading the catalogue…"}</p>`); return; }
    const shown = list.books.filter(matches);
    find("#library-count").textContent = list.total === 0 ? "" : view.query ? `${shown.length} of ${list.total}` : `${list.total} ${list.total === 1 ? "book" : "books"}`;
    setHtml(find("#library-list"), list.total === 0
      ? html`<p class="empty">No books yet. A book appears here once it stands on a chiseled bookshelf or lectern (the server sees it within a minute or two), or once a resident describes it with book_register.</p>`
      : shown.length === 0 ? html`<p class="empty">No book matches "${view.query}".</p>`
      : html`<ul class="library-books">${shown.map(book => html`<li><button type="button" data-book="${book.id}" aria-pressed="${String(book.id === view.selected)}">
          <span class="library-title">${title(book)}</span>
          <span class="meta">${book.kind === "written" ? book.author : "draft"} · ${book.pageCount} ${book.pageCount === 1 ? "page" : "pages"}${book.standing.length ? "" : " · no copy on a shelf now"}</span>
        </button></li>`)}</ul>`);
  }

  function renderBook() {
    const reader = find("#library-reader"), book = view.book;
    if (!view.selected) { setHtml(reader, html`<p class="empty">Choose a book to read it.</p>`); return; }
    if (!book || book.id !== view.selected) { setHtml(reader, html`<p class="empty">${view.problem || "Opening the book…"}</p>`); return; }
    const pages = book.pages;
    setHtml(reader, html`<article class="library-book" aria-labelledby="library-book-title">
      <header>
        <h2 id="library-book-title">${title(book)}</h2>
        <p>${byline(book)}${book.kind === "written" ? html` <span class="meta">· ${GENERATIONS[book.generation ?? 0] ?? "copy"}</span>` : ""}
          <span class="meta">· ${book.pageCount} ${book.pageCount === 1 ? "page" : "pages"} · first seen ${stamp(book.firstSeen)}</span></p>
        ${book.subjects.length || book.note ? html`<p class="meta">${book.subjects.length ? html`Subjects: ${book.subjects.join(", ")}. ` : ""}${book.note ? html`Note${book.describedBy ? html` from ${book.describedBy}` : ""}: ${book.note}` : ""}</p>` : ""}
        <p class="meta">${book.standing.length
          ? html`On ${book.standing.map((place, index) => html`${index ? "; " : ""}${where(place)}${place.seenBy === "server" ? "" : html` (${place.seenBy} says so)`}`)}.`
          : book.lastGone ? html`No copy stands anywhere now. It was last on ${where(book.lastGone)} until ${stamp(book.lastGone.goneAt)}.` : "No copy stands on a shelf or lectern now."}</p>
      </header>
      ${pages ? html`<ol class="library-pages">${pages.map((page, index) => html`<li><span class="meta">Page ${index + 1} of ${pages.length}</span><div class="library-page">${page || html`<span class="meta">(blank page)</span>`}</div></li>`)}</ol>`
        : html`<p class="warn">${book.pagesProblem}</p>`}
      ${book.history.length ? html`<details data-d="library-history:${book.id}"><summary>History</summary><ul class="places">${book.history.map(row =>
        html`<li><span class="meta">${stamp(row.at)} (${ago(row.at)})</span> ${row.observer === "server" ? "the server" : row.observer}: ${row.kind.replace(/_/g, " ")}${row.note ? html` — ${row.note}` : ""}</li>`)}</ul></details>` : ""}
    </article>`);
  }

  async function openBook(id) {
    view.selected = id; view.problem = "";
    localStorage.setItem(KEY, String(id));
    renderList(); renderBook();
    const asked = ++view.asked;
    try {
      const book = await get(`api/library-book?id=${id}`);
      if (asked === view.asked) view.book = book;
    } catch (error) {
      if (asked === view.asked) { view.book = null; view.problem = error.message; }
    }
    if (asked === view.asked) renderBook();
  }

  find("#library-list").addEventListener("click", event => {
    const id = Number(event.target.closest("button[data-book]")?.dataset.book);
    if (id) { void openBook(id); find("#library-reader").scrollIntoView({ block: "start", behavior: "smooth" }); }
  });
  find("#library-search").addEventListener("input", event => { view.query = event.target.value.trim(); renderList(); });

  return {
    async load() {
      try { view.list = await get("api/library"); view.problem = ""; }
      catch (error) { view.problem = error.message; renderList(); throw error; }
      if (view.selected && !view.list.books.some(book => book.id === view.selected)) {
        // A book read again under a newer edition keeps its place in the list by text; the old id may be gone.
        view.selected = null; view.book = null; localStorage.removeItem(KEY);
      }
      if (!view.selected && view.list.books.length) view.selected = (view.list.books.find(book => book.kind === "written") ?? view.list.books[0]).id;
      renderList();
      if (view.selected && view.book?.id !== view.selected) await openBook(view.selected);
      else if (view.selected) {
        const fresh = await get(`api/library-book?id=${view.selected}`).catch(() => null);
        if (fresh) { view.book = fresh; renderBook(); }
      } else renderBook();
    },
  };
}
