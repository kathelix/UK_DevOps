# Gmail Collector — Apps Script setup

Faithful port of Make.com scenario "UK DevOps - Gmail Collector" (Gmail → regex clean → store → label as collected). Destination is Airtable instead of Google Sheets. The 1:1 port has since been hardened with a reliability net — single-flight lock, timeout-safety, and crash-safe upsert dedupe (see §3).

## 1. Airtable table

Created automatically by CI from `airtable/schema.json` (additive-only apply via the Meta API — see `.github/workflows/deploy-airtable.yml`). The reference layout:

Table name: **RawEmails**

| Field | Type | Mirrors Make/Sheets column |
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

1. GAS editor → Project Settings → Script Properties → `AIRTABLE_TOKEN` = PAT with `data.records:write` on the base.
2. Run `collectJobEmails` once → authorize scopes → check Logger + the RawEmails table.
3. Triggers → Add → `collectJobEmails`, time-driven, daily 4am–5am (before the screening run).

## 3. Parity notes

- **Same query, same labels** as Make (`-label:job-vacancies/make-collected …`, adds `make-collected` on success). Script and Make scenario share state — they can run side by side during transition without double-collecting. Unread status is never touched, same as Make.
- **Regex verbatim** from the Text parser module, flags `gis` (global, case-insensitive, dot-matches-newline) exactly as configured in Make.
- **Write ordering** matches Make: write the row first, label as collected only on success. The write is an Airtable upsert (`PATCH` + `performUpsert` on `MessageId`), so a crash between the write and the label re-updates the same row on retry instead of creating a duplicate — never a duplicate row, never a lost email.
- **Reliability net (divergences from Make, additive only):** a `LockService` single-flight guard makes overlapping scheduled runs exit cleanly instead of double-writing or racing labels; the run processes the queue in sub-batches of `CONFIG.SUB_BATCH_SIZE` (fetch → upsert → label, each committed before the next) and stops starting sub-batches once over `CONFIG.MAX_RUNTIME_MS` (5 min, under the ~6 min Apps Script limit). So every run makes forward progress and a timeout or crash loses at most one in-flight sub-batch. These guard *how* a run terminates and how much it commits at once, not *what* it collects.
- `make-processing` is excluded by the query but never set, as in Make. `make-failed` is also excluded; unlike Make, the script *does* set it on a per-message processing failure (e.g. an HTML decode error) to keep one poison message from blocking the queue. Retry-count-based failure handling (label after N failures) remains a `TODO.md` item.
- `MAX_MESSAGES` is configurable (Make ran with limit=1).

Known drawbacks inherited from the 1:1 port, and planned improvements, are tracked in [`TODO.md`](../TODO.md) at the repo root.

## 4. Costs

£0. Apps Script consumer quotas: 90 min/day trigger runtime, 20,000 UrlFetch calls/day — this uses ~30 seconds and ~3 calls.
