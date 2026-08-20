//! Getting rclone onto the machine and configured.
//!
//! This used to be Windows-only, which left macOS and Linux users to install
//! rclone themselves with no guidance - and even then a GUI app launched from
//! Finder has a minimal `PATH`, so a Homebrew rclone is not found by name.
//! Detection covers that case; the installer covers the rest.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::upload::rclone::build_rclone_command;

/// Name of the binary on this platform.
const RCLONE_BINARY: &str = if cfg!(windows) {
    "rclone.exe"
} else {
    "rclone"
};

/// Where the app's own copy of rclone lives, if it has been installed.
fn managed_install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    Ok(app_data_dir.join("rclone"))
}

/// The archive rclone publishes for this platform.
fn download_url() -> Result<&'static str, String> {
    let url = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "https://downloads.rclone.org/rclone-current-windows-amd64.zip",
        ("windows", "aarch64") => "https://downloads.rclone.org/rclone-current-windows-arm64.zip",
        ("macos", "x86_64") => "https://downloads.rclone.org/rclone-current-osx-amd64.zip",
        ("macos", "aarch64") => "https://downloads.rclone.org/rclone-current-osx-arm64.zip",
        ("linux", "x86_64") => "https://downloads.rclone.org/rclone-current-linux-amd64.zip",
        ("linux", "aarch64") => "https://downloads.rclone.org/rclone-current-linux-arm64.zip",
        (os, arch) => {
            return Err(format!(
                "No rclone download is available for {os}/{arch}. Install it from https://rclone.org/downloads/ and set the path in Preferences."
            ))
        }
    };
    Ok(url)
}

/// Downloads rclone and returns the path to the extracted binary.
#[tauri::command]
pub async fn install_rclone(app: AppHandle) -> Result<String, String> {
    let url = download_url()?;
    let install_dir = managed_install_dir(&app)?;
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create rclone directory: {e}"))?;

    log::info!("Downloading rclone from {url}");
    let zip_path = install_dir.join("rclone.zip");
    let bytes = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download rclone: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read rclone download: {e}"))?;

    let mut zip_file =
        File::create(&zip_path).map_err(|e| format!("Failed to create rclone zip file: {e}"))?;
    zip_file
        .write_all(&bytes)
        .map_err(|e| format!("Failed to write rclone zip file: {e}"))?;

    let file = File::open(&zip_path).map_err(|e| format!("Failed to open zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let outpath = install_dir.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {e}"))?;
            }
            let mut outfile =
                File::create(&outpath).map_err(|e| format!("Failed to write file: {e}"))?;
            let mut buffer = Vec::new();
            entry
                .read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read zip entry: {e}"))?;
            outfile
                .write_all(&buffer)
                .map_err(|e| format!("Failed to write zip entry: {e}"))?;
        }
    }

    // The zip is only a staging file; leaving ~20 MB behind on every install
    // adds up.
    let _ = std::fs::remove_file(&zip_path);

    let rclone_binary = find_rclone_binary(&install_dir)
        .ok_or_else(|| format!("Failed to locate {RCLONE_BINARY} after extraction."))?;

    // Zip archives from rclone do carry a unix mode, but the extraction above
    // writes plain files - without this the binary cannot be executed.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&rclone_binary, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to make rclone executable: {e}"))?;
    }

    log::info!("rclone installed at {rclone_binary:?}");
    Ok(rclone_binary.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRclone {
    pub path: String,
    /// First line of `rclone version`, e.g. "rclone v1.68.1".
    pub version: String,
}

/// Finds a usable rclone without making the user hunt for it.
///
/// Order matters: the app's own copy first (it is the one this app installed),
/// then the bare name for anything already on `PATH`, then the places package
/// managers put it. A GUI app on macOS inherits a minimal `PATH`, so a Homebrew
/// install is invisible by name and only the explicit paths find it.
#[tauri::command]
pub async fn detect_rclone(app: AppHandle) -> Result<Option<DetectedRclone>, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = managed_install_dir(&app) {
        if let Some(path) = find_rclone_binary(&dir) {
            candidates.push(path);
        }
    }

    candidates.push(PathBuf::from(RCLONE_BINARY));

    #[cfg(windows)]
    {
        for base in [
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("Programs")),
            std::env::var_os("USERPROFILE").map(|v| PathBuf::from(v).join("scoop\\shims")),
            Some(PathBuf::from("C:\\ProgramData\\chocolatey\\bin")),
        ]
        .into_iter()
        .flatten()
        {
            candidates.push(base.join("rclone").join(RCLONE_BINARY));
            candidates.push(base.join(RCLONE_BINARY));
        }
    }

    #[cfg(unix)]
    {
        for dir in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/snap/bin",
        ] {
            candidates.push(PathBuf::from(dir).join(RCLONE_BINARY));
        }
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join(".local/bin").join(RCLONE_BINARY));
        }
    }

    for candidate in candidates {
        let path = candidate.to_string_lossy().to_string();
        if let Some(version) = probe_rclone(&path).await {
            log::info!("Detected rclone at {path}");
            return Ok(Some(DetectedRclone { path, version }));
        }
    }

    Ok(None)
}

/// Runs `<path> version`, returning the version line when the binary works.
async fn probe_rclone(path: &str) -> Option<String> {
    let args = vec!["version".to_string()];
    let mut command = build_rclone_command(path, &args);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .ok()?
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(stdout.lines().next().unwrap_or("rclone").trim().to_string())
}

/// Creates (or updates) the rclone remote this app uploads through.
///
/// The remote has to exist even though every transfer passes an explicit
/// `--drive-service-account-file`: rclone resolves `remote:` from its own
/// config first.
#[tauri::command]
pub async fn configure_rclone_remote(
    rclone_path: String,
    remote_name: String,
    service_account_folder: String,
) -> Result<(), String> {
    let service_account_file = pick_service_account_file(&service_account_folder)?
        .to_string_lossy()
        .to_string();

    let create_args = vec![
        "config".to_string(),
        "create".to_string(),
        remote_name.clone(),
        "drive".to_string(),
        "service_account_file".to_string(),
        service_account_file.clone(),
        "scope".to_string(),
        "drive".to_string(),
        "--non-interactive".to_string(),
    ];

    let created = run_config_command(&rclone_path, &create_args).await?;
    if created.status.success() {
        return Ok(());
    }

    // `config create` fails when the remote already exists, which is the
    // common case on a second run - point it at the current credentials.
    let update_args = vec![
        "config".to_string(),
        "update".to_string(),
        remote_name,
        "service_account_file".to_string(),
        service_account_file,
        "--non-interactive".to_string(),
    ];

    let updated = run_config_command(&rclone_path, &update_args).await?;
    if updated.status.success() {
        return Ok(());
    }

    let detail = crate::upload::rclone::describe_command_failure(&updated);
    Err(if detail.is_empty() {
        "Failed to configure rclone remote.".to_string()
    } else {
        format!("Failed to configure rclone remote: {detail}")
    })
}

async fn run_config_command(
    rclone_path: &str,
    args: &[String],
) -> Result<std::process::Output, String> {
    let mut command = build_rclone_command(rclone_path, args);
    tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "rclone config did not finish in time.".to_string())?
        .map_err(|e| format!("Failed to run rclone: {e}"))
}

fn pick_service_account_file(folder: &str) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|e| format!("Failed to read service account folder: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read folder entry: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_json {
            continue;
        }
        return Ok(path);
    }

    Err("No service account JSON files found in the selected folder.".to_string())
}

fn find_rclone_binary(root: &Path) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().eq_ignore_ascii_case(RCLONE_BINARY) {
            return Some(entry.into_path());
        }
    }
    None
}
