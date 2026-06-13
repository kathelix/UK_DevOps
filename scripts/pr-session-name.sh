#!/usr/bin/env bash
# PostToolUse(Bash, `gh pr create`) hook: put the created PR number into the session's
# display title, accumulating multiple PRs comma-separated (PR#20 -> PR#20, PR#23).
#
# It appends the SAME record the interactive `/rename` command writes
# ({"type":"custom-title","customTitle":"...","sessionId":"..."}) to the session journal —
# the only programmatic way to rename a live session (no `claude` subcommand exists).
# The persisted name shows in the /resume picker, session list, and --from-pr; the live
# prompt-box title may only refresh on the next resume (the record is written out-of-band
# rather than through the interactive rename path).
#
# Gating & PR-number source: settings.json fires this only on `Bash(gh pr create*)` (the
# `if` filter is honored). As defense-in-depth the script ALSO self-gates on the command,
# and — crucially — reads the new PR number from the command's STDOUT only (where
# `gh pr create` prints the .../pull/N URL), NOT the whole payload. The old version grepped
# the whole payload, so a `--title`/`--body` that merely mentioned another `pull/N` (which
# lives in tool_input.command) could hijack the number; stdout-only avoids that.
set -u
payload="$(cat)"

# Self-gate: act only on an actual `gh pr create` invocation — robust even if the
# settings.json `if` filter is ever removed or behaves differently across CLI versions.
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
case "$cmd" in
  *"gh pr create"*) ;;                 # a create invocation -> proceed
  *) exit 0 ;;                          # anything else -> silent
esac

# `gh pr create` prints the new PR URL (.../pull/N) to STDOUT. Read only stdout, so a
# pull/N inside --title/--body can't hijack the number, and a non-create command that
# merely prints a pull URL can't trigger a rename.
out="$(printf '%s' "$payload" | jq -r '.tool_response.stdout // empty' 2>/dev/null)"
num="$(printf '%s' "$out" | grep -oE 'pull/[0-9]+' | head -1 | grep -oE '[0-9]+' | head -1)"
[ -n "${num:-}" ] || exit 0            # no PR number (create failed / --dry-run / --web) -> silent

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
