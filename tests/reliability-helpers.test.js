'use strict';

// Coverage for the reliability-net slice (branch collector/reliability-net):
//   isOverRuntimeBudget_     -> the timeout-safety boundary
//   isTransientWriteFailure_ -> the transient(429/5xx)-vs-deterministic-4xx write classifier
//   buildUpsertPayload_      -> the Airtable upsert request body (dedupe contract)
//   airtableUpsert_          -> that the write is a PATCH upsert and returns the HTTP code
//   airtableFetchWithRetry_  -> the transient-retry/backoff wrapper (429/5xx/transport throw with
//                               [1s,2s,4s] backoff; 200 + deterministic 4xx pass through; the
//                               budget guard; retryOnThrow:false for the non-idempotent DELETE)
//
// The LockService single-flight guard is intentionally not unit-tested here: it is
// pure side effect around the unchanged batch loop and would need the whole run
// mocked. It is covered by manual / live runs (see PR #2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

// A UrlFetchApp.fetch stub driven by a script: each entry is either an HTTP status code (returns
// a response with that code) or the string 'throw' (throws a transport exception). The last entry
// repeats if the wrapper calls more times than the script length. `calls.n` records attempts.
function scriptedFetch(script) {
  const calls = { n: 0 };
  const fetch = () => {
    const step = script[Math.min(calls.n, script.length - 1)];
    calls.n++;
    if (step === 'throw') throw new Error('connection reset #' + calls.n);
    return { getResponseCode: () => step, getContentText: () => 'body-' + step };
  };
  return { fetch, calls };
}

test('isOverRuntimeBudget_ is true only after the budget is exceeded (strict >)', () => {
  const { isOverRuntimeBudget_, CONFIG } = loadCollector();
  const budget = CONFIG.MAX_RUNTIME_MS; // 300000 ms / 5 min
  const start = 1_000_000;              // arbitrary clock anchor
  assert.equal(isOverRuntimeBudget_(start, start), false);              // 0 elapsed
  assert.equal(isOverRuntimeBudget_(start, start + budget - 1), false);
  assert.equal(isOverRuntimeBudget_(start, start + budget), false);     // exactly at budget: not yet over
  assert.equal(isOverRuntimeBudget_(start, start + budget + 1), true);  // 1 ms over
});

test('isTransientWriteFailure_ classifies 429/5xx as transient, deterministic 4xx as not', () => {
  const { isTransientWriteFailure_ } = loadCollector();
  // Transient (retry-worthy): rate limit + any server-side outage.
  for (const code of [429, 500, 502, 503]) {
    assert.equal(isTransientWriteFailure_(code), true, `${code} is transient (retry next run)`);
  }
  // Deterministic rejects: a record/auth/endpoint/schema problem the loop isolates, never retries blindly.
  for (const code of [400, 401, 404, 422]) {
    assert.equal(isTransientWriteFailure_(code), false, `${code} is a deterministic reject (poison candidate)`);
  }
  // Mutation guards: success and the 5xx range boundaries are NOT transient — a mutation that
  // widened the predicate (e.g. >=400, or dropped the 429 special-case, or used >=500 with no
  // upper bound) flips one of these.
  assert.equal(isTransientWriteFailure_(200), false, '200 is success, not a transient failure');
  assert.equal(isTransientWriteFailure_(428), false, 'just below 429 is not transient');
  assert.equal(isTransientWriteFailure_(499), false, 'just below the 5xx band is not transient');
  assert.equal(isTransientWriteFailure_(500), true, 'low edge of the 5xx band is transient');
  assert.equal(isTransientWriteFailure_(599), true, 'high edge of the 5xx band is transient');
  assert.equal(isTransientWriteFailure_(600), false, 'above the 5xx band is not transient');
});

test('clampSubBatchSize_ keeps the sub-batch stride in [1, 10]', () => {
  const { clampSubBatchSize_ } = loadCollector();
  assert.equal(clampSubBatchSize_(5), 5);    // shipped value, untouched
  assert.equal(clampSubBatchSize_(1), 1);
  assert.equal(clampSubBatchSize_(10), 10);  // Airtable's records/request cap (boundary)
  assert.equal(clampSubBatchSize_(0), 1);    // a 0 stride would never advance the loop
  assert.equal(clampSubBatchSize_(-3), 1);
  assert.equal(clampSubBatchSize_(25), 10);  // >10 would 422 the oversized upsert
});

test('buildUpsertPayload_ pins the upsert contract (merge on MessageId, typecast, passthrough)', () => {
  const { buildUpsertPayload_, CONFIG } = loadCollector();
  const records = [{ fields: { MessageId: 'm1' } }, { fields: { MessageId: 'm2' } }];
  const body = buildUpsertPayload_(records);

  // Leaf asserts (body is a VM-realm object — avoid deepStrictEqual against literals).
  assert.equal(CONFIG.DEDUPE_FIELD, 'MessageId');                  // the dedupe field...
  assert.equal(body.performUpsert.fieldsToMergeOn.length, 1);      // ...is the only merge key
  assert.equal(body.performUpsert.fieldsToMergeOn[0], 'MessageId');
  assert.equal(body.typecast, true);
  assert.equal(body.records, records);                            // records passed through unchanged
  // Object.keys() returns a Node-realm array, so deepEqual is safe here.
  assert.deepEqual(Object.keys(body), ['performUpsert', 'records', 'typecast']);
});

test('airtableUpsert_ issues a PATCH upsert and returns the 200 status code', () => {
  const gas = loadCollector();
  const calls = [];
  gas.setGlobals({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k === 'AIRTABLE_TOKEN' ? 'tok_test' : null) }),
    },
    UrlFetchApp: {
      fetch(url, opts) {
        calls.push({ url, opts });
        return { getResponseCode: () => 200, getContentText: () => '' };
      },
    },
  });

  const code = gas.airtableUpsert_([{ fields: { MessageId: 'm1' } }]);

  assert.equal(code, 200); // numeric HTTP code, not a boolean — the caller branches poison vs transient on it
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.match(url, /\/v0\/appV9puNHinuRKTk9\/RawEmails$/); // base id + URL-encoded table name
  assert.equal(opts.method, 'patch');                       // upsert is PATCH, not POST — the dedupe fix
  assert.equal(opts.muteHttpExceptions, true);
  assert.equal(opts.headers.Authorization, 'Bearer tok_test');
  // opts.payload is a string; JSON.parse yields a Node-realm object (deepEqual safe).
  const body = JSON.parse(opts.payload);
  assert.deepEqual(body.performUpsert.fieldsToMergeOn, ['MessageId']);
  assert.equal(body.typecast, true);
});

test('airtableUpsert_ returns the non-200 code and captures the first error into failures', () => {
  const gas = loadCollector();
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'tok' }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 422, getContentText: () => 'unprocessable' }) },
  });
  const failures = { count: 0, first: '' };
  assert.equal(gas.airtableUpsert_([{ fields: {} }], failures), 422); // the numeric code, so the caller can classify it
  assert.equal(failures.count, 1);
  assert.equal(failures.first, '422: unprocessable'); // '<code>: <body>' preserved for the fail-loud summary
});

test('airtableUpsert_ throws when AIRTABLE_TOKEN is unset (fail loud, no silent skip)', () => {
  const gas = loadCollector();
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  });
  // The token is resolved BEFORE the fetch try, so a missing token fails fast with its own
  // error — it is NOT caught and mapped to the transport sentinel (Codex F-P2).
  assert.throws(() => gas.airtableUpsert_([{ fields: {} }]), /AIRTABLE_TOKEN is not set/);
});

test('airtableUpsert_ retries a transport throw, then maps the FINAL throw to code 0 (transient, not a crash)', () => {
  const gas = loadCollector();
  let calls = 0;
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'tok' }) },
    UrlFetchApp: { fetch: () => { calls++; throw new Error('Address unavailable'); } },
  });
  const failures = { count: 0, first: '' };
  // A network/transport failure (fetch itself throws — NOT an HTTP error response) is retried by
  // airtableFetchWithRetry_; after every attempt throws it re-throws the last error, which
  // airtableUpsert_'s narrow catch maps to code 0 so the caller classifies it transient. The
  // token being present, this throw is the only thing the catch swallows. Inject a no-op sleep so
  // the backoff doesn't real-sleep in CI.
  assert.equal(gas.airtableUpsert_([{ fields: {} }], failures, { sleep: () => {} }), 0);
  assert.equal(calls, 4, '4 attempts (1 + 3 retries) before giving up on the persistent transport failure');
  assert.equal(failures.count, 1, 'recorded once for the final outcome, not once per retry');
  assert.match(failures.first, /^network error: Address unavailable$/);
});

// ---------- airtableFetchWithRetry_ (the transient-retry/backoff wrapper) ----------
// Every test injects fetch + a recording sleep, so the backoff schedule is asserted without any
// real sleep. The default backoff is CONFIG.RETRY_BACKOFF_MS; asserting the recorded sleeps also
// pins that schedule. (sleeps is a Node-realm array of primitive ms — deepEqual is realm-safe.)

test('airtableFetchWithRetry_: 429 then 200 -> one retry, returns 200, sleeps [1000]', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([429, 200]);
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) });
  assert.equal(resp.getResponseCode(), 200, 'the retry recovered the blip');
  assert.equal(calls.n, 2, 'one retry after the 429');
  assert.deepEqual(sleeps, [1000], 'one backoff sleep (first step of the schedule)');
});

test('airtableFetchWithRetry_: 503 x4 -> 3 retries then returns the last 503, sleeps [1000,2000,4000]', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([503]); // repeats forever
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) });
  assert.equal(resp.getResponseCode(), 503, 'gave up and handed back the last transient response');
  assert.equal(calls.n, 4, '4 attempts = 1 + 3 retries');
  assert.deepEqual(sleeps, [1000, 2000, 4000], 'the full backoff schedule, in order');
});

test('airtableFetchWithRetry_: 422 -> no retry, returns immediately, sleeps []', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([422, 200]); // a 200 is queued but must never be reached
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) });
  assert.equal(resp.getResponseCode(), 422, 'a deterministic 4xx passes straight through');
  assert.equal(calls.n, 1, 'never retried — retrying a validation/auth reject only burns budget');
  assert.deepEqual(sleeps, []);
});

test('airtableFetchWithRetry_: 200 -> no retry, sleeps []', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([200]);
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) });
  assert.equal(resp.getResponseCode(), 200);
  assert.equal(calls.n, 1);
  assert.deepEqual(sleeps, []);
});

test('airtableFetchWithRetry_: transport-throw then 200 -> retried, returns 200', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch(['throw', 200]);
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) });
  assert.equal(resp.getResponseCode(), 200, 'a transport blip is transient and recovers on retry');
  assert.equal(calls.n, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('airtableFetchWithRetry_: every attempt throws -> re-throws the LAST transport error', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch(['throw']); // always throws, no response ever obtained
  const sleeps = [];
  assert.throws(
    () => airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms) }),
    /connection reset #4/, // the 4th attempt's error is the one surfaced
  );
  assert.equal(calls.n, 4, '4 attempts, all threw');
  assert.deepEqual(sleeps, [1000, 2000, 4000], 'slept between every attempt');
});

test('airtableFetchWithRetry_ budget guard: a clock past budget returns the last code WITHOUT sleeping (mutation: drop the guard -> it sleeps)', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([429]); // would retry to exhaustion without the guard
  const sleeps = [];
  // isOverBudget always true: the next sleep would cross MAX_RUNTIME_MS, so the wrapper stops.
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms), isOverBudget: () => true });
  assert.equal(resp.getResponseCode(), 429, 'hands back the last transient code rather than sleep past the budget');
  assert.equal(calls.n, 1, 'no retry once the budget guard trips');
  assert.deepEqual(sleeps, [], 'NEVER slept — removing the budget check flips this to [1000,2000,4000]');
});

test('airtableFetchWithRetry_ budget guard mirrors the collector wiring (now+nextSleep vs MAX_RUNTIME_MS)', () => {
  // Pins the exact predicate the collector threads: isOverRuntimeBudget_(startMs, now()+ms). With
  // the clock 100ms below budget, the next 1000ms backoff WOULD cross it, so no sleep happens —
  // proving the guard accounts for the prospective sleep, not just "are we already over".
  const { airtableFetchWithRetry_, isOverRuntimeBudget_, CONFIG } = loadCollector();
  const { fetch, calls } = scriptedFetch([429]);
  const sleeps = [];
  const startMs = 0;
  const nowMs = CONFIG.MAX_RUNTIME_MS - 100; // under budget now, but a 1000ms sleep crosses it
  const isOverBudget = (ms) => isOverRuntimeBudget_(startMs, nowMs + ms);
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms), isOverBudget });
  assert.equal(resp.getResponseCode(), 429);
  assert.equal(calls.n, 1);
  assert.deepEqual(sleeps, [], 'the prospective sleep would cross the 5-min budget, so it does not sleep');
});

test('airtableFetchWithRetry_ retryOnThrow:false (DELETE) — a transport throw propagates on attempt 1, never retried', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch(['throw', 200]); // would recover IF it retried — it must not
  const sleeps = [];
  assert.throws(
    () => airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms), retryOnThrow: false }),
    /connection reset/,
    'DELETE is not idempotent: a re-delete of an already-gone id 404s, so a transport throw must not retry',
  );
  assert.equal(calls.n, 1, 'no retry — the throw surfaces immediately (pre-wrapper DELETE behaviour)');
  assert.deepEqual(sleeps, []);
});

test('airtableFetchWithRetry_ retryOnThrow:false still retries 429/5xx (a server reject removed nothing)', () => {
  const { airtableFetchWithRetry_ } = loadCollector();
  const { fetch, calls } = scriptedFetch([429, 200]);
  const sleeps = [];
  const resp = airtableFetchWithRetry_('u', {}, { fetch, sleep: (ms) => sleeps.push(ms), retryOnThrow: false });
  assert.equal(resp.getResponseCode(), 200, 'a 429 is safe to retry even for DELETE — the delete did not apply');
  assert.equal(calls.n, 2);
  assert.deepEqual(sleeps, [1000]);
});
