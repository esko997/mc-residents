#!/usr/bin/env bash
# Call the Synapse API of the resident's client. Runs on the machine the client
# runs on: the API listens on loopback only.
#
#   synapse.sh GET '/state?mode=summary'
#   synapse.sh POST /player '{"action":"look","yaw":-90,"pitch":0}'
#   synapse.sh GET '/screenshot?format=raw' > shot.png
set -euo pipefail

method=${1:?usage: synapse.sh <GET|POST> <path> [json-body]}
path=${2:?usage: synapse.sh <GET|POST> <path> [json-body]}
base=${SYNAPSE_BASE:-http://127.0.0.1:25599}
token=$(cat "$HOME/.synapse/token")

if [ "$method" = POST ]; then
  exec curl -sS -m 30 -H "X-Synapse-Token: $token" -H 'Content-Type: application/json' -d "${3:-{\}}" "$base$path"
fi
exec curl -sS -m 30 -H "X-Synapse-Token: $token" "$base$path"
