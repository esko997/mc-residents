#!/usr/bin/env bash
# The caretaker: a stronger model reads what one resident did lately and writes
# at most one short note for it, plus a line for the humans who maintain its
# body. Every note is appended to overseer/<Name>.md. By default that is all
# (shadow mode). When the file overseer/speak exists, the note is also said in
# the game's chat as `<Caretaker> <Name>: ...`, through the server-console
# bridge of the phone-chat service; delete the file to go back to shadow.
#
#   overseer.sh <Name> <persona-dir-name> [minutes] [extra digest arguments]
#
# Runs in its own empty directory so no resident persona is loaded, read-only,
# and with the body tools switched off: a second tool server attached to a
# resident's client would run a second set of reflexes.
set -uo pipefail

name=${1:?usage: overseer.sh <Name> <persona> [minutes]}
persona=${2:?usage: overseer.sh <Name> <persona> [minutes]}
minutes=${3:-60}
shift; shift; [ $# -gt 0 ] && shift
model=${OVERSEER_MODEL:-gpt-6.2-astra}

base=${GARY_CLIENT_HOME:-$HOME/gary-client}
SYNAPSE_URL=http://127.0.0.1:25599
# shellcheck source=/dev/null
[ -f "$base/instances/$name.env" ] && . "$base/instances/$name.env"
work=$base/overseer
mkdir -p "$work/empty"

digest=$(python3 "$work/digest.py" "$name" "$base/resident/$persona" "$minutes" --synapse "$SYNAPSE_URL" "$@") || exit 1
# Its standing aims, as its persona states them, so the note can measure time against them.
aims=$(awk '/^## What you are working towards/{on=1; next} /^## /{on=0} on' "$base/resident/$persona/AGENTS.md" 2>/dev/null)

prompt="You are the caretaker of $name, an AI model that lives as a player in a modded Minecraft 1.20.1 world and plays through body tools (go_to, mine, craft, use, say and others). About once an hour you read what it did and may leave it ONE short note.

$name has standing visions, quoted below from its own instructions. Its projects connect these visions to observable outcomes and short action plans. How it pursues them is its choice: never dictate a full plan or invent a new vision. Your note may:
- state a missed or mistaken fact, citing the observation, coordinates or tool reply;
- point out a stalled prerequisite, a relevant guide query, or an unused resource/verified skill with evidence;
- point out a useful collaboration or shared facility, without assuming permission or that another resident has promised work;
- contrast observed outcomes with the project's done_when criterion: checked steps and written claims are not proof of a working result;
- ask one question about a blocker or what a newly established capability enables.
Prefer a small useful nudge, not another checklist. Survival means dependable access, not everyone owning a duplicate farm. A plan's evidence is resident-reported; distinguish it from tool observations. Count useful world changes, not verbosity or calls. Repeated checking, planning or skill-writing without an outcome can itself be a stall.
Treat social records as voluntary, dated reports: accepted is not delivered, reported is not recipient-confirmed, and neither is automatic world proof. Stock observations older than thirty minutes may already be wrong. A paused/failed body needs a maintainer alert, not gameplay advice or pressure to retry. Do not restart or administer clients.
New researched references may answer an existing blocker; point to their ref-N guide handle when useful, preserving uncertainty and version limits. Chosen exploration, conversations and aesthetic work are not stalls merely because they do not advance a checklist. Do not make reflection or documentation into recurring chores.
If it is doing fine, leave no note. A needless note is worse than none.

Its standing aims:
${aims:-(none stated)}

Answer in exactly this form, plain text, no Markdown:
NOTE: <at most 60 words addressed to $name as 'you', or the single word none>
MAINTAINERS: <at most 80 words for the humans who maintain its body: tool or harness problems you can see in the record, or none>

Here is the record.

$digest"

out=$(mktemp)
(cd "$work/empty" && CODEX_HOME=$base/codex-home timeout 300 "$base/bin/codex" exec \
  --skip-git-repo-check --ephemeral -s read-only -m "$model" \
  -c 'mcp_servers.body.enabled=false' -o "$out" "$prompt" < /dev/null > "$work/last-$name.log" 2>&1)
status=$?
mode=shadow
[ -e "$work/speak" ] && mode=spoken
{
  echo; echo "## $(date '+%F %H:%M') (last $minutes min, $model, $mode)"
  if [ "$status" -eq 0 ] && [ -s "$out" ]; then cat "$out"; else echo "(no answer: codex exit $status; see last-$name.log)"; fi
} >> "$work/$name.md"
if [ "$mode" = spoken ] && [ "$status" -eq 0 ] && [ -s "$out" ]; then
  # The bridge address is the one the web app uses.
  # shellcheck source=/dev/null
  [ -f "$HOME/.config/commons/env" ] && . "$HOME/.config/commons/env"
  python3 "$work/speak.py" "$name" "$out" "${CONSOLE_URL:-${CHAT_URL:-}}" >> "$work/$name.md" 2>&1 || true
fi
rm -f "$out"
# The same caretaker also looks over what residents put in the commons since
# its last pass. This part is not shadow: its verdicts take effect, and a person
# can undo them in the web app. It returns at once when nothing is new.
python3 "$work/commons-review.py" >> "$work/last-commons-review.log" 2>&1 || true
exit "$status"
