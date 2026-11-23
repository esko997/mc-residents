import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { CommonsClient } from "../src/commons.ts";
import { Events } from "../src/events.ts";
import { fixture } from "./fake-synapse.ts";
import { residentHub } from "../../commons/test/resident-api-fixture.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const text = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

test("real hub shared tools are attributed; missing hub never disables the body", async () => {
  const hub = residentHub();
  const identity = hub.identity();
  const f = await fixture(identity);
  try {
    const saved = await f.tools.call("place_save", { name: "landing", shared: true });
    expect(saved.isError).toBe(false);
    expect(hub.db.query("SELECT author FROM shared_places WHERE name='landing'").get()).toEqual({ author: "Gary" });
    f.tools.close();
    // The closed listener refuses immediately; mutations are not replayed to another store.
    hub.disconnect();
    const missing = await f.tools.call("notes_shared", {});
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("hub unreachable");
    expect((await f.tools.call("look", { yaw: 90 })).isError).toBe(false);
    expect(f.requests.some(r => r.body.action === "look")).toBe(true);
  } finally { f.tools.close(); hub.close(); }
});

test("poller feeds only addressed events; collaboration does not become a waking type", async () => {
  const hub = residentHub(), identity = hub.identity(), events = new Events();
  let resolve!: () => void;
  const received = new Promise<void>(done => { resolve = done; });
  const unsubscribe = events.subscribe(event => { if (event.type === "collaboration") resolve(); });
  const stop = identity.client.poll(events);
  try {
    // Real HTTP delivery and the Events platform-clock deadline are the integration under test.
    const waiting = events.wait(0.1);
    hub.api.events.publish("Margo", "collaboration", { from: "Gary", id: 1 });
    hub.api.events.publish("Gary", "collaboration", { from: "Margo", id: 2 });
    await received;
    expect(events.since(0).join("\n")).toContain("id=2");
    expect(events.since(0).join("\n")).not.toContain("id=1");
    expect(await waiting).toContain("Time is up");
  } finally { unsubscribe(); stop(); hub.close(); }
});

test("token files are exact bytes, errors never disclose their contents", async () => {
  const hub = residentHub(), identity = hub.identity();
  try {
    writeFileSync(identity.commonsTokenFile, `${identity.token}\n`);
    await expect(new CommonsClient(identity.commonsUrl, identity.commonsTokenFile).call("places", "list", {})).rejects.toThrow("without a newline");
  } finally { hub.close(); }
});
