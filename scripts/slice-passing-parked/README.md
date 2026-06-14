# Slice-passing automation — PARKED

**Status: PARKED as of 2026-06-14.**

This directory archives the **Cowork→Code slice-passing automation** — the tooling
that programmatically triggered a *cloud* Claude Code Implementer to run a slice
and open a PR. It is preserved revival-ready, not deleted, but it is **not in
active use**. We continue with the working flow: the Architect stages a slice
spec under `issue-drafts/<slice>/` and a human runs **`/run-slice`** in a Claude
Code session.

> ⚠️ **Claude tooling changes fast.** Everything below was true on 2026-06-14;
> CLI flags, billing, and the cloud git-proxy behaviour can all shift. **Re-verify
> before relying on any of it** (`claude --version`, `claude --help`, `/usage`,
> a live push test).

## Goal & priority — what we were reaching for

The driver was an **autonomous** cloud Implementer:

1. **Autonomous / fire-and-forget** — dispatch a slice and walk away; the Mac can
   be asleep or off while the cloud session works. *(This was the new ask.)*
2. **GUI-visible** — the run shows up as a card in the desktop Code tab /
   claude.ai/code / iOS, so the owner can watch it.
3. **Pushes a real PR** — the session opens a genuine pull request against `main`.
4. **On plan billing** — counts against the normal Claude subscription rate
   limits, no separate metered compute.

Points **2–4 are already features of the kept `/run-slice` flow** and must not
regress. **Autonomy (1)** was the only genuinely new capability — and it is what
the blocker below denied us.

## Kept vs parked

| | |
|---|---|
| **Kept (active)** | Manual **`/run-slice`** — Architect stages the spec, a human runs it in Claude Code. `.claude/commands/run-slice.md` + `docs/SLICE_PROMPT_TEMPLATE.md`. |
| **Parked (this dir)** | The dispatch tooling: `dispatch-slice.sh`, `watch-slices.sh`, `com.kathelix.slice-dispatch.plist`, `slice-agent-preamble.md`, and the mechanics guide `SLICE_DISPATCH.md`. |

## Approaches evaluated

| Approach | Verdict | Why |
|---|---|---|
| **Cloud `claude --remote`** | **Chosen** | GUI-visible, on plan billing, opens a real PR. Blocked only by the CLI push 401 below. |
| `claude -p` (headless) | Rejected | Not GUI-visible (no Code-tab card / claude.ai/code / iOS), and **metered** against the separate Agent-SDK credit pool after 2026-06-15. |
| `claude --remote-control` | Rejected | Its positional arg is a session **name**, not a prompt; it is process-bound / interactive (no fire-and-forget); billing unresolved. |

## The blocker that parked it (as of 2026-06-14)

**A CLI-launched `claude --remote` session cannot push — the cloud git proxy
returns HTTP 401**, so it can clone and work but cannot open a PR.

Observed in the dispatched session's environment:

- `CCR_TEST_GITPROXY=1` was set — a **test** git-proxy path, not production.
- `CCR_SESSION_ACCOUNT_EMAIL` was **unset** — no user binding, so the proxy has
  no identity to translate into GitHub credentials.
- **Read works** (the repo is public, so the clone succeeds); **write 401s**.
- A **fresh** session, created after installing the Claude **GitHub App** and
  running **`/web-setup`**, hit the **same 401**.

**Web/desktop-launched** cloud sessions use the **production** credential path
and *do* push — so the gap is **specific to the CLI trigger** (`claude --remote`
from the shell), not to cloud sessions in general. This is **not config-fixable
by us**; revisit and/or file feedback to Anthropic.

## Pattern A — why the dispatcher force-commits the staging

`issue-drafts/` is **gitignored**, and a cloud session runs in a fresh VM that
**clones the repo from GitHub** — it cannot read local files. So the dispatcher
**force-commits** the whole `issue-drafts/<slice>/` folder onto the feature
branch (`git add -f`) before pushing, so the clone carries the spec *and* any
fixtures. The cloud Implementer then moves fixtures into their committed home and
removes the staging dir, so after a squash-merge `main` never shows
`issue-drafts/`. Full mechanics: [`SLICE_DISPATCH.md`](SLICE_DISPATCH.md).

## Fixes already applied to this tooling

- **bash-3.2 `${BRANCH}` multibyte fix** — brace-delimit `${BRANCH}` before a
  trailing ellipsis so macOS bash 3.2 under a UTF-8 locale doesn't mis-scan the
  multibyte byte into the variable name ([PR #23](https://github.com/kathelix/UK_DevOps/pull/23), merged).
- **Recovery-gap rollback** — a dispatch that fails *after* the branch is cut
  (push 401, `claude` non-zero) now rolls back cleanly: it returns to the
  starting branch, deletes the throwaway local branch, and leaves the slice
  inputs on disk untracked, so nothing is lost and re-dispatch works. *(This
  slice — `rollback()` in `dispatch-slice.sh`.)*

## Billing (as of 2026-06-14)

The **2026-06-15** change meters the **Agent SDK**, **`claude -p`**, **GitHub
Actions**, and **3rd-party SDK apps** into a **separate Agent-SDK credit pool**.
**Interactive Claude Code**, **Claude.ai**, **Cowork**, and the cloud **"Claude
Code on the web" (`--remote`)** stay on **plan rate limits** per current docs —
which is why `--remote` was preferred over `claude -p`. **Re-verify via `/usage`
after the 15th.**

## Conventions still in force (used by the kept `/run-slice` flow)

These are **not** parked — they govern the active manual flow and are documented
in `CLAUDE.md` / `AGENTS.md`:

- **Branch = work type**, declared by the Architect in the slice spec:
  `<!-- branch: chore/x -->` (full name) or `<!-- type: fix -->` (→ `fix/<slice>`),
  defaulting to `feature/<slice>`.
- **Spec path:** `issue-drafts/<slice>/slice-prompt-<slice>.md` — the name
  `/run-slice` auto-discovers (newest `slice-prompt-*.md`).

## To revive

1. **Re-test the push** from a **web/desktop-launched** cloud session (the
   production credential path) to confirm whether the CLI-trigger gap still
   exists.
2. **Check `claude --version`** for a preview build that may have closed the
   CLI-trigger / git-proxy gap.
3. **Consider a hybrid:** stage **and push** the feature branch **locally**
   (where credentials work), then launch the cloud session **from the GUI** on
   that already-pushed branch — sidestepping the CLI push entirely.

## Files in this directory

| File | Role |
|---|---|
| `dispatch-slice.sh` | The dispatcher: cut a branch, force-stage the slice, push, launch `claude --remote`. Has `--dry-run` and the recovery-gap rollback. |
| `watch-slices.sh` | OPT-IN GO-sentinel poll loop for hands-off auto-dispatch. **Its header is the single canonical `launchctl` runbook.** |
| `com.kathelix.slice-dispatch.plist` | launchd agent that runs `watch-slices.sh` at login (OPT-IN; not loaded by default). |
| `slice-agent-preamble.md` | Cloud-Implementer working-agreement, prepended to the slice spec at dispatch time. |
| `SLICE_DISPATCH.md` | Detailed mechanics / limitations guide (the revival reference). |
