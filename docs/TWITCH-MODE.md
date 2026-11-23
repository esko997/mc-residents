# Twitch mode: private production desk

Exploratory branch `twitch-mode`, based on master `57d57d3`. This branch is not a deployment. No Twitch credentials, RTMP push, recording service, server mod changes, or resident-mind changes are involved.

## Architecture

```text
One resident's Synapse framebuffer (authenticated loopback BGRA)
  -> Commons bounded frame pump
  -> explicitly selected FFmpeg H.264 encoder
                                      -> MediaMTX -> WHEP/WebRTC browser preview
One resident's OpenAL output           -> MediaMTX -> RTSP/TCP OBS Media Source
  -> dedicated Pulse/PipeWire null sink
  -> that sink's monitor -> FFmpeg Opus

Commons observations, plans, chat, alarms, places, caretaker notes
  -> allowlisted, privacy-filtered overlay projection
  -> authenticated SSE -> transparent OBS Browser Source
                         + control-window stage
                         + WebRTC composite preview
```

The native framebuffer is captured, never the desktop. H.264 encoding is an explicit host setting, not an automatic GPU probe or fallback chain. A missing encoder, device or audio source is an error. The `h264_amf` FFmpeg entry alone does not establish usable AMF drivers on Linux; this branch uses VAAPI for AMD instead.

Each host has one on-demand channel for its own residents: explicit Watch, four viewer leases maximum, heartbeat every ten seconds, expiry after thirty seconds. Stop, navigation, hidden preview or final lease expiry stops capture and encoding. Switching to another resident on the same host changes that host's generation and invalidates its old leases. A recoverable ending re-Watches the same resident at most three times in two minutes (see the Commons README); the server never restarts a failed channel. The relay can be idle without a publisher.

RTSP readers do **not** own Commons leases. Keep a visible Commons preview or Live window watching while OBS pulls the clean feed. Closing or hiding the last viewing window intentionally stops OBS's upstream source too. This is a safety invariant, not an unattended broadcast scheduler.

Overlay data has its own sample timestamp; it is not frame-accurate metadata. The small map is a schematic X/Z trail and saved-place map, not terrain imagery. Unknown/offline values remain unavailable instead of inventing resident activity.

## Host configuration

Keep existing Synapse authentication and enable `videoEnabled` only with the client stopped. Preserve the existing private Commons URL and MediaMTX sandbox. Use FFmpeg with the selected H.264 encoder, `libopus`, and Pulse input support; MediaMTX is tested against version 1.21.4.

```sh
# Choose exactly one on each publishing host:
COMMONS_LIVE_ENABLED=true
COMMONS_LIVE_ENCODER=libx264
# COMMONS_LIVE_ENCODER=h264_nvenc
# COMMONS_LIVE_ENCODER=h264_vaapi
# COMMONS_LIVE_VAAPI_DEVICE=/dev/dri/renderD128

# Optional; false/unset preserves the existing video-only behavior:
COMMONS_LIVE_AUDIO=true
```

`COMMONS_LIVE_VAAPI_DEVICE` is required for VAAPI. Confirm the actual render node and permissions on that host; device numbering is not portable. No GPU settings are inferred from another host's result.

For each client, set its dedicated sink in the instance environment:

```sh
GARY_CLIENT_AUDIO_SINK=resident_Gary
```

For Gary, provide the same setting to Commons's environment; other residents use their `instances/<Name>.env`. The name must start with `resident_`, followed by 1–48 letters, digits or underscores. Never configure the desktop output or default microphone. The opt-in launcher owns a null sink, routes OpenAL with `ALSOFT_DRIVERS=pulse` and `PULSE_SINK`, and removes its owned sink when the client exits. Do not enable audio in Commons until the matching client is running through that launcher. Game master volume must be nonzero and its sound device must not override the requested Pulse sink.

Both inputs use wall-clock timestamps, subtracting one common epoch rather than resetting each input separately. Audio is resampled to 48 kHz, encoded as Opus, and transported beside H.264. This preserves initial skew; it does not promise zero capture or playback latency.

## Pages and control workflow

All routes are relative to the existing private `/<token>/` Commons base:

- `overlay`: transparent browser source; loading it does not start video.
- `overlay/control`: second-window scene editor.
- `overlay/preview`: WebRTC video plus the same overlay renderer, explicit Watch/Stop and sound control.

Choose 1920×1080 or 1280×720. Toggle each widget, drag it on the stage or enter numeric coordinates, then set scale and theme. Widgets: vitals, position/dimension, plan focus/next step, chat, alarms, nearby residents, map, caretaker note, title/now playing. Exploring, building and chat-heavy presets provide starting layouts. The selected resident may live on the hub or on a station: the hub proxies Live signaling to the station (media flows from the station's MediaMTX) and projects the station's overlay source through the same privacy filter. Overlay state stays on the hub. See "Live on stations" in the Commons README.

Scene state is saved server-side beside the Commons database in its `.overlay.json` file, with private permissions and atomic replacement. Revision checks reject stale concurrent edits rather than silently overwriting another control window. Open pages receive saved state and data through SSE. Preserve this file in backups; deleting it deliberately resets the scene to defaults.

## OBS setup

1. Open Commons preview, choose the resident and press Watch. Confirm video and sound there first. Keep this window visible while broadcasting.
2. Set OBS's base canvas to the same 1920×1080 or 1280×720 layout.
3. Add **Media Source**, turn off **Local File**, and use `rtsp://127.0.0.1:8554/resident` on the publisher host. Use RTSP over TCP; where OBS exposes FFmpeg options, set `rtsp_transport=tcp`. Start with a small network buffer, raising it only if measured packet loss requires it. Fit to canvas; the 854×480 source has a slightly different aspect ratio from exact 16:9.
4. Above that, add **Browser Source** using the private Commons `overlay` URL. Set its width and height exactly to the layout. Keep the background transparent. Do not use desktop/window capture of the control page.
5. Open `overlay/control` in a separate window. Change a widget and confirm the Browser Source updates. A resident change needs a fresh explicit Watch in preview; this avoids silently restarting a failed feed.
6. Use only the Media Source's audio in OBS. Mute desktop capture and avoid capturing preview sound a second time. Monitor the dedicated client source with headphones if needed.
7. Stop preview/Live when finished. Confirm Commons is idle and the encoder is gone. The client and its null sink may continue only when the operator intentionally leaves that resident client running.

No OBS application interaction or Twitch transmission is implied by an FFmpeg RTSP pull test. OBS's bundled decoder and Browser Source engine need their own holistic acceptance.

### OBS on another LAN machine

The default RTSP publisher/read listener and WHEP HTTP endpoint remain loopback-only. Do not simply expose all MediaMTX ports or change Commons's validated publish URL to a LAN address.

For an intentional LAN pull, bind MediaMTX RTSP to the publisher's chosen LAN interface (or all interfaces with a host firewall) and split its authorization rules: loopback alone may publish `resident`; only the specific OBS machine address may read it. Keep WHEP HTTP loopback and disable unused protocols. The Commons publisher must still reach a loopback listener, so an all-interface RTSP listener is required unless the relay supports separate listening sockets. Apply matching firewall restrictions. A private network address is not encryption or strong identity; use a tunnel on untrusted networks. Never port-forward this relay to the Internet.

## Privacy boundaries

The secret URL is full dashboard authority, not a public share token. It belongs in a private OBS source configuration, never on-screen, in public logs, scene exports or screenshots of the address bar. HTTP on a trusted LAN is not encrypted. Overlay APIs require the same secret path; mutations reject cross-origin browser requests. Overlay assets make no third-party font or analytics requests.

The overlay receives a restricted projection, not raw Commons configuration, session traces, credentials, console diagnostics or maintainer notes. Free text is bounded and filtered; the renderer uses text nodes rather than HTML. `spesk01` and `Levi` are hidden by default through a case-insensitive name list. Operators can change that list deliberately. Custom title/now-playing text is treated as untrusted too.

**The hide list does not redact the underlying Minecraft framebuffer or game audio.** In-game chat, menus, server listings, voice-chat mods and player names can still appear in the clean feed. Hide chat/HUD fields in the stopped client's own configuration as appropriate, and inspect every intended scene before going public. No text scrubber can guarantee detection of every secret encoded in arbitrary prose. Treat resident-authored text as potentially sensitive even with filtering.

## Verification record and integration gates

### Encoder matrix

| Host | Explicit choice | Observed status |
| --- | --- | --- |
| Bazzite software | `libx264` | **Verified:** Synapse-shaped BGRA endpoint + isolated Pulse monitor → FFmpeg → MediaMTX → RTSP recording and browser WHEP, both audio and video. |
| Bazzite Radeon 8060S | `h264_vaapi`, `/dev/dri/renderD128` | **Verified:** the same complete pipeline, Mesa 26.2.4 radeonsi; no fallback. |
| Inspiron GTX 1060 Max-Q | `h264_nvenc` | Existing video-only deployment used NVENC; this branch and audio were **not tested there**. |
| Chungus1 RX 590 | `h264_vaapi`, render node to check | **Not accessed.** Driver, profile, permissions and audio need verification later. |
| Linux AMF | Not offered | An FFmpeg encoder listing is not a working runtime; VAAPI is the supported AMD path. |

### Measurements

Local synthetic flash/beep source, 854×480 at a 15 fps ceiling, dedicated PipeWire/Pulse null sink, H.264 + 48 kHz stereo Opus, MediaMTX 1.21.4. Each RTSP recording contains 37 paired markers across 180 seconds. Both final recordings have empty FFmpeg warning/error logs.

| Measurement | libx264 | h264_vaapi |
| --- | ---: | ---: |
| Encoder average CPU, one core = 100% | 6.17% | 5.44% |
| Encoder peak RSS | 78.93 MiB | 110.41 MiB |
| Relay peak RSS | 45.67 MiB | 45.54 MiB |
| Watch → first browser frame, already-publishing channel | 702 ms | 644 ms |
| Median audio-minus-video marker offset | +336.9 ms | +329.2 ms |
| First-three to last-three marker offset change | −6 ms | −4 ms |
| Linear offset slope | −0.60 ms/min | −0.40 ms/min |

**Audio consistently trails video by about 330 ms in this fixture.** The small measured change means no accumulating drift was observed over three minutes; it does not establish precise game-audio synchronization. Video markers are quantized to roughly 67 ms, and the synthetic producer and Pulse buffering contribute to the fixed offset. Do not apply a hard-coded 330 ms production correction: measure the actual game/source first. OBS video delay is one possible calibration step after measuring.

VAAPI browser reception over roughly 195 seconds decoded 2,925 video frames with zero reported packet loss on either track. Average receiver jitter-buffer delay was about 76 ms video / 66 ms audio. These are **not** glass-to-glass latency measurements. CPU/RSS were sampled from `/proc`; low-complexity synthetic content does not predict Minecraft performance, and RSS excludes GPU allocations. Runs used `agent-heavy` with its 6 GiB per-job limit.

An earlier trial exposed non-monotonic audio timestamps when generic wall-clock replacement was applied to Pulse packets. The final implementation retains Pulse's native wall-clock timestamps, uses a shared epoch, and reserves generic wall-clock replacement for raw video. Final recordings above are from the corrected implementation.

Machine-readable results: [measurements.json](twitch-mode/measurements.json). Local, uncommitted evidence remains under `.cache/proof-libx264/` and `.cache/proof-h264_vaapi/`: `capture.mkv`, `av-analysis.json`, `resources.json`, browser statistics and logs.

### Tests and browser evidence

- Commons: **202 passed, 0 failed**, followed by a successful `bun run typecheck`. The first typecheck exposed a test-only literal-union inference error; corrected and typecheck rerun successfully.
- Toolserver: **477 passed, 9 skipped, 0 failed**.
- Launcher: **6 passed**, including cleanup/ownership cases. A real PipeWire attempt exposed incorrect assumptions about module JSON indices and the sink monitor field; validation now uses the actual `monitor_source` field and module IDs from `pactl list short modules`. Lifecycle tests were updated and passed again.
- All heavy verification was memory-guarded. No full suite was repeatedly run.
- Actual Chromium interaction verified dragging and numeric positioning, scale/theme/toggles, saved presets/layouts, title updates across open windows, human-name filtering, full air, responsive control at 390 px, and explicit Watch/Stop/unmute. Resident changes stop preview rather than silently continuing the wrong feed.
- WebRTC audio and video were verified with both encoders. **OBS itself and Twitch transmission were not tested.**

Screenshots use fixture resident data; the preview contains actual WebRTC playback of the synthetic media pipeline:

- [Control desk](twitch-mode/control.png)
- [Transparent 1920×1080 overlay](twitch-mode/overlay-1080.png)
- [Transparent 1280×720 overlay](twitch-mode/overlay-720.png)
- [Video + overlay preview](twitch-mode/preview.png)

The locally bundled Lato font avoids workstation-font dependencies and external requests. Its license is served alongside `overlay-font.ttf` as `overlay-font-LICENSE.txt`.

### Disposable Minecraft attempt

Only `gary_fc_test` was launched, from an isolated copy inside this worktree, against the explicitly permitted game port. No SSH, SCP, rsync, ADB, resident administration or scripted world actions were used.

The client connected and initialized OpenAL, but authenticated local Synapse `/video/info` requests timed out even with an 8-second request deadline. No usable real framebuffer arrived during the 180-second readiness window; the outer 280-second safety timeout ended the attempt (exit 124, not an observed OOM). **No real-client screenshot, real-game A/V drift, game-audio routing confirmation or game performance result is claimed.** The copied client's logs remain in `.cache/proof-real/` for diagnosis.

The real PipeWire null sink was created and final cleanup removed it. All owned Minecraft, encoder, relay, browser tabs and Xvfb processes were stopped; local media/API ports were no longer listening and the game-connection lease was released. A pre-existing unrelated Xvfb `:98` was deliberately untouched. The original isolated client cache was not edited.

### Integration tomorrow

1. Review/merge the branch only when authorized; back up private configuration and preserve the production URL token and database.
2. Decide topology first: each resident publishes from its own host's Commons, with that host's explicit encoder (Inspiron `h264_nvenc`, Chungus1 `h264_vaapi`). OBS pulls RTSP from the publishing host only; a station's RTSP stays loopback unless a LAN listener is configured there (see "OBS on another LAN machine").
3. Rehearse with a stopped/disposable client before changing a resident launcher. Configure a unique dedicated audio sink and confirm no speaker/microphone capture or default-device change.
4. Select the host's explicit encoder. Verify NVENC on Inspiron and VAAPI/render-device access on Chungus1 separately; an error must remain visible, never silently fall back.
5. Inspect the native game HUD for private text, then verify clean RTSP video **and** Opus audio in the actual OBS installation. Opus support can vary with the OBS/FFmpeg build.
6. Add the transparent Browser Source, select the exact layout, and rehearse preset and resident switching. **Cover/stop the OBS scene before switching residents:** overlay state and an already-held media lease are not an atomic broadcast switch. Confirm the actual video identity before uncovering.
7. Measure real-client sync for several minutes and calibrate only from that measurement. Check load, sleep/silence behavior, reconnects and LAN opt-in/security before any public stream.
8. Stop the rehearsal, verify encoder/client process groups and owned null sinks disappear, then authorize a controlled live rollout separately.

Open questions: atomic OBS scene/source switching (especially across hosts); acceptable fixed A/V offset and latency; real-game encoder capacity; native HUD privacy policy; which OBS builds ingest Opus over RTSP reliably. No production deployment is part of this branch.
