mod config_io;
mod ffmpeg;
mod model;
mod monitors;
mod overlay;
mod presets;
mod recorder;
mod settings;
mod windows_devices;

use tauri::{AppHandle, Manager};

/// Probe ffmpeg using the binary configured in settings.
#[tauri::command]
fn probe_ffmpeg(app: AppHandle) -> Result<ffmpeg::FfmpegProbe, String> {
    let s = settings::load(&app);
    Ok(ffmpeg::probe(&s.ffmpeg_path))
}

/// Pin / unpin the main window. We do it Rust-side so it survives a webview
/// reload and so the on/off path is the same whether the toggle came from the
/// titlebar button or a saved setting at startup.
#[tauri::command]
fn set_always_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    let mut s = settings::load(&app);
    s.always_on_top = on;
    settings::store(&app, &s)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(recorder::Recorder::default())
        .manage(overlay::OverlayTarget::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let handle = app.handle().clone();
            // Apply persisted always-on-top after the main window exists.
            let s = settings::load(&handle);
            if s.always_on_top {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.set_always_on_top(true);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            monitors::list_monitors,
            monitors::snapshot_monitor,
            settings::get_settings,
            settings::save_settings,
            settings::get_default_save_folder,
            presets::list_presets,
            presets::save_preset,
            presets::delete_preset,
            overlay::open_region_overlay,
            overlay::finish_region_selection,
            overlay::cancel_region_selection,
            recorder::start_recording,
            recorder::pause_recording,
            recorder::resume_recording,
            recorder::stop_recording,
            recorder::recording_status,
            windows_devices::list_windows,
            windows_devices::list_audio_devices,
            config_io::export_config,
            config_io::import_config,
            probe_ffmpeg,
            set_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crimsnap");
}
