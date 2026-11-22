#!/usr/bin/env bash
# Start a resident's real Minecraft client and join simons-vanilla-plus.
# Inspiron uses its NVIDIA X11 desktop; set GARY_CLIENT_DISPLAY_BACKEND=headless
# on hosts with gamescope. Run through gary-client@.service for resource limits.
set -euo pipefail

name=${1:?usage: launch.sh <username>}
base=${GARY_CLIENT_HOME:-$HOME/gary-client}
java=${GARY_CLIENT_JAVA:-$base/jdk17/bin/java}
heap=${GARY_CLIENT_HEAP:-4G}
backend=${GARY_CLIENT_DISPLAY_BACKEND:-x11}
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

display=()
case "$backend" in
  x11)
    export DISPLAY=${DISPLAY:-:0}
    export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
    ;;
  headless) display=(gamescope --backend headless -W 854 -H 480 -r 20 --) ;;
  *) echo "unknown GARY_CLIENT_DISPLAY_BACKEND: $backend" >&2; exit 2 ;;
esac

exec "${display[@]}" "$base/venv/bin/portablemc" --main-dir "$base/main" start \
  --resolution 854x480 \
  --mc-dir "$game" --jvm "$java" "--jvm-arg=-Xmx$heap" "--jvm-arg=-Xms512m" \
  --username "$name" \
  --join-server 192.168.1.233 --join-server-port 25570 \
  forge::1.20.1-47.4.10
