"use strict";

// One explicit viewing session. Polling reads status; only Watch acquires a lease.
// A cancelled watch request is allowed to finish so its late lease can be released.
export function createLiveView(root, { now, stamp, colour }) {
  const find = selector => root.querySelector(selector);
  const select = find("#live-resident"), watch = find("#live-watch"), stop = find("#live-stop");
  const video = find("#live-video"), stage = find("#live-stage"), blank = find("#live-blank");
  const status = find("#live-status"), detail = find("#live-detail"), channel = find("#live-channel");
  const context = find("#live-context"), facts = find("#live-facts"), contextTime = find("#live-context-time");
  const fullscreen = find("#live-fullscreen"), fullscreenNote = find("#live-fullscreen-note");
  const supported = typeof RTCPeerConnection === "function";
  let active = false, enabled = null, current = null, pendingWatch = false, revision = 0;
  let residents = [], sampleSeconds = 5, mode = "idle", station = false;

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
        throw new Error(message);
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
    if (station) return "Live video is disabled on stations. Use the Commons hub.";
    if (!supported) return "This browser does not support WebRTC video.";
    const resident = residents.find(entry => entry.name === select.value);
    if (!resident) return "No residents are configured.";
    if (resident.hostUnreachable) return `Host ${resident.host} is unreachable. ${resident.hostLastSeen === null
      ? "Host not reached yet." : `Host last seen ${stamp(resident.hostLastSeen)}.`}`;
    if (resident.liveAvailable !== true) return `Live video is unavailable for ${resident.name} on host ${resident.host}.`;
    if (enabled === false) return "Live video is disabled on this host.";
    return "";
  }

  function updateAvailability() {
    const message = unavailableMessage();
    if (message) {
      if (current) end(message, "disabled");
      else setState("disabled", message);
    } else if (!current && mode === "disabled") setState("idle", "Choose a resident, then press Watch.");
  }

  function buttons() {
    const unavailable = unavailableMessage();
    watch.disabled = !active || document.hidden || !!unavailable || !!current || pendingWatch;
    watch.textContent = unavailable ? "Unavailable" : "Watch";
    watch.title = unavailable || (pendingWatch && !current ? "Waiting for the cancelled start request to finish and release its lease." : "");
    stop.disabled = !current;
    select.disabled = residents.length === 0;
    fullscreen.disabled = !current?.playing;
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
    // Hide first: even a retained decoder frame must never appear under a new name.
    video.hidden = true;
    blank.hidden = false;
    video.onplaying = null;
    video.pause();
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

  function release(lease, generation, expectedRevision) {
    // keepalive is also used on pagehide. JSON matches the normal stop route;
    // no beacon content-type exception or additional backend contract is needed.
    void request("stop", { lease, generation }, { keepalive: true }).then(data => {
      if (revision === expectedRevision && !current) showChannel(data);
    }).catch(() => {
      if (revision === expectedRevision && !current) {
        detail.textContent = "Playback stopped here; the server did not confirm release. The viewing lease expires within 30 seconds of its last heartbeat.";
      }
    });
  }

  function end(message = "Stopped. Press Watch when you want to watch again.", next = "idle") {
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
      if (session.lease) release(session.lease, session.generation, revision);
    }
    clearMedia();
    setState(next, message);
  }

  function matches(session, data) {
    return data.enabled === true && data.resident === session.resident && data.generation === session.generation
      && (data.state === "starting" || data.state === "live");
  }

  function showChannel(data) {
    enabled = data.enabled;
    channel.textContent = !data.enabled ? `Live video is disabled. ${data.detail || "Ask the host operator to enable it."}`
      : data.resident ? `Shared channel: ${data.resident}. Service ${data.state}; ${data.viewers} viewer${data.viewers === 1 ? "" : "s"}. ${data.detail || ""}`
      : `Shared channel: ${data.state}. ${data.detail || "No resident is being streamed."}`;
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
        end("Your viewing lease expired. Press Watch to join again.", "error");
        return;
      }
      // Use request start, not response arrival, as the conservative lease clock.
      const sentAt = Date.now();
      try {
        const data = await request("heartbeat", { lease: session.lease, generation: session.generation }, { signal: session.controller.signal });
        if (current !== session) return;
        if (!matches(session, data)) {
          end("The shared channel changed or ended. Press Watch to join again.", "error");
          return;
        }
        session.expiresAt = sentAt + 30000;
        scheduleHeartbeat(session);
      } catch (error) {
        if (current === session) end(error.message, "error");
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

  async function start() {
    if (watch.disabled) return;
    end();
    const session = { resident: select.value, controller: new AbortController(), peer: null, lease: null, playing: false };
    current = session;
    pendingWatch = true;
    setState("connecting", `Starting ${session.resident}'s video…`);
    try {
      // Do not abort this request on selection/navigation: collect and release a
      // late lease. No second Watch is sent until this request has settled.
      let data;
      try { data = await request("watch", { resident: session.resident }, { timeout: 35000 }); }
      finally { pendingWatch = false; buttons(); }
      if (typeof data.lease !== "string" || !Number.isSafeInteger(data.generation)) throw new Error("Live service returned an invalid viewing lease.");
      if (current !== session) {
        release(data.lease, data.generation, revision);
        return;
      }
      // Status reads started before acquisition describe the previous channel.
      revision++;
      session.lease = data.lease;
      session.generation = data.generation;
      if (!matches(session, data)) throw new Error("The shared channel changed before viewing started. Press Watch to join again.");
      showChannel(data);
      session.expiresAt = Date.now() + 30000;
      scheduleHeartbeat(session);
      session.deadline = setTimeout(() => {
        if (current === session) end("No video arrived within 25 seconds. Check the live service and network, then press Watch.", "error");
      }, 25000);
      const peer = session.peer = new RTCPeerConnection({ iceServers: [] });
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.onconnectionstatechange = () => {
        if (current !== session) return;
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          end("The video connection ended. Press Watch to reconnect.", "error");
        }
      };
      peer.ontrack = event => {
        if (current !== session || event.track.kind !== "video") { event.track.stop(); return; }
        event.track.onended = () => {
          if (current === session) end("The video track ended. Press Watch to reconnect.", "error");
        };
        event.track.onmute = () => {
          if (current === session && session.playing) end("Video is no longer arriving. Press Watch to reconnect.", "error");
        };
        video.srcObject = new MediaStream([event.track]);
        video.onplaying = () => {
          if (current !== session || video.readyState < 2) return;
          clearTimeout(session.deadline);
          session.playing = true;
          video.hidden = false;
          blank.hidden = true;
          find("#live-name").textContent = session.resident;
          stage.style.setProperty("--who", colour(session.resident));
          setState("live", "Receiving live video. Video only; no audio is captured or played.");
          renderContext();
        };
        void video.play().catch(() => {
          if (current === session) end("The browser could not play the video. Press Watch to try again.", "error");
        });
      };
      setState("connecting", `Connecting to ${session.resident}'s video…`);
      await peer.setLocalDescription(await peer.createOffer());
      await gatherIce(peer, session.controller.signal);
      if (current !== session) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp || sdp.length > 65536) throw new Error("The browser generated an invalid or oversized video offer.");
      const answer = await request("offer", { lease: session.lease, generation: session.generation, sdp }, { signal: session.controller.signal, timeout: 12000 });
      if (current !== session) return;
      if (typeof answer.sdp !== "string" || answer.sdp.length > 65536) throw new Error("Live service returned an invalid video answer.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      if (current === session) end(error instanceof DOMException ? "WebRTC could not connect. Check browser and network support, then press Watch." : error.message, "error");
    }
  }

  select.addEventListener("change", () => {
    end("Selection changed. Press Watch to tune the shared channel.");
    updateAvailability();
  });
  watch.addEventListener("click", () => { void start(); });
  stop.addEventListener("click", () => end());
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
    if (document.hidden && current) end("Stopped while this page was hidden. Press Watch to resume.");
    buttons();
  });
  window.addEventListener("pagehide", () => end("Stopped when leaving this page. Press Watch to resume."));
  window.addEventListener("pageshow", buttons);
  setState(supported ? "idle" : "disabled", supported ? "Choose a resident, then press Watch." : "This browser does not support WebRTC video.");

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
      station = data.role === "station";
      const options = residents.map(entry => {
        const label = `${entry.name} (${entry.host})${entry.hostUnreachable ? " — host unreachable"
          : station || entry.liveAvailable !== true ? " — Live unavailable" : ""}`;
        return new Option(label, entry.name);
      });
      if (options.length !== select.options.length || options.some((option, index) =>
        select.options[index].value !== option.value || select.options[index].text !== option.text)) {
        const selected = select.value;
        if (current && !residents.some(entry => entry.name === current.resident)) end("This resident is no longer configured.", "error");
        select.replaceChildren(...options);
        if (residents.some(entry => entry.name === selected)) select.value = selected;
      }
      if (station) {
        enabled = false;
        channel.textContent = "Live video is disabled on stations.";
      }
      updateAvailability();
      buttons();
      renderContext();
    },
    async loadStatus() {
      if (!active || document.hidden || station) return;
      const expectedRevision = revision;
      try {
        const data = await request("status");
        if (!active || document.hidden || station || revision !== expectedRevision) return;
        showChannel(data);
        if (current?.lease && (!matches(current, data) || Date.now() >= current.expiresAt)) {
          end("The shared channel changed, ended, or your lease expired. Press Watch to join again.", "error");
        }
        updateAvailability();
        buttons();
        renderContext();
      } catch (error) {
        if (!active || document.hidden || station || revision !== expectedRevision) return;
        channel.textContent = "Live service status is unavailable.";
        enabled = null;
        if (current) end(error.message, "error");
        else {
          if (unavailableMessage()) updateAvailability();
          else detail.textContent = error.message;
          buttons();
        }
      }
    },
  };
}
