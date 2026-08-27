use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStatusEvent {
    pub item_id: String,
    pub path: String,
    pub kind: String,
    pub status: String,
    pub message: Option<String>,
    pub sa_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub item_id: String,
    pub path: String,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    /// rclone's own measurement (sum of the per-file moving averages). None
    /// when progress came from a source that does not report speed, in which
    /// case the frontend falls back to computing it from byte deltas.
    pub speed_bytes_per_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgressEvent {
    pub item_id: String,
    pub file_path: String,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    /// rclone's moving-average speed for this file, when reported.
    pub speed_bytes_per_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListEntry {
    pub file_path: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListEvent {
    pub item_id: String,
    pub files: Vec<FileListEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedEvent {
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
    /// Items stopped by a cancel. Counted apart from `failed` so the summary
    /// adds up and cancelling does not look like an error.
    pub canceled: u32,
}
