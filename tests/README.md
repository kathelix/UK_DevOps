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

- **`clean-regex.test.js`** — `CLEAN_REGEX`: per-alternative cases plus a golden regression
  over a **corpus** of real captured job-alert emails spanning a spread of senders / HTML
  styles (`fixtures/email-*.html`: cv-library, reed, nijobs, welcometothejungle, joblookup,
  ziprecruiter, jobs4, whatjobs, milkround, procontractjobs — sanitized of PII, LF-only). A
  manifest check asserts every
  `email-*.html` has a golden entry and vice versa, so a fixture can't sit unread by any test
  (and adding a footer-cutoff fixture forces a golden entry here). Regex-only — it tests the
  regex in isolation, not the link-cleanup stage that runs before it.
- **`link-cleanup.test.js`** — the offline link cleanup (pure, no network):
  `harvestUrls_` (href + bare-text URLs, trailing-punctuation trim, dedupe),
  `decodeEmbeddedDestination_` (the value-guard decode — absolute URL / absolute-path
  cases, `?r=5`/`?u=alice` rejected, document-order-first incl. the accepted mis-pick,
  protocol-relative `//` rejected), `stripUtm_` (order/separator/`#fragment` preservation,
  `&amp;` and `&`, case-insensitive, the "merely contains utm" non-match, parity no-op),
  `cleanUrl_` (decode-then-utm), and `cleanLinksInHtml_` (all-occurrence swap + the
  decoded/utm_stripped/bytes_saved metric, incl. the zero case). An **end-to-end** golden
  on a real cv-library job-alert email (`fixtures/email-cv-library.html`) asserts the
  cleaner decodes its trackers + strips utm and shrinks the stored `CleanText` further than
  the regex alone.
- **`table-unwrap.test.js`** — the single-child table-wrapper unwrap (`collapseTableWrappers_`,
  pure, applied after `CLEAN_REGEX`): the wrapper pattern collapses (plain, via single
  `<tbody>`, attr-bearing skeleton tags, mixed case, whitespace between skeleton tags, a void
  child, a quote-aware `">"`-in-attribute tag, sibling wrappers, nested chains, a wrapper
  around a content table), content tables never touched (multi-row, multi-cell, `th`,
  `thead`, text+element / text-only / empty `td`, literal entities count as text), malformed
  HTML degrades to a byte-identical no-op (unclosed/stray/EOF tags; junk inside the KEPT
  element is opaque and fine), the parity no-op, the `MAX_UNWRAP_PASSES` cap (25-deep
  collapses fully, 30-deep leaves exactly the innermost 5), and the **value-pinning corpus
  test**: every fixture through the full pipeline (link cleanup → `CLEAN_REGEX` → unwrap)
  with per-fixture wrapper counts / bytes saved golden-pinned (ziprecruiter and whatjobs pinned
  at 0 and byte-identical — whatjobs's outer `table`/`tr`/`td` chain is never closed, so strict
  pairing correctly no-ops; jobs4 pinned at one genuine wrapper), so a silent drop in the win is
  a visible regression.
- **`footer-cutoff.test.js`** — the per-sender footer cutoff (`truncateAtFooter_`, pure, applied
  after the unwrap): hit / miss / none outcomes; domain keying (exact + dot-boundary suffix, the
  `notwhatjobs.com` look-alike rejected, last-`@` + lowercase extraction, no-`@` unmapped); the
  position floor (an identical marker planted early is a miss, just past the floor is a hit);
  `lastIndexOf` (a marker in a listing AND the footer cuts only at the footer); marker-with-tail
  removal; byte-identical no-op for `none`/`miss`; and the **value-pinning corpus test** — every
  mapped fixture through the full pipeline (link cleanup → `CLEAN_REGEX` → unwrap → footer cutoff)
  with per-fixture cut bytes pinned above their corridor floors (cv-library, unmapped, byte-identical).
- **`parsers.test.js`** — `parseFrom_`, and `decodeB64Url_` (both body shapes the
  Gmail service returns, plus the forensic error paths).
- **`reliability-helpers.test.js`** — `isOverRuntimeBudget_` (timeout boundary),
  `clampSubBatchSize_` (the `[1,10]` stride clamp), `isTransientWriteFailure_` (the
  `429`/`5xx`-transient vs deterministic-`4xx` write classifier, boundary + mutation
  pinned), `buildUpsertPayload_`, and `airtableUpsert_` (the PATCH-upsert dedupe contract,
  now returning the numeric HTTP code + capturing the first error into `failures`; a missing
  token fails fast, a `UrlFetchApp` transport throw maps to code `0` with a `network error:` capture).
- **`max-messages.test.js`** — the runtime-tunable `MAX_MESSAGES` Script Property:
  `parseIntProp_` (the strict, non-clamping `[0,500]` parser — `0`/`"50"`/`" 50 "`
  accepted, decimal/sign/garbage/out-of-range → default), `getIntProp_` (warns on a
  set-but-invalid value, silent on unset/blank or a valid value equal to the default),
  and an integration pass over `collectJobEmailsLocked_` pinning the **`0` short-circuit**
  (no `Gmail.Users.Messages.list` call, no writes, no labels) and the **`maxResults`
  wiring** (unset → 25 parity, a valid override reaches Gmail, garbage → 25). Each is
  mutation-checked — neutering the early return, the `maxResults: maxMessages` wiring, or
  the warning flips an assertion.
- **`collect-loop.test.js`** — integration: drives `collectJobEmailsLocked_` with
  stubbed Apps Script globals and an injected clock. Pins the pipeline's load-bearing
  invariants — forward progress (an over-budget run still commits the first sub-batch),
  incremental commit, **transient upsert-failure** (a `429`/`5xx` sub-batch is NOT
  make-collected and never make-failed — no silent data loss — and the run then ends by
  **throwing** after the summary logs: Failed execution → GAS failure email, with the
  successful sub-batches' labels applied before the throw), **read-side poison isolation**
  (a parse-error message is make-failed while siblings are collected; an all-poison
  sub-batch sends no empty upsert), **write-side poison isolation** (a deterministic-`4xx`
  record is re-sent individually and make-failed only when ≥1 sibling upserted `200`; a
  systemic all-`4xx` sub-batch quarantines nothing and fails loud — counted once per
  sub-batch, not per record; a missing token fails fast rather than masking as a transient;
  a `UrlFetchApp` transport throw is transient; DRY_RUN quarantines nothing), the
  **`SUB_BATCH_SIZE > 10` clamp** (no oversized request / 422 livelock), the happy
  path, `DRY_RUN`, the **offline link-cleanup wiring** (`HtmlLength` stays the original
  body length, `CleanText` is decoded + utm-stripped, the per-run `Links:` metric is
  logged), the **table-wrapper unwrap wiring** (wrappers collapse out of `CleanText`,
  `HtmlLength` stays original, the per-email and per-run `Unwrap:` metrics log in real AND
  `DRY_RUN` runs), and the **footer-cutoff wiring** (a mapped sender's footer is cut from
  `CleanText`, the per-email + per-run `Footer:` metrics log in real AND `DRY_RUN`; a marker
  **miss** ends a real run by throwing after the summary but a `DRY_RUN` run never throws; and
  when an upsert failure co-occurs with a **committed** miss, one thrown error carries both —
  the upsert failure named first, the footer-miss summary folded in, so the alarm is never lost
  (**F1**)). Each guard is mutation-checked — removing the budget break, the make-collected
  branch, the individual-retry isolation branch, the `≥1 healthy sibling` quarantine guard,
  the `isTransientWriteFailure_` `5xx` arm, the per-sub-batch (vs per-record) failure count,
  the narrowed token-error catch, either fail-loudly throw, the `. Also …` miss fold, the
  empty-records guard, the clamp, or any cleaning-stage wiring flips an assertion.
- **`purge.test.js`** — the RawEmails purge job: pure helpers
  (`resolvePurgeThresholds_` — HIGH>LOW coherence with both-defaults fallback,
  `buildPurgePlan_` — at-high no-op / down-to-low / eligible-capped boundaries,
  `chunk_` — the 10-records-per-DELETE REST cap, `purgeEligibilityFormula_` — the
  Processed-only + min-age guard pinned **verbatim**), plus an integration pass over
  `purgeRawEmailsLocked_` with a paginating Airtable stub: oldest-first deletes down to
  low-water, the exact `filterByFormula` + `sort` in the outgoing request (so
  `Status='New'` rows structurally cannot be deleted), the count≤high no-op
  (mutation-checked with eligible rows present), the starvation warning vs the
  `PURGE_EMERGENCY` throw (949/950 boundary), `DRY_RUN` (full plan logged, nothing
  deleted), runtime-tunable thresholds, and fail-loud non-200 list/delete throws.

## Not covered (deliberately)

- The `LockService` single-flight guards (`collectJobEmails` and `purgeRawEmails`
  wrappers) — left to manual / live verification (pure side effect around the
  locked runs).
- The inner per-label granularity (a sub-batch already in flight is not interrupted
  mid-label) — an accepted, idempotency-bounded limit, not a unit concern. Full
  modularization for deeper testability is tracked in `TODO.md` ("Modularize for
  testability").
