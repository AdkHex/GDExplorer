# GDExplorer

GDExplorer is a Tauri v2 desktop app (React + TypeScript) for queueing local
files and folders and uploading them to Google Drive Shared Drives using
Service Accounts.

## Requirements

- Node.js 18+
- pnpm 10 (this repo pins pnpm via `packageManager`; `pnpm-lock.yaml` is the
  only lockfile)
- Rust (stable)
- Tauri system prerequisites for your OS
- [rclone](https://rclone.org/downloads/) on your `PATH`, or its full path set
  in Preferences. GDExplorer drives rclone to perform the actual uploads.

## Run in development

```sh
pnpm install
pnpm run tauri:dev
```

## Build installers

```sh
pnpm run build        # frontend
pnpm run tauri:build  # installers and artifacts
```

## Checks

Run everything CI runs (typecheck, lint, format, JS tests, `cargo fmt`,
`cargo clippy`, `cargo test`):

```sh
pnpm run check:all
```

## Auto-updates

Installed apps update from GitHub Releases. See
[docs/UPDATER_GITHUB_RELEASES.md](docs/UPDATER_GITHUB_RELEASES.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
