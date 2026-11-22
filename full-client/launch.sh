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

# Opt-in slim profiles live in their own derived game directory
# (tools/client-profile.py derive). Before every start of one, re-apply its
# options and Synapse port; GARY_CLIENT_PROFILE (instances/<name>.env) makes a
# missing or different profile a hard error instead of a silent full client.
# A game directory without a profile marker and no GARY_CLIENT_PROFILE launches
# exactly as before.
profile=${GARY_CLIENT_PROFILE:-}
if [ -n "$profile" ] || [ -f "$game/.client-profile.json" ]; then
  "${GARY_CLIENT_PYTHON:-python3}" "${GARY_CLIENT_PROFILE_TOOL:-$base/tools/client-profile.py}" \
    launch-check --game "$game" ${profile:+--expect "$profile"} || exit 2
fi

# The framebuffer, not the heap, is what resolution sizes. Below 640x480 the
# GUI can only render at scale 1, which leaves mod screens unreadable in
# pictures; the Commons view also assumes 854x480's aspect ratio.
resolution=${GARY_CLIENT_RESOLUTION:-854x480}
if [[ ! $resolution =~ ^([0-9]{3,4})x([0-9]{3,4})$ ]] ||
   (( 10#${BASH_REMATCH[1]} < 640 || 10#${BASH_REMATCH[2]} < 480 )); then
  echo "GARY_CLIENT_RESOLUTION must be WIDTHxHEIGHT, at least 640x480: $resolution" >&2
  exit 2
fi
width=$((10#${BASH_REMATCH[1]})) height=$((10#${BASH_REMATCH[2]}))

display=()
case "$backend" in
  x11)
    export DISPLAY=${DISPLAY:-:0}
    export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
    ;;
  headless) display=(gamescope --backend headless -W "$width" -H "$height" -r 20 --) ;;
  *) echo "unknown GARY_CLIENT_DISPLAY_BACKEND: $backend" >&2; exit 2 ;;
esac

exec "${display[@]}" "$base/venv/bin/portablemc" --main-dir "$base/main" start \
  --resolution "${width}x${height}" \
  --mc-dir "$game" --jvm "$java" "--jvm-arg=-Xmx$heap" "--jvm-arg=-Xms512m" \
  --username "$name" \
  --join-server 192.168.1.233 --join-server-port 25570 \
  forge::1.20.1-47.4.10
