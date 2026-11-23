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

command=("${display[@]}" "$base/venv/bin/portablemc" --main-dir "$base/main" start
  --resolution "${width}x${height}"
  --mc-dir "$game" --jvm "$java" "--jvm-arg=-Xmx$heap" "--jvm-arg=-Xms512m"
  --username "$name"
  --join-server 192.168.1.233 --join-server-port 25570
  forge::1.20.1-47.4.10)

# Audio is off unless this resident has an explicitly dedicated sink. Preserve
# the original exec path (and process identity) for every existing deployment.
audio=${GARY_CLIENT_AUDIO_SINK:-}
if [ -z "$audio" ]; then
  exec "${command[@]}"
fi
if [[ ! $audio =~ ^resident_[A-Za-z0-9_]{1,48}$ ]]; then
  echo "resident audio requires a dedicated resident_ sink name" >&2
  exit 2
fi
for tool in pactl python3 setsid timeout; do
  if ! command -v "$tool" >/dev/null; then
    echo "resident audio requires Pulse control, Python 3 and session isolation" >&2
    exit 2
  fi
done

module= child= router= creating=0
pulse_control() { timeout 5s pactl "$@"; }
# Never reuse a sink, including one left behind by another client. Only the
# module created below may be unloaded, and the game process group dies first.
owned_module() {
  pulse_control list short modules 2>/dev/null | python3 -c '
import re,sys
try:
    modules=[line.rstrip("\n").split("\t") for line in sys.stdin]
    found=[m for m in modules if len(m)>=3 and m[1]=="module-null-sink"
           and ("sink_name="+sys.argv[2]) in m[2].split()
           and re.search(r"resident[.]launch_id="+re.escape(sys.argv[3])+r"(?![0-9])",m[2])]
    if len(found)>1: sys.exit(1)
    if found and sys.argv[1] and found[0][0]!=sys.argv[1]: sys.exit(1)
    print(found[0][0] if found else "")
except Exception: sys.exit(1)
' "$module" "$audio" "$$"
}
cleanup_audio() {
  local result=$?
  trap - EXIT
  trap '' HUP INT TERM
  # Stop the stream router first so no Pulse call of ours overlaps the unload.
  if [ -n "$router" ]; then
    kill -TERM "$router" 2>/dev/null || true
    wait "$router" 2>/dev/null || true
  fi
  # Also covers a signal between spawning the game and assigning $!.
  if [ -z "$child" ]; then child=$(jobs -pr | head -n 1); fi
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    kill -TERM "$child" 2>/dev/null || true
    for ((attempt=0; attempt<20; attempt++)); do
      kill -0 -- "-$child" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$child" 2>/dev/null || true
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  # The launch marker also covers termination after load-module succeeded but
  # before its command substitution assigned the returned module ID.
  if [ -n "$module" ] || [ "$creating" = 1 ]; then
    local owned
    if owned=$(owned_module); then
      if [ -n "$owned" ]; then
        pulse_control unload-module "$owned" >/dev/null 2>&1 || {
          echo "resident audio cleanup could not unload its owned null sink" >&2
          result=2
        }
      fi
    else
      echo "resident audio cleanup could not verify ownership; refusing to unload another module" >&2
      result=2
    fi
  fi
  exit "$result"
}
trap cleanup_audio EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
audio_error() { echo "$1" >&2; exit 2; }

# A pre-existing default is required: never install the first/default device.
default_sink=$(pulse_control get-default-sink 2>/dev/null) || audio_error "resident audio cannot read the existing Pulse default sink"
[ -n "$default_sink" ] || audio_error "resident audio requires an existing default sink"
existing=$(pulse_control list short sinks 2>/dev/null) || audio_error "resident audio cannot inspect Pulse sinks"
if awk -v sink="$audio" '$2 == sink { found=1 } END { exit !found }' <<< "$existing"; then
  audio_error "resident audio sink already exists; reuse is refused"
fi
# Abstract/virtual sinks are ignored by the normal switch-on-connect policy.
# Do not export PULSE_SINK globally or change any user's default audio device.
creating=1
# The property list is quoted: real PulseAudio splits module arguments on
# spaces (PipeWire's Pulse server accepts both forms).
module=$(pulse_control load-module module-null-sink "sink_name=$audio" \
  "sink_properties='device.description=Resident_game_audio device.class=abstract resident.launch_id=$$'" \
  rate=48000 channels=2 2>/dev/null) || audio_error "resident audio could not create its dedicated Pulse null sink"
[[ $module =~ ^[0-9]+$ ]] || audio_error "resident audio returned an invalid module identity"
sink_index=$(pulse_control --format=json list sinks 2>/dev/null | python3 -c '
import json,sys
try:
    sinks=json.load(sys.stdin)
    matches=[s for s in sinks if s["name"]==sys.argv[1]]
    ok=len(matches)==1 and str(matches[0].get("owner_module"))==sys.argv[2] and matches[0].get("monitor_source")==sys.argv[1]+".monitor" and matches[0].get("properties",{}).get("device.class")=="abstract"
    if not ok: sys.exit(1)
    print(int(matches[0]["index"]))
except Exception: sys.exit(1)
' "$audio" "$module") || audio_error "resident audio sink ownership or isolated monitor validation failed"
[[ $sink_index =~ ^[0-9]+$ ]] || audio_error "resident audio sink ownership or isolated monitor validation failed"
current_default=$(pulse_control get-default-sink 2>/dev/null) || audio_error "resident audio could not verify the unchanged default sink"
if [ "$current_default" != "$default_sink" ]; then
  pulse_control set-default-sink "$default_sink" >/dev/null 2>&1 || true
  audio_error "Pulse policy changed the default sink; resident audio launch refused"
fi

# Force OpenAL's Pulse backend for this child only; never monitor speakers,
# microphones, or a mixed default output. Minecraft volume remains operator-set.
ALSOFT_DRIVERS=pulse PULSE_SINK="$audio" setsid "${command[@]}" &
child=$!
# PULSE_SINK alone is not enough: Minecraft opens its OpenAL device by name, and
# its stream then lands on the default output (seen on Inspiron: the laptop
# speakers). Keep every playback stream owned by the game's own session on the
# dedicated sink; streams of any other process are never touched.
route_streams() {
  pulse_control --format=json list sink-inputs 2>/dev/null | python3 -c '
import json,sys
try:
    for stream in json.load(sys.stdin):
        pid=str(stream.get("properties",{}).get("application.process.id",""))
        if not pid.isdigit() or str(stream.get("sink"))==sys.argv[2]: continue
        try: session=open("/proc/"+pid+"/stat").read().rsplit(")",1)[1].split()[3]
        except (OSError,IndexError): continue
        if session==sys.argv[1]: print(int(stream["index"]))
except Exception: sys.exit(1)
' "$child" "$sink_index" 2>/dev/null | while read -r stream; do
    pulse_control move-sink-input "$stream" "$audio" >/dev/null 2>&1 || true
  done
}
# The TERM trap lets an in-flight Pulse call finish before the router exits.
( trap 'exit 0' TERM; while kill -0 "$child" 2>/dev/null; do route_streams || true; sleep 0.5; done ) &
router=$!
set +e
wait "$child"
result=$?
set -e
exit "$result"
