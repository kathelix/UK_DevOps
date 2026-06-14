#!/usr/bin/env bash
#
# dispatch-slice.sh — Architect→Implementer handoff via Claude Code on the web.
#
# Cowork (Architect) stages a slice's inputs under issue-drafts/<slice>/:
#   slice-prompt-<slice>.md  (the spec) + any fixtures / provenance notes.
# This script (run on Ivan's Mac) launches a GUI-visible CLOUD Code session
# (`claude --remote`) that implements the slice and opens a PR.
#
# Why a feature branch + push first: a cloud session runs in a fresh VM that
# CLONES the repo from GitHub at your current branch. It cannot see local files,
# and issue-drafts/ is gitignored — so we cut feature/<slice>, force-stage the
# slice inputs onto it (Pattern A), and push, so the clone carries them. We
# dispatch from the feature branch (never main) so the proxy's "push only to the
# current working branch" rule keeps the cloud session off main.
#
# The cloud session owns implement → move fixtures into their home → open the PR.
# It NEVER merges (merge is the owner's decision — CLAUDE.md → GitHub PR hygiene).
#
# Usage:  scripts/dispatch-slice.sh [--dry-run] <slice-name> [branch-override]
#   --dry-run (-n): resolve + print the branch, then stop before any git/cloud op.
#
# Branch naming is the Architect's call, declared in the slice spec
# (issue-drafts/<slice>/slice-prompt-<slice>.md) so chores/fixes/docs aren't all "feature/":
#   <!-- branch: chore/tidy-logs -->   full branch name, wins
#   <!-- type: fix -->                 prefix only  → fix/<slice>
# Falls back to feature/<slice>. The optional [branch-override] arg trumps both.
#
set -euo pipefail

# --- locate repo root (this script lives in scripts/) -----------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
cd "$REPO_ROOT"

die()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m▶ %s\033[0m\n' "$*" >&2; }

# --- args -------------------------------------------------------------------
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-n" ]; then DRY_RUN=1; shift; fi
SLICE="${1:-}"
[ -n "$SLICE" ] || die "usage: scripts/dispatch-slice.sh [--dry-run] <slice-name> [branch-name]"
CLI_BRANCH="${2:-}"          # optional override; normally the branch comes from the spec
SLICE_DIR="issue-drafts/$SLICE"
PROMPT_FILE="$SLICE_DIR/slice-prompt-$SLICE.md"
PREAMBLE_FILE="$REPO_ROOT/scripts/slice-agent-preamble.md"

# --- preconditions ----------------------------------------------------------
command -v claude >/dev/null || die "claude CLI not found on PATH"
command -v git    >/dev/null || die "git not found on PATH"
# Canonical spec is slice-prompt-<slice>.md; fall back to any slice-prompt-*.md in the dir.
if [ ! -f "$PROMPT_FILE" ]; then
  # glob expands in sorted order; take the first existing match (literal glob if
  # no match → the -f test fails and PROMPT_FILE is unchanged, caught by die below)
  for alt in "$SLICE_DIR"/slice-prompt-*.md; do
    [ -f "$alt" ] && { PROMPT_FILE="$alt"; break; }
  done
fi
[ -f "$PROMPT_FILE" ]   || die "no slice spec at $SLICE_DIR/slice-prompt-$SLICE.md (Architect must stage it first)"
[ -f "$PREAMBLE_FILE" ] || die "missing $PREAMBLE_FILE"
# `--remote` needs claude.ai subscription auth (not an API key). If you're not
# signed in, the claude call below fails with its own message.

# --- resolve the branch (Architect's call, from the spec) -------------------
# Precedence: [branch-override] arg > <!-- branch: --> > <!-- type: --> (→ <type>/<slice>) > feature/<slice>
# Keyword match is case-insensitive; the sed strips the comment wrapper without
# the GNU-only `s///I` flag, so it's portable to macOS (BSD) sed.
BRANCH=""; BR_SRC=""
if [ -n "$CLI_BRANCH" ]; then
  BRANCH="$CLI_BRANCH"; BR_SRC="command-line override"
fi
if [ -z "$BRANCH" ]; then
  B="$(grep -oiE '<!--[[:space:]]*branch:[^>]*>' "$PROMPT_FILE" | head -1 \
       | sed -E 's/^<!--[[:space:]]*[Bb][Rr][Aa][Nn][Cc][Hh]:[[:space:]]*//; s/[[:space:]]*--*>[[:space:]]*$//' || true)"
  if [ -n "$B" ]; then BRANCH="$B"; BR_SRC="<!-- branch: --> in the slice spec"; fi
fi
if [ -z "$BRANCH" ]; then
  T="$(grep -oiE '<!--[[:space:]]*type:[^>]*>' "$PROMPT_FILE" | head -1 \
       | sed -E 's/^<!--[[:space:]]*[Tt][Yy][Pp][Ee]:[[:space:]]*//; s/[[:space:]]*--*>[[:space:]]*$//' || true)"
  if [ -n "$T" ]; then BRANCH="$T/$SLICE"; BR_SRC="<!-- type: $T --> in the slice spec"; fi
fi
if [ -z "$BRANCH" ]; then
  BRANCH="feature/$SLICE"; BR_SRC="default — no branch/type in the spec"
fi
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 \
  || die "resolved branch '$BRANCH' is not a valid git branch name — fix the <!-- branch:/type: --> line in $PROMPT_FILE"
info "branch: $BRANCH  ($BR_SRC)"

# --dry-run: report the resolved branch + spec and stop BEFORE any side effect
# (no fetch, no branch, no push, no cloud run). The prefix is a naming convention,
# not an enforced allow-list — preview here to catch a wrong/typo'd prefix yourself.
if [ "$DRY_RUN" -eq 1 ]; then
  info "dry-run: would dispatch '$SLICE' on '$BRANCH' (spec: $PROMPT_FILE). No branch created, nothing pushed."
  exit 0
fi

# Clean tree (tracked files only; gitignored issue-drafts/ staging doesn't count).
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "working tree has uncommitted changes — commit/stash before dispatching"
fi

# --- branch must not already exist (local or remote) ------------------------
info "fetching origin…"
git fetch --quiet origin
if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  die "branch $BRANCH already exists locally — delete it or pass a different name"
fi
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  die "branch $BRANCH already exists on origin — pick a different name"
fi

# --- cut the feature branch from a fresh origin/main (NEVER dispatch on main)-
info "cutting $BRANCH from origin/main"
git checkout -q -b "$BRANCH" origin/main

# --- Pattern A: force-stage the slice inputs onto the branch ----------------
# issue-drafts/ is gitignored, so -f is required. The cloud Implementer moves
# fixtures into their committed home and removes this dir (CLAUDE.md), so it
# never lands on main after a squash-merge.
git add -f "$SLICE_DIR"
git commit -q -m "chore(slice): stage $SLICE inputs for cloud Implementer"
info "staged inputs: $(git show --stat --oneline HEAD | tail -n +2 | sed 's/^/    /')"

# --- push so the cloud VM can clone the branch from GitHub ------------------
info "pushing ${BRANCH}…"
git push -q -u origin "$BRANCH"

# --- build the inlined prompt = cloud working-agreement + slice spec ---------
# (`--append-system-prompt` does not reach a --remote session, so we prepend.)
PROMPT="$(cat "$PREAMBLE_FILE"; printf '\n\n---\n\n'; cat "$PROMPT_FILE")"

# --- launch the GUI-visible cloud Code session ------------------------------
# Runs while checked out on $BRANCH: the cloud clones it (inputs included),
# works on it, pushes back to it, and opens the PR against main.
info "launching cloud Code session (claude --remote)…"
claude --remote "$PROMPT"

# --- return the local checkout to main; the cloud session runs independently -
git checkout -q main

info "dispatched '$SLICE'. Watch it in the Code tab / claude.ai/code / iOS."
info "When the PR is up: enable Auto-fix for the Codex review loop. Merge stays manual."
