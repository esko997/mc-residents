import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, renameSync } from "node:fs";
import { createApp, type App, type Replies } from "../src/app.ts";
import { classify, clockTime, Console, ConsoleFeed, gameNoise, parseClientChat, parseServerLine, plain, serverNoise } from "../src/console.ts";
import { clientLogLine, fakePhoneChat, fixture, serverLogLine, tempHome, type FakePhoneChat, type Home } from "./helpers.ts";

const T = Date.parse("2026-11-21T16:11:23.456Z");
let home: Home, fakes: FakePhoneChat[], clock: number, app: App | undefined;
beforeEach(() => { home = tempHome(); fakes = []; clock = T + 60_000; });
afterEach(() => { app?.stop(); app = undefined; for (const fake of fakes) fake.stop(); home.remove(); });

/** Log lines stamped `ms` after T. */
const serverLine = (ms: number, message: string, level?: string, logger?: string, thread?: string) => serverLogLine(T + ms, message, level, logger, thread);
const clientLine = (ms: number, message: string) => clientLogLine(T + ms, message);
const texts = (stream: Console, after = 0) => stream.since(after).lines.map(line => line.text);
const phoneChat = () => { const fake = fakePhoneChat(); fakes.push(fake); return fake; };

test("a server log line gives its time (the stamp is UTC), level, logger and message", () => {
  expect(parseServerLine("[21Nov2026 16:11:23.456] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: <Gary> hello")).toEqual({
    t: Date.UTC(2026, 10, 21, 16, 11, 23, 456), thread: "Server thread", level: "INFO", logger: "net.minecraft.server.MinecraftServer/", message: "<Gary> hello",
  });
  expect(parseServerLine("[01Jan2027 00:00:00.001] [Netty Server IO #1/WARN] [net.minecraft.server.network.ServerGamePacketListenerImpl/]: Gary moved too quickly! 12.1,0.0,3.4"))
    .toMatchObject({ t: Date.UTC(2027, 0, 1, 0, 0, 0, 1), thread: "Netty Server IO #1", level: "WARN", message: "Gary moved too quickly! 12.1,0.0,3.4" });
  expect(parseServerLine("\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:812)")).toBeNull();
  expect(parseServerLine("[16:11:23] [Render thread/INFO]: [CHAT] <Gary> hello")).toBeNull();
});

test("a client log gives what was shown in chat, and nothing that merely mentions [CHAT]", () => {
  const found = fixture("client-chat.log").split("\n").map(parseClientChat).filter(line => line !== null);
  // The four mixin debug lines at the top of the sample contain "[CHAT]" and are not chat.
  expect(found.slice(0, 3)).toEqual([
    { hours: 10, minutes: 15, seconds: 37, message: expect.stringMatching(/^\[SecurityCraft\] Thanks for using SecurityCraft v1\.10\.1! Tip: /) },
    { hours: 10, minutes: 15, seconds: 37, message: "Margo joined the game" },
    { hours: 10, minutes: 15, seconds: 59, message: "[Baritone] > goto 112 119 -205" },
  ]);
  expect(found.length).toBe(18);
  expect(parseClientChat("[16:11:23] [Render thread/INFO]: [CHAT] <Gary> hello")?.message).toBe("<Gary> hello");
  expect(parseClientChat("[16:11:23] [Render thread/INFO]: [Not Secure] [CHAT] <Gary> hello")?.message).toBe("<Gary> hello");
});

test("a client's clock time becomes the latest such moment not after the reference", () => {
  const reference = new Date(2026, 10, 21, 10, 30, 0).getTime();
  expect(clockTime(10, 15, 37, reference)).toBe(new Date(2026, 10, 21, 10, 15, 37).getTime());
  // Later on the clock than now: it was written yesterday evening.
  expect(clockTime(23, 50, 0, reference)).toBe(new Date(2026, 10, 20, 23, 50, 0).getTime());
  // A few seconds ahead is clock drift, not yesterday.
  expect(clockTime(10, 30, 20, reference)).toBe(new Date(2026, 10, 21, 10, 30, 20).getTime());
});

test("messages are sorted into chat, things that happened to players, and the rest", () => {
  const kinds = (messages: string[]) => messages.map(classify);
  expect(kinds([
    "<Gary> hello", "[Not Secure] <Margo> is anyone near the cabin?", "[Server] restarting in five minutes", "[Rcon] hello from the console",
    "* Gary waves", "<Caretaker> Gary: the stream is north", '> tellraw @a {"text":"<Caretaker> Gary: the stream is north"}',
  ])).toEqual(["chat", "chat", "chat", "chat", "chat", "chat", "chat"]);
  expect(kinds([
    "Gary joined the game", "Margo left the game", "Gary has made the advancement [Stone Age]", "Margo has completed the challenge [Arbalistic]",
    "Gary lost connection: Disconnected", "Gary[/192.168.1.50:51234] logged in with entity id 412 at (110.5, 120.0, -207.5)",
    "Gary was slain by Zombie", "Margo drowned", "Gary fell from a high place", "Margo tried to swim in lava", "Gary was blown up by Creeper", "Margo hit the ground too hard",
  ])).toEqual(Array(12).fill("players"));
  expect(kinds([
    "Done (12.345s)! For help, type \"help\"", "Saving the game (this may take a moment!)", "There are 2 of a max of 20 players online: Gary, Margo",
    "Gary was here", "Starting minecraft server version 1.20.1", "[SecurityCraft] Thanks for using SecurityCraft",
  ])).toEqual(Array(6).fill("other"));
});

test("server lines carry the kind the filters use, a tag when they are not plain server info, and trace lines stay with their record", () => {
  const stream = new Console(true);
  stream.addServer(serverLine(0, "[Not Secure] <Gary> hello"));
  stream.addServer(serverLine(100, "Margo joined the game"));
  stream.addServer(serverLine(200, "Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind", "WARN"));
  stream.addServer(serverLine(300, "Encountered an unexpected exception", "ERROR", "net.minecraft.server.dedicated.DedicatedServer/"));
  stream.addServer("java.lang.IllegalStateException: boom");
  stream.addServer("\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:812)");
  stream.addServer(serverLine(400, "Loaded 7 recipes", "INFO", "net.minecraft.world.item.crafting.RecipeManager/", "main"));
  stream.addServer("a line after an ordinary record");
  expect(stream.since().lines.map(line => ({ at: line.t - T, kind: line.kind, tag: line.tag, text: line.text, source: line.source }))).toEqual([
    { at: 0, kind: "chat", tag: undefined, text: "[Not Secure] <Gary> hello", source: "server" },
    { at: 100, kind: "players", tag: undefined, text: "Margo joined the game", source: "server" },
    { at: 200, kind: "warn", tag: "WARN", text: "Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind", source: "server" },
    { at: 300, kind: "warn", tag: "ERROR DedicatedServer", text: "Encountered an unexpected exception", source: "server" },
    { at: 300, kind: "warn", tag: undefined, text: "java.lang.IllegalStateException: boom", source: "server" },
    { at: 300, kind: "warn", tag: undefined, text: "\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:812)", source: "server" },
    { at: 400, kind: "other", tag: "RecipeManager", text: "Loaded 7 recipes", source: "server" },
    { at: 400, kind: "other", tag: undefined, text: "a line after an ordinary record", source: "server" },
  ]);
});

test("what a client showed is dropped when the server log has it, whichever arrives first", () => {
  const stream = new Console(true, { now: () => clock });
  stream.server = { state: "ok" };
  // Server first.
  stream.addServer(serverLine(0, "[Not Secure] <Gary> hello"));
  stream.addGame("Margo", T + 600, "<Gary> hello");
  // Client first: it waits for the server log to catch up.
  stream.addGame("Gary", T + 3000, "Margo joined the game");
  stream.flush();
  expect(texts(stream)).toEqual(["[Not Secure] <Gary> hello"]);
  stream.addServer(serverLine(3400, "Margo joined the game"));
  clock += 30_000;
  stream.flush();
  expect(stream.since().lines.map(line => `${line.source}: ${line.text}`)).toEqual(["server: [Not Secure] <Gary> hello", "server: Margo joined the game"]);
});

test("what only clients saw is kept, marked seen in game, once the server log has had its chance", () => {
  const stream = new Console(true, { now: () => clock });
  stream.server = { state: "ok" };
  stream.addServer(serverLine(0, "Gary joined the game"));
  // An announcement sent with tellraw: the server does not log it.
  stream.addGame("Gary", T + 2000, "Server restarts at 18:00 for a backup");
  stream.flush();
  expect(texts(stream)).toEqual(["Gary joined the game"]);
  clock += 5000;
  stream.flush();
  const [, seen] = stream.since().lines;
  expect(seen).toMatchObject({ source: "game", kind: "chat", text: "Server restarts at 18:00 for a backup", seenBy: ["Gary"], t: T + 2000 });

  // The other resident's client showed the same line: one line, two witnesses, and readers are told it changed.
  const before = stream.since().rev;
  stream.addGame("Margo", T + 2400, "Server restarts at 18:00 for a backup");
  clock += 5000;
  stream.flush();
  expect(stream.since().lines.length).toBe(2);
  expect(stream.since(before).lines).toMatchObject([{ id: seen.id, seenBy: ["Gary", "Margo"] }]);
  // The same words an hour later are another message.
  stream.addGame("Gary", T + 3_600_000, "Server restarts at 18:00 for a backup");
  clock += 5000;
  stream.flush();
  expect(stream.since().lines.length).toBe(3);
  // A death as a player sees it, which this server did not log.
  stream.addGame("Margo", T + 3_700_000, "Margo was slain by Zombie");
  clock += 5000;
  stream.flush();
  expect(stream.since().lines.at(-1)).toMatchObject({ kind: "players", source: "game", seenBy: ["Margo"] });
});

test("a client line already shown is withdrawn when the server log turns out to have it", () => {
  const stream = new Console(true, { now: () => clock });
  // The server machine could not be reached, so nothing was held back.
  stream.server = { state: "unreachable", detail: "no answer" };
  stream.addGame("Gary", T + 1000, "Margo joined the game");
  stream.addGame("Gary", T + 2000, "<Margo> hello");
  stream.flush();
  const shown = stream.since();
  expect(shown.lines.map(line => line.source)).toEqual(["game", "game"]);
  // It answers again and sends what it has.
  stream.server = { state: "ok" };
  stream.addServer(serverLine(1200, "Margo joined the game"));
  const now = stream.since(shown.rev);
  expect(now.gone).toEqual([shown.lines[0].id]);
  expect(now.lines.map(line => `${line.source}: ${line.text}`)).toEqual(["server: Margo joined the game"]);
  expect(texts(stream)).toEqual(["Margo joined the game", "<Margo> hello"]);
});

test("with no server log configured, client lines appear at once", () => {
  const stream = new Console(false, { now: () => clock });
  expect(stream.server).toEqual({ state: "unset" });
  stream.addGame("Gary", T, "<Margo> hello");
  stream.flush();
  expect(stream.since().lines).toMatchObject([{ source: "game", kind: "chat", text: "<Margo> hello", seenBy: ["Gary"] }]);
});

test("commands, their output and the caretaker's words are marked for the page", () => {
  const stream = new Console(true, { now: () => clock });
  stream.addServer("> list", { mark: "command", t: T + 1000 });
  stream.addServer("There are 1 of a max of 20 players online: Gary", { mark: "output", t: T + 1100 });
  stream.addServer('> tellraw @a {"text":"<Caretaker> Gary: the stream is north"}', { mark: "command", t: T + 2000 });
  stream.addServer("<spesk01> hello Gary", { mark: "chat", t: T + 3000 });
  expect(stream.since().lines.map(line => ({ at: line.t - T, kind: line.kind, mark: line.mark, text: line.text }))).toEqual([
    { at: 1000, kind: "command", mark: "command", text: "> list" },
    { at: 1100, kind: "command", mark: "output", text: "There are 1 of a max of 20 players online: Gary" },
    { at: 2000, kind: "chat", mark: "command", text: '> tellraw @a {"text":"<Caretaker> Gary: the stream is north"}' },
    { at: 3000, kind: "chat", mark: undefined, text: "<spesk01> hello Gary" },
  ]);
  // What the phone chat page said reaches clients by tellraw; their copy of it is a repeat.
  stream.server = { state: "ok" };
  stream.addGame("Gary", T + 3000, "<spesk01> hello Gary");
  clock += 60_000;
  stream.flush();
  expect(stream.since().lines.length).toBe(4);
});

test("lines are kept in time order whatever order they arrive in, and only the newest are kept", () => {
  const stream = new Console(true, { capacity: 3, now: () => clock });
  stream.addServer(serverLine(3000, "three"));
  stream.addServer(serverLine(1000, "one"));
  stream.addServer(serverLine(2000, "two"));
  expect(texts(stream)).toEqual(["one", "two", "three"]);
  stream.addServer(serverLine(4000, "four"));
  expect(texts(stream)).toEqual(["two", "three", "four"]);
  // A reader that has everything up to a revision gets only what came after it.
  const rev = stream.since().rev;
  stream.addServer(serverLine(5000, "five"));
  expect(texts(stream, rev)).toEqual(["five"]);
});

test("the feed follows the server's log through the phone-chat service, a restart of it, and a log rotation", async () => {
  const server = phoneChat();
  const stream = new Console(true, { now: () => clock });
  const feed = new ConsoleFeed(stream, home.config({ CONSOLE_URL: server.url.replace(/\/$/, "") }), () => clock);
  expect(stream.server.state).toBe("unknown");
  server.log(serverLine(0, "Gary joined the game"));
  server.log(serverLine(1000, "[Not Secure] <Gary> hello"));
  await feed.pollServer();
  expect(stream.server).toEqual({ state: "ok" });
  expect(texts(stream)).toEqual(["Gary joined the game", "[Not Secure] <Gary> hello"]);
  server.log(serverLine(2000, "Margo joined the game"));
  await feed.pollServer();
  await feed.pollServer();
  expect(server.requests).toEqual(["GET /chat-token/console?after=0", "GET /chat-token/console?after=2", "GET /chat-token/console?after=3"]);
  expect(texts(stream).length).toBe(3);

  // The service restarts: it reads the tail of the same log again and numbers it from 1.
  server.restart(2);
  server.log(serverLine(3000, "[Not Secure] <Margo> hi"));
  await feed.pollServer();
  expect(texts(stream)).toEqual(["Gary joined the game", "[Not Secure] <Gary> hello", "Margo joined the game", "[Not Secure] <Margo> hi"]);
  // The server restarts and starts a new log: nothing is repeated, what was read stays.
  server.rotate();
  server.log(serverLine(60_000, "Starting minecraft server version 1.20.1", "INFO", "net.minecraft.server.dedicated.DedicatedServer/"));
  await feed.pollServer();
  expect(texts(stream).slice(-2)).toEqual(["[Not Secure] <Margo> hi", "Starting minecraft server version 1.20.1"]);
  expect(texts(stream).length).toBe(5);
  server.log(serverLine(61_000, "Gary joined the game"));
  await feed.pollServer();
  expect(texts(stream).length).toBe(6);

  server.stop();
  await feed.pollServer();
  expect(stream.server).toEqual({ state: "unreachable", detail: "The phone-chat service on the server machine does not answer." });
});

test("an old phone-chat service without the console is reported, not mistaken for an empty log", async () => {
  const old = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "Not found." }, { status: 404 }) });
  try {
    const stream = new Console(true);
    await new ConsoleFeed(stream, home.config({ CHAT_URL: `http://127.0.0.1:${old.port}/chat-token/` })).pollServer();
    expect(stream.server).toEqual({ state: "unreachable", detail: "The phone-chat service answered 404: its token is wrong in CONSOLE_URL, or it is an older version without the console." });
  } finally { await old.stop(true); }
});

test("the feed reads what each resident's client showed, without Baritone's chatter, and again after a client restarts", async () => {
  home.put("instances/Margo.env", `GAME_DIR=${home.dir}/game-Margo\nSYNAPSE_URL=http://127.0.0.1:9\n`);
  home.put("resident/margo/memory.md", "# Margo\n");
  const margoLog = home.put("game-Margo/logs/latest.log", fixture("client-chat.log"));
  const garyLog = home.put("game/logs/latest.log", `${clientLine(-5000, "[System] [CHAT] Margo joined the game")}\n${clientLine(-4000, "half a li")}`);
  const stream = new Console(false, { now: () => clock });
  const feed = new ConsoleFeed(stream, home.config(), () => clock);
  await feed.readClients();
  const lines = stream.since().lines;
  // Of the sample's 18 chat lines, 16 are Baritone talking to its own client.
  expect(lines.map(line => `${line.seenBy}: ${line.text.slice(0, 40)}`).sort()).toEqual([
    "Gary: Margo joined the game", "Margo: Margo joined the game", "Margo: [SecurityCraft] Thanks for using Securit",
  ]);
  expect(lines.find(line => line.seenBy?.[0] === "Gary")).toMatchObject({ kind: "players", source: "game" });
  const sample = new Date(lines.find(line => line.text.startsWith("[SecurityCraft]"))!.t);
  expect([sample.getHours(), sample.getMinutes(), sample.getSeconds()]).toEqual([10, 15, 37]);

  // Only whole new lines are read.
  appendFileSync(garyLog, `ne\n${clientLine(1000, "[CHAT] <Margo> hello Gary")}\n`);
  await feed.readClients();
  await feed.readClients();
  expect(texts(stream).filter(text => text.includes("hello"))).toEqual(["<Margo> hello Gary"]);
  // A session start deletes the client's log and the client writes a new one.
  home.put("game-Margo/logs/new.log", `${clientLine(2000, "[System] [CHAT] Gary has made the advancement [Stone Age]")}\n`);
  renameSync(`${home.dir}/game-Margo/logs/new.log`, margoLog);
  await feed.readClients();
  expect(stream.since().lines.at(-1)).toMatchObject({ text: "Gary has made the advancement [Stone Age]", kind: "players", seenBy: ["Margo"] });
  expect(stream.since().lines.length).toBe(5);
});

test("a command goes to the server machine and comes back in the stream; refusals are told apart", async () => {
  const server = phoneChat();
  server.answers.list = "There are 2 of a max of 20 players online: Gary, Margo";
  server.answers.nonsense = new Error("The server console refused the command: Unknown or incomplete command");
  app = createApp(home.config({ CONSOLE_URL: server.url }), "test-token-123", () => clock, () => {});
  const send = async (command: unknown) => {
    const response = await app!.fetch(new Request("http://commons.test/test-token-123/api/console/command", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }),
    }));
    return [response.status, await response.json()];
  };
  const page = async (query = "") => (await app!.fetch(new Request(`http://commons.test/test-token-123/api/console${query}`))).json() as Promise<Replies["console"]>;

  expect(await send("  /list ")).toEqual([200, { output: "There are 2 of a max of 20 players online: Gary, Margo" }]);
  expect(server.commands).toEqual(["list"]);
  // The echo is there when the answer is, not at the next poll.
  const first = await page();
  expect(first.commandsOff).toBeNull();
  expect(first.server).toEqual({ state: "ok" });
  expect(first.lines.map(line => `${line.mark}: ${line.text}`)).toEqual(["command: > list", "output: There are 2 of a max of 20 players online: Gary, Margo"]);

  expect(await send('tellraw @a {"text":"<Caretaker> Gary: the stream is north"}')).toEqual([200, { output: "" }]);
  expect(await send("nonsense")).toEqual([502, { error: "The server console refused the command: Unknown or incomplete command" }]);
  const next = await page(`?boot=${first.boot}&after=${first.rev}`);
  expect(next.lines.map(line => `${line.kind}/${line.mark}: ${line.text}`)).toEqual([
    'chat/command: > tellraw @a {"text":"<Caretaker> Gary: the stream is north"}', "command/output: (no output)",
    "command/command: > nonsense", "command/output: The server console refused the command: Unknown or incomplete command",
  ]);
  // A page that remembers revisions from before this app restarted gets everything.
  expect((await page(`?boot=earlier&after=${first.rev}`)).lines.length).toBe(6);

  expect(await send("   ")).toEqual([400, { error: "Type a command first." }]);
  expect(await send("/")).toEqual([400, { error: "Type a command first." }]);
  expect(await send("say a\nstop")).toEqual([400, { error: "A command is one line of at most 1000 characters." }]);
  expect(await send(7)).toEqual([400, { error: "Type a command first." }]);
  expect(server.commands.length).toBe(3);
  server.stop();
  expect(await send("list")).toEqual([502, { error: "The phone-chat service on the server machine did not answer. The command may not have run." }]);
});

test("without an address for the server machine the command box is off and says why; client lines still show", async () => {
  home.put("game/logs/latest.log", `${clientLine(0, "[System] [CHAT] Gary joined the game")}\n`);
  app = createApp(home.config(), "test-token-123", () => clock, () => {});
  await app.feed.readClients();
  const reply = await (await app.fetch(new Request("http://commons.test/test-token-123/api/console"))).json() as Replies["console"];
  expect(reply.server).toEqual({ state: "unset" });
  expect(reply.commandsOff).toBe("Commands are off: neither CONSOLE_URL nor CHAT_URL is set, so this app has no way to the server.");
  expect(reply.lines).toMatchObject([{ source: "game", text: "Gary joined the game", seenBy: ["Gary"] }]);
  const refused = await app.fetch(new Request("http://commons.test/test-token-123/api/console/command", { method: "POST", body: JSON.stringify({ command: "list" }) }));
  expect([refused.status, await refused.json()]).toEqual([503, { error: reply.commandsOff }]);
});

test("CHAT_URL stands in for CONSOLE_URL, and either spelling of the address works", () => {
  expect(home.config({ CHAT_URL: "http://192.168.1.233:8766/tok/" }).consoleUrl).toBe("http://192.168.1.233:8766/tok/");
  expect(home.config({ CHAT_URL: "http://a/tok/", CONSOLE_URL: "http://b/tok" }).consoleUrl).toBe("http://b/tok/");
  expect(home.config().consoleUrl).toBeUndefined();
});

test("plumbing in the server log is noise; anything a person might want is not", () => {
  const noise = (messages: string[], level = "INFO") => messages.map(message => serverNoise(level, message));
  expect(noise([
    "Thread RCON Client /10.89.5.105 started", "Thread RCON Client /10.89.5.105 shutting down", "Thread RCON Client /127.0.0.1 started",
    "Rcon connection from: /10.89.5.105", "Saving chunks for level 'ServerLevel[world]'/minecraft:overworld",
    "ThreadedAnvilChunkStorage (world): All chunks are saved", "ThreadedAnvilChunkStorage: All dimensions are saved",
  ])).toEqual(Array(7).fill(true));
  expect(noise([
    "UUID of player Gary is 0b6c8a52-6e0f-3a58-9a5a-7f0f0c1f8c11", "Gary joined the game", "[Rcon] backup at six", "<Gary> Thread RCON Client /1.2.3.4 started",
    "Saving the game (this may take a moment!)", "Saved the game", "RCON running on 0.0.0.0:25575", "Thread RCON Listener started",
    "There are 2 of a max of 20 players online: Gary, Margo", "Done (41.208s)! For help, type \"help\"", "Stopping server",
  ])).toEqual(Array(11).fill(false));
  // The same words as a warning are something went wrong, not plumbing.
  expect(noise(["Thread RCON Client /10.89.5.105 shutting down"], "WARN")).toEqual([false]);
});

test("a mod's untargeted banner in a client's chat is noise, unless it names a player or is chat", () => {
  const names = new Set(["gary", "margo", "spesk01"]);
  const noise = (messages: string[]) => messages.map(message => gameNoise(message, names));
  expect(noise([
    "[SecurityCraft] Thanks for using SecurityCraft v1.10.1! Tip: Have a suggestion for SecurityCraft or found a bug?",
    "[Immersive Engineering] A new version is available", "[JEI] Recipes reloaded",
  ])).toEqual([true, true, true]);
  expect(noise([
    "[Waystones] Gary activated the waystone Cabin", "[FTB Chunks] spesk01 claimed this chunk", "[Quests] Reward for MARGO: 3 bread",
    "[Server] restarting in five minutes", "[Rcon] hello", "<Caretaker> Gary: the stream is north", "[Caretaker] <Caretaker> Margo: hello",
    "The server restarts at 18:00 for a backup", "Margo joined the game", "<Gary> [SecurityCraft] is chatty",
  ])).toEqual(Array(10).fill(false));
  // A name inside a longer word is not that player.
  expect(noise(["[Farming] Margosa trees grow in jungles"])).toEqual([true]);
});

test("noise is flagged on the lines themselves, keeps its kind, and players are learned as they appear", () => {
  const stream = new Console(false, { now: () => clock, names: ["Gary", "Margo"] });
  stream.addServer(serverLine(0, "Thread RCON Client /10.89.5.105 started", "INFO", "net.minecraft.server.rcon.thread.GenericThread/", "RCON Listener #1"));
  stream.addServer(serverLine(10, "Thread RCON Client /10.89.5.105 shutting down", "INFO", "net.minecraft.server.rcon.thread.RconClient/", "RCON Client /10.89.5.105 #2"));
  stream.addServer(serverLine(20, "UUID of player Gary is 0b6c8a52-6e0f-3a58-9a5a-7f0f0c1f8c11", "INFO", "net.minecraft.server.network.ServerLoginPacketListenerImpl/", "User Authenticator #1"));
  stream.addGame("Gary", T + 1000, "[SecurityCraft] Thanks for using SecurityCraft v1.10.1!");
  stream.addGame("Gary", T + 2000, "[Waystones] Gary activated the waystone Cabin");
  stream.addGame("Gary", T + 3000, "[FTB Chunks] Rosa claimed this chunk");
  stream.flush();
  // Rosa turns up: from now on a mod's line about her is worth showing.
  stream.addServer(serverLine(4000, "Rosa joined the game"));
  stream.addGame("Gary", T + 5000, "[FTB Chunks] Rosa claimed another chunk");
  stream.flush();
  expect(stream.since().lines.map(line => `${line.noise === true ? "noise" : "shown"} ${line.kind} ${line.tag ?? "-"}: ${line.text.split(" ").slice(0, 4).join(" ")}`)).toEqual([
    "noise other GenericThread: Thread RCON Client /10.89.5.105",
    "noise other RconClient: Thread RCON Client /10.89.5.105",
    "shown other ServerLoginPacketListenerImpl: UUID of player Gary",
    "noise chat -: [SecurityCraft] Thanks for using",
    "shown chat -: [Waystones] Gary activated the",
    "noise chat -: [FTB Chunks] Rosa claimed",
    "shown players -: Rosa joined the game",
    "shown chat -: [FTB Chunks] Rosa claimed",
  ]);
});

test("terminal colour codes are taken out, and a line that was only a colour reset is not a line", () => {
  expect(plain("There are 2 of a max of 20 players online: Gary, Margo\u001b[0m")).toBe("There are 2 of a max of 20 players online: Gary, Margo");
  expect(plain("\u001b[38;5;214mgold\u001b[m and \u001b[1;31mred\u001b[0m  ")).toBe("gold and red");
  const stream = new Console(true, { now: () => clock });
  stream.addServer("> list", { mark: "command", t: T });
  stream.addServer("There are 2 of a max of 20 players online: \u001b[32mGary\u001b[0m, Margo", { mark: "output", t: T + 1 });
  stream.addServer("\u001b[0m", { mark: "output", t: T + 2 });
  stream.addServer("", { mark: "output", t: T + 3 });
  stream.addServer(serverLine(1000, "\u001b[33mCan't keep up!\u001b[0m", "WARN"));
  stream.addServer("   ");
  expect(texts(stream)).toEqual(["> list", "There are 2 of a max of 20 players online: Gary, Margo", "Can't keep up!"]);
});

test("an older phone-chat service that passes colour codes through still gives a clean answer and no empty line", async () => {
  const server = phoneChat();
  server.answers.list = "There are 2 of a max of 20 players online: Gary, Margo\n\u001b[0m";
  server.answers.nonsense = new Error("The server console refused the command: \u001b[31mUnknown or incomplete command\u001b[0m\n\u001b[0m");
  const stream = new Console(true, { now: () => clock });
  const feed = new ConsoleFeed(stream, home.config({ CONSOLE_URL: server.url }), () => clock);
  expect(await feed.command("list")).toEqual({ ok: true, output: "There are 2 of a max of 20 players online: Gary, Margo" });
  expect(await feed.command("nonsense")).toEqual({ ok: false, code: 502, error: "The server console refused the command: Unknown or incomplete command" });
  expect(texts(stream)).toEqual([
    "> list", "There are 2 of a max of 20 players online: Gary, Margo",
    "> nonsense", "The server console refused the command: Unknown or incomplete command",
  ]);
});

test("the residents and the owner are known to the console from the start", async () => {
  expect(home.config().owners).toEqual(["spesk01"]);
  expect(home.config({ COMMONS_OWNER: "Sam, Rosa" }).owners).toEqual(["Sam", "Rosa"]);
  home.put("game/logs/latest.log", [
    clientLine(0, "[System] [CHAT] [SecurityCraft] Thanks for using SecurityCraft v1.10.1!"),
    clientLine(1000, "[System] [CHAT] [FTB Chunks] spesk01 claimed this chunk"),
    clientLine(2000, "[System] [CHAT] [Waystones] Gary activated the waystone Cabin"),
  ].join("\n") + "\n");
  app = createApp(home.config(), "test-token-123", () => clock, () => {});
  await app.feed.readClients();
  const reply = await (await app.fetch(new Request("http://commons.test/test-token-123/api/console"))).json() as Replies["console"];
  expect(reply.lines.map(line => `${line.noise === true} ${line.text.slice(0, 20)}`)).toEqual(["true [SecurityCraft] Than", "false [FTB Chunks] spesk01", "false [Waystones] Gary act"]);
});

test("noise is kept in small numbers, so hours of RCON polling do not push out what people said", () => {
  const stream = new Console(true, { capacity: 6, noiseCapacity: 2, now: () => clock });
  stream.addServer(serverLine(0, "<Gary> hello"));
  for (let poll = 1; poll <= 5; poll++) stream.addServer(serverLine(poll * 1000, `Thread RCON Client /10.89.5.${poll} started`));
  stream.addServer(serverLine(9000, "<Margo> hi"));
  expect(texts(stream)).toEqual(["<Gary> hello", "Thread RCON Client /10.89.5.4 started", "Thread RCON Client /10.89.5.5 started", "<Margo> hi"]);
});
