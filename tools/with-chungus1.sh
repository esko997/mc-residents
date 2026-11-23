#!/usr/bin/env bash
# Run a local script (stdin) that talks to Chungus1 while holding its device lock.
#
#   tools/with-chungus1.sh <scope> <<'EOF'
#   ssh -o BatchMode=yes swatson@192.168.1.120 ... < /dev/null
#   echo "what changed on the device" > "$CHUNGUS1_NOTE"
#   EOF
#
# Every ssh/scp to Chungus1 belongs inside one of these blocks. The ledger gets a
# CLAIM before the script runs and a RELEASE after it, carrying the script's
# exit status and whatever it wrote to $CHUNGUS1_NOTE. Exit 75 means the device is
# busy: do other work, do not retry in a loop.
set -uo pipefail

scope=${1:?usage: with-chungus1.sh <scope> < script}
ledger=/var/home/swatson/rom-cleanup/DEVICE_ACCESS_CHUNGUS1.md
owner=${CHUNGUS1_OWNER:-omp-minecraft-residents}

exec 9>>"$ledger"
if ! flock -n 9; then
  echo "Chungus1 is locked by another session; deferring." >&2
  exit 75
fi
echo "--- ledger tail ---" >&2
tail -n 3 "$ledger" | cut -c1-300 >&2
echo "-------------------" >&2

export CHUNGUS1_NOTE
CHUNGUS1_NOTE=$(mktemp)
export CHUNGUS1=swatson@192.168.1.120
export CHUNGUS1_SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $CHUNGUS1"
status=interrupted-before-exit-status
release() {
  note=$(tr '\n' ' ' < "$CHUNGUS1_NOTE" | cut -c1-600)
  rm -f "$CHUNGUS1_NOTE"
  printf '%s RELEASE owner=%s scope=%s exit=%s %s\n' "$(date -Iseconds)" "$owner" "$scope" "$status" "$note" >&9
}
trap release EXIT
printf '%s CLAIM owner=%s worktree=%s scope=%s\n' "$(date -Iseconds)" "$owner" "$PWD" "$scope" >&9

bash -s
status=$?
exit "$status"
