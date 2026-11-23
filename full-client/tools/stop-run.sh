#!/usr/bin/env bash
# Stop residents of THIS host cleanly, and the caretaker once none of them remains.
#
#   stop-run.sh Gary            # one resident; the caretaker keeps the others
#   stop-run.sh --all --by switchyard --json
#
# Stops <name>-run first (run-session.sh takes the body offline and commits the notes),
# then any body still up, then verifies every unit inactive and no client process left
# on the resident's game directory (exit 7 if anything remains). Idempotent.
set -euo pipefail
exec python3 "$(dirname "$(readlink -f "$0")")/runctl.py" stop "$@"
