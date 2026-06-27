# Known Issues

## 1. Gmail search-index orphans (messages invisible to the API)

**Symptom:** an email is visible in the Gmail web UI under `label:job-vacancies label:unread`, but no API query can find it — not `from:`, not `subject:`, not free text, not even `in:anywhere` with spam/trash included. Observed 2026-06-07 with securityclearedjobs.com emails (sender "noreply", subjects like "GCP Cloud Engineer at IO Associates…"); both stayed unread across multiple screening runs.

**Cause:** Gmail keeps two read paths. The **label store** (label → thread mapping, written transactionally at delivery) serves the UI's label views. The **full-text search index** is built asynchronously after delivery — and indexing is not guaranteed. Messages with MIME the indexer dislikes never enter the index. Every API search (`q=` parameter) goes through the index; the UI's label browsing does not. Result: delivered, labeled, visible — and unsearchable.

**Who inherits it:** anything using `q=`-based listing — the Claude Gmail connector, the retired Make.com "Search emails" module, and the current Apps Script collector (`Gmail.Users.Messages.list({q})`). The structural fix (label-store listing via `getUserLabelByName()` / `labelIds`) is in `TODO.md` → Collector.

**Detection (canary):** the screening pipeline marks everything it processes as read; the collector labels everything it stores. Anything left unread/uncollected in the label after the daily runs — beyond post-run arrivals — is an index orphan. Check occasionally in the Gmail UI.

**Current handling:** securityclearedjobs.com is a known-irrelevant sender anyway (100% clearance-gated); instructions v1.1 documents both the instant-reject and the count-mismatch explanation. The agreed mitigation is monitoring via the canary; escalate to the label-store fix if orphans appear from senders that matter.

## 2. Apps Script Advanced Gmail Service auto-decodes body data

`payload.body.data` arrives as a **byte array** (number[]), not the base64url string the raw Gmail API returns — the Apps Script client auto-converts `format: byte` fields. Decoders fed `String(byteArray)` fail with misleading errors (`invalid char "," …`). Handled in `decodeB64Url_()` (array → `newBlob(bytes)`); the string path is kept as fallback. Cost three debugging rounds on 2026-06-07; see commit `db60415`.

## 3. Airtable schema apply is additive-only (rename-safe via field-ID matching)

The Meta API cannot delete tables/fields or change field types, so `airtable/apply-schema.js` only creates and warns — removals/retypes stay manual.

**Resolved — field-ID matching shipped.** apply-schema now matches tables/fields **by id when present** (name is the fallback). A field renamed in the Airtable UI is detected as a rename-drift warning (`schema.json says <name>, live is <liveName> (<id>) — reconcile`) and is **not** re-created as a duplicate. `airtable/import-schema.js` backfills the live ids into `schema.json` and snapshots structural drift; run it before editing the schema.

**Residual:** rename-safety applies only to entries that carry an id. All three managed tables now carry live ids in `schema.json` — RawEmails (backfilled 2026-06-17, PR #36), Vacancies (already did), and **PostTopics** (backfilled 2026-06-27 from the live ids the post-merge apply assigned) — so every current managed field is rename-safe. The footgun is **future-only**: it returns for a **newly added** table/field committed name-only — until `import-schema.js` is run once (`schema.bases:read`) to backfill its id (or the ids are read off the live base and hand-applied, validated by the fixed-point test in `tests/import-schema.test.js`). For any such not-yet-backfilled entry, treat `schema.json` as the authority on names and don't rename it in the UI.

## 4. Aggregator "remote" tags lie

Reed's "WFH Remote" badge is recruiter-set; verified false on 2026-06-07 (Rise Technical listing: 3 days onsite, Inside IR35, SC/DV preferred). NIJobs prints "Benefits: Work From Home" under descriptions that say "Hybrid from Belfast". Screening rules in `instructions/` v1.1 treat tags as noise — only spec text or web verification confirms remote.

## 5. Offline link cleanup: bare-text URL immediately followed by an HTML entity

**Symptom:** the collector's offline link-cleanup harvest regex (`https?://[^\s"'<>]+`, in `harvestUrls_`) stops only at whitespace / quotes / `<>`. A **bare-text** URL (one not inside an `href="…"`, so not bounded by a quote) immediately followed by a content entity — `&nbsp;`, `&hellip;`, `&#160;`, … — absorbs that entity into the match. If that URL also carries a `utm_` param or an embedded destination (so it gets rewritten), the rewrite can mangle the trailing entity/text.

**Cause:** in an HTML body, `&` is genuinely ambiguous — it is both a raw query separator (`?a=1&b=2`, used as-is by CV-Library / Google Analytics links) **and** the start of an entity (`&nbsp;`). The regex deliberately keeps `&` so real raw-`&` and `&amp;` query separators stay part of the URL; the cost is that a trailing content entity on a *bare-text* URL is indistinguishable from a separator.

**Why not "fixed":** excluding `&` from the harvest class would truncate the real raw-`&` trackers (verified against `tests/fixtures/email-cv-library.html`), which is worse. A full entity-vs-separator disambiguation still cannot resolve `&amp;` in prose.

**Who it affects:** essentially nothing in practice — real job-alert HTML puts URLs in `href="…"` attributes, where the closing quote bounds the URL and no absorption occurs (covered by a test). Bare-text URLs adjacent to entities do not appear in the corpus. Flagged during the offline-link-cleanup review (2026-06-09); revisit only if a real sender surfaces it.

## 6. Airtable free-plan record cap is per base across all tables — and enforcement lags the notification

**Symptom:** Airtable notified that the Job Search base was over its 1,000-record limit (observed 2026-06-10, notification at 11:13) after the collector swept a ~3-week backlog: RawEmails 940 + Vacancies 77 = 1,017. Record **creation was still succeeding ≥5 hours after** the notification — the cap is announced before it is enforced, and the enforcement timing is unspecified.

**Cause / contract:** the free plan's 1,000-record cap is a **per-base budget shared by every table in the base**, not a per-table limit. Any one table's growth spends everyone's headroom.

**Handling:** the nightly `purgeRawEmails` job keeps RawEmails at ≤ 700 (high-water; see [OPERATIONS — RawEmails purge](OPERATIONS.md#rawemails-purge-janitor)), and the collector fails loudly on upsert failures so a hard write-block at the cap can't stall the pipeline silently. Capacity budget and allocation: `TECH_DESIGN.md` §5. Don't read "writes still succeed" as "we're under the cap".

## 7. A Claude Code session can't be reliably retitled to `PR#nn` from a hook — use `claude --from-pr`

**Context:** a global `PostToolUse` hook (`scripts/pr-session-name.sh`) tried to retitle a session to `PR#nn` on `gh pr create` by appending a `{"type":"custom-title",…}` record to the session journal. It was **retired 2026-06-18 (PR #37)** — the mechanism is unreliable, and Claude Code now solves the underlying need natively.

**Why it can't work (verified on Claude Code v2.1.177, PR #37):** the journal record format is correct (it matches what interactive `/rename` writes), but two layers defeat it — (a) a *running* session's title is driven by the app's **in-memory** state, so an out-of-band journal append never renames live; it can only take effect on the next **resume** (`/rename` works because it updates in-memory state; there is no CLI/programmatic equivalent — `--name` is startup-only); and (b) **compaction rewrites the journal from in-memory state and drops the out-of-band append entirely**, so in a long/compacted session the title is lost before any resume ever happens (observed: the PR #36 session compacted and retained 0 `custom-title` records despite the hook firing correctly).

**Use instead:** Claude Code natively links PRs to sessions — on `gh pr create` it writes first-class `pr-link` records (`{"type":"pr-link","prNumber":N,…}`) that **survive compaction**, and `claude --from-pr <n>` resumes the session that opened PR `<n>`. That reliably covers "find/resume a session by PR number"; the only thing lost by retiring the hook is a *visible* `PR#nn` label in the `/resume` picker, which isn't achievable reliably anyway. Removing the hook also requires removing its un-committable global registration — see the retirement PR for the exact `~/.claude/settings.json` + symlink changes.
