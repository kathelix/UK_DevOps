# Gmail Collector — Apps Script setup

Faithful port of the retired Make.com scenario "UK DevOps - Gmail Collector" (Gmail → regex clean → store → label as collected). Destination is Airtable instead of Google Sheets. The 1:1 port has since been hardened with a reliability net — single-flight lock, timeout-safety, and crash-safe upsert dedupe (see §3).

## 1. Airtable table

Created automatically by CI from `airtable/schema.json` (additive-only apply via the Meta API — see `.github/workflows/deploy-airtable.yml`). The reference layout:

Table name: **RawEmails**

| Field | Type | Ported from Make/Sheets column |
|---|---|---|
| MessageId | Single line text (primary) | C — Message ID |
| ExecutionId | Single line text | A — `{{executionId}}` |
| CollectedAt | Date (incl. time) | B — `{{now}}` |
| ThreadId | Single line text | D — Thread ID |
| EmailDate | Date (incl. time) | E — internalDate |
| FromName | Single line text | F — fromName |
| FromEmail | Single line text | G — fromEmail |
| Subject | Single line text | H — subject |
| Snippet | Long text | I — snippet |
| UserLabels | Single line text | J — user label names |
| HtmlLength | Number (0 dp) | K — length(htmlBody) |
| CleanLength | Number (0 dp) | L — length(cleaned) |
| CleanText | Long text | M — cleaned; 49k Sheets cap dropped, truncated only at Airtable's 100k long-text limit |
| Status | Single select: New / Processed / Error | — (only addition; queue field for the screening pipeline, default "New") |

## 2. Deployment

Continuous: merge to `main` touching `apps-script/**` → GitHub Action runs `clasp push` (see `.github/workflows/deploy-gas.yml`). The `appsscript.json` manifest declares the Gmail Advanced Service, OAuth scopes and timezone — no manual "Services" clicking.

> **`.claspignore` is an allow-list.** It ignores `**/**` and then un-ignores each script by name (`!gmail-collector.gs`, `!vacancies-backup.gs`, `!appsscript.json`). A **new** `.gs` file is therefore **not** pushed unless you add its own `!<file>.gs` line — adding the file alone deploys nothing.

One-time bootstrap (local):

1. `npm i -g @google/clasp && clasp login`
2. Enable the Apps Script API: [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
3. Create or link the script project:
   - existing project: copy its Script ID (GAS editor → Project Settings) into `.clasp.json`;
   - new: `clasp create --type standalone --title "UK DevOps - Gmail Collector" --rootDir apps-script` (writes `.clasp.json` for you — commit it).
4. `clasp push -f` once locally to verify, then add GitHub repo secrets:
   - `CLASPRC_JSON` = contents of `~/.clasprc.json` (created by `clasp login`)
   - `AIRTABLE_SCHEMA_TOKEN` = PAT with `schema.bases:read|write` on the base (for the Airtable workflow)

Runtime state — stays manual, not deployable:

1. GAS editor → Project Settings → Script Properties → `AIRTABLE_TOKEN` = PAT with `data.records:read+write` on the base (read is required by `purgeRawEmails`, which counts and lists records before deleting — re-scope or replace an older write-only PAT before enabling the purge trigger).
2. Run `collectJobEmails` once → authorize scopes → check Logger + the RawEmails table.
3. Triggers → Add → `collectJobEmails`, time-driven — cadence is tuned in the GAS console and recorded once in `docs/TECH_DESIGN.md` §7.
4. Triggers → Add → `purgeRawEmails`, time-driven, day timer, nightly window per the same `TECH_DESIGN` §7 (the RawEmails janitor — runbook in `docs/OPERATIONS.md`).

## 3. Parity notes

- **Query shape inherited from the Make scenario; state-label names since renamed.** The script originally shared label state with Make (same query, adds the collected label on success) so the two could run side by side during the parallel-run transition without double-collecting. Make was **decommissioned 2026-06-17**; now the sole collector, the script uses tool-neutral label names — the query excludes `-label:job-vacancies/collected -label:job-vacancies/failed` and a successful write adds `job-vacancies/collected`. Unread status is never touched (as in the original Make scenario).
- **Regex verbatim** from the Text parser module, flags `gis` (global, case-insensitive, dot-matches-newline) exactly as configured in the original Make scenario.
- **Write ordering** follows the original Make scenario: write the row first, label as collected only on success. The write is an Airtable upsert (`PATCH` + `performUpsert` on `MessageId`), so a crash between the write and the label re-updates the same row on retry instead of creating a duplicate — never a duplicate row, never a lost email.
- **Reliability net (divergences from the original Make scenario, additive only):** a `LockService` single-flight guard makes overlapping scheduled runs exit cleanly instead of double-writing or racing labels; the run processes the queue in sub-batches of `CONFIG.SUB_BATCH_SIZE` (fetch → upsert → label, each committed before the next) and stops starting sub-batches once over `CONFIG.MAX_RUNTIME_MS` (5 min, under the ~6 min Apps Script limit). So every run makes forward progress and a timeout or crash loses at most one in-flight sub-batch. These guard *how* a run terminates and how much it commits at once, not *what* it collects.
- No in-flight / "processing" marker is set (as in the original Make scenario): single-flight + the idempotent write-then-label already give crash-safety, so a mid-flight marker would add persistent state for no benefit (decided 2026-06-15). The never-set `processing` token the query used to carry was dropped from `CONFIG.QUERY` in the same label-rename slice. `failed` is also excluded; unlike the original Make scenario, the script *does* set it to keep one bad message from blocking the queue — on a per-message **read-side** processing failure (e.g. an HTML decode error), on a **write-side** deterministic Airtable reject (a `4xx` isolated to one record when its sub-batch siblings wrote fine), and on a **repeatedly-transient write** (a record whose own `429`/`5xx`/transport keeps failing, quarantined after `MAX_TRANSIENT_WRITE_RETRIES` consecutive strikes — default 5, runtime-tunable; the first strike needs a healthy sibling to prove record-specificity, then the counter is **sticky** so it keeps striking once the record is alone — Codex F1 fix). A *single* transient write failure is never `failed` (it retries next run), and a **fresh** message in a **systemic** reject/outage (every record fails, no healthy sibling) is never struck or quarantined and the run fails loud. See `docs/TECH_DESIGN.md` §2 and the `wretry:`/`MAX_TRANSIENT_WRITE_RETRIES` runbook in `docs/OPERATIONS.md`.
- `MAX_MESSAGES` is the per-run fetch cap (the original Make scenario ran with limit=1). The source default (25) is overridable at runtime via the `MAX_MESSAGES` Script Property — integer 0–500, `0` = processing disabled (no-op run) — with no code change or redeploy; out-of-range/garbage falls back to the default. See `docs/OPERATIONS.md`.

Known drawbacks inherited from the 1:1 port, and planned improvements, are tracked in [`TODO.md`](../TODO.md) at the repo root.

## 4. Vacancies backup (`vacancies-backup.gs`)

A **separate** script in the same GAS project: `backupVacancies()` writes a daily off-platform CSV of the **Vacancies** decisions table (Ivan's irreplaceable Applied/Skipped history) into a fixed Google Drive folder — the disaster-recovery copy, since Airtable has no API-schedulable/off-site backup. RawEmails is **not** backed up (regenerable from Gmail). Additive and self-contained: it shares the one global namespace but redeclares nothing, reusing only the generic `airtableToken_` helper. Design + restore caveat: [`docs/TECH_DESIGN.md`](../docs/TECH_DESIGN.md) §5; runbook: [`docs/OPERATIONS.md`](../docs/OPERATIONS.md) → *Vacancies backup (off-platform DR)*.

- **Script Property:** reuses `AIRTABLE_TOKEN` (read-only — `data.records:read` suffices); optional `BACKUP_FOLDER_ID` overrides the destination folder.
- **Drive scope:** adds `https://www.googleapis.com/auth/drive` to `appsscript.json` (needed to open the **pre-existing** folder by id — `drive.file` only reaches app-created files). **Adding a scope forces a one-time re-authorization of the whole project:** run `backupVacancies` once in the editor after deploy to re-consent. See the runbook.
- **Trigger:** daily, late hour (cadence in [`docs/TECH_DESIGN.md`](../docs/TECH_DESIGN.md) §7) — added manually in the GAS console, or via the optional idempotent `ensureDailyBackupTrigger()`.

## 5. Costs

£0. Apps Script consumer quotas: 90 min/day trigger runtime, 20,000 UrlFetch calls/day — the collector uses ~30 seconds and ~3 calls; the daily backup adds ~2–3 UrlFetch calls and a single small Drive write.
