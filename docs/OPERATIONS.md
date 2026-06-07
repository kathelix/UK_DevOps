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
