//! Spots an rclone process whose transfers are crawling next to what the job
//! has shown it can do, so the worker can start it again.
//!
//! A Drive upload is one TCP flow and one upload session, and how fast one
//! goes is largely luck: flows land on good or bad paths, sessions on near or
//! far servers. Fast ones finish first, so the slow ones are what is left at
//! the end of a batch - the last file of a folder crawling at a twentieth of
//! what the link did minutes earlier. The only remedy is a fresh flow, which
//! re-sends whatever the slow process had managed, hence the margins here.
//!
//! Two rules, each measured over a full window so a fresh process's ramp-up,
//! a retried chunk or a momentary dip never triggers a restart:
//!
//! * **Beside a healthy process.** Every transfer of the process runs at under
//!   an eighth of the best rate any single transfer has sustained lately, while
//!   another process is demonstrably fine right now. The link is proven good,
//!   so the loss of a restart is worth it whatever the progress.
//! * **On an idle link.** The whole job moves at under an eighth of the best
//!   rate the link has delivered - lately in this job, or ever on this
//!   machine (the *link record*, which the app keeps across runs so a lone
//!   file has something to be judged against) - and so does this process.
//!   Nothing proves the link is still that fast, so this only fires while
//!   there is at most half a file to lose, and a restart that turns out
//!   futile pauses the rule for a while: the link itself has slowed, and
//!   thrashing would only re-send files for nothing.
//!
//! A process with a transfer too young to judge, or one about to finish, is
//! left alone until the next reading.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a process must crawl before it is restarted, and the window every
/// rate is measured over.
pub const CRAWL_WINDOW: Duration = Duration::from_secs(60);

/// Crawling means moving slower than this fraction of the yardstick. Also the
/// "nearly done" margin: a transfer with less than this fraction left is
/// finishing, and a stall there is not evidence of anything.
pub const CRAWL_FRACTION: f64 = 0.125;

/// The most of a file the idle-link rule may throw away.
const IDLE_LINK_LOSS_CAP: f64 = 0.5;

/// A single transfer's best rate only stays a fair yardstick for other
/// transfers while conditions are comparable.
const TRANSFER_REFERENCE_TTL: Duration = Duration::from_secs(15 * 60);

/// The link's best rate is remembered longer: it is what the tail of a batch
/// is compared against, and the tail can come an hour after the peak.
const LINK_REFERENCE_TTL: Duration = Duration::from_secs(60 * 60);

/// How long the idle-link rule stays off after a restart proved futile.
const FUTILE_PAUSE: Duration = Duration::from_secs(15 * 60);

/// rclone prints stats every second, so a gap this long between two readings
/// means the process was suspended (a pause). The history is dropped rather
/// than measured across the gap.
const SAMPLE_GAP_LIMIT: Duration = Duration::from_secs(5);

/// A restarted process that needs restarting again within this long did not
/// benefit from the fresh flow.
pub const FUTILE_RUN: Duration = Duration::from_secs(3 * 60);

/// Restarts in a row, each within `FUTILE_RUN` of the last, before an item or
/// fan-out group is left to crawl. Each one re-sends the files in flight.
pub const MAX_RESTART_STREAK: u32 = 2;

/// One `transferring` entry from an rclone stats line.
#[derive(Debug, Clone, Copy)]
pub struct Transfer<'a> {
    pub name: &'a str,
    pub bytes: u64,
    pub size: u64,
}

type Ring = VecDeque<(Instant, u64)>;

/// What a process last reported: when, the sum of its measured transfer
/// rates, and its best single transfer rate.
#[derive(Clone, Copy)]
struct Report {
    at: Instant,
    rate: f64,
    best_transfer: Option<f64>,
}

#[derive(Default)]
struct State {
    next_stream: u64,
    /// Per process, per transfer name: the byte counter over the last window.
    streams: HashMap<u64, HashMap<String, Ring>>,
    latest: HashMap<u64, Report>,
    /// Best single-transfer rate seen, by minute of the job, so it ages out.
    transfer_by_minute: BTreeMap<u64, f64>,
    /// Best whole-job rate seen, by minute of the job.
    link_by_minute: BTreeMap<u64, f64>,
    /// Best whole-job rate this machine has ever sustained, seeded from the
    /// previous runs and raised by this one. Never ages out.
    link_record: f64,
    idle_rule_paused_until: Option<Instant>,
    started: Option<Instant>,
}

pub struct SpeedWatch {
    state: Mutex<State>,
}

impl Default for SpeedWatch {
    fn default() -> Self {
        Self::new()
    }
}

fn best_within(by_minute: &BTreeMap<u64, f64>, minute: u64, ttl: Duration) -> f64 {
    let oldest = minute.saturating_sub(ttl.as_secs() / 60);
    by_minute
        .range(oldest..)
        .map(|(_, rate)| *rate)
        .fold(0.0_f64, f64::max)
}

fn record(by_minute: &mut BTreeMap<u64, f64>, minute: u64, rate: f64, ttl: Duration) {
    let oldest = minute.saturating_sub(ttl.as_secs() / 60);
    *by_minute = by_minute.split_off(&oldest);
    let slot = by_minute.entry(minute).or_insert(0.0);
    if rate > *slot {
        *slot = rate;
    }
}

impl SpeedWatch {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
        }
    }

    /// Registers one rclone process. Every process gets its own history, so a
    /// restarted one is judged only on what it does itself.
    pub fn open_stream(&self) -> u64 {
        let mut state = self.state.lock().expect("speed watch poisoned");
        state.next_stream += 1;
        state.next_stream
    }

    pub fn close_stream(&self, stream: u64) {
        let mut state = self.state.lock().expect("speed watch poisoned");
        state.streams.remove(&stream);
        state.latest.remove(&stream);
    }

    /// Seeds the link record from what earlier runs achieved, so the first
    /// process of a job - a lone file, typically - can be judged against it.
    pub fn seed_link_record(&self, bytes_per_sec: f64) {
        let mut state = self.state.lock().expect("speed watch poisoned");
        if bytes_per_sec > state.link_record {
            state.link_record = bytes_per_sec;
        }
    }

    /// The best whole-job rate seen so far, seeded or measured, for saving.
    pub fn link_record(&self) -> f64 {
        self.state.lock().expect("speed watch poisoned").link_record
    }

    /// A restarted process crawled again straight away: the link itself has
    /// slowed, so the idle-link rule stands down for a while.
    pub fn restart_was_futile(&self, now: Instant) {
        let mut state = self.state.lock().expect("speed watch poisoned");
        state.idle_rule_paused_until = Some(now + FUTILE_PAUSE);
    }

    /// Feeds one stats line. Returns true when the process should be started
    /// again on a fresh flow (see the module docs for when that is).
    pub fn observe(&self, stream: u64, transfers: &[Transfer<'_>], now: Instant) -> bool {
        let mut state = self.state.lock().expect("speed watch poisoned");
        let started = *state.started.get_or_insert(now);
        let minute = now.duration_since(started).as_secs() / 60;

        let rings = state.streams.entry(stream).or_default();
        rings.retain(|name, _| transfers.iter().any(|t| t.name == name));

        // Per transfer: rate over the window once there is a full window,
        // bytes sent, size.
        let mut judged: Vec<(Option<f64>, u64, u64)> = Vec::with_capacity(transfers.len());
        let mut report = Report {
            at: now,
            rate: 0.0,
            best_transfer: None,
        };
        for transfer in transfers {
            let ring = rings.entry(transfer.name.to_string()).or_default();
            if let Some(&(last_at, last_bytes)) = ring.back() {
                if now.duration_since(last_at) > SAMPLE_GAP_LIMIT || transfer.bytes < last_bytes {
                    ring.clear();
                }
            }
            ring.push_back((now, transfer.bytes));
            // Keep exactly one reading at or beyond the window, so the span
            // measured is never shorter than the window.
            while ring.len() >= 2 && now.duration_since(ring[1].0) >= CRAWL_WINDOW {
                ring.pop_front();
            }
            let (first_at, first_bytes) = ring[0];
            let span = now.duration_since(first_at);
            let rate = (span >= CRAWL_WINDOW)
                .then(|| transfer.bytes.saturating_sub(first_bytes) as f64 / span.as_secs_f64());
            if let Some(rate) = rate {
                report.rate += rate;
                report.best_transfer = Some(report.best_transfer.map_or(rate, |b| b.max(rate)));
            }
            judged.push((rate, transfer.bytes, transfer.size));
        }

        if let Some(rate) = report.best_transfer {
            record(
                &mut state.transfer_by_minute,
                minute,
                rate,
                TRANSFER_REFERENCE_TTL,
            );
        }
        state.latest.insert(stream, report);
        let fresh = |report: &Report| now.duration_since(report.at) <= SAMPLE_GAP_LIMIT;
        let job_rate: f64 = state
            .latest
            .values()
            .filter(|r| fresh(r))
            .map(|r| r.rate)
            .sum();
        record(
            &mut state.link_by_minute,
            minute,
            job_rate,
            LINK_REFERENCE_TTL,
        );
        if job_rate > state.link_record {
            state.link_record = job_rate;
        }

        // Judge only a process whose every transfer has a full window behind
        // it and is not about to finish.
        if judged.is_empty() {
            return false;
        }
        let mut rates = Vec::with_capacity(judged.len());
        let mut most_sent = 0.0_f64;
        for (rate, bytes, size) in judged {
            let Some(rate) = rate else { return false };
            let remaining = size.saturating_sub(bytes);
            if remaining as f64 <= CRAWL_FRACTION * size as f64 {
                return false;
            }
            rates.push(rate);
            if size > 0 {
                most_sent = most_sent.max(bytes as f64 / size as f64);
            }
        }

        // Beside a healthy process.
        let best_transfer = best_within(&state.transfer_by_minute, minute, TRANSFER_REFERENCE_TTL);
        let transfer_floor = CRAWL_FRACTION * best_transfer;
        if best_transfer > 0.0 && rates.iter().all(|rate| *rate < transfer_floor) {
            let another_is_healthy = state.latest.iter().any(|(other, r)| {
                *other != stream && fresh(r) && r.best_transfer.is_some_and(|b| b >= transfer_floor)
            });
            if another_is_healthy {
                return true;
            }
        }

        // On an idle link.
        let best_link =
            best_within(&state.link_by_minute, minute, LINK_REFERENCE_TTL).max(state.link_record);
        let link_floor = CRAWL_FRACTION * best_link;
        let paused = state
            .idle_rule_paused_until
            .is_some_and(|until| now < until);
        best_link > 0.0
            && !paused
            && job_rate < link_floor
            && report.rate < link_floor
            && most_sent <= IDLE_LINK_LOSS_CAP
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    /// Drives a stream forward one reading per second at `per_sec` bytes,
    /// returning the last verdict.
    #[allow(clippy::too_many_arguments)]
    fn feed(
        watch: &SpeedWatch,
        stream: u64,
        name: &str,
        size: u64,
        start: Instant,
        from_sec: u64,
        to_sec: u64,
        per_sec: u64,
    ) -> bool {
        let mut verdict = false;
        for sec in from_sec..=to_sec {
            let bytes = sec * per_sec;
            let t = start + Duration::from_secs(sec);
            verdict = watch.observe(stream, &[Transfer { name, bytes, size }], t);
        }
        verdict
    }

    #[test]
    fn a_crawling_process_beside_a_healthy_one_is_restarted() {
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        let slow = watch.open_stream();

        // Fast: 60 MiB/s. Slow: 2 MiB/s of an 800 MiB file, so by the time it
        // is judged it is past the idle-link loss cap's little-to-lose region
        // and the restart rests on the fast process being healthy right then.
        let slow_size = 800 * MIB;
        for sec in 0..=59 {
            let t = start + Duration::from_secs(sec);
            let fast_v = watch.observe(
                fast,
                &[Transfer {
                    name: "a.mkv",
                    bytes: sec * 60 * MIB,
                    size: 12 * 1024 * MIB,
                }],
                t,
            );
            let slow_v = watch.observe(
                slow,
                &[Transfer {
                    name: "b.mkv",
                    bytes: sec * 2 * MIB,
                    size: slow_size,
                }],
                t,
            );
            assert!(!fast_v, "the fast process is never restarted");
            assert!(!slow_v, "no verdict before a full window at {sec}s");
        }

        let t = start + Duration::from_secs(60);
        assert!(!watch.observe(
            fast,
            &[Transfer {
                name: "a.mkv",
                bytes: 60 * 60 * MIB,
                size: 12 * 1024 * MIB
            }],
            t
        ));
        assert!(watch.observe(
            slow,
            &[Transfer {
                name: "b.mkv",
                bytes: 60 * 2 * MIB,
                size: slow_size
            }],
            t
        ));
    }

    #[test]
    fn a_lone_file_is_judged_against_the_machines_record() {
        // The first and only process of a job - a single file on a throttled
        // account - has no other process to compare with. The record of what
        // this machine did before is the yardstick instead.
        let watch = SpeedWatch::new();
        watch.seed_link_record(38.0 * MIB as f64);
        let start = Instant::now();
        let slow = watch.open_stream();
        let mut verdict = false;
        for sec in 0..=65 {
            let t = start + Duration::from_secs(sec);
            verdict = watch.observe(
                slow,
                &[Transfer {
                    name: "a.mkv",
                    bytes: sec * 2 * MIB + sec * MIB / 2,
                    size: 6000 * MIB,
                }],
                t,
            );
            if sec < 60 {
                assert!(!verdict, "a full window first, at {sec}s");
            }
        }
        assert!(verdict, "2.5 MiB/s against a 38 MiB/s record is a crawl");

        // The record is not lowered by a slow job, and is raised by a fast one.
        assert_eq!(watch.link_record(), 38.0 * MIB as f64);
        let fast = watch.open_stream();
        feed(
            &watch,
            fast,
            "b.mkv",
            100 * 1024 * MIB,
            start,
            100,
            165,
            60 * MIB,
        );
        assert_eq!(watch.link_record(), 60.0 * MIB as f64);
    }

    #[test]
    fn a_process_is_not_judged_without_a_yardstick() {
        // A lone slow process with nothing to compare against is just slow.
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let slow = watch.open_stream();
        assert!(!feed(
            &watch,
            slow,
            "b.mkv",
            8 * 1024 * MIB,
            start,
            0,
            120,
            2 * MIB
        ));
    }

    #[test]
    fn the_last_file_of_a_batch_crawling_on_an_idle_link_is_restarted() {
        // Three processes with four transfers each share the link at 12.5
        // MiB/s a transfer (150 MiB/s in all). No single transfer was ever
        // fast, so the tail file at 2.75 MiB/s is not crawling next to any
        // transfer - only next to what the link delivered minutes before.
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let streams: Vec<u64> = (0..3).map(|_| watch.open_stream()).collect();
        let size = 2800 * MIB;
        for sec in 0..=120 {
            let t = start + Duration::from_secs(sec);
            for (p, stream) in streams.iter().enumerate() {
                let names = [
                    format!("e{p}a"),
                    format!("e{p}b"),
                    format!("e{p}c"),
                    format!("e{p}d"),
                ];
                let transfers: Vec<Transfer<'_>> = names
                    .iter()
                    .map(|name| Transfer {
                        name,
                        bytes: sec * 12 * MIB + sec * MIB / 2,
                        size,
                    })
                    .collect();
                assert!(!watch.observe(*stream, &transfers, t));
            }
        }
        watch.close_stream(streams[1]);
        watch.close_stream(streams[2]);

        // Everything else finished; one file is left, 29% in, on a bad flow.
        let mut verdict = false;
        for sec in 121..=190 {
            let t = start + Duration::from_secs(sec);
            let bytes = 812 * MIB + (sec - 120) * (2 * MIB + 3 * MIB / 4);
            verdict = watch.observe(
                streams[0],
                &[Transfer {
                    name: "e0d",
                    bytes,
                    size,
                }],
                t,
            );
            if sec < 181 {
                assert!(!verdict, "a full window of crawling is needed, at {sec}s");
            }
        }
        assert!(verdict);
    }

    #[test]
    fn a_process_that_slows_down_alone_past_the_loss_cap_is_left_alone() {
        // Fast for two minutes, then ten times slower with most of the file
        // sent: without another healthy process nothing proves the link is
        // still fast, and a restart would throw away everything sent so far.
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let stream = watch.open_stream();
        let size = 1000 * MIB;
        assert!(!feed(&watch, stream, "a.mkv", size, start, 0, 120, 5 * MIB));
        let mut verdict = false;
        for sec in 121..=300 {
            let bytes = 120 * 5 * MIB + (sec - 120) * (MIB / 2);
            let t = start + Duration::from_secs(sec);
            verdict |= watch.observe(
                stream,
                &[Transfer {
                    name: "a.mkv",
                    bytes,
                    size,
                }],
                t,
            );
        }
        assert!(!verdict);
    }

    #[test]
    fn a_process_that_never_got_going_is_restarted_on_the_links_record_alone() {
        // The fast process finished a while ago; the slow one has barely
        // started, so there is little to lose by trying a fresh flow.
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        assert!(!feed(
            &watch,
            fast,
            "a.mkv",
            4000 * MIB,
            start,
            0,
            65,
            60 * MIB
        ));
        watch.close_stream(fast);

        let slow = watch.open_stream();
        assert!(feed(
            &watch,
            slow,
            "b.mkv",
            8 * 1024 * MIB,
            start,
            70,
            135,
            2 * MIB
        ));
    }

    #[test]
    fn a_futile_restart_pauses_the_idle_link_rule() {
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        assert!(!feed(
            &watch,
            fast,
            "a.mkv",
            4000 * MIB,
            start,
            0,
            65,
            60 * MIB
        ));
        watch.close_stream(fast);

        // The restarted process crawls again: the link has slowed.
        watch.restart_was_futile(start + Duration::from_secs(70));
        let slow = watch.open_stream();
        assert!(!feed(
            &watch,
            slow,
            "b.mkv",
            8 * 1024 * MIB,
            start,
            70,
            200,
            2 * MIB
        ));

        // The pause has run out, the link's record has not (an hour).
        let later = watch.open_stream();
        assert!(feed(
            &watch,
            later,
            "c.mkv",
            8 * 1024 * MIB,
            start,
            1000,
            1065,
            2 * MIB
        ));
    }

    #[test]
    fn a_finishing_transfer_holds_off_a_restart() {
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        let other = watch.open_stream();
        let size = 100 * MIB;
        for sec in 0..=70 {
            let t = start + Duration::from_secs(sec);
            watch.observe(
                fast,
                &[Transfer {
                    name: "a.mkv",
                    bytes: sec * 60 * MIB,
                    size: 12 * 1024 * MIB,
                }],
                t,
            );
            // Stuck at 99% - Drive is finalising the file, nothing to restart.
            let v = watch.observe(
                other,
                &[Transfer {
                    name: "b.mkv",
                    bytes: 99 * MIB,
                    size,
                }],
                t,
            );
            assert!(!v);
        }
    }

    #[test]
    fn a_healthy_sibling_transfer_in_the_same_process_vetoes_a_restart() {
        // One file crawls but another in the same process flies: the flow
        // and the account are fine, the file is just slow on Drive's side.
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let stream = watch.open_stream();
        let mut verdict = false;
        for sec in 0..=90 {
            let t = start + Duration::from_secs(sec);
            verdict |= watch.observe(
                stream,
                &[
                    Transfer {
                        name: "a.mkv",
                        bytes: sec * 60 * MIB,
                        size: 12 * 1024 * MIB,
                    },
                    Transfer {
                        name: "b.mkv",
                        bytes: sec * MIB,
                        size: 8 * 1024 * MIB,
                    },
                ],
                t,
            );
        }
        assert!(!verdict);
    }

    #[test]
    fn a_pause_gap_resets_the_history_instead_of_measuring_across_it() {
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        let paused = watch.open_stream();
        // Both run at full speed for a window.
        feed(
            &watch,
            fast,
            "a.mkv",
            100 * 1024 * MIB,
            start,
            0,
            65,
            60 * MIB,
        );
        feed(
            &watch,
            paused,
            "b.mkv",
            100 * 1024 * MIB,
            start,
            0,
            65,
            60 * MIB,
        );
        // Both are suspended for ten minutes, then resume at full speed.
        // Measured across the gap they would look like a crawl; they are not.
        let resume = start + Duration::from_secs(665);
        let mut verdict = false;
        for sec in 0..=30 {
            let t = resume + Duration::from_secs(sec);
            verdict |= watch.observe(
                fast,
                &[Transfer {
                    name: "a.mkv",
                    bytes: (65 + sec) * 60 * MIB,
                    size: 100 * 1024 * MIB,
                }],
                t,
            );
            verdict |= watch.observe(
                paused,
                &[Transfer {
                    name: "b.mkv",
                    bytes: (65 + sec) * 60 * MIB,
                    size: 100 * 1024 * MIB,
                }],
                t,
            );
        }
        assert!(!verdict);
    }
}
