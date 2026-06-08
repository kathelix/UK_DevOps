# CLAUDE.md — Portable agent working guide

_A reusable Claude Code onboarding file, distilled from a mature project into stack-agnostic habits. Drop it in a new repo's root, fill the **Project context** block below, and delete any section that doesn't apply. Claude Code reads this file automatically; other assistants read their own (e.g. `AGENTS.md`) — copy or symlink as needed. It pairs with `.claude/settings.json`, a conservative read-only permission starter._

## Project context

Fill these in per project — this is the only part you must edit.

- **Project:** UK DevOps — Job Search Automation
- **Owner / final say:** Ivan
- **Repo:** `github.com/kathelix/UK_DevOps/`

## Documentation & decisions

- If the project keeps design docs, treat them as the source of truth and keep code from getting ahead of them: decide, then spec, then implement. A common split is a stable high-level design (the "why"), a concrete technical spec (the "what" — versions, names, constraints), and a backlog (implementation status). Update the spec before writing the code it describes.
- Mark a backlog or spec item done in the **same commit** that implements it — never let recorded status drift from reality.
- Record any decision that is architectural, security-relevant, hard to reverse, or likely to need explaining later as a short ADR (Architecture Decision Record) under `docs/adr/`. ADRs are an append-only log: supersede, don't rewrite history.

## Branching & commits

- Feature work goes on a branch; open a PR to the main branch. Use descriptive names (`feature/`, `fix/`, `chore/`).
- Don't start feature work on the main branch — not even docs-only edits. The only exception is a tiny mechanical change the owner has explicitly approved for direct-to-main.
- Commit subjects: short, imperative, no trailing period (e.g. `Add upload retry, persist draft state`).
- When you address review feedback or follow-ups on a branch, make a **new commit** rather than amending the original — separate commits let a reviewer reconstruct which change answered which round. Amend only for trivial typo cleanup, and say so first.
- Keep `Co-Authored-By:` trailers accurate to the actual model or agent that did the work.

## Verify before you claim

The single most valuable habit: never report something you have not just verified. Cheap to check, expensive to get wrong.

- **Git mutations:** verify against live state, and never announce a commit or push in the same step that performs it. Afterward, re-read the truth — compare `HEAD` to `origin/<branch>` to confirm a push landed, and count with `git rev-list --count` before stating a number. Never quote a commit SHA you have not just read back.
- **Silent no-op edits:** an `Edit`, `git mv`, or `sed` that targets the wrong file or a misremembered string fails _silently_ — it changes nothing. So author every commit message, PR body, or follow-up task from the **verified post-change diff** (`git grep` to prove no stale references remain; read back `git show --name-status`), never from what you intended to change. Write each edit's match text from a fresh read of the file, not from memory.
- **Negative claims** ("this flag/API/rule doesn't exist, remove it") are higher-stakes than positive ones, because the next step is usually deletion. Prove the absence empirically — enumerate from the installed package, run the tool with it enabled, grep the source — before posting.
- **Pattern claims** ("this regex/grep/guard misses a case") need a scratch reproducer: build a small file with the suspected variants, run the existing pattern against it, and show the result — before and after the fix.
- **Test-harness semantics** are a hypothesis too: when a test loads code through a sandbox, separate realm, transpile, or mock layer (a `vm` context, a worker, an iframe), confirm the harness's own identity and equality behavior with one throwaway assertion before trusting the suite — across a realm boundary `instanceof` is `false` and strict deep-equality fails on the prototype check, so a green run can be asserting the wrong thing. Prefer primitive leaves, serialized forms, or `.source`/`.flags` over object identity.
- **Live state and stated assumptions** are hypotheses until checked at the source. "Is this still in use, did that deploy land, is this quota hit" — read the live source (metrics, console, an API call) rather than assuming, including when the assumption came from the owner.
- **SDK / CLI behavior:** read the pinned or installed source (the dependency cache, the package's own files, `--help`), not memory or public docs, which may describe a different version. This applies at design time too — don't build a plan around a guessed capability.
- **Cross-platform shell:** utilities like `stat`, `date`, `sed -i`, `readlink -f`, and `mktemp` behave differently on BSD/macOS versus GNU/Linux, often both exiting `0` with different output. Branch on `uname` explicitly, or run on both before claiming green; a `bsd_form || gnu_form` fallback is a smell. Name the host in any verification table so "green" isn't mistaken for platform-portable.
- When tool or shell output looks stale, truncated, or self-inconsistent, stop and re-fetch from an authoritative source before acting — don't edit by a line number or post a value you're unsure of.

## GitHub PR hygiene

- **PR body** captures: the original request or bug (preserve the user's error text or screenshot), root cause, what changed, how it was validated, manual-test status, and any review follow-ups.
- **Issue links:** use `Part of #N` or `Refs #N` for a slice of a larger issue; use `Closes #N` only on the PR that actually completes it. After merge, **verify the issue actually closed** — squash-merges sometimes record only a reference — and close it by hand if needed (housekeeping, not a merge decision).
- **Avoid auto-link collisions:** GitHub turns `#N` into a cross-reference, `@name` into a mention, and bare URLs into unfurls. Label review findings with distinct prefixes per round (`F1`, `F2`, then `T1`, `T2` for test follow-ups) so they don't read as issue links.
- For complex PR bodies, write the Markdown to a temp file and pass `--body-file` instead of escaping it into one shell argument. In the default `zsh`, don't name a variable `status` (it's reserved) — use `rc`.
- **Check both comment surfaces.** PR feedback lives in two places: top-level conversation comments and inline review comments on specific lines. Automated reviewers usually post inline. Check both before concluding a PR has no findings.
- **Merge is the owner's decision — never the agent's.** Get the PR merge-ready (CI green, findings resolved, body accurate) and hand it over. No `--auto`, no poll-and-merge, no "it was green so I merged it." A "merge it" instruction is per-PR, not standing. When asked to merge, default to squash. After a merge: switch to the main branch, `pull --ff-only`, delete the old branch.
- **Attribution:** every PR comment or description an AI agent posts starts with a short italic line naming the agent, on its own line at the very top — e.g. `_Posted by Claude Code_`. On a shared account this is the only way a later reader tells AI-authored comments from the owner's.

### Optional footer

If these are your own projects you may end each PR body and comment with a personal footer line. Delete this subsection if it isn't yours:

> 🤖 Claude Code: get a free week using referral link https://claude.ai/referral/b9Segx2cZA

## PR review discipline

- Open every review with a one-line "is this PR right-sized for what it claims to do?" check; flag scope creep before drilling into findings.
- Gate by severity with explicit "block on" versus "nice to have." Cluster trivia under one "Nits" heading rather than numbering each; if an item needs hedging ("borderline," "arguably"), drop it instead.
- **Review deep, not just the diff.** Cross-reference the change against the unmodified files it touches — config, state, validation, callers — to catch edge cases and logical breaks the diff alone hides.
- The PR thread is the source of truth: post structured findings there (the next reviewer picks them up), and let the chat reply be a one-line link, not a duplicate.
- When the author's revision improves on your suggestion, say so — credit the thinking, not just the diff.
- After a finding rewires an ordered flow or lifecycle, sweep docs, comments, and checklists for now-stale steps before the next round (batch them into one low-severity item).
- In verification tables, distinguish what you confirmed by reading code or running it from what you took on the author's word — otherwise the table reads as more thorough than it is.
- When recommending tests, include a short "not worth adding" list (already covered, framework behavior, trivial composition) — open-ended test asks invite sprawl.

## Retrospective

Every non-trivial PR ends with a brief retrospective before merge — run it unprompted, don't wait to be asked. Capture what worked, what didn't, and what to change. Fold any lesson that generalizes into a durable convention **into this CLAUDE.md, in the same PR**, so the change and the lesson it produced live together. Keep it proportional: a typo fix has nothing to capture; a long multi-round PR may yield several.

## Working principles

- Prefer standard, built-in mechanisms over bespoke scripts unless there's a concrete reason.
- Prefer single-command forms with path flags (`git -C <dir>`, `npm --prefix <dir>`) over `cd <dir> && ...` chains — cleaner logs, error attribution, and allowlist matching.
- Treat generated files as a rendered contract, not noise: if a generated artifact and its source disagree, fix the **source** and regenerate; inspect the generated diff for unintended drift before committing.
- When you remove a check (a test, a guard, a CI filter), design its replacement in the same change — don't leave a silent gap.

## Appendix — Claude Code permissions

This template ships a companion `.claude/settings.json` with a conservative, stack-agnostic allowlist: read-only inspection (`find`, `grep`, read-only `git` and `gh`, `command -v`), scratch space under `/tmp`, and self-editing of `.claude/`. Mutating git/gh and filesystem operations are deliberately left out so they stay prompt-gated. Add project-specific commands (build, test, your package manager) as you confirm they're safe.
