//! The remote switch and access password against a local HTTP server: lock and
//! release, stickiness across restarts and outages, garbage never changing
//! anything, the password flow (wrong, right, restart, change, off),
//! throttling, and a build that requires access but never reached the server.

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri_app_lib::remote_status::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const APP_VERSION: &str = "0.2.32";

// ------------------------------------------------------------------ test server

#[derive(Clone)]
enum Reply {
    Json(String),
    Status(u16),
    /// Accept, read the request, close without answering (an outage).
    Hangup,
}

struct Server {
    port: u16,
    reply: Arc<Mutex<Reply>>,
    last_request: Arc<Mutex<String>>,
}

impl Server {
    async fn start(reply: Reply) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let reply = Arc::new(Mutex::new(reply));
        let last_request = Arc::new(Mutex::new(String::new()));
        let (shared_reply, shared_last) = (reply.clone(), last_request.clone());
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let reply = shared_reply.lock().unwrap().clone();
                let last = shared_last.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 2048];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => request.extend_from_slice(&chunk[..n]),
                        }
                    }
                    *last.lock().unwrap() = String::from_utf8_lossy(&request).into_owned();
                    let response = match reply {
                        Reply::Hangup => return,
                        Reply::Status(code) => format!(
                            "HTTP/1.1 {code} Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        )
                        .into_bytes(),
                        Reply::Json(body) => {
                            let mut r = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            r.extend_from_slice(body.as_bytes());
                            r
                        }
                    };
                    let _ = sock.write_all(&response).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Self {
            port,
            reply,
            last_request,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/status.json", self.port)
    }

    fn set(&self, reply: Reply) {
        *self.reply.lock().unwrap() = reply;
    }

    fn serve(&self, doc: &Value) {
        self.set(Reply::Json(doc.to_string()));
    }
}

// ------------------------------------------------------------------ helpers

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gdx-remote-status-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn state_file(&self) -> PathBuf {
        self.0.join("service-status.json")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn core(
    url: Option<String>,
    dir: &TempDir,
    store: &MemoryAccessStore,
    require_access: bool,
) -> Arc<ServiceCore> {
    core_with(url, dir, Box::new(store.clone()), require_access)
}

fn core_with(
    url: Option<String>,
    dir: &TempDir,
    store: Box<dyn AccessStore>,
    require_access: bool,
) -> Arc<ServiceCore> {
    ServiceCore::new(
        ServiceConfig {
            url,
            require_access,
            app_version: APP_VERSION.into(),
            state_file: dir.state_file(),
            poll_every: None,
            throttle: Duration::from_millis(300),
        },
        store,
    )
}

/// A credential store like Windows Credential Manager on a server that
/// forbids storing credentials: it refuses every entry, and may still hold an
/// old one.
struct RefusingStore(Vec<String>);

impl AccessStore for RefusingStore {
    fn load(&self) -> Vec<String> {
        self.0.clone()
    }

    fn save(&self, _id: &str) -> Result<(), String> {
        Err("A specified logon session does not exist. (os error 1312)".into())
    }
}

/// What `scripts/gdexplorer-status.mjs password` writes, with few rounds so
/// the tests stay fast.
fn access_block(password: &str, salt: &[u8]) -> Value {
    let iterations = 1_000;
    let mut hash = [0u8; 32];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(iterations).unwrap(),
        salt,
        password.as_bytes(),
        &mut hash,
    );
    let b64 = base64::engine::general_purpose::STANDARD;
    json!({
        "alg": "pbkdf2-sha256",
        "iterations": iterations,
        "salt": b64.encode(salt),
        "hash": b64.encode(hash),
        "id": access_id(salt, &hash),
    })
}

fn ok() -> Value {
    json!({"status": "ok", "checkMinutes": 5})
}

fn maintenance() -> Value {
    json!({"status": "maintenance", "title": "Work is in progress", "message": "Back in a few minutes."})
}

fn with_access(mut doc: Value, access: Value) -> Value {
    doc["access"] = access;
    doc
}

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn maintenance_locks_and_ok_releases() {
    let server = Server::start(Reply::Json(ok().to_string())).await;
    let dir = TempDir::new("maintenance");
    let store = MemoryAccessStore::default();
    let core = core(Some(server.url()), &dir, &store, true);
    let events: Arc<Mutex<Vec<(bool, bool)>>> = Arc::default();
    let sink = events.clone();
    core.on_change(move |state, engaged| sink.lock().unwrap().push((state.locked, engaged)));
    let gate = core.subscribe();

    let state = core.check_now().await;
    assert!(!state.locked, "{state:?}");
    assert!(state.checked_at.is_some());
    assert_eq!(core.ensure_unlocked(), Ok(()));
    // cache-busting query and no-cache header on every request
    let request = server.last_request.lock().unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /status.json?_hs="), "{request}");
    assert!(request.contains("cache-control: no-cache"), "{request}");

    server.serve(&maintenance());
    let state = core.check_now().await;
    assert!(state.locked);
    assert_eq!(state.reason, Some(LockReason::Maintenance));
    assert_eq!(state.title.as_deref(), Some("Work is in progress"));
    assert_eq!(state.message.as_deref(), Some("Back in a few minutes."));
    assert_eq!(core.ensure_unlocked(), Err(PAUSED_ERROR.to_string()));
    assert!(*gate.borrow(), "the upload engine sees the lock");

    server.serve(&ok());
    let state = core.check_now().await;
    assert!(!state.locked);
    assert_eq!(core.ensure_unlocked(), Ok(()));
    assert!(!*gate.borrow(), "the upload engine sees the release");

    let events = events.lock().unwrap();
    assert_eq!(
        events.iter().filter(|(_, engaged)| *engaged).count(),
        1,
        "the window is brought forward once, when the lock starts: {events:?}"
    );
}

#[tokio::test]
async fn the_lock_survives_restarts_and_outages() {
    let server = Server::start(Reply::Json(maintenance().to_string())).await;
    let dir = TempDir::new("sticky");
    let store = MemoryAccessStore::default();
    let first = core(Some(server.url()), &dir, &store, false);
    assert!(first.check_now().await.locked);
    drop(first);

    // restart while the server is unreachable: locked before any check
    server.set(Reply::Hangup);
    let second = core(Some(server.url()), &dir, &store, false);
    assert!(second.is_locked(), "restored from the stored document");
    assert!(*second.subscribe().borrow());
    let state = second.check_now().await;
    assert!(state.locked, "an outage changes nothing");
    assert!(state.last_error.is_some());

    server.serve(&ok());
    let state = second.check_now().await;
    assert!(!state.locked);
    assert_eq!(state.last_error, None);
}

#[tokio::test]
async fn garbage_never_locks_or_unlocks() {
    let server = Server::start(Reply::Json(ok().to_string())).await;
    let dir = TempDir::new("garbage");
    let store = MemoryAccessStore::default();
    let core = core(Some(server.url()), &dir, &store, false);
    assert!(!core.check_now().await.locked);

    let oversize = json!({"status": "maintenance", "message": "a".repeat(MAX_BYTES)}).to_string();
    for reply in [
        Reply::Json("<html>503</html>".into()),
        Reply::Json(r#"{"status":"locked"}"#.into()),
        Reply::Json(oversize.clone()),
        Reply::Status(500),
        Reply::Status(404),
        Reply::Hangup,
    ] {
        server.set(reply);
        let state = core.check_now().await;
        assert!(!state.locked, "garbage locked the app");
        assert!(state.last_error.is_some());
    }

    server.serve(&maintenance());
    assert!(core.check_now().await.locked);
    for reply in [
        Reply::Json("not json".into()),
        Reply::Json(oversize),
        Reply::Status(503),
    ] {
        server.set(reply);
        assert!(core.check_now().await.locked, "garbage unlocked the app");
    }
}

#[tokio::test]
async fn password_wrong_right_restart_change_off() {
    let first_password = "correct horse battery staple";
    let second_password = "a different long passphrase";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(first_password, &[1; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("password");
    let store = MemoryAccessStore::default();

    // set: the app asks
    let app = core(Some(server.url()), &dir, &store, true);
    let state = app.check_now().await;
    assert_eq!(state.reason, Some(LockReason::Access));
    assert_eq!(app.ensure_unlocked(), Err(LOCKED_ERROR.to_string()));

    // wrong password refused, nothing remembered
    assert_eq!(app.unlock("guess"), Err(WRONG_PASSWORD.to_string()));
    assert!(app.is_locked());
    assert_eq!(store.get(), None);

    // right password unlocks and is remembered
    let state = app.unlock(first_password).expect("right password");
    assert!(!state.locked);
    assert_eq!(app.ensure_unlocked(), Ok(()));
    let first_id = store.get().expect("id stored");
    assert_eq!(first_id.len(), 16);
    assert_ne!(first_id, first_password);
    drop(app);

    // restart: no prompt, even before the first check
    let app = core(Some(server.url()), &dir, &store, true);
    assert!(!app.is_locked());
    assert!(!app.check_now().await.locked);

    // change the password: asked again; the old one no longer works
    server.serve(&with_access(ok(), access_block(second_password, &[2; 16])));
    assert_eq!(app.check_now().await.reason, Some(LockReason::Access));
    assert_eq!(app.unlock(first_password), Err(WRONG_PASSWORD.to_string()));
    assert!(!app.unlock(second_password).unwrap().locked);
    assert_ne!(store.get(), Some(first_id));

    // --off: no prompt, also for a user who never entered it
    server.serve(&ok());
    assert!(!app.check_now().await.locked);
    let stranger = MemoryAccessStore::default();
    let other_user = core(Some(server.url()), &dir, &stranger, true);
    assert!(!other_user.is_locked());
}

#[tokio::test]
async fn each_os_user_is_asked_separately() {
    let password = "correct horse battery staple";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(password, &[3; 16])).to_string(),
    ))
    .await;
    // Two OS users share the machine but not the credential store (or the
    // app data dir).
    let (dir_a, dir_b) = (TempDir::new("user-a"), TempDir::new("user-b"));
    let (store_a, store_b) = (MemoryAccessStore::default(), MemoryAccessStore::default());
    let user_a = core(Some(server.url()), &dir_a, &store_a, true);
    user_a.check_now().await;
    user_a.unlock(password).unwrap();
    assert!(!user_a.is_locked());

    let user_b = core(Some(server.url()), &dir_b, &store_b, true);
    assert_eq!(user_b.check_now().await.reason, Some(LockReason::Access));
}

#[tokio::test]
async fn maintenance_wins_over_the_password_screen() {
    let password = "correct horse battery staple";
    let access = access_block(password, &[4; 16]);
    let server = Server::start(Reply::Json(
        with_access(maintenance(), access.clone()).to_string(),
    ))
    .await;
    let dir = TempDir::new("both");
    let store = MemoryAccessStore::default();
    let app = core(Some(server.url()), &dir, &store, true);
    assert_eq!(app.check_now().await.reason, Some(LockReason::Maintenance));
    // entering the password during maintenance is remembered for later
    app.unlock(password).unwrap();
    assert_eq!(app.state().reason, Some(LockReason::Maintenance));

    server.serve(&with_access(ok(), access));
    assert!(!app.check_now().await.locked);
}

#[tokio::test]
async fn too_many_wrong_passwords_are_throttled() {
    let password = "correct horse battery staple";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(password, &[5; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("throttle");
    let store = MemoryAccessStore::default();
    let app = core(Some(server.url()), &dir, &store, true);
    app.check_now().await;

    for _ in 0..FREE_ATTEMPTS {
        assert_eq!(app.unlock("guess"), Err(WRONG_PASSWORD.to_string()));
    }
    // blocked: even the right password is not checked
    let refused = app.unlock(password).unwrap_err();
    assert!(refused.starts_with("Too many wrong passwords"), "{refused}");
    assert!(app.state().retry_after_secs.is_some());
    assert!(app.is_locked());

    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(!app.unlock(password).unwrap().locked);
    assert_eq!(app.state().retry_after_secs, None);
}

#[tokio::test]
async fn an_unreadable_access_block_keeps_the_password_on() {
    let password = "correct horse battery staple";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(password, &[6; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("bad-access");
    let store = MemoryAccessStore::default();
    let app = core(Some(server.url()), &dir, &store, true);
    assert_eq!(app.check_now().await.reason, Some(LockReason::Access));

    let mut broken = access_block(password, &[6; 16]);
    broken["hash"] = json!("AAAA");
    server.serve(&with_access(ok(), broken));
    let state = app.check_now().await;
    assert_eq!(
        state.reason,
        Some(LockReason::Access),
        "a typo must not switch the password off"
    );
    assert!(state.last_error.is_some());
}

#[tokio::test]
async fn requiring_access_fails_closed_until_the_first_contact() {
    let server = Server::start(Reply::Hangup).await;
    let dir = TempDir::new("first-contact");
    let store = MemoryAccessStore::default();

    // a build without requireAccess runs normally offline
    let relaxed = core(Some(server.url()), &dir, &store, false);
    assert!(!relaxed.check_now().await.locked);
    drop(relaxed);

    let app = core(Some(server.url()), &dir, &store, true);
    assert_eq!(app.state().reason, Some(LockReason::Connect));
    assert_eq!(app.ensure_unlocked(), Err(LOCKED_ERROR.to_string()));
    let state = app.check_now().await;
    assert_eq!(state.reason, Some(LockReason::Connect));
    assert!(state.last_error.is_some());

    // online once: a document without a password opens the app, and stays
    // open offline afterwards
    server.serve(&ok());
    assert!(!app.check_now().await.locked);
    server.set(Reply::Hangup);
    drop(app);
    let app = core(Some(server.url()), &dir, &store, true);
    assert!(!app.check_now().await.locked);
}

#[tokio::test]
async fn min_version_requires_an_update() {
    let server = Server::start(Reply::Json(
        json!({"status": "ok", "minVersion": "0.2.33", "updateUrl": "https://example.com/new"})
            .to_string(),
    ))
    .await;
    let dir = TempDir::new("min-version");
    let store = MemoryAccessStore::default();
    let app = core(Some(server.url()), &dir, &store, false);
    let state = app.check_now().await;
    assert_eq!(state.reason, Some(LockReason::Update));
    assert_eq!(state.update_url.as_deref(), Some("https://example.com/new"));
    assert_eq!(app.ensure_unlocked(), Err(PAUSED_ERROR.to_string()));

    server.serve(&json!({"status": "ok", "minVersion": APP_VERSION}));
    assert!(!app.check_now().await.locked);
}

#[tokio::test]
async fn a_build_without_a_url_clears_the_sticky_lock() {
    let server = Server::start(Reply::Json(maintenance().to_string())).await;
    let dir = TempDir::new("switch-off");
    let store = MemoryAccessStore::default();
    assert!(
        core(Some(server.url()), &dir, &store, true)
            .check_now()
            .await
            .locked
    );
    assert!(dir.state_file().exists());

    let off = core(None, &dir, &store, true);
    assert!(!off.is_locked());
    assert!(!off.state().enabled);
    assert_eq!(off.ensure_unlocked(), Ok(()));
    assert!(
        !dir.state_file().exists(),
        "a lock must not outlive the switch"
    );
}

#[tokio::test]
async fn the_poll_loop_follows_the_document() {
    let server = Server::start(Reply::Json(ok().to_string())).await;
    let dir = TempDir::new("poll");
    let store = MemoryAccessStore::default();
    let app = ServiceCore::new(
        ServiceConfig {
            url: Some(server.url()),
            require_access: true,
            app_version: APP_VERSION.into(),
            state_file: dir.state_file(),
            poll_every: Some(Duration::from_millis(50)),
            throttle: THROTTLE,
        },
        Box::new(store),
    );
    tokio::spawn(app.clone().run());
    let mut gate = app.subscribe();

    // the first check opens a requireAccess build
    tokio::time::timeout(Duration::from_secs(5), gate.wait_for(|locked| !*locked))
        .await
        .expect("first check")
        .unwrap();
    server.serve(&maintenance());
    tokio::time::timeout(Duration::from_secs(5), gate.wait_for(|locked| *locked))
        .await
        .expect("locked by a later poll")
        .unwrap();
    server.serve(&ok());
    tokio::time::timeout(Duration::from_secs(5), gate.wait_for(|locked| !*locked))
        .await
        .expect("released by a later poll")
        .unwrap();
}

#[tokio::test]
async fn a_refusing_credential_store_still_remembers_the_password() {
    let password = "correct horse battery staple";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(password, &[7; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("refusing-store");
    let file = dir.0.join("access-id");

    // What v0.2.33 did on a server whose Credential Manager refuses entries:
    // the password opened the app for that run only, and every start asked
    // again.
    let bare = core_with(
        Some(server.url()),
        &dir,
        Box::new(RefusingStore(Vec::new())),
        true,
    );
    bare.check_now().await;
    assert!(!bare.unlock(password).unwrap().locked);
    drop(bare);
    let restarted = core_with(
        Some(server.url()),
        &dir,
        Box::new(RefusingStore(Vec::new())),
        true,
    );
    assert_eq!(restarted.state().reason, Some(LockReason::Access));
    drop(restarted);

    // Backed by the file in the app data folder, it is remembered.
    let backed = || -> Box<dyn AccessStore> {
        Box::new(FileBackedAccess {
            primary: RefusingStore(Vec::new()),
            file: file.clone(),
        })
    };
    let app = core_with(Some(server.url()), &dir, backed(), true);
    assert_eq!(app.state().reason, Some(LockReason::Access));
    assert!(!app.unlock(password).unwrap().locked);
    assert!(file.exists());
    drop(app);
    for _ in 0..3 {
        let restarted = core_with(Some(server.url()), &dir, backed(), true);
        assert!(!restarted.is_locked(), "asked again after a restart");
        assert!(!restarted.check_now().await.locked);
    }
}

#[tokio::test]
async fn a_stale_credential_store_entry_does_not_hide_the_new_password() {
    let (old, new) = ("the old passphrase here", "the new passphrase here");
    let old_id = access_block(old, &[8; 16])["id"]
        .as_str()
        .unwrap()
        .to_string();
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(new, &[9; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("stale-store");
    let file = dir.0.join("access-id");
    // The credential store still has the old password's id and refuses the new one.
    let backed = || -> Box<dyn AccessStore> {
        Box::new(FileBackedAccess {
            primary: RefusingStore(vec![old_id.clone()]),
            file: file.clone(),
        })
    };
    let app = core_with(Some(server.url()), &dir, backed(), true);
    assert_eq!(app.check_now().await.reason, Some(LockReason::Access));
    assert!(!app.unlock(new).unwrap().locked);
    drop(app);
    let restarted = core_with(Some(server.url()), &dir, backed(), true);
    assert!(!restarted.is_locked());
}

#[tokio::test]
async fn the_file_alone_is_not_enough_when_both_places_fail() {
    let password = "correct horse battery staple";
    let server = Server::start(Reply::Json(
        with_access(ok(), access_block(password, &[10; 16])).to_string(),
    ))
    .await;
    let dir = TempDir::new("both-fail");
    // a file path that cannot be created: its parent is a file
    std::fs::write(dir.0.join("blocker"), "x").unwrap();
    let store = FileBackedAccess {
        primary: RefusingStore(Vec::new()),
        file: dir.0.join("blocker").join("access-id"),
    };
    assert!(store.save("31ee27f8fc8c671b").is_err());
    // the password still opens the app for this run
    let app = core_with(Some(server.url()), &dir, Box::new(store), true);
    app.check_now().await;
    assert!(!app.unlock(password).unwrap().locked);
}
