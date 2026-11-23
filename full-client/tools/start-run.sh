#!/usr/bin/env bash
# Start residents of THIS host until one absolute end time (America/New_York).
#
#   start-run.sh Gary Margo --end '2026-11-24 01:00'          # or --end-at <unix seconds>
#   start-run.sh --all --end-at 1795500000 --model Margo=gpt-6.2-sol --fresh Gary \
#       --caretaker on --caretaker-interval 25 --caretaker-speak keep --by switchyard --json
#
# Defaults (model, caretaker) come from $GARY_CLIENT_HOME/run.conf; personas and game
# dirs from instances/<Name>.env. A resident resumes its Codex thread unless --fresh.
# Refuses a past or >24 h deadline, and any run/body already active with another end
# time. Exit codes and the JSON reply: runctl.py and commons/docs/run-controller.md.
set -euo pipefail

# ============================================================================
# START GATE (G1, Switchyard generation token) -- the one place to implement it.
#
# Called by runctl.py after every argument and conflict check and with the host's
# control lock held, immediately before the first systemd-run, with one argument per
# component about to start: `resident-<name>` (lowercase) and `caretaker-<host>`.
# Switchyard will issue ~/.local/state/switchyard/tokens/minecraft-residents/<component>.token;
# the check is NOT implemented yet: this hook is a no-op that admits everything.
#
# Contract: return 0 to admit; return 77 (reserved: "start gate refused") to refuse,
# with one line on stderr saying why. Any other non-zero status is also treated as a
# refusal (fail closed) and reported as exit 77 by start-run.sh. Nothing has been
# started when the gate refuses; a refusal is never retried automatically.
# ============================================================================
start_gate() { # <component>...
  return 0
}

if [ "${1:-}" = __start-gate ]; then
  shift
  start_gate "$@"
  exit $?
fi
exec python3 "$(dirname "$(readlink -f "$0")")/runctl.py" start "$@"
