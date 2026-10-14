# Remote status: "Work is in progress" switch, access password, per-user install

Every installed copy of GDrive-Upload reads a small JSON document from a secret
GitHub Gist. With it the developer can, from any machine with the GitHub CLI:

- **stop every copy**: a full-window "Work is in progress" screen, all uploads
  stopped, nothing new can start; flip it back and the copies carry on by
  themselves;
- **require a password**: each OS user enters it once, then it is remembered
  for that user permanently; a new password asks everyone again;
- **force an update**: copies older than a version show "Update required".

## Operating it

Needs `gh` logged in as `AdkHex` (the gist owner). Run from the repo root.

| Goal                                     | Command                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| See what the gist says                   | `node scripts/gdexplorer-status.mjs status`                                                                                    |
| Stop every copy                          | `node scripts/gdexplorer-status.mjs maintenance "Updating, back soon"`                                                         |
| … with a title / faster polling          | `node scripts/gdexplorer-status.mjs maintenance "msg" --title "Scheduled maintenance" --check-minutes 2`                       |
| Release them                             | `node scripts/gdexplorer-status.mjs ok`                                                                                        |
| Require a password                       | `node scripts/gdexplorer-status.mjs password` (asks twice, hidden)                                                             |
| Change the password (everyone re-enters) | `node scripts/gdexplorer-status.mjs password`                                                                                  |
| No password                              | `node scripts/gdexplorer-status.mjs password --off`                                                                            |
| Force an update                          | `node scripts/gdexplorer-status.mjs ok --min-version 0.2.40 --update-url https://github.com/AdkHex/GDExplorer/releases/latest` |
| Drop the forced update                   | `node scripts/gdexplorer-status.mjs ok --min-version off --update-url off`                                                     |

Every command reads the current gist first and changes only what it is asked
to: `maintenance` keeps the password, `password` keeps the status. The password
is never printed or written anywhere; only its salted hash goes into the gist.
Use a long passphrase: anyone with the gist link can read the hash and try to
guess it offline (600 000 PBKDF2 rounds slow that down, they do not stop a weak
password).

Ship a build at or above a version before using `--min-version` with it, or
that build locks itself out too (the script warns when the checkout is older).

Changes reach every copy within `checkMinutes` (default 5) plus up to 5 minutes
of GitHub caching. **Check again** on the lock screen fetches immediately.

## What the user sees

| State                                                               | Screen                                                                                                                                                                                                                  | Work                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maintenance`                                                       | Logo, title (default "Work is in progress"), message, "Your uploads are paused and will continue when GDrive-Upload is back.", **Check again**, last check time                                                         | Running rclone processes are stopped; the items stay in the job as paused and run again by themselves on `ok` (rclone skips what already reached Drive). Every command that starts work or talks to Drive is refused in the Rust core with `GDrive-Upload is paused: work is in progress`. |
| version < `minVersion`                                              | "Update required", **Install the update** (the app's own updater), **Download the new version** (`updateUrl`), **Check again**                                                                                          | As maintenance. The updater keeps working.                                                                                                                                                                                                                                                 |
| `access` set, not yet entered by this OS user                       | "This app is strictly prohibited to be used by others" / "If you are the trusted one, enter the password.", password field, **Unlock**, "Wrong password" on failure; after 5 wrong attempts each further one waits 30 s | Everything refused with `GDrive-Upload is locked`.                                                                                                                                                                                                                                         |
| never read the gist (`requireAccess` build, fresh install, offline) | "Checking access…", then "Connect to the internet once to verify access" with **Try again** (retried by itself every 30 s)                                                                                              | Everything refused with `GDrive-Upload is locked`.                                                                                                                                                                                                                                         |

Maintenance wins over the password screen. The screen covers the whole window
(drag, minimize and close still work) and cannot be dismissed; the window
underneath is inert, and menu and tray shortcuts do not open dialogs under it.
The window is brought to the front when a lock starts. Uploads the app was not
running are not started by the unlock: what was queued stays queued.

## The document

```json
{
  "status": "ok",
  "title": "Work is in progress",
  "message": "We're updating GDrive-Upload. Back in a few minutes.",
  "minVersion": "0.2.40",
  "updateUrl": "https://github.com/AdkHex/GDExplorer/releases/latest",
  "checkMinutes": 5,
  "access": {
    "alg": "pbkdf2-sha256",
    "iterations": 600000,
    "salt": "<base64, 16 random bytes>",
    "hash": "<base64, 32 bytes>",
    "id": "<first 16 hex chars of sha256(salt || hash)>"
  }
}
```

| Field              | Meaning                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `status`           | `"ok"` or `"maintenance"` (required, case-insensitive)                             |
| `title`, `message` | Text of the maintenance screen (cut at 200 / 2000 characters, shown as plain text) |
| `minVersion`       | Copies older than this show "Update required" (numeric compare, `0.2.9 < 0.2.10`)  |
| `updateUrl`        | http(s) link for **Download the new version**                                      |
| `checkMinutes`     | Poll interval, clamped to 1..60, default 5                                         |
| `access`           | Present = password required. Absent or `null` = no password                        |

Unknown fields are ignored and invalid optional fields are dropped. A document
that is not JSON, larger than 64 KB, has no valid `status`, or has an `access`
block that cannot be read (wrong `alg`, bad base64, a hash that is not 32 bytes,
an `id` that does not match) counts as **no information**: the app keeps its
last known state. It never locks because of garbage, and a typo in the access
block cannot switch the password off.

## Where it is hosted

A secret gist on `AdkHex`:

- gist `5fee5fd42bf01592e81143dd4ecd7a94`, file `gdexplorer-status.json`
- raw URL, compiled into the app:
  `https://gist.githubusercontent.com/AdkHex/5fee5fd42bf01592e81143dd4ecd7a94/raw/gdexplorer-status.json`

The URL and `requireAccess: true` come from `src-tauri/remote-status.json`, read
at **compile time** (`include_str!`); `build.rs` fails the build if that file is
malformed or the URL is not https. Testers cannot point an installed copy
elsewhere. An empty `url` turns everything off in that build and also clears a
lock stored by an earlier build.

**Never delete or rename the gist.** Copies that cannot reach it keep their last
known state forever. A secret gist is unlisted, not private: anyone with the
link can read it, so it holds only the status and the salted hash.

## Offline behaviour

- Every successful fetch is stored in the app data folder
  (`service-status.json`: `%APPDATA%\com.ionicboy.gdexplorer` on Windows,
  `~/Library/Application Support/com.ionicboy.gdexplorer` on macOS) and applied at
  startup before anything can run. A lock survives restarts and offline periods
  until a successful `ok` arrives.
- A failed fetch (no network, timeout, HTTP error, redirect to http) or an
  unusable document changes nothing. The reason is logged ("remote status: …")
  and shown in small print on the "Connect" screen.
- `requireAccess` is fail-closed for first use only: a copy that has never read
  the gist stays on the "Connect" screen. After one successful fetch the sticky
  rules above apply, so a copy that once read "no password" keeps working
  offline.
- The password, once accepted, is remembered offline and across updates: the
  app keeps `access.id` in the OS credential store (service
  `com.ionicboy.gdexplorer`, account `access`): Windows Credential Manager or the
  macOS Keychain. It also keeps it in the file `access-id` in the app data
  folder, because some Windows servers refuse Credential Manager entries (policy
  "Network access: Do not allow storage of passwords and credentials for network
  authentication"). Without the file, v0.2.33 asked on every start on such a
  server. Either place is enough. Both are per OS user, so every account on a
  shared machine is asked separately. A new password has a new id, so everyone
  is asked again. If neither place can keep it, the password still opens the
  app for that run, and the log says why ("access: cannot remember the
  password: …").

## Per-user Windows install

The installer is **NSIS only, `installMode: currentUser`**
(`bundle.windows.nsis.installMode` in `src-tauri/tauri.conf.json`;
`bundle.targets` is `["nsis", "app", "dmg"]`, no MSI). It installs to
`%LOCALAPPDATA%\GDrive-Upload`, with the Start menu entry and uninstall entry in
the installing user's profile (HKCU), without an administrator prompt. Other
accounts on the machine do not get the app. The updater installs the same way:
`latest.json`'s `windows-x86_64` entry points at the signed `-setup.exe`. The
release workflow checks both before building and after publishing.

Why the RDP server got an all-users copy: the installers on GitHub releases
were already NSIS per-user (`requestedExecutionLevel asInvoker` in
v0.2.32's manifest), but `"targets": "all"` makes a local Windows
`npm run tauri build` produce an MSI too, and Tauri's MSI always installs per
machine into `C:\Program Files\GDrive-Upload` for every account. That target is
gone now.

### Moving a shared server off the all-users copy (once, needs an administrator)

A per-user installer cannot remove a per-machine copy. On Windows the new app
detects one (an `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall` entry
named GDrive-Upload, or `C:\Program Files\GDrive-Upload`) and shows, once per
user: "An all-users copy is installed in Program Files. Ask an administrator to
uninstall it from Settings > Apps."

1. An administrator signs in and uninstalls **GDrive-Upload** from Settings >
   Apps > Installed apps (or Control Panel > Programs and Features). To check
   first: `reg query HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall /s /f GDrive-Upload /d`.
2. Each user who should have the app runs `GDrive-Upload_<version>_x64-setup.exe`
   from the latest release while signed in as themselves. Their settings stay:
   they live in their own profile (see "Identifier change" below), which
   neither installer touches.

## Identifier change: `com.vo1x.gdexplorer` → `com.ionicboy.gdexplorer`

The bundle identifier in `src-tauri/tauri.conf.json` is now
`com.ionicboy.gdexplorer`. It names each user's data folders, so on the first
start under the new identifier the app copies the old ones over before anything
reads them (`src-tauri/src/data_migration.rs`):

| Old                                                 | New                                                     | Holds                                                                    |
| --------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `%APPDATA%\com.vo1x.gdexplorer`                     | `%APPDATA%\com.ionicboy.gdexplorer`                     | preferences, recovery files, managed rclone, remote status, speed record |
| `%LOCALAPPDATA%\com.vo1x.gdexplorer`                | `%LOCALAPPDATA%\com.ionicboy.gdexplorer`                | the WebView2 profile: upload queue, destinations, theme (`localStorage`) |
| `~/Library/Application Support/com.vo1x.gdexplorer` | `~/Library/Application Support/com.ionicboy.gdexplorer` | macOS app data                                                           |
| `~/Library/WebKit/com.vo1x.gdexplorer`              | `~/Library/WebKit/com.ionicboy.gdexplorer`              | macOS webview storage                                                    |

Paths in `preferences.json` that pointed into the old folder (the rclone the app
installed itself) are pointed at the copy. The copy runs once, only when the new
folder does not exist yet, and goes through a staging folder so an interrupted
copy is redone. The old folders are left in place: an older all-users copy still
on the machine keeps working from them, and they are a backup. Once everyone is
on the new version they can be deleted by hand.

Other effects: the Windows Start menu shortcut and notifications use the new
identifier as their app ID; the credential store entry for the password is
`com.ionicboy.gdexplorer` (no copy was ever stored under the old identifier,
since the password ships together with this change); and the NSIS installer
still finds and upgrades the existing per-user install, because its install
folder and uninstall entry are keyed on the product name "GDrive-Upload", not on
the identifier.

## Testing locally (never against the real gist)

Debug builds read two environment variables. **Release builds ignore both.**

| Variable                      | Meaning                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `GDEXPLORER_STATUS_URL`       | Status URL instead of the baked one. `https://`, or `http://` for 127.0.0.1 / localhost only |
| `GDEXPLORER_STATUS_POLL_SECS` | Poll interval in seconds instead of `checkMinutes`                                           |

```sh
# terminal 1: serve a local document (--serve implies --no-publish)
node scripts/gdexplorer-status.mjs ok --serve 8799

# terminal 2: run the debug app against it
GDEXPLORER_STATUS_URL=http://127.0.0.1:8799/status.json GDEXPLORER_STATUS_POLL_SECS=3 pnpm tauri dev

# terminal 3: change the local document (the server re-reads it per request)
node scripts/gdexplorer-status.mjs maintenance "Testing the lock" --no-publish
node scripts/gdexplorer-status.mjs ok --no-publish
printf 'a test passphrase\n' | node scripts/gdexplorer-status.mjs password --no-publish
node scripts/gdexplorer-status.mjs password --off --no-publish
```

**Always pass `--no-publish`** when changing the document for a local test;
without it the command publishes to the real gist (only `--serve` implies
`--no-publish`). The debug app shares its data folder and credential store entry
with an installed copy, so clean up afterwards: delete `service-status.json`
and `access-id` from the data folder and the stored id
(macOS: `security delete-generic-password -s com.ionicboy.gdexplorer -a access`;
Windows: Control Panel > Credential Manager > Windows Credentials, the entry
naming `com.ionicboy.gdexplorer`). To see whether the id is stored on macOS
without a Keychain prompt, leave out `-w`:
`security find-generic-password -s com.ionicboy.gdexplorer -a access`.

Automated tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml remote_status   # parsing, versions, PBKDF2 vs Node vectors, ids, locks
cargo test --manifest-path src-tauri/Cargo.toml --test remote_status   # local HTTP server: lock/release, sticky, garbage, password flow, throttle, first contact
cargo test --manifest-path src-tauri/Cargo.toml service_lock   # the upload engine holds and resumes
```

## Limits

- Changes take up to `checkMinutes` + 5 minutes (GitHub's cache); **Check
  again** is immediate.
- A copy that never reaches GitHub keeps its last known state; one that never
  reached it at all stays on the "Connect" screen (`requireAccess`).
- This keeps honest users and other accounts out; it is not DRM. Someone with
  enough effort can bypass any client-side check. In particular the remembered
  value is the public `access.id`: a user who digs the gist URL out of the
  binary could write that id into their own credential store entry and skip the
  prompt.
- The wrong-password throttle is per app run; restarting the app resets it
  (each attempt still costs a full PBKDF2 run).
- Unsigned macOS builds may show a Keychain "allow access" prompt after an
  update (the binary changed); "Always Allow" ends it. Denying it means the
  password is asked again.

## Code map

| Piece                                                                    | Where                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing, PBKDF2 check, lock rules, fetch, sticky state, poll loop        | `src-tauri/src/remote_status.rs`                                                                                                        |
| Baked URL, debug overrides, credential store, commands, all-users notice | `src-tauri/src/service.rs`, `src-tauri/remote-status.json`, `src-tauri/build.rs`                                                        |
| Command guard                                                            | `service::ensure_unlocked` in `start_upload`, `rclone_context` (every Drive call), `run_preflight`, `raise_send_buffer`, `rclone_tools` |
| Upload hold and resume                                                   | `UploadControlHandle::service_rx` / `is_held` (`upload/scheduler.rs`), `monitor_pause_state` (`upload/rclone.rs`)                       |
| Lock screen                                                              | `src/components/service/ServiceLockOverlay.tsx`, state in `src/lib/service-lock.ts`, mounted in `src/App.tsx`                           |
| All-users notice                                                         | `src/components/service/AllUsersInstallNotice.tsx`                                                                                      |
| Operator tool                                                            | `scripts/gdexplorer-status.mjs`                                                                                                         |
| Tests                                                                    | `src-tauri/tests/remote_status.rs`, unit tests in `remote_status.rs` and `upload/scheduler.rs`                                          |
