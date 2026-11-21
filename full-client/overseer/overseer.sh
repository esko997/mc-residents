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

$name has standing aims, quoted below from its own instructions. How it pursues them is its own choice: never give it orders, plans or step-by-step advice. Your note may only:
- state a fact it seems to have missed or got wrong, with the evidence (time, coordinates, the tool reply);
- point out means it has and is not using, with numbers (for example seeds and a hoe carried while the field has two crops, cobblestone and no furnace);
- point out repetition, or how its last hour compares with its aims, with counts (for example the same check run 30 times while no aim moved);
- ask one question.
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
