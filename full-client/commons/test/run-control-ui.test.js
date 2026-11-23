import { describe, expect, test } from "bun:test";
import { endLabel, inputsToEndAt, nextWallTime, resultLines, runSummary, startBody, stopConfirmation, wallInputs, wallToEpoch } from "../public/run-control.js";

const utc = text => Date.parse(text);

describe("New York wall clock", () => {
  test("the default end is the next 1:00 am in New York, whatever the device's zone", () => {
    // 2026-11-23 15:00 EST is 20:00 UTC: next 01:00 EST is 06:00 UTC on the 24th.
    expect(new Date(nextWallTime(utc("2026-11-23T20:00:00Z"))).toISOString()).toBe("2026-11-24T06:00:00.000Z");
    // Just after 01:00 New York time it is tomorrow's; just before, today's.
    expect(new Date(nextWallTime(utc("2026-11-24T06:00:01Z"))).toISOString()).toBe("2026-11-25T06:00:00.000Z");
    expect(new Date(nextWallTime(utc("2026-11-24T05:59:00Z"))).toISOString()).toBe("2026-11-24T06:00:00.000Z");
    // Summer time: 01:00 EDT is 05:00 UTC.
    expect(new Date(nextWallTime(utc("2026-07-01T16:00:00Z"))).toISOString()).toBe("2026-07-02T05:00:00.000Z");
  });

  test("daylight-saving edges: a missing hour is refused, a repeated hour means its first occurrence", () => {
    expect(wallToEpoch({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 })).toBeNull();
    expect(new Date(wallToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 })).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // 2:30 on the spring-forward night does not exist, so the next one is a day later.
    expect(new Date(nextWallTime(utc("2027-03-14T04:00:00Z"), 2, 30)).toISOString()).toBe("2027-03-15T06:30:00.000Z");
  });

  test("dialog inputs round-trip and are checked like the server checks them", () => {
    const now = utc("2026-11-23T20:00:00Z");
    expect(wallInputs(utc("2026-11-24T06:00:00Z"))).toEqual({ date: "2026-11-24", time: "01:00" });
    expect(inputsToEndAt("2026-11-24", "01:00", now)).toEqual({ endAt: utc("2026-11-24T06:00:00Z") / 1000 });
    expect(inputsToEndAt("2026-11-23", "12:00", now).error).toContain("in the past");
    expect(inputsToEndAt("2026-11-25", "01:00", now).error).toContain("more than 24 hours");
    expect(inputsToEndAt("", "01:00", now).error).toContain("Choose");
    expect(inputsToEndAt("2027-03-14", "02:30", utc("2027-03-14T04:00:00Z")).error).toContain("does not exist");
  });

  test("end labels name the weekday only when the end is not tonight", () => {
    const now = utc("2026-11-23T20:00:00Z");
    expect(endLabel(utc("2026-11-24T06:00:00Z") / 1000, now)).toBe("01:00");
    expect(endLabel(utc("2026-11-25T06:00:00Z") / 1000, now)).toBe("Wed 01:00");
  });
});

describe("run state and results", () => {
  const now = utc("2026-11-23T20:00:00Z"), end = utc("2026-11-24T06:00:00Z") / 1000;

  test("a card says what runs, until when, on what thread and who started it", () => {
    expect(runSummary({ running: true, end_at: end, model: "gpt-6.2-sol", mode: "resume", thread_id: "01a20685-ec8a-79f2", started_by: "switchyard" }, now))
      .toBe("Running until 01:00 · gpt-6.2-sol · resumed thread 01a20685… · started by switchyard.");
    expect(runSummary({ running: false, client_state: "active", started_by: "owner_dashboard", end_at: end }, now))
      .toBe("Not running. Last started by owner_dashboard until 01:00. Client active without a run.");
    expect(runSummary(undefined, now)).toBe("Run state unknown.");
  });

  const hosts = [
    { host: "inspiron", ok: true, residents: [
      { name: "Gary", running: true, unit: "gary-run.service", client_unit: "gary-client@Gary.service", client_state: "active" },
      { name: "Margo", running: true, unit: "margo-run.service", client_unit: "gary-client@Margo.service", client_state: "active" }],
      caretaker: { running: true, unit: "overseer-run.service" } },
    { host: "chungus1", ok: true, residents: [
      { name: "Wren", running: true, unit: "wren-run.service", client_unit: "gary-client@Wren.service", client_state: "active" },
      { name: "Tobin", running: false, unit: "tobin-run.service", client_unit: "gary-client@Tobin.service", client_state: "inactive" }],
      caretaker: { running: true, unit: "overseer-run.service" } },
  ];

  test("the stop confirmation names every unit that will stop, and whether the caretaker goes too", () => {
    const one = stopConfirmation([{ name: "Gary", host: "inspiron" }], hosts);
    expect(one).toContain("On inspiron: Gary (gary-run.service and gary-client@Gary.service).");
    expect(one).toContain("The caretaker keeps running for Margo.");
    const last = stopConfirmation([{ name: "Wren", host: "chungus1" }], hosts);
    expect(last).toContain("On chungus1: Wren (gary-run.service".replace("gary-run", "wren-run"));
    expect(last).toContain("The caretaker overseer-run.service stops too.");
    expect(stopConfirmation([{ name: "Tobin", host: "chungus1" }], hosts)).toContain("Tobin (nothing running)");
  });

  test("results are one line per host; an unreachable station is never folded into an ok", () => {
    const lines = resultLines({ ok: false, code: "partial", hosts: [
      { host: "inspiron", ok: true, code: "ok", residents: [{ name: "Gary", result: "started", mode: "resume" }, { name: "Margo", result: "already_running" }], caretaker: { result: "started" } },
      { host: "chungus1", ok: false, code: "unreachable", residents: [], caretaker: null, error: "station chungus1 unreachable: nothing was started there" },
    ], warnings: [] });
    expect(lines).toEqual([
      { ok: true, host: "inspiron", text: "inspiron: Gary started (resumed thread), Margo already running, caretaker started" },
      { ok: false, host: "chungus1", text: "station chungus1 unreachable: nothing was started there" },
    ]);
    expect(resultLines({ ok: false, code: "conflict", error: "Tobin is already running until 01:00 on chungus1." }))
      .toEqual([{ ok: false, text: "Tobin is already running until 01:00 on chungus1." }]);
    expect(resultLines({ ok: false, hosts: [{ host: "inspiron", ok: false, code: "conflict", residents: [], caretaker: null, error: "Gary is already running until 01:00" }] }))
      .toEqual([{ ok: false, host: "inspiron", text: "inspiron: Gary is already running until 01:00" }]);
  });

  test("a start body sends only what the person chose; the rest is each host's default", () => {
    expect(startBody({ residents: "all", endAt: end, model: "", fresh: false, caretaker: "default", interval: "", speak: "keep" }))
      .toEqual({ residents: "all", end_at: end });
    expect(startBody({ residents: ["Wren"], endAt: end, model: "gpt-6.1-sol", fresh: true, caretaker: "off", interval: "30", speak: "on" }))
      .toEqual({ residents: ["Wren"], end_at: end, model: "gpt-6.1-sol", fresh: ["Wren"], caretaker: { enabled: false, interval: 30, speak: "on" } });
  });
});
