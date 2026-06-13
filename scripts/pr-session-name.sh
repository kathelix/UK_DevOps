#!/usr/bin/env bash
# PostToolUse(Bash, `gh pr create`) hook: put the created PR number into the session's
# display title, accumulating multiple PRs comma-separated (PR#20 -> PR#20, PR#23).
#
# It appends the SAME record the interactive `/rename` command writes
# ({"type":"custom-title","customTitle":"...","sessionId":"..."}) to the session journal -
# the only programmatic way to rename a live session (no `claude` subcommand exists).
# The persisted name shows in the /resume picker, session list, and --from-pr; the live
# prompt-box title may only refresh on the next resume (the record is written out-of-band
# rather than through the interactive rename path).
#
# INSTALL (so Claude Code runs it automatically):
#   1. Copy this file into ~/.claude/hooks/ and make it executable:
#        cp scripts/pr-session-name.sh ~/.claude/hooks/ && chmod +x ~/.claude/hooks/pr-session-name.sh
#   2. Register it as a PostToolUse hook in ~/.claude/settings.json (user-global, so it
#      applies in every repo). Merge this under the top-level "hooks" key:
#        "hooks": {
#          "PostToolUse": [
#            { "matcher": "Bash",
#              "hooks": [
#                { "type": "command",
#                  "command": "$HOME/.claude/hooks/pr-session-name.sh",
#                  "if": "Bash(gh pr create*)",
#                  "statusMessage": "Updating session name with PR number" }
#              ] }
#          ]
#        }
#   3. Needs `jq` on PATH. Takes effect on the next Claude Code session (restart to reload
#      settings). This repo keeps a vendored copy at scripts/pr-session-name.sh for review;
#      the installed copy under ~/.claude/hooks/ is what actually runs - keep the two in sync
#      (or symlink ~/.claude/hooks/pr-session-name.sh to this file).
#
# Scope & PR number: settings.json scopes this hook with `if: "Bash(gh pr create*)"`
# (verified honored); the script mirrors that as a self-gate. It reads the new PR number
# from the command's STDOUT only (where `gh pr create` prints the .../pull/N URL), NOT the
# whole payload - the old version grepped the whole payload, so a `--title`/`--body` that
# merely mentioned another `pull/N` (which lives in tool_input.command) could hijack the
# number.
#
# CONTRACT / known limitation: the hook trusts the `gh pr create*` scope to mean "a PR was
# created" - it does NOT independently prove that. A contrived command that begins with
# `gh pr create` yet prints some OTHER PR's URL to stdout (e.g. `gh pr create --help;
# gh pr view 9`) would mis-set the title. That is an accepted trade for a convenience
# session-namer: hard prevention would need fragile shell-parsing of chaining/quoting and
# would risk NOT renaming on a legit `gh pr create` whose --title/--body contains `;`/`|`/`&`
# (a silent miss is worse here than the rare contrived mislabel). The settings filter is the
# real gate; this script just extracts the number and writes the title.
set -u
payload="$(cat)"

# Self-gate, mirroring the settings `if: "Bash(gh pr create*)"` scope (also covers the case
# where that filter is ever removed). This scopes to `gh pr create` *commands*; per the
# contract note above it does not by itself prove a PR was created.
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
case "$cmd" in
  "gh pr create"*) ;;                  # a `gh pr create` invocation -> proceed
  *) exit 0 ;;                          # anything else -> silent
esac

# `gh pr create` prints the new PR URL (.../pull/N) to STDOUT. Read only stdout (not the
# whole payload), so a pull/N inside --title/--body can't hijack the number.
out="$(printf '%s' "$payload" | jq -r '.tool_response.stdout // empty' 2>/dev/null)"
num="$(printf '%s' "$out" | grep -oE 'pull/[0-9]+' | head -1 | grep -oE '[0-9]+' | head -1)"
[ -n "${num:-}" ] || exit 0            # no PR URL on stdout (--help / --web / failed) -> silent

sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "${sid:-}" ] || exit 0

# Locate the session journal: prefer the authoritative transcript_path from the payload,
# fall back to find-by-session-id for older payloads that lack it.
jf="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "${jf:-}" ] && [ -f "$jf" ] || jf="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -1)"
[ -n "${jf:-}" ] && [ -f "$jf" ] || exit 0

new="PR#$num"
# Accumulate onto the most recent PR#... custom title, if any. Idempotent: re-firing for an
# already-listed PR writes nothing (so duplicate records can't pile up).
prev="$(grep -aoE '"customTitle":"PR#[^"]*"' "$jf" | tail -1 | sed -E 's/.*"customTitle":"//; s/"$//')"
title="$new"
if [ -n "${prev:-}" ]; then
  case ", $prev, " in
    *", $new, "*) title="$prev" ;;     # already listed -> unchanged
    *) title="$prev, $new" ;;          # append, comma-separated
  esac
fi
[ "$title" = "${prev:-}" ] && exit 0   # nothing new -> no redundant record

printf '%s\n' "{\"type\":\"custom-title\",\"customTitle\":\"$title\",\"sessionId\":\"$sid\"}" >> "$jf"
printf '%s\n' "{\"systemMessage\":\"Session renamed to \\\"$title\\\" (PR #$num created).\"}"
