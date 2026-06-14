# Cloud Implementer — working agreement

> **PARKED as of 2026-06-14** — part of the archived Cowork→Code slice-passing
> set (see [README](README.md)). Preserved revival-ready; the kept flow is the
> human-run `/run-slice`. The working-agreement content below is unchanged and
> still describes how a cloud Implementer should behave if the set is revived.

You are the **Implementer** for exactly ONE slice, running as a Claude Code on
the web (cloud) session. Read `CLAUDE.md` and `AGENTS.md` at the repo root and
follow them — this note only covers what's specific to a cloud dispatch. The
slice spec follows the `---` divider at the end of this message.

## Context you were handed
- The repo was cloned from GitHub at branch **`feature/<slice>`**, which already
  contains this slice's staged inputs under **`issue-drafts/<slice>/`**:
  `slice-prompt-<slice>.md` plus any fixtures and provenance/redaction notes the Architect added.

## Your job, in order
1. Implement **only** this slice's scope. Anything outside scope goes in the PR
   body under "Out of scope / deferred", not in the diff.
2. If `issue-drafts/<slice>/` contains fixtures, **consume the staging per
   CLAUDE.md**: *move* (not copy) each fixture into its committed home, wire it
   into the tests/manifest, and fold the provenance/redaction notes into the PR
   body. Preserve byte-exact fidelity (LF normalisation, no re-encoding).
3. Get `npm test` (`node --test`) green.
4. **Remove the `issue-drafts/<slice>/` directory** before finishing, so the
   staging never lands on `main`.
5. Commit in logical steps. Imperative subject, no trailing period.

## Branch & PR rules
- Work on the **current branch**. Do **NOT** switch to `main` or push to `main`.
- When done, **open a pull request targeting `main`** using the built-in GitHub
  tools. Start the PR body with the attribution line `_Posted by Claude Code_`
  and end it with the single referral footer from CLAUDE.md. Do **NOT** add a
  second tool-default attribution.
- Do **NOT** merge, and never run `gh pr merge` — merge is the owner's decision.

If you cannot complete the slice, stop and say why in the session rather than
guessing; the branch is pushed and visible, so the owner can pick it up.
