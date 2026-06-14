import { invoke } from "@tauri-apps/api/core";

export interface MonitorInfo {
  name: string;
  friendly_name: string | null;
  ordinal: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

/** "Display 2 · DELL U2719D · 1920×1080 ★" — for use in dropdowns. */
export function displayLabel(m: MonitorInfo): string {
  const parts: string[] = [`Display ${m.ordinal}`];
  if (m.friendly_name) parts.push(m.friendly_name);
  parts.push(`${m.width}×${m.height}`);
  return parts.join(" · ") + (m.primary ? " ★" : "");
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Settings {
  save_folder: string;
  fps: number;
  encoder: string;
  quality: number;
  resolution: number; // 0 = native, else target height
  backend: string;
  show_cursor: boolean;
  default_monitor: string | null;
  ffmpeg_path: string | null;
  always_on_top: boolean;
  audio_device: string | null;
  audio_enabled: boolean;
}

export interface WindowEntry {
  title: string;
  class_name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AudioDevice {
  name: string;
  is_loopback_hint: boolean;
}

export interface FfmpegProbe {
  found: boolean;
  version: string | null;
  bin: string;
  encoders: string[];
  recommended: string | null;
}

export interface RecStatus {
  recording: boolean;
  paused: boolean;
  outputs: string[];
  root: string | null;
  elapsed_ms: number;
}

export interface RecResult {
  root: string;
  files: string[];
  elapsed_ms: number;
}

export interface RegionDef {
  name: string;
  rect: Rect;
  monitor?: string | null;
}

export interface Preset {
  id: string;
  name: string;
  regions: RegionDef[];
  include_fullscreen: boolean;
  fullscreen_monitor: string | null;
  fps: number | null;
  encoder: string | null;
  quality: number | null;
}

export interface SelectedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  monitor: string;
}

export interface StartConfig {
  regions: { name: string; rect: Rect; window_title?: string | null }[];
  include_fullscreen: boolean;
  fullscreen_monitor: string | null;
  fps: number;
  encoder: string;
  quality: number;
  max_height: number | null;
  backend: string;
  show_cursor: boolean;
  save_root: string;
  label: string;
  ffmpeg_path: string | null;
  audio_device: string | null;
}

export const api = {
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  snapshotMonitor: (monitor: string | null) =>
    invoke<string>("snapshot_monitor", { monitor }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) =>
    invoke<Settings>("save_settings", { settings }),
  defaultSaveFolder: () => invoke<string>("get_default_save_folder"),
  listPresets: () => invoke<Preset[]>("list_presets"),
  savePreset: (preset: Preset) => invoke<Preset>("save_preset", { preset }),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),
  openOverlay: (monitor: string | null) =>
    invoke<void>("open_region_overlay", { monitor }),
  startRecording: (config: StartConfig) =>
    invoke<RecStatus>("start_recording", { config }),
  pauseRecording: () => invoke<RecStatus>("pause_recording"),
  resumeRecording: () => invoke<RecStatus>("resume_recording"),
  stopRecording: () => invoke<RecResult>("stop_recording"),
  recordingStatus: () => invoke<RecStatus>("recording_status"),
  probeFfmpeg: () => invoke<FfmpegProbe>("probe_ffmpeg"),
  listWindows: () => invoke<WindowEntry[]>("list_windows"),
  listAudioDevices: (ffmpegPath: string | null) =>
    invoke<AudioDevice[]>("list_audio_devices", { ffmpegPath }),
  setAlwaysOnTop: (on: boolean) => invoke<void>("set_always_on_top", { on }),
  exportConfig: (path: string, regions: RegionSnapshot[]) =>
    invoke<string>("export_config", { path, regions }),
  importConfig: (path: string) => invoke<ImportedSnapshot>("import_config", { path }),
};

export interface RegionSnapshot {
  name: string;
  rect: Rect;
  monitor: string | null;
  window_title: string | null;
}

export interface ImportedSnapshot {
  settings: Settings;
  presets: Preset[];
  regions: RegionSnapshot[];
}

/**
 * Quality-preset labels and the QP value (lower = better) each maps to.
 * Used by the UI to swap the raw QP slider for a friendly preset picker.
 */
export const QUALITY_PRESETS: { value: number; label: string; sub: string }[] = [
  { value: 30, label: "Low", sub: "smaller files · stream" },
  { value: 24, label: "Balanced", sub: "everyday clips" },
  { value: 20, label: "High", sub: "gaming · recommended" },
  { value: 16, label: "Visually lossless", sub: "big files" },
];

/** Rough output-bitrate estimate (Mbps) at a given pixel count, fps, and QP. */
export function estimateBitrate(width: number, height: number, fps: number, qp: number): number {
  // Empirical multiplier per QP step (each +1 QP roughly halves bitrate every ~6 steps).
  const pixelRate = width * height * fps;
  const baseBpp = 0.12; // bits per pixel at QP 18 (high-motion gaming-ish)
  const qpFactor = Math.pow(2, (18 - qp) / 6);
  const bps = pixelRate * baseBpp * qpFactor;
  return Math.max(0.2, Math.round((bps / 1_000_000) * 10) / 10);
}

export const ENCODER_LABELS: Record<string, string> = {
  auto: "Auto · best for this PC",
  h264_amf: "H.264 · AMD GPU",
  hevc_amf: "HEVC · AMD GPU",
  av1_amf: "AV1 · AMD GPU",
  h264_nvenc: "H.264 · NVIDIA",
  hevc_nvenc: "HEVC · NVIDIA",
  h264_qsv: "H.264 · Intel",
  hevc_qsv: "HEVC · Intel",
  h264_mf: "H.264 · GPU (Media Foundation)",
  hevc_mf: "HEVC · GPU (Media Foundation)",
  libx264: "H.264 · CPU (x264)",
};

export const encoderLabel = (id: string) => ENCODER_LABELS[id] ?? id;

export function qualityLabel(q: number): string {
  if (q <= 16) return "near-lossless · big files";
  if (q <= 20) return "high quality";
  if (q <= 24) return "balanced";
  return "smaller files";
}
