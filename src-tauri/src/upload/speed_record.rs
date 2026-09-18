//! The best whole-job rate this machine has ever sustained, kept across runs.
//!
//! It is the yardstick `speed_watch` needs for a lone file: with nothing else
//! running there is no other process to compare with, and without a record a
//! single upload on a throttled account crawls for its whole length.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "speed-record.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeedRecord {
    best_bytes_per_sec: f64,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

/// The recorded best, or 0 when there is none yet. Never fails: a missing or
/// unreadable record simply means the lone-file rule waits for a new one.
pub fn load(app: &AppHandle) -> f64 {
    let Some(path) = path(app) else { return 0.0 };
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SpeedRecord>(&bytes).ok())
        .map(|record| record.best_bytes_per_sec.max(0.0))
        .unwrap_or(0.0)
}

/// Writes the record when it has improved on what is stored.
pub fn save(app: &AppHandle, best_bytes_per_sec: f64) {
    if best_bytes_per_sec <= load(app) {
        return;
    }
    let Some(path) = path(app) else { return };
    let record = SpeedRecord { best_bytes_per_sec };
    let written = serde_json::to_vec_pretty(&record)
        .map_err(|e| e.to_string())
        .and_then(|bytes| std::fs::write(&path, bytes).map_err(|e| e.to_string()));
    match written {
        Ok(()) => log::info!(
            target: "rclone",
            "speed.record_saved bytes_per_sec={best_bytes_per_sec:.0}"
        ),
        Err(err) => log::warn!(target: "rclone", "speed.record_not_saved err={err}"),
    }
}
