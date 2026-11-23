#!/usr/bin/env bash
# Run the caretaker for each resident every <interval> minutes until a clock time.
#
#   systemd-run --user --unit=overseer-run ~/gary-client/overseer/overseer-loop.sh 13:20 55 Gary:gary Margo:margo
set -uo pipefail

until_clock=${1:?usage: overseer-loop.sh <HH:MM> <interval-minutes> <Name:persona>...}
interval=${2:?usage: overseer-loop.sh <HH:MM> <interval-minutes> <Name:persona>...}
shift 2
here=$(cd "$(dirname "$0")" && pwd)
set -a
for config in "$HOME/.config/commons/env" "$HOME/.config/commons/caretaker.env"; do
  # shellcheck source=/dev/null
  [ -f "$config" ] && . "$config"
done
set +a
export COMMONS_ROLE=${COMMONS_ROLE:-hub}
case "$COMMONS_ROLE" in
  hub|station) ;;
  *) echo "COMMONS_ROLE must be hub or station" >&2; exit 2 ;;
esac
end_at=${SESSION_END_AT:-$(date -d "$until_clock" +%s)} || exit 2
[[ $end_at =~ ^[0-9]+$ && $interval =~ ^[1-9][0-9]*$ ]] || exit 2
if [ -z "${SESSION_END_AT:-}" ] && [ "$end_at" -le "$(date +%s)" ]; then
  end_at=$(date -d "tomorrow $until_clock" +%s) || exit 2
fi

while :; do
  left=$(( end_at - $(date +%s) ))
  [ "$left" -le 0 ] && break
  sleep $(( left < interval * 60 ? left : interval * 60 ))
  for resident in "$@"; do
    left=$(( end_at - $(date +%s) ))
    [ "$left" -le 0 ] && break
    timeout --kill-after=5 "$left" "$here/overseer.sh" "${resident%%:*}" "${resident##*:}" "$interval"
    echo "$(date '+%F %H:%M') caretaker for ${resident%%:*} ended with status $?"
  done
  left=$(( end_at - $(date +%s) ))
  [ "$left" -le 0 ] && break
  if [ "$COMMONS_ROLE" = hub ]; then
    timeout --kill-after=5 "$left" python3 "$here/knowledge-research.py" >> "$here/last-knowledge-research.log" 2>&1
  fi
done
