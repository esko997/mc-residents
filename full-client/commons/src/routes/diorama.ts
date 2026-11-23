// Diorama panel: the blocks around one resident, read from its own client only while a
// dashboard asks (see diorama.ts), and the block colour table built from the modpack at deploy.
import { readBlockColours } from "../block-colours.ts";
import { DioramaCache, parseHave } from "../diorama.ts";
import { refuse, type Context, type Routes } from "./context.ts";

export function dioramaRoutes({ config, now, resident }: Context, cache = new DioramaCache(now)): Routes {
  return {
    async "GET diorama"({ query }) {
      const who = resident(query.get("resident"));
      if (!who) return refuse(404, "No resident by that name.");
      return { ...await cache.read(who, parseHave(query.get("have"))), host: config.hostName };
    },
    async "GET block-colours"() {
      return await readBlockColours(config.blockColours);
    },
  };
}
