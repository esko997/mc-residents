#!/usr/bin/env bash
# Run a local script (stdin) that accesses the Minecraft server host under its canonical lock.
# Use $POPOS_SSH for SSH; write the observed outcome to $POPOS_NOTE before returning.
set -uo pipefail
scope=${1:?usage: with-popos.sh <scope> < script}
ledger=/var/home/swatson/rom-cleanup/DEVICE_ACCESS_POPOS.md
owner=${POPOS_OWNER:-omp-minecraft-residents}
exec 9>>"$ledger"
if ! flock -n 9; then
  echo "pop-os is locked by another session; deferring." >&2
  exit 75
fi
echo "--- ledger tail ---" >&2
tail -n 3 "$ledger" | cut -c1-300 >&2
echo "-------------------" >&2
export POPOS_NOTE POPOS POPOS_SSH
POPOS_NOTE=$(mktemp)
POPOS=swatson@192.168.1.233
POPOS_SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $POPOS"
status=interrupted-before-exit-status
release() {
  local note
  note=$(tr '\n' ' ' < "$POPOS_NOTE" | cut -c1-600)
  rm -f "$POPOS_NOTE"
  printf '%s RELEASE owner=%s scope=%s exit=%s %s\n' "$(date -Iseconds)" "$owner" "$scope" "$status" "$note" >&9
}
trap release EXIT
printf '%s CLAIM owner=%s worktree=%s scope=%s\n' "$(date -Iseconds)" "$owner" "$PWD" "$scope" >&9
bash -s
status=$?
exit "$status"
