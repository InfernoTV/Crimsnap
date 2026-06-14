# Installing Crimsnap

You need **two** things — Crimsnap itself, and **ffmpeg** for it to call.

## 1. Install Crimsnap

Two options. Pick one.

### Option A — MSI installer (recommended)

1. Download **Crimsnap-x.y.z_x64_en-US.msi** from
   [Releases](../../../releases).
2. Double-click it. Next, Next, Install.
3. Crimsnap appears in the Start menu.

The MSI registers Start-menu and uninstall entries so it shows up in
"Apps & features" later.

### Option B — Standalone .exe

1. Download **crimsnap.exe** from
   [Releases](../../../releases).
2. Put it anywhere. Run it.

No installer, no Start-menu entry — just the executable. Good for portable
USB use or if you don't want anything written outside the folder.

> Crimsnap uses [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
> for its UI. WebView2 is bundled with Windows 11 and most Windows 10 builds;
> if launching errors out, install the
> [Evergreen runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download).

## 2. Install ffmpeg

Crimsnap calls `ffmpeg` to capture and encode. If you already have OBS, gyan's
ffmpeg build, or anything else that put `ffmpeg.exe` on PATH, you're done.

Otherwise:

1. Grab the **full build** zip from
   [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (the "ffmpeg-release-full"
   one).
2. Unzip somewhere permanent, e.g. `C:\Tools\ffmpeg`.
3. Either:
   - Add `C:\Tools\ffmpeg\bin` to your PATH
     ([how-to](https://www.java.com/en/download/help/path.html)), **or**
   - Open Crimsnap → **Settings → ffmpeg → Browse** and point it at
     `C:\Tools\ffmpeg\bin\ffmpeg.exe`.

Hit **Settings → ffmpeg → Test**. You should see:
```
✓ ffmpeg version 8.x... · best working: H.264 · <your GPU>
```

## 3. (Optional) System audio capture

Crimsnap can record any single dshow audio device. **Microphones work out of
the box** — pick yours in Settings → Audio → Source.

For **desktop sound** (game audio, browser audio, etc) you need a loopback
device. Pick one:

- **Stereo Mix** — many Realtek and Conexant audio drivers have it. In
  Windows Sound → Recording → right-click → Show Disabled Devices → enable
  Stereo Mix.
- **VB-Cable** — [free virtual audio cable](https://vb-audio.com/Cable/).
  Set your output to "CABLE Input", pick "CABLE Output" in Crimsnap. Cleanest
  setup but you'll need to route your own sound back to speakers.
- **virtual-audio-capturer** — [direct loopback ffmpeg-style](https://github.com/rdp/screen-capture-recorder-to-video-windows-free).
  Install and pick "virtual-audio-capturer" in Crimsnap. Easiest if you don't
  want to mess with routing.

Crimsnap hints "system audio" next to devices it recognizes as loopbacks.

## 4. Updates

Crimsnap checks for signed GitHub releases on startup, at most once every
6 hours. If an update is available, it shows the changelog before installing.

You can also open **Settings -> Updates -> Check now**. After the download and
passive install finish, Crimsnap asks you to restart the app.

## Uninstall

- MSI install: Settings → Apps → Crimsnap → Uninstall.
- Standalone .exe: delete the file.

Crimsnap stores its settings in `%APPDATA%\lol.crimsnap.desktop\` — delete
that folder too if you want a fully clean wipe.
