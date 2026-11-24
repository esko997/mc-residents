// Library panel: every book in the catalogue, readable in full by the person at the dashboard. Hub only.
import { libraryBook, libraryList } from "../library-view.ts";
import { refuse, type Context, type Routes } from "./context.ts";

export function libraryRoutes({ db }: Context): Routes {
  return {
    async "GET library"() {
      return libraryList(db);
    },
    async "GET library-book"({ query }) {
      const id = Number(query.get("id"));
      const book = Number.isSafeInteger(id) && id > 0 ? libraryBook(db, id) : null;
      return book ?? refuse(404, "No such book in the catalogue.");
    },
  };
}
