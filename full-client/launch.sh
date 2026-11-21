#!/usr/bin/env bash
# Start a resident's real Minecraft client on Cachy with no window: gamescope's
# headless backend gives it a GPU-rendered display nobody sees, and the client
# joins simons-vanilla-plus on its own.
#
# Run it as a capped transient user service, never from a bare SSH shell
# (logind kills SSH-session children on logout here):
#   systemd-run --user --unit=gary-client -p MemoryMax=10G -p MemoryHigh=9G \
#     -p CPUQuota=400% -p Nice=10 ~/gary-client/launch.sh <username>
set -euo pipefail

name=${1:?usage: launch.sh <username>}
base=${GARY_CLIENT_HOME:-$HOME/gary-client}
java=$HOME/.local/share/PrismLauncher/java/simon-java17/bin/java
heap=${GARY_CLIENT_HEAP:-6G}
# Each resident needs its own game directory: two clients cannot share logs,
# options or the mod's port. Set per resident in instances/<name>.env.
game=${GAME_DIR:-$base/game}
# Baritone reads baritone/settings.txt once at start and rewrites it whenever a
# setting is changed in game, so every start begins from the generated copy
# (full-client/tools/baritone-settings.ts; constructed-looking blocks cost much
# more to break while routing, but remain breakable if no other route exists).
if [ -f "$base/baritone-settings.txt" ]; then
  install -D -m 644 "$base/baritone-settings.txt" "$game/baritone/settings.txt"
else
  echo "no $base/baritone-settings.txt: Baritone keeps the settings already in $game" >&2
fi

exec gamescope --backend headless -W 854 -H 480 -r 20 -- \
  "$base/venv/bin/portablemc" --main-dir "$base/main" start \
  --mc-dir "$game" --jvm "$java" "--jvm-arg=-Xmx$heap" "--jvm-arg=-Xms512m" \
  --username "$name" \
  --join-server 192.168.1.233 --join-server-port 25570 \
  forge::1.20.1-47.4.10
