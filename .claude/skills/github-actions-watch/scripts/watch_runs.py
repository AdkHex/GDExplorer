#!/usr/bin/env python3
"""Report the GitHub Actions runs for one commit, polling until they finish.

Usage:
    watch_runs.py [SHA_OR_REF] [--repo OWNER/NAME] [--once]
                  [--interval SECONDS] [--timeout SECONDS]

SHA_OR_REF defaults to HEAD of the git checkout in the current directory,
and --repo to that checkout's `origin` remote. Needs only the public API;
set GITHUB_TOKEN to raise the rate limit or reach a private repository.

Prints one line per run as it completes (`<workflow>: <conclusion> <url>`),
then the latest release tag, so a release workflow's result is visible too.

Exit codes:
    0  every run completed successfully
    1  a run failed, was cancelled or timed out
    2  the runs were still going when --timeout elapsed
    3  no runs were found for the commit (after a short grace period)
    4  usage or lookup error (bad repo, git failure, API error)
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
GRACE_SECONDS = 90  # runs can take a moment to appear after a push


def git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()


def repo_from_origin():
    url = git("remote", "get-url", "origin")
    match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", url)
    if not match:
        raise SystemExit(f"origin is not a GitHub repository: {url}")
    return f"{match.group(1)}/{match.group(2)}"


def api(path):
    request = urllib.request.Request(f"{API}{path}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("User-Agent", "watch-runs")
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def resolve_sha(ref):
    """The full SHA when git can resolve `ref`, else `ref` as a hex prefix."""
    try:
        return git("rev-parse", "--verify", f"{ref}^{{commit}}")
    except (subprocess.CalledProcessError, FileNotFoundError):
        if re.fullmatch(r"[0-9a-f]{7,40}", ref):
            return ref
        raise SystemExit(f"cannot resolve {ref!r}: not a commit here and not a SHA")


def runs_for(repo, sha):
    # The API's head_sha filter only matches a full 40-character SHA; a
    # prefix has to be matched against recent runs instead.
    if len(sha) == 40:
        data = api(f"/repos/{repo}/actions/runs?head_sha={sha}&per_page=20")
    else:
        data = api(f"/repos/{repo}/actions/runs?per_page=50")
    return [run for run in data.get("workflow_runs", []) if run["head_sha"].startswith(sha)]


def latest_release(repo):
    try:
        release = api(f"/repos/{repo}/releases/latest")
    except urllib.error.HTTPError:
        return None
    return release.get("tag_name")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("ref", nargs="?", default="HEAD")
    parser.add_argument("--repo", help="OWNER/NAME; defaults to the origin remote")
    parser.add_argument("--once", action="store_true", help="print the current state and exit")
    parser.add_argument("--interval", type=int, default=45, help="seconds between polls")
    parser.add_argument("--timeout", type=int, default=1800, help="seconds before giving up")
    args = parser.parse_args()

    try:
        repo = args.repo or repo_from_origin()
        sha = resolve_sha(args.ref)
    except (subprocess.CalledProcessError, FileNotFoundError, SystemExit) as error:
        print(f"error: {error}", file=sys.stderr)
        return 4

    print(f"watching {repo} @ {sha[:7]}")
    reported = set()
    started = time.monotonic()
    while True:
        try:
            runs = runs_for(repo, sha)
        except (urllib.error.URLError, OSError) as error:
            # One failed request should not end the watch.
            print(f"warning: {error}", file=sys.stderr)
            runs = None

        if runs is not None:
            for run in runs:
                if run["status"] == "completed" and run["id"] not in reported:
                    reported.add(run["id"])
                    print(f"{run['name']}: {run['conclusion']} {run['html_url']}", flush=True)
            pending = [run for run in runs if run["status"] != "completed"]

            if runs and not pending:
                tag = latest_release(repo)
                if tag:
                    print(f"latest release: {tag}")
                failed = [run for run in runs if run["conclusion"] != "success"]
                return 1 if failed else 0

            if args.once:
                for run in pending:
                    print(f"{run['name']}: {run['status']} {run['html_url']}")
                if not runs:
                    print("no runs found yet")
                return 0

            if not runs and time.monotonic() - started > GRACE_SECONDS:
                print("no runs found for this commit", file=sys.stderr)
                return 3

        if time.monotonic() - started > args.timeout:
            print("timed out while runs were still in progress", file=sys.stderr)
            return 2
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
