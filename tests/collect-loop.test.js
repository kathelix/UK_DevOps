'use strict';

// Integration coverage for the sub-batch pipeline in collectJobEmailsLocked_.
//
// The run processes the queue in sub-batches of CONFIG.SUB_BATCH_SIZE, each doing
// fetch -> upsert -> label and committed before the next, with a single budget guard
// at the top of the loop. These tests drive the whole run with stubbed Apps Script
// globals and an injected clock (advanced per Gmail get(), modelling fetch latency).
//
// They pin the load-bearing invariants a unit test of isOverRuntimeBudget_ cannot:
//   - forward progress (an over-budget run still commits the first sub-batch);
//   - "label make-collected ONLY if the upsert succeeded" (no silent data loss);
//   - poison isolation (one bad message is make-failed, siblings still collected);
//   - the SUB_BATCH_SIZE clamp (an out-of-range knob can't 422 or stall the loop).
// Each is mutation-checked: removing the guarded behaviour flips an assertion.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

const RealDate = Date;
const SUB_BATCH = 5;
const L_COLLECTED = 'L_COLLECTED';
const L_FAILED = 'L_FAILED';

function makeClock() {
  const c = { t: 0 };
  const FakeDate = function (...args) { return args.length ? new RealDate(...args) : new RealDate(0); };
  FakeDate.now = () => c.t;
  FakeDate.prototype = RealDate.prototype;
  c.Date = FakeDate;
  c.advance = (d) => { c.t += d; };
  return c;
}

function fakeMessage(i) {
  return {
    id: 'm' + i, threadId: 't' + i, internalDate: '1700000000000', snippet: 's' + i, labelIds: [],
    payload: {
      headers: [{ name: 'From', value: 'Sender ' + i + ' <s' + i + '@x.com>' }, { name: 'Subject', value: 'Subj ' + i }],
      mimeType: 'text/html',
      body: { data: Array.from(Buffer.from('<html><body>hi' + i + '</body></html>', 'utf8')) },
    },
  };
}

// A message whose body.data is an undecodable base64 string -> decodeB64Url_ throws ->
// processMessage_ throws -> the loop's catch labels it make-failed (poison isolation).
function poisonMessage(i) {
  const m = fakeMessage(i);
  m.payload.body = { data: '!!!! not base64 !!!!' };
  return m;
}

// Drive one collector run. getDelta is the per-message fetch cost added to the clock;
// upsertCode(callIndex) lets a test force a non-200 Airtable response per request.
function runCollector({ n, budgetMs, getDelta, dryRun = false, subBatch = SUB_BATCH, poison = [], upsertCode = () => 200 }) {
  const gas = loadCollector();
  const clock = makeClock();
  const messages = Array.from({ length: n }, (_, i) => (poison.includes(i) ? poisonMessage(i) : fakeMessage(i)));
  const labelCalls = []; // { id, label }
  const upserts = [];     // { count, code }

  gas.CONFIG.MAX_RUNTIME_MS = budgetMs;
  gas.CONFIG.SUB_BATCH_SIZE = subBatch;
  gas.setGlobals({
    Date: clock.Date,
    Gmail: {
      Users: {
        Messages: {
          list: () => ({ messages: messages.map(m => ({ id: m.id })) }),
          get: (_user, id) => { clock.advance(getDelta); return messages.find(m => m.id === id); },
          modify: (body, _user, id) => { labelCalls.push({ id, label: body.addLabelIds[0] }); },
        },
        Labels: {
          list: () => ({ labels: [
            { id: L_COLLECTED, name: 'job-vacancies/make-collected', type: 'user' },
            { id: L_FAILED, name: 'job-vacancies/make-failed', type: 'user' },
          ] }),
          create: (body) => ({ id: 'L_CREATED', name: body.name }),
        },
      },
    },
    UrlFetchApp: {
      fetch: (_url, opts) => {
        const recs = JSON.parse(opts.payload).records;
        // Airtable rejects > 10 records/request (422); otherwise honour the test's code.
        const code = recs.length > 10 ? 422 : upsertCode(upserts.length);
        upserts.push({ count: recs.length, code });
        return { getResponseCode: () => code, getContentText: () => (code === 200 ? '' : 'ERR ' + code) };
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'DRY_RUN' ? (dryRun ? 'true' : null) : k === 'AIRTABLE_TOKEN' ? 'tok' : null) }) },
    Utilities: {
      getUuid: () => 'uuid-test',
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    },
  });

  gas.collectJobEmailsLocked_();

  const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };
  return {
    collected: labelCalls.filter(c => c.label === L_COLLECTED).map(c => c.id),
    failed: labelCalls.filter(c => c.label === L_FAILED).map(c => c.id),
    upserts,
    logs: gas.logs.map(fmt),
  };
}

test('under budget: every message is upserted then labelled, in sub-batches', () => {
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1 });
  assert.equal(r.collected.length, 12, 'all 12 labelled make-collected');
  assert.equal(r.upserts.length, 3, '12 messages / sub-batch 5 => 3 upserts (5 + 5 + 2)');
  assert.ok(r.logs.some(l => l.includes('Collected 12 of 12')), 'collected summary present');
});

test('forward progress: over budget after the first sub-batch still commits that sub-batch', () => {
  // budget=100, getDelta=25: sub-batch 0's check sees 0 (runs); its 5 gets push the
  // clock to 125, so sub-batch 1's check (125 > 100) breaks. Exactly one sub-batch
  // commits — never zero (the old two-phase design could defer all), never all 12.
  const r = runCollector({ n: 12, budgetMs: 100, getDelta: 25 });
  assert.equal(r.collected.length, SUB_BATCH, 'first sub-batch (5) committed despite the budget');
  assert.equal(r.upserts.length, 1, 'one sub-batch upserted');
  assert.ok(r.logs.some(l => /deferring 7 message\(s\)/.test(l)), 'remaining 7 deferred to next run');
});

test('incremental commit: over budget mid-run keeps earlier sub-batches committed', () => {
  // budget=100, getDelta=11: checks see 0, 55 (both run), then 110 > 100 => break.
  const r = runCollector({ n: 12, budgetMs: 100, getDelta: 11 });
  assert.equal(r.collected.length, 2 * SUB_BATCH, 'first two sub-batches (10) committed');
  assert.equal(r.upserts.length, 2, 'two sub-batches upserted');
  assert.ok(r.logs.some(l => /deferring 2 message\(s\)/.test(l)), 'remaining 2 deferred');
});

test('upsert failure: a sub-batch whose upsert is rejected is NOT labelled (no silent data loss)', () => {
  // 422 on the FIRST sub-batch only; the rest succeed. The PR's core invariant is
  // "label make-collected ONLY if the upsert succeeded" — mislabelling the failed
  // batch would drop never-written rows forever (QUERY excludes make-collected).
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode: (i) => (i === 0 ? 422 : 200) });
  assert.equal(r.collected.length, 7, 'only the 7 successfully-upserted messages are make-collected');
  for (const id of ['m0', 'm1', 'm2', 'm3', 'm4']) {
    assert.ok(!r.collected.includes(id), `${id} (its upsert 422'd) must NOT be make-collected`);
  }
  assert.ok(r.logs.some(l => /Airtable upsert FAILED for sub-batch starting at 0/.test(l)), 'failure logged');
  assert.ok(r.logs.some(l => l.includes('Collected 7 of 12')), 'summary counts only the committed');
});

test('poison isolation: a bad message is make-failed while its siblings are make-collected', () => {
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, poison: [2] });
  assert.deepEqual(r.failed, ['m2'], 'only the poison message is make-failed');
  assert.equal(r.collected.length, 4, 'the 4 well-formed siblings are collected');
  assert.ok(!r.collected.includes('m2'), 'poison message is not make-collected');
  assert.ok(r.logs.some(l => l.includes('Collected 4 of 5')));
});

test('all-poison sub-batch: no empty Airtable upsert is sent', () => {
  // Pins the `if (records.length === 0) continue` guard: without it an all-failed
  // sub-batch would fire an upsert with an empty records array.
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, poison: [0, 1, 2, 3, 4] });
  assert.equal(r.failed.length, 5, 'all 5 make-failed');
  assert.equal(r.collected.length, 0, 'none collected');
  assert.equal(r.upserts.length, 0, 'no upsert request sent for an all-failed sub-batch');
});

test('SUB_BATCH_SIZE > 10 is clamped to 10 (no oversized upsert, no 422 livelock)', () => {
  // Without the clamp this sends a 12-record PATCH -> 422 -> 0 committed -> re-fetch
  // forever. The clamp keeps every request within Airtable's 10-record cap.
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, subBatch: 25 });
  assert.equal(r.collected.length, 12, 'all collected despite the out-of-range config');
  assert.ok(r.upserts.every(u => u.count <= 10), 'no upsert exceeds Airtable\'s 10-record cap');
  assert.ok(r.upserts.every(u => u.code === 200), 'no request is rejected');
  assert.ok(r.logs.some(l => /SUB_BATCH_SIZE=25 is out of range \[1,10\]; using 10/.test(l)), 'out-of-range config logged');
});

test('DRY_RUN: inspects every sub-batch but writes and labels nothing', () => {
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, dryRun: true });
  assert.equal(r.collected.length, 0, 'nothing labelled');
  assert.equal(r.upserts.length, 0, 'nothing upserted');
  assert.ok(r.logs.some(l => /DRY_RUN complete: 12 message\(s\) inspected/.test(l)), 'dry-run summary present');
});
