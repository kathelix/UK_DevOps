# <Slice title — becomes the PR title>

<!-- branch: feature/<slice> -->
<!-- issue: 00 -->

> Architect → Implementer handoff. Copy this file to
> `issue-drafts/<slice>/slice-prompt-<slice>.md`, fill every section, then dispatch with
> `scripts/dispatch-slice.sh <slice>`. Keep it self-contained — the cloud
> session sees this text (inlined) plus the repo's CLAUDE.md.
>
> **Branch:** set the `<!-- branch: … -->` line above — the **prefix is the work
> type** (`feature/`, `fix/`, `chore/`, `docs/`, `refactor/`), so not everything
> is a "feature". Prefix-only shorthand: a `type: chore` line in an HTML comment
> yields `chore/<slice>`. Omit both → `feature/<slice>`. `issue:` is optional and
> surfaces as a PR reference.
>
> **Fixtures:** drop any test fixtures / golden inputs / provenance notes in the
> same folder (`issue-drafts/<slice>/`). The dispatcher force-stages the whole
> folder onto the branch so the cloud session can read it; the Implementer moves
> the fixtures into their committed home and removes the staging (Pattern A).
> For fixture-heavy slices you can instead run a local Code-tab session — see
> `docs/SLICE_DISPATCH.md`.

## Scope
What this slice changes, in one or two sentences. The smallest shippable unit.

## Old → new behaviour to preserve
What works today that must keep working. Name the functions/files/contracts the
change touches and the behaviour to hold invariant.

## Acceptance criteria / tests
- [ ] Concrete, checkable outcomes.
- [ ] The exact tests to add or update (and what they assert).
- [ ] Which staged fixtures to land and where (if any).
- [ ] `npm test` (`node --test`) stays green.

## Guardrails
- Files/areas that are off-limits.
- Any value that must be re-measured rather than copied (CLAUDE.md →
  "Numbers measured by a prototype are corridors").
- PR targets `main`, with attribution line + single footer; never merge.

## Out of scope
Explicitly list what NOT to do, so the run doesn't wander.
