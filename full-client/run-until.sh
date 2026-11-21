#!/usr/bin/env bash
# Keep a resident in the world until a clock time, as back-to-back sessions.
# Every session starts a fresh client and fresh tools, so new code deployed to
# this machine is picked up at the next session boundary.
#
#   run-until.sh <username> <persona-dir-name> <HH:MM> [session-minutes] [model]
#
#   systemd-run --user --unit=gary-night ~/gary-client/run-until.sh Gary gary 08:00
#
# To pick up new code sooner, end the current session; the next starts at once:
#   pkill -TERM -f 'gary-client/bin/codex exec'
#
# FIRST_NOTE, when set, is one-off news for the first session only.
set -uo pipefail

name=${1:?usage: run-until.sh <username> <persona> <HH:MM> [session-minutes] [model]}
persona=${2:?usage: run-until.sh <username> <persona> <HH:MM> [session-minutes] [model]}
until_clock=${3:?usage: run-until.sh <username> <persona> <HH:MM> [session-minutes] [model]}
session_minutes=${4:-60}
model=${5:-gpt-6-luna}

base=${GARY_CLIENT_HOME:-$HOME/gary-client}
end_at=$(date -d "$until_clock" +%s) || exit 2
# A clock time that has already passed today means tomorrow.
[ "$end_at" -le "$(date +%s)" ] && end_at=$((end_at + 86400))
note=${FIRST_NOTE:-}

while :; do
  left=$(( (end_at - $(date +%s)) / 60 ))
  [ "$left" -lt 5 ] && break
  minutes=$(( left < session_minutes ? left : session_minutes ))
  SESSION_NOTE=$note "$base/run-session.sh" "$name" "$persona" "$minutes" "$model"
  status=$?
  note=
  echo "$(date '+%F %H:%M') session ended with status $status"
  case $status in
    # Finished, hit its time backstop, or was ended on purpose for new code.
    0 | 124 | 143) ;;
    # Anything else (login, rate limit, client would not start) will not be
    # fixed by retrying at once.
    *) sleep 600 ;;
  esac
done
