# TODO

Improvements deliberately deferred during the 1:1 Make.com → Apps Script port of the Gmail collector (see `apps-script/README.md`). Roughly in priority order.

## Roadmap: GAS collector rollout (agreed 2026-06-07)

Goal: new GAS script runs end-to-end — deployed from CI, fed by time trigger, consumed by Claude from Airtable.

- [ ] **M6 — Instructions cutover (bump to VERSION 2.0)**: rewrite Block 1 §1 (intake = RawEmails, Gmail demoted to fallback + discrepancy canary) and §9 (mark-as-read → Status flip); claude.ai project field becomes a bootstrap stub → read `instructions/Claude_project_instructions.md` from the mounted UK_DevOps folder. Local dir primary, fail loudly if folder not attached, no network fallback. Verify the scheduled run's session has the folder attached. Pause Make scenario after parity.
- [ ] **M6 addendum — V2.0 link-resolution directives (agreed with Ivan 2026-06-11)**, fold into Block 1 §6a when rewriting:
  - **Claude-in-Chrome resolution pass for flagged roles only.** After screening completes, resolve the final Flagged list's links in the user's Chrome (navigate → get_page_text) to find the live canonical posting and verify work model/rate/clearance on the rendered page. Do NOT browser-resolve every email link — too slow/token-heavy, and email text already rejects most. Proven 2026-06-11: 5/5 flags resolved; 2 upgraded (iwoca remote-within-UK confirmed, Intellias live+remote), 3 exposed as aggregator fiction or dead scrapes.
  - **Cookie banners: pre-authorised to accept** when resolving links in Chrome (owner grant 2026-06-11).
  - **Geo-blocking / VPN.** Some boards geo-reject from France ("candidates from your area are not accepted"). Before the Chrome resolution pass, remind Ivan to connect "Total VPN 2" (macOS app) to a United Kingdom server; treat geo-reject pages as VPN-not-connected, not as dead listings. Stretch goal: drive Total VPN 2 via computer use — connect to UK at pass start, disconnect at end.

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible.
- [ ] **`make-failed` on a repeatedly-transient write / set `make-processing`.** `make-processing` is never set (as in Make). Still uncovered: a message that fetches fine but whose Airtable write fails **transiently** (`429`/`5xx`) on every run is left to retry forever by design (a transient is never quarantined — only deterministic rejects are, see below). Add retry-count-based `make-failed` labelling (label after N *transient* failures) to cap that, and decide whether `make-processing` is worth setting. _The cross-run counter was rejected for the deterministic case (slower, doesn't unblock siblings — `docs/TECH_DESIGN.md` §2); a counter still fits the repeatedly-transient case._
- [x] Write-side **deterministic-`4xx`** poison isolation — a record-specific Airtable reject (e.g. `422`) is isolated to its own record and `make-failed` (guarded by ≥1 healthy sibling), so good siblings stop being re-fetched every run. Read-side parse/decode `make-failed` was already in place; this makes the write side symmetric — PR #19
- [ ] **Failure alerting — screening-side canary.** The screening pipeline treats "0 New rows in RawEmails but unread mail present in Gmail" as a collector failure rather than a quiet day. _(The script half is done: collector and purge executions now end Failed on any upsert/list/delete failure, so GAS failure emails fire.)_
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step. Measured 2026-06-07 (NIJobs single-rec, 47.2KB html → 19.4KB clean): ~3.5KB is invisible-entity preheader padding (`&#847;&zwnj;&shy;` walls) the regex doesn't target; real content is only ~5KB. _The single-child table-wrapper unwrap (#13) already landed as the safe incremental step; tag→text would subsume its saving, at which point the unwrap retires or becomes its pre-stage — see `docs/TECH_DESIGN.md` §4._
- [ ] **Modularize for testability** — split into `config / gmail / parser / airtable / main`; keep cleaning, link-extraction and dedupe as pure functions (no Gmail/Airtable side effects) so they run against `tests/fixtures/` locally. _(Remaining: the full module split — `buildUpsertPayload_` and `isOverRuntimeBudget_` are already extracted as pure, unit-tested helpers.)_
- [x] Collapse single-child table wrappers in CleanText — Issue #13
- [x] Per-sender footer cutoff with template-change alarm — Issue #14

### Reliability

- [x] **Retry wrapper with exponential backoff** (1s/2s/4s, then fail cleanly) for Airtable calls — `airtableFetchWithRetry_` wraps upsert (write), list + delete (purge); transient (`429`/`5xx`/transport throw) only, budget-aware on the collector path, deletes opt out of transport-throw retry (non-idempotent). TECH_DESIGN §2.
- [ ] **Gmail-read retry** (`Messages.get`/`list`) — deferred from the Airtable retry slice: the per-message `get` already lives inside the read-side poison-isolation try/catch, so wrapping it is a separate change with its own failure semantics.

## Airtable

- [ ] **Import the existing Vacancies table schema into `airtable/schema.json`** so all schemas are under version control (RawEmails and Vacancies_test already are). Do it via a small repeatable export script (`airtable/import-schema.js`: GET Meta API → merge into schema.json) rather than hand-copying, so drift snapshots stay diffable. Prerequisite for safety: extend `apply-schema.js` to match fields **by field ID when present** (import IDs along with names) — name-only matching turns any UI rename into a duplicate field on the next CI run. With ID matching, renames become detectable drift warnings instead.

## Pipeline integration

- [ ] **Switch the Claude screening pipeline (project instructions Block 1 §1) from Gmail search to RawEmails**: read `Status=New` → screen → flip to `Processed`. Keep the Gmail connector as fallback + discrepancy canary. Do this only after the collector has run validated in parallel with Make.
- [ ] **Decommission the Make.com scenario** once parity is confirmed (it also burns the 1,000 free ops/month).
- [ ] **Refactor Make.com leftovers after decommission** — rename state labels `job-vacancies/make-collected|processing|failed` → tool-neutral (preferred, e.g. `job-vacancies/collected|…`) or `gas-*`. Also sweep other relics: `UK_DevOps_Gmail_Collector.blueprint.json` at repo root (archive into `docs/` or delete), "Make" wording in `apps-script/README.md` parity notes and script comments.

## Developer experience

- [ ] **Fix Code session renaming**: fix the `scripts/pr-session-name.sh`, currently symlink-ed `~/.claude/hooks/pr-session-name.sh` that should rename a Claude Code sesion to "PR#nn" once session opens a new PR. Debug in the existing session that already created a PR, because it has all the logs from this hook and script.
- [ ] **Revisit Cowork-Code handover approach**: Currently parked in `scripts/slice-passing-parked``
