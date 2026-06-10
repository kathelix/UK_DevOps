# TODO

Improvements deliberately deferred during the 1:1 Make.com → Apps Script port of the Gmail collector (see `apps-script/README.md`). Roughly in priority order.

## Roadmap: GAS collector rollout (agreed 2026-06-07)

Goal: new GAS script runs end-to-end — deployed from CI, fed by time trigger, consumed by Claude from Airtable.

- [ ] **M6 — Instructions cutover (bump to VERSION 2.0)**: rewrite Block 1 §1 (intake = RawEmails, Gmail demoted to fallback + discrepancy canary) and §9 (mark-as-read → Status flip); claude.ai project field becomes a bootstrap stub → read `instructions/Claude_project_instructions.md` from the mounted UK_DevOps folder. Local dir primary, fail loudly if folder not attached, no network fallback. Verify the scheduled run's session has the folder attached. Pause Make scenario after parity.

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible.
- [ ] **`make-failed` after N failures / set `make-processing`.** `make-processing` is never set (as in Make). `make-failed` _is_ already set on a per-message processing exception (decode/parse error → poison-message isolation, see the catch block in `collectJobEmailsLocked_`), but a message that fetches fine yet repeatedly fails the Airtable _write_ is only logged, not labelled — so it retries forever. Add retry-count-based `make-failed` labelling (label after N failures) to cover that path.
- [ ] **Failure alerting — screening-side canary.** The screening pipeline treats "0 New rows in RawEmails but unread mail present in Gmail" as a collector failure rather than a quiet day. _(The script half is done: collector and purge executions now end Failed on any upsert/list/delete failure, so GAS failure emails fire.)_
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step. Measured 2026-06-07 (NIJobs single-rec, 47.2KB html → 19.4KB clean): ~3.5KB is invisible-entity preheader padding (`&#847;&zwnj;&shy;` walls) the regex doesn't target; real content is only ~5KB.
- [ ] **Modularize for testability** — split into `config / gmail / parser / airtable / main`; keep cleaning, link-extraction and dedupe as pure functions (no Gmail/Airtable side effects) so they run against `tests/fixtures/` locally. _(Remaining: the full module split — `buildUpsertPayload_` and `isOverRuntimeBudget_` are already extracted as pure, unit-tested helpers.)_

### Reliability

- [ ] **Retry wrapper with exponential backoff** (1s/2s/4s, then fail cleanly) for external calls: Airtable writes, Gmail API reads, any `UrlFetchApp`.

## Airtable

- [ ] **Import the existing Vacancies table schema into `airtable/schema.json`** so all schemas are under version control (RawEmails and Vacancies_test already are). Do it via a small repeatable export script (`airtable/import-schema.js`: GET Meta API → merge into schema.json) rather than hand-copying, so drift snapshots stay diffable. Prerequisite for safety: extend `apply-schema.js` to match fields **by field ID when present** (import IDs along with names) — name-only matching turns any UI rename into a duplicate field on the next CI run. With ID matching, renames become detectable drift warnings instead.

## Pipeline integration

- [ ] **Switch the Claude screening pipeline (project instructions Block 1 §1) from Gmail search to RawEmails**: read `Status=New` → screen → flip to `Processed`. Keep the Gmail connector as fallback + discrepancy canary. Do this only after the collector has run validated in parallel with Make.
- [ ] **Decommission the Make.com scenario** once parity is confirmed (it also burns the 1,000 free ops/month).
- [ ] **Refactor Make.com leftovers after decommission** — rename state labels `job-vacancies/make-collected|processing|failed` → tool-neutral (preferred, e.g. `job-vacancies/collected|…`) or `gas-*`. Also sweep other relics: `UK_DevOps_Gmail_Collector.blueprint.json` at repo root (archive into `docs/` or delete), "Make" wording in `apps-script/README.md` parity notes and script comments.

## Docs

- [ ] **Reconcile `docs/v3_design.md`** — it assumes Make.com remains the orchestrator with a Python cleanup service; the Apps Script collector changes that premise (no per-run credit costs, cleanup can grow in-script or still move to a service later).
