import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUTS, OverlayStore, WIDGET_IDS, WIDGET_SIZES, overlayPresets, validateOverlayState } from "../src/overlay-state.ts";
import { tempHome, type Home } from "./helpers.ts";

const homes: Home[] = [];
afterEach(() => { for (const home of homes.splice(0)) home.remove(); });
function setup() {
  const home = tempHome(); homes.push(home);
  const path = join(home.dir, "commons", "test.sqlite");
  return { home, path, store: new OverlayStore(path, ["Gary", "Margo"], ["spesk01", "Piper", "spesk01"]) };
}

test("overlay state persists atomically with private permissions and reloads independently", () => {
  const { store, path } = setup(), state = store.get();
  expect(state.hideNames).toEqual(["spesk01", "Piper"]);
  state.title = "A walk along the coast";
  state.resident = "margo";
  const saved = store.replace(0, state);
  expect(saved.revision).toBe(1);
  expect(saved.resident).toBe("Margo");
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual(saved);
  const reloaded = new OverlayStore(path, ["Gary", "Margo"]);
  expect(reloaded.get()).toEqual(saved);
  saved.widgets.chat.x = 500;
  expect(reloaded.get().widgets.chat.x).not.toBe(500);
});

test("invalid, huge and symlink state files fail explicitly and are never replaced", () => {
  const { home, path, store } = setup();
  home.put("commons/test.sqlite.overlay.json", "{half-written");
  expect(() => new OverlayStore(path, ["Gary"])).toThrow("unreadable or invalid");
  expect(readFileSync(store.path, "utf8")).toBe("{half-written");
  writeFileSync(store.path, " ".repeat(32_769));
  expect(() => new OverlayStore(path, ["Gary"])).toThrow("unreadable or invalid");
  const other = home.put("other.overlay.json", JSON.stringify(store.get()));
  symlinkSync(other, `${path}.link.overlay.json`);
  expect(() => new OverlayStore(`${path}.link`, ["Gary"])).toThrow("unreadable or invalid");
});

test("optimistic conflicts and strict validation never change durable revision", () => {
  const { store } = setup(), initial = store.get();
  store.replace(0, initial);
  expect(() => store.replace(0, initial)).toThrow("another controller");
  for (const change of [
    { resident: "Remote" }, { title: "x".repeat(161) }, { host: "private-host" }, { version: 2 },
    { revision: 9 }, { hideNames: ["bad name"] },
  ]) expect(() => store.replace(1, { ...store.get(), ...change })).toThrow();
  for (const scale of [0.49, 2.01, Infinity, NaN]) {
    const bad = store.get(); bad.widgets.vitals.scale = scale;
    expect(() => store.replace(1, bad)).toThrow("numeric bounds");
  }
  expect(store.get().revision).toBe(1);
});

test("all presets and proportional 720 layouts fit real renderer footprints", () => {
  const { store } = setup();
  for (const layout of Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[]) {
    for (const [preset, widgets] of Object.entries(overlayPresets(layout))) {
      const state = validateOverlayState({ ...store.get(), layout, preset, widgets }, ["Gary"]);
      const [width, height] = LAYOUTS[layout];
      for (const id of WIDGET_IDS) {
        const widget = state.widgets[id], [w, h] = WIDGET_SIZES[id];
        expect(widget.x).toBeGreaterThanOrEqual(0); expect(widget.y).toBeGreaterThanOrEqual(0);
        expect(widget.x + w * widget.scale).toBeLessThanOrEqual(width);
        expect(widget.y + h * widget.scale).toBeLessThanOrEqual(height);
      }
    }
  }
  const state = store.get(); state.layout = "1280x720"; state.widgets.map.x = 9999; state.widgets.map.y = -99;
  const clamped = validateOverlayState(state, ["Gary"]);
  expect(clamped.widgets.map.x).toBe(940); expect(clamped.widgets.map.y).toBe(0);
});

test("failed persistence leaves active revision and settings unchanged", () => {
  const { home, store } = setup(), initial = store.get();
  // A regular file in place of the storage parent forces a deterministic filesystem failure.
  home.put("commons", "not a directory");
  const changed = store.get(); changed.title = "Must not become active";
  expect(() => store.replace(0, changed)).toThrow("previous settings remain active");
  expect(store.get()).toEqual(initial);
});
