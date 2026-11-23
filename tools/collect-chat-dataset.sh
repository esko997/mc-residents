#!/usr/bin/env bash
# Mirror everything needed to study the residents' chat and behaviour into one
# local directory. Read-only on every host; safe to re-run (rsync is incremental).
#
#   tools/collect-chat-dataset.sh [directory]
#
# The dataset is for offline analysis only: it is not served by Commons and it
# contains people's chat as well as the residents'. Keep it out of the repository.
#
#   server-logs/   the Minecraft server's logs (all of them, UTC timestamps)
#   calls/         every body tool call per resident (t is the call's START time)
#   client-logs/   the [CHAT] lines each resident's client displayed (local time)
#   caretaker/     the caretaker's notes per resident
#
# Known gaps (see research/chat-analysis-2026-11-23.md): the server log lacks
# lines relayed through the phone-chat bridge and the caretaker's tellraw lines;
# those exist only in client logs and in tool-result tails inside calls/.
set -euo pipefail

out=${1:-${CHAT_DATASET_DIR:-$HOME/.local/share/mc-residents/chat-dataset}}
mkdir -p "$out"/{server-logs,calls,client-logs,caretaker}
export out

lease() { # <host> <scope> <local shell snippet using $SWITCHYARD_SSH_TARGET>
  switchyard lease run "$1" --wait 120 --scope "read-only: $2" -- sh -c "$3"
}

lease pop-os "copy Minecraft server logs for the chat dataset" \
  'rsync -a --include="*.log.gz" --include="latest.log" --exclude="*" "$SWITCHYARD_SSH_TARGET:mc-servers/simon_vanilla_plus/mc-data/logs/" "$out/server-logs/"'

# The quoted remote command survives fish, the login shell on some hosts.
chat_lines='for g in ~/gary-client/game ~/gary-client/game-*; do [ -d "$g/logs" ] || continue; n=$(basename "$g"); [ "$n" = game-test ] && continue; echo "@@ $n"; zcat -f "$g"/logs/20*.log.gz "$g"/logs/latest.log 2>/dev/null | grep -a "\[CHAT\]" || true; done'
for host in inspiron chungus1; do
  lease "$host" "copy call logs, caretaker notes and client chat lines for the chat dataset" \
    'rsync -a "$SWITCHYARD_SSH_TARGET:gary-client/calls/" "$out/calls/" &&
     rsync -a --include="[A-Z]*.md" --exclude="*" "$SWITCHYARD_SSH_TARGET:gary-client/overseer/" "$out/caretaker/" &&
     ssh -o BatchMode=yes "$SWITCHYARD_SSH_TARGET" /bin/bash -s <<<'"'$chat_lines'"' |
       awk -v dir="$out/client-logs" '"'"'/^@@ /{f=dir "/" $2 ".chat.log"; printf "" > f; next} f{print > f}'"'"
done

du -sh "$out"/* | sed 's/^/  /'
echo "dataset: $out"
