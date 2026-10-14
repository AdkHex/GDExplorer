//! Tauri side of the remote switch and access password: which URL to poll,
//! the OS credential store, the commands the lock screen uses, and the notice
//! about an old all-users install on Windows. The logic lives in
//! `remote_status`. See docs/REMOTE-STATUS.md.
//!
//! The URL and `requireAccess` are compiled in from `src-tauri/remote-status.json`
//! (`{"url": ""}` turns the switch off), so an installed copy cannot be pointed
//! elsewhere. Debug builds also read `GDEXPLORER_STATUS_URL` (http:// allowed
//! for 127.0.0.1 / localhost) and `GDEXPLORER_STATUS_POLL_SECS` for testing.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote_status::{
    validate_url, AccessStore, FileBackedAccess, ServiceConfig, ServiceCore, ServiceLock,
    LOCKED_ERROR, THROTTLE,
};

const BAKED: &str = include_str!("../remote-status.json");

/// Emitted with a `ServiceLock` whenever the state changes.
pub const EVENT: &str = "service-lock-changed";

/// Credential store entry: service = bundle identifier, account = this.
const KEYRING_ACCOUNT: &str = "access";

/// The same id, kept in the app data folder. See `KeyringAccess`.
const ACCESS_FILE: &str = "access-id";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Baked {
    url: String,
    require_access: bool,
}

/// build.rs has already rejected a malformed file, so this cannot fail in a
/// build that compiled.
fn baked() -> Baked {
    serde_json::from_str(BAKED).unwrap_or_else(|e| {
        log::error!("remote-status.json: {e}");
        Baked::default()
    })
}

/// The status URL this build polls, if the switch is on.
fn status_url(baked: &Baked) -> Option<String> {
    if cfg!(debug_assertions) {
        if let Some(u) = std::env::var("GDEXPLORER_STATUS_URL")
            .ok()
            .filter(|u| !u.trim().is_empty())
        {
            return match validate_url(&u, true) {
                Ok(u) => Some(u),
                Err(e) => {
                    log::error!("GDEXPLORER_STATUS_URL ignored: {e}");
                    None
                }
            };
        }
    }
    let url = baked.url.trim();
    if url.is_empty() {
        return None;
    }
    match validate_url(url, false) {
        Ok(u) => Some(u),
        Err(e) => {
            log::error!("remote-status.json: {e}");
            None
        }
    }
}

fn poll_override() -> Option<Duration> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("GDEXPLORER_STATUS_POLL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join(&app.config().identifier))
}

/// Windows Credential Manager / macOS Keychain, both per OS user.
///
/// Not always usable on its own: Windows servers commonly enable "Network
/// access: Do not allow storage of passwords and credentials for network
/// authentication", under which Credential Manager refuses the entry, and the
/// password was then asked on every start. So `init` backs it with a file in
/// the user's app data folder (`FileBackedAccess`). What is kept is the access
/// id, which is derived from the public gist, so the file holds nothing
/// secret; like the credential store it lives in the user's own profile.
struct KeyringAccess {
    service: String,
}

impl AccessStore for KeyringAccess {
    fn load(&self) -> Vec<String> {
        match keyring::Entry::new(&self.service, KEYRING_ACCOUNT).and_then(|e| e.get_password()) {
            Ok(id) => vec![id],
            Err(keyring::Error::NoEntry) => Vec::new(),
            Err(e) => {
                log::warn!("access: cannot read the credential store: {e}");
                Vec::new()
            }
        }
    }

    fn save(&self, id: &str) -> Result<(), String> {
        keyring::Entry::new(&self.service, KEYRING_ACCOUNT)
            .and_then(|e| e.set_password(id))
            .map_err(|e| format!("credential store refused the entry: {e}"))
    }
}

/// Builds the switch from the baked config and the stored document, before the
/// window can ask for anything, and starts polling in the background.
pub fn init(app: &AppHandle) -> Arc<ServiceCore> {
    let baked = baked();
    let url = status_url(&baked);
    let core = ServiceCore::new(
        ServiceConfig {
            url,
            require_access: baked.require_access,
            app_version: app.package_info().version.to_string(),
            state_file: data_dir(app).join("service-status.json"),
            poll_every: poll_override(),
            throttle: THROTTLE,
        },
        Box::new(FileBackedAccess {
            primary: KeyringAccess {
                service: app.config().identifier.clone(),
            },
            file: data_dir(app).join(ACCESS_FILE),
        }),
    );

    let handle = app.clone();
    core.on_change(move |state, engaged| {
        let _ = handle.emit(EVENT, state);
        // Someone with the window hidden in the tray should see why their
        // uploads stopped.
        if engaged {
            crate::tray::show_main_window(&handle);
        }
    });

    if core.enabled() {
        tauri::async_runtime::spawn(core.clone().run());
    } else {
        log::info!("remote status: no status URL in this build; switch off");
    }
    core
}

/// The guard for commands that do work: refuses with "GDrive-Upload is paused:
/// work is in progress" or "GDrive-Upload is locked".
pub fn ensure_unlocked(app: &AppHandle) -> Result<(), String> {
    match app.try_state::<Arc<ServiceCore>>() {
        Some(core) => core.ensure_unlocked(),
        // Only possible before setup has run, when nothing may start either.
        None => Err(LOCKED_ERROR.to_string()),
    }
}

#[tauri::command]
pub fn service_lock(core: State<'_, Arc<ServiceCore>>) -> ServiceLock {
    core.state()
}

/// "Check again" / "Try again" on the lock screen: fetch now.
#[tauri::command]
pub async fn check_service_status(
    core: State<'_, Arc<ServiceCore>>,
) -> Result<ServiceLock, String> {
    let core = core.inner().clone();
    Ok(core.check_now().await)
}

/// The password screen's Unlock button.
#[tauri::command]
pub async fn unlock_access(
    core: State<'_, Arc<ServiceCore>>,
    password: String,
) -> Result<ServiceLock, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.unlock(&password))
        .await
        .map_err(|e| format!("Could not check the password: {e}"))?
}

// ------------------------------------------------------------------ old all-users install (Windows)

const NOTICE_DISMISSED: &str = "all-users-notice-dismissed";

/// Where an all-users copy of the app is installed, if there is one. The
/// installer now installs per user and cannot remove it without admin rights,
/// so the user is told once. See docs/REMOTE-STATUS.md.
#[cfg(windows)]
fn all_users_install() -> Option<String> {
    use crate::remote_status::APP_NAME;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let Ok(root) = hklm.open_subkey_with_flags(UNINSTALL, KEY_READ | view) else {
            continue;
        };
        for name in root.enum_keys().flatten() {
            let Ok(entry) = root.open_subkey_with_flags(&name, KEY_READ | view) else {
                continue;
            };
            let display: String = entry.get_value("DisplayName").unwrap_or_default();
            if display.trim().eq_ignore_ascii_case(APP_NAME) {
                let location: String = entry.get_value("InstallLocation").unwrap_or_default();
                let location = location.trim().trim_end_matches('\\').to_string();
                return Some(if location.is_empty() {
                    format!("Program Files ({name})")
                } else {
                    location
                });
            }
        }
    }
    for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(var) {
            let dir = std::path::Path::new(&base).join(APP_NAME);
            if dir.is_dir() {
                return Some(dir.display().to_string());
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn all_users_install() -> Option<String> {
    None
}

/// Where the old all-users copy is, unless the notice was already shown.
#[tauri::command]
pub async fn all_users_install_notice(app: AppHandle) -> Option<String> {
    if data_dir(&app).join(NOTICE_DISMISSED).exists() {
        return None;
    }
    tauri::async_runtime::spawn_blocking(all_users_install)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub fn dismiss_all_users_install_notice(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(NOTICE_DISMISSED), b"1").map_err(|e| e.to_string())
}
