import { describe, expect, mock, test } from "bun:test";
import { createLiveView } from "../public/live-view.js";

// A small DOM harness for the controls used before a viewing lease is acquired.
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
  pause() {}
  load() {}
}

async function withLiveView(run) {
  const elements = new Map();
  const find = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const fetchStatus = mock(async () => ({ ok: true, json: async () => ({ enabled: true, state: "idle", viewers: 0 }) }));
  const globals = {
    document: { hidden: false, fullscreenElement: null, addEventListener() {} },
    window: { addEventListener() {} },
    RTCPeerConnection: class {},
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    fetch: fetchStatus,
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
