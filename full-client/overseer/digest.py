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
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

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


def project_summary(path):
    """Readable project evidence, never equating checked actions with success."""
    try:
        store = json.loads(Path(path).read_text())
        if not isinstance(store, dict):
            raise ValueError("project store is not an object")
        plans = [p for p in store.get("plans", []) if isinstance(p, dict)]
        plans.sort(key=lambda p: p.get("name") != store.get("focus"))
        lines = []
        for plan in plans[:3]:
            lines.append(f"Project {plan.get('name')} (focus={plan.get('name') == store.get('focus')}): {plan.get('goal')}")
            lines.append(f"  Vision link: {plan.get('why') or 'not specified'}")
            lines.append(f"  Done when: {plan.get('done_when') or 'legacy project; criterion not specified'}")
            if plan.get("needs"):
                lines.append(f"  Prerequisites/blockers: {plan['needs']}")
            if plan.get("with"):
                lines.append(f"  Collaborators named by resident (not proof of agreement): {plan['with']}")
            steps = [s for s in plan.get("steps", []) if isinstance(s, dict)]
            active = next((s for s in steps if s.get("state") == "doing"), None)
            active = active or next((s for s in steps if s.get("state") == "todo"), None)
            blocked = [s for s in steps if s.get("state") == "blocked"]
            if active:
                lines.append(f"  Next: {active.get('text')}; note: {active.get('note') or 'none'}")
            for step in blocked[:3]:
                lines.append(f"  Blocked: {step.get('text')}; {step.get('note') or 'no reason recorded'}")
            if steps and not active and not blocked:
                lines.append("  No open actions: outcome still awaits explicit verification/closure.")
        history = [p for p in store.get("history", []) if isinstance(p, dict)]
        history.sort(key=lambda p: p.get("ended", 0), reverse=True)
        for plan in history[:3]:
            lines.append(f"Ended {plan.get('name')}: {plan.get('outcome') or 'legacy/unclassified'}; resident-reported evidence: {plan.get('evidence') or 'none'}; unlocks: {plan.get('unlocks') or 'not recorded'}")
        return "\n".join(lines) or "No projects recorded."
    except FileNotFoundError:
        return "No project file."
    except (ValueError, TypeError, OSError):
        return "Project file unreadable; no progress inferred."


class NoLibraryRedirect(HTTPRedirectHandler):
    """Never forward the caretaker credential to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def library_digest(resident):
    """Read the hub's shared-library snapshot; never consult a local database."""
    url = os.environ.get("COMMONS_URL", "").rstrip("/")
    token_file = os.environ.get("COMMONS_TOKEN_FILE", "")
    parsed = urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/") or not token_file):
        raise ValueError("COMMONS_URL and COMMONS_TOKEN_FILE must configure the hub")
    token = Path(token_file).expanduser().read_text().strip()
    if not token or any(character.isspace() for character in token):
        raise ValueError("invalid caretaker token file")
    request = Request(url + "/resident-api/v1/caretaker/digest?" + urlencode({"resident": resident}),
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    with build_opener(NoLibraryRedirect()).open(request, timeout=10) as response:
        raw = response.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise ValueError("library digest too large")
    data = json.loads(raw)
    fields = ("skills", "collaborations", "facilities", "knowledge_requests", "places")
    if not isinstance(data, dict) or any(
            not isinstance(data.get(field), list) or any(not isinstance(row, dict) for row in data[field])
            for field in fields):
        raise ValueError("invalid library digest shape")
    for skill in data["skills"]:
        if any(not isinstance(skill.get(field), str) for field in ("name", "author", "description", "status")):
            raise ValueError("invalid library skill")
    return data


def print_library(resident):
    try:
        data = library_digest(resident)
    except (OSError, URLError, ValueError) as error:
        # Never print exception text: URLs, paths and credentials may be in it.
        reason = f"HTTP {error.code}" if isinstance(error, HTTPError) else type(error).__name__
        print(f"\n## Shared library\nHub library unavailable ({reason}); do not infer none exist.")
        return
    for key, title in (
        ("places", "Shared places (saved claims; check permissions and current state)"),
        ("collaborations", "Voluntary agreements (reported results and confirmations are not machine verification)"),
        ("facilities", "Shared facilities (claims with access terms; dated observations, not live counts)"),
        ("knowledge_requests", "This resident's knowledge requests (ref-N is a guide handle; references remain untested)"),
    ):
        print(f"\n## {title}")
        for row in data[key]:
            print(json.dumps(row, ensure_ascii=False))
        if not data[key]:
            print("None.")
    print("\n## Available reusable skills (passed declared checks or curated; not universal guarantees)")
    for skill in data["skills"]:
        print(f"{skill['name']} by {skill['author']} [{skill['status']}]: {skill['description'][:200]}")
    if not data["skills"]:
        print("None.")


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

    health_file = Path(args.base) / "sessions" / f"{args.name}-health.json"
    try:
        health = json.loads(health_file.read_text())
        fields = {key: health.get(key) for key in ("status", "reason", "updated_at", "end_at", "last_healthy_at", "consecutive_failures", "client_stopped")}
        print("\n## Session health (supervisor observations, timestamps in Unix seconds)")
        print(json.dumps(fields))
    except (OSError, ValueError, TypeError):
        pass
    print("\n## Its projects (resident reports, not automatic world verification)")
    print(project_summary(os.path.join(resident_dir, "plan.json")))
    for other in sorted(glob.glob(os.path.join(os.path.dirname(resident_dir), "*", "plan.json"))):
        if os.path.dirname(other) != resident_dir:
            print(f"\n## Neighbour projects: {os.path.basename(os.path.dirname(other))}")
            print(project_summary(other))
    print_library(args.name)
    for name, limit in (("memory.md", 6000), ("places.json", 1500)):
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
