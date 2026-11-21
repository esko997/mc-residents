#!/usr/bin/env python3
"""The caretaker's pass over the commons: shared notes and verified skills that
no person and no caretaker has looked at yet.

    commons-review.py [--db PATH] [--model NAME] [--dry-run]

Items are already visible to the residents (notes are accepted automatically,
skills once they pass their own check), so this is review after the fact: keep,
comment, or remove with a reason the author will read. A person can undo any of
it in the Commons web app. Exits at once when there is nothing new.
"""
import argparse, json, os, re, sqlite3, subprocess, sys, tempfile, time

BASE = os.path.expanduser(os.environ.get("GARY_CLIENT_HOME", "~/gary-client"))
LOOKED = "reviewer != 'auto'"


def pending(db):
    # A note still `proposed` (the web app's automatic acceptance is off or has not run) is reviewed too.
    notes = db.execute(f"""SELECT id, author, topic, text FROM shared_notes WHERE status IN ('proposed', 'curated')
        AND NOT EXISTS (SELECT 1 FROM reviews WHERE kind = 'note' AND target_id = shared_notes.id AND {LOOKED})""").fetchall()
    skills = db.execute(f"""SELECT id, name, author, description, code, expect_json, version FROM skills WHERE status = 'verified'
        AND NOT EXISTS (SELECT 1 FROM reviews WHERE kind = 'skill' AND target_id = skills.id AND {LOOKED})""").fetchall()
    return notes, skills


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.environ.get("COMMONS_DB", os.path.join(BASE, "commons-data", "commons.sqlite")))
    parser.add_argument("--model", default=os.environ.get("OVERSEER_MODEL", "gpt-6.2-astra"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not os.path.exists(args.db):
        return 0
    db = sqlite3.connect(args.db, timeout=5)
    db.row_factory = sqlite3.Row
    notes, skills = pending(db)
    if not notes and not skills:
        return 0

    parts = []
    for note in notes:
        parts.append(f"note {note['id']} by {note['author']}, topic \"{note['topic']}\":\n{note['text']}")
    for skill in skills:
        runs = db.execute("SELECT COUNT(*) total, COALESCE(SUM(check_ok = 1), 0) passed, COUNT(DISTINCT resident) residents FROM skill_runs WHERE skill_id = ? AND version = ?", (skill["id"], skill["version"])).fetchone()
        parts.append(f"skill {skill['id']} \"{skill['name']}\" by {skill['author']}: {skill['description']}\ncheck: {skill['expect_json']}\nruns of this version: {runs['passed']} of {runs['total']} passed its check, {runs['residents']} resident(s)\ncode:\n{skill['code'][:1500]}")

    prompt = """You look after a shared library used by AI residents who live as players in a modded Minecraft 1.20.1 world (mods include Immersive Engineering, Refined Storage, Occultism and others you may not know well). Residents put notes (facts or methods in prose) and skills (JavaScript routines over their body tools: go_to, mine, craft, use, state() and so on) into it. Everything below is already visible to all of them. Review each item after the fact.

Verdicts:
- keep: nothing wrong with it.
- comment: probably fine, but something the author or a later reader should know; say it.
- reject: only when you are confident it states something false, or would mislead, or a skill would harm the resident or other players' builds (for example by switching off its rescue reflexes, or digging through someone's house). Rejecting removes it from the residents' view and the author reads your reason. When you do not know a mod well enough to judge a claim about it, do not reject: keep or comment.

Answer with exactly one line per item and nothing else:
note <id>: keep|comment|reject - <reason, at most 30 words, plain text>
skill <id>: keep|comment|reject - <reason, at most 30 words, plain text>

Items:

""" + "\n\n".join(parts)

    work = os.path.join(BASE, "overseer", "empty")
    os.makedirs(work, exist_ok=True)
    with tempfile.NamedTemporaryFile("r", suffix=".txt") as out:
        result = subprocess.run(
            [os.path.join(BASE, "bin", "codex"), "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", args.model,
             "-c", "mcp_servers.body.enabled=false", "-o", out.name, prompt],
            cwd=work, env={**os.environ, "CODEX_HOME": os.path.join(BASE, "codex-home")},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
        answer = out.read()
    if result.returncode != 0 or not answer.strip():
        print(f"commons review: no answer (codex exit {result.returncode})", file=sys.stderr)
        return 1

    known = {("note", row["id"]) for row in notes} | {("skill", row["id"]) for row in skills}
    now = int(time.time() * 1000)
    applied = []
    for kind, target, verdict, reason in re.findall(r"^(note|skill) (\d+): (keep|comment|reject)\b\s*-?\s*(.*)$", answer, re.M):
        key = (kind, int(target))
        if key not in known:
            continue  # an id the model made up
        known.discard(key)
        reason = reason.strip()[:300]
        applied.append(f"{kind} {target}: {verdict} - {reason}")
        if args.dry_run:
            continue
        db.execute("INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES (?, ?, 'caretaker', ?, ?, ?)", (kind, int(target), verdict, reason, now))
        if verdict == "reject":
            table = "shared_notes" if kind == "note" else "skills"
            db.execute(f"UPDATE {table} SET status = 'rejected', updated_at = ? WHERE id = ?", (now, int(target)))
        elif kind == "note":
            db.execute("UPDATE shared_notes SET status = 'curated', updated_at = ? WHERE id = ? AND status = 'proposed'", (now, int(target)))
        elif verdict == "keep":
            db.execute("UPDATE skills SET status = 'curated', updated_at = ? WHERE id = ? AND status = 'verified'", (now, int(target)))
    db.commit()
    with open(os.path.join(BASE, "overseer", "commons-reviews.md"), "a") as log:
        log.write(f"\n## {time.strftime('%F %H:%M')} ({args.model}{', dry run' if args.dry_run else ''})\n" + "\n".join(applied or ["(no usable verdict lines)"]) + "\n")
    print("\n".join(applied))
    return 0


if __name__ == "__main__":
    sys.exit(main())
