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
//   - read-side poison isolation (a parse-error message is make-failed, siblings still collected);
//   - write-side poison isolation (a deterministic-4xx record is isolated per-record and
//     make-failed only with a healthy sibling; a transient 429/5xx is left to retry, never
//     make-failed; a systemic all-4xx sub-batch quarantines nothing and fails loud);
//   - the SUB_BATCH_SIZE clamp (an out-of-range knob can't 422 or stall the loop);
//   - the offline link-cleanup wiring (HtmlLength stays original, CleanText is cleaned,
//     the per-run "Links:" metric is logged);
//   - the table-wrapper unwrap wiring (wrappers collapse out of CleanText, the per-email
//     and per-run "Unwrap:" metrics log in real AND DRY_RUN runs);
//   - the footer-cutoff wiring (a mapped sender's footer is cut from CleanText, the per-email
//     and per-run "Footer:" metrics log in real AND DRY_RUN; a MISS ends a real run Failed but
//     a DRY_RUN run never throws; when an upsert failure co-occurs, its error is named first AND
//     the footer-miss summary is folded into the same throw so the alarm is never lost — F1).
// Each is mutation-checked: removing the guarded behaviour flips an assertion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
// upsertCode(callIndex, records) lets a test force a non-200 Airtable response per request.
// The second arg is the parsed records of THIS PATCH, so a write-poison test can branch on
// recs.length (a batch PATCH vs a single-record isolation retry) and on the MessageId, e.g.
//   upsertCode: (i, recs) => recs.length > 1 ? 422 : (recs[0].fields.MessageId === 'm2' ? 422 : 200)
// expectThrow: true captures a thrown run-ending error into r.threw (the fail-loudly
// contract); without it any throw propagates and fails the calling test.
// fetchThrows(callIndex, records) → truthy makes UrlFetchApp.fetch THROW (a transport failure,
// not an HTTP error response). airtableToken: null simulates a missing AIRTABLE_TOKEN Script
// Property (a config error that must fail the run fast, not be masked transient).
function runCollector({ n, budgetMs, getDelta, dryRun = false, subBatch = SUB_BATCH, poison = [], upsertCode = () => 200, fetchThrows = () => false, airtableToken = 'tok', bodyHtml = null, from = null, expectThrow = false, backoffMs = null }) {
  const gas = loadCollector();
  const clock = makeClock();
  const messages = Array.from({ length: n }, (_, i) => {
    if (poison.includes(i)) return poisonMessage(i);
    const m = fakeMessage(i);
    // Override the From header (default sender is sN@x.com, an unmapped domain) so a test can
    // drive a FOOTER_MARKERS-mapped sender through the footer-cutoff stage.
    if (from) m.payload.headers = [{ name: 'From', value: from(i) }, { name: 'Subject', value: 'Subj ' + i }];
    if (bodyHtml) m.payload.body = { data: Array.from(Buffer.from(bodyHtml(i), 'utf8')) };
    return m;
  });
  const labelCalls = []; // { id, label }
  const upserts = [];     // { count, code }

  gas.CONFIG.MAX_RUNTIME_MS = budgetMs;
  gas.CONFIG.SUB_BATCH_SIZE = subBatch;
  // backoffMs: override the retry schedule. [] disables retries (the wrapper makes one attempt),
  // used to mutation-check that the transient-retry is what recovers a 429-then-200 sub-batch.
  if (backoffMs) gas.CONFIG.RETRY_BACKOFF_MS = backoffMs;
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
        if (fetchThrows(upserts.length, recs)) {
          // Transport-level failure (DNS/timeout/connection): fetch THROWS, it does not return
          // an error response. airtableUpsert_ must map this to code 0 (transient), not crash.
          upserts.push({ count: recs.length, threw: true, records: recs });
          throw new Error('connection reset');
        }
        // Airtable rejects > 10 records/request (422); otherwise honour the test's code.
        const code = recs.length > 10 ? 422 : upsertCode(upserts.length, recs);
        upserts.push({ count: recs.length, code, records: recs });
        return { getResponseCode: () => code, getContentText: () => (code === 200 ? '' : 'ERR ' + code) };
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'DRY_RUN' ? (dryRun ? 'true' : null) : k === 'AIRTABLE_TOKEN' ? airtableToken : null) }) },
    Utilities: {
      getUuid: () => 'uuid-test',
      newBlob: (data) => ({ getDataAsString: () => Buffer.from(data).toString('utf8') }),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      sleep: () => {}, // the retry wrapper's backoff is a no-op under test (no real CI sleep)
    },
  });

  let threw = null;
  try {
    gas.collectJobEmailsLocked_();
  } catch (e) {
    if (!expectThrow) throw e; // an unexpected throw must fail the calling test
    threw = e;
  }

  const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };
  return {
    collected: labelCalls.filter(c => c.label === L_COLLECTED).map(c => c.id),
    failed: labelCalls.filter(c => c.label === L_FAILED).map(c => c.id),
    upserts,
    threw,
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

test('transient upsert (503) leaves the whole sub-batch uncollected, successes commit, and the run ends FAILED (fail loudly)', () => {
  // A 503 on the FIRST sub-batch's PATCH (rate-limit/outage, not a record problem); the rest
  // succeed. Three invariants, all mutation-checked:
  //   1. "label make-collected ONLY if the upsert succeeded" — mislabelling the failed batch
  //      would drop never-written rows forever (QUERY excludes make-collected).
  //   2. A transient is NEVER make-failed (it isn't poison) — the whole sub-batch is left
  //      uncollected and retries next run.
  //   3. Fail-loudly: a run with >=1 transient failure must THROW after the loop (GAS failure
  //      emails fire only on Failed executions). Successful sub-batches' labels are applied
  //      BEFORE the throw — deleting the final throw flips r.threw while the commit asserts pass.
  // The dormant per-record individual codes (m0 healthy, m1-m4 503) are reached ONLY if a
  // mutation routes 5xx into the make-failed/isolation path — then m1-m4 would be make-failed
  // (m0 proves a healthy sibling), flipping `failed.length` from 0. So this also mutation-checks
  // "5xx must stay transient, never poison".
  const upsertCode = (i, recs) => {
    const ids = recs.map(r => r.fields.MessageId);
    if (recs.length > 1) return ids.includes('m0') ? 503 : 200; // sub-batch 0 transient, rest OK
    return ids[0] === 'm0' ? 200 : 503; // dormant unless 5xx is wrongly isolated
  };
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode, expectThrow: true });
  assert.equal(r.collected.length, 7, 'only the 7 messages in the two healthy sub-batches are make-collected');
  for (const id of ['m0', 'm1', 'm2', 'm3', 'm4']) {
    assert.ok(!r.collected.includes(id), `${id} (its sub-batch 503'd) must NOT be make-collected`);
  }
  assert.equal(r.failed.length, 0, 'a transient failure is never make-failed (not poison)');
  assert.ok(r.logs.some(l => /Airtable upsert FAILED \(transient 503\) for sub-batch starting at 0/.test(l)), 'transient failure logged');
  assert.ok(r.logs.some(l => l.includes('Collected 7 of 12')), 'summary still logged before the throw');
  assert.ok(r.threw, 'a run with a transient failure must end by throwing (Failed execution)');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'count + first error text in the message');
});

test('fail loudly: multiple transient sub-batches are counted, the FIRST error text wins, successes still commit', () => {
  // Sub-batches 0 (503) and 2 (500) fail transiently; sub-batch 1 succeeds and is labelled.
  const upsertCode = (i, recs) => {
    const ids = recs.map(r => r.fields.MessageId);
    if (ids.includes('m0')) return 503;  // sub-batch 0 (m0-m4)
    if (ids.includes('m10')) return 500; // sub-batch 2 (m10-m11)
    return 200;                          // sub-batch 1 (m5-m9)
  };
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode, expectThrow: true });
  assert.equal(r.collected.length, SUB_BATCH, 'the one successful sub-batch is still labelled');
  assert.equal(r.failed.length, 0, 'transients are never make-failed');
  assert.ok(r.threw, 'run ends Failed');
  assert.match(r.threw.message, /^2 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'failure count aggregated, first error preserved');
});

test('read-side poison isolation: a bad message is make-failed while its siblings are make-collected', () => {
  // A parse-error message (undecodable body) — isolated by the per-message try/catch BEFORE
  // any upsert. Distinct from the write-side isolation below (a deterministic Airtable reject).
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, poison: [2] });
  assert.deepEqual(r.failed, ['m2'], 'only the poison message is make-failed');
  assert.equal(r.collected.length, 4, 'the 4 well-formed siblings are collected');
  assert.ok(!r.collected.includes('m2'), 'poison message is not make-collected');
  assert.ok(r.logs.some(l => l.includes('Collected 4 of 5')));
});

test('write-side poison isolated: one record 422s individually, the four siblings collect, the poison one is make-failed, no throw', () => {
  // A 5-record sub-batch whose batch PATCH 4xx's (Airtable batch writes are all-or-nothing).
  // The loop re-sends each record individually: m2's own PATCH 422s (a record-specific reject),
  // the other four return 200. Because >=1 sibling succeeded, m2 is make-failed (quarantined so
  // its good siblings stop being re-fetched + the run stops failing every run) and the run does
  // NOT throw on the isolated poison. The make-failed label excludes m2 from CONFIG.QUERY, so a
  // follow-up run won't re-present it (label semantics, not re-tested here).
  // Mutation: delete the individual-retry (isolation) branch -> the 422 batch leaves every record
  // uncollected -> r.collected.length flips from 4 to 0.
  const upsertCode = (i, recs) => {
    if (recs.length > 1) return 422; // the batch PATCH: a deterministic 4xx -> isolate
    return recs[0].fields.MessageId === 'm2' ? 422 : 200; // m2 poison, the rest healthy
  };
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode });
  assert.deepEqual(r.failed, ['m2'], 'only the record-specific reject is make-failed');
  assert.equal(r.collected.length, 4, 'the four healthy siblings now make progress');
  for (const id of ['m0', 'm1', 'm3', 'm4']) assert.ok(r.collected.includes(id), `${id} collected`);
  assert.ok(!r.collected.includes('m2'), 'the poison record is not make-collected');
  assert.ok(!r.threw, 'an isolated, quarantined poison record does NOT fail the run');
  assert.ok(r.logs.some(l => /re-sending its 5 record\(s\) individually/.test(l)), 'isolation logged');
  assert.ok(r.logs.some(l => /Labeled m2 as job-vacancies\/make-failed — deterministic Airtable reject \(422\)/.test(l)), 'quarantine logged with the code');
  assert.ok(r.logs.some(l => l.includes('Collected 4 of 5')), 'summary reflects the four collected');
});

test('systemic 4xx does NOT mass-quarantine: every record 401s, none make-failed, sub-batch left uncollected, run throws', () => {
  // Every record's individual PATCH returns 401 (bad auth / wrong endpoint / schema drift) — a
  // SYSTEMIC failure, not a record-specific one. The quarantine guard requires >=1 healthy
  // sibling; with zero successes it make-failed NONE (so a deploy mistake can't quarantine the
  // whole queue), leaves the sub-batch uncollected, and the run ends by throwing after the summary
  // so a human fixes the systemic cause.
  // Mutation: remove the ">=1 sibling succeeded" guard -> all five records are wrongly make-failed
  // -> r.failed.length flips from 0 to 5.
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode: () => 401, expectThrow: true });
  assert.equal(r.failed.length, 0, 'a systemic reject quarantines NOTHING (no make-failed)');
  assert.equal(r.collected.length, 0, 'the whole sub-batch is left uncollected');
  assert.ok(r.threw, 'a systemic reject ends the run Failed');
  // Counted ONCE for the sub-batch, not once per rejected record (Codex F-P3): a 5-record
  // systemic outage is "1 sub-batch", not "5". Mutation: count per-record -> "5 sub-batch …".
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 401: ERR 401$/, 'one sub-batch failure, first error preserved');
  assert.ok(r.logs.some(l => /every record in the sub-batch was rejected \(systemic, not record-specific\); NOT quarantined/.test(l)), 'systemic non-quarantine logged');
});

test('missing AIRTABLE_TOKEN fails the run fast with its own error, NOT masked as a transient (Codex F-P2)', () => {
  // A cleared/rotated PAT is a config error: airtableToken_ throws, and because attemptUpsert_
  // no longer wraps it in a transient-catch, the throw propagates and ends the run on the FIRST
  // sub-batch with its precise message — never a synthetic 'network error' that limps through
  // every sub-batch and reports a generic fail-loud summary.
  // Mutation: re-broaden the catch (treat the token error as transient) -> r.threw.message
  // becomes 'N sub-batch upsert(s) failed' and the two asserts below flip.
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, airtableToken: null, expectThrow: true });
  assert.ok(r.threw, 'the run throws');
  assert.match(r.threw.message, /AIRTABLE_TOKEN is not set/, 'fails fast with the precise config error');
  assert.ok(!/upsert\(s\) failed/.test(r.threw.message), 'NOT masked as a transient fail-loud summary');
  assert.equal(r.collected.length, 0, 'nothing collected — failed before any write');
  assert.equal(r.failed.length, 0, 'nothing make-failed');
});

test('a network transport throw is transient: whole sub-batch uncollected, fail-loud, never make-failed', () => {
  // UrlFetchApp.fetch THROWS on the batch PATCH (transport failure, not an HTTP response).
  // airtableUpsert_ maps it to code 0 -> attemptUpsert_ classifies transient -> the sub-batch is
  // left uncollected and retried next run, never make-failed, and the run ends Failed with the
  // network-error text. Pins the prompt's "UrlFetchApp.fetch threw a network exception → transient".
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, fetchThrows: (i, recs) => recs.length > 1, expectThrow: true });
  assert.equal(r.collected.length, 0, 'a transport failure leaves the sub-batch uncollected');
  assert.equal(r.failed.length, 0, 'a transport failure is never make-failed (not poison)');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: network error: connection reset$/, 'counted as a transient sub-batch failure with the network-error text');
  assert.ok(r.logs.some(l => /Airtable upsert transport failure: network error: connection reset/.test(l)), 'transport failure logged');
});

test('transient 429 then 200 recovers WITHIN the run: sub-batch collected, no isolation, no fail-loud (composes with #19)', () => {
  // The batch PATCH 429s once, then 200s on the retry — airtableFetchWithRetry_ absorbs the blip
  // inside the same attemptUpsert_ call, so the sub-batch is make-collected, the run does NOT
  // fail-loud and NEVER enters per-record isolation (#19's contracts see only the recovered 200).
  // n=5 = one sub-batch; upsertCode keys on the global fetch-call index so the first fetch is 429
  // and the retry is 200. Mutation lives in the next test (backoffMs:[] -> the 429 fails the run).
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode: (i) => (i === 0 ? 429 : 200) });
  assert.equal(r.collected.length, 5, 'all 5 recovered and make-collected after the retry');
  assert.equal(r.failed.length, 0, 'nothing make-failed — a transient never quarantines');
  assert.ok(!r.threw, 'a recovered transient does NOT fail the run');
  assert.equal(r.upserts.length, 2, 'one 429 then one 200 — exactly one retry');
  assert.ok(!r.logs.some(l => /individually to isolate/.test(l)), 'never entered write-side isolation');
});

test('mutation: retries disabled (backoffMs:[]) — the SAME 429 fails loud, sub-batch left uncollected', () => {
  // Identical to the recovery test but backoffMs:[] makes the wrapper take a single attempt, so the
  // 429 is never retried -> classified transient -> the whole sub-batch is left uncollected and the
  // run ends Failed. This proves the retry above is the load-bearing recovery (CLAUDE.md: a guard
  // around a tested predicate needs its own mutation check).
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode: (i) => (i === 0 ? 429 : 200), backoffMs: [], expectThrow: true });
  assert.equal(r.collected.length, 0, 'with no retry the 429 leaves the sub-batch uncollected');
  assert.equal(r.failed.length, 0, 'still never make-failed (transient, not poison)');
  assert.ok(r.threw, 'the run ends Failed (no retry to recover the blip)');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 429: ERR 429$/, 'fail-loud summary names the 429');
  assert.equal(r.upserts.length, 1, 'exactly one attempt — no retry');
});

test('DRY_RUN never quarantines a would-be write-poison: no upsert, no make-collected, no make-failed', () => {
  // DRY_RUN short-circuits BEFORE any upsert, so a write-poison can't even be observed (detecting
  // it needs a real PATCH). The point under test: DRY_RUN touches nothing — it never make-failed
  // a message on the write side. (Read-side would-be make-failed is logged by the parse-error path,
  // covered separately.) The upsertCode that would 422 is never invoked.
  const upsertCode = (i, recs) => (recs.length > 1 ? 422 : 200);
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode, dryRun: true });
  assert.equal(r.upserts.length, 0, 'DRY_RUN sends no PATCH at all');
  assert.equal(r.collected.length, 0, 'nothing labelled make-collected');
  assert.equal(r.failed.length, 0, 'nothing labelled make-failed — DRY_RUN never quarantines');
  assert.ok(r.logs.some(l => /DRY_RUN complete: 5 message\(s\) inspected/.test(l)), 'reached the dry-run summary');
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

test('offline link cleanup is wired into processMessage_: HtmlLength stays original, CleanText is cleaned, metric logged', () => {
  // One message whose body carries a cv-library refer tracker (?url= holding a relative
  // path that itself carries utm). Pins the wiring the pure-function units cannot: that
  // cleanLinksInHtml_ actually runs BEFORE CLEAN_REGEX, that HtmlLength is the ORIGINAL
  // length (Make parity) and only CleanText reflects the cleanup, and that the per-run
  // "Links:" metric is logged. Mutation-checked: setting HtmlLength to the cleaned length,
  // dropping the cleanLinksInHtml_ call, or removing the log each flips an assertion.
  // NOTE: this does NOT mutation-check that cleanup runs BEFORE CLEAN_REGEX — for every input
  // under test the two orders are byte-identical (CLEAN_REGEX only deletes URLs outside <body>),
  // so the 'before CLEAN_REGEX' ordering is asserted by code comments, not by a test.
  const tracker = 'http://www.cv-library.co.uk/refer/100145?url=%2Fjob%2F123%2FDevOps-Engineer%3Futm_source%3Dx%26utm_medium%3Demail';
  const html = `<html><body><a href="${tracker}">DevOps Engineer</a></body></html>`;
  const r = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, bodyHtml: () => html });

  const fields = r.upserts[0].records[0].fields;
  assert.equal(fields.HtmlLength, html.length, 'HtmlLength is the ORIGINAL html length, not the cleaned length');
  assert.ok(fields.CleanText.includes('http://www.cv-library.co.uk/job/123/DevOps-Engineer'), 'destination surfaced in CleanText');
  assert.ok(!fields.CleanText.includes('/refer/100145?url='), 'the opaque tracker is gone from CleanText');
  assert.ok(!/utm_/i.test(fields.CleanText), 'no utm_ remains in CleanText');
  assert.equal(fields.CleanLength, fields.CleanText.length, 'CleanLength matches the cleaned text');
  assert.ok(fields.CleanLength < fields.HtmlLength, 'cleaning removed bytes');
  // bytes_saved pinned exactly (not just \d+) so a zeroed-out run-loop accumulator flips this.
  assert.ok(r.logs.some(l => /^Links: decoded=1 utm_stripped=1 bytes_saved=62$/.test(l)), 'per-run Links metric logged with the actual byte delta');
});

test('table-wrapper unwrap is wired in AFTER CLEAN_REGEX: wrappers collapse out of CleanText, Unwrap metrics logged (real + DRY_RUN)', () => {
  // One message wrapped in a double single-child table chain (the issue #13 live shape).
  // CLEAN_REGEX leaves the bare skeleton; collapseTableWrappers_ must then collapse it, so
  // CleanText is just the kept element while HtmlLength stays the ORIGINAL body length.
  // Mutation-checked: dropping the collapseTableWrappers_ call flips the CleanText asserts
  // and both log asserts; zeroing the run accumulator flips the rollup line; the DRY_RUN
  // pass pins "metrics in both paths" (the unwrap + its per-email line live in
  // processMessage_, the rollup logs before the DRY_RUN summary branch).
  const wrapped = '<table><tr><td><table><tr><td><p>DevOps role</p></td></tr></table></td></tr></table>';
  const html = `<html><body>${wrapped}</body></html>`;
  const r = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, bodyHtml: () => html });

  const fields = r.upserts[0].records[0].fields;
  assert.equal(fields.HtmlLength, html.length, 'HtmlLength is the ORIGINAL html length (Make parity)');
  assert.equal(fields.CleanText, '<p>DevOps role</p>', 'both wrapper tables collapsed out of CleanText');
  assert.equal(fields.CleanLength, fields.CleanText.length, 'CleanLength matches the unwrapped text');
  // Per-email line and per-run rollup, bytes pinned exactly: the skeleton is 84 chars, the
  // kept element 18, so 66 bytes drop. (msg= distinguishes the per-email line from the rollup.)
  assert.ok(r.logs.some(l => /^Unwrap: msg=m0 tables=2 bytes_saved=66$/.test(l)), 'per-email Unwrap line logged');
  assert.ok(r.logs.some(l => /^Unwrap: tables=2 bytes_saved=66$/.test(l)), 'per-run Unwrap rollup logged');

  const dry = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, bodyHtml: () => html, dryRun: true });
  assert.equal(dry.upserts.length, 0, 'DRY_RUN writes nothing');
  assert.ok(dry.logs.some(l => /^Unwrap: msg=m0 tables=2 bytes_saved=66$/.test(l)), 'per-email Unwrap line logs in DRY_RUN too');
  assert.ok(dry.logs.some(l => /^Unwrap: tables=2 bytes_saved=66$/.test(l)), 'per-run Unwrap rollup logs in DRY_RUN too');
});

test('footer cutoff is wired in AFTER the unwrap: a mapped sender\'s footer is cut from CleanText, Footer metrics logged (real + DRY_RUN)', () => {
  // Feed the REAL whatjobs fixture as the message body and a dot-boundary subdomain sender
  // (mail.uk.whatjobs.com -> the whatjobs.com key). The full processMessage_ pipeline runs
  // (link cleanup -> CLEAN_REGEX -> unwrap -> footer cutoff), so the marker "Overall, how
  // relevant are these jobs" and its tail must be gone from CleanText while HtmlLength stays
  // original. Mutation-checked: dropping the truncateAtFooter_ call leaves the marker in
  // CleanText and emits no Footer hit lines, flipping every assert below. The exact cut byte
  // count is pinned by the corpus test (footer-cutoff.test.js); here we pin the wiring + that
  // the per-email and per-run lines agree.
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'email-whatjobs.html'), 'utf8');
  const opts = { n: 1, budgetMs: 1e9, getDelta: 1, from: () => 'jobalerts@mail.uk.whatjobs.com', bodyHtml: () => fixture };
  const r = runCollector(opts);

  const fields = r.upserts[0].records[0].fields;
  assert.equal(fields.HtmlLength, fixture.length, 'HtmlLength stays the ORIGINAL body length (Make parity)');
  assert.ok(!fields.CleanText.includes('Overall, how relevant are these jobs'), 'the footer marker (and its tail) is cut from CleanText');
  assert.equal(fields.CleanLength, fields.CleanText.length, 'CleanLength matches the footer-cut text');
  const perEmail = r.logs.find(l => /^Footer: msg=m0 /.test(l));
  assert.match(perEmail, /^Footer: msg=m0 domain=whatjobs\.com marker=hit bytes_cut=\d+$/, 'per-email line uses the matched registered-domain key');
  const bytes = Number(perEmail.match(/bytes_cut=(\d+)/)[1]);
  assert.ok(bytes > 0, 'a hit cuts a positive number of bytes');
  assert.ok(r.logs.includes(`Footer: hits=1 misses=0 bytes_cut=${bytes}`), 'per-run Footer rollup matches the per-email cut (and has no msg=)');
  assert.ok(!r.threw, 'a clean hit run does not throw');

  const dry = runCollector({ ...opts, dryRun: true });
  assert.equal(dry.upserts.length, 0, 'DRY_RUN writes nothing');
  assert.ok(dry.logs.some(l => /^Footer: msg=m0 domain=whatjobs\.com marker=hit bytes_cut=\d+$/.test(l)), 'per-email Footer line logs in DRY_RUN too');
  assert.ok(dry.logs.some(l => /^Footer: hits=1 misses=0 bytes_cut=\d+$/.test(l)), 'per-run Footer rollup logs in DRY_RUN too');
});

test('a footer-marker MISS on a mapped sender ends a real run FAILED (mutation-checked: deleting the miss-throw flips this)', () => {
  // reed.co.uk is mapped, but this body lacks reed's marker -> miss. The row is still committed
  // (a miss is a no-cut, NOT a failure), THEN the run throws after the summary so the GAS failure
  // email fires and tells Ivan to update the changed marker. Deleting the end-of-run miss-throw
  // leaves r.threw null and flips the last two asserts (the guards-around-tested-predicates lesson).
  const body = '<html><body><p>a reed job alert with no footer marker present</p></body></html>';
  const opts = { n: 1, budgetMs: 1e9, getDelta: 1, from: () => 'jobs@reed.co.uk', bodyHtml: () => body };
  const r = runCollector({ ...opts, expectThrow: true });

  assert.equal(r.collected.length, 1, 'the miss row is still committed + labelled before the throw (no data loss)');
  assert.ok(r.logs.includes('Footer: msg=m0 domain=reed.co.uk marker=miss bytes_cut=0'), 'per-email miss line logged');
  assert.ok(r.logs.includes('Footer: hits=0 misses=1 bytes_cut=0'), 'per-run rollup counts the miss');
  assert.ok(r.threw, 'a real run with a footer miss must end by throwing (Failed execution)');
  assert.match(r.threw.message, /^1 footer marker miss\(es\); first: reed\.co\.uk msg=m0$/, 'count + first domain/msg in the message');

  // DRY_RUN with the same miss logs everything but throws NOTHING (pinned alongside the real path).
  const dry = runCollector({ ...opts, dryRun: true });
  assert.equal(dry.threw, null, 'DRY_RUN never throws on a miss');
  assert.equal(dry.upserts.length, 0, 'DRY_RUN writes nothing');
  assert.ok(dry.logs.includes('Footer: msg=m0 domain=reed.co.uk marker=miss bytes_cut=0'), 'miss still logged per-email in DRY_RUN');
  assert.ok(dry.logs.includes('Footer: hits=0 misses=1 bytes_cut=0'), 'miss still counted in the DRY_RUN rollup');
  assert.ok(dry.logs.some(l => /DRY_RUN complete:/.test(l)), 'reached the dry-run summary (did not throw out early)');
});

test('F1 — an upsert failure co-occurring with a COMMITTED footer miss throws one error carrying BOTH signals', () => {
  // The gap Codex caught (F1, PR #17): a footer miss in a sub-batch that COMMITTED is already
  // make-collected and will NOT recur, so if a later sub-batch fails its upsert and the upsert
  // throw simply *suppressed* the footer-miss throw, that template-change signal would be lost
  // forever. Compose exactly that — one message per sub-batch (subBatch=1): m0 is a reed miss that
  // upserts OK (so it's labelled, won't recur); m1 then 422s. The single thrown error must name
  // the upsert failure FIRST (precedence preserved) AND fold in the footer-miss summary, so the
  // one GAS failure email carries both. Mutation-checked: dropping the `. Also …` fold reverts to
  // the bare upsert message and flips the combined-message assert.
  // m1 fails its upsert TRANSIENTLY (503) — a genuine transient, not a deterministic 4xx that
  // would isolate. (A 422 here would route m1, alone in its 1-record sub-batch, through the
  // isolation path, which the no-healthy-sibling guard also leaves uncollected + fail-loud — but
  // 503 keeps the F1 scenario unambiguous: a transient outage co-occurring with a committed miss.)
  const reedNoFooter = '<html><body><p>a reed job alert with no footer marker present</p></body></html>';
  const r = runCollector({
    n: 2, budgetMs: 1e9, getDelta: 1, subBatch: 1,
    from: (i) => (i === 0 ? 'jobs@reed.co.uk' : 'someone@x.com'),
    bodyHtml: (i) => (i === 0 ? reedNoFooter : '<html><body>hi</body></html>'),
    upsertCode: (call) => (call === 0 ? 200 : 503),
    expectThrow: true,
  });

  assert.ok(r.collected.includes('m0'), 'the missed-marker message committed + was labelled (so it will NOT recur — why the signal must survive)');
  assert.ok(!r.collected.includes('m1'), 'the 503 sub-batch is not labelled');
  assert.equal(r.failed.length, 0, 'a transient upsert failure is never make-failed');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(
    r.threw.message,
    /^1 sub-batch upsert\(s\) failed; first: 503: ERR 503\. Also 1 footer marker miss\(es\); first: reed\.co\.uk msg=m0$/,
    'the upsert failure is named first AND the footer-miss summary is folded into the same error',
  );
  // The footer-miss alarm is the load-bearing feature; prove both conditions were really present:
  assert.ok(r.logs.includes('Footer: hits=0 misses=1 bytes_cut=0'), 'the footer miss did occur (rollup shows misses=1)');
  assert.ok(r.logs.some(l => /Airtable upsert FAILED/.test(l)), 'the upsert failure did occur');
});
