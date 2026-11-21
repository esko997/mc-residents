#!/usr/bin/env bash
# Run a local script (stdin) that talks to Cachy while holding its device lock.
#
#   tools/with-cachy.sh <scope> <<'EOF'
#   ssh -o BatchMode=yes swatson@192.168.1.143 ... < /dev/null
#   echo "what changed on the device" > "$CACHY_NOTE"
#   EOF
#
# Every ssh/scp to Cachy belongs inside one of these blocks. The ledger gets a
# CLAIM before the script runs and a RELEASE after it, carrying the script's
# exit status and whatever it wrote to $CACHY_NOTE. Exit 75 means the device is
# busy: do other work, do not retry in a loop.
set -uo pipefail

scope=${1:?usage: with-cachy.sh <scope> < script}
ledger=/var/home/swatson/rom-cleanup/DEVICE_ACCESS_CACHY.md
owner=${CACHY_OWNER:-omp-minecraft-residents}

exec 9>>"$ledger"
if ! flock -n 9; then
  echo "Cachy is locked by another session; deferring." >&2
  exit 75
fi
echo "--- ledger tail ---" >&2
tail -n 3 "$ledger" | cut -c1-300 >&2
echo "-------------------" >&2

export CACHY_NOTE
CACHY_NOTE=$(mktemp)
export CACHY=swatson@192.168.1.143
export CACHY_SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $CACHY"
status=aborted-before-any-device-access
release() {
  note=$(tr '\n' ' ' < "$CACHY_NOTE" | cut -c1-600)
  rm -f "$CACHY_NOTE"
  printf '%s RELEASE owner=%s scope=%s exit=%s %s\n' "$(date -Iseconds)" "$owner" "$scope" "$status" "$note" >&9
}
trap release EXIT
printf '%s CLAIM owner=%s worktree=%s scope=%s\n' "$(date -Iseconds)" "$owner" "$PWD" "$scope" >&9

bash -s
status=$?
exit "$status"
