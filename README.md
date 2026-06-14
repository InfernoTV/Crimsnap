# Crimsnap

Lightweight crimson-neon screen recorder for Windows. Pick a region, a
window, or your whole screen and record one or several views at the same time
into clean MP4 files.

```
  CRIMSNAP - crimson + snap
```

Crimsnap is a small Tauri + ffmpeg app. It ships as a standalone exe and an
MSI installer. No account, no telemetry, no background service.

## Features

- Pick a region on any monitor with a live preview, draggable rectangle, and
  numeric inputs.
- Snap a region directly on the real screen, similar to Win+Shift+S.
- Capture a specific window and keep following it when it moves.
- Record multiple regions at the same time, each to its own MP4 file.
- Capture the full screen alongside individual regions.
- Pause, resume, and stop recordings.
- Resolution caps from native down to 144p, plus custom height.
- FPS presets: 24, 30, 48, 60, 120, 144, or custom.
- Quality presets: Low, Balanced, High, and Visually lossless.
- Runtime encoder probing for AMD AMF, NVIDIA NVENC, Intel QSV, Windows Media
  Foundation, and x264 CPU fallback.
- Optional audio capture from any dshow input device.
- Always-on-top pin for use over games.
- Named presets for game layouts such as health, loadout, and killfeed.
- Export and import `.crimsnap.json` configs.
- Signed in-app updates with changelog preview, passive install, and restart
  prompt.
- Multi-monitor support with friendly display labels.

## Install

1. Download the latest installer from [Releases](../../releases).
2. Run the MSI or setup exe.
3. Make sure `ffmpeg.exe` is available.

If ffmpeg is not on your PATH, download a full Windows build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) and point
**Settings -> ffmpeg -> Browse** at `ffmpeg.exe`.

## Quick Start

1. Click **+ Pick a region** and draw a rectangle on the monitor preview.
2. Click **Record**.
3. Click **Stop**.

Recordings are saved under:

```text
Videos\Crimsnap\session\<timestamp>\
```

For gaming, create regions such as `health`, `loadout`, and `killfeed`, enable
full-screen capture if wanted, then save the layout as a preset.

For window capture, open the picker, choose **Specific window**, select the
window title, and save the region.

## Build From Source

Requirements:

- Node 18+
- pnpm
- Rust with the MSVC toolchain
- ffmpeg

```powershell
git clone https://github.com/InfernoTV/Crimsnap
cd Crimsnap
pnpm install
pnpm tauri dev
pnpm tauri build
```

## Encoding Notes

Crimsnap tests encoders at runtime. A codec being compiled into ffmpeg does not
mean it actually works on the current PC.

Typical choices:

- AMD systems: `h264_amf` when available.
- NVIDIA systems: `h264_nvenc` when available.
- Intel systems: `h264_qsv` when available.
- Windows GPU fallback: `h264_mf`.
- Universal fallback: `libx264`.

## Bitrate Guidance

| Resolution / FPS | Low | Balanced | High | Visually lossless |
| --- | --- | --- | --- | --- |
| 1080p60 | ~5 Mbps | ~10 Mbps | ~16 Mbps | ~26 Mbps |
| 1440p60 | ~9 Mbps | ~17 Mbps | ~28 Mbps | ~45 Mbps |
| 4K60 | ~20 Mbps | ~38 Mbps | ~62 Mbps | ~100 Mbps |

For competitive gaming and uploads, use **High**. For long sessions, use
**Balanced**.

## Roadmap

- OBS-style canvas compositor for combining regions into one output.
- Per-app audio mute through WASAPI session handling.
- More global hotkeys.
- GIF and WebP export for short clips.

## Known Limits

- Exclusive-fullscreen games can block GDI capture. Borderless mode is best.
- `ddagrab` is experimental. `gdigrab` is the reliable default.
- Desktop audio usually needs a loopback device such as Stereo Mix, VB-Cable,
  or `virtual-audio-capturer`.

## License

MIT. See [LICENSE](LICENSE).
