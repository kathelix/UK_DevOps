'use strict';

// Coverage for the reliability-net slice (branch collector/reliability-net):
//   isOverRuntimeBudget_     -> the timeout-safety boundary
//   isTransientWriteFailure_ -> the transient(429/5xx)-vs-deterministic-4xx write classifier
//   buildUpsertPayload_      -> the Airtable upsert request body (dedupe contract)
//   airtableUpsert_          -> that the write is a PATCH upsert and returns the HTTP code
//
// The LockService single-flight guard is intentionally not unit-tested here: it is
// pure side effect around the unchanged batch loop and would need the whole run
// mocked. It is covered by manual / live runs (see PR #2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

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
  assert.throws(() => gas.airtableUpsert_([{ fields: {} }]), /AIRTABLE_TOKEN is not set/);
});
