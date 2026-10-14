//! The bundle identifier changed from `com.vo1x.gdexplorer` to
//! `com.ionicboy.gdexplorer`. The identifier names the per-user folders the app
//! keeps everything in - preferences, recovery files, the managed rclone, the
//! remote status, and on Windows and macOS the webview's storage, which holds
//! the upload queue and destinations - so without this every user would start
//! from scratch after the update.
//!
//! On the first start under the new identifier, each old folder is copied to
//! its new name before anything reads it, and paths in `preferences.json` that
//! pointed into the old folder (the managed rclone) are pointed at the copy.
//! The old folders are left as they were: an older copy of the app that is
//! still installed (such as an all-users install) keeps working from them.

use std::path::{Path, PathBuf};

pub const OLD_IDENTIFIER: &str = "com.vo1x.gdexplorer";
/// Must match `identifier` in tauri.conf.json (checked by a test).
pub const IDENTIFIER: &str = "com.ionicboy.gdexplorer";

/// The (old, new) folder pairs on this platform. Computed from the
/// environment because this runs before Tauri, and so before its path resolver.
fn folder_pairs() -> Vec<(PathBuf, PathBuf)> {
    let mut bases: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    for var in ["APPDATA", "LOCALAPPDATA"] {
        // Roaming: app data. Local: the WebView2 profile.
        if let Some(dir) = std::env::var_os(var) {
            bases.push(PathBuf::from(dir));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let library = PathBuf::from(home).join("Library");
        bases.push(library.join("Application Support"));
        // WKWebView's storage for the bundled app.
        bases.push(library.join("WebKit"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
        bases.extend(data);
    }
    bases
        .into_iter()
        .map(|base| (base.join(OLD_IDENTIFIER), base.join(IDENTIFIER)))
        .collect()
}

/// Carries the old folders over. Returns what it did, for the log (logging is
/// not set up yet when this runs).
pub fn carry_over() -> Vec<String> {
    folder_pairs()
        .into_iter()
        .filter_map(|(old, new)| migrate(&old, &new))
        .collect()
}

/// Copies `old` to `new` unless `new` already exists. The copy goes to a
/// staging folder first and is renamed into place at the end, so an
/// interrupted copy is redone on the next start instead of being taken for a
/// finished one.
fn migrate(old: &Path, new: &Path) -> Option<String> {
    if new.exists() || !old.is_dir() {
        return None;
    }
    let staging = new.with_file_name(format!("{IDENTIFIER}.migrating"));
    let _ = std::fs::remove_dir_all(&staging);
    let mut skipped = 0;
    if let Err(e) = copy_tree(old, &staging, &mut skipped) {
        let _ = std::fs::remove_dir_all(&staging);
        return Some(format!(
            "data: could not copy {} to {}: {e}",
            old.display(),
            new.display()
        ));
    }
    repoint_preferences(&staging.join("preferences.json"), old, new);
    match std::fs::rename(&staging, new) {
        Ok(()) => Some(format!(
            "data: carried {} over to {}{}",
            old.display(),
            new.display(),
            if skipped > 0 {
                format!(" ({skipped} unreadable files skipped)")
            } else {
                String::new()
            }
        )),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Some(format!(
                "data: could not move the copy into {}: {e}",
                new.display()
            ))
        }
    }
}

/// Copies a folder tree. A file that cannot be read (a cache file held open by
/// another program) is skipped and counted rather than failing the whole copy.
fn copy_tree(from: &Path, to: &Path, skipped: &mut usize) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let Ok(entry) = entry else {
            *skipped += 1;
            continue;
        };
        let target = to.join(entry.file_name());
        let copied = match entry.file_type() {
            Ok(kind) if kind.is_dir() => copy_tree(&entry.path(), &target, skipped).is_ok(),
            Ok(kind) if kind.is_file() => std::fs::copy(entry.path(), &target).is_ok(),
            // symlinks and anything else are not part of the app's data
            _ => true,
        };
        if !copied {
            *skipped += 1;
        }
    }
    Ok(())
}

/// Points paths in preferences.json that lead into the old folder - the rclone
/// the app installed itself lives there - at the same place in the new one.
fn repoint_preferences(file: &Path, old: &Path, new: &Path) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(fields) = value.as_object_mut() else {
        return;
    };
    let (old, new) = (old.to_string_lossy(), new.to_string_lossy());
    let mut changed = false;
    for field in fields.values_mut() {
        let Some(path) = field.as_str() else {
            continue;
        };
        // Windows paths compare case-insensitively.
        let leads_into_old = path.len() >= old.len()
            && path.is_char_boundary(old.len())
            && path[..old.len()].eq_ignore_ascii_case(&old);
        if leads_into_old {
            *field = serde_json::Value::String(format!("{new}{}", &path[old.len()..]));
            changed = true;
        }
    }
    if changed {
        if let Ok(text) = serde_json::to_string_pretty(&value) {
            let _ = std::fs::write(file, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gdx-migrate-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
        assert_ne!(OLD_IDENTIFIER, IDENTIFIER);
    }

    #[test]
    fn copies_the_old_folder_and_repoints_preferences() {
        let base = temp_base("copy");
        let (old, new) = (base.join(OLD_IDENTIFIER), base.join(IDENTIFIER));
        std::fs::create_dir_all(old.join("recovery")).unwrap();
        std::fs::create_dir_all(old.join("EBWebView/Default/Local Storage")).unwrap();
        std::fs::write(old.join("recovery/queue.json"), "[1]").unwrap();
        std::fs::write(
            old.join("EBWebView/Default/Local Storage/leveldb.log"),
            "queue",
        )
        .unwrap();
        let rclone = old.join("rclone").join("rclone");
        let prefs = serde_json::json!({
            "rclonePath": rclone.to_string_lossy(),
            "serviceAccountFolderPath": "/somewhere/else",
            "maxConcurrentUploads": 3,
        });
        std::fs::write(old.join("preferences.json"), prefs.to_string()).unwrap();

        let report = migrate(&old, &new).expect("migrated");
        assert!(report.contains("carried"), "{report}");

        assert_eq!(
            std::fs::read_to_string(new.join("recovery/queue.json")).unwrap(),
            "[1]"
        );
        assert!(new
            .join("EBWebView/Default/Local Storage/leveldb.log")
            .exists());
        let moved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(new.join("preferences.json")).unwrap())
                .unwrap();
        assert_eq!(
            moved["rclonePath"],
            new.join("rclone").join("rclone").to_string_lossy().as_ref()
        );
        assert_eq!(moved["serviceAccountFolderPath"], "/somewhere/else");
        assert_eq!(moved["maxConcurrentUploads"], 3);
        // the old folder stays for an older copy of the app, and as a backup
        assert!(old.join("preferences.json").exists());
        assert!(!base.join(format!("{IDENTIFIER}.migrating")).exists());

        // only once: the new folder exists now
        assert_eq!(migrate(&old, &new), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn never_touches_an_existing_new_folder() {
        let base = temp_base("existing");
        let (old, new) = (base.join(OLD_IDENTIFIER), base.join(IDENTIFIER));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("preferences.json"), "{\"a\":1}").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("preferences.json"), "{\"a\":2}").unwrap();

        assert_eq!(migrate(&old, &new), None);
        assert_eq!(
            std::fs::read_to_string(new.join("preferences.json")).unwrap(),
            "{\"a\":2}"
        );
        // nothing to carry over on a fresh install either
        assert_eq!(migrate(&base.join("missing"), &base.join("other")), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_interrupted_copy_is_redone() {
        let base = temp_base("staging");
        let (old, new) = (base.join(OLD_IDENTIFIER), base.join(IDENTIFIER));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("preferences.json"), "{}").unwrap();
        // what a crash mid-copy leaves behind
        let staging = base.join(format!("{IDENTIFIER}.migrating"));
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("half.tmp"), "x").unwrap();

        assert!(migrate(&old, &new).unwrap().contains("carried"));
        assert!(new.join("preferences.json").exists());
        assert!(!new.join("half.tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
