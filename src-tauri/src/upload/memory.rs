//! Keeps the app's rclone processes inside the machine's memory.
//!
//! Every transfer of an upload holds a whole `--drive-chunk-size` chunk in
//! memory, plus up to `--buffer-size` read ahead from disk, and a job runs one
//! rclone process per item and per fan-out group, so what a job asks for grows
//! with items x groups x transfers x chunk. Nothing capped that. When it
//! outgrew the machine, every rclone running at that moment died together of
//! Go's "fatal error: out of memory", and the items showed only the tail of
//! the crash trace: "rclone failed (exit code 2): runtime/asm_amd64.s:1693
//! +0x1 fp=... created by github.com/rclone/rclone/fs/asyncreader...".
//!
//! Now every upload process is admitted before it starts: it reserves what it
//! can use from the app's budget, and starts only once the machine also has
//! that much free beside what is kept back for everything else. Until then the
//! upload is on hold, not started and left to crash.

use std::fmt;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MIB: u64 = 1024 * 1024;

/// What an rclone process uses besides its transfers' buffers: the runtime,
/// connections, the file list and stats.
const PROCESS_BASE_MIB: u64 = 128;

/// What a one-off rclone run - a listing, a mkdir - is admitted with.
pub const SMALL_PROCESS_MIB: u32 = PROCESS_BASE_MIB as u32;

/// rclone's defaults, for a flag the arguments do not carry.
const DEFAULT_TRANSFERS: u64 = 4;
const DEFAULT_CHUNK_MIB: u64 = 8;
const DEFAULT_BUFFER_MIB: u64 = 16;

/// Assumed when the machine will not say how much memory it has.
const FALLBACK_PHYSICAL_MIB: u64 = 8 * 1024;

/// The smallest budget, however little memory the machine reports.
const MIN_BUDGET_MIB: u64 = 1024;

/// Always left free for the system and other programs: a tenth of the
/// machine, and never less than this.
const MIN_HEADROOM_MIB: u64 = 1024;

/// How long a process just started counts as still growing into what it
/// reserved. rclone allocates a transfer's chunk as that file starts, which is
/// within seconds; until then the system's free figure does not show it yet,
/// and ten groups starting together would each see the same free memory.
const RAMP_UP: Duration = Duration::from_secs(30);

/// How often an upload on hold looks at the system's free memory again.
const HOLD_POLL: Duration = Duration::from_secs(3);

/// Why an upload is on hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// The app's other uploads already hold its whole share of memory.
    Budget { budget_mib: u32 },
    /// The machine itself is short: other programs, or uploads that have only
    /// just started, are using it.
    System { needs_mib: u64, available_mib: u64 },
}

impl fmt::Display for Hold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Hold::Budget { budget_mib } => write!(
                f,
                "Waiting for memory: other uploads are using the {} the app allows itself",
                gb(u64::from(budget_mib))
            ),
            Hold::System {
                needs_mib,
                available_mib,
            } => write!(
                f,
                "Waiting for memory: this upload needs {}, {} is free",
                gb(needs_mib),
                gb(available_mib)
            ),
        }
    }
}

fn gb(mib: u64) -> String {
    format!("{:.1} GB", mib as f64 / 1024.0)
}

/// The memory every upload process draws from.
pub struct MemoryBudget {
    permits: Arc<Semaphore>,
    total_mib: u32,
    headroom_mib: u64,
    /// What the machine has free right now, in MiB; `None` where it cannot
    /// say, and then only the budget applies.
    free_mib: fn() -> Option<u64>,
    /// Processes admitted within `RAMP_UP`: when, and how much.
    ramping: Mutex<Vec<(Instant, u64)>>,
}

/// The one budget every job shares. A job replaced by a new one keeps running
/// the items it holds until they finish, so a budget per job would let the two
/// reserve twice what the machine can give.
pub fn machine_budget() -> &'static MemoryBudget {
    static BUDGET: OnceLock<MemoryBudget> = OnceLock::new();
    BUDGET.get_or_init(MemoryBudget::for_this_machine)
}

impl MemoryBudget {
    /// Half the machine's physical memory, leaving the rest to the system and
    /// whatever else is running.
    fn for_this_machine() -> Self {
        let physical_mib = physical_memory_bytes()
            .map(|bytes| bytes / MIB)
            .unwrap_or(FALLBACK_PHYSICAL_MIB);
        Self::new(
            (physical_mib / 2).max(MIN_BUDGET_MIB),
            (physical_mib / 10).max(MIN_HEADROOM_MIB),
            || free_memory_bytes().map(|bytes| bytes / MIB),
        )
    }

    fn new(budget_mib: u64, headroom_mib: u64, free_mib: fn() -> Option<u64>) -> Self {
        let total_mib = budget_mib.clamp(1, u64::from(u32::MAX)) as u32;
        Self {
            permits: Arc::new(Semaphore::new(total_mib as usize)),
            total_mib,
            headroom_mib,
            free_mib,
            ramping: Mutex::new(Vec::new()),
        }
    }

    pub fn total_mib(&self) -> u32 {
        self.total_mib
    }

    /// Waits until `mib` fits both the budget and the memory the machine has
    /// free, then holds it until the returned permit is dropped. A process
    /// that needs more than the whole budget waits for all of it and then runs
    /// alone.
    ///
    /// `on_hold` hears why, each time the upload is found unable to start yet,
    /// so it can show that it is waiting rather than look stuck. Returns
    /// `None`, without waiting further, once `stopped` says so.
    pub async fn admit(
        &self,
        mib: u32,
        stopped: impl Fn() -> bool,
        mut on_hold: impl FnMut(Hold),
    ) -> Option<OwnedSemaphorePermit> {
        let need = mib.clamp(1, self.total_mib);
        let permit = match self.permits.clone().try_acquire_many_owned(need) {
            Ok(permit) => permit,
            Err(_) => {
                on_hold(Hold::Budget {
                    budget_mib: self.total_mib,
                });
                self.permits
                    .clone()
                    .acquire_many_owned(need)
                    .await
                    .expect("the budget's semaphore is never closed")
            }
        };
        loop {
            if stopped() {
                return None;
            }
            match self.claim_free_memory(u64::from(need)) {
                Ok(()) => return Some(permit),
                Err(hold) => {
                    on_hold(hold);
                    tokio::time::sleep(HOLD_POLL).await;
                }
            }
        }
    }

    /// Whether the machine has `need` free beside the headroom, counting
    /// what processes admitted moments ago are about to take. If so, this
    /// process is counted among those.
    fn claim_free_memory(&self, need: u64) -> Result<(), Hold> {
        let mut ramping = self.ramping.lock().unwrap_or_else(|e| e.into_inner());
        ramping.retain(|(at, _)| at.elapsed() < RAMP_UP);
        if let Some(free) = (self.free_mib)() {
            let still_growing: u64 = ramping.iter().map(|(_, mib)| mib).sum();
            let available = free
                .saturating_sub(still_growing)
                .saturating_sub(self.headroom_mib);
            if available < need {
                return Err(Hold::System {
                    needs_mib: need,
                    available_mib: available,
                });
            }
        }
        ramping.push((Instant::now(), need));
        Ok(())
    }
}

/// The most an rclone upload run with `args` can hold in memory, in MiB.
/// `files` is how many files it uploads, when known: no more of them are in
/// flight at once than there are files. The flags are read from the final
/// arguments, so the user's extra flags count where they override ours.
pub fn footprint_mib(args: &[String], files: Option<usize>) -> u32 {
    let transfers = flag_value(args, "--transfers")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TRANSFERS)
        .max(1);
    let in_flight = match files {
        Some(files) => transfers.min(files.max(1) as u64),
        None => transfers,
    };
    let chunk = flag_value(args, "--drive-chunk-size")
        .and_then(parse_size_bytes)
        .unwrap_or(DEFAULT_CHUNK_MIB * MIB);
    let buffer = flag_value(args, "--buffer-size")
        .and_then(parse_size_bytes)
        .unwrap_or(DEFAULT_BUFFER_MIB * MIB);
    let per_transfer_mib = (chunk + buffer).div_ceil(MIB);
    (PROCESS_BASE_MIB + in_flight * per_transfer_mib).min(u64::from(u32::MAX)) as u32
}

/// `GOMEMLIMIT` for a process reserved `footprint_mib`.
///
/// Go lets its heap grow to twice what is live before collecting, and every
/// file an upload starts allocates a fresh chunk, so without a limit a process
/// can hold about double what it uses. A quarter over the reservation keeps it
/// near its reservation without making the collector chase every allocation.
pub fn go_memory_limit(footprint_mib: u32) -> String {
    let mib = u64::from(footprint_mib);
    format!("{}MiB", mib + mib / 4)
}

/// The last value given for `flag`, as `--flag value` or `--flag=value`;
/// rclone takes the last one too.
fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let mut found = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == flag {
            found = iter.next().map(String::as_str);
        } else if let Some(value) = arg
            .strip_prefix(flag)
            .and_then(|rest| rest.strip_prefix('='))
        {
            found = Some(value);
        }
    }
    found
}

/// An rclone size such as `128M`, `1Gi`, `16MiB` or `512k`, in bytes. A bare
/// number is KiB, as rclone reads it; `off` is nothing.
fn parse_size_bytes(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("off") {
        return Some(0);
    }
    let split = value
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(value.len());
    let (number, suffix) = value.split_at(split);
    let number: f64 = number.parse().ok()?;
    let shift = match suffix.chars().next().map(|c| c.to_ascii_lowercase()) {
        None => 10,
        Some('b') => 0,
        Some('k') => 10,
        Some('m') => 20,
        Some('g') => 30,
        Some('t') => 40,
        Some('p') => 50,
        Some(_) => return None,
    };
    Some((number * (1u64 << shift) as f64) as u64)
}

#[cfg(windows)]
fn memory_status() -> Option<windows_sys::Win32::System::SystemInformation::MEMORYSTATUSEX> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    // SAFETY: MEMORYSTATUSEX is plain data, and the call only writes into the
    // struct it is handed once `dwLength` says how big it is.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status)
    }
}

#[cfg(windows)]
fn physical_memory_bytes() -> Option<u64> {
    memory_status().map(|status| status.ullTotalPhys)
}

/// The smaller of free RAM and the commit Windows can still grant. A Go
/// program dies the moment Windows refuses to commit memory, which can happen
/// with RAM to spare once the page file is full; with RAM gone it pages hard
/// long before that.
#[cfg(windows)]
fn free_memory_bytes() -> Option<u64> {
    memory_status().map(|status| status.ullAvailPhys.min(status.ullAvailPageFile))
}

#[cfg(unix)]
fn physical_memory_bytes() -> Option<u64> {
    // SAFETY: sysconf only reads system configuration.
    let (pages, page_size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    (pages > 0 && page_size > 0).then(|| pages as u64 * page_size as u64)
}

/// Unix systems count their file cache as used, so a free figure from them
/// would hold uploads back with memory to spare; only the budget applies.
#[cfg(not(windows))]
fn free_memory_bytes() -> Option<u64> {
    None
}

#[cfg(not(any(windows, unix)))]
fn physical_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn unknown_free() -> Option<u64> {
        None
    }

    #[test]
    fn reads_rclone_sizes() {
        assert_eq!(parse_size_bytes("128M"), Some(128 * MIB));
        assert_eq!(parse_size_bytes("1Gi"), Some(1024 * MIB));
        assert_eq!(parse_size_bytes("16MiB"), Some(16 * MIB));
        assert_eq!(parse_size_bytes("512k"), Some(512 * 1024));
        assert_eq!(parse_size_bytes("1024"), Some(MIB), "a bare number is KiB");
        assert_eq!(parse_size_bytes("off"), Some(0));
        assert_eq!(parse_size_bytes("lots"), None);
    }

    #[test]
    fn counts_a_chunk_and_a_read_buffer_per_transfer_in_flight() {
        let ours = args(&["copy", "--drive-chunk-size", "128M", "--transfers", "4"]);
        assert_eq!(footprint_mib(&ours, None), 128 + 4 * (128 + 16));
        assert_eq!(
            footprint_mib(&ours, Some(1)),
            128 + 128 + 16,
            "one file is one transfer, whatever --transfers says"
        );
    }

    #[test]
    fn the_users_extra_flags_win_over_ours() {
        let overridden = args(&[
            "--drive-chunk-size",
            "128M",
            "--transfers",
            "4",
            "--drive-chunk-size=1G",
            "--buffer-size",
            "off",
        ]);
        assert_eq!(footprint_mib(&overridden, Some(2)), 128 + 2 * 1024);
    }

    #[tokio::test]
    async fn an_upload_is_held_until_the_budget_has_room() {
        let budget = MemoryBudget::new(1000, 0, unknown_free);
        let first = budget.admit(600, || false, |_| {}).await.unwrap();

        let mut holds = Vec::new();
        let second = tokio::time::timeout(
            Duration::from_millis(50),
            budget.admit(600, || false, |hold| holds.push(hold)),
        )
        .await;
        assert!(second.is_err(), "only 400 left, so it waits");
        assert_eq!(holds, vec![Hold::Budget { budget_mib: 1000 }]);

        drop(first);
        assert!(budget.admit(600, || false, |_| {}).await.is_some());
    }

    #[tokio::test]
    async fn an_upload_bigger_than_the_budget_runs_alone() {
        let budget = MemoryBudget::new(1000, 0, unknown_free);
        let whole = budget.admit(5000, || false, |_| {}).await.unwrap();
        assert!(budget.permits.available_permits() == 0);
        drop(whole);
    }

    static FREE: AtomicU64 = AtomicU64::new(0);
    fn test_free() -> Option<u64> {
        Some(FREE.load(Ordering::Relaxed))
    }

    #[tokio::test(start_paused = true)]
    async fn an_upload_is_held_while_the_machine_is_short_and_starts_when_it_frees() {
        FREE.store(1500, Ordering::Relaxed);
        let budget = MemoryBudget::new(10_000, 1000, test_free);

        let mut holds = Vec::new();
        let admitted = {
            let waiting = budget.admit(800, || false, |hold| holds.push(hold));
            tokio::pin!(waiting);
            assert!(
                tokio::time::timeout(Duration::from_secs(10), &mut waiting)
                    .await
                    .is_err(),
                "500 free beside the 1000 kept back is not 800"
            );
            FREE.store(1800, Ordering::Relaxed);
            waiting.await
        };
        assert!(admitted.is_some());
        assert_eq!(
            holds[0],
            Hold::System {
                needs_mib: 800,
                available_mib: 500
            }
        );

        // The first upload has not allocated yet, so the free figure still
        // shows its 800: a second one starting now must not count it twice.
        let mut second_held = false;
        let second = tokio::time::timeout(
            Duration::from_secs(5),
            budget.admit(800, || false, |_| second_held = true),
        )
        .await;
        assert!(second.is_err() && second_held);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_upload_stops_waiting() {
        let budget = MemoryBudget::new(10_000, 1000, || Some(0));
        assert!(budget.admit(800, || true, |_| {}).await.is_none());
    }

    #[test]
    fn says_why_an_upload_waits() {
        assert_eq!(
            Hold::System {
                needs_mib: 1229,
                available_mib: 410
            }
            .to_string(),
            "Waiting for memory: this upload needs 1.2 GB, 0.4 GB is free"
        );
    }

    #[test]
    fn the_go_limit_sits_a_quarter_over_the_reservation() {
        assert_eq!(go_memory_limit(400), "500MiB");
    }
}
