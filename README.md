# UK DevOps — Job Search Automation

A daily, mostly hands-off pipeline that collects UK DevOps job-alert emails, screens every vacancy against personal criteria (rate, remote, IR35, clearance, tech stack), tracks applications, and produces a daily report with a side of sarcasm. Human attention is required only for flagged roles — everything else is rejected, deduplicated, or logged automatically.

## How it works

```mermaid
flowchart LR
    A[Gmail\njob-alert emails,\nfiltered to a label] --> B[Apps Script collector\ncleans HTML, every 30 min]
    B --> C[(Airtable\nRawEmails queue +\nVacancies decisions)]
    C --> D[Claude · Cowork\nscheduled 06:00 screening]
    D -->|writes decisions,\ndaily report| C
    D -->|flags worth applying| E[Ivan]
    E -->|applies, replies| D
```

Job boards and recruiters email constantly; Gmail filters label everything into one place. A small Google Apps Script picks up new emails every 30 minutes, cleans the links offline (decodes trackers that embed their destination in a `?url=`-style param and strips `utm_*` analytics params — no network calls, no clicking), strips the remaining HTML noise with a regex, and stores clean text in Airtable. Claude (running scheduled in Claude Cowork) reads the queue, splits digests into individual vacancies, screens them against versioned criteria, verifies ambiguous roles on the web, writes Applied/Skipped decisions to Airtable, and posts a daily report. Ivan applies to the flagged few and tells Claude, which logs the outcome.

## Components

| Component | Role | In this repo |
|---|---|---|
| Gmail + filters | Intake: all job alerts under one label | — |
| Google Apps Script "UK DevOps - Gmail Collector" | Fetch, clean, store (every 30 min) + nightly RawEmails purge | `apps-script/` |
| Airtable base "Job Search" | State store: email queue + vacancy decisions | `airtable/` (schema-as-code) |
| Claude (Cowork) | The screening brain: split, dedupe, score, verify, report | `instructions/` (versioned rules) |
| GitHub Actions | Deploys the script (clasp) and Airtable schema on merge to main | `.github/workflows/` |
| Make.com | Legacy collector — parallel-run until cutover, then retired | `UK_DevOps_Gmail_Collector.blueprint.json` |

## Repo map

- `apps-script/` — the collector script, manifest, setup guide
- `airtable/` — desired schema + idempotent apply script (additive-only)
- `instructions/` — Claude's pipeline instructions (`VERSION`-ed, source of truth)
- `docs/` — technical design & decisions (`TECH_DESIGN.md`), project brief, daily workflow, design notes, known issues, operations runbook
- `tests/` — `node:test` harness + fixtures for the collector (cleaning regex, offline link cleanup, parsers, reliability helpers)
- `TODO.md` — improvement backlog + open milestone

## Status

**Parallel-run week** (since 2026-06-07): the new collector shadows the legacy Gmail-direct screening path. Cutover plan: `TODO.md`, milestone M6.
