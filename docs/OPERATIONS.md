# Operations Runbook

## Daily schedule

| Time (Europe/London) | What | Where |
|---|---|---|
| ~04:30 (4–5am window) | Collector run: Gmail → clean → RawEmails, label `make-collected` | GAS time trigger |
| 06:00 | Screening run: read job alerts, screen, write Vacancies, daily report | Claude Cowork scheduled task |
| Ad hoc | Ivan reviews flags, applies, reports back; Claude logs Applied/Skipped | Chat |

During the **parallel-run period** the screening run still reads Gmail directly (authoritative); RawEmails is shadow data. Do not write RawEmails-sourced decisions to the real Vacancies table until M6 cutover.

## Secrets inventory (names and locations — never values)

| Secret | Scope | Stored in |
|---|---|---|
| `CLASPRC_JSON` | clasp OAuth (contents of `~/.clasprc.json`) | GitHub repo secret |
| `AIRTABLE_SCHEMA_TOKEN` | PAT: `schema.bases:read+write`, Job Search base only | GitHub repo secret |
| `AIRTABLE_TOKEN` ("UK DevOps - GAS collector") | PAT: `data.records:read+write`, Job Search base only | GAS Script Properties |

PAT names appear in Airtable record revision history — name them for the actor.

## Collector: routine procedures

- **Deploy:** merge to `main` touching `apps-script/**` → GitHub Action `clasp push`. No manual steps.
- **Dry run:** GAS Script Properties → set `DRY_RUN` = `true` → run `collectJobEmails` → Execution log shows would-be writes/labels, touches nothing. Delete the property (or set `false`) to resume.
- **Fetch cap / pause (`MAX_MESSAGES`):** GAS Script Properties → `MAX_MESSAGES` = integer `0`–`500` overrides the per-run fetch cap (source default `25`) with no code change or redeploy. Takes effect on the next run; the effective value is logged each run (`Run config: MAX_MESSAGES=…`). **`0` disables processing** — the trigger still fires but the run logs and exits immediately without fetching, writing, or labelling anything; use it as a pause switch (no need to touch the trigger) or a wiring smoke test. Out-of-range, non-integer, negative, or decimal values fall back to the default `25` and the rejected value is logged (`Ignoring Script property MAX_MESSAGES=…`); blank or unset also falls back, silently. Distinct from `DRY_RUN`: `DRY_RUN` still fetches and cleans and only skips the writes/labels, whereas `MAX_MESSAGES=0` skips the fetch entirely.
- **Manual run:** GAS editor → run `collectJobEmails`. Safe to run repeatedly — already-collected messages are excluded by the `make-collected` label.
- **Health check:** GAS left sidebar → Executions (durations, failures). Airtable RawEmails should grow by roughly the day's email volume (~25). Trigger failures email Ivan ("Notify me immediately" setting).
- **Failed message:** processing failures are labeled `job-vacancies/make-failed` (excluded from future runs) with forensics in the execution log (error, MIME tree). Inspect the email in Gmail, fix the script if systematic, remove the label to retry.

## Collector: offline link cleanup

Before the `CLEAN_REGEX` pass, the collector cleans URLs in the HTML body **offline — it makes NO network calls** (no `UrlFetchApp`, no fetching/following/probing of any link). It does two mechanical, click-free things to every URL it finds (both `href="…"` values and bare-text URLs):

1. **Decode embedded destinations.** When a tracker carries its real destination inside a query param (e.g. `…/refer/100145?url=%2Fjob%2F…`), the collector takes that decoded destination in place. It uses no host/param allow-list: it decodes the **first** query param (in document order) whose URL-decoded value is itself an absolute `http(s)` URL or an absolute path (`/…`) — the "value must be a URL/path" guard is the whole filter. Opaque tracker tokens (a `?data=<JWT>` with no embedded URL) are left untouched — those are server-expandable only and are resolved at the screening layer by click-free content-search.
2. **Strip `utm_*` analytics params** (any param whose name starts with `utm_`, case-insensitive), preserving every other param, their order, and any `#fragment`.

With neither present, the transform is a byte-identical no-op, so `CleanText` is exactly what the regex alone would have produced. `HtmlLength` always stays the **original** body length (parity with Make's `length(1.htmlBody)`); only `CleanText` / `CleanLength` reflect the cleanup.

**Why no fetching:** probing arbitrary tracker links can trigger side-effect endpoints (one-click unsubscribe, 1-click-apply), and opaque tokens can't be expanded offline anyway. See `docs/adr/0001-offline-link-cleanup.md`.

**Observability — per-run log line** (Executions panel), once per run, no Airtable field:

```
Links: decoded=<N> utm_stripped=<M> bytes_saved=<B>
```

`N` = embedded destinations recovered, `M` = URLs that had ≥1 `utm_` param removed, `B` = total chars removed across all in-place swaps. All three can be `0` (an email with no trackers/utm) — that is the expected no-op case, not an error.

## Canary: missing-email check

Pipeline marks processed mail read; collector labels collected mail. In the Gmail UI, search `label:job-vacancies label:unread` — anything old sitting there (not post-run arrivals) is a search-index orphan (see `KNOWN_ISSUES.md` §1). Same logic for uncollected: old mail without `make-collected`.

## Parity check (end of parallel-run week)

Compare, per day: RawEmails rows (`CollectedAt` date) vs emails the 06:00 run reports processing. Equal modulo index-orphans → cutover is safe → execute M6 (`TODO.md`).

## When things break

| Symptom | Likely cause | Action |
|---|---|---|
| Collector run red in Executions | Airtable API change/outage, expired PAT | Read execution log; messages stay uncollected and retry next run — no data loss by design (write-then-label ordering) |
| `Deploy GAS` workflow fails | `CLASPRC_JSON` token expired/revoked | `clasp login` locally, update the GitHub secret |
| `Deploy Airtable schema` fails | PAT scope/expiry, or schema.json invalid | Run locally: `AIRTABLE_TOKEN=… node airtable/apply-schema.js` |
| RawEmails empty but unread mail exists in Gmail | Collector trigger missing/failed, or index orphans | Executions panel first; then canary check |
| Screening run reports fewer emails than UI shows unread | Index orphans (KNOWN_ISSUES §1) | Expected for securityclearedjobs.com; investigate only for senders that matter |
