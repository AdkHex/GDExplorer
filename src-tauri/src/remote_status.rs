//! The remote switch ("Work is in progress") and the access password.
//!
//! Every installed copy polls a small JSON document, a secret GitHub Gist (see
//! docs/REMOTE-STATUS.md). When it says `maintenance`, or this build is older
//! than `minVersion`, the app locks: running uploads stop, nothing new can
//! start, and the window shows a full-window screen. When it says `ok` again,
//! the uploads the lock held carry on by themselves.
//!
//! The same document can carry an `access` block, a salted PBKDF2-SHA256 hash
//! of a password. Each OS user then has to enter the password once; the app
//! remembers it by keeping `access.id` in the OS credential store, so a new
//! password (new salt, new id) asks everyone again.
//!
//! Fail-open and sticky: a failed fetch or an unreadable document changes
//! nothing, and the last good document is kept on disk, so a lock survives
//! restarts and offline periods. The exception is a build with
//! `requireAccess`: until it has read the document once it stays locked.
//!
//! Nothing here depends on Tauri, so `tests/remote_status.rs` drives it against
//! a local HTTP server. The Tauri side is `service.rs`.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{watch, Notify};

pub const APP_NAME: &str = "GDrive-Upload";
/// Larger documents are ignored.
pub const MAX_BYTES: usize = 64 * 1024;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_CHECK_MINUTES: u32 = 5;
/// How soon a build that requires a password tries again while it has never
/// read the document. It is locked until then, so five minutes is too long.
pub const FIRST_CONTACT_RETRY: Duration = Duration::from_secs(30);
/// What every refused command returns during maintenance (or "update required").
pub const PAUSED_ERROR: &str = "GDrive-Upload is paused: work is in progress";
/// What every refused command returns until the access password is entered.
pub const LOCKED_ERROR: &str = "GDrive-Upload is locked";
pub const WRONG_PASSWORD: &str = "Wrong password";
/// Wrong passwords allowed before each further attempt has to wait `THROTTLE`.
pub const FREE_ATTEMPTS: u32 = 5;
pub const THROTTLE: Duration = Duration::from_secs(30);

const ACCESS_ALG: &str = "pbkdf2-sha256";
const MIN_ITERATIONS: u64 = 1_000;
const MAX_ITERATIONS: u64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteState {
    #[default]
    Ok,
    Maintenance,
}

/// The `access` block after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessSpec {
    pub iterations: u32,
    pub salt: Vec<u8>,
    pub hash: Vec<u8>,
    /// First 16 hex characters of sha256(salt || hash). Stored in the
    /// credential store once the password is accepted.
    pub id: String,
}

/// The remote document after validation.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusDoc {
    pub status: RemoteState,
    pub title: Option<String>,
    pub message: Option<String>,
    pub min_version: Option<String>,
    pub update_url: Option<String>,
    pub check_minutes: Option<u32>,
    pub access: Option<AccessSpec>,
}

impl StatusDoc {
    pub fn interval(&self) -> Duration {
        let minutes = self
            .check_minutes
            .unwrap_or(DEFAULT_CHECK_MINUTES)
            .clamp(1, 60);
        Duration::from_secs(u64::from(minutes) * 60)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockReason {
    /// The document says "maintenance".
    Maintenance,
    /// This build is older than `minVersion`.
    Update,
    /// A password is required and this OS user has not entered it yet.
    Access,
    /// The build requires a password but has never read the document.
    Connect,
}

/// What the window shows (`service-lock-changed` event, `service_lock` command).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLock {
    pub locked: bool,
    pub reason: Option<LockReason>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub update_url: Option<String>,
    pub min_version: Option<String>,
    pub app_version: String,
    /// A status URL is configured, so the switch is on in this build.
    pub enabled: bool,
    /// Unix ms of the last successful fetch, in this run or an earlier one.
    pub checked_at: Option<i64>,
    /// Why the last fetch failed; cleared by the next success.
    pub last_error: Option<String>,
    /// A fetch is in flight.
    pub checking: bool,
    /// Seconds until the password screen accepts another attempt.
    pub retry_after_secs: Option<u64>,
}

// ------------------------------------------------------------------ parsing

fn clean_text(v: Option<&Value>, max_chars: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(max_chars).collect())
}

/// Parse the document. `None` means no information (too large, not JSON, not
/// an object, no valid `status`, or an unreadable `access` block): the caller
/// keeps the last known state. Unknown fields are ignored; invalid optional
/// fields other than `access` are dropped.
pub fn parse(bytes: &[u8]) -> Option<StatusDoc> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    parse_value(&value)
}

pub fn parse_value(value: &Value) -> Option<StatusDoc> {
    let o = value.as_object()?;
    let status = match o
        .get("status")?
        .as_str()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "ok" => RemoteState::Ok,
        "maintenance" => RemoteState::Maintenance,
        _ => return None,
    };
    // An `access` block that is there but unreadable is not "no password":
    // dropping it would let one typo in the gist switch the password off for
    // everyone. The whole document counts as no information instead.
    let access = match o.get("access") {
        None | Some(Value::Null) => None,
        Some(v) => Some(parse_access(v)?),
    };
    let update_url = clean_text(o.get("updateUrl"), 2000).filter(|u| {
        url::Url::parse(u)
            .map(|p| matches!(p.scheme(), "https" | "http"))
            .unwrap_or(false)
    });
    let min_version = clean_text(o.get("minVersion"), 64).filter(|v| parse_version(v).is_some());
    let check_minutes = o
        .get("checkMinutes")
        .and_then(|x| x.as_f64())
        .filter(|x| x.is_finite())
        .map(|x| x.round().clamp(1.0, 60.0) as u32);
    Some(StatusDoc {
        status,
        title: clean_text(o.get("title"), 200),
        message: clean_text(o.get("message"), 2000),
        min_version,
        update_url,
        check_minutes,
        access,
    })
}

fn decode_b64(v: &Value) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(v.as_str()?.trim())
        .ok()
}

fn parse_access(v: &Value) -> Option<AccessSpec> {
    let o = v.as_object()?;
    if !o
        .get("alg")?
        .as_str()?
        .trim()
        .eq_ignore_ascii_case(ACCESS_ALG)
    {
        return None;
    }
    let iterations = o
        .get("iterations")?
        .as_u64()
        .filter(|n| (MIN_ITERATIONS..=MAX_ITERATIONS).contains(n))? as u32;
    let salt = decode_b64(o.get("salt")?).filter(|s| (8..=64).contains(&s.len()))?;
    let hash = decode_b64(o.get("hash")?).filter(|h| h.len() == 32)?;
    let id = access_id(&salt, &hash);
    // The id is derived, so a stated one that disagrees means the block was
    // edited by hand and is not trustworthy.
    if let Some(stated) = o.get("id") {
        if !stated.as_str()?.trim().eq_ignore_ascii_case(&id) {
            return None;
        }
    }
    Some(AccessSpec {
        iterations,
        salt,
        hash,
        id,
    })
}

/// First 16 hex characters of sha256(salt || hash).
pub fn access_id(salt: &[u8], hash: &[u8]) -> String {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(salt);
    ctx.update(hash);
    ctx.finish().as_ref()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// PBKDF2-HMAC-SHA256(password, salt, iterations, 32 bytes) compared with
/// `hash` in constant time (`ring::pbkdf2::verify`).
pub fn verify_password(spec: &AccessSpec, password: &str) -> bool {
    let Some(iterations) = NonZeroU32::new(spec.iterations) else {
        return false;
    };
    ring::pbkdf2::verify(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &spec.salt,
        password.as_bytes(),
        &spec.hash,
    )
    .is_ok()
}

/// "1.2.3", "v1.2", "1.0.0-beta.2" → numeric parts (pre-release and build
/// suffixes are ignored). None when the first part is not a number.
pub fn parse_version(v: &str) -> Option<Vec<u64>> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or("");
    let mut out = Vec::new();
    for (i, part) in core.split('.').enumerate() {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        match digits.parse::<u64>() {
            Ok(n) => out.push(n),
            Err(_) if i == 0 => return None,
            Err(_) => out.push(0),
        }
    }
    Some(out)
}

/// True when `app` is older than `min`. Unparsable versions never count as older.
pub fn version_older(app: &str, min: &str) -> bool {
    let (Some(mut a), Some(mut b)) = (parse_version(app), parse_version(min)) else {
        return false;
    };
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a < b
}

/// The lock a document implies on its own (maintenance wins over "update required").
pub fn lock_reason(doc: &StatusDoc, app_version: &str) -> Option<LockReason> {
    if doc.status == RemoteState::Maintenance {
        return Some(LockReason::Maintenance);
    }
    match &doc.min_version {
        Some(min) if version_older(app_version, min) => Some(LockReason::Update),
        _ => None,
    }
}

/// The lock for this OS user: the document's own lock first, then the password.
/// `granted` holds the access ids this user has unlocked with.
pub fn evaluate(
    doc: Option<&StatusDoc>,
    app_version: &str,
    require_access: bool,
    granted: &[String],
) -> Option<LockReason> {
    let Some(doc) = doc else {
        return require_access.then_some(LockReason::Connect);
    };
    if let Some(reason) = lock_reason(doc, app_version) {
        return Some(reason);
    }
    match &doc.access {
        Some(access) if !granted.contains(&access.id) => Some(LockReason::Access),
        _ => None,
    }
}

/// Status URLs must be https; plain http only for a local test server, and
/// only when allowed (debug builds).
pub fn validate_url(raw: &str, allow_local_http: bool) -> Result<String, String> {
    let u = url::Url::parse(raw.trim()).map_err(|e| format!("invalid status URL: {e}"))?;
    match u.scheme() {
        "https" => Ok(u.to_string()),
        "http" if allow_local_http && is_loopback(&u) => Ok(u.to_string()),
        "http" => Err(
            "the status URL must use https:// (http:// only for 127.0.0.1 / localhost in tests)"
                .into(),
        ),
        s => Err(format!("unsupported status URL scheme {s}://")),
    }
}

fn is_loopback(u: &url::Url) -> bool {
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

// ------------------------------------------------------------------ credential store

/// Where the accepted access id is kept, per OS user, so every account on a
/// shared machine is asked separately. The app uses the OS credential store
/// plus a file in the user's app data folder (`service::RememberedAccess`).
pub trait AccessStore: Send + Sync {
    /// Every id remembered here. More than one when the places it is kept in
    /// disagree (one of them failed to take the latest).
    fn load(&self) -> Vec<String>;
    /// Ok when at least one place took it.
    fn save(&self, id: &str) -> Result<(), String>;
}

/// In-memory store for tests.
#[derive(Default, Clone)]
pub struct MemoryAccessStore(Arc<Mutex<Option<String>>>);

impl MemoryAccessStore {
    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl AccessStore for MemoryAccessStore {
    fn load(&self) -> Vec<String> {
        self.get().into_iter().collect()
    }

    fn save(&self, id: &str) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_string());
        Ok(())
    }
}

/// An `AccessStore` (the OS credential store in the app) backed by a file in
/// the user's app data folder. Each counts on its own: an id is remembered if
/// either place took it, and a place that failed to take the latest id cannot
/// hide it. See `service::KeyringAccess` for why the file is needed.
pub struct FileBackedAccess<P: AccessStore> {
    pub primary: P,
    pub file: PathBuf,
}

impl<P: AccessStore> AccessStore for FileBackedAccess<P> {
    fn load(&self) -> Vec<String> {
        let mut ids = self.primary.load();
        if let Some(id) = read_access_file(&self.file) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }

    fn save(&self, id: &str) -> Result<(), String> {
        let primary = self.primary.save(id);
        let file = write_access_file(&self.file, id);
        if let Err(e) = &primary {
            log::warn!("access: {e}; kept in {} instead", self.file.display());
        }
        match (primary, file) {
            (Err(a), Err(b)) => Err(format!("{a}; {b}")),
            _ => Ok(()),
        }
    }
}

fn is_access_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The access id kept in a file, when there is a valid one.
pub fn read_access_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let id = text.trim().to_ascii_lowercase();
    is_access_id(&id).then_some(id)
}

/// Keeps the access id in a file (write, then rename into place).
pub fn write_access_file(path: &Path, id: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, id)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| format!("{}: {e}", path.display()))
}

// ------------------------------------------------------------------ runtime state

pub struct ServiceConfig {
    /// Validated status URL. None turns the switch off in this build.
    pub url: Option<String>,
    /// Fail closed until the document has been read once.
    pub require_access: bool,
    pub app_version: String,
    /// Where the last good document is kept, in the app data dir.
    pub state_file: PathBuf,
    /// Poll interval instead of the document's `checkMinutes` (debug builds, tests).
    pub poll_every: Option<Duration>,
    /// How long a wrong password blocks further attempts once `FREE_ATTEMPTS` are used.
    pub throttle: Duration,
}

/// The last good document as stored on disk. The raw JSON is kept and parsed
/// again on startup, so a stored document passes the same checks as a fetched one.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    fetched_at: i64,
    document: Value,
}

#[derive(Default)]
struct Shared {
    doc: Option<StatusDoc>,
    fetched_at: Option<i64>,
    last_error: Option<String>,
    /// Access ids this OS user has unlocked with.
    granted: Vec<String>,
    checking: bool,
    failures: u32,
    blocked_until: Option<Instant>,
}

/// Called with the new state whenever it changes; the flag is true when the
/// app has just become locked.
type Listener = Box<dyn Fn(&ServiceLock, bool) + Send + Sync>;

pub struct ServiceCore {
    cfg: ServiceConfig,
    store: Box<dyn AccessStore>,
    shared: Mutex<Shared>,
    /// True while locked. The upload engine watches it to stop and resume.
    gate: watch::Sender<bool>,
    /// Serializes fetch + apply (poll loop and "Check again").
    check: tokio::sync::Mutex<()>,
    wake: Notify,
    started: AtomicBool,
    listener: Mutex<Option<Listener>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_persisted(path: &Path) -> Option<(StatusDoc, i64)> {
    let text = std::fs::read_to_string(path).ok()?;
    let p: Persisted = serde_json::from_str(&text).ok()?;
    if p.fetched_at <= 0 {
        return None;
    }
    Some((parse_value(&p.document)?, p.fetched_at))
}

fn write_persisted(path: &Path, p: &Persisted) {
    let Ok(text) = serde_json::to_string(p) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write then rename, so a crash mid-write cannot leave a torn file that
    // would read as "never fetched".
    let tmp = path.with_extension("json.tmp");
    let result = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, path));
    if let Err(e) = result {
        log::warn!("remote status: cannot save {}: {e}", path.display());
    }
}

/// The innermost cause of a request error ("Connection refused (os error 61)",
/// "dns error: …"), which says more than reqwest's own "error sending request
/// for url (…)" and leaves out the cache-busting query.
fn root_cause(e: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    if e.is_timeout() {
        "timed out".to_string()
    } else {
        cause.to_string()
    }
}

fn throttle_message(until: Instant) -> String {
    let secs = until
        .saturating_duration_since(Instant::now())
        .as_secs()
        .max(1);
    format!("Too many wrong passwords. Try again in {secs} s.")
}

impl ServiceCore {
    /// Restores the last good document before anything else runs, so a lock
    /// from an earlier run is in force from the first instant.
    pub fn new(cfg: ServiceConfig, store: Box<dyn AccessStore>) -> Arc<Self> {
        let mut shared = Shared::default();
        if cfg.url.is_some() {
            shared.granted = store.load();
            if let Some((doc, at)) = read_persisted(&cfg.state_file) {
                shared.doc = Some(doc);
                shared.fetched_at = Some(at);
            }
        } else if cfg.state_file.exists() {
            // No switch in this build: a lock must never outlive it.
            let _ = std::fs::remove_file(&cfg.state_file);
        }
        let core = Self {
            cfg,
            store,
            shared: Mutex::new(shared),
            gate: watch::channel(false).0,
            check: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
            started: AtomicBool::new(false),
            listener: Mutex::new(None),
        };
        let state = core.state();
        if state.locked {
            log::warn!("remote status: locked at startup ({:?})", state.reason);
        }
        core.gate.send_replace(state.locked);
        Arc::new(core)
    }

    fn shared(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reason(&self, sh: &Shared) -> Option<LockReason> {
        self.cfg.url.as_ref()?;
        evaluate(
            sh.doc.as_ref(),
            &self.cfg.app_version,
            self.cfg.require_access,
            &sh.granted,
        )
    }

    pub fn enabled(&self) -> bool {
        self.cfg.url.is_some()
    }

    pub fn state(&self) -> ServiceLock {
        let sh = self.shared();
        let reason = self.reason(&sh);
        let doc = sh.doc.clone().unwrap_or_default();
        ServiceLock {
            locked: reason.is_some(),
            reason,
            title: doc.title,
            message: doc.message,
            update_url: doc.update_url,
            min_version: doc.min_version,
            app_version: self.cfg.app_version.clone(),
            enabled: self.enabled(),
            checked_at: sh.fetched_at,
            last_error: sh.last_error.clone(),
            checking: sh.checking,
            retry_after_secs: sh
                .blocked_until
                .and_then(|until| until.checked_duration_since(Instant::now()))
                .map(|left| left.as_secs().max(1)),
        }
    }

    pub fn is_locked(&self) -> bool {
        self.reason(&self.shared()).is_some()
    }

    /// The guard every command that starts work calls first.
    pub fn ensure_unlocked(&self) -> Result<(), String> {
        match self.reason(&self.shared()) {
            None => Ok(()),
            Some(LockReason::Maintenance | LockReason::Update) => Err(PAUSED_ERROR.into()),
            Some(LockReason::Access | LockReason::Connect) => Err(LOCKED_ERROR.into()),
        }
    }

    /// True while locked; the upload engine holds its work while it is.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.gate.subscribe()
    }

    pub fn on_change(&self, listener: impl Fn(&ServiceLock, bool) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(listener));
    }

    /// Push the current state to the gate and the listener.
    fn publish(&self) {
        let state = self.state();
        let was = self.gate.send_replace(state.locked);
        if state.locked != was {
            if state.locked {
                log::warn!("remote status: locking ({:?})", state.reason);
            } else {
                log::warn!("remote status: unlocking");
            }
        }
        if let Some(listener) = self
            .listener
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            listener(&state, state.locked && !was);
        }
    }

    /// Apply a freshly fetched document: store it, then lock or unlock.
    pub fn apply_document(&self, doc: StatusDoc, raw: Value) {
        let now = now_ms();
        write_persisted(
            &self.cfg.state_file,
            &Persisted {
                fetched_at: now,
                document: raw,
            },
        );
        {
            let mut sh = self.shared();
            sh.doc = Some(doc);
            sh.fetched_at = Some(now);
            sh.last_error = None;
        }
        self.publish();
    }

    /// Record a failed fetch. The lock does not change (fail-open, sticky).
    fn note_error(&self, error: String) {
        log::info!("remote status: {error}");
        self.shared().last_error = Some(error);
        self.publish();
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            // Never downgrade: redirects stay on https (or a loopback test server).
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() == "https" || is_loopback(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirect to a non-https address")
            }
        });
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .connect_timeout(FETCH_TIMEOUT)
            .redirect(policy)
            .user_agent(format!("{APP_NAME}/{}", self.cfg.app_version))
            .build()
            .map_err(|e| format!("cannot create HTTP client: {e}"))
    }

    /// GET the document (cache-busting query, no cookies, 64 KB cap).
    /// `Ok(None)` = fetched but unusable (no information).
    pub async fn fetch(&self, url: &str) -> Result<Option<(StatusDoc, Value)>, String> {
        let mut u = url::Url::parse(url).map_err(|e| e.to_string())?;
        u.query_pairs_mut()
            .append_pair("_hs", &now_ms().to_string());
        let mut resp = self
            .client()?
            .get(u)
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .header(reqwest::header::PRAGMA, "no-cache")
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
            .send()
            .await
            .map_err(|e| format!("cannot reach the status server: {}", root_cause(&e)))?;
        if !resp.status().is_success() {
            return Err(format!(
                "status server answered HTTP {}",
                resp.status().as_u16()
            ));
        }
        if resp.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return Ok(None);
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("status download failed: {}", root_cause(&e)))?
        {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_BYTES {
                return Ok(None);
            }
        }
        let Ok(value) = serde_json::from_slice::<Value>(&body) else {
            return Ok(None);
        };
        Ok(parse_value(&value).map(|doc| (doc, value)))
    }

    /// Fetch now and apply the result; returns the state afterwards.
    pub async fn check_now(&self) -> ServiceLock {
        let Some(url) = self.cfg.url.clone() else {
            return self.state();
        };
        let _guard = self.check.lock().await;
        self.shared().checking = true;
        self.publish();
        let result = self.fetch(&url).await;
        self.shared().checking = false;
        match result {
            Ok(Some((doc, raw))) => self.apply_document(doc, raw),
            Ok(None) => self.note_error(
                "the status document is not valid; keeping the last known state".into(),
            ),
            Err(e) => self.note_error(e),
        }
        self.state()
    }

    fn next_wait(&self) -> Duration {
        if let Some(every) = self.cfg.poll_every {
            return every;
        }
        match &self.shared().doc {
            Some(doc) => doc.interval(),
            None if self.cfg.require_access => FIRST_CONTACT_RETRY,
            None => Duration::from_secs(u64::from(DEFAULT_CHECK_MINUTES) * 60),
        }
    }

    /// The poll loop: first check right away, then every `checkMinutes`.
    /// Runs until the process ends; a second call returns at once.
    pub async fn run(self: Arc<Self>) {
        if !self.enabled() || self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        log::info!(
            "remote status: polling {}",
            self.cfg.url.as_deref().unwrap_or_default()
        );
        loop {
            self.check_now().await;
            let wait = self.next_wait();
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.wake.notified() => {}
            }
        }
    }

    /// Ask the poll loop to check right away.
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// Check the access password. PBKDF2 with 600k rounds takes a noticeable
    /// fraction of a second, so callers run this off the main thread. The
    /// password is never stored or logged; only the id goes to the store.
    pub fn unlock(&self, password: &str) -> Result<ServiceLock, String> {
        let spec = {
            let sh = self.shared();
            let Some(spec) = sh.doc.as_ref().and_then(|d| d.access.clone()) else {
                drop(sh);
                return Ok(self.state());
            };
            if sh.granted.contains(&spec.id) {
                drop(sh);
                return Ok(self.state());
            }
            if let Some(until) = sh.blocked_until.filter(|until| *until > Instant::now()) {
                return Err(throttle_message(until));
            }
            spec
        };

        let accepted = verify_password(&spec, password);
        {
            let mut sh = self.shared();
            if accepted {
                sh.failures = 0;
                sh.blocked_until = None;
                sh.granted.push(spec.id.clone());
            } else {
                sh.failures += 1;
                if sh.failures >= FREE_ATTEMPTS {
                    sh.blocked_until = Some(Instant::now() + self.cfg.throttle);
                }
            }
        }

        if accepted {
            log::info!("access: password accepted");
            // If nothing could keep it, the password still holds for this run
            // and is asked again next time.
            match self.store.save(&spec.id) {
                Ok(()) => log::info!("access: remembered for this user"),
                Err(e) => log::warn!("access: cannot remember the password: {e}"),
            }
            self.publish();
            Ok(self.state())
        } else {
            log::info!("access: wrong password");
            self.publish();
            Err(WRONG_PASSWORD.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated with Node, exactly as scripts/gdexplorer-status.mjs does it:
    // crypto.pbkdf2Sync("correct horse battery staple", salt, it, 32, "sha256")
    // with salt = bytes 0..16.
    const PASSWORD: &str = "correct horse battery staple";
    const SALT: &str = "AAECAwQFBgcICQoLDA0ODw==";
    const HASH_600K: &str = "7xdxRO7JQgy8EJPSqLNEqSvFBtDU7JwCjdGfgyTYweY=";
    const ID_600K: &str = "2e3c27cab79ad82a";
    const HASH_1K: &str = "ppsXnjrdPB4KryJ6DrOqKqhkWrhv7PbKAMF1Eml8cZ4=";
    const ID_1K: &str = "31ee27f8fc8c671b";

    fn access_json(iterations: u32, hash: &str, id: Option<&str>) -> String {
        let id = id.map(|i| format!(r#","id":"{i}""#)).unwrap_or_default();
        format!(
            r#"{{"alg":"pbkdf2-sha256","iterations":{iterations},"salt":"{SALT}","hash":"{hash}"{id}}}"#
        )
    }

    fn doc_with_access(iterations: u32, hash: &str, id: Option<&str>) -> Option<StatusDoc> {
        parse(
            format!(
                r#"{{"status":"ok","access":{}}}"#,
                access_json(iterations, hash, id)
            )
            .as_bytes(),
        )
    }

    #[test]
    fn parses_ok_and_maintenance() {
        let d = parse(br#"{"status":"ok"}"#).unwrap();
        assert_eq!(d.status, RemoteState::Ok);
        assert_eq!(d.interval(), Duration::from_secs(300));
        assert_eq!(d.access, None);
        let d = parse(
            br#"{"status":"Maintenance","title":"  Work is in progress ","message":"Back soon","minVersion":"1.2.0",
                "updateUrl":"https://example.com/app","checkMinutes":2,"extra":{"ignored":true}}"#,
        )
        .unwrap();
        assert_eq!(d.status, RemoteState::Maintenance);
        assert_eq!(d.title.as_deref(), Some("Work is in progress"));
        assert_eq!(d.message.as_deref(), Some("Back soon"));
        assert_eq!(d.min_version.as_deref(), Some("1.2.0"));
        assert_eq!(d.update_url.as_deref(), Some("https://example.com/app"));
        assert_eq!(d.interval(), Duration::from_secs(120));
    }

    #[test]
    fn garbage_is_no_information() {
        for bad in [
            &b""[..],
            b"null",
            b"[]",
            b"<html>503</html>",
            br#"{"status":"locked"}"#,
            br#"{"status":1}"#,
            br#"{"title":"x"}"#,
        ] {
            assert_eq!(parse(bad), None, "{}", String::from_utf8_lossy(bad));
        }
        // invalid optional fields are dropped, the document stays usable
        let d = parse(
            br#"{"status":"ok","updateUrl":"javascript:alert(1)","minVersion":"latest","checkMinutes":999,"title":""}"#,
        )
        .unwrap();
        assert_eq!(
            (&d.update_url, &d.min_version, &d.title),
            (&None, &None, &None)
        );
        assert_eq!(d.interval(), Duration::from_secs(3600));
        assert_eq!(
            parse(br#"{"status":"ok","checkMinutes":0}"#)
                .unwrap()
                .interval(),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn oversize_is_rejected() {
        let mut big = br#"{"status":"maintenance","message":""#.to_vec();
        big.extend(std::iter::repeat_n(b'a', MAX_BYTES));
        big.extend_from_slice(br#""}"#);
        assert_eq!(parse(&big), None);
        // long fields are cut, not rejected
        let long = format!(
            r#"{{"status":"maintenance","title":"{}"}}"#,
            "t".repeat(1000)
        );
        assert_eq!(
            parse(long.as_bytes())
                .unwrap()
                .title
                .unwrap()
                .chars()
                .count(),
            200
        );
    }

    #[test]
    fn version_compare() {
        assert!(version_older("1.0.0", "1.0.10"));
        assert!(version_older("1.0.9", "1.0.10"));
        assert!(!version_older("1.0.10", "1.0.9"));
        assert!(!version_older("1.0.0", "1.0.0"));
        assert!(!version_older("1.0", "1.0.0"));
        assert!(version_older("1.0", "1.0.1"));
        assert!(version_older("0.9.9", "1"));
        assert!(version_older("0.2.32", "0.2.33"));
        assert!(!version_older("v2.0.0", "1.99.99"));
        assert!(!version_older("1.0.0-beta.1", "1.0.0"));
        // unknown versions never lock
        assert!(!version_older("test", "9.9.9"));
        assert!(!version_older("1.0.0", "garbage"));
    }

    #[test]
    fn lock_reasons() {
        let mut d = StatusDoc::default();
        assert_eq!(lock_reason(&d, "1.0.0"), None);
        d.min_version = Some("1.0.1".into());
        assert_eq!(lock_reason(&d, "1.0.0"), Some(LockReason::Update));
        assert_eq!(lock_reason(&d, "1.0.1"), None);
        d.status = RemoteState::Maintenance;
        assert_eq!(lock_reason(&d, "1.0.1"), Some(LockReason::Maintenance));
        assert_eq!(lock_reason(&d, "1.0.0"), Some(LockReason::Maintenance));
    }

    #[test]
    fn url_rules() {
        assert!(validate_url("https://gist.githubusercontent.com/a/b/raw/s.json", false).is_ok());
        assert!(validate_url("http://example.com/s.json", false).is_err());
        assert!(validate_url("http://example.com/s.json", true).is_err());
        assert!(validate_url("http://127.0.0.1:8799/status.json", false).is_err());
        assert!(validate_url("http://127.0.0.1:8799/status.json", true).is_ok());
        assert!(validate_url("http://localhost:8799/status.json", true).is_ok());
        assert!(validate_url("file:///etc/passwd", true).is_err());
        assert!(validate_url("", true).is_err());
    }

    #[test]
    fn baked_config_is_https_and_requires_access() {
        let v: Value = serde_json::from_str(include_str!("../remote-status.json")).unwrap();
        let url = v["url"].as_str().unwrap();
        assert!(validate_url(url, false).is_ok(), "{url}");
        assert_eq!(v["requireAccess"], Value::Bool(true));
    }

    #[test]
    fn access_id_matches_node() {
        let salt = base64::engine::general_purpose::STANDARD
            .decode(SALT)
            .unwrap();
        let hash = base64::engine::general_purpose::STANDARD
            .decode(HASH_600K)
            .unwrap();
        assert_eq!(access_id(&salt, &hash), ID_600K);
    }

    #[test]
    fn verifies_the_node_vector_at_600k_rounds() {
        let doc = doc_with_access(600_000, HASH_600K, Some(ID_600K)).expect("valid access block");
        let access = doc.access.unwrap();
        assert_eq!(access.iterations, 600_000);
        assert_eq!(access.id, ID_600K);
        assert!(verify_password(&access, PASSWORD));
        assert!(!verify_password(&access, "correct horse battery stapler"));
        assert!(!verify_password(&access, ""));
    }

    #[test]
    fn wrong_password_and_case_are_refused() {
        let access = doc_with_access(1_000, HASH_1K, None)
            .unwrap()
            .access
            .unwrap();
        assert_eq!(
            access.id, ID_1K,
            "id is derived when the block leaves it out"
        );
        assert!(verify_password(&access, PASSWORD));
        assert!(!verify_password(&access, &PASSWORD.to_uppercase()));
        assert!(!verify_password(&access, &format!("{PASSWORD} ")));
    }

    #[test]
    fn unreadable_access_block_is_no_information() {
        // a hand-edited id, a wrong algorithm, a short hash, bad base64, too few rounds
        assert_eq!(
            doc_with_access(1_000, HASH_1K, Some("0000000000000000")),
            None
        );
        let bad_alg = format!(
            r#"{{"status":"ok","access":{}}}"#,
            access_json(1_000, HASH_1K, None).replace("pbkdf2-sha256", "md5")
        );
        assert_eq!(parse(bad_alg.as_bytes()), None);
        assert_eq!(doc_with_access(1_000, "AAAA", None), None);
        assert_eq!(doc_with_access(1_000, "not base64!", None), None);
        assert_eq!(doc_with_access(10, HASH_1K, None), None);
        assert_eq!(parse(br#"{"status":"ok","access":"on"}"#), None);
        // null means no password
        assert_eq!(
            parse(br#"{"status":"ok","access":null}"#).unwrap().access,
            None
        );
    }

    #[test]
    fn the_access_file_round_trips_and_ignores_junk() {
        let dir = std::env::temp_dir().join(format!(
            "gdx-access-file-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = dir.join("nested").join("access-id");
        assert_eq!(read_access_file(&file), None, "missing file");
        write_access_file(&file, ID_1K).unwrap();
        assert_eq!(read_access_file(&file).as_deref(), Some(ID_1K));
        assert!(!file.with_extension("tmp").exists());
        for junk in ["", "not an id", "31ee27f8fc8c671", "31ee27f8fc8c671bz"] {
            std::fs::write(&file, junk).unwrap();
            assert_eq!(read_access_file(&file), None, "{junk:?}");
        }
        // hand-edited: whitespace and capitals are fine
        std::fs::write(&file, format!(" {}\r\n", ID_1K.to_uppercase())).unwrap();
        assert_eq!(read_access_file(&file).as_deref(), Some(ID_1K));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluate_orders_the_locks() {
        let with_access = doc_with_access(1_000, HASH_1K, None).unwrap();
        // never fetched: only a build that requires access is locked
        assert_eq!(evaluate(None, "1.0.0", false, &[]), None);
        assert_eq!(
            evaluate(None, "1.0.0", true, &[]),
            Some(LockReason::Connect)
        );
        // password
        assert_eq!(
            evaluate(Some(&with_access), "1.0.0", false, &[]),
            Some(LockReason::Access)
        );
        assert_eq!(
            evaluate(Some(&with_access), "1.0.0", true, &["other".to_string()]),
            Some(LockReason::Access)
        );
        assert_eq!(
            evaluate(Some(&with_access), "1.0.0", true, &[ID_1K.to_string()]),
            None
        );
        // remembered in two places that disagree: either one is enough
        assert_eq!(
            evaluate(
                Some(&with_access),
                "1.0.0",
                true,
                &["stale".to_string(), ID_1K.to_string()]
            ),
            None
        );
        // maintenance wins over the password screen
        let mut both = with_access.clone();
        both.status = RemoteState::Maintenance;
        assert_eq!(
            evaluate(Some(&both), "1.0.0", true, &[]),
            Some(LockReason::Maintenance)
        );
        assert_eq!(
            evaluate(Some(&both), "1.0.0", true, &[ID_1K.to_string()]),
            Some(LockReason::Maintenance)
        );
        // after one successful fetch a document without access means no password
        assert_eq!(
            evaluate(Some(&StatusDoc::default()), "1.0.0", true, &[]),
            None
        );
    }
}
