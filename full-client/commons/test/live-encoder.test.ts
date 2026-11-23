import { expect, test } from "bun:test";
import { buildEncoderArgs } from "../src/live-encoder.ts";
import type { LiveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

const source = (encoder: LiveConfig["encoder"] = "h264_nvenc"): LiveConfig => ({
  enabled: true, ffmpeg: "ffmpeg", encoder, rtspUrl: "rtsp://127.0.0.1:8554/resident", whepUrl: "http://127.0.0.1:8889/resident/whep",
});
const option = (args: string[], key: string) => args[args.indexOf(key) + 1];

test("explicit encoders have disjoint low-latency settings; VAAPI uploads NV12", () => {
  for (const encoder of ["h264_nvenc", "h264_vaapi", "libx264"] as const) {
    const args = buildEncoderArgs({ ...source(encoder), vaapiDevice: encoder === "h264_vaapi" ? "/dev/dri/renderD128" : undefined }, { width: 853, height: 479 });
    expect(option(args, "-c:v")).toBe(encoder);
    expect(option(args, "-bf")).toBe("0");
    expect(option(args, "-thread_queue_size")).toBe("2");
    expect(args).toContain("-an");
    expect(args).not.toContain("pulse");
    if (encoder === "h264_vaapi") {
      expect(option(args, "-vf")).toContain("format=nv12,hwupload");
      expect(option(args, "-vaapi_device")).toBe("/dev/dri/renderD128");
      expect(args).not.toContain("-preset");
      expect(option(args, "-profile:v")).toBe("constrained_baseline");
    } else {
      expect(option(args, "-preset")).toBe(encoder === "h264_nvenc" ? "p1" : "ultrafast");
      expect(args).not.toContain("-vaapi_device");
    }
  }
});

test("audio captures only the dedicated monitor with bounded queues, Opus and a shared epoch", () => {
  const args = buildEncoderArgs({ ...source("libx264"), audio: true }, { width: 854, height: 480 }, { audioSink: "resident_Gary", epochMs: 1_790_000_123_456 });
  expect(args).toContain("resident_Gary.monitor");
  expect(args.filter(value => value === "-use_wallclock_as_timestamps")).toHaveLength(1);
  const videoEnd = args.indexOf("pipe:0"), audioEnd = args.indexOf("resident_Gary.monitor");
  expect(args.slice(0, videoEnd)).toContain("-use_wallclock_as_timestamps");
  expect(args.slice(videoEnd + 1, audioEnd)).not.toContain("-use_wallclock_as_timestamps");
  expect(args.slice(videoEnd + 1, audioEnd)).toContain("-wallclock");
  expect(option(args, "-wallclock")).toBe("1");
  expect(args).toContain("-copyts");
  expect(args).not.toContain("-start_at_zero");
  expect(args.join(" ")).not.toContain("STARTPTS");
  expect(option(args, "-vf")).toContain("PTS-1790000123.456/TB");
  expect(option(args, "-af")).toContain("PTS-1790000123.456/TB");
  expect(args.join(" ")).not.toContain("first_pts=0");
  expect(option(args, "-c:a")).toBe("libopus");
  expect(option(args, "-fragment_size")).toBe("3840");
  expect(args).not.toContain("-an");
  expect(args).not.toContain("default");
});

test("builder refuses missing/unsafe audio, absent common clock and invalid VAAPI setup", () => {
  for (const sink of [undefined, "default", "alsa_output.speakers", "resident_Gary.monitor", "resident_Gary;private-secret"]) {
    expect(() => buildEncoderArgs({ ...source(), audio: true }, { width: 4, height: 2 }, { audioSink: sink, epochMs: 1000 })).toThrow();
  }
  expect(() => buildEncoderArgs({ ...source(), audio: true }, { width: 4, height: 2 }, { audioSink: "resident_Gary" })).toThrow("shared wall-clock epoch");
  for (const device of [undefined, "/tmp/private-secret", "/dev/dri/card0", "/dev/dri/renderD128/../private-secret"]) {
    expect(() => buildEncoderArgs({ ...source("h264_vaapi"), vaapiDevice: device }, { width: 4, height: 2 })).toThrow("DRM render node");
  }
});

test("configuration is audio-off by default and requires explicit supported encoder/device choices", () => {
  const home = tempHome();
  try {
    expect(home.config().live).toMatchObject({ encoder: "h264_nvenc", audio: false });
    for (const encoder of ["h264_nvenc", "h264_vaapi", "libx264"] as const) {
      expect(home.config({ COMMONS_LIVE_ENCODER: encoder, COMMONS_LIVE_VAAPI_DEVICE: "/dev/dri/renderD128" }).live?.encoder).toBe(encoder);
    }
    expect(() => home.config({ COMMONS_LIVE_ENCODER: "h264_vaapi" })).toThrow("DRM render node");
    expect(() => home.config({ COMMONS_LIVE_ENCODER: "h264_amf" })).toThrow("explicitly select");
    expect(() => home.config({ COMMONS_LIVE_AUDIO: "yes" })).toThrow("true or false");
    expect(() => home.config({ GARY_CLIENT_AUDIO_SINK: "default" })).toThrow("dedicated resident_");
  } finally { home.remove(); }
});

test("audio sink comes from each instance, with Gary environment precedence and no shared sinks", () => {
  const home = tempHome();
  try {
    home.put("resident/margo/memory.md", "fixture");
    home.put("instances/Gary.env", "GARY_CLIENT_AUDIO_SINK=resident_Gary\n");
    home.put("instances/Margo.env", "GARY_CLIENT_AUDIO_SINK=resident_Margo\n");
    expect(home.config().residents.map(resident => resident.audioSink)).toEqual(["resident_Gary", "resident_Margo"]);
    expect(home.config({ GARY_CLIENT_AUDIO_SINK: "resident_override" }).residents[0].audioSink).toBe("resident_override");
    expect(() => home.config({ GARY_CLIENT_AUDIO_SINK: "resident_Margo" })).toThrow("dedicated to exactly one");
    expect(home.config({ GARY_CLIENT_AUDIO_SINK: "" }).residents[0].audioSink).toBeUndefined();
  } finally { home.remove(); }
});
