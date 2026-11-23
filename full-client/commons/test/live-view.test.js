import { describe, expect, mock, test } from "bun:test";
import { createLiveView } from "../public/live-view.js";

// Small media/DOM harness: no browser, capture device or real WebRTC connection.
class Element {
  value = "";
  options = [];
  listeners = {};
  style = { setProperty() {}, removeProperty() {} };
  dataset = {};
  addEventListener(type, listener) { this.listeners[type] = listener; }
  replaceChildren(...children) {
    this.options = children;
    this.value = children[0]?.value ?? "";
  }
  removeAttribute() {}
  setAttribute() {}
  append() {}
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
}

async function withLiveView(run, overrides = {}) {
  const elements = new Map();
  const find = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const fetchStatus = mock(async () => ({ ok: true, json: async () => ({ enabled: true, state: "idle", viewers: 0 }) }));
  const globals = {
    document: { hidden: false, fullscreenElement: null, addEventListener() {}, createElement() { return new Element(); } },
    window: { addEventListener() {} },
    RTCPeerConnection: class {},
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    fetch: fetchStatus,
    ...overrides,
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const view = createLiveView({ querySelector: find }, { now: Date.now, stamp: at => `seen:${at}`, colour: () => "black" });
    await run({ view, find, fetchStatus });
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const resident = (name, host, liveAvailable, extra = {}) => ({ name, host, liveAvailable, hostUnreachable: false, hostLastSeen: 1234, ...extra });
const reply = (residents, role = "hub") => ({ residents, role, sampleSeconds: 5, federationErrors: [] });

// Drains promise chains between fake timer callbacks; setImmediate is never faked.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// Fake clock, timers, Live service and WebRTC peer for reconnect tests.
function liveRig() {
  let clock = 1_000_000, nextTimer = 1;
  const timers = new Map(), peers = [], calls = [], listeners = { document: {}, window: {} };
  const service = { state: "live", enabled: true, resuming: false, generation: 0, watchStatus: 200, resident: null };
  const status = () => ({ enabled: service.enabled, state: service.state, resident: service.resident, generation: service.generation,
    viewers: 1, detail: "", audio: false, videoOnly: true, resuming: service.resuming });
  const routes = {
    watch: body => {
      if (service.watchStatus !== 200) return [service.watchStatus, { error: "Resident framebuffer unavailable." }];
      service.generation++;
      service.state = "live";
      service.resident = body.resident;
      return [200, { ...status(), lease: `lease-${service.generation}` }];
    },
    heartbeat: () => [200, status()],
    status: () => [200, status()],
    offer: () => [200, { sdp: "v=0" }],
    stop: () => [200, status()],
  };
  const fetch = mock(async (url, init) => {
    const route = url.split("/").pop().split("?")[0], body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const [code, data] = routes[route](body);
    return { ok: code < 400, status: code, json: async () => data };
  });
  class Peer {
    iceGatheringState = "complete";
    connectionState = "new";
    constructor() { peers.push(this); }
    addTransceiver() {}
    async createOffer() { return { type: "offer", sdp: "v=0" }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() { this.connected = true; }
    getReceivers() { return []; }
    close() { this.closed = true; }
  }
  class Stream {
    tracks = [];
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  }
  class FakeDate extends Date { static now() { return clock; } }
  const on = target => (type, listener) => { (listeners[target][type] ??= []).push(listener); };
  const document = { hidden: false, fullscreenElement: null, addEventListener: on("document"), createElement: () => new Element() };
  return {
    service, peers, calls, document,
    watches: () => calls.filter(call => call.route === "watch"),
    released: () => calls.filter(call => call.route === "stop").map(call => call.body.lease),
    dispatch(target, type) { for (const listener of listeners[target][type] ?? []) listener(); },
    globals: {
      Date: FakeDate,
      setTimeout: (callback, delay = 0) => {
        const id = nextTimer++;
        timers.set(id, { at: clock + Math.max(0, delay), callback });
        return id;
      },
      clearTimeout: id => { timers.delete(id); },
      fetch, document, window: { addEventListener: on("window") },
      RTCPeerConnection: Peer, MediaStream: Stream,
      location: { pathname: "/commons/overlay/preview" },
    },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const [id, timer] = [...timers].filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] ?? [];
        if (!timer) break;
        timers.delete(id);
        clock = timer.at;
        timer.callback();
        await settle();
      }
      clock = target;
    },
  };
}

// Completes the latest negotiation and plays one video track.
async function playLatest(rig, video) {
  await settle();
  const peer = rig.peers.at(-1), track = { kind: "video", stop() {} };
  expect(peer.connected).toBe(true);
  peer.ontrack({ track });
  video.readyState = 2;
  video.videoWidth = 640;
  video.onplaying();
  return { peer, track };
}

async function watchGary(rig, view, find) {
  view.updateResidents(reply([resident("Gary", "inspiron", true), resident("Wren", "chungus1", true)]));
  view.setActive(true);
  find("#live-watch").listeners.click();
  return playLatest(rig, find("#live-video"));
}

const BETWEEN = "Between worlds; holding the last picture.";

describe("federated Live controls", () => {
  test("a remote resident whose station reports Live unavailable cannot be watched; status is never read for it", async () => {
    await withLiveView(async ({ view, find, fetchStatus }) => {
      view.updateResidents(reply([resident("Gary", "inspiron", true), resident("Wren", "chungus1", false)]));
      view.setActive(true);
      const select = find("#live-resident"), watch = find("#live-watch");
      expect(select.options.map(option => option.text)).toEqual(["Gary (inspiron)", "Wren (chungus1) — Live unavailable"]);
      select.value = "Wren";
      select.listeners.change();
      expect(watch.disabled).toBe(true);
      expect(watch.textContent).toBe("Unavailable");
      expect(find("#live-detail").textContent).toContain("Wren on host chungus1");
      watch.listeners.click();
      expect(fetchStatus).not.toHaveBeenCalled();
      await view.loadStatus();
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(fetchStatus.mock.calls[0][0]).toBe("api/live/status?resident=Wren");
      expect(watch.disabled).toBe(true);
      expect(watch.textContent).toBe("Unavailable");
      select.value = "Gary";
      select.listeners.change();
      expect(watch.disabled).toBe(false);
      expect(watch.textContent).toBe("Watch");
      // Selecting an available resident reads that resident's host channel.
      await settle();
      expect(fetchStatus.mock.calls.at(-1)[0]).toBe("api/live/status?resident=Gary");
      expect(watch.disabled).toBe(false);
    });
  });

  test("host reachability updates labels and exposes the last successful sample", async () => {
    await withLiveView(async ({ view, find }) => {
      view.setActive(true);
      view.updateResidents(reply([resident("Gary", "inspiron", true)]));
      expect(find("#live-watch").disabled).toBe(false);
      view.updateResidents(reply([resident("Gary", "inspiron", true, { hostUnreachable: true })]));
      expect(find("#live-resident").options[0].text).toContain("host unreachable");
      expect(find("#live-watch").disabled).toBe(true);
      expect(find("#live-detail").textContent).toContain("Host last seen seen:1234");
      view.updateResidents(reply([resident("Gary", "inspiron", true, { hostUnreachable: true, hostLastSeen: null })]));
      expect(find("#live-detail").textContent).toContain("Host not reached yet");
      view.updateResidents(reply([resident("Gary", "inspiron", true)]));
      expect(find("#live-watch").disabled).toBe(false);
      expect(find("#live-status").textContent).toBe("Idle");
    });
  });

  test("a remote resident is watchable when its station reports Live; status follows its host and the disabled reason names it", async () => {
    await withLiveView(async ({ view, find, fetchStatus }) => {
      fetchStatus.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith("resident=Wren")
        ? { enabled: false, state: "disabled", resident: null, generation: 0, viewers: 0, detail: "Live video is disabled on host chungus1.", host: "chungus1" }
        : { enabled: true, state: "idle", resident: null, generation: 3, viewers: 0, detail: "", host: "inspiron" } }));
      view.updateResidents(reply([resident("Gary", "inspiron", true), resident("Wren", "chungus1", true)]));
      view.setActive(true);
      const select = find("#live-resident"), watch = find("#live-watch");
      await view.loadStatus();
      expect(find("#live-channel").textContent).toContain("Channel on inspiron");
      select.value = "Wren";
      select.listeners.change();
      expect(watch.disabled).toBe(false);
      await settle();
      expect(fetchStatus.mock.calls.at(-1)[0]).toBe("api/live/status?resident=Wren");
      expect(find("#live-channel").textContent).toContain("disabled on chungus1");
      expect(watch.disabled).toBe(true);
      expect(find("#live-detail").textContent).toBe("Live video is disabled on host chungus1.");
      // Back to a hub resident: the previous host's "disabled" must not linger on Watch.
      select.value = "Gary";
      select.listeners.change();
      expect(watch.disabled).toBe(false);
      await settle();
      expect(fetchStatus.mock.calls.at(-1)[0]).toBe("api/live/status?resident=Gary");
      expect(find("#live-channel").textContent).toContain("Channel on inspiron");
      expect(watch.disabled).toBe(false);
    });
  });

  test("a station dashboard watches its own residents when the station enables Live", async () => {
    await withLiveView(async ({ view, find, fetchStatus }) => {
      view.updateResidents(reply([resident("Wren", "chungus1", true)], "station"));
      view.setActive(true);
      await view.loadStatus();
      expect(fetchStatus.mock.calls[0][0]).toBe("api/live/status?resident=Wren");
      expect(find("#live-watch").disabled).toBe(false);
      expect(find("#live-watch").textContent).toBe("Watch");
    });
  });

  test("a locally disabled resident remains unavailable even when status says enabled", async () => {
    await withLiveView(async ({ view, find }) => {
      view.updateResidents(reply([resident("Gary", "inspiron", false)]));
      view.setActive(true);
      await view.loadStatus();
      expect(find("#live-watch").disabled).toBe(true);
      expect(find("#live-resident").options[0].text).toContain("Live unavailable");
    });
  });
});

test("Live receives optional audio without replacing video and requires explicit unmute", async () => {
  for (const audio of [false, true]) {
    let peer, negotiated;
    const ready = new Promise(resolve => { negotiated = resolve; });
    class Peer {
      iceGatheringState = "complete";
      transceivers = [];
      constructor() { peer = this; }
      addTransceiver(kind, options) { this.transceivers.push({ kind, ...options }); }
      async createOffer() { return { type: "offer", sdp: "v=0" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() { negotiated(); }
      getReceivers() { return []; }
      close() {}
    }
    class Stream {
      tracks = [];
      addTrack(track) { this.tracks.push(track); }
      getTracks() { return this.tracks; }
    }
    await withLiveView(async ({ view, find, fetchStatus }) => {
      fetchStatus.mockImplementation(async route => ({
        ok: true,
        json: async () => route.endsWith("/offer") ? { sdp: "v=0\\r\\n" } : {
          enabled: true, state: "live", resident: "Gary", generation: 1, lease: "fixture-lease", viewers: 1, audio, videoOnly: !audio,
        },
      }));
      view.updateResidents(reply([resident("Gary", "inspiron", true)]));
      view.setActive(true);
      find("#live-watch").listeners.click();
      await ready;
      try {
        expect(peer.transceivers).toEqual((audio ? ["video", "audio"] : ["video"]).map(kind => ({ kind, direction: "recvonly" })));
        const videoTrack = { kind: "video", stop: mock(() => {}) };
        const audioTrack = { kind: "audio", stop: mock(() => {}) };
        peer.ontrack({ track: videoTrack });
        const video = find("#live-video"), media = video.srcObject;
        peer.ontrack({ track: audioTrack });
        expect(video.srcObject).toBe(media);
        expect(media.getTracks()).toHaveLength(audio ? 2 : 1);
        expect(audioTrack.stop).toHaveBeenCalledTimes(audio ? 0 : 1);
        video.readyState = 2;
        video.onplaying();
        expect(video.muted).toBe(true);
        expect(find("#live-audio").disabled).toBe(!audio);
        find("#live-audio").listeners.click();
        expect(video.muted).toBe(!audio);
        if (audio) {
          find("#live-audio").listeners.click();
          expect(video.muted).toBe(true);
        }
      } finally {
        find("#live-stop").listeners.click();
        expect(find("#live-video").srcObject).toBeNull();
        expect(find("#live-video").muted).toBe(true);
      }
    }, { RTCPeerConnection: Peer, MediaStream: Stream });
  }
});

describe("Live recovery", () => {
  test("a resuming channel stays live with a between-worlds message until frames return", async () => {
    const rig = liveRig();
    await withLiveView(async ({ view, find }) => {
      await watchGary(rig, view, find);
      const status = find("#live-status"), detail = find("#live-detail");
      expect(status.textContent).toBe("Live");
      rig.service.resuming = true;
      await rig.advance(10000);
      expect(status.textContent).toBe("Live");
      expect(detail.textContent).toBe(BETWEEN);
      expect(find("#live-video").hidden).toBe(false);
      expect(find("#live-stop").disabled).toBe(false);
      rig.service.resuming = false;
      await view.loadStatus();
      expect(detail.textContent).toContain("Receiving live video");
      rig.service.resuming = true;
      await view.loadStatus();
      expect(detail.textContent).toBe(BETWEEN);
      rig.service.resuming = false;
      await rig.advance(10000);
      expect(status.textContent).toBe("Live");
      expect(detail.textContent).toContain("Receiving live video");
      expect(rig.released()).toEqual([]);
      expect(rig.watches()).toHaveLength(1);
    }, rig.globals);
  });

  test("a lost channel re-Watches the same resident after 1 s, 3 s and 8 s, then gives up", async () => {
    const rig = liveRig();
    await withLiveView(async ({ view, find }) => {
      await watchGary(rig, view, find);
      const detail = find("#live-detail");
      rig.service.state = "error";
      await rig.advance(10000);
      expect(detail.textContent).toBe("Reconnecting (1 of 3)…");
      expect(find("#live-status").textContent).toBe("Connecting");
      expect(find("#live-stop").disabled).toBe(false);
      expect(rig.released()).toEqual(["lease-1"]);
      rig.service.watchStatus = 503;
      for (const [attempt, delay] of [[1, 1000], [2, 3000], [3, 8000]]) {
        await rig.advance(delay - 1);
        expect(rig.watches()).toHaveLength(attempt);
        await rig.advance(1);
        expect(rig.watches()).toHaveLength(attempt + 1);
        if (attempt < 3) expect(detail.textContent).toBe(`Reconnecting (${attempt + 1} of 3)…`);
      }
      expect(find("#live-status").textContent).toBe("Error");
      expect(detail.textContent).toContain("Gave up reconnecting to Gary after 3 attempts in 2 minutes.");
      expect(detail.textContent).toContain("Press Watch");
      expect(find("#live-stop").disabled).toBe(true);
      expect(find("#live-watch").disabled).toBe(false);
      await rig.advance(300000);
      expect(rig.watches()).toHaveLength(4);
      expect(rig.watches().every(call => call.body.resident === "Gary")).toBe(true);
    }, rig.globals);
  });

  test("a reconnect resumes playback, keeps heartbeats and lets attempts roll out of the window", async () => {
    const rig = liveRig();
    await withLiveView(async ({ view, find }) => {
      const video = find("#live-video"), detail = find("#live-detail");
      let { peer, track } = await watchGary(rig, view, find);
      track.onended();
      expect(detail.textContent).toBe("Reconnecting (1 of 3)…");
      await rig.advance(1000);
      ({ peer, track } = await playLatest(rig, video));
      expect(find("#live-status").textContent).toBe("Live");
      peer.connectionState = "failed";
      peer.onconnectionstatechange();
      expect(detail.textContent).toBe("Reconnecting (2 of 3)…");
      await rig.advance(3000);
      ({ peer, track } = await playLatest(rig, video));
      await rig.advance(121000);
      expect(find("#live-status").textContent).toBe("Live");
      expect(rig.calls.filter(call => call.route === "heartbeat" && call.body.lease === "lease-3").length).toBeGreaterThan(10);
      track.onmute();
      expect(detail.textContent).toBe("Reconnecting (1 of 3)…");
      expect(rig.released()).toEqual(["lease-1", "lease-2", "lease-3"]);
      expect(rig.watches()).toHaveLength(3);
      // Every lease request names its resident so a hub can route it to that resident's host.
      const leased = rig.calls.filter(call => ["heartbeat", "offer", "stop"].includes(call.route));
      expect(leased.length).toBeGreaterThan(0);
      expect(leased.every(call => call.body.resident === "Gary")).toBe(true);
    }, rig.globals);
  });

  test("no automatic Watch follows Stop, a hidden page, a switch, leaving Live, unavailability or navigation", async () => {
    const actions = {
      stop: ({ find }) => find("#live-stop").listeners.click(),
      hidden: ({ rig }) => { rig.document.hidden = true; rig.dispatch("document", "visibilitychange"); },
      switch: ({ find }) => { const select = find("#live-resident"); select.value = "Wren"; select.listeners.change(); },
      inactive: ({ view }) => view.setActive(false),
      disabled: ({ view }) => view.updateResidents(reply([resident("Gary", "inspiron", false), resident("Wren", "chungus1", true)])),
      pagehide: ({ rig }) => rig.dispatch("window", "pagehide"),
    };
    const results = {}, expected = {};
    for (const [name, act] of Object.entries(actions)) {
      for (const when of ["live", "backoff"]) {
        const rig = liveRig();
        await withLiveView(async ({ view, find }) => {
          const { track } = await watchGary(rig, view, find);
          if (when === "backoff") track.onended();
          act({ rig, view, find });
          // A late failure from the ended session must not restart it either.
          track.onended();
          await rig.advance(60000);
          results[`${name}/${when}`] = { watches: rig.watches().length, released: rig.released(), stop: find("#live-stop").disabled,
            reconnecting: find("#live-detail").textContent.includes("Reconnecting") };
          expected[`${name}/${when}`] = { watches: 1, released: ["lease-1"], stop: true, reconnecting: false };
        }, rig.globals);
      }
    }
    expect(results).toEqual(expected);
  });

  test("a host-disabled channel and a refused first Watch do not retry", async () => {
    let rig = liveRig();
    await withLiveView(async ({ view, find }) => {
      await watchGary(rig, view, find);
      rig.service.enabled = false;
      await view.loadStatus();
      expect(find("#live-status").textContent).toBe("Unavailable");
      await rig.advance(60000);
      expect(rig.watches()).toHaveLength(1);
    }, rig.globals);
    rig = liveRig();
    rig.service.watchStatus = 503;
    await withLiveView(async ({ view, find }) => {
      view.updateResidents(reply([resident("Gary", "inspiron", true)]));
      view.setActive(true);
      find("#live-watch").listeners.click();
      await settle();
      expect(find("#live-status").textContent).toBe("Error");
      expect(find("#live-detail").textContent).toBe("Resident framebuffer unavailable.");
      await rig.advance(60000);
      expect(rig.watches()).toHaveLength(1);
    }, rig.globals);
  });
});

describe("overlay preview recovery", () => {
  async function withOverlay(run) {
    const rig = liveRig();
    await withLiveView(async () => {
      // overlay-core reads location at import, so import only after globals exist.
      const { createPreviewMedia } = await import("../public/overlay-media.js");
      const parts = Object.fromEntries(["video", "blank", "watch", "stop", "audio", "fullscreen", "stage", "status"].map(key => [key, new Element()]));
      let who = "Gary";
      const media = createPreviewMedia({ ...parts, resident: () => who });
      media.availability(true);
      await run({
        rig, media, parts,
        watchAndPlay: async () => { parts.watch.listeners.click(); return playLatest(rig, parts.video); },
        switchTo: name => { who = name; media.selectionChanged(); },
      });
    }, rig.globals);
  }

  test("resuming shows the held-picture message without ending the session", async () => {
    await withOverlay(async ({ rig, parts, watchAndPlay }) => {
      await watchAndPlay();
      expect(parts.status.dataset.state).toBe("live");
      rig.service.resuming = true;
      await rig.advance(10000);
      expect(parts.status.textContent).toBe(BETWEEN);
      expect(parts.status.dataset.state).toBe("live");
      expect(parts.stop.disabled).toBe(false);
      rig.service.resuming = false;
      await rig.advance(10000);
      expect(parts.status.textContent).toBe("Live video only. Audio capture is not enabled for this channel.");
      expect(rig.released()).toEqual([]);
    });
  });

  test("a lost channel retries at most three times in two minutes", async () => {
    await withOverlay(async ({ rig, parts, watchAndPlay }) => {
      await watchAndPlay();
      rig.service.state = "error";
      await rig.advance(10000);
      expect(parts.status.textContent).toBe("Reconnecting (1 of 3)…");
      expect(parts.status.dataset.state).toBe("connecting");
      expect(parts.stop.disabled).toBe(false);
      rig.service.watchStatus = 503;
      await rig.advance(1000);
      expect(parts.status.textContent).toBe("Reconnecting (2 of 3)…");
      await rig.advance(3000);
      expect(parts.status.textContent).toBe("Reconnecting (3 of 3)…");
      await rig.advance(7999);
      expect(rig.watches()).toHaveLength(3);
      await rig.advance(1);
      expect(rig.watches()).toHaveLength(4);
      expect(parts.status.textContent).toContain("Gave up reconnecting after 3 attempts in 2 minutes.");
      expect(parts.status.dataset.state).toBe("error");
      await rig.advance(300000);
      expect(rig.watches()).toHaveLength(4);
      expect(rig.released()).toEqual(["lease-1"]);
    });
  });

  test("Stop, a hidden page, a resident switch, unavailability and navigation cancel retries", async () => {
    const actions = {
      stop: ({ parts }) => parts.stop.listeners.click(),
      hidden: ({ rig }) => { rig.document.hidden = true; rig.dispatch("document", "visibilitychange"); },
      switch: ({ switchTo }) => switchTo("Wren"),
      unavailable: ({ media }) => media.availability(false),
      pagehide: ({ rig }) => rig.dispatch("window", "pagehide"),
    };
    const results = {}, expected = {};
    for (const [name, act] of Object.entries(actions)) {
      await withOverlay(async context => {
        const { track } = await context.watchAndPlay();
        // Teardown clears track handlers, so keep the ended session's own callback.
        const ended = track.onended;
        ended();
        const reconnecting = context.parts.status.textContent;
        act(context);
        ended();
        await context.rig.advance(60000);
        results[name] = { reconnecting, watches: context.rig.watches().length, stop: context.parts.stop.disabled };
        expected[name] = { reconnecting: "Reconnecting (1 of 3)…", watches: 1, stop: true };
      });
    }
    expect(results).toEqual(expected);
  });
});
