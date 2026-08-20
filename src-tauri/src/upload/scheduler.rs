use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Clone)]
pub struct UploadControlHandle {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub pause_rx: watch::Receiver<bool>,
    pub paused_items_rx: watch::Receiver<HashSet<String>>,
}

impl UploadControlHandle {
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Error text used when an item stops because the whole job was cancelled.
/// Cancellation is not a failure, so it is reported separately.
pub const CANCELED: &str = "Upload canceled";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemInput {
    pub id: String,
    pub path: String,
    pub kind: String,
    /// Drive folder this item uploads into. Carried per item so one run can
    /// fan out to several destinations; the frontend falls back to the global
    /// destination when a row has none of its own.
    pub destination_folder_id: String,
}

/// Running totals for the job.
///
/// The worker pool used to be handed a fixed `Vec` and exited once it drained,
/// which is why starting a second batch had to cancel the first. Workers now
/// sit on a channel that stays open for the lifetime of the job, so completion
/// can no longer be inferred from "all workers returned". `outstanding` tracks
/// items accepted but not yet finished; the batch is done when it reaches zero.
#[derive(Debug, Default)]
pub struct JobTallies {
    pub outstanding: AtomicUsize,
    pub total: AtomicUsize,
    pub succeeded: AtomicUsize,
    pub failed: AtomicUsize,
    pub canceled: AtomicUsize,
}

impl JobTallies {
    /// Called as each item is accepted onto the queue.
    pub fn record_enqueued(&self) {
        self.outstanding.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
    }

    /// Called once an item settles. Returns true when this was the last
    /// outstanding item, meaning the batch just finished.
    ///
    /// Uses compare-exchange rather than `fetch_sub` so a spurious call with
    /// nothing outstanding cannot wrap the counter to `usize::MAX` and strand
    /// the job in a state where completion is never reported again.
    pub fn record_finished(&self) -> bool {
        let mut current = self.outstanding.load(Ordering::Acquire);
        loop {
            if current == 0 {
                debug_assert!(false, "record_finished with no outstanding items");
                return false;
            }
            match self.outstanding.compare_exchange_weak(
                current,
                current - 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return current == 1,
                Err(actual) => current = actual,
            }
        }
    }

    pub fn snapshot(&self) -> (u32, u32, u32, u32) {
        (
            self.total.load(Ordering::Relaxed) as u32,
            self.succeeded.load(Ordering::Relaxed) as u32,
            self.failed.load(Ordering::Relaxed) as u32,
            self.canceled.load(Ordering::Relaxed) as u32,
        )
    }

    /// Clear the per-batch tallies so the next batch reports its own numbers
    /// rather than accumulating across an app session.
    pub fn reset(&self) {
        self.total.store(0, Ordering::Relaxed);
        self.succeeded.store(0, Ordering::Relaxed);
        self.failed.store(0, Ordering::Relaxed);
        self.canceled.store(0, Ordering::Relaxed);
    }
}

pub async fn wait_if_paused(control: &UploadControlHandle, item_id: &str) -> Result<(), String> {
    if control.is_canceled() {
        return Err(CANCELED.to_string());
    }

    let mut pause_all_rx = control.pause_rx.clone();
    let mut paused_items_rx = control.paused_items_rx.clone();

    let is_blocked = *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id);
    if !is_blocked {
        return Ok(());
    }

    while *pause_all_rx.borrow() || paused_items_rx.borrow().contains(item_id) {
        if control.is_canceled() {
            return Err(CANCELED.to_string());
        }
        tokio::select! {
            r = pause_all_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
            r = paused_items_rx.changed() => {
                r.map_err(|_| "Pause channel closed".to_string())?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_completion_only_on_the_last_item() {
        let tallies = JobTallies::default();
        tallies.record_enqueued();
        tallies.record_enqueued();

        assert!(!tallies.record_finished(), "first of two is not the last");
        assert!(
            tallies.record_finished(),
            "second of two finishes the batch"
        );
    }

    #[test]
    fn items_appended_mid_batch_extend_it() {
        let tallies = JobTallies::default();
        tallies.record_enqueued();

        // A second item arrives while the first is still running, which is what
        // happens when the user adds to a queue that is already uploading.
        tallies.record_enqueued();
        assert!(!tallies.record_finished());
        assert!(tallies.record_finished());
        assert_eq!(tallies.snapshot().0, 2, "both items counted in the total");
    }

    #[test]
    fn reset_clears_tallies_but_not_outstanding() {
        let tallies = JobTallies::default();
        tallies.record_enqueued();
        tallies.succeeded.fetch_add(1, Ordering::Relaxed);
        assert!(tallies.record_finished());

        tallies.reset();
        assert_eq!(tallies.snapshot(), (0, 0, 0, 0));

        // A fresh batch after a reset reports its own numbers.
        tallies.record_enqueued();
        assert!(tallies.record_finished());
        assert_eq!(tallies.snapshot().0, 1);
    }

    #[test]
    fn finishing_with_nothing_outstanding_does_not_wrap() {
        let tallies = JobTallies::default();
        // `debug_assert` would fire in a debug build, so only the release
        // behaviour is asserted here: the counter must stay at zero.
        if cfg!(not(debug_assertions)) {
            assert!(!tallies.record_finished());
        }
        assert_eq!(tallies.outstanding.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn queue_item_carries_its_own_destination() {
        let json =
            r#"{"id":"a","path":"/tmp/a","kind":"folder","destinationFolderId":"FOLDER123"}"#;
        let item: QueueItemInput = serde_json::from_str(json).expect("deserializes");
        assert_eq!(item.destination_folder_id, "FOLDER123");
    }
}
