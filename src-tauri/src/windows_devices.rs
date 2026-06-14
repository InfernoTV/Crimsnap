//! Enumerate top-level windows and dshow audio devices.

use serde::Serialize;

use crate::ffmpeg;

#[derive(Clone, Serialize)]
pub struct WindowEntry {
    pub title: String,
    pub class_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_loopback_hint: bool,
}

#[cfg(windows)]
mod sys {
    use super::WindowEntry;
    use std::cell::RefCell;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    thread_local! {
        static SINK: RefCell<Vec<WindowEntry>> = const { RefCell::new(Vec::new()) };
    }

    pub fn enumerate_windows() -> Vec<WindowEntry> {
        SINK.with(|s| s.borrow_mut().clear());
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(0));
        }
        SINK.with(|s| s.borrow().clone())
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if (ex_style as u32 & WS_EX_TOOLWINDOW.0) != 0 {
            return BOOL(1);
        }
        // Skip windows hidden by DWM cloaking (e.g. minimized to other virtual desktops).
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return BOOL(1);
        }
        let mut title_buf: Vec<u16> = vec![0; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..copied as usize]);
        if title.trim().is_empty() {
            return BOOL(1);
        }
        let mut class_buf: [u16; 256] = [0; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

        // Prefer the DWM "extended frame bounds" — matches what the user sees,
        // unlike GetWindowRect which includes invisible resize borders.
        let mut rect = RECT::default();
        let res = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if res.is_err() {
            return BOOL(1);
        }
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        if width < 50 || height < 50 {
            return BOOL(1);
        }

        SINK.with(|s| {
            s.borrow_mut().push(WindowEntry {
                title,
                class_name,
                x: rect.left,
                y: rect.top,
                width,
                height,
            });
        });
        BOOL(1)
    }
}

#[cfg(not(windows))]
mod sys {
    use super::WindowEntry;
    pub fn enumerate_windows() -> Vec<WindowEntry> {
        Vec::new()
    }
}

#[tauri::command]
pub fn list_windows() -> Vec<WindowEntry> {
    sys::enumerate_windows()
}

/// Probe ffmpeg's dshow input to learn what audio devices are available.
/// dshow prints them to stderr as `"Some Device Name" (audio)` lines.
#[tauri::command]
pub fn list_audio_devices(ffmpeg_path: Option<String>) -> Vec<AudioDevice> {
    let bin = ffmpeg::bin(&ffmpeg_path);
    let output = ffmpeg::command(&bin)
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    // ffmpeg writes the device list to stderr regardless of the exit code.
    let text = String::from_utf8_lossy(&out.stderr);
    let mut devices = Vec::new();
    let mut in_audio = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.contains("DirectShow audio devices") {
            in_audio = true;
            continue;
        }
        if line.contains("DirectShow video devices") {
            in_audio = false;
            continue;
        }
        if !in_audio {
            continue;
        }
        if let (Some(start), Some(end)) = (line.find('"'), line.rfind('"')) {
            if end > start + 1 {
                let name = &line[start + 1..end];
                // Skip ffmpeg's own "Alternative name" follow-ups.
                if line.contains("Alternative name") {
                    continue;
                }
                let lower = name.to_lowercase();
                let is_loopback_hint = lower.contains("stereo mix")
                    || lower.contains("loopback")
                    || lower.contains("vb-cable")
                    || lower.contains("cable output")
                    || lower.contains("voicemeeter out")
                    || lower.contains("virtual-audio-capturer")
                    || lower.contains("what u hear");
                devices.push(AudioDevice {
                    name: name.to_string(),
                    is_loopback_hint,
                });
            }
        }
    }
    devices
}
