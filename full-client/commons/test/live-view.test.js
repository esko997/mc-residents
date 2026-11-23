import { describe, expect, mock, test } from "bun:test";
import { createLiveView } from "../public/live-view.js";

// Small media/DOM harness: no browser, capture device or real WebRTC connection.
class Element {
  value = "";
  options = [];
  listeners = {};
  style = { setProperty() {}, removeProperty() {} };
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

describe("federated Live controls", () => {
  test("local-only Live status never enables Watch for a remote resident", async () => {
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
      expect(fetchStatus.mock.calls[0][0]).toBe("api/live/status");
      expect(watch.disabled).toBe(true);
      expect(watch.textContent).toBe("Unavailable");
      select.value = "Gary";
      select.listeners.change();
      expect(watch.disabled).toBe(false);
      expect(watch.textContent).toBe("Watch");
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

  test("stations do not poll the disabled Live endpoint", async () => {
    await withLiveView(async ({ view, find, fetchStatus }) => {
      view.updateResidents(reply([resident("Wren", "chungus1", true)], "station"));
      view.setActive(true);
      await view.loadStatus();
      expect(fetchStatus).not.toHaveBeenCalled();
      expect(find("#live-watch").disabled).toBe(true);
      expect(find("#live-watch").textContent).toBe("Unavailable");
      expect(find("#live-channel").textContent).toContain("disabled on stations");
      expect(find("#live-detail").textContent).toContain("Use the Commons hub");
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
