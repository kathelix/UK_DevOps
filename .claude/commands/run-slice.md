---
description: Execute a staged Architect slice prompt as the Implementer
argument-hint: [path/to/slice-prompt.md]
---
You are the Implementer (Claude Code). Execute the slice defined by the Architect's prompt.

Slice prompt path: $ARGUMENTS

**If a path is given, use it.** **If empty,** discover every `issue-drafts/**/slice-prompt-*.md` — do NOT silently default to newest mtime. For each, read its first `# ` heading as a one-line summary, and treat the slice as **PARKED** if its folder's `README.md` contains a `PARKED` status marker. Then:

- **0 slices** → report that none are staged under `issue-drafts/` and stop.
- **Exactly 1 slice** → run it, stating which one you chose. (If that slice is PARKED, do NOT auto-run — show its parked status and ask the user to confirm first.)
- **2 or more** → present a numbered menu (folder name + summary, with PARKED slices clearly flagged and never pre-selected), then **ask which one to implement and wait for the answer** before proceeding.

1. Read the slice prompt top to bottom FIRST — it is self-contained and may list its own (untracked) inputs; read everything it points to (e.g. an `issue-drafts/<slice>/README.md` provenance doc).
2. Follow @CLAUDE.md throughout: branch from `origin/main` and verify the base, verify-before-claim, GitHub PR hygiene, and the slice-staging cleanup convention.
3. Execute the prompt exactly: make the code/test changes, **move** (not copy) any staged fixtures into their committed home, and run the full test suite to green.
4. Open a PR; fold the staging's provenance if exists into the PR body; then remove the `issue-drafts/<slice>/` dir so the working tree ends clean.
5. Resolve Codex's review (route architectural findings back to the Architect). **Stop before merging — the merge decision is the owner's.**
