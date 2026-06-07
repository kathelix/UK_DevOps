# TODO

Improvements deliberately deferred during the 1:1 Make.com → Apps Script port of the Gmail collector (see `apps-script/README.md`). Roughly in priority order.

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible.
- [ ] **Dedupe on retry.** Write-then-label ordering means a crash between the Airtable write and the labeling re-collects the same message next run. Use Airtable upsert (`performUpsert` on MessageId) or pre-check existing MessageIds.
- [ ] **Actually use `make-failed` / `make-processing` labels.** The query excludes them (as in Make) but nothing ever sets them; a persistently failing message currently just retries forever. Label it `make-failed` after N failures.
- [ ] **Failure alerting.** Script emails on error, and/or the screening pipeline treats "0 New rows in RawEmails but unread mail present in Gmail" as a collector failure rather than a quiet day.
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step.
- [ ] **Extract links into a separate field.** Harvest hrefs from the original HTML, junk-filter (unsubscribe, tracking pixels, manage-alerts), dedupe. Feeds the pipeline's link-resolution rule (§6a).
- [ ] **Resolve tracking redirects to canonical job URLs** (`clicks.reed.co.uk`, `click.nijobs.com/f/a/…`) via `UrlFetchApp`, capped per run. Note: this "clicks" the trackers.
- [ ] **Regression test for the cleaning regex** using `tests/fixtures/email.html` (e.g. clasp + local runner, or an in-project `checkFixture()` assertion function).
- [ ] **Raise `MAX_MESSAGES` back to ~25** once testing with `1` is done.

## Pipeline integration

- [ ] **Switch the Claude screening pipeline (project instructions Block 1 §1) from Gmail search to RawEmails**: read `Status=New` → screen → flip to `Processed`. Keep the Gmail connector as fallback + discrepancy canary. Do this only after the collector has run validated in parallel with Make.
- [ ] **Decommission the Make.com scenario** once parity is confirmed (it also burns the 1,000 free ops/month).

## Docs

- [ ] **Reconcile `docs/v3_design.md`** — it assumes Make.com remains the orchestrator with a Python cleanup service; the Apps Script collector changes that premise (no per-run credit costs, cleanup can grow in-script or still move to a service later).
