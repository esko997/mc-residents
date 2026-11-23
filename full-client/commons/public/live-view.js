"use strict";

// One explicit viewing session. Polling reads status; only Watch acquires a lease.
// A cancelled watch request is allowed to finish so its late lease can be released.
// A session that ends for a recoverable reason re-Watches the same resident while the
// user still wants it: at most three attempts (1 s, 3 s, 8 s) in a rolling two minutes.
const RETRY_DELAYS = [1000, 3000, 8000], RETRY_WINDOW = 120000;
const RESUMING = "Between worlds; holding the last picture.";
const fatal = message => Object.assign(new Error(message), { fatal: true });

export function createLiveView(root, { now, stamp, colour }) {
  const find = selector => root.querySelector(selector);
  const select = find("#live-resident"), watch = find("#live-watch"), stop = find("#live-stop");
  const video = find("#live-video"), stage = find("#live-stage"), blank = find("#live-blank");
  const status = find("#live-status"), detail = find("#live-detail"), channel = find("#live-channel");
  const context = find("#live-context"), facts = find("#live-facts"), contextTime = find("#live-context-time");
  const fullscreen = find("#live-fullscreen"), fullscreenNote = find("#live-fullscreen-note");
  const audioButton = find("#live-audio"), mediaNote = find("#live-media-note");
  const supported = typeof RTCPeerConnection === "function";
  let active = false, enabled = null, current = null, pendingWatch = false, revision = 0;
  let residents = [], sampleSeconds = 5, mode = "idle";
  // Watch intent that survives one session: { resident, attempts, timer }.
  let wanted = null;

  async function request(route, body, { signal, timeout = 8000, keepalive = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(`api/live/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer",
        signal: controller.signal, keepalive,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = response.status === 409 ? "The channel changed or your viewing lease expired. Press Watch to join again."
          : typeof data?.error === "string" ? data.error.slice(0, 500)
          : `Live service answered ${response.status}. Press Watch to try again.`;
        // Retrying a refused request cannot help; a changed channel, a busy viewer
        // slot or a server/proxy failure may recover.
        const error = new Error(message);
        error.fatal = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
        throw error;
      }
      if (!data || typeof data !== "object") throw new Error("Live service returned an unreadable response.");
      return data;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Viewing stopped", "AbortError");
      if (controller.signal.aborted) throw new Error("Live service timed out. Press Watch to try again.");
      if (error instanceof TypeError) throw new Error("Cannot reach the live service. Check your connection, then press Watch.");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function unavailableMessage() {
    if (!supported) return "This browser does not support WebRTC video.";
    const resident = residents.find(entry => entry.name === select.value);
    if (!resident) return "No residents are configured.";
    if (resident.hostUnreachable) return `Host ${resident.host} is unreachable. ${resident.hostLastSeen === null
      ? "Host not reached yet." : `Host last seen ${stamp(resident.hostLastSeen)}.`}`;
    if (resident.liveAvailable !== true) return `Live video is unavailable for ${resident.name} on host ${resident.host}: Live is not enabled there.`;
    if (enabled === false) return `Live video is disabled on host ${resident.host}.`;
    return "";
  }

  function updateAvailability() {
    const message = unavailableMessage();
    if (message) {
      if (current) end(message, "disabled");
      else {
        cancelRetry();
        setState("disabled", message);
      }
    } else if (!current && mode === "disabled") setState("idle", "Choose a resident, then press Watch.");
  }

  function buttons() {
    const unavailable = unavailableMessage();
    watch.disabled = !active || document.hidden || !!unavailable || !!current || pendingWatch;
    watch.textContent = unavailable ? "Unavailable" : "Watch";
    watch.title = unavailable || (pendingWatch && !current ? "Waiting for the cancelled start request to finish and release its lease." : "");
    stop.disabled = !current && !wanted?.timer;
    select.disabled = residents.length === 0;
    fullscreen.disabled = !current?.playing;
    audioButton.disabled = !current?.playing || !current.audio;
    audioButton.textContent = video.muted ? "Unmute game audio" : "Mute game audio";
    audioButton.setAttribute("aria-pressed", String(!video.muted));
  }

  function setState(next, message) {
    mode = next;
    status.textContent = { idle: "Idle", connecting: "Connecting", live: "Live", error: "Error", disabled: "Unavailable" }[next];
    status.className = `pill ${next === "live" ? "online" : next === "connecting" ? "activating" : next === "error" ? "error" : "offline"}`;
    detail.textContent = message;
    blank.textContent = message;
    buttons();
  }

  function clearMedia() {
    // Conceal first: even a retained decoder frame must never appear under a new name. The element stays in the
    // layout, only transparent: a video removed with `hidden` never starts decoding in WebKit, so `playing` never came.
    video.dataset.awaiting = ""; video.setAttribute("aria-hidden", "true");
    blank.hidden = false;
    video.onplaying = null;
    video.pause();
    video.muted = true;
    mediaNote.textContent = "No recording · Audio only with operator opt-in";
    for (const track of video.srcObject?.getTracks() ?? []) track.stop();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
    context.hidden = true;
    facts.replaceChildren();
    contextTime.textContent = "";
    find("#live-name").textContent = "Resident view";
    stage.style.removeProperty("--who");
    fullscreenNote.textContent = "";
    if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
  }

  function release(lease, generation, expectedRevision, resident) {
    // keepalive is also used on pagehide. JSON matches the normal stop route;
    // no beacon content-type exception or additional backend contract is needed.
    // The resident routes the stop to the channel's own host.
    void request("stop", { lease, generation, resident }, { keepalive: true }).then(data => {
      if (revision === expectedRevision && !current) showChannel(data);
    }).catch(() => {
      if (revision === expectedRevision && !current && !wanted) {
        detail.textContent = "Playback stopped here; the server did not confirm release. The viewing lease expires within 30 seconds of its last heartbeat.";
      }
    });
  }

  function teardown() {
    const session = current;
    current = null;
    revision++;
    if (session) {
      clearTimeout(session.heartbeat);
      clearTimeout(session.deadline);
      session.controller.abort();
      if (session.peer) {
        session.peer.ontrack = null;
        session.peer.onconnectionstatechange = null;
        session.peer.close();
        for (const receiver of session.peer.getReceivers()) receiver.track?.stop();
      }
      if (session.lease) release(session.lease, session.generation, revision, session.resident);
    }
    clearMedia();
  }

  function cancelRetry() {
    clearTimeout(wanted?.timer);
    wanted = null;
  }

  // Every user or availability ending: no automatic Watch follows.
  function end(message = "Stopped. Press Watch when you want to watch again.", next = "idle") {
    cancelRetry();
    teardown();
    setState(next, message);
  }

  function canRetry(resident) {
    return !!wanted && wanted.resident === resident && select.value === resident
      && active && !document.hidden && !unavailableMessage();
  }

  const reconnecting = attempt => `Reconnecting (${attempt} of ${RETRY_DELAYS.length})…`;

  // A recoverable ending. Only a session that held a lease, or an automatic attempt,
  // re-Watches; a failed manual Watch reports its error instead.
  function lost(session, message) {
    if (current !== session) return;
    if (!session.recoverable || !canRetry(session.resident)) {
      end(message, "error");
      return;
    }
    const at = Date.now(), attempts = wanted.attempts.filter(time => at - time < RETRY_WINDOW);
    if (attempts.length >= RETRY_DELAYS.length) {
      end(`Gave up reconnecting to ${session.resident} after ${RETRY_DELAYS.length} attempts in 2 minutes. ${message}${
        /Press Watch/.test(message) ? "" : " Press Watch to try again."}`, "error");
      return;
    }
    teardown();
    attempts.push(at);
    const intent = wanted, attempt = attempts.length;
    intent.attempts = attempts;
    intent.timer = setTimeout(() => {
      if (wanted !== intent) return;
      intent.timer = 0;
      void start(attempt);
    }, RETRY_DELAYS[attempt - 1]);
    setState("connecting", reconnecting(attempt));
  }

  function failed(session, error) {
    if (current !== session) return;
    if (error instanceof DOMException) end("WebRTC could not connect. Check browser and network support, then press Watch.", "error");
    else if (error.fatal) end(error.message, "error");
    else lost(session, error.message);
  }

  function liveMessage(session) {
    if (session.resuming) return RESUMING;
    return session.audio ? "Receiving live video and dedicated game audio. Audio starts muted; use Unmute game audio to listen."
      : "Receiving live video. Video only; no audio is captured or played.";
  }

  // The server keeps the channel live and repeats its last frame while the
  // resident changes worlds; only the message changes.
  function setResuming(session, value) {
    if (session.resuming === value) return;
    session.resuming = value;
    if (session.playing) setState("live", liveMessage(session));
  }

  function matches(session, data) {
    return data.enabled === true && data.resident === session.resident && data.generation === session.generation
      && (data.state === "starting" || data.state === "live");
  }

  // One channel per host: say whose host this is, so viewers know what Watch will switch.
  function showChannel(data) {
    enabled = data.enabled;
    const where = typeof data.host === "string" ? ` on ${data.host}` : "";
    channel.textContent = !data.enabled ? `Live video is disabled${where}. ${data.detail || "Ask the host operator to enable it."}`
      : data.resident ? `Channel${where}: ${data.resident}. Service ${data.state}; ${data.viewers} viewer${data.viewers === 1 ? "" : "s"}. ${data.detail || ""}`
      : `Channel${where}: ${data.state}. ${data.detail || "No resident is being streamed."}`;
  }

  function renderContext() {
    if (!current?.playing) return;
    const resident = residents.find(entry => entry.name === current.resident);
    context.hidden = false;
    facts.replaceChildren();
    const field = (label, value) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = value;
      facts.append(dt, dd);
    };
    if (!resident) {
      contextTime.textContent = "Resident context unavailable.";
      return;
    }
    const age = now() - resident.checkedAt;
    const fresh = resident.status === "online" && resident.state && resident.checkedAt > 0
      && age >= -5000 && age <= Math.max(30000, sampleSeconds * 2000);
    contextTime.textContent = resident.checkedAt > 0
      ? `${fresh ? "Sampled" : "Last checked"} ${stamp(resident.checkedAt)}. Context is sampled separately from video, not frame-synchronised.`
      : "No resident context has been sampled yet.";
    if (!fresh) {
      field("Client", resident.status === "online" ? "Context is stale; waiting for a fresh sample." : resident.status);
      return;
    }
    const s = resident.state;
    field("Health", `${s.health} / ${s.maxHealth}`);
    field("Food", `${s.food} / 20`);
    field("Position", `${s.pos.x}, ${s.pos.y}, ${s.pos.z} (${s.dimension})`);
    field("Action", "Not reported by the resident status feed.");
    field("Holding", s.held ? `${s.held.item} ×${s.held.count}` : "Nothing");
    field("Screen", s.screen ?? "None open");
    if (s.dangers?.length) field("Hazards", s.dangers.join(", "));
  }

  function scheduleHeartbeat(session) {
    session.heartbeat = setTimeout(async () => {
      if (current !== session) return;
      if (Date.now() >= session.expiresAt) {
        lost(session, "Your viewing lease expired. Press Watch to join again.");
        return;
      }
      // Use request start, not response arrival, as the conservative lease clock.
      const sentAt = Date.now();
      try {
        const data = await request("heartbeat", { lease: session.lease, generation: session.generation, resident: session.resident }, { signal: session.controller.signal });
        if (current !== session) return;
        showChannel(data);
        if (!matches(session, data)) {
          lost(session, "The shared channel changed or ended. Press Watch to join again.");
          return;
        }
        setResuming(session, data.resuming === true);
        session.expiresAt = sentAt + 30000;
        scheduleHeartbeat(session);
      } catch (error) {
        failed(session, error);
      }
    }, 10000);
  }

  function gatherIce(peer, signal) {
    if (signal.aborted) return Promise.reject(new DOMException("Viewing stopped", "AbortError"));
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", changed);
        signal.removeEventListener("abort", cancelled);
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
      const cancelled = () => finish(new DOMException("Viewing stopped", "AbortError"));
      const timer = setTimeout(() => finish(new Error("WebRTC network discovery timed out. Press Watch to try again.")), 10000);
      peer.addEventListener("icegatheringstatechange", changed);
      signal.addEventListener("abort", cancelled, { once: true });
      changed();
    });
  }

  // attempt 0 is the user's Watch; 1-3 are automatic re-Watches of the same resident.
  async function start(attempt = 0) {
    if (attempt) {
      if (current) return;
      if (!canRetry(wanted?.resident)) {
        const unavailable = unavailableMessage();
        end(unavailable || "Stopped reconnecting. Press Watch to try again.", unavailable ? "disabled" : "idle");
        return;
      }
      if (pendingWatch) {
        // A cancelled request still owns the only Watch slot; try once it settles.
        const intent = wanted;
        intent.timer = setTimeout(() => {
          if (wanted !== intent) return;
          intent.timer = 0;
          void start(attempt);
        }, 1000);
        buttons();
        return;
      }
      teardown();
    } else {
      if (watch.disabled) return;
      cancelRetry();
      teardown();
      wanted = { resident: select.value, attempts: [], timer: 0 };
    }
    const session = { resident: wanted.resident, controller: new AbortController(), peer: null, lease: null, playing: false,
      resuming: false, recoverable: attempt > 0 };
    current = session;
    pendingWatch = true;
    setState("connecting", attempt ? reconnecting(attempt) : `Starting ${session.resident}'s video…`);
    try {
      // Do not abort this request on selection/navigation: collect and release a
      // late lease. No second Watch is sent until this request has settled.
      let data;
      try { data = await request("watch", { resident: session.resident }, { timeout: 35000 }); }
      finally { pendingWatch = false; buttons(); }
      if (typeof data.lease !== "string" || !Number.isSafeInteger(data.generation)) throw fatal("Live service returned an invalid viewing lease.");
      if (current !== session) {
        release(data.lease, data.generation, revision, session.resident);
        return;
      }
      // Status reads started before acquisition describe the previous channel.
      revision++;
      session.lease = data.lease;
      session.generation = data.generation;
      session.recoverable = true;
      showChannel(data);
      if (!matches(session, data)) throw new Error("The shared channel changed before viewing started. Press Watch to join again.");
      session.resuming = data.resuming === true;
      session.expiresAt = Date.now() + 30000;
      scheduleHeartbeat(session);
      session.deadline = setTimeout(() => {
        lost(session, "No video arrived within 25 seconds. Check the live service and network, then press Watch.");
      }, 25000);
      const peer = session.peer = new RTCPeerConnection({ iceServers: [] });
      peer.addTransceiver("video", { direction: "recvonly" });
      session.audio = data.audio === true;
      if (session.audio) peer.addTransceiver("audio", { direction: "recvonly" });
      peer.onconnectionstatechange = () => {
        if (current !== session) return;
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          lost(session, "The video connection ended. Press Watch to reconnect.");
        }
      };
      peer.ontrack = event => {
        if (current !== session || (event.track.kind !== "video" && !(session.audio && event.track.kind === "audio"))) { event.track.stop(); return; }
        event.track.onended = () => {
          lost(session, `The ${event.track.kind} track ended. Press Watch to reconnect.`);
        };
        if (!video.srcObject) video.srcObject = new MediaStream();
        video.srcObject.addTrack(event.track);
        if (event.track.kind === "audio") return;
        event.track.onmute = () => {
          if (session.playing) lost(session, "Video is no longer arriving. Press Watch to reconnect.");
        };
        video.onplaying = () => {
          if (current !== session || video.readyState < 2) return;
          clearTimeout(session.deadline);
          session.playing = true;
          delete video.dataset.awaiting; video.removeAttribute("aria-hidden");
          blank.hidden = true;
          find("#live-name").textContent = session.resident;
          stage.style.setProperty("--who", colour(session.resident));
          mediaNote.textContent = session.audio ? "Dedicated game audio · No recording" : "Video only · No audio · No recording";
          setState("live", liveMessage(session));
          renderContext();
        };
        void video.play().catch(() => {
          if (current === session) end("The browser could not play the video. Press Watch to try again.", "error");
        });
      };
      if (!attempt) setState("connecting", `Connecting to ${session.resident}'s video…`);
      await peer.setLocalDescription(await peer.createOffer());
      await gatherIce(peer, session.controller.signal);
      if (current !== session) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp || sdp.length > 65536) throw fatal("The browser generated an invalid or oversized video offer.");
      const answer = await request("offer", { lease: session.lease, generation: session.generation, resident: session.resident, sdp }, { signal: session.controller.signal, timeout: 12000 });
      if (current !== session) return;
      if (typeof answer.sdp !== "string" || answer.sdp.length > 65536) throw fatal("Live service returned an invalid video answer.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      failed(session, error);
    }
  }

  select.addEventListener("change", () => {
    // The last status described the previous resident's host; forget it before
    // redrawing, then read this one's.
    enabled = null;
    end("Selection changed. Press Watch to tune that resident's host channel.");
    updateAvailability();
    if (!unavailableMessage()) void loadStatus();
  });
  watch.addEventListener("click", () => { void start(); });
  stop.addEventListener("click", () => end());
  audioButton.addEventListener("click", () => {
    if (!current?.playing || !current.audio) return;
    const session = current;
    video.muted = !video.muted;
    buttons();
    void video.play().catch(() => {
      if (current !== session) return;
      video.muted = true;
      buttons();
      detail.textContent = "The browser refused audio playback. Game audio remains muted.";
    });
  });
  fullscreen.addEventListener("click", async () => {
    if (!current?.playing) return;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      // Video-only fullscreen would hide the game chat.
      else fullscreenNote.textContent = "This browser cannot show video and chat in fullscreen. Both remain visible here.";
    } catch {
      fullscreenNote.textContent = "Fullscreen was refused by the browser. Video is still playing here.";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen.textContent = document.fullscreenElement === stage ? "Exit fullscreen" : "Fullscreen";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (current || wanted)) end("Stopped while this page was hidden. Press Watch to resume.");
    buttons();
  });
  window.addEventListener("pagehide", () => end("Stopped when leaving this page. Press Watch to resume."));
  window.addEventListener("pageshow", buttons);
  setState(supported ? "idle" : "disabled", supported ? "Choose a resident, then press Watch." : "This browser does not support WebRTC video.");

  // Status describes the channel on the host of the resident being watched (or selected).
  async function loadStatus() {
    if (!active || document.hidden) return;
    const expectedRevision = revision, name = current?.resident ?? wanted?.resident ?? select.value;
    try {
      const data = await request(name ? `status?resident=${encodeURIComponent(name)}` : "status");
      if (!active || document.hidden || revision !== expectedRevision) return;
      showChannel(data);
      if (current?.lease && (!matches(current, data) || Date.now() >= current.expiresAt)) {
        lost(current, "The shared channel changed, ended, or your lease expired. Press Watch to join again.");
      } else if (current?.lease) setResuming(current, data.resuming === true);
      updateAvailability();
      buttons();
      renderContext();
    } catch (error) {
      if (!active || document.hidden || revision !== expectedRevision) return;
      channel.textContent = "Live service status is unavailable.";
      enabled = null;
      if (current) failed(current, error);
      else {
        if (unavailableMessage()) updateAvailability();
        else if (!wanted) detail.textContent = error.message;
        buttons();
      }
    }
  }

  return {
    setActive(value) {
      if (active === value) return;
      active = value;
      if (!active) end("Stopped when leaving Live. Press Watch to resume.");
      updateAvailability();
      buttons();
    },
    updateResidents(data) {
      residents = data.residents;
      sampleSeconds = data.sampleSeconds;
      const options = residents.map(entry => {
        const label = `${entry.name} (${entry.host})${entry.hostUnreachable ? " — host unreachable"
          : entry.liveAvailable !== true ? " — Live unavailable" : ""}`;
        return new Option(label, entry.name);
      });
      if (options.length !== select.options.length || options.some((option, index) =>
        select.options[index].value !== option.value || select.options[index].text !== option.text)) {
        const selected = select.value;
        const watching = current?.resident ?? wanted?.resident;
        if (watching && !residents.some(entry => entry.name === watching)) end("This resident is no longer configured.", "error");
        select.replaceChildren(...options);
        if (residents.some(entry => entry.name === selected)) select.value = selected;
      }
      updateAvailability();
      buttons();
      renderContext();
    },
    loadStatus,
  };
}
