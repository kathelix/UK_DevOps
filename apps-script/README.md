# Gmail Collector — Apps Script setup

Faithful port of Make.com scenario "UK DevOps - Gmail Collector" (Gmail → regex clean → store → label as collected). Destination is Airtable instead of Google Sheets. No behavior improvements in this slice.

## 1. Airtable table (create manually in base "Job Search")

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

## 2. Script

1. [script.google.com](https://script.google.com) → New project → name it `UK DevOps - Gmail Collector` → paste `gmail-collector.gs`.
2. Services (+) → **Gmail API** → Add (the Advanced Gmail Service; needed for message-level labels and snippet, same granularity as Make's modules).
3. Project Settings → Script Properties → add `AIRTABLE_TOKEN` = a PAT scoped to the Job Search base with `data.records:write`.
4. Run `collectJobEmails` once → authorize → check Logger output and the Airtable table.
5. Triggers → Add → `collectJobEmails`, time-driven, daily 4am–5am (before the screening run).

## 3. Parity notes (deliberate, for later iterations)

- **Same query, same labels** as Make (`-label:job-vacancies/make-collected …`, adds `make-collected` on success). Script and Make scenario share state — they can run side by side during transition without double-collecting. Unread status is never touched, same as Make.
- **Regex verbatim** from the Text parser module, flags `gis` (global, case-insensitive, dot-matches-newline) exactly as configured in Make.
- **Search-index caveat inherited:** the query path (`q=`) is the same Gmail search index Make uses, so securityclearedjobs.com-style index orphans remain invisible to this slice. Switching the fetch to the label store (`getUserLabelByName`) is a later iteration.
- **Write ordering** matches Make: store row first, label as collected only on success. A crash between the two yields a duplicate row on retry (MessageId makes duplicates detectable), never a lost email.
- `make-processing` / `make-failed` labels are excluded by the query (as in Make) but never set by this slice (also as in Make's exported scenario).
- `MAX_MESSAGES` is 25/run vs Make's limit 1 — the only operational difference; lower it if you want strict parity.

## 4. Costs

£0. Apps Script consumer quotas: 90 min/day trigger runtime, 20,000 UrlFetch calls/day — this uses ~30 seconds and ~3 calls.
