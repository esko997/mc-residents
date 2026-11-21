#!/usr/bin/env bash
# Restart a resident's host when its runtime has stopped itself.
#
# mine-ai-mcp's supervisor kills the bot runtime when its event loop stalls
# (seen 2026-11-20 inside build_structure) and then stays up reporting
# "requires a restart", which leaves the resident in the world with no body.
set -uo pipefail

unit=${1:?usage: watch-host.sh <systemd-user-unit> [listen-port]}
port=${2:-25575}

while sleep 15; do
  state=$(curl -s -m 5 "http://127.0.0.1:$port/health" | jq -r '.runtime.state // empty' 2>/dev/null)
  if [ "$state" = failed ]; then
    echo "runtime failed; restarting $unit"
    systemctl --user restart "$unit"
    sleep 60 # let it rejoin, and never hammer a server that is down
  fi
done
