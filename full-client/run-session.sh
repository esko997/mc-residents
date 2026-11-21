#!/usr/bin/env bash
# One session of a resident on Cachy: bring the body online, let the mind play
# until the end time, take the body offline, and commit what it wrote.
#
#   run-session.sh <username> <persona-dir-name> <minutes> [model]
#
# The model picks the harness: `claude:<model>` runs Claude Code (for example
# `claude:claude-haiku-4-5`); anything else is a Codex model.
#
# instances/<username>.env, when present, sets GAME_DIR and SYNAPSE_URL for a
# resident that is not Gary. SESSION_NOTE, when set, is appended to the opening
# prompt: one-off news, such as a change to the body.
#
# Start it as a transient user unit so it outlives the SSH session:
#   systemd-run --user --unit=gary-session ~/gary-client/run-session.sh Gary gary 60
set -uo pipefail

name=${1:?usage: run-session.sh <username> <persona> <minutes> [model]}
persona=${2:?usage: run-session.sh <username> <persona> <minutes> [model]}
minutes=${3:?usage: run-session.sh <username> <persona> <minutes> [model]}
model=${4:-gpt-6-luna}

base=${GARY_CLIENT_HOME:-$HOME/gary-client}
GAME_DIR=$base/game
SYNAPSE_URL=http://127.0.0.1:25599
# shellcheck source=/dev/null
[ -f "$base/instances/$name.env" ] && . "$base/instances/$name.env"
home=$base/resident/$persona
# Each harness reads its own persona file. Started with the wrong model, a
# resident would play with no persona at all (Margo moved from Claude Code to
# Codex; her old start command named a Claude model), so refuse instead.
case $model in claude:*) persona_file=CLAUDE.md ;; *) persona_file=AGENTS.md ;; esac
if [ ! -f "$home/$persona_file" ]; then
  echo "$name is not set up for model $model: $home has no $persona_file" >&2
  exit 2
fi
unit="gary-client@$name.service"
log=$GAME_DIR/logs/latest.log
mkdir -p "$base/sessions"
session_log=$base/sessions/$(date +%Y%m%d-%H%M)-$name.log

finish() {
  systemctl --user stop "$unit"
  # The mind's sandbox cannot write .git, so its notes are committed here.
  git -C "$base/resident" add -A
  git -C "$base/resident" commit -q -m "journal($persona): session $(date '+%F %H:%M')" || true
}
trap finish EXIT
# Stopping the unit must still take the body offline and commit the notes.
trap 'exit 143' TERM INT HUP

# Tool calls as each harness logs them; used to tell a session that played from
# one whose mind never reached its body.
body_calls() { grep -caE '^mcp: body/|"name":"mcp__body__' "$session_log" 2>/dev/null; }

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

end_at=$(( $(date +%s) + minutes * 60 ))
end=$(date -d "@$end_at" +%H:%M)
cd "$home" || exit 1

body_env() {
  printf '{"CLIENT_LOG":"%s","SYNAPSE_URL":"%s","RESIDENT_NAME":"%s","RESIDENT_DIR":"%s","KNOWLEDGE_DB":"%s"}' \
    "$log" "$SYNAPSE_URL" "$name" "$home" "$base/knowledge.sqlite"
}

run_mind() { # <seconds> <prompt> [Codex thread to resume]
  case $model in
    claude:*)
      local mcp; mcp=$(mktemp)
      printf '{"mcpServers":{"body":{"command":"%s","args":["%s"],"env":%s}}}' \
        "$base/bin/bun" "$base/toolserver/src/main.ts" "$(body_env)" > "$mcp"
      # Its own config directory keeps the owner's Claude settings, memory and
      # MCP servers out. dontAsk refuses everything not listed, so it can use its
      # body, its own notes and the clock, and nothing else. --tools drops the
      # other built-ins (Haiku spawned Task agents and set wakeups), and with tool
      # search off the body's schemas are in the prompt: deferred, Haiku spent
      # 41 calls loading them and guessed arguments ("Invalid input").
      CLAUDE_CONFIG_DIR=$base/claude-home DISABLE_AUTOUPDATER=1 ENABLE_TOOL_SEARCH=false \
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30 MCP_TOOL_TIMEOUT=180000 \
        timeout "$1" "$base/bin/claude" -p "$2" --model "${model#claude:}" \
        --mcp-config "$mcp" --strict-mcp-config --permission-mode dontAsk \
        --tools "Read,Edit,Write,Bash" \
        --allowedTools "mcp__body" "Read(./**)" "Edit(./**)" "Write(./**)" "Bash(date)" "Bash(date:*)" \
        --output-format stream-json --verbose < /dev/null >> "$session_log" 2>&1
      local rc=$?; rm -f "$mcp"; return "$rc" ;;
    *)
      local body=(
        -c "mcp_servers.body.env.RESIDENT_NAME=\"$name\""
        -c "mcp_servers.body.env.RESIDENT_DIR=\"$home\""
        -c "mcp_servers.body.env.CLIENT_LOG=\"$log\""
        -c "mcp_servers.body.env.SYNAPSE_URL=\"$SYNAPSE_URL\""
      )
      if [ -n "${3:-}" ]; then
        CODEX_HOME=$base/codex-home timeout "$1" "$base/bin/codex" exec resume \
          --skip-git-repo-check -m "$model" -c 'sandbox_mode="workspace-write"' "${body[@]}" \
          "$3" "$2" < /dev/null >> "$session_log" 2>&1
      else
        CODEX_HOME=$base/codex-home timeout "$1" "$base/bin/codex" exec \
          --skip-git-repo-check -s workspace-write -m "$model" "${body[@]}" \
          "$2" < /dev/null >> "$session_log" 2>&1
      fi ;;
  esac
}

# A model may decide it is finished long before the end time. A Codex mind is
# then resumed as the same thread, so a session is one mind with one history
# however often it stops: that is what a long run is meant to observe. Every
# stop is written to the session log. Claude Code is started afresh instead and
# reads its notes again.
status=0
# memory.md is read at every start; past a couple of pages it crowds out play
# and old conclusions pile up (Margo's reached 127 KB in one night).
memory_note() {
  local bytes=0; [ -f "$home/memory.md" ] && bytes=$(wc -c < "$home/memory.md")
  [ "$bytes" -gt 8000 ] && printf ' Your memory.md has grown to %d KB. Before playing, rewrite it down to a page or two: keep what is still true and matters, and move detail into files under notes/.' $((bytes / 1000))
}
opening="It is $(date +%H:%M). Play until $end.${SESSION_NOTE:+ $SESSION_NOTE}$(memory_note)"
# A fresh run needs a few minutes to be worth starting: near the end, Margo's
# restarts each read her notes, said goodbye in chat and stopped, three times in
# two minutes.
min_left=180
thread=
while :; do
  left=$(( end_at - $(date +%s) ))
  [ "$left" -lt "$min_left" ] && break
  min_left=420
  calls_before=$(body_calls)
  # The hard limit is a backstop: the mind is asked to stop itself at the end time.
  run_mind "$((left + 300))" "$opening" "$thread"
  status=$?
  # Codex prints the thread id at the top of every run.
  case $model in claude:*) ;; *) thread=$(grep -a '^session id: ' "$session_log" | tail -n 1 | awk '{print $3}') ;; esac
  echo "run ended with status $status at $(date +%H:%M)${thread:+ (thread $thread)}" >> "$session_log"
  [ "$status" -ne 0 ] && break
  # A run that never touched the body would otherwise restart in a tight loop.
  [ "$(body_calls)" -eq "${calls_before:-0}" ] && break
  if [ -n "$thread" ]; then
    opening="It is $(date +%H:%M) and the session runs until $end. You stopped early; carry on from where you were. If you already said goodbye in chat, no need to say it again.$(memory_note)"
  else
    opening="It is $(date +%H:%M) and the session runs until $end. You stopped a moment ago; your notes say where you left off. If you already said goodbye in chat, no need to say it again.$(memory_note)"
  fi
done

# The unit must fail when the mind did: a login, model or tool-server problem
# would otherwise look like a quiet, successful session. A run that never used
# the body is such a failure even when the harness itself exits cleanly.
if [ "$status" -eq 0 ] && [ "$(body_calls)" -eq 0 ]; then
  echo "no body tool was ever called; treating the session as failed" >> "$session_log"
  status=3
fi
exit "$status"
