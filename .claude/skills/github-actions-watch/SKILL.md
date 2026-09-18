---
name: github-actions-watch
description: This skill should be used after pushing to this repository, or whenever someone asks whether CI or the release build passed for a commit. It runs a bundled script that polls GitHub Actions for that commit's runs (CI and "Release GDrive-Upload") and reports each outcome plus the latest release tag - instead of rewriting a polling loop each time.
---

# GitHub Actions watch

Report the outcome of the GitHub Actions runs for one commit of this
repository. A push to `main` starts two workflows: **CI** (typecheck, lint,
format, vitest, cargo fmt/clippy/test on Ubuntu) and **Release GDrive-Upload**
(bumps the patch version, builds the Windows app, publishes a release). The
release build is the only Windows compile of `#[cfg(windows)]` code, so its
result matters as much as CI's.

## Run the script, do not rewrite it

Always execute `scripts/watch_runs.py`; never re-implement the polling loop
inline (as a Monitor, a shell `while` loop, or ad-hoc `curl` calls).

```bash
# From the repository root. Waits for the runs of HEAD to finish (up to 30 min).
python3 .claude/skills/github-actions-watch/scripts/watch_runs.py

# A specific commit, or a snapshot without waiting:
python3 .claude/skills/github-actions-watch/scripts/watch_runs.py 2ac5869
python3 .claude/skills/github-actions-watch/scripts/watch_runs.py 2ac5869 --once
```

Options: `--repo OWNER/NAME` (defaults to the `origin` remote), `--interval`
(seconds between polls, default 45), `--timeout` (seconds, default 1800),
`--once`. Only the public API is used; export `GITHUB_TOKEN` if the rate limit
bites or the repository goes private. No `gh` or `jq` needed.

Run it from the healthy checkout (`~/GDExplorer`), so `HEAD` and `origin`
resolve correctly.

## Read the result

One line per completed run, then the latest release tag:

```
watching AdkHex/GDExplorer @ 2ac5869
CI: success https://github.com/AdkHex/GDExplorer/actions/runs/...
Release GDrive-Upload: success https://github.com/AdkHex/GDExplorer/actions/runs/...
latest release: v0.2.27
```

Exit codes: `0` all runs succeeded · `1` a run failed/cancelled/timed out ·
`2` still running at `--timeout` · `3` no runs found for the commit · `4`
usage or lookup error.

"Verified" means exit code 0 **and** the latest release tag is newer than the
one before the push (the release workflow commits a `chore(release): vX.Y.Z
[skip ci]` bump on its own; that commit has a different SHA and is not part
of the watched runs). On exit `1`, open the failing run's URL and read the
job log before changing anything; on `2`, run again with `--once` later
rather than starting a new poll from scratch.
