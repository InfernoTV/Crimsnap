use std::process::{Command, Stdio};

use serde::Serialize;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Resolve the ffmpeg binary: a user override path, or `ffmpeg` from PATH.
pub fn bin(custom: &Option<String>) -> String {
    match custom {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => "ffmpeg".to_string(),
    }
}

/// Build a `Command` that never flashes a console window on Windows.
pub fn command(bin: &str) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Encoders we care about, in order of preference (best hardware → software).
// Order is "best first". h264_mf is Windows Media Foundation — it taps the
// GPU through the OS API on AMD/Intel/NVIDIA without needing the standalone
// AMF runtime (it's the path OBS often falls back to). libx264 is the CPU
// safety net so we always land on something that works.
const PREFERRED: &[&str] = &[
    "h264_amf",
    "hevc_amf",
    "av1_amf",
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "h264_mf",
    "hevc_mf",
    "libx264",
];

#[derive(Serialize, Clone)]
pub struct FfmpegProbe {
    pub found: bool,
    pub version: Option<String>,
    pub bin: String,
    pub encoders: Vec<String>,
    pub recommended: Option<String>,
}

/// Is this a GPU encoder whose availability depends on driver runtime?
fn is_hardware(enc: &str) -> bool {
    enc.ends_with("_amf")
        || enc.ends_with("_nvenc")
        || enc.ends_with("_qsv")
        || enc.ends_with("_vaapi")
        || enc.ends_with("_mf")
        || enc.ends_with("_videotoolbox")
}

/// Actually open the encoder on a tiny synthetic clip. A hardware encoder can be
/// compiled into ffmpeg yet fail at runtime (missing/old driver runtime, no GPU,
/// headless session), so this is the only reliable availability check.
///
/// A failed AMF init can hang on Windows, so we bound this with a hard timeout.
fn encoder_works(bin: &str, enc: &str) -> bool {
    use std::time::{Duration, Instant};

    let mut cmd = command(bin);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=0.2",
        "-frames:v",
        "3",
        "-c:v",
        enc,
        "-f",
        "null",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline = Instant::now() + Duration::from_millis(3000);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return false,
        }
    }
}

/// Quick "is ffmpeg present" check without the (slower) encoder validation.
pub fn is_available(custom: &Option<String>) -> bool {
    command(&bin(custom))
        .args(["-hide_banner", "-version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn probe(custom: &Option<String>) -> FfmpegProbe {
    let bin = bin(custom);

    let version = command(&bin)
        .args(["-hide_banner", "-version"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
        });

    let found = version.is_some();

    let mut encoders = Vec::new();
    if found {
        if let Ok(out) = command(&bin).args(["-hide_banner", "-encoders"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for cand in PREFERRED {
                // encoder lines look like: " V....D h264_amf   AMD AMF H.264 Encoder"
                let compiled = text
                    .lines()
                    .any(|l| l.split_whitespace().nth(1) == Some(*cand));
                if !compiled {
                    continue;
                }
                // Trust software encoders; runtime-test the hardware ones.
                if !is_hardware(cand) || encoder_works(&bin, cand) {
                    encoders.push((*cand).to_string());
                }
            }
        }
    }

    let recommended = PREFERRED
        .iter()
        .find(|c| encoders.iter().any(|e| e == *c))
        .map(|c| c.to_string());

    FfmpegProbe {
        found,
        version,
        bin,
        encoders,
        recommended,
    }
}
