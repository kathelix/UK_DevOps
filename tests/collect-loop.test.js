'use strict';

// Integration coverage for the sub-batch pipeline in collectJobEmailsLocked_.
//
// The run processes the queue in sub-batches of CONFIG.SUB_BATCH_SIZE, each doing
// fetch -> upsert -> label and committed before the next, with a single budget guard
// at the top of the loop. These tests drive the whole run with stubbed Apps Script
// globals and an injected clock (advanced per Gmail get(), modelling fetch latency).
//
// The headline property is FORWARD PROGRESS: because the first sub-batch effectively
// always runs, an over-budget run still commits at least one sub-batch rather than
// deferring everything (the livelock the two-phase design could hit). A unit test of
// isOverRuntimeBudget_ does not prove this — deleting the loop's `break` is caught
// here (mutation-checked: removing it makes the over-budget tests label all 12).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

const RealDate = Date;
const SUB_BATCH = 5;

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

// Drive one collector run; getDelta is the per-message fetch cost added to the clock.
function runCollector({ n, budgetMs, getDelta, dryRun = false }) {
  const gas = loadCollector();
  const clock = makeClock();
  const messages = Array.from({ length: n }, (_, i) => fakeMessage(i));
  const labelled = [];   // ids that got make-collected
  const upserts = [];    // Airtable upsert requests

  gas.CONFIG.MAX_RUNTIME_MS = budgetMs;
  gas.CONFIG.SUB_BATCH_SIZE = SUB_BATCH;
  gas.setGlobals({
    Date: clock.Date,
    Gmail: {
      Users: {
        Messages: {
          list: () => ({ messages: messages.map(m => ({ id: m.id })) }),
          get: (_user, id) => { clock.advance(getDelta); return messages.find(m => m.id === id); },
          modify: (_body, _user, id) => { labelled.push(id); },
        },
        Labels: {
          list: () => ({ labels: [{ id: 'L_COLLECTED', name: 'job-vacancies/make-collected', type: 'user' }] }),
          create: (body) => ({ id: 'L_NEW', name: body.name }),
        },
      },
    },
    UrlFetchApp: { fetch: (url, opts) => { upserts.push({ url, opts }); return { getResponseCode: () => 200, getContentText: () => '' }; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'DRY_RUN' ? (dryRun ? 'true' : null) : k === 'AIRTABLE_TOKEN' ? 'tok' : null) }) },
    Utilities: {
      getUuid: () => 'uuid-test',
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    },
  });

  gas.collectJobEmailsLocked_();

  const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };
  return { labelled, upserts, logs: gas.logs.map(fmt) };
}

test('under budget: every message is upserted then labelled, in sub-batches', () => {
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1 });
  assert.equal(r.labelled.length, 12, 'all 12 labelled make-collected');
  assert.equal(r.upserts.length, 3, '12 messages / sub-batch 5 => 3 upserts (5 + 5 + 2)');
  assert.equal(r.upserts[0].opts.method, 'patch', 'each write is a PATCH upsert');
  assert.ok(r.logs.some(l => l.includes('Collected 12 of 12')), 'collected summary present');
});

test('forward progress: over budget after the first sub-batch still commits that sub-batch', () => {
  // budget=100, getDelta=25: sub-batch 0's check sees 0 (runs); its 5 gets push the
  // clock to 125, so sub-batch 1's check (125 > 100) breaks. Exactly one sub-batch
  // commits — never zero (the old two-phase design could defer all), never all 12.
  const r = runCollector({ n: 12, budgetMs: 100, getDelta: 25 });
  assert.equal(r.labelled.length, SUB_BATCH, 'first sub-batch (5) committed despite the budget');
  assert.equal(r.upserts.length, 1, 'one sub-batch upserted');
  assert.ok(r.logs.some(l => /deferring 7 message\(s\)/.test(l)), 'remaining 7 deferred to next run');
});

test('incremental commit: over budget mid-run keeps earlier sub-batches committed', () => {
  // budget=100, getDelta=11: checks see 0, 55 (both run), then 110 > 100 => break.
  const r = runCollector({ n: 12, budgetMs: 100, getDelta: 11 });
  assert.equal(r.labelled.length, 2 * SUB_BATCH, 'first two sub-batches (10) committed');
  assert.equal(r.upserts.length, 2, 'two sub-batches upserted');
  assert.ok(r.logs.some(l => /deferring 2 message\(s\)/.test(l)), 'remaining 2 deferred');
});

test('DRY_RUN: inspects every sub-batch but writes and labels nothing', () => {
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, dryRun: true });
  assert.equal(r.labelled.length, 0, 'nothing labelled');
  assert.equal(r.upserts.length, 0, 'nothing upserted');
  assert.ok(r.logs.some(l => /DRY_RUN complete: 12 message\(s\) inspected/.test(l)), 'dry-run summary present');
});
