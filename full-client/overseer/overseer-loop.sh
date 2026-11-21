#!/usr/bin/env bash
# Run the caretaker for each resident every <interval> minutes until a clock time.
#
#   systemd-run --user --unit=overseer-run ~/gary-client/overseer/overseer-loop.sh 13:20 55 Gary:gary Margo:margo
set -uo pipefail

until_clock=${1:?usage: overseer-loop.sh <HH:MM> <interval-minutes> <Name:persona>...}
interval=${2:?usage: overseer-loop.sh <HH:MM> <interval-minutes> <Name:persona>...}
shift 2
here=$(cd "$(dirname "$0")" && pwd)
end_at=$(date -d "$until_clock" +%s) || exit 2
[ "$end_at" -le "$(date +%s)" ] && end_at=$((end_at + 86400))

while :; do
  left=$(( end_at - $(date +%s) ))
  [ "$left" -le 0 ] && break
  sleep $(( left < interval * 60 ? left : interval * 60 ))
  for resident in "$@"; do
    "$here/overseer.sh" "${resident%%:*}" "${resident##*:}" "$interval"
    echo "$(date '+%F %H:%M') caretaker for ${resident%%:*} ended with status $?"
  done
done
