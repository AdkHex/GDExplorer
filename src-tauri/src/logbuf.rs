//! In-memory ring buffer of log records.
//!
//! Everything the app logs - including every line rclone writes, which is
//! emitted with `target: "rclone"` - is mirrored here so the log panel can show
//! it without reading the log file back off disk. The buffer is a process-wide
//! global because `tauri_plugin_log` builds its targets before there is an
//! `AppHandle` to hang state off.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// rclone emits a stats line every second for every running transfer, so this
/// cap is what bounds memory during a long batch. Oldest entries drop first.
const MAX_ENTRIES: usize = 5_000;

/// Keeps one pathological line (a stack trace, a huge JSON blob) from sitting
/// in memory - and being re-sent on every poll - in full.
const MAX_MESSAGE_LEN: usize = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Monotonic within a process run. The panel polls with the highest one it
    /// has already received, so entries are never fetched twice.
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSnapshot {
    pub entries: Vec<LogEntry>,
    /// Sequence of the oldest entry still buffered. A caller whose cursor is
    /// older than this knows lines were dropped rather than silently missing.
    pub oldest_seq: u64,
    /// Sequence of the newest entry, or 0 when nothing has been logged.
    pub latest_seq: u64,
}

#[derive(Default)]
struct Buffer {
    entries: VecDeque<LogEntry>,
    next_seq: u64,
}

fn buffer() -> &'static Mutex<Buffer> {
    static BUFFER: OnceLock<Mutex<Buffer>> = OnceLock::new();
    BUFFER.get_or_init(|| {
        Mutex::new(Buffer {
            entries: VecDeque::new(),
            // Sequences start at 1 so a cursor of 0 means "nothing seen yet".
            next_seq: 1,
        })
    })
}

fn level_name(level: log::Level) -> &'static str {
    match level {
        log::Level::Trace => "trace",
        log::Level::Debug => "debug",
        log::Level::Info => "info",
        log::Level::Warn => "warn",
        log::Level::Error => "error",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Drops the `[date][time][target][LEVEL]` prefix `tauri_plugin_log` adds
/// before a record reaches its targets. The panel shows those as their own
/// columns, so keeping the prefix would print each of them twice.
///
/// Only strips a prefix that really is the plugin's: the fourth group has to be
/// this record's level, otherwise the brackets belong to the message.
fn strip_plugin_prefix(message: &str, level: log::Level) -> &str {
    let mut rest = message;
    let mut groups = 0;

    while groups < 4 && rest.starts_with('[') {
        let Some(end) = rest.find(']') else { break };
        let group = &rest[1..end];
        rest = rest[end + 1..].trim_start();
        groups += 1;

        if groups == 4 {
            return if group.eq_ignore_ascii_case(level.as_str()) {
                rest
            } else {
                message
            };
        }
    }

    message
}

pub fn push(level: log::Level, target: &str, message: &str) {
    let trimmed = strip_plugin_prefix(message.trim(), level).trim();
    if trimmed.is_empty() {
        return;
    }

    let message = if trimmed.chars().count() > MAX_MESSAGE_LEN {
        trimmed.chars().take(MAX_MESSAGE_LEN).collect::<String>() + "…"
    } else {
        trimmed.to_string()
    };

    // A poisoned buffer must not take the logger - and with it the app - down,
    // so a failed lock just drops the line.
    let Ok(mut buffer) = buffer().lock() else {
        return;
    };

    let seq = buffer.next_seq;
    buffer.next_seq += 1;
    buffer.entries.push_back(LogEntry {
        seq,
        timestamp_ms: now_ms(),
        level: level_name(level).to_string(),
        target: target.to_string(),
        message,
    });

    while buffer.entries.len() > MAX_ENTRIES {
        buffer.entries.pop_front();
    }
}

/// Entries newer than `after_seq`, newest-last and capped at `limit`.
pub fn snapshot(after_seq: u64, limit: usize) -> LogSnapshot {
    let Ok(buffer) = buffer().lock() else {
        return LogSnapshot {
            entries: Vec::new(),
            oldest_seq: 0,
            latest_seq: 0,
        };
    };

    let latest_seq = buffer.next_seq.saturating_sub(1);
    let oldest_seq = buffer.entries.front().map(|e| e.seq).unwrap_or(latest_seq);

    let mut entries: Vec<LogEntry> = buffer
        .entries
        .iter()
        .filter(|entry| entry.seq > after_seq)
        .cloned()
        .collect();

    // Over the limit means the panel fell behind; keep the newest lines, which
    // are the ones worth showing.
    if entries.len() > limit {
        entries.drain(0..entries.len() - limit);
    }

    LogSnapshot {
        entries,
        oldest_seq,
        latest_seq,
    }
}

/// Empties the buffer. Sequences keep counting up so an in-flight cursor can
/// never be satisfied by a re-used sequence number.
pub fn clear() {
    if let Ok(mut buffer) = buffer().lock() {
        buffer.entries.clear();
    }
}

/// `log::Log` sink handed to `tauri_plugin_log` as a dispatch target, so the
/// buffer sees the same records as stdout and the log file.
pub struct BufferLogger;

impl log::Log for BufferLogger {
    fn enabled(&self, _metadata: &log::Metadata<'_>) -> bool {
        // Level filtering already happened upstream in the plugin's dispatch.
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        push(record.level(), record.target(), &record.args().to_string());
    }

    fn flush(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The buffer is a process-wide global, so the tests share it. They run in
    /// one function to keep them deterministic under the test harness's
    /// threads.
    #[test]
    fn buffers_entries_and_serves_them_by_cursor() {
        clear();
        let start = snapshot(0, 10).latest_seq;

        push(log::Level::Info, "rclone", "first");
        push(log::Level::Warn, "rclone", "second");

        let all = snapshot(start, 10);
        assert_eq!(all.entries.len(), 2);
        assert_eq!(all.entries[0].message, "first");
        assert_eq!(all.entries[1].level, "warn");

        // A cursor at the newest entry gets nothing new.
        let tail = snapshot(all.latest_seq, 10);
        assert!(tail.entries.is_empty());

        // Blank lines never make it in.
        push(log::Level::Info, "rclone", "   ");
        assert!(snapshot(all.latest_seq, 10).entries.is_empty());

        // Over the limit, the newest entries win.
        push(log::Level::Info, "rclone", "third");
        push(log::Level::Info, "rclone", "fourth");
        let limited = snapshot(start, 1);
        assert_eq!(limited.entries.len(), 1);
        assert_eq!(limited.entries[0].message, "fourth");
    }

    #[test]
    fn strips_only_the_plugins_own_prefix() {
        assert_eq!(
            strip_plugin_prefix(
                "[2026-08-20][09:27:34][tauri_app_lib][INFO] Application starting up",
                log::Level::Info
            ),
            "Application starting up"
        );

        // A message that happens to start with brackets keeps them.
        assert_eq!(
            strip_plugin_prefix("[a][b][c][d] real message", log::Level::Info),
            "[a][b][c][d] real message"
        );
        assert_eq!(
            strip_plugin_prefix("[not a prefix] text", log::Level::Debug),
            "[not a prefix] text"
        );
        // rclone's JSON output is untouched.
        assert_eq!(
            strip_plugin_prefix(r#"{"level":"info","msg":"x"}"#, log::Level::Debug),
            r#"{"level":"info","msg":"x"}"#
        );
    }
}
