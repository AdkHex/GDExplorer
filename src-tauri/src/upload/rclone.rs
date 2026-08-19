use crate::upload::events::{
    CompletedEvent, FileListEntry, FileListEvent, FileProgressEvent, ItemStatusEvent,
    ProgressEvent, Summary,
};
use crate::upload::scheduler::{wait_if_paused, QueueItemInput, UploadControlHandle, CANCELED};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex};
use walkdir::WalkDir;

#[derive(Clone, Debug)]
pub struct RclonePreferences {
    pub rclone_path: String,
    pub remote_name: String,
    pub drive_chunk_size_mib: u32,
    pub transfers: u16,
    pub checkers: u16,
    pub retries: u16,
    /// `--bwlimit` value; empty means unlimited.
    pub bandwidth_limit: String,
    /// Glob patterns passed as repeated `--exclude` flags.
    pub exclude_patterns: Vec<String>,
}

#[derive(Clone, Debug)]
struct ServiceAccountFile {
    path: PathBuf,
    email: Option<String>,
    last_used: u64,
}

/// Why the rclone child process is being stopped early.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StopReason {
    None,
    Cancel,
    /// Windows only: pause is implemented by stopping rclone and re-running it
    /// on resume, because there is no portable SIGSTOP equivalent.
    PauseRestart,
}

/// Internal sentinel error meaning "this item was paused, run it again once it
/// is resumed". Never surfaced to the UI.
const PAUSE_RESTART: &str = "__gdexplorer_pause_restart__";

/// Keep the failure message useful without letting a pathological log line blow
/// up the UI tooltip.
const MAX_ERROR_DETAIL: usize = 600;

pub async fn run_rclone_job(
    app: AppHandle,
    control: UploadControlHandle,
    prefs: RclonePreferences,
    max_concurrent: u8,
    service_account_folder: String,
    queue: Vec<QueueItemInput>,
    destination_folder_id: String,
) -> Result<(), String> {
    log::debug!(
        target: "rclone",
        "queue.received items={} max_concurrent={}",
        queue.len(),
        max_concurrent
    );
    let sa_files = load_service_account_files(&service_account_folder)?;
    if sa_files.is_empty() {
        return Err(
            "No valid service account JSON files found in the selected folder.".to_string(),
        );
    }

    let sa_pool = Arc::new(Mutex::new(sa_files));
    let sa_tick = Arc::new(AtomicU64::new(0));

    let concurrency = max_concurrent.clamp(1, 10) as usize;
    let (tx, rx) = mpsc::channel::<QueueItemInput>(concurrency.saturating_mul(2).max(8));
    let rx = Arc::new(Mutex::new(rx));

    let succeeded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let failed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let canceled = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    for item in &queue {
        log::debug!(
            target: "rclone",
            "queue.added id={} kind={} path={}",
            item.id,
            item.kind,
            item.path
        );
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
    }

    let mut worker_handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let app = app.clone();
        let control = control.clone();
        let rx = rx.clone();
        let prefs = prefs.clone();
        let destination_folder_id = destination_folder_id.clone();
        let sa_pool = sa_pool.clone();
        let sa_tick = sa_tick.clone();
        let succeeded = succeeded.clone();
        let failed = failed.clone();
        let canceled = canceled.clone();

        worker_handles.push(tokio::spawn(async move {
            loop {
                if control.is_canceled() {
                    break;
                }
                let item = {
                    let mut guard = rx.lock().await;
                    guard.recv().await
                };
                let Some(item) = item else { break };

                let result = run_rclone_for_item(
                    &app,
                    &control,
                    &prefs,
                    &sa_pool,
                    &sa_tick,
                    &destination_folder_id,
                    &item,
                )
                .await;

                match result {
                    Ok(()) => {
                        succeeded.fetch_add(1, Ordering::Relaxed);
                    }
                    // Cancelling is not a failure. Put the item back in the
                    // queue so it can simply be started again.
                    Err(err) if control.is_canceled() || err == CANCELED => {
                        canceled.fetch_add(1, Ordering::Relaxed);
                        let _ = app.emit(
                            "upload:item_status",
                            ItemStatusEvent {
                                item_id: item.id.clone(),
                                path: item.path.clone(),
                                kind: item.kind.clone(),
                                status: "queued".to_string(),
                                message: None,
                                sa_email: None,
                            },
                        );
                    }
                    Err(err) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        let _ = app.emit(
                            "upload:item_status",
                            ItemStatusEvent {
                                item_id: item.id.clone(),
                                path: item.path.clone(),
                                kind: item.kind.clone(),
                                status: "failed".to_string(),
                                message: Some(err),
                                sa_email: None,
                            },
                        );
                    }
                }
            }
        }));
    }

    let total_items = queue.len() as u32;
    for item in queue {
        if control.is_canceled() {
            break;
        }
        log::debug!(
            target: "rclone",
            "queue.enqueued id={} kind={} path={}",
            item.id,
            item.kind,
            item.path
        );
        tx.send(item)
            .await
            .map_err(|e| format!("Failed to enqueue upload task: {e}"))?;
    }

    drop(tx);

    for handle in worker_handles {
        let _ = handle.await;
    }

    let succeeded = succeeded.load(Ordering::Relaxed) as u32;
    let failed = failed.load(Ordering::Relaxed) as u32;
    let canceled = canceled.load(Ordering::Relaxed) as u32;

    let _ = app.emit(
        "upload:completed",
        CompletedEvent {
            summary: Summary {
                total: total_items,
                succeeded,
                failed,
                canceled,
            },
        },
    );

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_rclone_for_item(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_pool: &Arc<Mutex<Vec<ServiceAccountFile>>>,
    sa_tick: &Arc<AtomicU64>,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if let Some(file_list) = collect_file_list(item) {
        let _ = app.emit(
            "upload:file_list",
            FileListEvent {
                item_id: item.id.clone(),
                files: file_list,
            },
        );
    }

    // On Windows a pause stops the child process, so the item has to be run
    // again when it resumes. rclone skips whatever already reached Drive, so
    // re-running is safe. On Unix the process is suspended in place and this
    // loop runs exactly once.
    loop {
        let should_pause =
            *control.pause_rx.borrow() || control.paused_items_rx.borrow().contains(&item.id);
        let initial_status = if should_pause { "paused" } else { "uploading" };
        log::debug!(
            target: "rclone",
            "upload.start id={} kind={} path={} paused={}",
            item.id,
            item.kind,
            item.path,
            should_pause
        );
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: initial_status.to_string(),
                message: None,
                sa_email: None,
            },
        );

        wait_if_paused(control, &item.id).await?;

        let (sa_path, sa_email) = select_service_account(sa_pool, sa_tick).await?;

        match run_rclone_command(
            app,
            control,
            prefs,
            &sa_path,
            sa_email,
            destination_folder_id,
            item,
        )
        .await
        {
            Err(err) if err == PAUSE_RESTART => continue,
            other => return other,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_rclone_command(
    app: &AppHandle,
    control: &UploadControlHandle,
    prefs: &RclonePreferences,
    sa_path: &Path,
    sa_email: Option<String>,
    destination_folder_id: &str,
    item: &QueueItemInput,
) -> Result<(), String> {
    if control.is_canceled() {
        return Err(CANCELED.to_string());
    }

    log::debug!(
        target: "rclone",
        "upload.sa id={} sa={}",
        item.id,
        sa_path.to_string_lossy()
    );
    let _ = app.emit(
        "upload:item_status",
        ItemStatusEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            kind: item.kind.clone(),
            status: "uploading".to_string(),
            message: None,
            sa_email: sa_email.clone(),
        },
    );

    let args = build_rclone_args(prefs, destination_folder_id, item, sa_path);

    let mut command = build_rclone_command(&prefs.rclone_path, &args);

    log::debug!(
        target: "rclone",
        "upload.exec id={} cmd={} args={:?}",
        item.id,
        prefs.rclone_path,
        args
    );
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start rclone: {e}"))?;

    let pid = child
        .id()
        .ok_or_else(|| "Failed to get rclone process id".to_string())?;

    let (done_tx, done_rx) = watch::channel(false);
    // The monitor observes pause/cancel but does not own the child, so it asks
    // this function to stop the process through `stop_tx`.
    let (stop_tx, mut stop_rx) = watch::channel(StopReason::None);
    let pause_task = tokio::spawn(monitor_pause_state(
        app.clone(),
        control.clone(),
        item.clone(),
        pid,
        stop_tx,
        done_rx,
    ));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr".to_string())?;

    let (line_tx, mut line_rx) = mpsc::channel::<String>(256);
    let stdout_task = tokio::spawn(read_rclone_stream(stdout, line_tx.clone()));
    let stderr_task = tokio::spawn(read_rclone_stream(stderr, line_tx.clone()));
    drop(line_tx);

    let progress_re = progress_regex();
    let mut last_bytes = 0_u64;
    let mut last_total = 0_u64;
    let mut last_file_progress: HashMap<String, (u64, u64)> = HashMap::new();
    // Keep the most recent rclone errors so a failure can say what went wrong
    // instead of only reporting an exit code.
    let mut error_lines: Vec<String> = Vec::new();
    let mut recent_lines: Vec<String> = Vec::new();
    let mut stop_reason = StopReason::None;
    let mut stopped = false;

    loop {
        tokio::select! {
            maybe_line = line_rx.recv() => {
                let Some(line) = maybe_line else { break };
                log::debug!(target: "rclone", "{}", line);

                if let Some(message) = extract_log_error(&line) {
                    if !error_lines.contains(&message) {
                        if error_lines.len() == 5 {
                            error_lines.remove(0);
                        }
                        error_lines.push(message);
                    }
                }
                if recent_lines.len() == 3 {
                    recent_lines.remove(0);
                }
                recent_lines.push(line.clone());

                if let Some(entries) = parse_json_file_progress(&line) {
                    for (file_path, bytes, total) in entries {
                        let should_emit = match last_file_progress.get(&file_path) {
                            Some((last_bytes, last_total)) => {
                                *last_bytes != bytes || *last_total != total
                            }
                            None => true,
                        };
                        if should_emit {
                            last_file_progress.insert(file_path.clone(), (bytes, total));
                            emit_file_progress(app, item, &file_path, bytes, total).await;
                        }
                    }
                }
                if let Some((bytes, total)) = parse_json_progress(&line, &item.path)
                    .or_else(|| parse_progress_line(&progress_re, &line))
                {
                    if bytes != last_bytes || total != last_total {
                        last_bytes = bytes;
                        last_total = total;
                        emit_progress(app, item, bytes, total).await;
                    }
                }
            }
            changed = stop_rx.changed(), if !stopped => {
                if changed.is_err() {
                    // Monitor finished; nothing more will ask us to stop.
                    stopped = true;
                    continue;
                }
                let reason = *stop_rx.borrow();
                if reason == StopReason::None {
                    continue;
                }
                stop_reason = reason;
                stopped = true;
                // A suspended process cannot act on a terminate request, so
                // always resume before killing - this is what used to wedge the
                // app when cancelling a paused item.
                #[cfg(unix)]
                {
                    let _ = resume_process(pid);
                }
                if let Err(e) = child.kill().await {
                    log::warn!(target: "rclone", "upload.kill_failed id={} err={e}", item.id);
                }
            }
        }
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let _ = done_tx.send(true);
    let _ = pause_task.await;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for rclone: {e}"))?;

    if control.is_canceled() || stop_reason == StopReason::Cancel {
        return Err(CANCELED.to_string());
    }

    if stop_reason == StopReason::PauseRestart {
        return Err(PAUSE_RESTART.to_string());
    }

    if status.success() {
        log::info!(
            target: "rclone",
            "upload.done id={} status=ok",
            item.id
        );
        let _ = app.emit(
            "upload:item_status",
            ItemStatusEvent {
                item_id: item.id.clone(),
                path: item.path.clone(),
                kind: item.kind.clone(),
                status: "done".to_string(),
                message: None,
                sa_email,
            },
        );
        return Ok(());
    }

    let failure = describe_failure(&status, &error_lines, &recent_lines);
    log::warn!(
        target: "rclone",
        "upload.failed id={} status={} detail={}",
        item.id,
        status,
        failure
    );

    Err(failure)
}

/// Pull the human-readable message out of an rclone JSON log line, but only for
/// lines that actually represent a failure.
fn extract_log_error(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let level = value.get("level").and_then(|v| v.as_str())?;
    if !matches!(level, "error" | "fatal" | "critical") {
        return None;
    }
    let msg = value.get("msg").and_then(|v| v.as_str())?.trim();
    if msg.is_empty() {
        return None;
    }
    let object = value
        .get("object")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    Some(if object.is_empty() {
        msg.to_string()
    } else {
        format!("{object}: {msg}")
    })
}

/// Build a failure message that tells the user what rclone actually complained
/// about, falling back to the last raw output when nothing was tagged as an
/// error (for example when rclone dies before it starts logging JSON).
fn describe_failure(
    status: &std::process::ExitStatus,
    error_lines: &[String],
    recent_lines: &[String],
) -> String {
    let mut detail = if !error_lines.is_empty() {
        error_lines.join("; ")
    } else {
        recent_lines.join("; ")
    };

    if detail.chars().count() > MAX_ERROR_DETAIL {
        detail = detail.chars().take(MAX_ERROR_DETAIL).collect::<String>() + "…";
    }

    let code = match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "terminated by signal".to_string(),
    };

    if detail.is_empty() {
        format!("rclone failed ({code})")
    } else {
        format!("rclone failed ({code}): {detail}")
    }
}

async fn emit_progress(app: &AppHandle, item: &QueueItemInput, bytes: u64, total: u64) {
    log::debug!(
        target: "rclone",
        "progress id={} bytes={} total={}",
        item.id,
        bytes,
        total
    );
    let _ = app.emit(
        "upload:progress",
        ProgressEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            bytes_sent: bytes,
            total_bytes: total,
        },
    );
}

async fn emit_file_progress(
    app: &AppHandle,
    item: &QueueItemInput,
    file_path: &str,
    bytes: u64,
    total: u64,
) {
    let _ = app.emit(
        "upload:file_progress",
        FileProgressEvent {
            item_id: item.id.clone(),
            file_path: file_path.to_string(),
            bytes_sent: bytes,
            total_bytes: total,
        },
    );
}

async fn monitor_pause_state(
    app: AppHandle,
    control: UploadControlHandle,
    item: QueueItemInput,
    pid: u32,
    stop_tx: watch::Sender<StopReason>,
    mut done_rx: watch::Receiver<bool>,
) {
    // `pid` is only needed for the Unix suspend/resume signals.
    let _ = pid;
    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();
    let mut is_paused = false;

    loop {
        if *done_rx.borrow() {
            break;
        }

        if control.is_canceled() {
            log::debug!(target: "rclone", "upload.cancel id={}", item.id);
            let _ = stop_tx.send(StopReason::Cancel);
            break;
        }

        let should_pause = *pause_all_rx.borrow() || paused_items_rx.borrow().contains(&item.id);
        if should_pause != is_paused {
            is_paused = should_pause;
            log::debug!(
                target: "rclone",
                "upload.pause id={} paused={}",
                item.id,
                is_paused
            );

            let _ = app.emit(
                "upload:item_status",
                ItemStatusEvent {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    status: if is_paused {
                        "paused".to_string()
                    } else {
                        "uploading".to_string()
                    },
                    message: None,
                    sa_email: None,
                },
            );

            #[cfg(unix)]
            {
                let _ = if is_paused {
                    suspend_process(pid)
                } else {
                    resume_process(pid)
                };
            }
            #[cfg(windows)]
            {
                // No portable process-suspend on Windows: stop rclone and let
                // the worker re-run it when the item resumes.
                if is_paused {
                    log::debug!(
                        target: "rclone",
                        "upload.pause stopping child on Windows id={}",
                        item.id
                    );
                    let _ = stop_tx.send(StopReason::PauseRestart);
                    break;
                }
            }
        }

        tokio::select! {
            _ = pause_all_rx.changed() => {}
            _ = paused_items_rx.changed() => {}
            _ = done_rx.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
}

/// Build an rclone command with piped output, hiding the console window on
/// Windows so the app does not flash a terminal for every invocation.
fn build_rclone_command(rclone_path: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut std_command = std::process::Command::new(rclone_path);
        std_command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        Command::from(std_command)
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = Command::new(rclone_path);
        command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };
    command
}

/// Check that the destination folder is reachable with the configured remote
/// and service accounts, so a bad folder ID or an account without access fails
/// immediately instead of part-way through a large transfer.
pub async fn verify_destination(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    destination_folder_id: &str,
) -> Result<(), String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let args = vec![
        "lsjson".to_string(),
        format!("{}:", prefs.remote_name),
        "--drive-root-folder-id".to_string(),
        destination_folder_id.to_string(),
        "--max-depth".to_string(),
        "1".to_string(),
        "--use-json-log".to_string(),
        "--drive-service-account-file".to_string(),
        sa.path.to_string_lossy().to_string(),
    ];

    let mut command = build_rclone_command(&prefs.rclone_path, &args);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Timed out checking the destination folder.".to_string())?
        .map_err(|e| format!("Failed to run rclone: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let error_lines: Vec<String> = stderr.lines().filter_map(extract_log_error).collect();
    let detail = if error_lines.is_empty() {
        stderr.lines().rev().take(2).collect::<Vec<_>>().join("; ")
    } else {
        error_lines.join("; ")
    };

    Err(if detail.trim().is_empty() {
        "Destination folder is not reachable with the configured service accounts.".to_string()
    } else {
        format!("Destination folder is not reachable: {}", detail.trim())
    })
}

fn build_rclone_args(
    prefs: &RclonePreferences,
    destination_folder_id: &str,
    item: &QueueItemInput,
    sa_path: &Path,
) -> Vec<String> {
    let mut args = vec![
        "copy".to_string(),
        item.path.clone(),
        format!(
            "{}:{}",
            prefs.remote_name,
            if item.kind == "folder" {
                Path::new(&item.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("folder")
                    .to_string()
            } else {
                "".to_string()
            }
        ),
        "--drive-root-folder-id".to_string(),
        destination_folder_id.to_string(),
        "--drive-chunk-size".to_string(),
        format!("{}M", prefs.drive_chunk_size_mib),
        "--transfers".to_string(),
        prefs.transfers.to_string(),
        "--checkers".to_string(),
        prefs.checkers.to_string(),
        "--stats".to_string(),
        "1s".to_string(),
        "--stats-log-level".to_string(),
        "INFO".to_string(),
        "--log-level".to_string(),
        "INFO".to_string(),
        "--use-json-log".to_string(),
        "--drive-service-account-file".to_string(),
        sa_path.to_string_lossy().to_string(),
        "--retries".to_string(),
        prefs.retries.to_string(),
    ];

    let bandwidth_limit = prefs.bandwidth_limit.trim();
    if !bandwidth_limit.is_empty() {
        args.push("--bwlimit".to_string());
        args.push(bandwidth_limit.to_string());
    }

    for pattern in &prefs.exclude_patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        args.push("--exclude".to_string());
        args.push(pattern.to_string());
    }

    args
}

fn load_service_account_files(folder: &str) -> Result<Vec<ServiceAccountFile>, String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|e| format!("Failed to read service account folder: {e}"))?;

    let mut accounts = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read folder entry: {e}"))?;
        let path = entry.path();
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata for {path:?}: {e}"))?;
        if !metadata.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_json {
            continue;
        }

        let email = match read_service_account_email(&path) {
            Ok(email) => email,
            Err(_) => continue,
        };
        accounts.push(ServiceAccountFile {
            path,
            email,
            last_used: 0,
        });
    }

    Ok(accounts)
}

fn read_service_account_email(path: &Path) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct ServiceAccountJson {
        client_email: Option<String>,
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read service account JSON: {e}"))?;
    let parsed: ServiceAccountJson = serde_json::from_str(&contents)
        .map_err(|e| format!("Invalid service account JSON: {e}"))?;

    Ok(parsed.client_email)
}

async fn select_service_account(
    pool: &Arc<Mutex<Vec<ServiceAccountFile>>>,
    tick: &Arc<AtomicU64>,
) -> Result<(PathBuf, Option<String>), String> {
    let mut guard = pool.lock().await;
    if guard.is_empty() {
        return Err("No service account JSON files available.".to_string());
    }

    let mut best_idx = 0;
    let mut best_used = guard[0].last_used;
    for (idx, entry) in guard.iter().enumerate().skip(1) {
        if entry.last_used < best_used {
            best_idx = idx;
            best_used = entry.last_used;
        }
    }

    let next = tick.fetch_add(1, Ordering::Relaxed) + 1;
    guard[best_idx].last_used = next;

    let entry = &guard[best_idx];
    Ok((entry.path.clone(), entry.email.clone()))
}

fn progress_regex() -> Regex {
    Regex::new(r"([0-9.]+)\s*([A-Za-z]+)\s*/\s*([0-9.]+)\s*([A-Za-z]+)").expect("progress regex")
}

fn parse_progress_line(regex: &Regex, line: &str) -> Option<(u64, u64)> {
    let caps = regex.captures(line)?;
    let sent = parse_size(&caps[1], &caps[2])?;
    let total = parse_size(&caps[3], &caps[4])?;
    Some((sent, total))
}

fn parse_json_progress(line: &str, path: &str) -> Option<(u64, u64)> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;
    let file_name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);

    if let Some(transferring) = stats.get("transferring").and_then(|v| v.as_array()) {
        for entry in transferring {
            let name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| entry.get("path").and_then(|v| v.as_str()))
                .or_else(|| entry.get("object").and_then(|v| v.as_str()));
            if let Some(name) = name {
                if name == file_name || name.ends_with(file_name) {
                    let bytes = entry.get("bytes").and_then(|v| v.as_u64())?;
                    let total = entry.get("size").and_then(|v| v.as_u64())?;
                    return Some((bytes, total));
                }
            }
        }

        if transferring.len() == 1 {
            let entry = &transferring[0];
            let bytes = entry.get("bytes").and_then(|v| v.as_u64())?;
            let total = entry.get("size").and_then(|v| v.as_u64())?;
            return Some((bytes, total));
        }
    }

    let bytes = stats.get("bytes").and_then(|v| v.as_u64())?;
    let total = stats.get("totalBytes").and_then(|v| v.as_u64())?;
    Some((bytes, total))
}

fn parse_json_file_progress(line: &str) -> Option<Vec<(String, u64, u64)>> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;
    let transferring = stats.get("transferring")?.as_array()?;
    let mut entries = Vec::new();
    for entry in transferring {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("path").and_then(|v| v.as_str()))
            .or_else(|| entry.get("object").and_then(|v| v.as_str()));
        let bytes = entry.get("bytes").and_then(|v| v.as_u64());
        let total = entry.get("size").and_then(|v| v.as_u64());
        if let (Some(name), Some(bytes), Some(total)) = (name, bytes, total) {
            entries.push((name.to_string(), bytes, total));
        }
    }
    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

fn collect_file_list(item: &QueueItemInput) -> Option<Vec<FileListEntry>> {
    let path = PathBuf::from(&item.path);
    let mut files = Vec::new();

    if item.kind == "file" {
        if let Ok(metadata) = std::fs::metadata(&path) {
            files.push(FileListEntry {
                file_path: path.to_string_lossy().to_string(),
                total_bytes: metadata.len(),
            });
        }
        return Some(files);
    }

    if item.kind != "folder" {
        return None;
    }

    for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path().to_path_buf();
        if let Ok(metadata) = std::fs::metadata(&file_path) {
            files.push(FileListEntry {
                file_path: file_path.to_string_lossy().to_string(),
                total_bytes: metadata.len(),
            });
        }
    }

    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

fn parse_size(value: &str, unit: &str) -> Option<u64> {
    let number: f64 = value.parse().ok()?;
    let unit = unit.to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "b" => 1.0,
        "kb" => 1_000.0,
        "mb" => 1_000_000.0,
        "gb" => 1_000_000_000.0,
        "tb" => 1_000_000_000_000.0,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier).round() as u64)
}

#[cfg(unix)]
fn signal_process(pid: u32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err("Failed to signal rclone process".to_string())
    }
}

#[cfg(unix)]
fn suspend_process(pid: u32) -> Result<(), String> {
    signal_process(pid, libc::SIGSTOP)
}

#[cfg(unix)]
fn resume_process(pid: u32) -> Result<(), String> {
    signal_process(pid, libc::SIGCONT)
}

async fn read_rclone_stream<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    tx: mpsc::Sender<String>,
) {
    let mut buf = [0_u8; 4096];
    let mut pending = Vec::new();

    loop {
        let read = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        pending.extend_from_slice(&buf[..read]);

        let mut start = 0;
        for i in 0..pending.len() {
            let b = pending[i];
            if b == b'\n' || b == b'\r' {
                if i > start {
                    let line = String::from_utf8_lossy(&pending[start..i])
                        .trim()
                        .to_string();
                    if !line.is_empty() {
                        let _ = tx.send(line).await;
                    }
                }
                start = i + 1;
            }
        }

        if start > 0 {
            pending.drain(0..start);
        }
    }

    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).trim().to_string();
        if !line.is_empty() {
            let _ = tx.send(line).await;
        }
    }
}
