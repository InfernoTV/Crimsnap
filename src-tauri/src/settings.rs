use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub save_folder: String,
    pub fps: u32,
    pub encoder: String,
    pub quality: u32,
    /// Downscale cap (height in px); 0 = native resolution.
    pub resolution: u32,
    pub backend: String,
    pub show_cursor: bool,
    pub default_monitor: Option<String>,
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub audio_device: Option<String>,
    #[serde(default = "default_audio_enabled")]
    pub audio_enabled: bool,
}

fn default_audio_enabled() -> bool {
    false
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            save_folder: String::new(),
            fps: 60,
            encoder: "auto".to_string(),
            quality: 20,
            resolution: 0,
            backend: "gdigrab".to_string(),
            show_cursor: true,
            default_monitor: None,
            ffmpeg_path: None,
            always_on_top: false,
            audio_device: None,
            audio_enabled: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// The default save folder: <Videos>/Crimsnap.
pub fn default_save_folder(app: &AppHandle) -> String {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("Crimsnap").to_string_lossy().to_string()
}

pub fn load(app: &AppHandle) -> Settings {
    let mut s = settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .unwrap_or_default();
    if s.save_folder.trim().is_empty() {
        s.save_folder = default_save_folder(app);
    }
    s
}

pub fn store(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(load(&app))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    store(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn get_default_save_folder(app: AppHandle) -> Result<String, String> {
    Ok(default_save_folder(&app))
}
