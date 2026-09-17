//! Spots an rclone process whose transfers are crawling next to what the job
//! has shown it can do, so the worker can start it again on another service
//! account.
//!
//! Drive throttles per account. A throttled account drags one file for hours
//! while the account beside it flies, and since a Drive file is a single
//! resumable session the only remedy is to start that file again elsewhere,
//! which re-sends whatever the slow process had managed. Hence the wide margins
//! here: a process is only declared crawling after a full window at under an
//! eighth of the best rate any transfer of the job has sustained, never while
//! one of its transfers is moving or too young to judge, and never for a
//! transfer that is nearly done. When no other process is demonstrably healthy
//! at the same moment, the slowness may just as well be the link, so a switch
//! is only allowed while there is little to lose.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a transfer must crawl before its process is switched, and the
/// window every rate is measured over. Wide enough that a fresh process's
/// ramp-up, a retried chunk, or a momentary dip never triggers a restart.
pub const CRAWL_WINDOW: Duration = Duration::from_secs(60);

/// A transfer is crawling when it moves slower than this fraction of the best
/// rate the job has sustained. Also the "nearly done" margin: a transfer with
/// less than this fraction left is finishing, and a stall there is not
/// evidence of a bad account.
pub const CRAWL_FRACTION: f64 = 0.125;

/// The best rate only stays a fair yardstick while conditions are comparable.
const REFERENCE_TTL: Duration = Duration::from_secs(15 * 60);

/// rclone prints stats every second, so a gap this long between two readings
/// means the process was suspended (a pause). The history is dropped rather
/// than measured across the gap.
const SAMPLE_GAP_LIMIT: Duration = Duration::from_secs(5);

/// Switches per item or fan-out group. Each one re-sends the file that was in
/// flight, so a link that is simply slow must not thrash.
pub const MAX_ACCOUNT_SWITCHES: u32 = 2;

/// One `transferring` entry from an rclone stats line.
#[derive(Debug, Clone, Copy)]
pub struct Transfer<'a> {
    pub name: &'a str,
    pub bytes: u64,
    pub size: u64,
}

type Ring = VecDeque<(Instant, u64)>;

#[derive(Default)]
struct State {
    next_stream: u64,
    /// Per process, per transfer name: the byte counter over the last window.
    streams: HashMap<u64, HashMap<String, Ring>>,
    /// Per process: when it last reported, and its best transfer's rate then.
    latest: HashMap<u64, (Instant, Option<f64>)>,
    /// Best windowed rate seen, by minute of the job, so the yardstick ages out.
    best_by_minute: BTreeMap<u64, f64>,
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

    /// Feeds one stats line. Returns true when the process should be switched
    /// to another account: every transfer it has is crawling (or finishing),
    /// and either another process is healthy right now or the crawling
    /// transfers have barely started.
    pub fn observe(&self, stream: u64, transfers: &[Transfer<'_>], now: Instant) -> bool {
        let mut state = self.state.lock().expect("speed watch poisoned");
        let started = *state.started.get_or_insert(now);
        let minute = now.duration_since(started).as_secs() / 60;
        let oldest = minute.saturating_sub(REFERENCE_TTL.as_secs() / 60);
        state.best_by_minute = state.best_by_minute.split_off(&oldest);

        let rings = state.streams.entry(stream).or_default();
        rings.retain(|name, _| transfers.iter().any(|t| t.name == name));

        // (rate over the window if there is a full window yet, bytes, size)
        let mut judged: Vec<(Option<f64>, u64, u64)> = Vec::with_capacity(transfers.len());
        let mut best_here: Option<f64> = None;
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
                best_here = Some(best_here.map_or(rate, |b| b.max(rate)));
            }
            judged.push((rate, transfer.bytes, transfer.size));
        }

        if let Some(rate) = best_here {
            let slot = state.best_by_minute.entry(minute).or_insert(0.0);
            if rate > *slot {
                *slot = rate;
            }
        }
        state.latest.insert(stream, (now, best_here));

        let best = state
            .best_by_minute
            .values()
            .copied()
            .fold(0.0_f64, f64::max);
        if best <= 0.0 {
            return false;
        }
        let floor = CRAWL_FRACTION * best;

        let mut crawling = false;
        let mut little_to_lose = true;
        for (rate, bytes, size) in judged {
            let remaining = size.saturating_sub(bytes);
            let nearly_done = remaining as f64 <= CRAWL_FRACTION * size as f64;
            match rate {
                // Too young to judge: wait for it.
                None => return false,
                // Something is moving fine, so the account is fine.
                Some(rate) if rate >= floor => return false,
                Some(_) if nearly_done => {}
                Some(_) => {
                    crawling = true;
                    if bytes as f64 > CRAWL_FRACTION * size as f64 {
                        little_to_lose = false;
                    }
                }
            }
        }
        if !crawling {
            return false;
        }

        let another_is_healthy = state.latest.iter().any(|(other, (at, rate))| {
            *other != stream
                && now.duration_since(*at) <= SAMPLE_GAP_LIMIT
                && rate.is_some_and(|rate| rate >= floor)
        });
        another_is_healthy || little_to_lose
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    /// Drives a stream forward one reading per second at `per_sec` bytes.
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
    fn a_crawling_stream_beside_a_healthy_one_is_switched() {
        let watch = SpeedWatch::new();
        let start = Instant::now();
        let fast = watch.open_stream();
        let slow = watch.open_stream();

        // Fast: 60 MiB/s. Slow: 2 MiB/s of an 800 MiB file, so by the time it
        // is judged it is past the little-to-lose margin and the switch rests
        // on the fast process being healthy at that moment.
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
            assert!(!fast_v, "the fast stream is never switched");
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
    fn a_stream_is_not_judged_without_a_yardstick() {
        // A lone slow stream with nothing to compare against is just slow.
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
    fn a_stream_that_slows_down_alone_is_left_alone_once_it_has_progress() {
        // Fast for two minutes, then eight times slower with most of the file
        // sent: without another healthy process the link is the likelier
        // cause, and a restart would throw away everything sent so far.
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
    fn a_stream_that_never_got_going_is_switched_on_history_alone() {
        // The fast process finished a while ago; the slow one has barely
        // started, so there is little to lose by trying another account.
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
    fn a_finishing_transfer_is_not_evidence() {
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
            // Stuck at 99% - Drive is finalising the file, nothing to switch.
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
    fn a_healthy_sibling_transfer_in_the_same_process_vetoes_a_switch() {
        // One file crawls but another in the same process flies: the account
        // is fine, the file is just slow on Drive's side.
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
            12 * 1024 * MIB,
            start,
            0,
            65,
            60 * MIB,
        );
        feed(
            &watch,
            paused,
            "b.mkv",
            12 * 1024 * MIB,
            start,
            0,
            65,
            60 * MIB,
        );
        // The second is suspended for ten minutes, then resumes at full speed.
        // Measured across the gap it would look like a crawl; it is not.
        let resume = start + Duration::from_secs(665);
        let mut verdict = false;
        for sec in 0..=30 {
            let t = resume + Duration::from_secs(sec);
            watch.observe(
                fast,
                &[Transfer {
                    name: "a.mkv",
                    bytes: (665 + sec) * 60 * MIB,
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
