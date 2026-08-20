use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

mod rclone_tools;
mod upload;

use upload::events::ItemStatusEvent;
#[derive(Default)]
struct UploadControlState(tokio::sync::Mutex<Option<UploadControl>>);

#[derive(Clone)]
struct UploadControl {
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pause_tx: tokio::sync::watch::Sender<bool>,
    paused_items_tx: tokio::sync::watch::Sender<HashSet<String>>,
    /// Items are pushed here rather than handed to the job as a fixed list, so
    /// a running upload can be extended instead of cancelled and restarted.
    queue_tx: tokio::sync::mpsc::UnboundedSender<upload::scheduler::QueueItemInput>,
    tallies: std::sync::Arc<upload::scheduler::JobTallies>,
}

impl UploadControl {
    fn new() -> (
        Self,
        tokio::sync::mpsc::UnboundedReceiver<upload::scheduler::QueueItemInput>,
    ) {
        let (pause_tx, _pause_rx) = tokio::sync::watch::channel(false);
        let (paused_items_tx, _paused_items_rx) = tokio::sync::watch::channel(HashSet::new());
        let (queue_tx, queue_rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                pause_tx,
                paused_items_tx,
                queue_tx,
                tallies: std::sync::Arc::new(upload::scheduler::JobTallies::default()),
            },
            queue_rx,
        )
    }

    fn cancel(&self) {
        self.cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Ensure any paused workers can wake up and observe cancellation.
        let _ = self.pause_tx.send(false);
    }

    fn is_canceled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// True while the worker pool is still reading from the queue.
    fn accepts_items(&self) -> bool {
        !self.is_canceled() && !self.queue_tx.is_closed()
    }

    fn set_paused(&self, paused: bool) {
        let _ = self.pause_tx.send(paused);
    }

    fn set_items_paused(&self, item_ids: &[String], paused: bool) {
        if item_ids.is_empty() {
            return;
        }
        let mut next = self.paused_items_tx.borrow().clone();
        if paused {
            for id in item_ids {
                next.insert(id.clone());
            }
        } else {
            for id in item_ids {
                next.remove(id);
            }
        }
        let _ = self.paused_items_tx.send(next);
    }

    /// Accept items onto the queue, marking each as preparing so the row does
    /// not sit on its previous state until a worker picks it up.
    fn enqueue(
        &self,
        app: &AppHandle,
        items: Vec<upload::scheduler::QueueItemInput>,
    ) -> Result<(), String> {
        for item in items {
            log::debug!(
                target: "rclone",
                "queue.enqueued id={} kind={} path={} dest={}",
                item.id,
                item.kind,
                item.path,
                item.destination_folder_id
            );
            self.tallies.record_enqueued();
            let _ = app.emit(
                "upload:item_status",
                ItemStatusEvent {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    status: "preparing".to_string(),
                    message: None,
                    sa_email: None,
                },
            );
            self.queue_tx
                .send(item)
                .map_err(|e| format!("Failed to enqueue upload task: {e}"))?;
        }
        Ok(())
    }

    fn handle(&self) -> upload::scheduler::UploadControlHandle {
        upload::scheduler::UploadControlHandle {
            cancel: self.cancel.clone(),
            pause_rx: self.pause_tx.subscribe(),
            paused_items_rx: self.paused_items_tx.subscribe(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LocalPathKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClassifiedPath {
    path: String,
    kind: LocalPathKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileListEntry {
    file_path: String,
    total_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartUploadArgs {
    queue_items: Vec<upload::scheduler::QueueItemInput>,
    destination_folder_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PauseItemsArgs {
    item_ids: Vec<String>,
    paused: bool,
}

#[tauri::command]
async fn start_upload(
    window: tauri::Window,
    state: State<'_, UploadControlState>,
    args: StartUploadArgs,
) -> Result<(), String> {
    let app = window.app_handle();
    let preferences = load_preferences(app.clone()).await?;

    let service_account_folder = preferences
        .service_account_folder_path
        .clone()
        .ok_or_else(|| "Service Account folder path is not set in Preferences.".to_string())?;

    let max_concurrent = preferences.max_concurrent_uploads;

    // Each item carries its own destination so one run can fan out to several
    // Drive folders. Anything that arrives without one falls back to the
    // job-level destination the sidebar supplies.
    let fallback_destination = args.destination_folder_id.trim().to_string();
    let mut queue_items = args.queue_items;
    for item in &mut queue_items {
        if item.destination_folder_id.trim().is_empty() {
            item.destination_folder_id = fallback_destination.clone();
        }
    }
    if let Some(missing) = queue_items
        .iter()
        .find(|item| item.destination_folder_id.trim().is_empty())
    {
        return Err(format!("No destination folder set for {}", missing.path));
    }

    // Appending to a job that is already running is the whole point of keeping
    // the queue in the control handle: starting a second batch used to cancel
    // the first one.
    {
        let guard = state.0.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.accepts_items() {
                log::debug!(
                    target: "rclone",
                    "queue.appended_to_running_job items={}",
                    queue_items.len()
                );
                return existing.enqueue(app, queue_items);
            }
        }
    }

    // No live job, so start one. Any stale handle is cancelled first.
    let (control, queue_rx) = UploadControl::new();
    let control_handle = control.handle();
    let tallies = control.tallies.clone();
    {
        let mut guard = state.0.lock().await;
        if let Some(existing) = guard.take() {
            existing.cancel();
        }
        *guard = Some(control.clone());
    }

    control.enqueue(app, queue_items)?;

    let app_for_task = app.clone();
    tokio::spawn(async move {
        let prefs = upload::rclone::RclonePreferences {
            rclone_path: preferences.rclone_path,
            remote_name: preferences.rclone_remote_name,
            drive_chunk_size_mib: preferences.upload_chunk_size_mib,
            transfers: preferences.rclone_transfers,
            checkers: preferences.rclone_checkers,
            retries: preferences.rclone_retries,
            bandwidth_limit: preferences.rclone_bandwidth_limit,
            exclude_patterns: preferences.rclone_exclude_patterns,
        };

        let result = upload::rclone::run_rclone_job(
            app_for_task.clone(),
            control_handle,
            prefs,
            max_concurrent,
            service_account_folder,
            queue_rx,
            tallies,
        )
        .await;

        if let Err(e) = result {
            log::error!("Upload job failed: {e}");
        }

        // The pool has stopped, so this handle can no longer accept items.
        // Clearing it lets the next Start build a fresh job instead of pushing
        // into a queue nobody is reading.
        let state = app_for_task.state::<UploadControlState>();
        let mut guard = state.0.lock().await;
        if guard.as_ref().is_some_and(|c| !c.accepts_items()) {
            *guard = None;
        }
    });

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyDestinationArgs {
    destination_folder_id: String,
}

#[tauri::command]
async fn verify_destination(app: AppHandle, args: VerifyDestinationArgs) -> Result<(), String> {
    let preferences = load_preferences(app).await?;
    let service_account_folder = preferences
        .service_account_folder_path
        .clone()
        .ok_or_else(|| "Service Account folder path is not set in Preferences.".to_string())?;

    let prefs = upload::rclone::RclonePreferences {
        rclone_path: preferences.rclone_path,
        remote_name: preferences.rclone_remote_name,
        drive_chunk_size_mib: preferences.upload_chunk_size_mib,
        transfers: preferences.rclone_transfers,
        checkers: preferences.rclone_checkers,
        retries: preferences.rclone_retries,
        bandwidth_limit: preferences.rclone_bandwidth_limit,
        exclude_patterns: preferences.rclone_exclude_patterns,
    };

    upload::rclone::verify_destination(&prefs, &service_account_folder, &args.destination_folder_id)
        .await
}

#[tauri::command]
async fn pause_upload(state: State<'_, UploadControlState>, paused: bool) -> Result<(), String> {
    let guard = state.0.lock().await;
    // Returning Ok() with no control handle let the UI paint rows as paused
    // while rclone kept running. Report it instead so the caller can react.
    let Some(control) = guard.as_ref() else {
        return Err("No upload is running".to_string());
    };
    control.set_paused(paused);
    Ok(())
}

#[tauri::command]
async fn pause_items(
    state: State<'_, UploadControlState>,
    args: PauseItemsArgs,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    let Some(control) = guard.as_ref() else {
        return Err("No upload is running".to_string());
    };
    log::debug!(
        target: "rclone",
        "upload.pause_request ids={:?} paused={}",
        args.item_ids,
        args.paused
    );
    control.set_items_paused(&args.item_ids, args.paused);
    Ok(())
}

#[tauri::command]
async fn cancel_upload(state: State<'_, UploadControlState>) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(control) = guard.take() {
        control.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn list_item_files(path: String, kind: LocalPathKind) -> Result<Vec<FileListEntry>, String> {
    let mut files = Vec::new();
    let path_buf = PathBuf::from(&path);

    match kind {
        LocalPathKind::File => {
            let metadata =
                std::fs::metadata(&path_buf).map_err(|e| format!("Failed to stat file: {e}"))?;
            files.push(FileListEntry {
                file_path: path_buf.to_string_lossy().to_string(),
                total_bytes: metadata.len(),
            });
        }
        LocalPathKind::Folder => {
            for entry in walkdir::WalkDir::new(&path_buf)
                .into_iter()
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let file_path = entry.path().to_path_buf();
                // Skip files we cannot stat (broken symlinks, permission
                // denied) instead of failing the whole listing.
                let Ok(metadata) = std::fs::metadata(&file_path) else {
                    log::warn!("Skipping unreadable file while listing: {file_path:?}");
                    continue;
                };
                files.push(FileListEntry {
                    file_path: file_path.to_string_lossy().to_string(),
                    total_bytes: metadata.len(),
                });
            }
        }
    }

    files.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    Ok(files)
}
// Validation functions
fn validate_filename(filename: &str) -> Result<(), String> {
    // Regex pattern: only alphanumeric, dash, underscore, dot
    let filename_pattern = Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .map_err(|e| format!("Regex compilation error: {e}"))?;

    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.len() > 100 {
        return Err("Filename too long (max 100 characters)".to_string());
    }

    if !filename_pattern.is_match(filename) {
        return Err(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed"
                .to_string(),
        );
    }

    Ok(())
}

fn validate_string_input(input: &str, max_len: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_len {
        return Err(format!("{field_name} too long (max {max_len} characters)"));
    }
    Ok(())
}

fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err("Invalid theme: must be 'light', 'dark', or 'system'".to_string()),
    }
}

fn validate_max_concurrent_uploads(value: u8) -> Result<(), String> {
    if (1..=10).contains(&value) {
        Ok(())
    } else {
        Err("Invalid maximum concurrent uploads: must be between 1 and 10".to_string())
    }
}

fn validate_upload_chunk_size_mib(value: u32) -> Result<(), String> {
    // MiB, must be a multiple of 1 MiB; Drive requires chunk sizes aligned to 256KiB,
    // and any whole MiB satisfies that.
    if (1..=1024).contains(&value) {
        Ok(())
    } else {
        Err("Invalid upload chunk size: must be between 1 and 1024 MiB".to_string())
    }
}

fn validate_rclone_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Invalid rclone path: must not be empty".to_string());
    }
    validate_string_input(path, 512, "Rclone path")?;
    Ok(())
}

fn validate_rclone_remote_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Invalid rclone remote name: must not be empty".to_string());
    }
    validate_string_input(name, 64, "Rclone remote name")?;
    Ok(())
}

fn validate_rclone_transfers(value: u16) -> Result<(), String> {
    if (1..=64).contains(&value) {
        Ok(())
    } else {
        Err("Invalid rclone transfers: must be between 1 and 64".to_string())
    }
}

fn validate_rclone_checkers(value: u16) -> Result<(), String> {
    if (1..=64).contains(&value) {
        Ok(())
    } else {
        Err("Invalid rclone checkers: must be between 1 and 64".to_string())
    }
}

fn validate_rclone_retries(value: u16) -> Result<(), String> {
    if value <= 20 {
        Ok(())
    } else {
        Err("Invalid rclone retries: must be between 0 and 20".to_string())
    }
}

fn validate_rclone_bandwidth_limit(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    validate_string_input(trimmed, 32, "Rclone bandwidth limit")?;
    // Accept rclone size suffixes, e.g. "512k", "10M", "1.5G".
    let pattern = Regex::new(r"(?i)^\d+(\.\d+)?[bkmgt]?$")
        .map_err(|e| format!("Regex compilation error: {e}"))?;
    if !pattern.is_match(trimmed) {
        return Err(
            "Invalid bandwidth limit: use a number with an optional B/K/M/G/T suffix, e.g. 10M"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_rclone_exclude_patterns(patterns: &[String]) -> Result<(), String> {
    if patterns.len() > 50 {
        return Err("Too many exclude patterns (max 50).".to_string());
    }
    for pattern in patterns {
        if pattern.trim().is_empty() {
            return Err("Exclude patterns cannot be empty.".to_string());
        }
        validate_string_input(pattern, 256, "Exclude pattern")?;
    }
    Ok(())
}

fn validate_service_account_json_path(path: &Option<String>) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };

    validate_string_input(path, 1024, "Service account credentials folder path")?;
    Ok(())
}

fn validate_destination_presets(presets: &[DestinationPreset]) -> Result<(), String> {
    if presets.len() > 50 {
        return Err("Too many destination presets (max 50).".to_string());
    }
    for (i, p) in presets.iter().enumerate() {
        validate_string_input(&p.id, 64, "Destination preset id")?;
        validate_string_input(&p.name, 80, "Destination preset name")?;
        validate_string_input(&p.url, 1024, "Destination preset URL")?;
        if p.name.trim().is_empty() {
            return Err(format!(
                "Destination preset name cannot be empty (index {i})"
            ));
        }
        if p.url.trim().is_empty() {
            return Err(format!(
                "Destination preset URL cannot be empty (index {i})"
            ));
        }
    }
    Ok(())
}

// Preferences data structure
// Only contains settings that should be persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationPreset {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct AppPreferences {
    pub theme: String,
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(alias = "serviceAccountJsonPath")]
    pub service_account_folder_path: Option<String>,
    pub max_concurrent_uploads: u8,
    pub upload_chunk_size_mib: u32,
    #[serde(default = "default_rclone_path")]
    pub rclone_path: String,
    #[serde(default = "default_rclone_remote_name")]
    pub rclone_remote_name: String,
    #[serde(default = "default_rclone_transfers")]
    pub rclone_transfers: u16,
    #[serde(default = "default_rclone_checkers")]
    pub rclone_checkers: u16,
    #[serde(default = "default_rclone_retries")]
    pub rclone_retries: u16,
    /// rclone `--bwlimit` value, e.g. "10M". Empty means unlimited.
    #[serde(default)]
    pub rclone_bandwidth_limit: String,
    /// Glob patterns passed to rclone as `--exclude`.
    #[serde(default)]
    pub rclone_exclude_patterns: Vec<String>,
    pub destination_presets: Vec<DestinationPreset>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            auto_check_updates: true,
            service_account_folder_path: None,
            max_concurrent_uploads: 3,
            // Peak rclone memory is roughly
            //   max_concurrent_uploads * rclone_transfers * upload_chunk_size
            // so these three defaults are chosen together: 3 * 16 * 256 MiB is
            // about 12 GiB. Raise transfers for more throughput only if the
            // machine has the RAM for it.
            upload_chunk_size_mib: 256,
            rclone_path: "rclone".to_string(),
            rclone_remote_name: "gdrive".to_string(),
            rclone_transfers: 16,
            rclone_checkers: 16,
            rclone_retries: default_rclone_retries(),
            rclone_bandwidth_limit: String::new(),
            rclone_exclude_patterns: Vec::new(),
            destination_presets: Vec::new(),
        }
    }
}

fn default_rclone_retries() -> u16 {
    3
}

fn default_rclone_path() -> String {
    "rclone".to_string()
}

fn default_auto_check_updates() -> bool {
    true
}

fn default_rclone_remote_name() -> String {
    "gdrive".to_string()
}

fn default_rclone_transfers() -> u16 {
    16
}

fn default_rclone_checkers() -> u16 {
    16
}

fn get_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("preferences.json"))
}

#[tauri::command]
async fn load_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    log::debug!("Loading preferences from disk");
    let prefs_path = get_preferences_path(&app)?;

    if !prefs_path.exists() {
        log::info!("Preferences file not found, using defaults");
        return Ok(AppPreferences::default());
    }

    let contents = std::fs::read_to_string(&prefs_path).map_err(|e| {
        log::error!("Failed to read preferences file: {e}");
        format!("Failed to read preferences file: {e}")
    })?;

    let preferences: AppPreferences = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse preferences JSON: {e}");
        format!("Failed to parse preferences: {e}")
    })?;

    log::info!("Successfully loaded preferences");
    Ok(preferences)
}

#[tauri::command]
async fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    // Validate theme value
    validate_theme(&preferences.theme)?;
    validate_max_concurrent_uploads(preferences.max_concurrent_uploads)?;
    validate_upload_chunk_size_mib(preferences.upload_chunk_size_mib)?;
    validate_rclone_path(&preferences.rclone_path)?;
    validate_rclone_remote_name(&preferences.rclone_remote_name)?;
    validate_rclone_transfers(preferences.rclone_transfers)?;
    validate_rclone_checkers(preferences.rclone_checkers)?;
    validate_rclone_retries(preferences.rclone_retries)?;
    validate_rclone_bandwidth_limit(&preferences.rclone_bandwidth_limit)?;
    validate_rclone_exclude_patterns(&preferences.rclone_exclude_patterns)?;
    validate_service_account_json_path(&preferences.service_account_folder_path)?;
    validate_destination_presets(&preferences.destination_presets)?;

    log::debug!("Saving preferences to disk: {preferences:?}");
    let prefs_path = get_preferences_path(&app)?;

    let json_content = serde_json::to_string_pretty(&preferences).map_err(|e| {
        log::error!("Failed to serialize preferences: {e}");
        format!("Failed to serialize preferences: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = prefs_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write preferences file: {e}");
        format!("Failed to write preferences file: {e}")
    })?;

    std::fs::rename(&temp_path, &prefs_path).map_err(|e| {
        log::error!("Failed to finalize preferences file: {e}");
        format!("Failed to finalize preferences file: {e}")
    })?;

    log::info!("Successfully saved preferences to {prefs_path:?}");
    Ok(())
}

#[tauri::command]
async fn send_native_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    log::info!("Sending native notification: {title}");

    #[cfg(not(mobile))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut notification = app.notification().builder().title(title);

        if let Some(body_text) = body {
            notification = notification.body(body_text);
        }

        match notification.show() {
            Ok(_) => {
                log::info!("Native notification sent successfully");
                Ok(())
            }
            Err(e) => {
                log::error!("Failed to send native notification: {e}");
                Err(format!("Failed to send notification: {e}"))
            }
        }
    }

    #[cfg(mobile)]
    {
        log::warn!("Native notifications not supported on mobile");
        Err("Native notifications not supported on mobile".to_string())
    }
}

// Recovery functions - simple pattern for saving JSON data to disk
fn get_recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let recovery_dir = app_data_dir.join("recovery");

    // Ensure the recovery directory exists
    std::fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("Failed to create recovery directory: {e}"))?;

    Ok(recovery_dir)
}

#[tauri::command]
async fn save_emergency_data(app: AppHandle, filename: String, data: Value) -> Result<(), String> {
    log::info!("Saving emergency data to file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    // Validate data size (10MB limit)
    let data_str = serde_json::to_string(&data)
        .map_err(|e| format!("Failed to serialize data for size check: {e}"))?;
    if data_str.len() > 10_485_760 {
        return Err("Data too large (max 10MB)".to_string());
    }

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    let json_content = serde_json::to_string_pretty(&data).map_err(|e| {
        log::error!("Failed to serialize emergency data: {e}");
        format!("Failed to serialize data: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = file_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write emergency data file: {e}");
        format!("Failed to write data file: {e}")
    })?;

    std::fs::rename(&temp_path, &file_path).map_err(|e| {
        log::error!("Failed to finalize emergency data file: {e}");
        format!("Failed to finalize data file: {e}")
    })?;

    log::info!("Successfully saved emergency data to {file_path:?}");
    Ok(())
}

#[tauri::command]
async fn load_emergency_data(app: AppHandle, filename: String) -> Result<Value, String> {
    log::info!("Loading emergency data from file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    if !file_path.exists() {
        log::info!("Recovery file not found: {file_path:?}");
        return Err("File not found".to_string());
    }

    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        log::error!("Failed to read recovery file: {e}");
        format!("Failed to read file: {e}")
    })?;

    let data: Value = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse recovery JSON: {e}");
        format!("Failed to parse data: {e}")
    })?;

    log::info!("Successfully loaded emergency data");
    Ok(data)
}

#[tauri::command]
async fn cleanup_old_recovery_files(app: AppHandle) -> Result<u32, String> {
    log::info!("Cleaning up old recovery files");

    let recovery_dir = get_recovery_dir(&app)?;
    let mut removed_count = 0;

    // Calculate cutoff time (7 days ago)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get current time: {e}"))?
        .as_secs();
    let seven_days_ago = now - (7 * 24 * 60 * 60);

    // Read directory and check each file
    let entries = std::fs::read_dir(&recovery_dir).map_err(|e| {
        log::error!("Failed to read recovery directory: {e}");
        format!("Failed to read directory: {e}")
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Only process JSON files
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }

        // Check file modification time
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file metadata: {e}");
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file modification time: {e}");
                continue;
            }
        };

        let modified_secs = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(e) => {
                log::warn!("Failed to convert modification time: {e}");
                continue;
            }
        };

        // Remove if older than 7 days
        if modified_secs < seven_days_ago {
            match std::fs::remove_file(&path) {
                Ok(_) => {
                    log::info!("Removed old recovery file: {path:?}");
                    removed_count += 1;
                }
                Err(e) => {
                    log::warn!("Failed to remove old recovery file: {e}");
                }
            }
        }
    }

    log::info!("Cleanup complete. Removed {removed_count} old recovery files");
    Ok(removed_count)
}

#[tauri::command]
async fn classify_paths(paths: Vec<String>) -> Vec<ClassifiedPath> {
    paths
        .into_iter()
        .map(|path| {
            let kind = match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_dir() => LocalPathKind::Folder,
                Ok(_) => LocalPathKind::File,
                Err(e) => {
                    log::warn!("Failed to classify path {path:?}: {e}");
                    LocalPathKind::File
                }
            };

            ClassifiedPath { path, kind }
        })
        .collect()
}

// Create the native menu system
fn create_app_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Setting up native menu system");

    // Build the main application submenu
    let app_submenu = SubmenuBuilder::new(app, "GDExplorer")
        .item(&MenuItemBuilder::with_id("about", "About GDExplorer").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide GDExplorer"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit GDExplorer"))?)
        .build()?;

    // Build the View submenu
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .build()?;

    #[cfg(target_os = "macos")]
    let mut menu_builder = MenuBuilder::new(app).item(&app_submenu);
    #[cfg(not(target_os = "macos"))]
    let menu_builder = MenuBuilder::new(app).item(&app_submenu);

    #[cfg(target_os = "macos")]
    {
        // Build the Edit submenu to enable standard shortcuts (copy/paste/select all)
        let edit_submenu = SubmenuBuilder::new(app, "Edit")
            .item(&PredefinedMenuItem::undo(app, None)?)
            .item(&PredefinedMenuItem::redo(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::cut(app, None)?)
            .item(&PredefinedMenuItem::copy(app, None)?)
            .item(&PredefinedMenuItem::paste(app, None)?)
            .item(&PredefinedMenuItem::select_all(app, None)?)
            .build()?;
        menu_builder = menu_builder.item(&edit_submenu);
    }

    // Build the main menu with submenus
    let menu = menu_builder.item(&view_submenu).build()?;

    // Set the menu for the app
    app.set_menu(menu)?;

    log::info!("Native menu system initialized successfully");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UploadControlState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Use Debug level in development, Info in production
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .targets([
                    // Always log to stdout for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // Log to webview console for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    // Log to system logs on macOS (appears in Console.app)
                    #[cfg(target_os = "macos")]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            log::info!("🚀 Application starting up");
            log::debug!(
                "App handle initialized for package: {}",
                app.package_info().name
            );

            // Set up native menu system
            if let Err(e) = create_app_menu(app) {
                log::error!("Failed to create app menu: {e}");
                return Err(e);
            }

            // Set up menu event handlers
            app.on_menu_event(move |app, event| {
                log::debug!("Menu event received: {:?}", event.id());

                match event.id().as_ref() {
                    "about" => {
                        log::info!("About menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-about", ()) {
                            Ok(_) => log::debug!("Successfully emitted menu-about event"),
                            Err(e) => log::error!("Failed to emit menu-about event: {e}"),
                        }
                    }
                    "check-updates" => {
                        log::info!("Check for Updates menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-check-updates", ()) {
                            Ok(_) => log::debug!("Successfully emitted menu-check-updates event"),
                            Err(e) => log::error!("Failed to emit menu-check-updates event: {e}"),
                        }
                    }
                    "preferences" => {
                        log::info!("Preferences menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-preferences", ()) {
                            Ok(_) => log::debug!("Successfully emitted menu-preferences event"),
                            Err(e) => log::error!("Failed to emit menu-preferences event: {e}"),
                        }
                    }
                    "toggle-left-sidebar" => {
                        log::info!("Toggle Left Sidebar menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-toggle-left-sidebar", ()) {
                            Ok(_) => {
                                log::debug!("Successfully emitted menu-toggle-left-sidebar event")
                            }
                            Err(e) => {
                                log::error!("Failed to emit menu-toggle-left-sidebar event: {e}")
                            }
                        }
                    }
                    _ => {
                        log::debug!("Unhandled menu event: {:?}", event.id());
                    }
                }
            });

            // Example of different log levels
            log::trace!("This is a trace message (most verbose)");
            log::debug!("This is a debug message (development only)");
            log::info!("This is an info message (production)");
            log::warn!("This is a warning message");
            // log::error!("This is an error message");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_preferences,
            save_preferences,
            send_native_notification,
            save_emergency_data,
            load_emergency_data,
            cleanup_old_recovery_files,
            classify_paths,
            start_upload,
            verify_destination,
            pause_upload,
            pause_items,
            cancel_upload,
            list_item_files,
            rclone_tools::install_rclone_windows,
            rclone_tools::configure_rclone_remote
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
