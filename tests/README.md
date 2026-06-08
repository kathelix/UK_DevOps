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
  `buildUpsertPayload_` and `airtableUpsert_` (the PATCH-upsert dedupe contract).
- **`collect-loop.test.js`** — integration: drives `collectJobEmailsLocked_` with
  stubbed Apps Script globals and an injected clock, exercising both timeout
  `break`s end to end (fetch-phase and write/label-phase deferral) plus the happy
  path. A unit test of `isOverRuntimeBudget_` alone leaves the `break` that calls it
  untested — these tests fail if either break is removed (mutation-checked).

## Not covered (deliberately)

- The `LockService` single-flight guard and the `DRY_RUN` path — left to manual /
  live verification (the guard is a pure side effect around the run).
- The inner per-label budget granularity (a batch already in flight is not
  interrupted mid-label) — an accepted, idempotency-bounded limit, not a unit
  concern. Full modularization for deeper testability is tracked in `TODO.md`
  ("Modularize for testability").
