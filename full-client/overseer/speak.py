#!/usr/bin/env python3
"""Say the caretaker's note to a resident in the game's chat.

    speak.py <Name> <answer-file> <bridge base URL>

The answer file holds `NOTE: ...` and `MAINTAINERS: ...`. Only the note is
spoken, and nothing is sent when it is `none`. The line goes out as
`<Caretaker> <Name>: <note>` with `tellraw`, through the phone-chat service's
`command` route (the game machine cannot reach the server console itself).
Prints one line saying what happened; the caller appends it to the notes file.
"""
import json, re, sys, urllib.request


def note_of(answer):
    match = re.search(r"^NOTE:\s*(.*?)(?=^MAINTAINERS:|\Z)", answer, re.M | re.S)
    note = " ".join(match.group(1).split()) if match else ""
    return "" if note.lower().rstrip(".") in ("", "none") else note


def main():
    name, path, base = sys.argv[1], sys.argv[2], sys.argv[3]
    note = note_of(open(path).read())
    if not note:
        print("(nothing said: no note)")
        return 0
    if not base:
        print("(not said: no bridge address; set CONSOLE_URL or CHAT_URL in ~/.config/commons/env)")
        return 1
    # Plain text only: tellraw takes JSON, and json.dumps does the quoting.
    command = "tellraw @a " + json.dumps({"text": f"<Caretaker> {name}: {note[:480]}"}, ensure_ascii=False)
    request = urllib.request.Request(base.rstrip("/") + "/command", data=json.dumps({"command": command}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as reply:
            reply.read()
    except Exception as error:  # the note is already on file; a failed delivery must not fail the pass
        print(f"(not said: {error})")
        return 1
    print("(said in chat)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
