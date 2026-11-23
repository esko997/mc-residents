import { residentAudioSink, type LiveConfig } from "./config.ts";

export interface EncoderFrame { width: number; height: number }
export interface EncoderOptions { audioSink?: string; epochMs?: number }

/** Pure argument builder: no discovery, process launch or implicit encoder fallback. */
export function buildEncoderArgs(source: LiveConfig, frame: EncoderFrame, options: EncoderOptions = {}): string[] {
  if (![frame.width, frame.height].every(value => Number.isInteger(value) && value > 0)
    || frame.width > 1920 || frame.height > 1080) throw new Error("Unsupported encoder framebuffer dimensions.");
  if (!["h264_nvenc", "h264_vaapi", "libx264"].includes(source.encoder)) throw new Error("Select an explicit supported live encoder.");
  const vaapi = source.encoder === "h264_vaapi";
  if (vaapi && !/^\/dev\/dri\/renderD[0-9]{3,4}$/.test(source.vaapiDevice ?? "")) throw new Error("h264_vaapi requires a configured DRM render node.");
  const audio = source.audio === true;
  const sink = audio ? residentAudioSink(options.audioSink) : undefined;
  if (audio && !sink) throw new Error("Resident audio requires its dedicated launcher-owned Pulse sink.");
  if (audio && (!Number.isFinite(options.epochMs) || options.epochMs! < 0)) throw new Error("Resident audio requires a shared wall-clock epoch.");
  // With audio, preserve BOTH inputs' absolute capture timestamps until the same
  // epoch is subtracted. STARTPTS/start_at_zero on each input loses their offset.
  // Pulse's native wallclock mode anchors its sample clock to that epoch.
  // Do not overwrite audio packet PTS with demux-delivery time: scheduling
  // jitter would turn a sample-continuous track into overlapping packets.
  const epoch = audio ? (options.epochMs! / 1000).toFixed(3) : undefined;
  const videoFilter = `vflip,pad=ceil(iw/2)*2:ceil(ih/2)*2,setpts=${audio ? `PTS-${epoch}/TB` : "PTS-STARTPTS"}`
    + (vaapi ? ",format=nv12,hwupload" : "");
  return ["-hide_banner", "-loglevel", "warning", "-nostdin", "-nostats", "-stats_period", "0.2", "-progress", "pipe:1",
    "-filter_threads", "1", ...(audio ? ["-copyts"] : []),
    ...(vaapi ? ["-vaapi_device", source.vaapiDevice!] : []),
    "-thread_queue_size", "2", "-use_wallclock_as_timestamps", "1",
    "-f", "rawvideo", "-pixel_format", "bgra", "-video_size", `${frame.width}x${frame.height}`, "-framerate", "15", "-i", "pipe:0",
    ...(audio ? ["-thread_queue_size", "8", "-f", "pulse", "-wallclock", "1",
      "-sample_rate", "48000", "-channels", "2", "-fragment_size", "3840", "-i", `${sink}.monitor`] : []),
    "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : ["-an"]),
    "-vf", videoFilter, "-fps_mode", "vfr", "-enc_time_base", "1:90000", "-c:v", source.encoder, "-threads", "1",
    ...(source.encoder === "h264_nvenc"
      ? ["-preset", "p1", "-tune", "ull", "-rc-lookahead", "0", "-zerolatency", "1", "-surfaces", "4", "-delay", "0"]
      : vaapi ? ["-async_depth", "1"] : ["-preset", "ultrafast", "-tune", "zerolatency"]),
    "-profile:v", vaapi ? "constrained_baseline" : "baseline", ...(!vaapi ? ["-pix_fmt", "yuv420p"] : []),
    "-bf", "0", "-g", "15", "-b:v", "2M", "-maxrate", "2M", "-bufsize", "1M",
    ...(audio ? ["-af", `asetpts=PTS-${epoch}/TB,aresample=async=1`, "-c:a", "libopus", "-b:a", "96k",
      "-application", "lowdelay", "-frame_duration", "20", "-ar", "48000", "-ac", "2", "-avoid_negative_ts", "disabled"] : []),
    "-max_muxing_queue_size", "32", "-max_interleave_delta", "100000", "-flush_packets", "1", "-muxdelay", "0.1",
    "-f", "rtsp", "-rtsp_transport", "tcp", source.rtspUrl];
}
