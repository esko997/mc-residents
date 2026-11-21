#!/usr/bin/env bash
# Start one resident's Minecraft body: a mine-ai-mcp host that joins
# simons-vanilla-plus (Forge 1.20.1 on pop-os) and serves MCP on localhost.
# The resident's agent session reaches it through <resident>/.codex/config.toml.
#
# The username must already be in the server's whitelist.json with its
# offline UUID; `whitelist add` cannot do that for a mixed-case name.
set -euo pipefail

name=${1:?usage: run-host.sh <username> [listen-port]}
port=${2:-25575}

cd "$HOME/Repos/mine-ai-mcp"
exec bun src/server/host.ts \
  --minecraft-host 192.168.1.233 --minecraft-port 25570 \
  --version 1.20.1 --forge-handshake fml3 \
  --username "$name" --instance-id "$name" --listen-port "$port"
