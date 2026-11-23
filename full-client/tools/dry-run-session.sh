#!/usr/bin/env bash
# Stand-in for run-session.sh / overseer-loop.sh when start-run.sh --dry-run is used:
# the same transient units, deadline and stop path, with no mind and no model call.
#
#   dry-run-session.sh <Name> <persona> 0 <model>      (resident form)
#   dry-run-session.sh <HH:MM> <interval> Name:persona... (caretaker form)
#
# The resident form also starts the real body when RESIDENTS_DRY_RUN_BODY names its
# client unit (start-run.sh --dry-run-body); otherwise it only waits.
# Either way it waits until SESSION_END_AT and takes the body offline on exit/stop.
set -uo pipefail
end_at=${SESSION_END_AT:?SESSION_END_AT is required}
unit=
if [[ ! ${1:-} =~ ^[0-9]{2}:[0-9]{2}$ ]]; then
  : "${1:?usage: dry-run-session.sh <Name> <persona> 0 <model>}"
  [[ ${RESIDENTS_DRY_RUN_BODY:-} =~ ^[A-Za-z0-9_@.-]+\.service$ ]] && unit=$RESIDENTS_DRY_RUN_BODY
fi
echo "dry run: $* until $(date -d "@$end_at" '+%F %H:%M %Z'); body ${unit:-not started}; no model calls"
finish() {
  trap '' TERM INT HUP
  [ -n "$unit" ] && systemctl --user stop "$unit"
  echo "dry run: finished at $(date '+%H:%M:%S')"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP
if [ -n "$unit" ]; then
  systemctl --user reset-failed "$unit" 2>/dev/null
  systemctl --user start "$unit" || exit 10
fi
while [ "$(date +%s)" -lt "$end_at" ]; do sleep 1 & wait $!; done
