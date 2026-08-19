# GDExplorer

GDExplorer is a Tauri v2 desktop app (React + TypeScript) for queueing local files/folders and uploading them to Google Drive Shared Drives using Service Accounts.

Requirements

- Node.js 18+
- pnpm 10 (this repo pins pnpm via `packageManager`; `pnpm-lock.yaml` is the
  only lockfile)
- Rust (stable)
- Tauri system prerequisites for your OS
- [rclone](https://rclone.org/downloads/) on your `PATH`, or its full path set
  in Preferences. GDExplorer drives rclone to perform the actual uploads.

Run in development

1. Install dependencies:
   `pnpm install`

2. Start the dev app:
   `pnpm run tauri:dev`

Build installers

1. Build the frontend:
   `pnpm run build`

2. Build the Tauri app (installers/artifacts):
   `pnpm run tauri:build`

Checks

Run everything CI runs (typecheck, lint, format, JS tests, `cargo fmt`,
`cargo clippy`, `cargo test`):

`pnpm run check:all`

Auto-updates (GitHub Releases)

See `docs/UPDATER_GITHUB_RELEASES.md`.

License

MIT. See `LICENSE.md`.
