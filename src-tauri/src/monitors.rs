use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::ffmpeg;
use crate::model::Rect;
use crate::settings;

#[derive(Clone, Serialize)]
pub struct MonitorInfo {
    /// Internal Win32 identifier (`\\.\DISPLAY1`) — used everywhere as the
    /// stable handle, not shown to the user.
    pub name: String,
    /// Friendly display name like "DELL U2719D" (from `EnumDisplayDevices`),
    /// or `None` if we couldn't resolve one.
    pub friendly_name: Option<String>,
    /// 1-based ordinal used to label "Display 1", "Display 2", … in the UI.
    pub ordinal: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

impl MonitorInfo {
    pub fn rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            w: self.width,
            h: self.height,
        }
    }
}

/// Enumerate the physical monitor layout. We borrow the main window because in
/// Tauri v2 the monitor APIs hang off a window handle.
pub fn enumerate(app: &AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let win = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "no window available to query monitors".to_string())?;

    let primary_name = win
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .and_then(|m| m.name().cloned());

    let monitors = win.available_monitors().map_err(|e| e.to_string())?;

    let friendly_map = friendly_name_map();

    let mut out = Vec::with_capacity(monitors.len());
    for (i, m) in monitors.iter().enumerate() {
        let name = m
            .name()
            .cloned()
            .unwrap_or_else(|| format!("Display {}", i + 1));
        let pos = m.position();
        let size = m.size();
        let primary = match &primary_name {
            Some(p) => &name == p,
            None => pos.x == 0 && pos.y == 0,
        };
        let friendly_name = friendly_map.get(&name).cloned();
        out.push(MonitorInfo {
            name,
            friendly_name,
            ordinal: (i as u32) + 1,
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale: m.scale_factor(),
            primary,
        });
    }
    Ok(out)
}

/// On Windows, map each `\\.\DISPLAYN` adapter name to the *monitor's* friendly
/// name (e.g. "DELL U2719D"). On other platforms (or if the lookup fails) we
/// just return an empty map and the UI falls back to "Display N".
#[cfg(windows)]
fn friendly_name_map() -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    use windows::core::PWSTR;
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    // Not re-exported by the `windows` crate; defined as 1 in WinUser.h.
    const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x0000_0001;

    fn lossy(buf: &[u16]) -> String {
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }

    let mut map: HashMap<String, String> = HashMap::new();
    unsafe {
        let mut adapter_idx = 0u32;
        loop {
            let mut adapter = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..Default::default()
            };
            let ok = EnumDisplayDevicesW(PWSTR::null(), adapter_idx, &mut adapter, 0).as_bool();
            if !ok {
                break;
            }
            adapter_idx += 1;

            let adapter_name = lossy(&adapter.DeviceName);
            // Iterate the monitors connected to this adapter — we want their
            // friendly DeviceString, not the adapter's GPU string.
            let mut monitor_idx = 0u32;
            loop {
                let mut monitor = DISPLAY_DEVICEW {
                    cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    ..Default::default()
                };
                let mok = EnumDisplayDevicesW(
                    PWSTR::from_raw(adapter.DeviceName.as_ptr() as *mut _),
                    monitor_idx,
                    &mut monitor,
                    EDD_GET_DEVICE_INTERFACE_NAME,
                )
                .as_bool();
                if !mok {
                    break;
                }
                monitor_idx += 1;

                let friendly = lossy(&monitor.DeviceString);
                if !friendly.trim().is_empty() {
                    map.insert(adapter_name.clone(), friendly);
                    break; // first monitor on the adapter is enough
                }
            }
        }
    }
    map
}

#[cfg(not(windows))]
fn friendly_name_map() -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

/// Find the monitor whose bounds contain the given point, falling back to the
/// primary (or first) monitor.
pub fn monitor_for_point<'a>(
    monitors: &'a [MonitorInfo],
    px: i32,
    py: i32,
) -> Option<&'a MonitorInfo> {
    monitors
        .iter()
        .find(|m| m.rect().contains_point(px, py))
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    enumerate(&app)
}

/// Grab a single PNG of the named monitor (or the primary if name is None) and
/// stash it in the app cache so the region picker can blueprint over real
/// pixels instead of a generic rectangle.
#[tauri::command]
pub fn snapshot_monitor(app: AppHandle, monitor: Option<String>) -> Result<String, String> {
    let mons = enumerate(&app)?;
    let mon = monitor
        .and_then(|n| mons.iter().find(|m| m.name == n).cloned())
        .or_else(|| mons.iter().find(|m| m.primary).cloned())
        .or_else(|| mons.first().cloned())
        .ok_or("no monitor available")?;

    let s = settings::load(&app);
    let bin = ffmpeg::bin(&s.ffmpeg_path);

    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = cache.join(format!("preview-{stamp}.png"));

    let status = ffmpeg::command(&bin)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "gdigrab",
            "-framerate",
            "1",
            "-draw_mouse",
            "0",
            "-offset_x",
            &mon.x.to_string(),
            "-offset_y",
            &mon.y.to_string(),
            "-video_size",
            &format!("{}x{}", mon.width, mon.height),
            "-i",
            "desktop",
            "-frames:v",
            "1",
        ])
        .arg(&out)
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err("ffmpeg failed to capture the monitor".into());
    }
    Ok(out.to_string_lossy().to_string())
}
