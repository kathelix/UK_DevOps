# UK DevOps — Job Search Automation

A daily, mostly hands-off pipeline that collects UK DevOps job-alert emails, screens every vacancy against personal criteria (rate, remote, IR35, clearance, tech stack), tracks applications, and produces a daily report with a side of sarcasm. Human attention is required only for flagged roles — everything else is rejected, deduplicated, or logged automatically.

## How it works

```mermaid
flowchart LR
    A[Gmail\njob-alert emails,\nfiltered to a label] --> B[Apps Script collector\ncleans HTML, on a time trigger]
    B --> C[(Airtable\nRawEmails queue +\nVacancies decisions)]
    C --> D[Claude · Cowork\nscheduled 06:00 screening]
    D -->|writes decisions,\ndaily report| C
    D -->|flags worth applying| E[Ivan]
    E -->|applies, replies| D
```

Job boards and recruiters email constantly; Gmail filters label everything into one place. A small Google Apps Script picks up new emails on a frequent time trigger (cadence recorded once, in `docs/TECH_DESIGN.md` §7), cleans the links offline (decodes trackers that embed their destination in a `?url=`-style param and strips `utm_*` analytics params — no network calls, no clicking), strips the remaining HTML noise with a regex, and stores clean text in Airtable. Claude (running scheduled in Claude Cowork) reads the queue, splits digests into individual vacancies, screens them against versioned criteria, verifies ambiguous roles on the web, writes Applied/Skipped decisions to Airtable, and posts a daily report. Ivan applies to the flagged few and tells Claude, which logs the outcome.

## Components

| Component | Role | In this repo |
|---|---|---|
| Gmail + filters | Intake: all job alerts under one label | — |
| Google Apps Script "UK DevOps - Gmail Collector" | Fetch, clean, store + nightly RawEmails purge; time triggers (cadence: `docs/TECH_DESIGN.md` §7) | `apps-script/` |
| Airtable base "Job Search" | State store: email queue + vacancy decisions | `airtable/` (schema-as-code) |
| Claude (Cowork) | The screening brain: split, dedupe, score, verify, report | `instructions/` (versioned rules) |
| GitHub Actions | Deploys the script (clasp) and Airtable schema on merge to main | `.github/workflows/` |
| Make.com | Legacy collector — runs in parallel as the safety net until decommission, then retired | `UK_DevOps_Gmail_Collector.blueprint.json` |

## Repo map

- `apps-script/` — the collector script, manifest, setup guide
- `airtable/` — desired schema + idempotent apply script (additive-only)
- `instructions/` — Claude's pipeline instructions (`VERSION`-ed, source of truth); `PROJECT_FIELD_STUB.md` is the bootstrap pointer pasted into the claude.ai project field (it reads the canonical file from the mounted folder — `docs/OPERATIONS.md` → "Instructions loading")
- `docs/` — technical design & decisions (`TECH_DESIGN.md`), project brief, daily workflow, design notes, known issues, operations runbook + slice prompt template (`SLICE_PROMPT_TEMPLATE.md`)
- `tests/` — `node:test` harness + fixtures for the collector (cleaning regex, offline link cleanup, parsers, reliability helpers)
- `scripts/slice-passing-parked/` — the **parked** Cowork→Code slice-dispatch tooling (`dispatch-slice.sh` et al.); the kept flow is manual `/run-slice`. See `scripts/slice-passing-parked/README.md`
- `TODO.md` — improvement backlog + open milestone

## Status

**Intake cutover shipped (M6.2):** the screening run now reads the collector's Airtable **RawEmails** queue as its source of truth (`Status=New` → screen → flip to `Processed`), with Gmail demoted to a fallback + discrepancy canary. The Make.com scenario and the GAS collector still run in parallel as the safety net until Make is decommissioned (a later slice). Roadmap: `TODO.md`, milestone M6; runbook: `docs/OPERATIONS.md`.
