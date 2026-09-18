//! Service accounts that crawled recently, remembered across jobs.
//!
//! Google throttles an account that has been pushed hard, and the throttle
//! outlives the job that discovered it by hours. Within a job a crawling
//! account is marked and picked last (see `mark_slow` in `rclone`); this keeps
//! that mark on disk for a day, so the next job does not start on the same
//! throttled account and find out all over again.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "slow-accounts.json";

/// How long a mark is honoured. Throttles lift on their own within a day.
pub const TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Account path -> when it was last found crawling, as Unix seconds.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    accounts: HashMap<String, u64>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Drops marks older than `TTL` as of `now`.
fn prune(accounts: &mut HashMap<String, u64>, now: u64) {
    let oldest = now.saturating_sub(TTL.as_secs());
    accounts.retain(|_, marked_at| *marked_at >= oldest);
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

fn read(app: &AppHandle) -> Store {
    let Some(path) = path(app) else {
        return Store::default();
    };
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, store: &Store) {
    let Some(path) = path(app) else { return };
    let written = serde_json::to_vec_pretty(store)
        .map_err(|e| e.to_string())
        .and_then(|bytes| std::fs::write(&path, bytes).map_err(|e| e.to_string()));
    if let Err(err) = written {
        log::warn!(target: "rclone", "sa.slow_list_not_saved err={err}");
    }
}

/// Accounts found crawling within the last `TTL`. Never fails: without a
/// readable list every account simply starts unmarked.
pub fn recently_slow(app: &AppHandle) -> HashSet<PathBuf> {
    let mut store = read(app);
    prune(&mut store.accounts, now_secs());
    store.accounts.keys().map(PathBuf::from).collect()
}

/// Records that `sa_path` was found crawling just now.
pub fn note(app: &AppHandle, sa_path: &Path) {
    let now = now_secs();
    let mut store = read(app);
    prune(&mut store.accounts, now);
    store
        .accounts
        .insert(sa_path.to_string_lossy().to_string(), now);
    write(app, &store);
    log::info!(
        target: "rclone",
        "sa.remembered_slow sa={} remembered={}",
        sa_path.to_string_lossy(),
        store.accounts.len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_expire_after_a_day() {
        let now = 1_000_000;
        let mut accounts = HashMap::from([
            ("fresh.json".to_string(), now - 60),
            ("yesterday.json".to_string(), now - TTL.as_secs() + 1),
            ("stale.json".to_string(), now - TTL.as_secs() - 1),
        ]);
        prune(&mut accounts, now);
        let mut kept: Vec<&str> = accounts.keys().map(String::as_str).collect();
        kept.sort_unstable();
        assert_eq!(kept, vec!["fresh.json", "yesterday.json"]);
    }

    #[test]
    fn the_list_round_trips_through_json() {
        let store = Store {
            accounts: HashMap::from([("C:\\accounts\\0.json".to_string(), 42)]),
        };
        let bytes = serde_json::to_vec(&store).unwrap();
        let back: Store = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.accounts.get("C:\\accounts\\0.json"), Some(&42));
    }
}
