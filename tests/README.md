# Tests

Node-only unit tests for the Gmail collector (`apps-script/gmail-collector.gs`),
run with the built-in test runner — no framework, no dependencies.

```sh
node --test        # from the repo root  (or: npm test)
```

## Why these live at the repo root, not under `apps-script/`

`clasp` deploys everything under its `rootDir` (`apps-script/`, see `.clasp.json`
and `.claspignore`) to Apps Script. A file with `require` / `module.exports` in
that directory would break the push. So the harness and tests live here, outside
`rootDir`, and the deployed `.gs` file stays free of any test scaffolding. The CI
deploy job (`deploy-gas.yml`) is path-filtered to `apps-script/**` and never sees
this directory; the `tests.yml` job runs these on every relevant PR.

## How the harness works

`helpers/load-collector.js` reads `gmail-collector.gs` verbatim and runs it in a
`vm` context seeded with minimal Apps Script stubs (`Utilities`, `Logger`, and —
for the Airtable test — `PropertiesService` / `UrlFetchApp`), then exposes the
pure / near-pure functions. The file on disk is never modified.

Two realm caveats the tests work around: values created in the VM realm have the
VM's prototypes (so `deepStrictEqual` against a Node literal fails — assert on
primitive leaves / `Object.keys` / JSON round-trips), and a VM-realm regex is not
`instanceof` Node's `RegExp` (assert on `.source` / `.flags` / behavior).

## What's covered

- **`clean-regex.test.js`** — `CLEAN_REGEX`: per-alternative cases plus a golden
  regression against a real captured email (`fixtures/email.html`).
- **`parsers.test.js`** — `parseFrom_`, and `decodeB64Url_` (both body shapes the
  Gmail service returns, plus the forensic error paths).
- **`reliability-helpers.test.js`** — `isOverRuntimeBudget_` (timeout boundary),
  `clampSubBatchSize_` (the `[1,10]` stride clamp), `buildUpsertPayload_` and
  `airtableUpsert_` (the PATCH-upsert dedupe contract).
- **`max-messages.test.js`** — the runtime-tunable `MAX_MESSAGES` Script Property:
  `parseIntProp_` (the strict, non-clamping `[0,500]` parser — `0`/`"50"`/`" 50 "`
  accepted, decimal/sign/garbage/out-of-range → default), `getIntProp_` (warns on a
  set-but-invalid value, silent on unset/blank or a valid value equal to the default),
  and an integration pass over `collectJobEmailsLocked_` pinning the **`0` short-circuit**
  (no `Gmail.Users.Messages.list` call, no writes, no labels) and the **`maxResults`
  wiring** (unset → 25 parity, a valid override reaches Gmail, garbage → 25). Each is
  mutation-checked — neutering the early return, the `maxResults: maxMessages` wiring, or
  the warning flips an assertion.
- **`resolver.test.js`** — tracker-URL resolution (slice `feature/tracker-url-resolution`):
  `harvestHrefs_` / `dedupe_` (pull + dedupe href values), `decodeEntities_` (`&amp;` → `&`
  before fetch), `hostOf_` / `pathOf_`, `classifyTracker_` (exact + `*.suffix` wildcard +
  path-pinned shared hosts), `isJunkLink_` (unsubscribe/manage/pixel/cv-upload rejected even
  on a tracker host), `resolveTracker_` (the header-only 3xx hop loop — single/multi-hop,
  max-hops, non-3xx, missing/relative Location, exception), `resolveTrackersInHtml_` (the
  per-message path: in-place swap, swap-all-occurrences, the found/resolved metric, the
  **shared cap**, dry-run detect-don't-click, and the **`maxResolutions=0` byte-identical
  no-op**), and `logTrackerSummary_`. The fetch is injected so no real network is touched.
- **`collect-loop.test.js`** — integration: drives `collectJobEmailsLocked_` with
  stubbed Apps Script globals and an injected clock. Pins the pipeline's load-bearing
  invariants — forward progress (an over-budget run still commits the first sub-batch),
  incremental commit, **upsert-failure** (a rejected sub-batch is NOT make-collected —
  no silent data loss), **poison isolation** (a bad message is make-failed while
  siblings are collected; an all-poison sub-batch sends no empty upsert), the
  **`SUB_BATCH_SIZE > 10` clamp** (no oversized request / 422 livelock), the happy
  path, `DRY_RUN`, and the **tracker-resolution wiring** (the swapped CleanText + the
  `TrackersFound`/`TrackersResolved` fields reach the upsert; `MAX_RESOLUTIONS_PER_RUN=0`
  threads through to a no-op). Each guard is mutation-checked — removing the budget break, the
  `if (!ok)` check, the empty-records guard, the clamp, the resolved-HTML wiring, or the
  kill-switch short-circuit flips an assertion.

## Not covered (deliberately)

- The `LockService` single-flight guard — left to manual / live verification (a
  pure side effect around the run).
- The inner per-label granularity (a sub-batch already in flight is not interrupted
  mid-label) — an accepted, idempotency-bounded limit, not a unit concern. Full
  modularization for deeper testability is tracked in `TODO.md` ("Modularize for
  testability").
