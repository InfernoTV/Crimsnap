//! Export / import the full Crimsnap config (settings + presets + a snapshot
//! of the current capture layout) as a single portable JSON file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::model::Rect;
use crate::presets;
use crate::settings;

#[derive(Serialize, Deserialize)]
pub struct RegionSnapshot {
    pub name: String,
    pub rect: Rect,
    #[serde(default)]
    pub monitor: Option<String>,
    #[serde(default)]
    pub window_title: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ConfigBundle {
    pub version: u32,
    pub app: String,
    pub settings: settings::Settings,
    pub presets: Vec<presets::Preset>,
    /// Currently-staged regions in the UI (so users can ship a "the layout
    /// I'm using right now" alongside their named presets).
    #[serde(default)]
    pub regions: Vec<RegionSnapshot>,
}

#[derive(Serialize, Deserialize)]
pub struct ImportedSnapshot {
    pub settings: settings::Settings,
    pub presets: Vec<presets::Preset>,
    pub regions: Vec<RegionSnapshot>,
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn export_config(
    app: AppHandle,
    path: String,
    regions: Vec<RegionSnapshot>,
) -> Result<String, String> {
    let bundle = ConfigBundle {
        version: 1,
        app: "crimsnap".to_string(),
        settings: settings::load(&app),
        presets: presets::read_all(&app),
        regions,
    };
    let out = PathBuf::from(&path);
    ensure_parent(&out)?;
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    fs::write(&out, json).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_config(app: AppHandle, path: String) -> Result<ImportedSnapshot, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("can't open {path}: {e}"))?;
    let bundle: ConfigBundle =
        serde_json::from_str(&text).map_err(|e| format!("not a Crimsnap config: {e}"))?;
    if bundle.app != "crimsnap" {
        return Err(format!("file isn't a Crimsnap config (got app={})", bundle.app));
    }
    settings::store(&app, &bundle.settings)?;
    presets::write_all(&app, &bundle.presets)?;
    Ok(ImportedSnapshot {
        settings: bundle.settings,
        presets: bundle.presets,
        regions: bundle.regions,
    })
}
