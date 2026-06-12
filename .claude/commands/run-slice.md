---
description: Execute a staged Architect slice prompt as the Implementer (Part B)
argument-hint: [path/to/slice-prompt.md]
---
You are the Implementer (Claude Code). Execute the slice defined by the Architect's prompt.

Slice prompt path: $ARGUMENTS
If empty, locate the most recent `issue-drafts/**/slice-prompt-*.md` (newest mtime) and state which one you chose.

1. Read the slice prompt top to bottom FIRST — it is self-contained and lists its own (untracked) inputs; read everything it points to (e.g. an `issue-drafts/<slice>/README.md` provenance doc).
2. Follow @CLAUDE.md throughout: branch from `origin/main` and verify the base, verify-before-claim, GitHub PR hygiene, and the slice-staging cleanup convention.
3. Execute the prompt's Part B exactly: make the code/test changes, **move** (not copy) any staged fixtures into their committed home, and run the full test suite to green.
4. Open a PR; fold the staging's provenance into the PR body; then remove the `issue-drafts/<slice>/` dir so the working tree ends clean.
5. Resolve Codex's review (route architectural findings back to the Architect). **Stop before merging — the merge decision is the owner's.**
