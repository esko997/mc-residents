#!/usr/bin/env bash
# Current and last run of each resident of THIS host, and the caretaker.
#   run-status.sh [--json]
set -euo pipefail
exec python3 "$(dirname "$(readlink -f "$0")")/runctl.py" status "$@"
