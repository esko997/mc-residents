#!/usr/bin/env python3
"""Type into the Minecraft server's chat from a phone on the LAN.

A message is shown to everyone as `<NAME> text` through the server console
(`tellraw`), so it reads like that player's own chat without a second login.
The page also follows the server log, so replies appear without the game open.

Configuration (environment):
  PHONE_CHAT_TOKEN      required; the secret first path segment of every URL
  PHONE_CHAT_NAME       player name to speak as (default spesk01)
  PHONE_CHAT_PORT       listen port (default 8766)
  PHONE_CHAT_CONTAINER  podman container running the server
  PHONE_CHAT_LOG        the server's latest.log
"""

import hmac
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["PHONE_CHAT_TOKEN"]
NAME = os.environ.get("PHONE_CHAT_NAME", "spesk01")
PORT = int(os.environ.get("PHONE_CHAT_PORT", "8766"))
CONTAINER = os.environ.get("PHONE_CHAT_CONTAINER", "simons-vanilla-plus")
LOG = os.environ.get(
    "PHONE_CHAT_LOG", os.path.expanduser("~/mc-servers/simon_vanilla_plus/mc-data/logs/latest.log")
)
MAX_CHARS = 256  # Minecraft's own chat limit

# [21Nov2026 00:13:07.381] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: [Not Secure] <Gary> hello
LOG_LINE = re.compile(
    r"^\[(\d{2}\w{3}\d{4} \d{2}:\d{2}:\d{2})\.\d+\] \[Server thread/INFO\] "
    r"\[net\.minecraft\.server\.MinecraftServer/\]: (?:\[Not Secure\] )?(.*)$"
)
CHAT = re.compile(r"^<([^>]{1,32})> (.*)$")
PRESENCE = re.compile(r"^(\w{1,32}) (joined|left) the game$")

entries = deque(maxlen=300)  # {"id", "t", "name", "text"}; name is None for joins and leaves
entries_lock = threading.Lock()
next_id = 1


def add_entry(seconds, name, text):
    global next_id
    with entries_lock:
        entries.append({"id": next_id, "t": seconds, "name": name, "text": text})
        next_id += 1


def read_log_line(line):
    found = LOG_LINE.match(line.rstrip("\n"))
    if not found:
        return
    # The container logs in UTC.
    seconds = datetime.strptime(found[1], "%d%b%Y %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    chat = CHAT.match(found[2])
    if chat:
        add_entry(seconds, chat[1], chat[2])
    elif PRESENCE.match(found[2]):
        add_entry(seconds, None, found[2])


def follow_log():
    """Tail latest.log across the server's rotation, which replaces the file."""
    while True:
        try:
            with open(LOG, "rb") as log:
                inode = os.fstat(log.fileno()).st_ino
                pending = b""
                while True:
                    chunk = log.read(65536)
                    if chunk:
                        *lines, pending = (pending + chunk).split(b"\n")
                        for line in lines:
                            read_log_line(line.decode("utf-8", errors="replace"))
                        continue
                    time.sleep(0.5)
                    if os.stat(LOG).st_ino != inode:
                        break
        except OSError:
            time.sleep(2)


def say(text):
    """Show `text` in game chat as NAME. Returns an error string, or None on success."""
    component = json.dumps({"text": f"<{NAME}> {text}"})  # ASCII-only JSON; nothing in it is a selector
    try:
        done = subprocess.run(
            ["podman", "exec", CONTAINER, "rcon-cli", f"tellraw @a {component}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as problem:
        return f"The server console did not answer: {problem}"
    output = (done.stdout + done.stderr).strip()
    if done.returncode != 0:
        return f"The server console refused the message: {output or done.returncode}"
    if "No player was found" in output:
        return "Nobody is online to read that."
    # tellraw is not written to the server log, so record it here.
    add_entry(time.time(), NAME, text)
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "phone-chat"

    def log_message(self, *_):
        pass  # the token is in every URL; keep it out of the journal

    def reply(self, status, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def route(self):
        """The path after the token, or None when the token is wrong."""
        parts = self.path.split("?", 1)[0].strip("/").split("/", 1)
        if not hmac.compare_digest(parts[0], TOKEN):
            self.reply(404, {"error": "Not found."})
            return None
        return parts[1] if len(parts) > 1 else ""

    def do_GET(self):
        route = self.route()
        if route is None:
            return
        if route == "":
            self.reply(200, PAGE.replace("__NAME__", NAME).encode(), "text/html; charset=utf-8")
        elif route == "log":
            query = self.path.partition("?")[2]
            after = int(query.removeprefix("after=")) if query.removeprefix("after=").isdigit() else 0
            with entries_lock:
                self.reply(200, [entry for entry in entries if entry["id"] > after])
        else:
            self.reply(404, {"error": "Not found."})

    def do_POST(self):
        route = self.route()
        if route is None:
            return
        if route != "say":
            self.reply(404, {"error": "Not found."})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4096:
            self.reply(413, {"error": "That message is too long."})
            return
        try:
            text = json.loads(self.rfile.read(length))["text"]
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "Send JSON with a text field."})
            return
        text = " ".join("".join(ch for ch in str(text) if ch.isprintable()).split())
        if not text:
            self.reply(400, {"error": "Type a message first."})
            return
        if len(text) > MAX_CHARS:
            self.reply(400, {"error": f"Chat lines stop at {MAX_CHARS} characters."})
            return
        problem = say(text)
        self.reply(502 if problem else 200, {"error": problem} if problem else {"ok": True})


PAGE = r"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#23262d">
<title>Server chat</title>
<style>
  :root { --stone: #23262d; --deep: #191b20; --plank: #b8945f; --plank-edge: #6f5632; --ink: #2a1f10;
          --text: #ffffff; --shadow: #3f3f3f; --gold: #ffaa00; --aqua: #55ffff; --yellow: #ffff55; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; height: 100dvh; background: var(--stone); color: var(--text);
         font: 600 17px/1.45 "Trebuchet MS", "Segoe UI", system-ui, sans-serif; }
  #log { flex: 1; overflow-y: auto; margin: 0; padding: 14px 14px 8px; list-style: none;
         background: linear-gradient(var(--deep), var(--stone)); overscroll-behavior: contain; }
  #log li { text-shadow: 2px 2px 0 var(--shadow); overflow-wrap: anywhere; padding: 1px 0; }
  #log time { font-weight: 400; font-size: 12px; opacity: .55; margin-right: 6px; text-shadow: none; }
  .name { color: var(--aqua); }
  .me .name { color: var(--gold); }
  .presence { color: var(--yellow); font-style: italic; }
  #empty { opacity: .6; text-shadow: none; font-weight: 400; }
  form { display: flex; gap: 8px; padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
         background: var(--plank); border-top: 4px solid var(--plank-edge); }
  input { flex: 1; min-width: 0; font: inherit; color: var(--ink); background: #d9bd8c; border: 2px solid var(--plank-edge);
          border-radius: 2px; padding: 10px 12px; }
  input::placeholder { color: #6b5636; font-weight: 400; }
  button { font: inherit; color: var(--text); background: #4a7a2c; border: 2px solid #2c4d18; border-radius: 2px;
           padding: 10px 16px; text-shadow: 2px 2px 0 #2c4d18; }
  button:disabled { opacity: .6; }
  input:focus-visible, button:focus-visible { outline: 3px solid var(--text); outline-offset: 1px; }
  #problem { margin: 0; padding: 0 12px; background: var(--plank); color: #7a1414; font-size: 14px; }
  #problem:not(:empty) { padding: 8px 12px 0; }
</style>
<ul id="log" aria-live="polite"><li id="empty">Nothing said yet. Your messages appear in game as __NAME__.</li></ul>
<p id="problem" role="alert"></p>
<form id="form" autocomplete="off">
  <input id="text" maxlength="256" enterkeyhint="send" placeholder="Say something as __NAME__" aria-label="Chat message">
  <button id="send">Send</button>
</form>
<script>
  const me = "__NAME__";
  const log = document.getElementById("log"), form = document.getElementById("form");
  const input = document.getElementById("text"), send = document.getElementById("send");
  const problem = document.getElementById("problem");
  let after = 0;

  function show(entry) {
    document.getElementById("empty")?.remove();
    const line = document.createElement("li"), stamp = document.createElement("time");
    stamp.textContent = new Date(entry.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    line.append(stamp);
    if (entry.name === null) {
      line.className = "presence";
      line.append(entry.text);
    } else {
      if (entry.name === me) line.className = "me";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = "<" + entry.name + ">";
      line.append(name, " " + entry.text);
    }
    log.append(line);
  }

  async function poll() {
    try {
      const response = await fetch("log?after=" + after, { cache: "no-store" });
      const fresh = await response.json();
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      for (const entry of fresh) { show(entry); after = entry.id; }
      if (fresh.length && atBottom) log.scrollTop = log.scrollHeight;
    } catch { /* the next poll retries */ }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    problem.textContent = "";
    try {
      const response = await fetch("say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const result = await response.json();
      if (response.ok) { input.value = ""; await poll(); log.scrollTop = log.scrollHeight; }
      else problem.textContent = result.error;
    } catch {
      problem.textContent = "Could not reach the chat page's server. Check you are on the home network.";
    }
    send.disabled = false;
    input.focus();
  });

  poll().then(() => { log.scrollTop = log.scrollHeight; });
  setInterval(poll, 1500);
</script>
</html>
"""

if __name__ == "__main__":
    threading.Thread(target=follow_log, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
