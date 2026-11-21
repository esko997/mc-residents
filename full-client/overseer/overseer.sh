#!/usr/bin/env bash
# The caretaker: a stronger model reads what one resident did lately and writes
# at most one short note for it, plus a line for the humans who maintain its
# body. SHADOW MODE: the note is only appended to overseer/<Name>.md for people
# to read. Nothing here reaches the resident.
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

prompt="You are the caretaker of $name, an AI model that lives as a player in a modded Minecraft 1.20.1 world and plays through body tools (go_to, mine, craft, use, say and others). About once an hour you read what it did and may leave it ONE short note.

$name decides its own life. Never give it goals, plans, orders or advice about what to want. Your note may only:
- state a fact it seems to have missed or got wrong, with the evidence (time, coordinates, the tool reply);
- point out repetition, with counts;
- ask one question.
If it is doing fine, leave no note. A needless note is worse than none.

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
{
  echo; echo "## $(date '+%F %H:%M') (last $minutes min, $model, shadow)"
  if [ "$status" -eq 0 ] && [ -s "$out" ]; then cat "$out"; else echo "(no answer: codex exit $status; see last-$name.log)"; fi
} >> "$work/$name.md"
rm -f "$out"
exit "$status"
