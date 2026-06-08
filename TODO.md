# TODO

Improvements deliberately deferred during the 1:1 Make.com → Apps Script port of the Gmail collector (see `apps-script/README.md`). Roughly in priority order.

## Roadmap: GAS collector rollout (agreed 2026-06-07)

Goal: new GAS script runs end-to-end — deployed from CI, fed by time trigger, consumed by Claude from Airtable.

- [x] **M1 — Apps Script project files into repo**: `appsscript.json` manifest (declares Gmail Advanced Service, scopes, timezone — replaces manual "Services" setup) + `.clasp.json` (scriptId).
- [x] **M2 — CI deploy via clasp**: GitHub Action `clasp push` on merge to main; `CLASPRC_JSON` as repo secret. CI deploys only — execution stays on the GAS time trigger / manual runs (decided: no CI-triggered execution, ever). Script Properties and triggers remain runtime state: one-time manual + idempotent `setup()`.
- [x] **M3 — Airtable schema-as-code**: `airtable/schema.json` + idempotent apply script in CI (Meta API, PAT with `schema.bases:write`). Additive-only: the API cannot delete tables/fields or change field types — removals stay manual. First apply creates `RawEmails`.
- [x] **M4 — Collector E2E (1 email)**: add `DRY_RUN` flag (log would-be writes/labels, touch nothing); then real run with `MAX_MESSAGES=1`, verify RawEmails row + `make-collected` label.
- [x] **M5 — Claude dry-run session (Cowork)**: read `Status=New` rows, split into vacancies, screen per Block 2; propose Vacancies rows + Status flips in chat only, zero writes. Second pass writes to `Vacancies_test` before touching real tables.
- [ ] **M6 — Instructions cutover (bump to VERSION 2.0)**: rewrite Block 1 §1 (intake = RawEmails, Gmail demoted to fallback + discrepancy canary) and §9 (mark-as-read → Status flip); claude.ai project field becomes a bootstrap stub → read `instructions/Claude_project_instructions.md` from the mounted UK_DevOps folder. Local dir primary, fail loudly if folder not attached, no network fallback. Verify the scheduled run's session has the folder attached. Pause Make scenario after parity.

Decisions of record:
- **Vacancies stays decisions-only** (applied/skipped/flagged) — no full vacancy inventory (Airtable free-tier record cap; ~100 parsed vacancies/day would blow it in weeks). RawEmails needs a **purge job**: delete `Processed` rows older than ~7 days (record deletion is API-supported).
- **Cross-source vacancy identity rule** (goes into instructions at M6): same title-pattern + rate band + location + stack via a *different* recruiter = same underlying vacancy. Keep one record, append "also via <recruiter> at <rate>" to Notes, never apply through a second channel once an application is in flight; prefer better terms / direct posting before first application; uncertain identity → flag, don't auto-merge. Rationale: duplicate agency submissions can disqualify the candidate.
- **Instructions file is versioned** (`VERSION: x.y` header, from 1.0): MAJOR = breaking (intake, gates, output contract), MINOR = non-breaking. Claude echoes the loaded version in every batch report.

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible.
- [x] **Dedupe on retry.** Write-then-label ordering means a crash between the Airtable write and the labeling re-collects the same message next run. Use Airtable upsert (`performUpsert` on MessageId) or pre-check existing MessageIds. When rows later become per-vacancy instead of per-email, switch the dedupe key to `gmailMessageId + urlHash`. _(Done 2026-06-08, branch `collector/reliability-net`: `airtableUpsert_` PATCHes with `performUpsert` on MessageId.)_
- [ ] **Actually use `make-failed` / `make-processing` labels.** The query excludes them (as in Make) but nothing ever sets them; a persistently failing message currently just retries forever. Label it `make-failed` after N failures.
- [ ] **Failure alerting.** Script emails on error, and/or the screening pipeline treats "0 New rows in RawEmails but unread mail present in Gmail" as a collector failure rather than a quiet day.
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step. Measured 2026-06-07 (NIJobs single-rec, 47.2KB html → 19.4KB clean): ~3.5KB is invisible-entity preheader padding (`&#847;&zwnj;&shy;` walls) the regex doesn't target; real content is only ~5KB.
- [ ] **Extract links into a separate field.** Harvest hrefs from the original HTML, junk-filter (unsubscribe, tracking pixels, manage-alerts), dedupe. Feeds the pipeline's link-resolution rule (§6a). Measured 2026-06-07: ~10KB of a 19.4KB CleanText was tracking-URL base64 (just 8 links) — extraction alone halves stored text; combined with the second cleaning pass, ~19.4KB → ~5KB.
- [ ] **Resolve tracking redirects to canonical job URLs** (`clicks.reed.co.uk`, `click.nijobs.com/f/a/…`) via `UrlFetchApp`, capped per run. Note: this "clicks" the trackers.
- [ ] **Regression test for the cleaning regex** using `tests/fixtures/email.html` (e.g. clasp + local runner, or an in-project `checkFixture()` assertion function).
- [ ] **Modularize for testability** — split into `config / gmail / parser / airtable / main`; keep cleaning, link-extraction and dedupe as pure functions (no Gmail/Airtable side effects) so they run against `tests/fixtures/` locally.
- [x] **Raise `MAX_MESSAGES` back to ~25** once testing with `1` is done. (Done 2026-06-07, start of parallel-run week.)

### Reliability

- [x] **LockService guard** — prevent overlapping scheduled runs (duplicate writes, label races); `tryLock`, exit cleanly if held, release in `finally`. _(Done 2026-06-08, branch `collector/reliability-net`: `tryLock(0)` wrapper around `collectJobEmailsLocked_`.)_
- [ ] **Retry wrapper with exponential backoff** (1s/2s/4s, then fail cleanly) for external calls: Airtable writes, Gmail API reads, any `UrlFetchApp`.
- [x] **Timeout safety** — track elapsed time, stop cleanly before the Apps Script execution limit, leave the rest for the next run (pairs with the `MAX_MESSAGES` batch size). _(Done 2026-06-08, branch `collector/reliability-net`: `MAX_RUNTIME_MS` break in the fetch loop.)_

## Airtable

- [ ] **Import the existing Vacancies table schema into `airtable/schema.json`** so all schemas are under version control (RawEmails and Vacancies_test already are). Do it via a small repeatable export script (`airtable/import-schema.js`: GET Meta API → merge into schema.json) rather than hand-copying, so drift snapshots stay diffable. Prerequisite for safety: extend `apply-schema.js` to match fields **by field ID when present** (import IDs along with names) — name-only matching turns any UI rename into a duplicate field on the next CI run. With ID matching, renames become detectable drift warnings instead.

## Pipeline integration

- [ ] **Switch the Claude screening pipeline (project instructions Block 1 §1) from Gmail search to RawEmails**: read `Status=New` → screen → flip to `Processed`. Keep the Gmail connector as fallback + discrepancy canary. Do this only after the collector has run validated in parallel with Make.
- [ ] **Decommission the Make.com scenario** once parity is confirmed (it also burns the 1,000 free ops/month).
- [ ] **Refactor Make.com leftovers after decommission** — rename state labels `job-vacancies/make-collected|processing|failed` → tool-neutral (preferred, e.g. `job-vacancies/collected|…`) or `gas-*`; add a `nolinks` state once link extraction lands. Also sweep other relics: `UK_DevOps_Gmail_Collector.blueprint.json` at repo root (archive into `docs/` or delete), "Make" wording in `apps-script/README.md` parity notes and script comments.

## Docs

- [ ] **Reconcile `docs/v3_design.md`** — it assumes Make.com remains the orchestrator with a Python cleanup service; the Apps Script collector changes that premise (no per-run credit costs, cleanup can grow in-script or still move to a service later).
