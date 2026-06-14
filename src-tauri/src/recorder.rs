use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::ffmpeg;
use crate::model::Rect;
use crate::monitors;

/// A single named region the user wants captured. If `window_title` is set the
/// region tracks that window (rect is ignored); otherwise the rect is a
/// physical-pixel rectangle on the desktop.
#[derive(Clone, Deserialize)]
pub struct RegionInput {
    pub name: String,
    pub rect: Rect,
    #[serde(default)]
    pub window_title: Option<String>,
}

/// Everything needed to kick off a recording session, sent from the frontend.
#[derive(Clone, Deserialize)]
pub struct StartConfig {
    pub regions: Vec<RegionInput>,
    #[serde(default)]
    pub include_fullscreen: bool,
    #[serde(default)]
    pub fullscreen_monitor: Option<String>,
    pub fps: u32,
    pub encoder: String,
    pub quality: u32,
    /// Downscale cap (height in px). `None` = native resolution.
    #[serde(default)]
    pub max_height: Option<u32>,
    #[serde(default = "default_backend")]
    pub backend: String,
    #[serde(default = "default_true")]
    pub show_cursor: bool,
    pub save_root: String,
    #[serde(default = "default_label")]
    pub label: String,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    /// dshow audio device name, e.g. "Microphone (Realtek)" or "Stereo Mix".
    /// `None` = no audio track.
    #[serde(default)]
    pub audio_device: Option<String>,
}

fn default_backend() -> String {
    "gdigrab".to_string()
}
fn default_true() -> bool {
    true
}
fn default_label() -> String {
    "session".to_string()
}

/// One output stream of the session (a cropped region or the full monitor).
struct OutputState {
    safe: String,
    group: usize,
    /// Crop relative to the group's capture rect. `None` = whole monitor.
    crop: Option<Rect>,
    parts: Vec<PathBuf>,
    final_path: PathBuf,
}

/// A single capture pipeline. Either a desktop rectangle (one gdigrab per
/// used monitor, may have multiple cropped outputs) or a single window
/// (one gdigrab title= input that follows the window, one output).
enum GroupKind {
    Monitor(Rect),
    Window(String),
}

struct Group {
    kind: GroupKind,
}

/// Local copy of `GroupKind` so `spawn_group` doesn't have to keep an
/// immutable borrow on `self.groups` while it builds its ffmpeg command.
enum GroupKindLocal {
    Monitor(Rect),
    Window(String),
}

struct Session {
    ffmpeg: String,
    backend: String,
    fps: u32,
    encoder: String,
    quality: u32,
    max_height: Option<u32>,
    show_cursor: bool,
    audio_device: Option<String>,
    root: PathBuf,
    parts_dir: PathBuf,
    groups: Vec<Group>,
    outputs: Vec<OutputState>,
    children: Vec<Child>,
    segment: u32,
    paused: bool,
    accumulated: Duration,
    run_started: Instant,
}

#[derive(Default)]
pub struct Recorder(Mutex<Option<Session>>);

#[derive(Clone, Serialize)]
pub struct RecStatus {
    pub recording: bool,
    pub paused: bool,
    pub outputs: Vec<String>,
    pub root: Option<String>,
    pub elapsed_ms: u128,
}

#[derive(Clone, Serialize)]
pub struct RecResult {
    pub root: String,
    pub files: Vec<String>,
    pub elapsed_ms: u128,
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "region".to_string()
    } else {
        s
    }
}

/// Hardware/software encoder flags. `quality` is a QP/CRF value (lower = better).
fn encoder_args(encoder: &str, quality: u32) -> Vec<String> {
    let q = quality.to_string();
    match encoder {
        "h264_amf" | "hevc_amf" | "av1_amf" => vec![
            "-c:v".into(),
            encoder.into(),
            "-usage".into(),
            "transcoding".into(),
            "-quality".into(),
            "quality".into(),
            "-rc".into(),
            "cqp".into(),
            "-qp_i".into(),
            q.clone(),
            "-qp_p".into(),
            q.clone(),
            "-qp_b".into(),
            q,
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => vec![
            "-c:v".into(),
            encoder.into(),
            "-preset".into(),
            "p5".into(),
            "-rc".into(),
            "constqp".into(),
            "-qp".into(),
            q,
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        "h264_qsv" | "hevc_qsv" => vec![
            "-c:v".into(),
            encoder.into(),
            "-global_quality".into(),
            q,
            "-pix_fmt".into(),
            "nv12".into(),
        ],
        // Windows Media Foundation: uses GPU via the OS API (the path OBS
        // takes on AMD when the standalone AMF runtime isn't installed).
        // Map our QP scale (14=best, 30=smallest) to MF quality (0-100,
        // higher=better) → 14→95, 30→30.
        "h264_mf" | "hevc_mf" => {
            let mf_q = (95i32 - ((quality as i32 - 14) * 65 / 16)).clamp(30, 95);
            vec![
                "-c:v".into(),
                encoder.into(),
                "-rate_control".into(),
                "quality".into(),
                "-quality".into(),
                mf_q.to_string(),
                "-pix_fmt".into(),
                "nv12".into(),
            ]
        }
        // libx264 and anything unknown.
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            q,
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
    }
}

impl Session {
    /// Spawn one ffmpeg process per group for the current segment index.
    fn start_segment(&mut self) -> Result<(), String> {
        let mut children = Vec::with_capacity(self.groups.len());
        for g in 0..self.groups.len() {
            children.push(self.spawn_group(g)?);
        }
        self.children = children;
        Ok(())
    }

    fn spawn_group(&mut self, g: usize) -> Result<Child, String> {
        let seg = self.segment;
        let kind = match &self.groups[g].kind {
            GroupKind::Monitor(r) => GroupKindLocal::Monitor(*r),
            GroupKind::Window(t) => GroupKindLocal::Window(t.clone()),
        };

        // Outputs that belong to this group, in stable order.
        let idxs: Vec<usize> = (0..self.outputs.len())
            .filter(|&i| self.outputs[i].group == g)
            .collect();
        if idxs.is_empty() {
            return Err("group has no outputs".into());
        }

        // ddagrab (monitor only) delivers GPU frames, so the graph must download
        // them first.
        let head = if matches!(kind, GroupKindLocal::Monitor(_)) && self.backend == "ddagrab" {
            "hwdownload,format=bgra,"
        } else {
            ""
        };

        // Capture "source size" used to decide whether to scale.
        let src_h_default = match &kind {
            GroupKindLocal::Monitor(r) => r.h,
            // Window source size is unknown ahead of time — assume any height
            // and just always apply the scale cap if set.
            GroupKindLocal::Window(_) => u32::MAX,
        };

        // Per-output op chain: crop, then downscale only if the source is
        // taller than the resolution cap. Window outputs never crop (the
        // window is the whole frame); monitor regions crop pixel-exact.
        let ops: Vec<String> = idxs
            .iter()
            .map(|&oi| {
                let crop = self.outputs[oi].crop;
                let src_h = crop.map(|c| c.h).unwrap_or(src_h_default);
                let mut parts: Vec<String> = Vec::new();
                if let Some(c) = crop {
                    parts.push(format!("crop={}:{}:{}:{}", c.w, c.h, c.x, c.y));
                }
                if let Some(mh) = self.max_height {
                    if src_h > mh {
                        parts.push(format!("scale=-2:{mh}:flags=bicubic"));
                    }
                }
                parts.join(",")
            })
            .collect();

        let n = idxs.len();
        let mut filter = String::new();
        let mut maps: Vec<String> = Vec::with_capacity(n);

        if n == 1 {
            let chain = format!("{head}{}", ops[0]);
            let chain = chain.trim_end_matches(',');
            if chain.is_empty() {
                maps.push("0:v".to_string());
            } else {
                filter = format!("[0:v]{chain}[o0]");
                maps.push("[o0]".to_string());
            }
        } else {
            filter.push_str(&format!("[0:v]{head}split={n}"));
            for i in 0..n {
                filter.push_str(&format!("[b{i}]"));
            }
            filter.push(';');
            for i in 0..n {
                let op = if ops[i].is_empty() {
                    "null".to_string()
                } else {
                    ops[i].clone()
                };
                filter.push_str(&format!("[b{i}]{op}[o{i}];"));
                maps.push(format!("[o{i}]"));
            }
            if filter.ends_with(';') {
                filter.pop();
            }
        }

        let mut cmd = ffmpeg::command(&self.ffmpeg);
        cmd.args(["-y", "-hide_banner", "-loglevel", "warning", "-nostats"]);

        // Capture input #0 — video.
        match &kind {
            GroupKindLocal::Window(title) => {
                let draw_mouse = if self.show_cursor { "1" } else { "0" };
                cmd.args([
                    "-f",
                    "gdigrab",
                    "-framerate",
                    &self.fps.to_string(),
                    "-draw_mouse",
                    draw_mouse,
                    "-i",
                    &format!("title={title}"),
                ]);
            }
            GroupKindLocal::Monitor(cap) => match self.backend.as_str() {
                // GPU desktop-duplication capture (experimental; primary output).
                "ddagrab" => {
                    cmd.args([
                        "-f",
                        "lavfi",
                        "-i",
                        &format!("ddagrab=output_idx=0:framerate={}", self.fps),
                    ]);
                }
                // Default: reliable GDI grab of an exact desktop rectangle.
                _ => {
                    let draw_mouse = if self.show_cursor { "1" } else { "0" };
                    cmd.args([
                        "-f",
                        "gdigrab",
                        "-framerate",
                        &self.fps.to_string(),
                        "-draw_mouse",
                        draw_mouse,
                        "-offset_x",
                        &cap.x.to_string(),
                        "-offset_y",
                        &cap.y.to_string(),
                        "-video_size",
                        &format!("{}x{}", cap.w, cap.h),
                        "-i",
                        "desktop",
                    ]);
                }
            },
        }

        // Optional audio input #1 — dshow device. We don't decide system vs
        // mic here — the user picks any dshow audio device they have (a mic,
        // Stereo Mix, virtual-audio-capturer, VB-Cable output, etc).
        let has_audio = if let Some(dev) = &self.audio_device {
            cmd.args([
                "-f",
                "dshow",
                "-rtbufsize",
                "256M",
                "-i",
                &format!("audio={dev}"),
            ]);
            true
        } else {
            false
        };

        if !filter.is_empty() {
            cmd.args(["-filter_complex", &filter]);
        }

        // One mapped, encoded output file per region in this group.
        for (i, &oi) in idxs.iter().enumerate() {
            let part = self
                .parts_dir
                .join(format!("{g}_{}.{seg:03}.mp4", self.outputs[oi].safe));
            self.outputs[oi].parts.push(part.clone());

            cmd.arg("-map").arg(&maps[i]);
            cmd.args(encoder_args(&self.encoder, self.quality));
            cmd.args(["-r", &self.fps.to_string()]);

            if has_audio {
                cmd.args(["-map", "1:a", "-c:a", "aac", "-b:a", "192k"]);
            } else {
                cmd.arg("-an");
            }
            cmd.arg("-movflags").arg("+faststart");
            cmd.arg(&part);
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        cmd.spawn()
            .map_err(|e| format!("failed to launch ffmpeg ({}): {e}", self.ffmpeg))
    }

    /// Gracefully tell every ffmpeg child to finish the current segment.
    fn stop_children(&mut self) {
        for child in self.children.iter_mut() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
        }
        for child in self.children.iter_mut() {
            let _ = child.wait();
        }
        self.children.clear();
    }

    fn elapsed(&self) -> Duration {
        if self.paused {
            self.accumulated
        } else {
            self.accumulated + self.run_started.elapsed()
        }
    }

    /// Stitch each output's segments into its final file (or rename a lone part).
    fn finalize(&self) -> Result<Vec<String>, String> {
        let mut files = Vec::new();
        for o in &self.outputs {
            if o.parts.is_empty() {
                continue;
            }
            if o.parts.len() == 1 {
                if fs::rename(&o.parts[0], &o.final_path).is_err() {
                    fs::copy(&o.parts[0], &o.final_path).map_err(|e| e.to_string())?;
                }
            } else {
                let list = self.parts_dir.join(format!("{}_concat.txt", o.safe));
                {
                    let mut f = File::create(&list).map_err(|e| e.to_string())?;
                    for p in &o.parts {
                        let path = p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
                        writeln!(f, "file '{path}'").map_err(|e| e.to_string())?;
                    }
                }
                let status = ffmpeg::command(&self.ffmpeg)
                    .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
                    .arg(&list)
                    .args(["-c", "copy", "-movflags", "+faststart"])
                    .arg(&o.final_path)
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err(format!("concat failed for {}", o.safe));
                }
            }
            files.push(o.final_path.to_string_lossy().to_string());
        }
        let _ = fs::remove_dir_all(&self.parts_dir);
        Ok(files)
    }
}

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, Recorder>,
    config: StartConfig,
) -> Result<RecStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "recorder state poisoned")?;
    if guard.is_some() {
        return Err("already recording".into());
    }

    if config.regions.is_empty() && !config.include_fullscreen {
        return Err("nothing to record — add a region or enable full screen".into());
    }
    if config.save_root.trim().is_empty() {
        return Err("no save folder set".into());
    }

    let ffmpeg_bin = ffmpeg::bin(&config.ffmpeg_path);
    if !ffmpeg::is_available(&config.ffmpeg_path) {
        return Err(format!(
            "ffmpeg not found ({ffmpeg_bin}). Install it or set a path in Settings."
        ));
    }

    // Resolve the encoder. Concrete encoders are trusted (the frontend already
    // validated them via probe); only "auto"/empty triggers a fresh probe that
    // runtime-tests the hardware encoders and falls back to libx264 (CPU).
    let encoder = if config.encoder.is_empty() || config.encoder == "auto" {
        ffmpeg::probe(&config.ffmpeg_path)
            .recommended
            .unwrap_or_else(|| "libx264".to_string())
    } else {
        config.encoder.clone()
    };

    let mons = monitors::enumerate(&app)?;

    // Groups: monitor-region groups are de-duped by monitor name (so multiple
    // regions on one monitor share one gdigrab). Window-region groups are
    // always unique — each window gets its own capture pipeline.
    let mut group_of: Vec<(String, usize)> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    let mut monitor_group = |name: &str, rect: Rect, groups: &mut Vec<Group>| -> usize {
        if let Some((_, idx)) = group_of.iter().find(|(n, _)| n == name) {
            *idx
        } else {
            let idx = groups.len();
            groups.push(Group { kind: GroupKind::Monitor(rect) });
            group_of.push((name.to_string(), idx));
            idx
        }
    };

    let mut outputs: Vec<OutputState> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut unique = |base: &str| -> String {
        let mut name = base.to_string();
        let mut n = 2;
        while used_names.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        used_names.insert(name.clone());
        name
    };

    // Regions → cropped outputs (or window-capture outputs).
    for region in &config.regions {
        // Window-capture: a region pinned to a window title.
        if let Some(title) = region.window_title.as_ref().filter(|t| !t.trim().is_empty()) {
            let g = groups.len();
            groups.push(Group { kind: GroupKind::Window(title.clone()) });
            let safe = unique(&sanitize(&region.name));
            outputs.push(OutputState {
                final_path: PathBuf::new(),
                safe,
                group: g,
                crop: None,
                parts: Vec::new(),
            });
            continue;
        }

        let (cx, cy) = region.rect.center();
        let mon = monitors::monitor_for_point(&mons, cx, cy)
            .ok_or("no monitor found for a region")?
            .clone();
        let g = monitor_group(&mon.name, mon.rect(), &mut groups);

        let r = region.rect.even_size();
        // Crop relative to the monitor, clamped inside it.
        let mut cx0 = r.x - mon.x;
        let mut cy0 = r.y - mon.y;
        cx0 = cx0.clamp(0, (mon.width as i32 - 2).max(0));
        cy0 = cy0.clamp(0, (mon.height as i32 - 2).max(0));
        let cw = (r.w as i32).min(mon.width as i32 - cx0).max(2) as u32 & !1;
        let ch = (r.h as i32).min(mon.height as i32 - cy0).max(2) as u32 & !1;

        let safe = unique(&sanitize(&region.name));
        outputs.push(OutputState {
            final_path: PathBuf::new(), // filled in once root is known
            safe: safe.clone(),
            group: g,
            crop: Some(Rect {
                x: cx0,
                y: cy0,
                w: cw,
                h: ch,
            }),
            parts: Vec::new(),
        });
    }

    // Optional full-monitor output.
    if config.include_fullscreen {
        let mon = match &config.fullscreen_monitor {
            Some(name) => mons.iter().find(|m| &m.name == name).cloned(),
            None => mons.iter().find(|m| m.primary).cloned(),
        }
        .or_else(|| mons.first().cloned())
        .ok_or("no monitor available for full-screen capture")?;
        let g = monitor_group(&mon.name, mon.rect(), &mut groups);
        let safe = unique("fullscreen");
        outputs.push(OutputState {
            final_path: PathBuf::new(),
            safe,
            group: g,
            crop: None,
            parts: Vec::new(),
        });
    }

    // Build the session folder: <save_root>/<label>/<timestamp>.
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let label = sanitize(&config.label);
    let root = PathBuf::from(&config.save_root).join(&label).join(&stamp);
    let parts_dir = root.join(".parts");
    fs::create_dir_all(&parts_dir).map_err(|e| format!("cannot create save folder: {e}"))?;

    for o in &mut outputs {
        o.final_path = root.join(format!("{}.mp4", o.safe));
    }

    let mut session = Session {
        ffmpeg: ffmpeg_bin,
        backend: config.backend,
        fps: config.fps.clamp(1, 240),
        encoder,
        quality: config.quality.clamp(0, 51),
        max_height: config.max_height.filter(|h| *h > 0),
        show_cursor: config.show_cursor,
        audio_device: config.audio_device.filter(|s| !s.trim().is_empty()),
        root,
        parts_dir,
        groups,
        outputs,
        children: Vec::new(),
        segment: 0,
        paused: false,
        accumulated: Duration::ZERO,
        run_started: Instant::now(),
    };

    session.start_segment().map_err(|e| {
        // Clean up the empty session folder on failure.
        let _ = fs::remove_dir_all(&session.root);
        e
    })?;

    let status = RecStatus {
        recording: true,
        paused: false,
        outputs: session.outputs.iter().map(|o| o.safe.clone()).collect(),
        root: Some(session.root.to_string_lossy().to_string()),
        elapsed_ms: 0,
    };

    let _ = app.emit("rec:started", &status);
    *guard = Some(session);
    Ok(status)
}

#[tauri::command]
pub fn pause_recording(
    app: AppHandle,
    state: tauri::State<'_, Recorder>,
) -> Result<RecStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "recorder state poisoned")?;
    let session = guard.as_mut().ok_or("not recording")?;
    if session.paused {
        return Err("already paused".into());
    }
    session.accumulated += session.run_started.elapsed();
    session.stop_children();
    session.paused = true;

    let status = build_status(session);
    let _ = app.emit("rec:paused", &status);
    Ok(status)
}

#[tauri::command]
pub fn resume_recording(
    app: AppHandle,
    state: tauri::State<'_, Recorder>,
) -> Result<RecStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "recorder state poisoned")?;
    let session = guard.as_mut().ok_or("not recording")?;
    if !session.paused {
        return Err("not paused".into());
    }
    session.segment += 1;
    session.start_segment()?;
    session.paused = false;
    session.run_started = Instant::now();

    let status = build_status(session);
    let _ = app.emit("rec:resumed", &status);
    Ok(status)
}

#[tauri::command]
pub fn stop_recording(
    app: AppHandle,
    state: tauri::State<'_, Recorder>,
) -> Result<RecResult, String> {
    let mut guard = state.0.lock().map_err(|_| "recorder state poisoned")?;
    let mut session = guard.take().ok_or("not recording")?;

    if !session.paused {
        session.accumulated += session.run_started.elapsed();
    }
    session.stop_children();

    let files = session.finalize()?;
    let result = RecResult {
        root: session.root.to_string_lossy().to_string(),
        files,
        elapsed_ms: session.accumulated.as_millis(),
    };
    let _ = app.emit("rec:stopped", &result);
    Ok(result)
}

#[tauri::command]
pub fn recording_status(state: tauri::State<'_, Recorder>) -> Result<RecStatus, String> {
    let guard = state.0.lock().map_err(|_| "recorder state poisoned")?;
    Ok(match guard.as_ref() {
        Some(s) => build_status(s),
        None => RecStatus {
            recording: false,
            paused: false,
            outputs: Vec::new(),
            root: None,
            elapsed_ms: 0,
        },
    })
}

fn build_status(s: &Session) -> RecStatus {
    RecStatus {
        recording: true,
        paused: s.paused,
        outputs: s.outputs.iter().map(|o| o.safe.clone()).collect(),
        root: Some(s.root.to_string_lossy().to_string()),
        elapsed_ms: s.elapsed().as_millis(),
    }
}
