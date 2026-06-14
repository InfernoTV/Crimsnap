# Crimsnap

> Lightweight crimson-neon screen recorder for Windows. Pick a region, a
> window, or your whole screen — record one or several of them at the same
> time, hardware-encoded by your GPU, into clean .mp4 files.

```
   ▰▰  CRIMSNAP   crimson + snap
```

A small Tauri + ffmpeg app: the binary is ~6 MB, sips RAM, and ships as a
single .exe + MSI installer. No background services, no telemetry, no account.

## What it does

- **Pick a region** on any monitor with a real-screen preview + draggable
  rectangle + live numeric inputs, *or* drag directly on your screen
  Win+Shift+S style.
- **Capture a specific window** that follows the window when it moves.
- **Multi-region simultaneous capture** — health bar, loadout, killfeed, and
  the full screen, all recorded at the same time, each to its own .mp4 file,
  from a single GPU capture.
- **Pause / Resume / Stop** with lossless segment-and-concat (the final mp4
  is one continuous file, no re-encode on stitch).
- **Resolution caps:** Native / 2160p / 1440p / 1080p / 720p / 480p / 360p
  / 240p / 144p / Custom (W×H).
- **FPS:** 24 / 30 / 48 / 60 / 120 / 144 / Custom.
- **Quality presets:** Low / Balanced / High / Visually lossless, with a
  live output-bitrate estimate.
- **GPU encoding, auto-detected:** AMD AMF, NVIDIA NVENC, Intel QSV, Windows
  Media Foundation, and an x264 CPU fallback. Each is runtime-tested so the
  app never silently uses a broken encoder.
- **Audio:** any input device (microphone, Stereo Mix, VB-Cable,
  virtual-audio-capturer…). One toggle, one device picker.
- **Always-on-top pin** for over-the-game use.
- **Named presets** to recall a multi-region layout (health/loadout/killfeed)
  per game.
- **Export / import configs** as `.crimsnap.json` so layouts can be backed up
  or shared.
- **Signed in-app updates** with changelog preview, passive install progress,
  and restart prompt.
- **Multi-monitor** — pick which display to capture or select on.

## Install (no Node / Rust / anything needed)

1. Download the latest `Crimsnap-Setup.msi` from
   [Releases](../../releases).
2. Run the installer.
3. Make sure **ffmpeg** is on your `PATH` (most builds ship it; if not,
   grab a build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) and
   point Settings → ffmpeg → Browse at `ffmpeg.exe`).

That's it. Crimsnap appears in the Start menu.

## Quick start

1. Hit **+ Pick a region**, draw a rect on the live screenshot of your monitor.
2. Hit **● Record**. The frame glows crimson while recording.
3. Hit **■ Stop**. The session lands in `Videos\Crimsnap\session\<timestamp>\`.

For gamers:

1. Add three regions named `health`, `loadout`, `killfeed`.
2. Tick **Also record full screen of …** for the gameplay track.
3. **Save current** as a preset named after the game.
4. Press **F9** to start/stop next time.

For window-specific capture (e.g. a Discord call, a chat window, an
overlay): in the picker modal click **Specific window**, pick the title,
done. Crimsnap follows the window even if you move or resize it.

## Build from source

You need **Node 18+ / pnpm**, **Rust** (MSVC toolchain), and **ffmpeg**.

```powershell
git clone https://github.com/InfernoTV/crimsnap
cd crimsnap
pnpm install
pnpm tauri dev      # hot-reload dev mode
pnpm tauri build    # release exe + MSI
```

The release exe lands at `src-tauri/target/release/crimsnap.exe`, the MSI at
`src-tauri/target/release/bundle/msi/`.

## Publishing releases

Before publishing publicly, replace the updater endpoint in
`src-tauri/tauri.conf.json`:

```json
"https://github.com/InfernoTV/crimsnap/releases/latest/download/latest.json"
```

The app checks that signed static JSON file, so normal users do not hit the
GitHub REST API rate limit.

Updater signing is already wired:

- `src-tauri/updater.key.pub` / the public key is safe to publish.
- `src-tauri/updater.key` is private and is ignored by git.
- Add the private key text to the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`.
- Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too. It can be blank if you keep
  the generated no-password local key, but a passworded key is better before
  a serious public release.

To release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Action builds the MSI, NSIS setup exe, updater signatures, and
`latest.json`, then uploads them to the matching GitHub Release.

More detail lives in [docs/PUBLISHING.md](docs/PUBLISHING.md) and the
step-by-step [GitHub release checklist](docs/GITHUB_RELEASE_CHECKLIST.md).

## Encoding notes

Crimsnap tests every encoder at runtime — compiled-into-ffmpeg ≠ actually
working. On AMD systems with the AMF runtime installed, `h264_amf` is the
fastest path. On AMD systems *without* it, Crimsnap falls back to
`h264_mf` (Windows Media Foundation, the path OBS uses), which still uses
the GPU. If everything fails it lands on `libx264` (CPU, slowest but
universal).

### Bitrate guidance

| Resolution / FPS | Low (~QP 30) | Balanced (~QP 24) | High (~QP 20) | Lossless (~QP 16) |
| --- | --- | --- | --- | --- |
| 1080p60 | ~5 Mbps | ~10 Mbps | ~16 Mbps | ~26 Mbps |
| 1440p60 | ~9 Mbps | ~17 Mbps | ~28 Mbps | ~45 Mbps |
| 4K60 | ~20 Mbps | ~38 Mbps | ~62 Mbps | ~100 Mbps |

For competitive gaming and uploads pick **High**. For long captures keep
**Balanced**.

## Roadmap

Things I'd like to add and that PRs are welcome on:

- **OBS-style canvas compositor** — drag regions onto a single output
  canvas (today each region is its own file).
- **Per-app audio mute** via WASAPI session enumeration.
- **Global hotkeys** — separate per-action hotkeys (not just record toggle).
- **GIF / WebP export** of short clips.

## Known limits

- Exclusive-fullscreen games can block the GDI capture path; run them
  borderless for capture (works fine in practice with every modern engine).
- `ddagrab` (GPU desktop-duplication) is in Settings → Capture as an
  experimental backend; the default reliable `gdigrab` is what we test
  with.
- System-audio capture needs a loopback device. Easiest options: turn on
  Stereo Mix in Windows Sound settings, install
  [VB-Cable](https://vb-audio.com/Cable/), or install
  [`virtual-audio-capturer`](https://github.com/rdp/virtual-audio-capturer).

## License

MIT — see [LICENSE](LICENSE).
