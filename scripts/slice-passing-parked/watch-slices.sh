#!/usr/bin/env bash
#
# ============================================================================
#  PARKED as of 2026-06-14 — see scripts/slice-passing-parked/README.md
#  Part of the archived Cowork→Code dispatch automation. Ships OPT-IN and is
#  NOT launchctl-loaded by default. The kept flow is manual /run-slice.
# ============================================================================
#
# watch-slices.sh — OPT-IN: poll for a GO sentinel and auto-dispatch a slice.
#
# Cowork (Architect) stages issue-drafts/<slice>/slice-prompt-<slice>.md, then touches
# issue-drafts/<slice>/GO. This loop notices the GO file, removes it, and runs
# dispatch-slice.sh for that slice. The GO sentinel (not the bare prompt) is the
# trigger, so a half-written prompt never fires a run.
#
# Foreground:  scripts/slice-passing-parked/watch-slices.sh   (Ctrl-C to stop)
# Env:         INTERVAL=<seconds>  poll interval (default 15)
#
# ── Run at login via launchd — the single canonical launchctl runbook ───────
# com.kathelix.slice-dispatch.plist (this dir) runs this watcher at login. To
# enable it (do this only with eyes on it, pointed at a dedicated worktree):
#   1. Edit the plist: replace every __REPO_ROOT__ with the absolute path to
#      your checkout/worktree, e.g. /Users/fenix/git/UK_DevOps  (the plist's
#      ProgramArguments points at scripts/slice-passing-parked/watch-slices.sh).
#   2. Copy it into place:
#        cp scripts/slice-passing-parked/com.kathelix.slice-dispatch.plist \
#           ~/Library/LaunchAgents/com.kathelix.slice-dispatch.plist
#   3. Start it — runs now AND at every login; KeepAlive restarts it on exit:
#        launchctl load   ~/Library/LaunchAgents/com.kathelix.slice-dispatch.plist
#   4. Stop it:
#        launchctl unload ~/Library/LaunchAgents/com.kathelix.slice-dispatch.plist
#   (launchctl bootstrap/bootout gui/$UID … is the newer form; load/unload is
#    primary here.)
#
# PATH caveat: launchd gives jobs a minimal PATH, so the plist's
# EnvironmentVariables.PATH must include wherever `claude`, `gh`, `git`, and
# `node` live — Homebrew differs by arch (/opt/homebrew/bin on Apple silicon,
# /usr/local/bin on Intel); match `command -v claude` on your machine.
# Logs (stdout+stderr) land in <repo>/.slice-dispatch.log.
#
# Clean-tree / worktree caveat: dispatch-slice.sh refuses a dirty tree, and
# auto-branching can collide with manual work — point the watcher at a DEDICATED
# git worktree so it never fights your main checkout (CLAUDE.md → worktrees).
#
set -euo pipefail

# this watcher lives in scripts/slice-passing-parked/ (repo root is two levels up)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd)"
cd "$REPO_ROOT"

INTERVAL="${INTERVAL:-15}"
printf '▶ watching %s/issue-drafts/*/GO every %ss (Ctrl-C to stop)\n' "$REPO_ROOT" "$INTERVAL" >&2

while true; do
  for go in issue-drafts/*/GO; do
    [ -e "$go" ] || continue                      # no match → glob stays literal
    slice="$(basename "$(dirname "$go")")"
    rm -f "$go"                                    # consume the sentinel first
    printf '\n▶ dispatching slice: %s\n' "$slice" >&2
    if "$SCRIPT_DIR/dispatch-slice.sh" "$slice"; then
      printf '✓ %s dispatched\n' "$slice" >&2
    else
      printf '✖ dispatch failed for %s (see output above)\n' "$slice" >&2
    fi
  done
  sleep "$INTERVAL"
done
