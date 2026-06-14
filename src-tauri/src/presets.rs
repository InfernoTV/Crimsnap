use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::model::Rect;

#[derive(Clone, Serialize, Deserialize)]
pub struct RegionDef {
    pub name: String,
    pub rect: Rect,
    #[serde(default)]
    pub monitor: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Preset {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub regions: Vec<RegionDef>,
    #[serde(default)]
    pub include_fullscreen: bool,
    #[serde(default)]
    pub fullscreen_monitor: Option<String>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
}

fn presets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("presets.json"))
}

pub fn read_all(app: &AppHandle) -> Vec<Preset> {
    presets_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<Preset>>(&t).ok())
        .unwrap_or_default()
}

pub fn write_all(app: &AppHandle, presets: &[Preset]) -> Result<(), String> {
    let path = presets_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(presets).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p{nanos}")
}

#[tauri::command]
pub fn list_presets(app: AppHandle) -> Result<Vec<Preset>, String> {
    Ok(read_all(&app))
}

/// Insert or update a preset. A blank id means "create new".
#[tauri::command]
pub fn save_preset(app: AppHandle, mut preset: Preset) -> Result<Preset, String> {
    let mut all = read_all(&app);
    if preset.id.trim().is_empty() {
        preset.id = new_id();
    }
    match all.iter_mut().find(|p| p.id == preset.id) {
        Some(existing) => *existing = preset.clone(),
        None => all.push(preset.clone()),
    }
    write_all(&app, &all)?;
    Ok(preset)
}

#[tauri::command]
pub fn delete_preset(app: AppHandle, id: String) -> Result<(), String> {
    let mut all = read_all(&app);
    all.retain(|p| p.id != id);
    write_all(&app, &all)
}
