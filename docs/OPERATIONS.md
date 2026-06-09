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
- **Tracker-URL resolution (`MAX_RESOLUTIONS_PER_RUN`):** the collector resolves known tracking-redirect links (e.g. `clicks.reed.co.uk`, `click.nijobs.com`, `*.ct.sendgrid.net`) to their canonical job URL and swaps them **in place** inside `CleanText` — shrinking the stored text (a tracker is often ~10× its canonical) and feeding the pipeline real links. Only the hosts in the script's `CONFIG.TRACKERS` list are ever network-resolved (that bounds the clicks); junk links (unsubscribe / manage-alerts / preferences / view-in-browser / pixels / CV-upload) are never resolved. GAS Script Properties → `MAX_RESOLUTIONS_PER_RUN` = integer `0`–`1000` overrides the per-run cap (source default `100`) with no redeploy. The cap is **shared across the whole run**: once hit, later messages still detect their trackers (counted, not resolved) but skip the network call. **`0` disables resolution entirely** — a kill-switch / A-B knob; `CleanText` is then byte-identical to the pre-resolution collector. Out-of-range / non-integer / negative / decimal values fall back to `100` and log `Ignoring Script property MAX_RESOLUTIONS_PER_RUN=…`; blank or unset falls back silently. The effective value is logged each run on the `Run config:` line. A **dry run still detects but never clicks or swaps** (resolution is an external side effect) — to dry-run *and* suppress detection counting, set `MAX_RESOLUTIONS_PER_RUN=0` as well. Edge: `UrlFetchApp` has no per-call timeout (~60 s default), so a hanging tracker can cost up to ~60 s/hop; the per-run cap and the `MAX_RUNTIME_MS` budget bound the blast radius (the run defers the rest).
- **Resolution metric (`TrackersFound` / `TrackersResolved`):** two integer fields on each RawEmails row — `TrackersFound` = distinct known-tracker URLs detected in the email (post junk-filter); `TrackersResolved` = how many of those reached a canonical and were swapped. Each run also logs a structured summary, e.g. `Trackers: found=42 resolved=37 (88%) | reed 12/12, sendgrid 8/10, jobmails 5/9, nijobs 12/12` — the per-host found/resolved breakdown shows which tracker families are failing, so the `CONFIG.TRACKERS` host list can be extended. `attempted=N` is appended only when the per-run cap stopped resolution short of `found`. Watch the rate over time; a family that stays at `0/N` means its host pattern needs adding or its redirect isn't a header-based 3xx.
- **Manual run:** GAS editor → run `collectJobEmails`. Safe to run repeatedly — already-collected messages are excluded by the `make-collected` label.
- **Health check:** GAS left sidebar → Executions (durations, failures). Airtable RawEmails should grow by roughly the day's email volume (~25). Trigger failures email Ivan ("Notify me immediately" setting).
- **Failed message:** processing failures are labeled `job-vacancies/make-failed` (excluded from future runs) with forensics in the execution log (error, MIME tree). Inspect the email in Gmail, fix the script if systematic, remove the label to retry.

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
