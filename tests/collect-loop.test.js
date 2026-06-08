'use strict';

// Integration coverage for the timeout-safety BREAKS in collectJobEmailsLocked_.
//
// The reliability-helpers tests pin isOverRuntimeBudget_ as a pure predicate, but a
// green predicate test does NOT prove the loop actually breaks: deleting either
// `break` left `node --test` green (confirmed by mutation). These tests drive the
// whole run with stubbed Apps Script globals and an injected, monotonic clock so the
// fetch-loop and write/label-loop budget guards are exercised end to end.
//
// The clock advances by `getDelta` on each Gmail get() (the per-message fetch cost);
// CONFIG.MAX_RUNTIME_MS is lowered per-scenario. Because the budget check sits at the
// TOP of each loop iteration, scenarios are tuned so the guard trips at a known point.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

const RealDate = Date;

// A controllable clock: Date.now() reads a mutable counter; new Date(...) still works
// (for collectedAt / EmailDate). Only Gmail.get advances it, modelling fetch latency.
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

// Drive one collector run; return observable side effects.
function runCollector({ n, budgetMs, getDelta }) {
  const gas = loadCollector();
  const clock = makeClock();
  const messages = Array.from({ length: n }, (_, i) => fakeMessage(i));
  const labelled = [];   // message ids that got make-collected
  const upserts = [];    // Airtable upsert requests

  gas.CONFIG.MAX_RUNTIME_MS = budgetMs;
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'AIRTABLE_TOKEN' ? 'tok' : null) }) },
    Utilities: {
      getUuid: () => 'uuid-test',
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    },
  });

  gas.collectJobEmailsLocked_();

  // Render Logger.log's printf-style entries (template + %s args) to plain strings.
  const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };
  return { labelled, upserts, logs: gas.logs.map(fmt) };
}

test('under budget: every fetched message is upserted then labelled', () => {
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1 });
  assert.equal(r.labelled.length, 12, 'all 12 messages labelled make-collected');
  assert.equal(r.upserts.length, 2, '12 records => 2 Airtable batches (10 + 2)');
  assert.equal(r.upserts[0].opts.method, 'patch', 'write is a PATCH upsert');
  assert.ok(r.logs.some(l => l.includes('Collected 12 of 12')), 'collected log present');
});

test('write/label phase honours the budget: over budget at write => defer all, label none', () => {
  // n=11, budget=100, getDelta=10: fetch checks see 0..100 (all pass; strict >), the
  // 11th get pushes the clock to 110, so the write loop's first check (110 > 100) breaks.
  const r = runCollector({ n: 11, budgetMs: 100, getDelta: 10 });
  assert.equal(r.labelled.length, 0, 'no message labelled (whole batch deferred)');
  assert.equal(r.upserts.length, 0, 'no Airtable write started');
  assert.ok(r.logs.some(l => /exceeded before write; deferring 11 record\(s\)/.test(l)), 'write-phase deferral logged');
  assert.ok(!r.logs.some(l => /remaining message/.test(l)), 'fetch loop did not break (it completed)');
  // The 11 records keep no make-collected label, so the next run re-collects them;
  // the MessageId upsert makes those re-writes idempotent (no duplicate rows).
});

test('fetch phase honours the budget: trips mid-fetch and defers the remainder', () => {
  // n=10, budget=100, getDelta=40: check at i=3 sees 120 > 100 => break, 7 deferred.
  const r = runCollector({ n: 10, budgetMs: 100, getDelta: 40 });
  assert.ok(r.logs.some(l => /deferring 7 remaining message\(s\)/.test(l)), 'fetch-phase deferral of 7 logged');
});
