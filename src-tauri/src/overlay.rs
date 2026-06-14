use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::monitors::{self, MonitorInfo};

/// Remembers which monitor the active selection overlay covers, so we can turn
/// window-local coordinates back into absolute desktop coordinates.
#[derive(Default)]
pub struct OverlayTarget(pub Mutex<Option<MonitorInfo>>);

#[derive(Clone, Serialize)]
pub struct SelectedRegion {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub monitor: String,
}

/// Spawn the dim selection overlay across one monitor.
#[tauri::command]
pub fn open_region_overlay(
    app: AppHandle,
    target: tauri::State<'_, OverlayTarget>,
    monitor: Option<String>,
) -> Result<(), String> {
    let mons = monitors::enumerate(&app)?;
    let mon = monitor
        .and_then(|name| mons.iter().find(|m| m.name == name).cloned())
        .or_else(|| mons.iter().find(|m| m.primary).cloned())
        .or_else(|| mons.first().cloned())
        .ok_or("no monitor available")?;

    if let Some(existing) = app.get_webview_window("overlay") {
        let _ = existing.close();
    }

    let win = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Crimsnap — Select Region")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    win.set_position(Position::Physical(PhysicalPosition::new(mon.x, mon.y)))
        .map_err(|e| e.to_string())?;
    win.set_size(Size::Physical(PhysicalSize::new(mon.width, mon.height)))
        .map_err(|e| e.to_string())?;
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    let _ = win.set_focus();

    *target.0.lock().map_err(|_| "overlay state poisoned")? = Some(mon);
    Ok(())
}

/// Called by the overlay on mouse-up. `x/y/w/h` are physical pixels relative to
/// the overlay window's top-left (the overlay already multiplied by DPR).
#[tauri::command]
pub fn finish_region_selection(
    app: AppHandle,
    target: tauri::State<'_, OverlayTarget>,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let mon = target
        .0
        .lock()
        .map_err(|_| "overlay state poisoned")?
        .clone();

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }

    let mon = mon.ok_or("no overlay target")?;
    let region = SelectedRegion {
        x: mon.x + x,
        y: mon.y + y,
        w,
        h,
        monitor: mon.name,
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    app.emit("region:selected", &region)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cancel_region_selection(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
    let _ = app.emit("region:cancelled", ());
    Ok(())
}
