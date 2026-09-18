use crate::upload::events::{
    CompletedEvent, FileListEntry, FileListEvent, FileProgressEvent, ItemStatusEvent,
    ProgressEvent, Summary,
};
use crate::upload::scheduler::{
    wait_if_paused, JobTallies, QueueItemInput, UploadControlHandle, CANCELED,
};
use crate::upload::speed_watch::{SpeedWatch, Transfer, FUTILE_RUN, MAX_RESTART_STREAK};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    /// Times a process on this account was restarted for crawling. Such an
    /// account is picked only once every account with fewer marks has been.
    slow_marks: u32,
}

/// What every rclone process of a job shares.
struct Job {
    app: AppHandle,
    control: UploadControlHandle,
    prefs: RclonePreferences,
    sa_pool: Arc<Mutex<Vec<ServiceAccountFile>>>,
    sa_tick: Arc<AtomicU64>,
    /// Spots a process crawling on a bad flow or account, see `speed_watch`.
    watch: Arc<SpeedWatch>,
}

/// Rations an item's or group's restarts for crawling, so a link that is
/// simply slow does not thrash: restarts count as a streak while each run
/// crawled within `FUTILE_RUN` of starting, and the streak ends at
/// `MAX_RESTART_STREAK`. A run that went well for longer starts a new streak.
struct RestartBudget {
    streak: u32,
    run_started: Instant,
}

impl RestartBudget {
    fn new() -> Self {
        Self {
            streak: 0,
            run_started: Instant::now(),
        }
    }

    /// Marks the start of a run. Whether it may be restarted for crawling.
    fn starting(&mut self) -> bool {
        self.run_started = Instant::now();
        self.streak < MAX_RESTART_STREAK
    }

    /// The run was stopped for crawling. A rerun that crawled again straight
    /// away tells the watch that the link itself has slowed.
    fn restarted(&mut self, watch: &SpeedWatch) {
        let quick = self.run_started.elapsed() < FUTILE_RUN;
        let was_rerun = self.streak > 0;
        self.streak = if quick { self.streak + 1 } else { 1 };
        if quick && was_rerun {
            watch.restart_was_futile(Instant::now());
        }
    }
}

/// Why the rclone child process is being stopped early.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StopReason {
    None,
    Cancel,
    /// Windows only: pause is implemented by stopping rclone and re-running it
    /// on resume, because there is no portable SIGSTOP equivalent.
    PauseRestart,
    /// The process was crawling and is to be run again on a fresh flow, on
    /// another service account when there is one. See `speed_watch`.
    Restart,
}

/// Internal sentinel error meaning "this item was paused, run it again once it
/// is resumed". Never surfaced to the UI.
const PAUSE_RESTART: &str = "__gdexplorer_pause_restart__";

/// Internal sentinel error meaning "this process crawled, run it again". Never
/// surfaced to the UI.
const RESTART: &str = "__gdexplorer_restart__";

/// Keep the failure message useful without letting a pathological log line blow
/// up the UI tooltip.
const MAX_ERROR_DETAIL: usize = 600;

/// Runs the worker pool for the lifetime of a job.
///
/// The pool used to receive a fixed `Vec` of items and exit once it drained,
/// which is why starting a second batch had to cancel the first one. It now
/// pulls from a channel owned by `UploadControl`, so items can be appended to a
/// running job. Workers exit only when that sender is dropped (cancel, or a new
/// job replacing this one).
pub async fn run_rclone_job(
    app: AppHandle,
    control: UploadControlHandle,
    prefs: RclonePreferences,
    max_concurrent: u8,
    service_account_folder: String,
    queue_rx: mpsc::UnboundedReceiver<QueueItemInput>,
    tallies: Arc<JobTallies>,
) -> Result<(), String> {
    let sa_files = load_service_account_files(&service_account_folder)?;
    if sa_files.is_empty() {
        return Err(
            "No valid service account JSON files found in the selected folder.".to_string(),
        );
    }

    let concurrency = max_concurrent.clamp(1, 10) as usize;
    log::debug!(
        target: "rclone",
        "queue.worker_pool_started concurrency={concurrency}"
    );

    let job = Arc::new(Job {
        app: app.clone(),
        control: control.clone(),
        prefs,
        sa_pool: Arc::new(Mutex::new(sa_files)),
        sa_tick: Arc::new(AtomicU64::new(0)),
        watch: Arc::new(SpeedWatch::new()),
    });
    let rx = Arc::new(Mutex::new(queue_rx));

    let mut worker_handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let app = app.clone();
        let control = control.clone();
        let rx = rx.clone();
        let job = job.clone();
        let tallies = tallies.clone();
        let fanout = concurrency;

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

                let result = run_rclone_for_item(&job, &item, fanout).await;

                match result {
                    Ok(()) => {
                        tallies.succeeded.fetch_add(1, Ordering::Relaxed);
                    }
                    // Cancelling is not a failure. Put the item back in the
                    // queue so it can simply be started again.
                    Err(err) if control.is_canceled() || err == CANCELED => {
                        tallies.canceled.fetch_add(1, Ordering::Relaxed);
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
                        tallies.failed.fetch_add(1, Ordering::Relaxed);
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

                // The batch is finished when the last accepted item settles.
                // Anything queued after this point starts a fresh batch, so the
                // tallies are cleared once reported.
                if tallies.record_finished() {
                    let (total, succeeded, failed, canceled) = tallies.snapshot();
                    log::info!(
                        target: "rclone",
                        "queue.batch_complete total={total} succeeded={succeeded} failed={failed} canceled={canceled}"
                    );
                    let _ = app.emit(
                        "upload:completed",
                        CompletedEvent {
                            summary: Summary {
                                total,
                                succeeded,
                                failed,
                                canceled,
                            },
                        },
                    );
                    tallies.reset();
                }
            }
        }));
    }

    for handle in worker_handles {
        let _ = handle.await;
    }

    log::debug!(target: "rclone", "queue.worker_pool_stopped");
    Ok(())
}

async fn run_rclone_for_item(
    job: &Arc<Job>,
    item: &QueueItemInput,
    max_fanout: usize,
) -> Result<(), String> {
    let (app, control, prefs) = (&job.app, &job.control, &job.prefs);
    let files = collect_file_list(item);
    if let Some(file_list) = &files {
        let _ = app.emit(
            "upload:file_list",
            FileListEvent {
                item_id: item.id.clone(),
                files: file_list.clone(),
            },
        );
    }

    // A folder with several files fans its files out across service accounts,
    // so a single folder is no longer capped at one account's throughput. A
    // file item, an empty folder, or a folder the fan-out cannot express (see
    // `plan_folder_fanout`) keeps the single-process path.
    if item.kind == "folder" {
        if let Some(groups) = plan_folder_fanout(prefs, item, files.as_deref(), max_fanout).await {
            return run_folder_fanout(job, item, groups).await;
        }
    }

    // On Windows a pause stops the child process, so the item has to be run
    // again when it resumes. rclone skips whatever already reached Drive, so
    // re-running is safe. The same goes for a process restarted for crawling.
    // On Unix without a restart the loop runs exactly once.
    let mut budget = RestartBudget::new();
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

        let (sa_path, sa_email) = select_service_account(&job.sa_pool, &job.sa_tick).await?;
        let may_restart = budget.starting();

        match run_rclone_command(
            job,
            &sa_path,
            sa_email,
            item,
            &ItemProgress::Direct,
            None,
            may_restart,
        )
        .await
        {
            Err(err) if err == PAUSE_RESTART => continue,
            Err(err) if err == RESTART => {
                budget.restarted(&job.watch);
                mark_slow(&job.sa_pool, &sa_path).await;
                continue;
            }
            other => return other,
        }
    }
}

/// How one rclone process reports the item-level progress it produces.
enum ItemProgress {
    /// This process owns the item and emits its status and progress directly.
    Direct,
    /// Part of a folder fan-out: forward progress to the aggregator so the
    /// folder's total is the sum of every group, and let the coordinator emit
    /// status and completion.
    Fanout {
        aggregator: Arc<FolderAggregator>,
        part: usize,
    },
}

impl ItemProgress {
    async fn report(
        &self,
        app: &AppHandle,
        item: &QueueItemInput,
        bytes: u64,
        total: u64,
        speed: Option<u64>,
    ) {
        match self {
            ItemProgress::Direct => emit_progress(app, item, bytes, total, speed).await,
            ItemProgress::Fanout { aggregator, part } => {
                aggregator.update(*part, bytes, total, speed).await;
            }
        }
    }
}

/// One group's last reported progress: (bytes sent, total bytes, speed).
type PartProgress = (u64, u64, Option<u64>);

#[derive(Default)]
struct PartState {
    latest: PartProgress,
    /// The total the group reported before its process was restarted, so its
    /// readings can be mapped back onto it. See `carried_reading`.
    carried_total: Option<u64>,
}

/// Sums the progress of a folder's fan-out groups into one item-level reading.
struct FolderAggregator {
    app: AppHandle,
    item: QueueItemInput,
    /// group index -> that group's progress.
    parts: Mutex<HashMap<usize, PartState>>,
}

impl FolderAggregator {
    fn new(app: AppHandle, item: QueueItemInput) -> Self {
        Self {
            app,
            item,
            parts: Mutex::new(HashMap::new()),
        }
    }

    /// Called before a group's process is run again on another account.
    async fn restarting(&self, part: usize) {
        let mut parts = self.parts.lock().await;
        let state = parts.entry(part).or_default();
        if state.carried_total.is_none() && state.latest.1 > 0 {
            state.carried_total = Some(state.latest.1);
        }
    }

    async fn update(&self, part: usize, bytes: u64, total: u64, speed: Option<u64>) {
        let (bytes, total, speed) = {
            let mut parts = self.parts.lock().await;
            let state = parts.entry(part).or_default();
            let (bytes, total) = match state.carried_total {
                Some(carried) => carried_reading(carried, state.latest, bytes, total),
                None => (bytes, total),
            };
            state.latest = (bytes, total, speed);
            parts
                .values()
                .fold((0_u64, 0_u64, 0_u64), |(b, t, s), state| {
                    let (pb, pt, ps) = state.latest;
                    (b + pb, t + pt, s + ps.unwrap_or(0))
                })
        };
        emit_progress(&self.app, &self.item, bytes, total, Some(speed)).await;
    }
}

/// Maps a restarted group's reading back onto the total it had before.
///
/// A fresh rclone process counts only the files still to send, so its total
/// shrinks by whatever already reached Drive - which is exactly what counts as
/// sent. Until it has listed those files its total is still climbing, and a
/// complete total always covers at least what the group had left before the
/// restart; below that the last reading is repeated rather than overstated.
fn carried_reading(carried_total: u64, frozen: PartProgress, bytes: u64, total: u64) -> (u64, u64) {
    if total > carried_total {
        // More to send than the original list had: rclone knows better.
        return (bytes, total);
    }
    if total < carried_total.saturating_sub(frozen.0) {
        return (frozen.0, frozen.1);
    }
    ((carried_total - total) + bytes, carried_total)
}

/// A file's path relative to the folder root, in the forward-slash form rclone
/// uses on every platform.
///
/// `--files-from-raw` is one path per line, so a name with a line break in it
/// would be read as two paths that match nothing; such a folder is refused
/// here and goes through a single process instead.
fn relative_path(root: &Path, file_path: &str) -> Result<String, String> {
    let relative = Path::new(file_path)
        .strip_prefix(root)
        .map_err(|_| {
            format!(
                "File {file_path} is not inside the folder {}",
                root.display()
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.contains(['\n', '\r']) {
        return Err(format!("File {file_path} has a line break in its name"));
    }
    Ok(relative)
}

/// Splits a folder's files into up to `max_groups` balanced groups, each a list
/// of paths relative to the folder root for rclone's `--files-from-raw`.
///
/// A top-level subfolder always goes to one group whole. Drive allows two
/// folders of the same name side by side, and rclone creates any folder it
/// cannot list, so two processes writing into the same new subfolder at the
/// same moment each created their own. The units - top-level files and
/// subfolders - are handed out largest-first to the group with the least work,
/// so one big unit cannot leave a group idle while another still has work.
fn partition_files(
    root: &Path,
    files: &[FileListEntry],
    max_groups: usize,
) -> Result<Vec<Vec<String>>, String> {
    // top-level entry -> (bytes under it, its files)
    let mut units: BTreeMap<String, (u64, Vec<String>)> = BTreeMap::new();
    for file in files {
        let relative = relative_path(root, &file.file_path)?;
        let unit = relative.split('/').next().unwrap_or(&relative).to_string();
        let entry = units.entry(unit).or_default();
        entry.0 += file.total_bytes;
        entry.1.push(relative);
    }
    let mut units: Vec<(u64, Vec<String>)> = units.into_values().collect();
    units.sort_by_key(|(size, _)| std::cmp::Reverse(*size));

    let group_count = max_groups.min(units.len()).max(1);
    let mut groups: Vec<(u64, Vec<String>)> = vec![(0, Vec::new()); group_count];
    for (size, paths) in units {
        let lightest = groups
            .iter_mut()
            .min_by_key(|(load, _)| *load)
            .expect("at least one group");
        lightest.0 += size;
        lightest.1.extend(paths);
    }
    Ok(groups
        .into_iter()
        .map(|(_, paths)| paths)
        .filter(|paths| !paths.is_empty())
        .collect())
}

/// Writes a file list for rclone's `--files-from-raw`, one path per line. The
/// raw variant reads each line verbatim, so names with leading/trailing spaces
/// or a leading `#` survive. Returns the temp file's path for the caller to
/// clean up.
///
/// The separator has to be a newline. rclone splits this file with a line
/// scanner, so a NUL-separated list is read as a single path that matches
/// nothing - and a `--files-from` entry that does not exist is skipped without
/// an error, so rclone then reports a successful copy of no files at all.
/// (`--files-from0` takes NUL, but only in releases from mid-2026 on.)
fn write_files_from(paths: &[String]) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "gdexplorer-files-from-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let mut contents = String::new();
    for entry in paths {
        contents.push_str(entry);
        contents.push('\n');
    }
    std::fs::write(&path, contents)
        .map_err(|e| format!("Failed to write rclone file list: {e}"))?;
    Ok(path)
}

/// Asks rclone which of a folder's files survive the exclude patterns.
///
/// rclone refuses `--exclude` next to `--files-from-raw` ("overrides all other
/// filters"), so a fanned-out folder cannot hand the patterns to `copy`.
/// Listing the local folder through rclone with the same patterns applies them
/// with rclone's own matcher, so the fan-out skips exactly what one process
/// would. Paths come back relative to the folder with forward slashes, the
/// same form `relative_path` produces.
async fn files_surviving_excludes(
    prefs: &RclonePreferences,
    root: &Path,
) -> Result<HashSet<String>, String> {
    let mut args = vec![
        "lsjson".to_string(),
        root.to_string_lossy().to_string(),
        "-R".to_string(),
        "--files-only".to_string(),
    ];
    args.extend(exclude_args(prefs));

    let output = run_rclone_to_completion(prefs, &args, Duration::from_secs(30 * 60)).await?;
    if !output.status.success() {
        let detail = describe_command_failure(&output);
        return Err(if detail.is_empty() {
            "Could not list the folder with the exclude patterns.".to_string()
        } else {
            format!("Could not list the folder with the exclude patterns: {detail}")
        });
    }

    let entries: Vec<LsJsonEntry> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Could not read the folder listing: {e}"))?;
    Ok(entries
        .into_iter()
        .filter(|entry| !entry.is_dir)
        .map(|entry| entry.path)
        .collect())
}

/// Decides how a folder is split across rclone processes, or returns None when
/// it should go through a single process instead.
///
/// Single-process is the fallback for anything the fan-out cannot express:
/// fewer than two files once the exclude patterns are applied, a name
/// `--files-from-raw` cannot carry, or a listing that failed. Falling back
/// costs throughput, never correctness.
async fn plan_folder_fanout(
    prefs: &RclonePreferences,
    item: &QueueItemInput,
    files: Option<&[FileListEntry]>,
    max_fanout: usize,
) -> Option<Vec<Vec<String>>> {
    let files = files?;
    if files.len() < 2 || max_fanout < 2 {
        return None;
    }
    let root = Path::new(&item.path);

    let kept: Vec<FileListEntry> = if exclude_args(prefs).is_empty() {
        files.to_vec()
    } else {
        match files_surviving_excludes(prefs, root).await {
            Ok(surviving) => files
                .iter()
                .filter(|file| {
                    relative_path(root, &file.file_path)
                        .is_ok_and(|relative| surviving.contains(&relative))
                })
                .cloned()
                .collect(),
            Err(err) => {
                log::warn!(
                    target: "rclone",
                    "upload.fanout_skipped id={} reason={err}",
                    item.id
                );
                return None;
            }
        }
    };

    match partition_files(root, &kept, max_fanout) {
        Ok(groups) if groups.len() > 1 => Some(groups),
        Ok(_) => None,
        Err(err) => {
            log::warn!(
                target: "rclone",
                "upload.fanout_skipped id={} reason={err}",
                item.id
            );
            None
        }
    }
}

/// Creates the item's folder in Drive before any fan-out group starts.
///
/// Drive allows two folders of the same name side by side, and rclone creates
/// a folder it cannot list. Groups starting at the same instant each listed,
/// saw nothing and created their own - which is where the duplicate folders
/// came from. Created once up front, every group finds it.
async fn create_remote_folder(
    job: &Job,
    item: &QueueItemInput,
    sa_path: &Path,
) -> Result<(), String> {
    let args = vec![
        "mkdir".to_string(),
        remote_target(&job.prefs, item),
        "--drive-root-folder-id".to_string(),
        item.destination_folder_id.clone(),
        "--drive-service-account-file".to_string(),
        sa_path.to_string_lossy().to_string(),
        "--use-json-log".to_string(),
    ];
    let output = run_rclone_to_completion(&job.prefs, &args, Duration::from_secs(60)).await?;
    if output.status.success() {
        return Ok(());
    }
    let detail = describe_command_failure(&output);
    Err(if detail.is_empty() {
        "Could not create the folder in Drive.".to_string()
    } else {
        format!("Could not create the folder in Drive: {detail}")
    })
}

/// Runs a folder item's files across several service accounts at once.
///
/// Each group is its own rclone process with its own service account, so the
/// folder is no longer limited to a single account's throughput. Progress is
/// summed across groups and reported once; the item is marked done only after
/// every group finishes.
async fn run_folder_fanout(
    job: &Arc<Job>,
    item: &QueueItemInput,
    groups: Vec<Vec<String>>,
) -> Result<(), String> {
    let (app, control) = (&job.app, &job.control);
    let group_count = groups.len();

    let should_pause =
        *control.pause_rx.borrow() || control.paused_items_rx.borrow().contains(&item.id);
    let _ = app.emit(
        "upload:item_status",
        ItemStatusEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            kind: item.kind.clone(),
            status: if should_pause {
                "paused".to_string()
            } else {
                "uploading".to_string()
            },
            message: None,
            sa_email: None,
        },
    );

    wait_if_paused(control, &item.id).await?;
    let (sa_path, _) = select_service_account(&job.sa_pool, &job.sa_tick).await?;
    create_remote_folder(job, item, &sa_path).await?;

    let aggregator = Arc::new(FolderAggregator::new(app.clone(), item.clone()));

    let mut tasks = Vec::with_capacity(group_count);
    for (part, group) in groups.into_iter().enumerate() {
        let files_from = write_files_from(&group)?;
        let job = job.clone();
        let item = item.clone();
        let aggregator = aggregator.clone();

        tasks.push(tokio::spawn(async move {
            let result = run_rclone_group(&job, &item, part, &files_from, &aggregator).await;
            let _ = std::fs::remove_file(&files_from);
            result
        }));
    }

    let mut failures: Vec<String> = Vec::new();
    let mut canceled = false;
    for task in tasks {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if err == CANCELED || control.is_canceled() {
                    canceled = true;
                } else if !failures.contains(&err) {
                    failures.push(err);
                }
            }
            Err(join) => failures.push(format!("folder worker stopped: {join}")),
        }
    }

    if canceled || control.is_canceled() {
        return Err(CANCELED.to_string());
    }
    if !failures.is_empty() {
        let mut detail = failures.join("; ");
        if detail.chars().count() > MAX_ERROR_DETAIL {
            detail = detail.chars().take(MAX_ERROR_DETAIL).collect::<String>() + "…";
        }
        return Err(detail);
    }

    log::info!(
        target: "rclone",
        "upload.done id={} status=ok groups={group_count}",
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
            sa_email: None,
        },
    );
    Ok(())
}

/// Runs one fan-out group to completion, running it again after a Windows
/// pause or a restart for crawling the same way the single-process path does.
async fn run_rclone_group(
    job: &Job,
    item: &QueueItemInput,
    part: usize,
    files_from: &Path,
    aggregator: &Arc<FolderAggregator>,
) -> Result<(), String> {
    let mut budget = RestartBudget::new();
    loop {
        wait_if_paused(&job.control, &item.id).await?;
        let (sa_path, sa_email) = select_service_account(&job.sa_pool, &job.sa_tick).await?;
        let progress = ItemProgress::Fanout {
            aggregator: aggregator.clone(),
            part,
        };
        let may_restart = budget.starting();
        match run_rclone_command(
            job,
            &sa_path,
            sa_email,
            item,
            &progress,
            Some(files_from),
            may_restart,
        )
        .await
        {
            Err(err) if err == PAUSE_RESTART => continue,
            Err(err) if err == RESTART => {
                budget.restarted(&job.watch);
                mark_slow(&job.sa_pool, &sa_path).await;
                aggregator.restarting(part).await;
                continue;
            }
            other => return other,
        }
    }
}

/// Runs one rclone process for an item or fan-out group.
///
/// With `may_restart`, a process whose transfers crawl next to what the job has
/// shown it can do (see `speed_watch`) is stopped and `RESTART` is returned,
/// so the caller runs it again on a fresh flow.
#[allow(clippy::too_many_arguments)]
async fn run_rclone_command(
    job: &Job,
    sa_path: &Path,
    sa_email: Option<String>,
    item: &QueueItemInput,
    progress: &ItemProgress,
    files_from: Option<&Path>,
    may_restart: bool,
) -> Result<(), String> {
    let (app, control, prefs) = (&job.app, &job.control, &job.prefs);
    if control.is_canceled() {
        return Err(CANCELED.to_string());
    }

    log::debug!(
        target: "rclone",
        "upload.sa id={} sa={}",
        item.id,
        sa_path.to_string_lossy()
    );
    if let ItemProgress::Direct = progress {
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
    }

    let args = build_rclone_args(prefs, item, sa_path, files_from);

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

    let stream = job.watch.open_stream();
    let progress_re = progress_regex();
    let mut last_bytes = 0_u64;
    let mut last_total = 0_u64;
    let mut last_speed: Option<u64> = None;
    let mut last_file_progress: HashMap<String, (u64, u64, u64)> = HashMap::new();
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
                    for (file_path, bytes, total, speed) in &entries {
                        let should_emit = match last_file_progress.get(file_path) {
                            Some(previous) => *previous != (*bytes, *total, *speed),
                            None => true,
                        };
                        if should_emit {
                            last_file_progress.insert(file_path.clone(), (*bytes, *total, *speed));
                            emit_file_progress(app, item, file_path, *bytes, *total, *speed).await;
                        }
                    }

                    // Judged on every stats line, not only when a counter
                    // moved: a process that has stopped moving is the one to
                    // catch.
                    let transfers: Vec<Transfer<'_>> = entries
                        .iter()
                        .map(|(name, bytes, size, _)| Transfer {
                            name,
                            bytes: *bytes,
                            size: *size,
                        })
                        .collect();
                    if may_restart
                        && stop_reason == StopReason::None
                        && job.watch.observe(stream, &transfers, Instant::now())
                    {
                        log::info!(
                            target: "rclone",
                            "upload.restart_for_crawling id={} pid={} sa={}",
                            item.id,
                            pid,
                            sa_path.to_string_lossy()
                        );
                        stop_reason = StopReason::Restart;
                        stopped = true;
                        stop_child(&mut child, pid, item, stop_reason).await;
                    }
                }
                if let Some((bytes, total, speed)) = parse_json_progress(
                    &line,
                    &item.path,
                    &item.kind,
                )
                .or_else(|| {
                    parse_progress_line(&progress_re, &line).map(|(b, t)| (b, t, None))
                }) {
                    if bytes != last_bytes || total != last_total || speed != last_speed {
                        last_bytes = bytes;
                        last_total = total;
                        last_speed = speed;
                        progress.report(app, item, bytes, total, speed).await;
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
                stop_child(&mut child, pid, item, stop_reason).await;
            }
        }
    }

    job.watch.close_stream(stream);
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
    if stop_reason == StopReason::Restart {
        return Err(RESTART.to_string());
    }

    if status.success() {
        log::info!(
            target: "rclone",
            "upload.done id={} status=ok",
            item.id
        );
        if let ItemProgress::Direct = progress {
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
        }
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

/// Stops the child process. A suspended process cannot act on a terminate
/// request, so it is always resumed first - this is what used to wedge the app
/// when cancelling a paused item.
async fn stop_child(
    child: &mut tokio::process::Child,
    pid: u32,
    item: &QueueItemInput,
    reason: StopReason,
) {
    #[cfg(unix)]
    {
        let _ = resume_process(pid);
    }
    match child.kill().await {
        Ok(()) => log::info!(
            target: "rclone",
            "upload.killed id={} pid={} reason={:?}",
            item.id,
            pid,
            reason
        ),
        Err(e) => log::warn!(
            target: "rclone",
            "upload.kill_failed id={} pid={} err={e}",
            item.id,
            pid
        ),
    }
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

async fn emit_progress(
    app: &AppHandle,
    item: &QueueItemInput,
    bytes: u64,
    total: u64,
    speed: Option<u64>,
) {
    log::debug!(
        target: "rclone",
        "progress id={} bytes={} total={} speed={:?}",
        item.id,
        bytes,
        total,
        speed
    );
    let _ = app.emit(
        "upload:progress",
        ProgressEvent {
            item_id: item.id.clone(),
            path: item.path.clone(),
            bytes_sent: bytes,
            total_bytes: total,
            speed_bytes_per_sec: speed,
        },
    );
}

async fn emit_file_progress(
    app: &AppHandle,
    item: &QueueItemInput,
    file_path: &str,
    bytes: u64,
    total: u64,
    speed: u64,
) {
    let _ = app.emit(
        "upload:file_progress",
        FileProgressEvent {
            item_id: item.id.clone(),
            file_path: file_path.to_string(),
            bytes_sent: bytes,
            total_bytes: total,
            speed_bytes_per_sec: Some(speed),
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
pub(crate) fn build_rclone_command(rclone_path: &str, args: &[String]) -> Command {
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

/// Runs rclone to completion. Newer callers use this instead of repeating the
/// spawn/timeout dance; each one still words its own failure message.
pub(crate) async fn run_rclone_to_completion(
    prefs: &RclonePreferences,
    args: &[String],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut command = build_rclone_command(&prefs.rclone_path, args);
    tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| "rclone did not finish in time.".to_string())?
        .map_err(|e| format!("Failed to run rclone: {e}"))
}

/// The most useful part of a failed rclone run: what it logged as an error, or
/// the last thing it said before giving up.
pub(crate) fn describe_command_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let error_lines: Vec<String> = stderr.lines().filter_map(extract_log_error).collect();
    let detail = if error_lines.is_empty() {
        stderr.lines().rev().take(2).collect::<Vec<_>>().join("; ")
    } else {
        error_lines.join("; ")
    };
    detail.trim().to_string()
}

/// What the preflight panel reports about the service account folder.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountSummary {
    pub valid: usize,
    /// File names that look like credentials but could not be parsed.
    pub invalid: Vec<String>,
}

/// Counts usable service account files without loading a job's worth of state,
/// so the preflight panel can say "4 of 5 usable" instead of just failing.
pub fn inspect_service_account_files(folder: &str) -> Result<ServiceAccountSummary, String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|e| format!("Failed to read service account folder: {e}"))?;

    let mut summary = ServiceAccountSummary::default();
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

        match read_service_account_email(&path) {
            Ok(_) => summary.valid += 1,
            Err(_) => summary.invalid.push(
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string_lossy().to_string()),
            ),
        }
    }

    Ok(summary)
}

/// Outcome of the write test.
pub enum WriteCheck {
    Writable,
    /// Writing worked, but the folder created to prove it is still there.
    WritableWithLeftover {
        folder: String,
    },
}

/// Creates and removes a folder in the destination.
///
/// Listing a folder only proves it can be read: a service account is regularly
/// given viewer access to a shared drive, which passes `verify_destination` and
/// then fails on the first file. This is the only check that answers the
/// question the upload actually asks.
pub async fn check_destination_writable(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    destination_folder_id: &str,
) -> Result<WriteCheck, String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    // Unique per run so two windows checking at once cannot collide, and
    // obvious enough that a leftover folder is recognisable.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let probe = format!("gdrive-upload-write-test-{stamp}");

    let target = format!("{}:{}", prefs.remote_name, probe);
    let common = [
        "--drive-root-folder-id".to_string(),
        destination_folder_id.to_string(),
        "--drive-service-account-file".to_string(),
        sa.path.to_string_lossy().to_string(),
    ];

    let mut mkdir_args = vec!["mkdir".to_string(), target.clone()];
    mkdir_args.extend_from_slice(&common);
    let output = run_rclone_to_completion(prefs, &mkdir_args, Duration::from_secs(30)).await?;

    if !output.status.success() {
        let detail = describe_command_failure(&output);
        return Err(if detail.is_empty() {
            "The service accounts cannot create folders here.".to_string()
        } else {
            format!("The service accounts cannot create folders here: {detail}")
        });
    }

    let mut rmdir_args = vec!["rmdir".to_string(), target];
    rmdir_args.extend_from_slice(&common);
    let cleanup = run_rclone_to_completion(prefs, &rmdir_args, Duration::from_secs(30)).await;

    match cleanup {
        Ok(output) if output.status.success() => Ok(WriteCheck::Writable),
        // Writing worked, which is what was being tested. Report that rather
        // than failing the check, but name the folder left behind.
        Ok(_) | Err(_) => {
            log::warn!(target: "rclone", "preflight.cleanup_failed folder={probe}");
            Ok(WriteCheck::WritableWithLeftover { folder: probe })
        }
    }
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

/// One entry of `rclone lsjson` output. Drive fills in `ID`, which is what the
/// shareable links are built from.
#[derive(Debug, Deserialize)]
struct LsJsonEntry {
    #[serde(rename = "Path")]
    path: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "IsDir")]
    is_dir: bool,
    #[serde(rename = "ID")]
    id: Option<String>,
    #[serde(rename = "Size")]
    size: Option<i64>,
    #[serde(rename = "ModTime")]
    mod_time: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileLink {
    /// Path relative to the uploaded item, matching what the file rows show.
    pub file_path: String,
    pub file_id: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLinks {
    /// Set for folder items once rclone has created the folder in Drive.
    pub folder_id: Option<String>,
    /// Set for a single file item, or for each file inside a folder.
    pub files: Vec<DriveFileLink>,
}

/// What a listing should cover. Drive charges a round trip per level, so each
/// caller asks for the narrowest listing that answers its question.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LsMode {
    /// Everything directly inside the folder.
    TopLevel,
    /// Subfolders of the folder, for the destination browser.
    TopLevelDirs,
    /// Every file underneath the folder, at any depth.
    RecursiveFiles,
}

async fn run_lsjson(
    prefs: &RclonePreferences,
    sa_path: &Path,
    root_folder_id: &str,
    mode: LsMode,
) -> Result<Vec<LsJsonEntry>, String> {
    let mut args = vec![
        "lsjson".to_string(),
        format!("{}:", prefs.remote_name),
        "--drive-root-folder-id".to_string(),
        root_folder_id.to_string(),
        "--drive-service-account-file".to_string(),
        sa_path.to_string_lossy().to_string(),
    ];
    match mode {
        LsMode::RecursiveFiles => {
            args.push("-R".to_string());
            args.push("--files-only".to_string());
        }
        LsMode::TopLevel | LsMode::TopLevelDirs => {
            args.push("--max-depth".to_string());
            args.push("1".to_string());
            if mode == LsMode::TopLevelDirs {
                args.push("--dirs-only".to_string());
            }
        }
    }

    let mut command = build_rclone_command(&prefs.rclone_path, &args);
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "Timed out listing Drive.".to_string())?
        .map_err(|e| format!("Failed to run rclone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().rev().take(2).collect::<Vec<_>>().join("; ");
        return Err(if detail.trim().is_empty() {
            "Could not list the destination folder.".to_string()
        } else {
            format!("Could not list the destination folder: {}", detail.trim())
        });
    }

    serde_json::from_slice::<Vec<LsJsonEntry>>(&output.stdout)
        .map_err(|e| format!("Could not read the Drive listing: {e}"))
}

/// Looks up the Drive IDs for an uploaded item so the UI can offer share links.
///
/// rclone does not report the IDs it creates, so they have to be listed back
/// out of Drive. A folder is resolvable as soon as rclone has created it, which
/// is why folder links can be copied mid-upload; a single file only exists once
/// its upload finishes.
pub async fn resolve_item_links(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    destination_folder_id: &str,
    path: &str,
    kind: &str,
) -> Result<ItemLinks, String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();

    let top = run_lsjson(prefs, &sa.path, destination_folder_id, LsMode::TopLevel).await?;
    let Some(entry) = top.into_iter().find(|entry| entry.name == name) else {
        return Ok(ItemLinks::default());
    };
    let Some(id) = entry.id else {
        return Ok(ItemLinks::default());
    };

    if kind != "folder" || !entry.is_dir {
        return Ok(ItemLinks {
            folder_id: None,
            files: vec![DriveFileLink {
                file_path: name,
                file_id: id,
            }],
        });
    }

    // Scope the recursive listing to the uploaded folder rather than walking the
    // whole destination, which may hold plenty of unrelated content.
    let files = run_lsjson(prefs, &sa.path, &id, LsMode::RecursiveFiles)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.is_dir)
        .filter_map(|entry| {
            entry.id.map(|file_id| DriveFileLink {
                file_path: entry.path,
                file_id,
            })
        })
        .collect();

    Ok(ItemLinks {
        folder_id: Some(id),
        files,
    })
}

/// A folder the destination browser can show: a shared drive, or a folder
/// inside one.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    /// Drive folder ID, usable directly as an upload destination.
    pub id: String,
    pub name: String,
}

/// One entry of `rclone backend drives remote:`.
#[derive(Debug, Deserialize)]
struct SharedDriveEntry {
    #[serde(rename = "id")]
    id: String,
    #[serde(rename = "name")]
    name: String,
}

/// Shared drives the service accounts can reach.
///
/// This is the root of the destination browser: a service account has its own
/// empty My Drive, so the only folders worth browsing are the shared drives it
/// has been granted access to.
pub async fn list_shared_drives(
    prefs: &RclonePreferences,
    service_account_folder: &str,
) -> Result<Vec<RemoteFolder>, String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let args = vec![
        "backend".to_string(),
        "drives".to_string(),
        format!("{}:", prefs.remote_name),
        "--drive-service-account-file".to_string(),
        sa.path.to_string_lossy().to_string(),
    ];

    let mut command = build_rclone_command(&prefs.rclone_path, &args);
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "Timed out listing shared drives.".to_string())?
        .map_err(|e| format!("Failed to run rclone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().rev().take(2).collect::<Vec<_>>().join("; ");
        return Err(if detail.trim().is_empty() {
            "Could not list shared drives.".to_string()
        } else {
            format!("Could not list shared drives: {}", detail.trim())
        });
    }

    let drives: Vec<SharedDriveEntry> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Could not read the shared drive listing: {e}"))?;

    Ok(drives
        .into_iter()
        .map(|drive| RemoteFolder {
            id: drive.id,
            name: drive.name,
        })
        .collect())
}

/// One row of the browser's contents pane.
///
/// Files are carried alongside folders so the pane can show what is actually in
/// a folder. Only folders are selectable as a destination; the files are there
/// to confirm you are in the right place.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    /// Bytes. None for a folder - Drive does not report a folder's size without
    /// walking everything inside it, which is far too expensive here.
    pub size: Option<u64>,
    /// RFC 3339, straight from rclone.
    pub modified_at: Option<String>,
}

/// Everything inside one Drive folder: folders first, then files, each group
/// by name.
///
/// Kept separate from `list_remote_folders` on purpose. The tree only ever
/// needs folders, and asking Drive for a full listing there would make
/// expanding a folder full of files needlessly slow.
pub async fn list_remote_entries(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    folder_id: &str,
) -> Result<Vec<RemoteEntry>, String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let mut entries: Vec<RemoteEntry> = run_lsjson(prefs, &sa.path, folder_id, LsMode::TopLevel)
        .await?
        .into_iter()
        .filter_map(|entry| {
            let id = entry.id?;
            Some(RemoteEntry {
                id,
                name: entry.name,
                is_dir: entry.is_dir,
                size: if entry.is_dir {
                    None
                } else {
                    entry.size.and_then(|size| u64::try_from(size).ok())
                },
                modified_at: entry.mod_time,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Subfolders of a Drive folder, so the browser can descend one level at a
/// time instead of walking a whole drive up front.
pub async fn list_remote_folders(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    folder_id: &str,
) -> Result<Vec<RemoteFolder>, String> {
    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let mut folders: Vec<RemoteFolder> =
        run_lsjson(prefs, &sa.path, folder_id, LsMode::TopLevelDirs)
            .await?
            .into_iter()
            .filter(|entry| entry.is_dir)
            .filter_map(|entry| {
                entry.id.map(|id| RemoteFolder {
                    id,
                    name: entry.name,
                })
            })
            .collect();

    // Drive returns folders in an order of its own; the picker reads better
    // alphabetically, the way a file browser lists them.
    folders.sort_by_key(|folder| folder.name.to_lowercase());
    Ok(folders)
}

/// One entry of `rclone backend query`, which returns raw Drive file objects.
#[derive(Debug, Deserialize)]
struct DriveQueryEntry {
    id: Option<String>,
    name: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

const DRIVE_FOLDER_MIME: &str = "application/vnd.google-apps.folder";

/// Keeps the search term inside its quoted literal. Drive's query language
/// escapes with backslashes, so a folder called `Bob's` would otherwise close
/// the string early and produce a syntax error rather than a result.
fn escape_drive_query_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Most matches anyone scrolls through. A two-letter search can match thousands
/// of folders; the UI says when it hit this ceiling.
pub const MAX_SEARCH_RESULTS: usize = 200;

/// Finds folders anywhere in one shared drive whose name matches `query`.
///
/// Drive does the searching, so a drive with thousands of folders answers about
/// as fast as an empty one - walking the tree with recursive listings would
/// take a call per folder. `--drive-team-drive` is what scopes the search to
/// the drive: rclone only asks the API for `corpora=drive` when that option is
/// set, and without it the search does not reach shared drives at all.
///
/// Note that Drive's `contains` matches from the start of a word rather than
/// anywhere in the name, so "Ato" finds "Atomic" but "tomic" does not. That is
/// the API's behaviour, not a filter applied here.
/// Name of a single Drive folder, given only its ID.
///
/// Browsing already knows the name, but a pasted link carries nothing but an
/// ID. `lsjson --stat` against the folder as its own root returns the entry for
/// that folder, which is the cheapest way to put a human label on it.
///
/// Failure is not an error worth surfacing: the sidebar simply keeps showing
/// the ID, so this returns None rather than propagating.
pub async fn resolve_folder_name(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    folder_id: &str,
) -> Option<String> {
    let sa_files = load_service_account_files(service_account_folder).ok()?;
    let sa = sa_files.first()?;

    let args = vec![
        "lsjson".to_string(),
        format!("{}:", prefs.remote_name),
        "--stat".to_string(),
        "--drive-root-folder-id".to_string(),
        folder_id.to_string(),
        "--drive-service-account-file".to_string(),
        sa.path.to_string_lossy().to_string(),
    ];

    let output = run_rclone_to_completion(prefs, &args, Duration::from_secs(30))
        .await
        .ok()?;
    if !output.status.success() {
        log::debug!(
            target: "rclone",
            "destination.name_unresolved id={} detail={}",
            folder_id,
            describe_command_failure(&output)
        );
        return None;
    }

    let entry: LsJsonEntry = serde_json::from_slice(&output.stdout).ok()?;
    let name = entry.name.trim();
    if name.is_empty() || name == "/" {
        return None;
    }
    Some(name.to_string())
}

pub async fn search_remote_folders(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    drive_id: &str,
    query: &str,
) -> Result<Vec<RemoteFolder>, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let sa_files = load_service_account_files(service_account_folder)?;
    let sa = sa_files
        .first()
        .ok_or("No valid service account JSON files found in the selected folder.")?;

    let drive_query = format!(
        "name contains '{}' and mimeType = '{DRIVE_FOLDER_MIME}' and trashed = false",
        escape_drive_query_value(needle)
    );

    let args = vec![
        "backend".to_string(),
        "query".to_string(),
        format!("{}:", prefs.remote_name),
        drive_query,
        "--drive-service-account-file".to_string(),
        sa.path.to_string_lossy().to_string(),
        "--drive-team-drive".to_string(),
        drive_id.to_string(),
    ];

    let output = run_rclone_to_completion(prefs, &args, Duration::from_secs(60)).await?;

    if !output.status.success() {
        let detail = describe_command_failure(&output);
        return Err(if detail.is_empty() {
            "Could not search this drive.".to_string()
        } else {
            format!("Could not search this drive: {detail}")
        });
    }

    let entries: Vec<DriveQueryEntry> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Could not read the search results: {e}"))?;

    let mut folders: Vec<RemoteFolder> = entries
        .into_iter()
        .filter(|entry| entry.mime_type.as_deref() == Some(DRIVE_FOLDER_MIME))
        .filter_map(|entry| {
            let id = entry.id?;
            let name = entry.name?;
            Some(RemoteFolder { id, name })
        })
        .collect();

    folders.sort_by_key(|folder| folder.name.to_lowercase());
    folders.truncate(MAX_SEARCH_RESULTS);
    Ok(folders)
}

/// The `--exclude` flags for the configured patterns.
fn exclude_args(prefs: &RclonePreferences) -> Vec<String> {
    prefs
        .exclude_patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .flat_map(|pattern| ["--exclude".to_string(), pattern.to_string()])
        .collect()
}

/// Where an item lands: a folder under its own name inside the destination, a
/// file directly in it.
fn remote_target(prefs: &RclonePreferences, item: &QueueItemInput) -> String {
    let folder = if item.kind == "folder" {
        Path::new(&item.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("folder")
    } else {
        ""
    };
    format!("{}:{}", prefs.remote_name, folder)
}

fn build_rclone_args(
    prefs: &RclonePreferences,
    item: &QueueItemInput,
    sa_path: &Path,
    files_from: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "copy".to_string(),
        item.path.clone(),
        remote_target(prefs, item),
        "--drive-root-folder-id".to_string(),
        item.destination_folder_id.clone(),
        // Kept deliberately close to rclone's own defaults.
        //
        // A previous round of "tuning" added --drive-upload-cutoff, an
        // aggressive pacer (--drive-pacer-min-sleep 10ms / --drive-pacer-burst
        // 200) and --fast-list on the theory that each would raise throughput.
        // In practice the build without any of them uploaded faster, so they
        // are gone. Drive rate-limits per account; pushing the pacer harder
        // invites 403 rateLimitExceeded and the backoff that follows, which
        // costs more than the extra calls gain.
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

    // rclone rejects `--exclude` next to `--files-from-raw`, so a fan-out
    // group's list arrives with the patterns already applied (see
    // `files_surviving_excludes`) and only a single process passes them.
    match files_from {
        Some(files_from) => {
            args.push("--files-from-raw".to_string());
            args.push(files_from.to_string_lossy().to_string());
        }
        None => args.extend(exclude_args(prefs)),
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
            slow_marks: 0,
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

    // Least recently used, except that an account which has crawled comes
    // after every account that has not. See `mark_slow`.
    let best_idx = guard
        .iter()
        .enumerate()
        .min_by_key(|(_, entry)| (entry.slow_marks, entry.last_used))
        .map(|(idx, _)| idx)
        .expect("pool is not empty");

    let next = tick.fetch_add(1, Ordering::Relaxed) + 1;
    guard[best_idx].last_used = next;

    let entry = &guard[best_idx];
    Ok((entry.path.clone(), entry.email.clone()))
}

/// Notes that a process on this account was restarted for crawling, so
/// `select_service_account` reaches for it only once every account with fewer
/// such marks has been tried.
async fn mark_slow(pool: &Arc<Mutex<Vec<ServiceAccountFile>>>, sa_path: &Path) {
    let mut guard = pool.lock().await;
    if let Some(entry) = guard.iter_mut().find(|entry| entry.path == sa_path) {
        entry.slow_marks += 1;
        log::info!(
            target: "rclone",
            "sa.marked_slow sa={} marks={}",
            entry.path.to_string_lossy(),
            entry.slow_marks
        );
    }
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

/// Current speed rclone reports for one `transferring` entry. `speedAvg` is
/// the exponentially weighted moving average ("current" speed); `speed` is the
/// whole-transfer average and only used as a fallback.
fn transfer_entry_speed(entry: &Value) -> u64 {
    entry
        .get("speedAvg")
        .and_then(|v| v.as_f64())
        .or_else(|| entry.get("speed").and_then(|v| v.as_f64()))
        .map(|v| v.max(0.0).round() as u64)
        .unwrap_or(0)
}

fn parse_json_progress(line: &str, path: &str, kind: &str) -> Option<(u64, u64, Option<u64>)> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;

    // The item's current speed is the sum of the per-file moving averages on
    // this same stats line, so the parent row always matches its children.
    let transferring = stats.get("transferring").and_then(|v| v.as_array());
    let speed = Some(
        transferring
            .map(|entries| entries.iter().map(transfer_entry_speed).sum())
            .unwrap_or(0),
    );

    // For a single-file item the matching `transferring` entry is more precise
    // than the aggregate (which can include retried bytes). Folders must use
    // the aggregate: picking a lone transferring entry used to overwrite the
    // whole folder's progress with one file's bytes whenever only one file was
    // left mid-flight, which corrupted the parent progress bar and speed.
    if kind == "file" {
        let file_name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);

        if let Some(transferring) = transferring {
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
                        return Some((bytes, total, speed));
                    }
                }
            }

            if transferring.len() == 1 {
                let entry = &transferring[0];
                let bytes = entry.get("bytes").and_then(|v| v.as_u64())?;
                let total = entry.get("size").and_then(|v| v.as_u64())?;
                return Some((bytes, total, speed));
            }
        }
    }

    let bytes = stats.get("bytes").and_then(|v| v.as_u64())?;
    let total = stats.get("totalBytes").and_then(|v| v.as_u64())?;
    Some((bytes, total, speed))
}

/// The `transferring` entries of a stats line as (name, bytes, size, speed).
/// Some and empty for a stats line with nothing in flight, None for any other
/// line, so a caller can tell "nothing moving" from "not a stats line".
fn parse_json_file_progress(line: &str) -> Option<Vec<(String, u64, u64, u64)>> {
    if !line.trim_start().starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let stats = value.get("stats")?;
    let mut entries = Vec::new();
    let Some(transferring) = stats.get("transferring").and_then(|v| v.as_array()) else {
        return Some(entries);
    };
    for entry in transferring {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("path").and_then(|v| v.as_str()))
            .or_else(|| entry.get("object").and_then(|v| v.as_str()));
        let bytes = entry.get("bytes").and_then(|v| v.as_u64());
        let total = entry.get("size").and_then(|v| v.as_u64());
        if let (Some(name), Some(bytes), Some(total)) = (name, bytes, total) {
            entries.push((name.to_string(), bytes, total, transfer_entry_speed(entry)));
        }
    }
    Some(entries)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_quotes_in_a_search_term() {
        // A folder called "Bob's" would otherwise close the quoted literal and
        // turn the search into a Drive query syntax error.
        assert_eq!(escape_drive_query_value("Bob's"), r"Bob\'s");
        assert_eq!(escape_drive_query_value(r"back\slash"), r"back\\slash");
        assert_eq!(escape_drive_query_value("plain"), "plain");
    }

    const STATS_LINE: &str = r#"{"level":"info","msg":"","stats":{"bytes":3000,"totalBytes":10000,"transferring":[{"name":"a.mkv","bytes":1000,"size":4000,"speed":50.0,"speedAvg":100.4},{"name":"b.mkv","bytes":2000,"size":6000,"speed":75.0,"speedAvg":200.0}]}}"#;

    #[test]
    fn folder_progress_uses_the_aggregate_and_sums_file_speeds() {
        let (bytes, total, speed) =
            parse_json_progress(STATS_LINE, "/movies/Flyboys (2006)", "folder").unwrap();
        assert_eq!((bytes, total), (3000, 10000));
        assert_eq!(speed, Some(300));
    }

    #[test]
    fn folder_progress_ignores_a_lone_transferring_entry() {
        // With one file left mid-flight the folder's progress used to be
        // overwritten with that file's bytes, corrupting the parent row.
        let line = r#"{"stats":{"bytes":9000,"totalBytes":10000,"transferring":[{"name":"a.mkv","bytes":1000,"size":4000,"speedAvg":100.0}]}}"#;
        let (bytes, total, speed) =
            parse_json_progress(line, "/movies/Flyboys (2006)", "folder").unwrap();
        assert_eq!((bytes, total), (9000, 10000));
        assert_eq!(speed, Some(100));
    }

    #[test]
    fn file_progress_matches_its_transferring_entry() {
        let (bytes, total, speed) =
            parse_json_progress(STATS_LINE, "/movies/a.mkv", "file").unwrap();
        assert_eq!((bytes, total), (1000, 4000));
        assert_eq!(speed, Some(300));
    }

    #[test]
    fn per_file_progress_includes_the_moving_average_speed() {
        let entries = parse_json_file_progress(STATS_LINE).unwrap();
        assert_eq!(
            entries,
            vec![
                ("a.mkv".to_string(), 1000, 4000, 100),
                ("b.mkv".to_string(), 2000, 6000, 200),
            ]
        );
    }

    #[test]
    fn progress_without_transferring_reports_zero_speed() {
        // Finalize/checking phase: nothing is moving, so the truthful current
        // speed is zero rather than a stale value.
        let line = r#"{"stats":{"bytes":10000,"totalBytes":10000}}"#;
        let (_, _, speed) = parse_json_progress(line, "/movies/x", "folder").unwrap();
        assert_eq!(speed, Some(0));
    }

    #[test]
    fn partition_files_splits_into_relative_forward_slash_paths() {
        let files = vec![
            FileListEntry {
                file_path: "/root/a.mkv".to_string(),
                total_bytes: 100,
            },
            FileListEntry {
                file_path: "/root/b.mkv".to_string(),
                total_bytes: 200,
            },
            FileListEntry {
                file_path: "/root/sub/c.mkv".to_string(),
                total_bytes: 300,
            },
        ];
        // Units largest-first (sub=300, b=200, a=100), each to the group with
        // the least work so far.
        let groups = partition_files(Path::new("/root"), &files, 2).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], vec!["sub/c.mkv".to_string()]);
        assert_eq!(groups[1], vec!["b.mkv".to_string(), "a.mkv".to_string()]);
    }

    #[test]
    fn partition_files_never_splits_a_subfolder() {
        // Two processes creating the same new subfolder at once each create
        // their own in Drive, so a subfolder is one unit however big it is.
        let files = vec![
            FileListEntry {
                file_path: "/root/Subs/a.srt".to_string(),
                total_bytes: 400,
            },
            FileListEntry {
                file_path: "/root/Subs/deep/b.srt".to_string(),
                total_bytes: 400,
            },
            FileListEntry {
                file_path: "/root/c.mkv".to_string(),
                total_bytes: 300,
            },
            FileListEntry {
                file_path: "/root/d.mkv".to_string(),
                total_bytes: 100,
            },
        ];
        let groups = partition_files(Path::new("/root"), &files, 3).unwrap();
        assert_eq!(
            groups,
            vec![
                vec!["Subs/a.srt".to_string(), "Subs/deep/b.srt".to_string()],
                vec!["c.mkv".to_string()],
                vec!["d.mkv".to_string()],
            ]
        );

        // Everything inside one subfolder is one unit, so there is nothing to
        // fan out: one group, which the planner turns into a single process.
        let nested: Vec<FileListEntry> = files[..2].to_vec();
        let groups = partition_files(Path::new("/root"), &nested, 3).unwrap();
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn a_restarted_group_keeps_its_original_total() {
        // Before the restart: 800 of 1000 sent, of which one 300-byte file
        // was complete and a 700-byte file was 500 in. The new process counts
        // only the 700-byte file, from zero.
        let frozen = (800, 1000, None);
        // First stats line: nothing listed yet. Repeat the last reading rather
        // than claim the whole difference as sent.
        assert_eq!(carried_reading(1000, frozen, 0, 0), (800, 1000));
        // Listed: the 300 already at Drive count as sent, the rest from zero.
        assert_eq!(carried_reading(1000, frozen, 0, 700), (300, 1000));
        assert_eq!(carried_reading(1000, frozen, 650, 700), (950, 1000));
        // rclone found more than the original list: trust it.
        assert_eq!(carried_reading(1000, frozen, 10, 1200), (10, 1200));
    }

    /// A stats line as rclone v1.75.1 really prints it (`--use-json-log
    /// --stats 1s`), so the field names the watchdog relies on are the real
    /// ones rather than a guess.
    const REAL_STATS_LINE: &str = r#"{"time":"2026-09-17T22:14:15.255203+05:45","level":"info","msg":"","stats":{"bytes":262144,"checks":0,"deletedDirs":0,"deletes":0,"elapsedTime":1.00163725,"errors":0,"eta":2,"fatalError":false,"listed":4,"renames":0,"retryError":false,"serverSideCopies":0,"serverSideCopyBytes":0,"serverSideMoveBytes":0,"serverSideMoves":0,"speed":262139.69671473873,"totalBytes":800000,"totalChecks":0,"totalTransfers":2,"transferTime":1.001194417,"transferring":[{"bytes":131072,"dstFs":"dst2/Nimrods (2025)","eta":1,"group":"global_stats","name":"Nimrods.2025.1080p.mkv","percentage":43,"size":300000,"speed":130941.74020437861,"speedAvg":131070.15964388844,"srcFs":"src/Nimrods (2025)"},{"bytes":131072,"dstFs":"dst2/Nimrods (2025)","eta":2,"group":"global_stats","name":"Nimrods.2025.2160p.mkv","percentage":26,"size":500000,"speed":130941.40781292172,"speedAvg":131070.03945434986,"srcFs":"src/Nimrods (2025)"}],"transfers":0},"source":"accounting/stats.go:549"}"#;

    #[test]
    fn real_stats_lines_feed_the_speed_watch() {
        use crate::upload::speed_watch::{SpeedWatch, Transfer, CRAWL_WINDOW};
        use std::time::Instant;

        let entries = parse_json_file_progress(REAL_STATS_LINE).expect("a stats line");
        assert_eq!(entries.len(), 2);
        let transfers: Vec<Transfer<'_>> = entries
            .iter()
            .map(|(name, bytes, size, _)| Transfer {
                name,
                bytes: *bytes,
                size: *size,
            })
            .collect();
        assert_eq!(transfers[0].name, "Nimrods.2025.1080p.mkv");
        assert_eq!((transfers[0].bytes, transfers[0].size), (131072, 300000));
        assert_eq!((transfers[1].bytes, transfers[1].size), (131072, 500000));

        // Two readings of a real line with no yardstick yet: a first window
        // never triggers a restart.
        let watch = SpeedWatch::new();
        let stream = watch.open_stream();
        let now = Instant::now();
        assert!(!watch.observe(stream, &transfers, now));
        assert!(!watch.observe(stream, &transfers, now + CRAWL_WINDOW));
    }

    #[test]
    fn a_stats_line_with_nothing_in_flight_is_still_a_stats_line() {
        let line = r#"{"stats":{"bytes":10000,"totalBytes":10000}}"#;
        assert_eq!(parse_json_file_progress(line), Some(Vec::new()));
        assert_eq!(
            parse_json_file_progress(r#"{"level":"info","msg":"x"}"#),
            None
        );
    }

    #[test]
    fn partition_files_caps_the_number_of_groups() {
        let files = vec![
            FileListEntry {
                file_path: "/root/a.mkv".to_string(),
                total_bytes: 1,
            },
            FileListEntry {
                file_path: "/root/b.mkv".to_string(),
                total_bytes: 1,
            },
        ];
        let groups = partition_files(Path::new("/root"), &files, 10).unwrap();
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn partition_files_rejects_a_file_outside_the_root() {
        let files = vec![FileListEntry {
            file_path: "/elsewhere/a.mkv".to_string(),
            total_bytes: 1,
        }];
        assert!(partition_files(Path::new("/root"), &files, 2).is_err());
    }

    #[test]
    fn partition_files_refuses_a_name_with_a_line_break() {
        // One path per line: a break inside a name would become two paths that
        // match nothing, so the folder has to go through a single process.
        let files = vec![
            FileListEntry {
                file_path: "/root/a.mkv".to_string(),
                total_bytes: 1,
            },
            FileListEntry {
                file_path: "/root/odd\nname.mkv".to_string(),
                total_bytes: 1,
            },
        ];
        assert!(partition_files(Path::new("/root"), &files, 2).is_err());
    }

    #[test]
    fn files_from_writes_one_path_per_line() {
        // rclone splits `--files-from-raw` on newlines. A NUL-separated list
        // used to be read as one path that matched nothing, and rclone then
        // reported a successful copy of zero files.
        let path = write_files_from(&["a.mkv".to_string(), "sub/b.mkv".to_string()]).unwrap();
        let contents = std::fs::read(&path).unwrap();
        assert_eq!(contents, b"a.mkv\nsub/b.mkv\n");
        std::fs::remove_file(&path).unwrap();
    }

    fn test_prefs(exclude_patterns: &[&str]) -> RclonePreferences {
        RclonePreferences {
            rclone_path: "rclone".to_string(),
            remote_name: "gdrive".to_string(),
            drive_chunk_size_mib: 128,
            transfers: 4,
            checkers: 8,
            retries: 3,
            bandwidth_limit: String::new(),
            exclude_patterns: exclude_patterns.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn test_item() -> QueueItemInput {
        QueueItemInput {
            id: "item".to_string(),
            path: "/movies/Flyboys (2006)".to_string(),
            kind: "folder".to_string(),
            destination_folder_id: "FOLDER".to_string(),
        }
    }

    #[test]
    fn single_process_args_carry_the_exclude_patterns() {
        let args = build_rclone_args(
            &test_prefs(&[".DS_Store", " ", "**/node_modules/**"]),
            &test_item(),
            Path::new("/sa/one.json"),
            None,
        );
        let excludes: Vec<&str> = args
            .windows(2)
            .filter(|pair| pair[0] == "--exclude")
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(excludes, vec![".DS_Store", "**/node_modules/**"]);
        assert!(!args.iter().any(|arg| arg == "--files-from-raw"));
    }

    #[test]
    fn fanout_args_carry_the_file_list_and_no_excludes() {
        // rclone refuses the two together, so a fan-out group's list is
        // pre-filtered and the patterns must not be passed again.
        let args = build_rclone_args(
            &test_prefs(&[".DS_Store"]),
            &test_item(),
            Path::new("/sa/one.json"),
            Some(Path::new("/tmp/list.txt")),
        );
        let position = args
            .iter()
            .position(|arg| arg == "--files-from-raw")
            .expect("file list flag present");
        assert_eq!(args[position + 1], "/tmp/list.txt");
        assert!(!args.iter().any(|arg| arg == "--exclude"));
    }
}
