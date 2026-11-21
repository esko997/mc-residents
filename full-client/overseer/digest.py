#!/usr/bin/env python3
"""What one resident did lately, condensed for the caretaker model.

    digest.py <Name> <resident-dir> <minutes> [--until ISO-UTC] [--synapse URL]

Reads the resident's body call log (one JSON line per tool call, written by the
tool server, see src/calllog.ts) and its Codex rollouts (told apart by their
working directory) for its own words, its notes and, when the client is up,
its current state. Rollouts from before the call log existed are read for
calls too. Prints plain text.
"""
import argparse, collections, datetime, glob, json, os, re, subprocess, sys

EVENT = re.compile(r"^(\d+) (chat|hurt|died|arrived|stopped_short|navigation_stopped|reflex|player_near|player_gone|system|hungry)\b ?(.*)$", re.M)
CALL = re.compile(r"mcp__body__(\w+)\(\s*(\{.*?\})?\s*\)", re.S)
QUIET = {"status", "wait", "picture", "screen", "inventory"}


def text_of(output):
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "\n".join(part.get("text", "") for part in output if isinstance(part, dict))
    return json.dumps(output)


def rollouts(codex_home, resident_dir, since):
    for path in sorted(glob.glob(os.path.join(codex_home, "sessions", "*", "*", "*", "*.jsonl"))):
        if os.path.getmtime(path) < since.timestamp():
            continue
        with open(path, errors="replace") as handle:
            first = handle.readline()
        try:
            meta = json.loads(first)
        except ValueError:
            continue
        if (meta.get("payload") or {}).get("cwd") == resident_dir:
            yield path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("name"); parser.add_argument("resident_dir"); parser.add_argument("minutes", type=int)
    parser.add_argument("--until"); parser.add_argument("--synapse"); parser.add_argument("--calls")
    parser.add_argument("--base", default=os.path.expanduser("~/gary-client"))
    args = parser.parse_args()
    until = datetime.datetime.fromisoformat(args.until.replace("Z", "+00:00")) if args.until else datetime.datetime.now(datetime.timezone.utc)
    since = until - datetime.timedelta(minutes=args.minutes)
    resident_dir = os.path.realpath(args.resident_dir)

    calls = collections.Counter(); events = collections.Counter()
    timeline = []; said = []; heard = []; thoughts = []; pending = {}
    repeats = collections.Counter(); previous = None

    def called(clock, found):
        nonlocal previous
        for tool, arguments in found:
            calls[tool] += 1
            key = (tool, re.sub(r"\s+", "", arguments or ""))
            if tool not in QUIET:
                if key == previous:
                    repeats[key] += 1
                previous = key
            if tool == "say":
                match = re.search(r'text"?\s*:\s*"((?:[^"\\]|\\.)*)"', arguments or "")
                if match:
                    said.append(f"{clock} {match.group(1)[:200]}")

    def answered(clock, found, body):
        seen = []
        for _, name, rest in EVENT.findall(body):
            # In a rollout the tool result is embedded in JSON; its closing brackets trail the last event line.
            rest = rest.split('"}')[0]
            events[name] += 1
            if name == "chat":
                heard.append(f"{clock} {rest[:200]}")
            elif name in ("died", "stopped_short", "navigation_stopped", "reflex", "hurt"):
                seen.append(f"{name} {rest[:150]}")
        errors = re.findall(r"^Error: .*$", body, re.M)
        loud = [f"{tool}{(' ' + re.sub(chr(10), ' ', arguments)[:90]) if arguments else ''}" for tool, arguments in found if tool not in QUIET]
        if errors:
            # Name the tool that failed even when it is one of the quiet ones.
            loud = loud or [tool for tool, _ in found]
        if loud or seen or errors:
            entry = f"{clock} " + "; ".join(loud)
            if errors:
                entry += " -> " + errors[0][:160]
            if seen:
                entry += " | " + " | ".join(seen[:3])
            timeline.append(entry)

    # The call log is the record when it exists: under Codex's code mode a model
    # calls tools from JavaScript it writes itself, and Sol wrapped them in a
    # helper of its own, so call sites in a rollout follow no fixed pattern.
    call_log = args.calls or os.path.join(args.base, "calls", f"{args.name}.jsonl")
    logged = False
    if os.path.exists(call_log):
        for line in open(call_log, errors="replace"):
            try:
                record = json.loads(line)
                when = datetime.datetime.fromisoformat(record["t"].replace("Z", "+00:00"))
            except (ValueError, KeyError, TypeError):
                continue
            if when < since or when > until:
                continue
            logged = True
            clock = when.astimezone().strftime("%H:%M")
            found = [(record.get("tool", "?"), json.dumps(record.get("args") or {}, ensure_ascii=False, separators=(",", ":")) if record.get("args") else "")]
            called(clock, found)
            answered(clock, found, record.get("text") or "")

    for path in rollouts(os.path.join(args.base, "codex-home"), resident_dir, since):
        for line in open(path, errors="replace"):
            try:
                item = json.loads(line)
            except ValueError:
                continue
            stamp = item.get("timestamp")
            if not stamp:
                continue
            when = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if when < since or when > until:
                continue
            clock = when.astimezone().strftime("%H:%M")
            payload = item.get("payload") or {}
            kind = payload.get("type")
            if kind == "custom_tool_call" and not logged:
                found = CALL.findall(payload.get("input") or "")
                pending[payload.get("call_id")] = (clock, found)
                called(clock, found)
            elif kind == "custom_tool_call_output" and not logged:
                clock0, found = pending.pop(payload.get("call_id"), (clock, []))
                answered(clock0, found, text_of(payload.get("output")).replace("\\n", "\n"))
            elif kind == "message" and payload.get("role") == "assistant":
                words = text_of(payload.get("content")).strip()
                if words:
                    thoughts.append(f"{clock} {words[:300]}")

    def section(title, lines, limit):
        print(f"\n## {title}")
        text = "\n".join(lines) if lines else "(none)"
        print(text if len(text) <= limit else "… earlier lines omitted …\n" + text[-limit:])

    print(f"# {args.name}: last {args.minutes} minutes, to {until.astimezone().strftime('%H:%M')}")
    print("\n## Counts")
    print("tool calls: " + (", ".join(f"{tool} {count}" for tool, count in calls.most_common()) or "none"))
    print("events: " + (", ".join(f"{name} {count}" for name, count in events.most_common()) or "none"))
    again = [f"{tool}{arguments} x{count + 1}" for (tool, arguments), count in repeats.most_common(6)]
    print("same action repeated back to back: " + ("; ".join(again) or "none"))
    section("What it did, in order (status, wait, picture, screen and inventory calls left out)", timeline, 9000)
    section("What it said in chat", said, 2500)
    section("Chat it heard", heard, 2500)
    section("Its own remarks to itself", thoughts, 2000)

    if args.synapse:
        try:
            raw = subprocess.run([os.path.join(args.base, "synapse.sh"), "GET", "/state?mode=full"], env={**os.environ, "SYNAPSE_BASE": args.synapse}, capture_output=True, text=True, timeout=10).stdout
            state = json.loads(raw)["data"]
            pos = state["pos"]
            # The full state lists the hotbar inside the main inventory as well.
            carried = (state.get("inventory") or {}).get("main") or state.get("hotbar") or []
            stacks = [f"{s['count']} {s['item'].split(':')[-1]}" for s in carried if s.get("item") not in (None, "minecraft:air")]
            print("\n## Right now")
            print(f"position {round(pos['x'])},{round(pos['y'])},{round(pos['z'])} {state.get('dimension')}; health {state.get('health')}/20; food {state.get('food')}/20")
            print("carrying: " + (", ".join(stacks) or "nothing"))
        except Exception as error:  # the client may be down between sessions
            print(f"\n## Right now\n(state unavailable: the client is not running or did not answer; {error.__class__.__name__})")

    for name, limit in (("memory.md", 6000), ("plan.json", 2500), ("places.json", 1500)):
        path = os.path.join(resident_dir, name)
        if os.path.exists(path):
            body = open(path, errors="replace").read()
            print(f"\n## Its {name} ({len(body)} bytes)")
            print(body if len(body) <= limit else body[:limit] + "\n… cut …")
    journal = os.path.join(resident_dir, "journal.md")
    if os.path.exists(journal):
        print("\n## End of its journal.md")
        print(open(journal, errors="replace").read()[-1500:])


if __name__ == "__main__":
    sys.exit(main())
