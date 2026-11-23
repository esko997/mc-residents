"use strict";
import { base } from "./overlay-core.js";

// Only this local error type may expose its message on the broadcast surface.
// A fatal error is a refusal that retrying the same Watch cannot fix.
class MediaError extends Error { constructor(text, fatal = false) { super(text); this.fatal = fatal; } }
const RETRY_DELAYS = [1000, 3000, 8000], RETRY_WINDOW = 120000;
const RESUMING = "Between worlds; holding the last picture.";

// One explicit lease at a time. A cancelled Watch is not aborted: its late
// result must still be collected and released. A recoverable ending re-Watches
// the same resident while the user still wants it: at most three attempts
// (1 s, 3 s, 8 s) in a rolling two minutes, never after Stop, a resident change,
// a hidden page or unavailability.
export function createPreviewMedia({ video, blank, watch, stop, audio, fullscreen, stage, status, resident }) {
  const supported = typeof RTCPeerConnection === "function";
  let current = null, pendingWatch = false, availability = false, generation = 0;
  let wanted = null; // Watch intent that survives one session: { resident, attempts, timer }.
  function message(text, state = "idle") { status.textContent = text; status.dataset.state = state; }
  function buttons() {
    watch.disabled = !supported || !availability || document.hidden || !!current || pendingWatch;
    stop.disabled = !current && !wanted?.timer; audio.disabled = !current?.playing || !current?.audioTrack;
    audio.textContent = video.muted ? "Unmute audio" : "Mute audio";
    fullscreen.disabled = !current?.playing;
  }
  async function request(route, body, { signal, timeout = 8000, keepalive = false } = {}) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(base + "api/live/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal, keepalive });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new MediaError(response.status === 409 ? "The shared channel changed or the lease expired. Press Watch to join again." : "The live service could not complete this request. Check the service, then press Watch.",
        response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status));
      if (!data || typeof data !== "object") throw new MediaError("The live service returned an unreadable reply. Press Watch to try again.");
      return data;
    } catch (error) {
      if (signal?.aborted) throw new MediaError("Viewing stopped.");
      if (controller.signal.aborted) throw new MediaError("The live service timed out. Press Watch to try again.");
      if (error instanceof TypeError) throw new MediaError("Cannot reach the live service. Check your connection, then press Watch.");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  function clearMedia() {
    // Transparent, not `hidden`: a video taken out of the layout never starts decoding in WebKit, so `playing` never came.
    video.dataset.awaiting = ""; video.setAttribute("aria-hidden", "true");
    blank.hidden = false; video.onplaying = null; video.pause(); video.muted = true;
    for (const track of video.srcObject?.getTracks() || []) { track.onended = null; track.onmute = null; track.stop(); }
    video.srcObject = null; video.removeAttribute("src"); video.load();
    if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
  }
  // The resident routes lease requests to the host whose channel issued the lease.
  function release(lease, channelGeneration, expected, name) {
    void request("stop", { lease, generation: channelGeneration, resident: name }, { keepalive: true }).catch(() => {
      if (generation === expected && !current && !wanted) message("Playback stopped here. Release was not confirmed; the server lease expires within 30 seconds of its last heartbeat.");
    });
  }
  function teardown() {
    const session = current; current = null; generation++;
    clearMedia();
    if (session) {
      clearTimeout(session.heartbeat); clearTimeout(session.deadline); clearTimeout(session.expiry);
      session.controller.abort();
      if (session.peer) { session.peer.ontrack = null; session.peer.onconnectionstatechange = null; session.peer.close(); for (const receiver of session.peer.getReceivers()) receiver.track?.stop(); }
      if (session.lease) release(session.lease, session.generation, generation, session.resident);
    }
  }
  function cancelRetry() { clearTimeout(wanted?.timer); wanted = null; }
  // Every user or availability ending: no automatic Watch follows.
  function end(text = "Stopped. Press Watch to watch again.", state = "idle") { cancelRetry(); teardown(); message(text, state); buttons(); }
  function canRetry(name) { return !!wanted && wanted.resident === name && resident() === name && supported && availability && !document.hidden; }
  const reconnecting = attempt => `Reconnecting (${attempt} of ${RETRY_DELAYS.length})…`;
  function retryLater(intent, attempt, delay) {
    intent.timer = setTimeout(() => { if (wanted !== intent) return; intent.timer = 0; void start(attempt); }, delay);
  }
  // A recoverable ending. Only a session that held a lease, or an automatic attempt, re-Watches.
  function lost(session, text) {
    if (current !== session) return;
    if (!session.recoverable || !canRetry(session.resident)) { end(text, "error"); return; }
    const at = Date.now(), attempts = wanted.attempts.filter(time => at - time < RETRY_WINDOW);
    if (attempts.length >= RETRY_DELAYS.length) {
      end(`Gave up reconnecting after ${RETRY_DELAYS.length} attempts in 2 minutes. ${text}${/Press Watch/.test(text) ? "" : " Press Watch to try again."}`, "error");
      return;
    }
    teardown();
    attempts.push(at); wanted.attempts = attempts;
    retryLater(wanted, attempts.length, RETRY_DELAYS[attempts.length - 1]);
    message(reconnecting(attempts.length), "connecting"); buttons();
  }
  // Browser exceptions can contain network addresses or SDP. Never surface them.
  function failed(session, error) {
    if (current !== session) return;
    if (!(error instanceof MediaError)) end("The browser could not connect media. Check browser and network support, then press Watch.", "error");
    else if (error.fatal) end(error.message, "error");
    else lost(session, error.message);
  }
  function liveMessage(session) {
    return session.resuming ? RESUMING : session.audio ? "Live video. Audio starts muted; choose Unmute audio to listen." : "Live video only. Audio capture is not enabled for this channel.";
  }
  // The server keeps the channel live and repeats its last frame while the resident changes worlds.
  function setResuming(session, value) {
    if (session.resuming === value) return;
    session.resuming = value;
    if (session.playing) message(liveMessage(session), "live");
  }
  function matches(session, data) { return data.enabled === true && data.resident === session.resident && data.generation === session.generation && ["starting", "live"].includes(data.state); }
  function setExpiry(session, sentAt) {
    session.expiresAt = sentAt + 30000; clearTimeout(session.expiry);
    session.expiry = setTimeout(() => lost(session, "Your viewing lease expired. Press Watch to join again."), Math.max(0, session.expiresAt - Date.now()));
  }
  function heartbeat(session) {
    session.heartbeat = setTimeout(async () => {
      if (current !== session) return;
      if (Date.now() >= session.expiresAt) { lost(session, "Your viewing lease expired. Press Watch to join again."); return; }
      const sentAt = Date.now();
      try {
        const data = await request("heartbeat", { lease: session.lease, generation: session.generation, resident: session.resident }, { signal: session.controller.signal });
        if (current !== session) return;
        if (!matches(session, data)) { lost(session, "The shared channel changed or ended. Press Watch to join again."); return; }
        setResuming(session, data.resuming === true);
        setExpiry(session, sentAt); heartbeat(session);
      } catch (error) { failed(session, error instanceof MediaError ? error : new MediaError("The live service could not renew the viewing lease. Press Watch to join again.")); }
    }, 10000);
  }
  function gather(peer, signal) {
    if (signal.aborted) return Promise.reject(new MediaError("Viewing stopped."));
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); signal.removeEventListener("abort", cancelled); if (error) reject(error); else resolve(); };
      const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
      const cancelled = () => finish(new MediaError("Viewing stopped."));
      const timer = setTimeout(() => finish(new MediaError("Media network discovery timed out. Press Watch to try again.")), 10000);
      peer.addEventListener("icegatheringstatechange", changed); signal.addEventListener("abort", cancelled, { once: true }); changed();
    });
  }
  // attempt 0 is the user's Watch; 1-3 are automatic re-Watches of the same resident.
  async function start(attempt = 0) {
    if (attempt) {
      if (current) return;
      if (!canRetry(wanted?.resident)) { end("Stopped reconnecting. Press Watch to try again."); return; }
      // A cancelled request still owns the only Watch slot; try once it settles.
      if (pendingWatch) { retryLater(wanted, attempt, 1000); buttons(); return; }
      teardown();
    } else {
      if (watch.disabled) return;
      cancelRetry(); teardown();
      wanted = { resident: resident(), attempts: [], timer: 0 };
    }
    const session = { resident: wanted.resident, controller: new AbortController(), peer: null, lease: null, playing: false, stream: new MediaStream(), audioTrack: null, resuming: false, recoverable: attempt > 0, audio: false };
    current = session; pendingWatch = true; message(attempt ? reconnecting(attempt) : "Starting a shared viewing session…", "connecting"); buttons();
    try {
      let data;
      try { data = await request("watch", { resident: session.resident }, { timeout: 35000 }); }
      finally { pendingWatch = false; buttons(); }
      if (typeof data.lease !== "string" || !Number.isSafeInteger(data.generation)) throw new MediaError("The live service returned an invalid lease. Press Watch to try again.", true);
      if (current !== session) { release(data.lease, data.generation, generation, session.resident); return; }
      session.lease = data.lease; session.generation = data.generation; session.recoverable = true;
      if (!matches(session, data)) throw new MediaError("The shared channel changed before playback started. Press Watch to join again.");
      session.resuming = data.resuming === true; session.audio = data.audio === true;
      setExpiry(session, Date.now()); heartbeat(session);
      session.deadline = setTimeout(() => lost(session, "No video arrived within 25 seconds. Check the live service and network, then press Watch."), 25000);
      const peer = session.peer = new RTCPeerConnection({ iceServers: [] });
      peer.addTransceiver("video", { direction: "recvonly" });
      if (data.audio === true) peer.addTransceiver("audio", { direction: "recvonly" });
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) lost(session, "The media connection ended. Press Watch to reconnect.");
      };
      video.onplaying = () => {
        if (current !== session || video.paused || video.readyState < 2 || video.videoWidth === 0 || !session.stream.getVideoTracks().length) return;
        clearTimeout(session.deadline); session.playing = true; delete video.dataset.awaiting; video.removeAttribute("aria-hidden"); blank.hidden = true;
        message(liveMessage(session), "live"); buttons();
      };
      peer.ontrack = event => {
        if (current !== session || !["video", "audio"].includes(event.track.kind) || (event.track.kind === "audio" && data.audio !== true)) { event.track.stop(); return; }
        session.stream.addTrack(event.track);
        if (event.track.kind === "audio") session.audioTrack = event.track;
        event.track.onended = () => lost(session, "A media track ended. Press Watch to reconnect.");
        if (event.track.kind === "video") {
          event.track.onmute = () => { if (session.playing) lost(session, "Video is no longer arriving. Press Watch to reconnect."); };
          // Attach the stream only now that it holds the video track: an element given an empty stream that gains
          // its video later plays in WebKit but never reports a picture size, so the check above never passed.
          video.srcObject = session.stream;
          void video.play().catch(() => { if (current === session) end("The browser could not play the video. Press Watch to try again.", "error"); });
        }
        buttons();
      };
      if (!attempt) message("Connecting the live picture…", "connecting");
      await peer.setLocalDescription(await peer.createOffer()); await gather(peer, session.controller.signal);
      if (current !== session) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp || sdp.length > 65536) throw new MediaError("The browser generated an invalid media offer. Press Watch to try again.", true);
      const answer = await request("offer", { lease: session.lease, generation: session.generation, resident: session.resident, sdp }, { signal: session.controller.signal, timeout: 12000 });
      if (current !== session) return;
      if (typeof answer.sdp !== "string" || answer.sdp.length > 65536) throw new MediaError("The live service returned an invalid media answer. Press Watch to try again.", true);
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      failed(session, error);
    }
  }
  watch.addEventListener("click", () => void start()); stop.addEventListener("click", () => end());
  video.addEventListener("pause", () => {
    if (current?.playing) end("Playback paused. Press Watch to start a new viewing session.");
  });
  audio.addEventListener("click", async () => {
    if (!current?.playing || !current.audioTrack) return;
    const session = current; video.muted = !video.muted;
    try { await video.play(); if (current === session) { buttons(); message(video.muted ? "Live video. Audio is muted." : "Live video and audio. Choose Mute audio to silence playback.", "live"); } }
    catch { if (current === session) { video.muted = true; buttons(); message("The browser blocked audio playback. Choose Unmute audio to try again.", "error"); } }
  });
  fullscreen.addEventListener("click", async () => {
    try { if (document.fullscreenElement === stage) await document.exitFullscreen(); else await stage.requestFullscreen(); }
    catch { message("Fullscreen is not available in this browser window."); }
  });
  document.addEventListener("fullscreenchange", () => { fullscreen.textContent = document.fullscreenElement === stage ? "Exit fullscreen" : "Fullscreen"; });
  document.addEventListener("visibilitychange", () => { if (document.hidden) end("Stopped when this page was hidden. Press Watch to resume."); else buttons(); });
  window.addEventListener("pagehide", () => end("Stopped when leaving this page. Press Watch to resume."));
  window.addEventListener("pageshow", buttons);
  if (!supported) message("This browser does not support WebRTC video.", "error");
  buttons();
  return {
    end,
    availability(value) { availability = value; if (!value && (current || wanted)) end("Live video is unavailable for the selected resident. Choose another resident, then press Watch.", "error"); buttons(); },
    selectionChanged() { end("Resident selection changed. Press Watch to start the selected resident's video."); },
    hasSession: () => !!current,
  };
}
