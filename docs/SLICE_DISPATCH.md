# Slice dispatch — Architect → Implementer handoff (cloud)

A way for the **Architect** (Claude Cowork) to hand a slice to the **Implementer**
(Claude Code) as a GUI-visible cloud session. The Architect stages the slice;
one command launches a Claude Code on the web session that implements it on a
branch and opens a PR. Merge stays manual.

## Flow

```
Cowork (Architect)                 your Mac                         GitHub / cloud
─────────────────                 ─────────                        ──────────────
write issue-drafts/<slice>/   ─►  scripts/dispatch-slice.sh <slice>
  slice-prompt-<slice>.md            │
  (+ fixtures, provenance)           ├─ git checkout -b feature/<slice> origin/main
                                     ├─ git add -f issue-drafts/<slice>/   (Pattern A)
                                     ├─ git commit + push                       ─► branch on GitHub
                                     └─ claude --remote "<preamble + prompt>"   ─► cloud Code session
                                                                                   │  (visible in Code tab,
                                                                                   │   claude.ai/code, iOS)
                                     watch in GUI ◄── implements, moves fixtures, ─┘
                                                       removes staging, opens PR vs main
                                     enable Auto-fix ─► Codex review comments + CI handled in-session
                                     you squash-merge ◄── (manual; never automated)
```

The Architect only writes files under the gitignored `issue-drafts/`. The
dispatcher dispatches from a **feature branch, never `main`**, so the cloud
session can't push to main, and it never merges.

## One-time setup

1. `claude` CLI installed and signed in to **claude.ai** (`--remote` needs
   subscription auth, not an API key).
2. GitHub connected to your Claude account: authorize the **Claude GitHub App**
   (needed for Auto-fix) or run `/web-setup` to sync your `gh` token.
3. The repo lives on GitHub (it does: `kathelix/UK_DevOps`).
4. `chmod +x scripts/dispatch-slice.sh`.

## Usage

```bash
scripts/dispatch-slice.sh <slice-name>             # branch comes from the slice spec
scripts/dispatch-slice.sh <slice-name> fix/hotfix  # optional one-off branch override
```

Author the spec from `docs/SLICE_PROMPT_TEMPLATE.md` into
`issue-drafts/<slice>/slice-prompt-<slice>.md`; its first `# H1` is the intended PR title.

**Branch naming is the Architect's call, declared in the spec** — the prefix is
the work type, so chores/fixes/docs aren't all `feature/`:

| In the slice spec                  | Resulting branch  |
| ---------------------------------- | ----------------- |
| `<!-- branch: chore/tidy-logs -->` | `chore/tidy-logs` |
| `<!-- type: fix -->`               | `fix/<slice>`     |
| (neither)                          | `feature/<slice>` |

The optional CLI arg overrides both. The resolved name is validated with
`git check-ref-format`, so a typo'd prefix fails fast instead of creating a junk branch.

## Fixtures (Pattern A)

A cloud session runs in a fresh VM that **clones the repo from GitHub** — it
cannot see local files, and `issue-drafts/` is gitignored. So the dispatcher
**force-stages the whole `issue-drafts/<slice>/` folder onto the feature branch**
(`git add -f`) and pushes, so the clone carries your prompt *and* fixtures. The
cloud Implementer then moves the fixtures into their committed home, folds the
provenance/redaction notes into the PR body, and deletes the staging dir — so
after a squash-merge `main` shows only the fixtures in their home.

Don't inline fixture *contents* into the prompt: byte-exactness (LF, the U+FFFD
head quirk, per-recipient token redaction) won't survive a prompt string. Let
git carry the bytes.

**Fixture-heavy or fiddly?** Skip the cloud and run a **local** session instead:
desktop **Code tab → Local**, point it at this repo, and paste the slice spec.
A local session reads `issue-drafts/<slice>/` straight off disk (no force-stage
needed) and is still fully visible in the GUI. Use cloud `--remote` for
prompt-only / light slices; local Code-tab for heavy fixture work.

## Cloud session limitations

- **No local machine access:** clones from GitHub at your current branch, so
  push first; it never sees local-only files, your working tree, or local tools.
- **No integrated terminal, file pane, connectors, or plugins**; no `@mention`.
- **Network is allowlisted by default** (package registries, GitHub, cloud SDKs);
  widen via the environment's network setting if a slice needs more.
- **No secrets store yet:** env vars are visible to anyone who can edit the
  environment — don't put real secrets there.
- **Push is proxy-restricted to the working branch** (a safety feature we rely on).

## Billing

Cloud sessions count against your **normal Claude subscription plan rate limits,
with no separate compute charge** and no API key. They do **not** draw from the
separate monthly *Agent SDK credit* that `claude -p` starts using on 2026-06-15.
Parallel sessions consume rate limits proportionately.

## Auto-fix (the review loop)

Once the PR exists, turn on **Auto-fix** so the session watches it and responds
to CI failures and reviewer (Codex) comments automatically: paste the PR URL into
the session and ask it to auto-fix, or toggle it in the web CI status bar.
Requires the Claude GitHub App. Replies post under your GitHub account, labeled
as Claude Code. It can't resolve merge conflicts on its own — open the session
and ask it to rebase.

## Safety

- **Never dispatches from `main`** and the proxy blocks pushes to other branches,
  so main is untouched until you merge.
- **Never merges** — `gh pr merge` is never invoked. You review (and let Codex
  review), then squash-merge yourself.
- Refuses to run on a dirty working tree or if the branch already exists.
