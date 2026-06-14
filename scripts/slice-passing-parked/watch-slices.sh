#!/usr/bin/env bash
#
# watch-slices.sh — OPT-IN: poll for a GO sentinel and auto-dispatch a slice.
#
# Cowork (Architect) stages issue-drafts/<slice>/slice-prompt-<slice>.md, then touches
# issue-drafts/<slice>/GO. This loop notices the GO file, removes it, and runs
# dispatch-slice.sh for that slice. The GO sentinel (not the bare prompt) is the
# trigger, so a half-written prompt never fires a run.
#
# Foreground:  scripts/watch-slices.sh        (Ctrl-C to stop)
# At login:    via com.kathelix.slice-dispatch.plist (launchd)
# Env:         INTERVAL=<seconds>  poll interval (default 15)
#
# Tip: point this at a DEDICATED git worktree so auto-branching can't collide
# with manual work in your main checkout (CLAUDE.md → separate worktrees).
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
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
