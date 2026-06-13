#!/usr/bin/env bash
# PostToolUse(Bash, `gh pr create`) hook: put the created PR number into the session's
# display title, accumulating multiple PRs comma-separated (PR#20 -> PR#20, PR#23).
#
# It appends the SAME record the interactive `/rename` command writes
# ({"type":"custom-title","customTitle":"...","sessionId":"..."}) to the session journal —
# the only programmatic way to rename a live session (no `claude` subcommand exists).
# A single O_APPEND write of one line is atomic, so it can't interleave with Claude Code's
# own appends. The persisted name shows in the /resume picker, session list, and --from-pr;
# the live prompt-box title may only refresh on the next resume (the record is written
# out-of-band rather than through the interactive rename path).
set -u
payload="$(cat)"

# gh pr create prints the new PR URL (.../pull/N). This hook only fires on `gh pr create`
# (see the `if` filter in settings.json), so the first pull/N in the payload is that PR.
num="$(printf '%s' "$payload" | grep -oE 'pull/[0-9]+' | head -1 | grep -oE '[0-9]+' | head -1)"
[ -n "${num:-}" ] || exit 0          # no PR number (e.g. create failed) -> stay silent

sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "${sid:-}" ] || exit 0

jf="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -1)"
[ -n "${jf:-}" ] && [ -f "$jf" ] || exit 0

new="PR#$num"
# Accumulate onto the most recent PR#... custom title, if any.
prev="$(grep -aoE '"customTitle":"PR#[^"]*"' "$jf" | tail -1 | sed -E 's/.*"customTitle":"//; s/"$//')"
title="$new"
if [ -n "${prev:-}" ]; then
  case ", $prev, " in
    *", $new, "*) title="$prev" ;;   # already listed -> unchanged
    *) title="$prev, $new" ;;        # append, comma-separated
  esac
fi
[ "$title" = "${prev:-}" ] && exit 0  # nothing new -> no redundant record

printf '%s\n' "{\"type\":\"custom-title\",\"customTitle\":\"$title\",\"sessionId\":\"$sid\"}" >> "$jf"
printf '%s\n' "{\"systemMessage\":\"Session renamed to \\\"$title\\\" (PR #$num created).\"}"
