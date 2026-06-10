# Technical Design

_Living document — edited in place, history lives in git. One section per design area; each records the current design, its rationale, **Rejected:** alternatives with why, and **Revisit when:** triggers, so settled questions aren't re-litigated._

## 1. Architecture overview

Gmail filters funnel all job-alert email under one label; a Google Apps Script collector picks it up daily, cleans it offline, and stores clean text in Airtable (RawEmails queue + Vacancies decisions); a scheduled Claude (Cowork) run screens the queue against versioned instructions, writes decisions, and reports to Ivan. The flow diagram and component table live in the [README](../README.md) — not duplicated here.

## 2. Collector — fetch & write pipeline

- **Sub-batch pipeline with a forward-progress guarantee.** The run is an interleaved fetch → upsert → label loop over sub-batches (`CONFIG.SUB_BATCH_SIZE = 5`), each committed before the next — not a two-phase fetch-all-then-write-all. The runtime budget (`MAX_RUNTIME_MS`, against the ~6-minute Apps Script execution limit) is checked once per sub-batch, and the first sub-batch always runs: every run commits at least one sub-batch, and a timeout or crash loses at most one. **Rejected:** separate budget breaks in a two-phase fetch/write structure — under sustained slow-fetch latency the write-phase guard tripped before writing anything, re-collecting the same head-of-queue messages with no forward progress. Guarded by the forward-progress test in `tests/collect-loop.test.js`.
- **Write-then-label ordering.** The Airtable write happens before the Gmail label; a crash in between re-presents the message next run. No data loss by design — the dedupe below makes the retry safe.
- **Dedupe on retry.** Airtable upsert (`performUpsert` on `MessageId`) rather than pre-checking existing rows. **Revisit when:** rows become per-vacancy instead of per-email — switch the dedupe key to `gmailMessageId + urlHash`.
- **Single-flight.** A `LockService` guard (`tryLock(0)`, exit cleanly if held, release in `finally`) prevents overlapping scheduled runs — duplicate writes and label races.
- **Runtime controls, not redeploys.** `MAX_MESSAGES` (fetch cap; `0` = pause switch) and `DRY_RUN` (log would-be writes/labels, touch nothing) are Script Properties read at runtime. Semantics and procedure: [OPERATIONS — Collector: routine procedures](OPERATIONS.md#collector-routine-procedures).

## 3. Collector — offline link cleanup

Job-alert emails wrap links in tracking redirectors, which bloats `CleanText` (measured: ~10 KB of a 19.4 KB body was tracking-URL base64) and hides real job URLs from screening.

**Decision: the collector cleans links entirely offline — it makes no network calls of any kind** (no `UrlFetchApp`, no fetching/following/probing). Before `CLEAN_REGEX`, for every URL in the body (both `href="…"` values and bare-text URLs) it (a) decodes an embedded destination and (b) strips `utm_*` analytics params, swapping the cleaned form in place. Operational description and the per-run `Links: decoded=N utm_stripped=M bytes_saved=B` log line (the only output — no Airtable schema field): [OPERATIONS — Collector: offline link cleanup](OPERATIONS.md#collector-offline-link-cleanup).

- **Value-guard only — no param-name allow-list, no tracker-host list.** The embedded destination is the **first** query param in document order whose URL-decoded value is itself an absolute `http(s)` URL or an absolute path (`/…`, prepending the tracker's scheme+host). **Rejected:** a curated list of redirect param names (`url`, `u`, `dest`, `redirect_uri`, …) — a maintenance burden that silently misses any name not enumerated (`redirect_url`, `dest_url`, `r2`, …); the "value must be a URL/path" guard is zero-maintenance and future-proof. **Accepted cost:** if a tracker carries a non-destination URL-valued param *before* the real one in document order (e.g. `?img=https://cdn/logo.png&url=…`), the wrong value is picked — rare in click-trackers, deliberate trade-off (decided with Ivan).
- **`HtmlLength` parity.** `HtmlLength` stays the **original** body length (parity with Make's `length(1.htmlBody)`); only `CleanText`/`CleanLength` reflect the cleanup. With neither an embedded destination nor a `utm_` param present, the transform is a **byte-identical no-op**.
- **Rejected: network redirect resolution** (`UrlFetchApp`, hop on `3xx` `Location`, cap per run — prototyped in PR #5, closed unmerged). Judged both risky and incomplete: (1) **side-effect risk** — tracker links are not all idempotent GETs; some are one-click unsubscribe or 1-click-apply endpoints, and even a `HEAD`/no-body hop can trip them; (2) **incompleteness** — opaque tracker tokens (`?data=<JWT>`, `/f/a/<token>`) encode the destination only on the sender's server, so the risky hop buys nothing for the opaque majority; (3) **cost/fragility** — network latency against the ~6-minute limit, quota burn, and a non-deterministic, hard-to-unit-test cleaning step.
- **Opaque-token resolution lives at the screening layer:** Claude resolves canonical job URLs by click-free **content-search**, never by following links. Offline, opaque trackers pass through unshrunk — accepted.
- **Accepted cost: no re-encoding of decoded separators.** A decoded destination's inner separators come back as bare `&` (from `%26`); we do not re-encode to `&amp;`. Harmless for the screening consumer (it reads text, not a browser).
- **Accepted cost: bare-text URL followed by a content entity** (`&nbsp;`, `&hellip;`, …) can be mis-harvested — `&` is ambiguous in an HTML body. Does not affect the href-based corpus; documented in [KNOWN_ISSUES §5](KNOWN_ISSUES.md), not fixed because excluding `&` from the harvest would truncate real raw-`&` trackers.
- **Implementation notes (review hardening).** The in-place swap is one position-based `String.replace` pass over the original body (not repeated `split`/`join`), so a freshly-inserted destination is never re-scanned and a URL that is a substring of another can't be corrupted by a later swap. Trailing punctuation is trimmed with a linear character walk, not an anchored `/[…]+$/` regex, which would backtrack O(n²) on a long punct run in a sender-controlled URL token.
- **Superseded: a dedicated extracted-links field.** Harvesting hrefs into a separate junk-filtered, deduped Airtable field was an earlier plan for the same tracker-bloat problem; the in-place cleanup above delivers real links to the pipeline with no separate field and no schema change. **Revisit when:** the screening pipeline wants a harvested, junk-filtered links list of its own.

The whole stage is pure and unit-testable (`tests/link-cleanup.test.js`, an end-to-end real-email fixture, and a mutation-checked wiring test). Parity preserved: emails with no trackers/utm produce exactly the regex-only `CleanText`.

## 4. Collector — HTML cleaning & no-library policy

The collector carries hand-written string logic: `CLEAN_REGEX` (HTML noise stripping) and the offline link cleanup (`harvestUrls_` / `decodeEmbeddedDestination_` / `stripUtm_` / `cleanLinksInHtml_`). Question raised during PR #6: wouldn't an established HTML/URL library be safer and less code?

**Decision: while the collector runs on Google Apps Script, keep the custom pure-function approach — no third-party HTML or URL library.**

1. **No dependency story on GAS without a build step.** `clasp` pushes raw files, and `.claspignore` ships exactly one (`gmail-collector.gs`, plus `appsscript.json`); there is no npm at deploy time. A library means bundling (webpack/esbuild → one large `.gs`) or vendoring — adding a bundler and a compile-before-push pipeline to a project that deliberately has none. It would also break the test harness's central trick: `tests/helpers/load-collector.js` runs the raw `.gs` in a `vm` *because* the file stays free of `require`/`module.exports`.
2. **Byte-parity with Make is the contract during the parallel-run cutover.** `CLEAN_REGEX` is a 1:1 port of the Make.com "Text parser" regex; a real DOM parser produces *different* output and would blow up the golden corpus. `URL`/`URLSearchParams` **normalise** (re-percent-encode, drop default ports, …), breaking the "byte-identical output when nothing changes" guarantee, and assume `&` separators where our hrefs are HTML-entity-encoded (`&amp;`) with original separators and untouched params deliberately preserved. Surgical string ops honour parity more simply than wrapping a library to defeat its normalisation.
3. **No viable built-in either.** GAS's `XmlService` chokes on real email HTML (almost never well-formed XML — that malformedness is *why* regex stripping exists). And GAS's V8 runtime most likely does **not** expose the WHATWG `URL`/`URLSearchParams` globals (web-platform APIs, not ECMAScript) — **unverified**; a two-line check in the GAS editor would confirm before any future URL-library consideration.
4. **The custom logic is small and well-tested.** ~150 lines of pure functions, covered by 67 `node --test` cases including a real-email corpus and mutation-checked guards — a modest, bounded maintenance surface.

**Rejected:** cheerio / parse5 (DOM parsing — breaks parity, needs bundling); `URL` / `URLSearchParams` (normalising — breaks parity; availability on GAS unverified).

**Accepted cost:** we own the parsing edge cases. This bit during PR #6 — an HTML injection via a decoded `</body>`, a trailing-punctuation ReDoS, a bare-text-URL entity absorption — all now pinned by regression tests, but the class of risk is ours to carry.

**Revisit when:** adopt the platform `URL` + a real HTML→text parser when either (a) the cleaning ambition grows materially — the backlog's **second cleaning pass** (tag→text, entity decode, block-boundary newlines) is genuinely hard to hand-roll well — or (b) the cleaning moves **off Apps Script** to a Node/Python service (see [v3_design.md](v3_design.md)), where the constraints above vanish. The inflection point is "the runtime changed" or "the ambition grew" — not "the code got fiddly". Those two tend to arrive together, and that is the natural moment to bring in libraries rather than retrofitting a bundler onto the single-file GAS collector now.

## 5. Data model (Airtable)

- **Vacancies stays decisions-only** (applied/skipped/flagged) — no full vacancy inventory. **Rejected:** storing every parsed vacancy — the Airtable free-tier record cap; ~100 parsed vacancies/day would blow it in weeks.
- **RawEmails is a transient queue and needs a purge job:** delete `Processed` rows older than ~7 days (record deletion is API-supported, unlike schema deletion).
- **Schema-as-code, additive-only.** `airtable/schema.json` + an idempotent apply script in CI (Meta API). The API cannot delete tables/fields or change field types — removals stay manual. Caveat: matching is by field **name** until ID-matching lands (`TODO.md` → Airtable), so a UI rename re-creates the field as a duplicate on the next run — treat `schema.json` as the authority on names; see [KNOWN_ISSUES §3](KNOWN_ISSUES.md).

## 6. Screening layer

- **Instructions are versioned.** `VERSION: x.y` header (from 1.0): MAJOR = breaking (intake, gates, output contract), MINOR = non-breaking. Claude echoes the loaded version in every batch report.
- **Cross-source vacancy identity rule** (ships into the instructions at M6): same title-pattern + rate band + location + stack via a *different* recruiter = same underlying vacancy. Keep one record, append "also via \<recruiter\> at \<rate\>" to Notes, never apply through a second channel once an application is in flight; prefer better terms / direct posting before first application; uncertain identity → flag, don't auto-merge. Rationale: duplicate agency submissions can disqualify the candidate.
- **M6 cutover contract.** Intake becomes RawEmails (read `Status=New` → screen → flip to `Processed`); the Gmail connector is demoted to fallback + discrepancy canary. Until cutover, Gmail stays authoritative and RawEmails is shadow data — see [OPERATIONS](OPERATIONS.md).

## 7. Deployment & CI

- **Deploy on merge.** Merge to `main` → GitHub Action `clasp push` (script) and schema apply (Airtable, additive-only per §5). **Decided: no CI-triggered execution, ever** — execution stays on the GAS time trigger and manual runs; CI only deploys.
- **Script Properties and triggers are runtime state,** not deployed artifacts: one-time manual setup plus an idempotent `setup()`. Secrets inventory: [OPERATIONS](OPERATIONS.md#secrets-inventory-names-and-locations--never-values).
