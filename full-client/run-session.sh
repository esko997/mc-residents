#!/usr/bin/env bash
# One session of a resident on Cachy: bring the body online, let the mind play
# until the end time, take the body offline, and commit what he wrote.
#
#   run-session.sh <username> <persona-dir-name> <minutes> [model]
#
# Start it as a transient user unit so it outlives the SSH session:
#   systemd-run --user --unit=gary-session ~/gary-client/run-session.sh Gary gary 60
set -uo pipefail

name=${1:?usage: run-session.sh <username> <persona> <minutes> [model]}
persona=${2:?usage: run-session.sh <username> <persona> <minutes> [model]}
minutes=${3:?usage: run-session.sh <username> <persona> <minutes> [model]}
model=${4:-gpt-6-luna}

base=${GARY_CLIENT_HOME:-$HOME/gary-client}
home=$base/resident/$persona
unit="gary-client@$name.service"
log=$base/game/logs/latest.log
mkdir -p "$base/sessions"
session_log=$base/sessions/$(date +%Y%m%d-%H%M)-$name.log

finish() {
  systemctl --user stop "$unit"
  # His sandbox cannot write .git, so his notes are committed here.
  git -C "$base/resident" add -A
  git -C "$base/resident" commit -q -m "journal($persona): session $(date '+%F %H:%M')" || true
}
trap finish EXIT

# A client left over from an earlier run has an old log; always start fresh.
systemctl --user stop "$unit" 2>/dev/null
systemctl --user reset-failed "$unit" 2>/dev/null
rm -f "$log"
systemctl --user start "$unit"
for _ in $(seq 1 60); do
  grep -qa "Time from main menu to in-game" "$log" 2>/dev/null && break
  if [ "$(systemctl --user is-active "$unit")" != active ]; then
    echo "the client stopped before joining the server" | tee -a "$session_log"
    exit 1
  fi
  sleep 3
done
grep -qa "Time from main menu to in-game" "$log" || { echo "the client did not reach the world in time" | tee -a "$session_log"; exit 1; }

end=$(date -d "+$minutes minutes" +%H:%M)
cd "$home" || exit 1
# The hard limit is a backstop: he is asked to stop himself at the end time.
CODEX_HOME=$base/codex-home timeout "$((minutes * 60 + 300))" "$base/bin/codex" exec \
  --skip-git-repo-check -s workspace-write -m "$model" \
  -c "mcp_servers.body.env.RESIDENT_NAME=\"$name\"" \
  -c "mcp_servers.body.env.RESIDENT_DIR=\"$home\"" \
  "It is $(date +%H:%M). Play until $end." < /dev/null >> "$session_log" 2>&1
echo "session ended with status $? at $(date +%H:%M)" >> "$session_log"
