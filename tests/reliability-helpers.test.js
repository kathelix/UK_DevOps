'use strict';

// Coverage for the reliability-net slice (branch collector/reliability-net):
//   isOverRuntimeBudget_ -> the timeout-safety boundary
//   buildUpsertPayload_  -> the Airtable upsert request body (dedupe contract)
//   airtableUpsert_      -> that the write is a PATCH upsert and maps status->bool
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

test('airtableUpsert_ issues a PATCH upsert and maps a 200 to true', () => {
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

  const ok = gas.airtableUpsert_([{ fields: { MessageId: 'm1' } }]);

  assert.equal(ok, true);
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

test('airtableUpsert_ returns false on a non-200 (batch stays uncollected, retried next run)', () => {
  const gas = loadCollector();
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'tok' }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 422, getContentText: () => 'unprocessable' }) },
  });
  assert.equal(gas.airtableUpsert_([{ fields: {} }]), false);
});

test('airtableUpsert_ throws when AIRTABLE_TOKEN is unset (fail loud, no silent skip)', () => {
  const gas = loadCollector();
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  });
  assert.throws(() => gas.airtableUpsert_([{ fields: {} }]), /AIRTABLE_TOKEN is not set/);
});
