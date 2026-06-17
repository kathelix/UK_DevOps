# TODO

Forward-looking backlog for the GAS collector + screening pipeline. Roughly in priority order. Shipped milestones and the decisions behind them live in the permanent docs — `docs/TECH_DESIGN.md` (decisions + rejected alternatives), `docs/OPERATIONS.md` (runbook), `docs/KNOWN_ISSUES.md` (caveats); this file tracks only **open** work.

## Screening pipeline

- [ ] **Footer-freshness analysis — Cowork-side daily scan (idea raised by Ivan 2026-06-14)**, fold into Block 1 as a screening-side step now that intake reads RawEmails (**M6.2 shipped → unblocked**):
  - **What.** During daily screening, after reading the day's cleaned emails from Airtable `RawEmails`, scan their footers and surface any *new* footer (sender not yet in the collector's `FOOTER_MARKERS`) or *changed* footer (text drifted from the known marker). Fuzzy pattern-spotting, so it lives with Claude/Ivan — explicitly not GAS.
  - **Why it's additive, not duplicate.** The GAS-side `truncateAtFooter_` template-change alarm (Issue #14, done; TECH_DESIGN §4) only fires for *mapped* senders whose marker goes missing, and only as a run-failure email — "unmapped senders never alarm." This Cowork pass covers the gap: footers on not-yet-mapped senders, plus marker drift, surfaced inline so Ivan sees it the same day without digging into Airtable/Gmail.
  - **Surface only when detected.** Add an inline alert to the batch report only when a new/changed footer is spotted; stay silent on clean days (mirrors the §8 "don't prompt if every role was a clean accept/reject" pattern).
  - **Output → action.** When flagged, propose a candidate marker string — entity-free, taken from stored `CleanText` byte-form (per the footer-fixture-capture recipe) — so `FOOTER_MARKERS` / the `.gs` can be updated. This is the human-in-the-loop feeder that keeps the collector's marker map current.
- [ ] **VPN automation for the live link-resolution pass (stretch).** Drive **Total VPN 2** (macOS app) via computer use: connect to a UK server at the start of the §6a Chrome pass, disconnect at the end — replacing the current remind-only step (`docs/OPERATIONS.md` → "Live link resolution (Chrome pass)"). Deferred from M6.3 (owner decision 2026-06-17).

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible. _(Parked pending the 2026-06-21 `label-store-fetch-recheck` probe.)_
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step. Measured 2026-06-07 (NIJobs single-rec, 47.2KB html → 19.4KB clean): ~3.5KB is invisible-entity preheader padding (`&#847;&zwnj;&shy;` walls) the regex doesn't target; real content is only ~5KB. _The single-child table-wrapper unwrap (#13) already landed as the safe incremental step; tag→text would subsume its saving, at which point the unwrap retires or becomes its pre-stage — see `docs/TECH_DESIGN.md` §4._
- [ ] **Modularize for testability** — split into `config / gmail / parser / airtable / main`; keep cleaning, link-extraction and dedupe as pure functions (no Gmail/Airtable side effects) so they run against `tests/fixtures/` locally. _(Remaining: the full module split — `buildUpsertPayload_` and `isOverRuntimeBudget_` are already extracted as pure, unit-tested helpers.)_

## Developer experience

- [ ] **Fix Code session renaming**: fix the `scripts/pr-session-name.sh`, currently symlink-ed `~/.claude/hooks/pr-session-name.sh` that should rename a Claude Code sesion to "PR#nn" once session opens a new PR. Debug in the existing session that already created a PR, because it has all the logs from this hook and script.
- [ ] **Revisit Cowork-Code handover approach** — currently parked under `scripts/slice-passing-parked/` (`docs/TECH_DESIGN.md` §8).
