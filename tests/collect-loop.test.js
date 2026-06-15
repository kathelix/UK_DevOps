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
//   - write-side isolation of ANY non-ok sub-batch (poison or transient): a deterministic-4xx
//     record is isolated per-record and make-failed only with a healthy sibling; a record-specific
//     transient (429/5xx/transport) is isolated too, so its HEALTHY siblings collect while only the
//     bad record is left to retry (never make-failed); a systemic sub-batch (all-4xx, or an all-
//     transient outage with no healthy sibling) quarantines nothing and fails loud, counted once;
//   - the SUB_BATCH_SIZE clamp (an out-of-range knob can't 422 or stall the loop);
//   - the offline link-cleanup wiring (HtmlLength stays original, CleanText is cleaned,
//     the per-run "Links:" metric is logged);
//   - the table-wrapper unwrap wiring (wrappers collapse out of CleanText, the per-email
//     and per-run "Unwrap:" metrics log in real AND DRY_RUN runs);
//   - the footer-cutoff wiring (a mapped sender's footer is cut from CleanText, the per-email
//     and per-run "Footer:" metrics log in real AND DRY_RUN; a MISS ends a real run Failed but
//     a DRY_RUN run never throws; when an upsert failure co-occurs, its error is named first AND
//     the footer-miss summary is folded into the same throw so the alarm is never lost — F1).
//   - the Gmail-read retry wiring (gmailReadWithRetry_): a transient get heals in-run (collected,
//     NOT make-failed) — mutation-checked by disabling retries; a persistent get is left
//     uncollected, NOT make-failed, run Failed; a parse-poison still make-faileds and does NOT
//     trip the read canary; a transient list blip heals while a persistent list failure propagates
//     (run Failed); and a read failure folds into the same one fail-loud throw as upsert + footer (F1).
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
// getThrows(id, attempt) / listThrows(attempt) → truthy makes a Gmail read THROW (a transient
// blip), so gmailReadWithRetry_ is exercised end-to-end. `attempt` is 0-based and PER-ID for get
// (the retry re-calls get for the SAME id) and global for list — so `(id, a) => id==='m2' && a===0`
// throws once then heals, `(id) => id==='m2'` throws on every attempt (a persistent read failure).
function runCollector({ n, budgetMs, getDelta, dryRun = false, subBatch = SUB_BATCH, poison = [], upsertCode = () => 200, fetchThrows = () => false, getThrows = () => false, listThrows = () => false, airtableToken = 'tok', bodyHtml = null, from = null, expectThrow = false, backoffMs = null }) {
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
  const getAttempts = {}; // id -> times Gmail.get has been called for it (the retry re-calls per id)
  let listAttempts = 0;   // times Gmail.list has been called (global; the once-per-run list + retries)

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
          list: () => {
            const a = listAttempts++;
            if (listThrows(a)) throw new Error('gmail list blip #' + (a + 1));
            return { messages: messages.map(m => ({ id: m.id })) };
          },
          get: (_user, id) => {
            clock.advance(getDelta);
            const a = getAttempts[id] || 0;
            getAttempts[id] = a + 1;
            if (getThrows(id, a)) throw new Error('gmail read blip #' + (a + 1));
            return messages.find(m => m.id === id);
          },
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

test('record-specific transient (503) unblocks healthy siblings: m0/m2 collect, only m1 stuck, nothing make-failed, run FAILED (the headline)', () => {
  // THE headline of this slice. A 3-record sub-batch whose all-or-nothing batch PATCH 503s because
  // ONE record (m1) trips a record-specific 5xx. Pre-slice the transient branch took an early
  // `continue` and left ALL THREE uncollected on every run — the healthy siblings held hostage by m1.
  // Now a non-ok batch falls into per-record isolation: m0 and m2 individually 200 -> make-collected
  // (unblocked!), m1 individually 503 -> stuck (uncollected, retries next run), and a transient is
  // NEVER make-failed. The run still ends Failed (one stuck sub-batch) so the GAS failure email fires.
  // This IS the mutation check vs the old behaviour: asserting m0/m2 are collected fails pre-slice,
  // which collected none of the three.
  const upsertCode = (i, recs) => {
    if (recs.length > 1) return 503;                        // the batch PATCH: all-or-nothing 503
    return recs[0].fields.MessageId === 'm1' ? 503 : 200;  // isolation: only m1 is the bad record
  };
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, upsertCode, expectThrow: true });
  assert.deepEqual(r.collected.sort(), ['m0', 'm2'], 'the two healthy siblings are unblocked and make-collected');
  assert.ok(!r.collected.includes('m1'), 'the record-specific transient is left uncollected');
  assert.equal(r.failed.length, 0, 'a transient is NEVER make-failed (not poison)');
  assert.ok(r.logs.some(l => /re-sending its 3 record\(s\) individually to isolate the failure/.test(l)), 'the non-ok batch entered per-record isolation');
  assert.ok(r.logs.some(l => /Airtable individual upsert FAILED \(transient 503\) for message m1/.test(l)), 'only m1 logged as a stuck transient');
  assert.ok(!r.logs.some(l => /Airtable individual upsert FAILED \(transient 503\) for message m(0|2)/.test(l)), 'the healthy siblings are not logged as stuck');
  assert.ok(r.threw, 'a run with a stuck record ends Failed');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'counted once for the sub-batch, first error preserved');
});

test('systemic transient outage (every record 503) quarantines nothing: nothing collected, nothing make-failed, counted once, run FAILED', () => {
  // The hold-invariant: a SYSTEMIC transient outage (the batch PATCH 503s AND every individual
  // record 503s, so there is no healthy sibling) must leave the whole sub-batch uncollected and
  // make-failed NOTHING — the same outcome as the old early-continue, now reached via isolation
  // rather than a short-circuit. Counted ONCE for the sub-batch (the `stuck` flag), not once per
  // record (F-P3) — pin the exact rendered string.
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, upsertCode: () => 503, expectThrow: true });
  assert.equal(r.collected.length, 0, 'a systemic transient outage collects nothing');
  assert.equal(r.failed.length, 0, 'and quarantines nothing — a transient is never make-failed, even with no healthy sibling');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'counted ONCE for the sub-batch (not 3), first error preserved');
  assert.ok(r.logs.some(l => /re-sending its 3 record\(s\) individually to isolate the failure/.test(l)), 'reached isolation even though no record will succeed');
});

test('mixed-origin sub-batch: healthy collects, the 422 is make-failed, the 5xx stays stuck — the unified path keeps the quarantine guard', () => {
  // One sub-batch, three records of three different fates after the batch PATCH fails: m0 healthy
  // (200), m1 a record-specific transient (503), m2 a record-specific poison (422). The batch PATCH
  // 503s (so the OLD transient early-continue would have stranded ALL three AND never quarantined
  // the 422); the unified isolation now sorts them out — m0 make-collected (proving a healthy
  // sibling), m2 make-failed (the anyHealthy quarantine guard is satisfied), m1 left stuck and NEVER
  // make-failed. Confirms the unified path strikes neither the healthy nor the transient record while
  // still quarantining the poison one.
  const upsertCode = (i, recs) => {
    if (recs.length > 1) return 503;            // the batch PATCH (a mix; classifies transient)
    const id = recs[0].fields.MessageId;
    if (id === 'm1') return 503;                // record-specific transient -> stuck
    if (id === 'm2') return 422;                // record-specific poison -> make-failed
    return 200;                                 // m0 healthy
  };
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, upsertCode, expectThrow: true });
  assert.deepEqual(r.collected, ['m0'], 'the healthy record is make-collected');
  assert.deepEqual(r.failed, ['m2'], 'only the 422 poison record is make-failed (quarantine guard satisfied by m0)');
  assert.ok(!r.collected.includes('m1') && !r.failed.includes('m1'), 'the 503 record is left stuck — neither collected nor make-failed');
  assert.ok(r.threw, 'the stuck transient record ends the run Failed');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'the stuck record drives one sub-batch failure, named by the 503');
  assert.ok(r.logs.some(l => /Labeled m2 as job-vacancies\/make-failed.*deterministic Airtable reject \(422\)/.test(l)), 'the poison record is quarantined with the code');
  assert.ok(r.logs.some(l => /Airtable individual upsert FAILED \(transient 503\) for message m1/.test(l)), 'the transient record stays uncollected');
});

test('fail loudly: multiple systemic-transient sub-batches are counted, the FIRST error text wins, successes still commit', () => {
  // Two whole sub-batches suffer a SYSTEMIC transient outage (every record fails), so each is left
  // uncollected and counted once; the middle sub-batch succeeds and is labelled. Keys on the message
  // index so the batch PATCH AND each isolation retry get the same code: sub-batch 0 (m0-m4) -> 503,
  // sub-batch 2 (m10-m11) -> 500, sub-batch 1 (m5-m9) -> 200. (Under the unified isolation a 503
  // tripping on one record alone would now let its healthy siblings through; the systemic stubs are
  // what keep each whole sub-batch stuck for this multi-sub-batch counting check.)
  const idx = (id) => Number(id.slice(1)); // 'm10' -> 10
  const upsertCode = (i, recs) => {
    const ids = recs.map(r => idx(r.fields.MessageId));
    if (ids.some(n => n <= 4)) return 503;   // sub-batch 0 (m0-m4) — batch + every individual retry
    if (ids.some(n => n >= 10)) return 500;  // sub-batch 2 (m10-m11) — batch + every individual retry
    return 200;                              // sub-batch 1 (m5-m9)
  };
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode, expectThrow: true });
  assert.equal(r.collected.length, SUB_BATCH, 'the one successful sub-batch is still labelled');
  assert.equal(r.failed.length, 0, 'transients are never make-failed');
  assert.ok(r.threw, 'run ends Failed');
  assert.match(r.threw.message, /^2 sub-batch upsert\(s\) failed; first: 503: ERR 503$/, 'failure count aggregated (one per stuck sub-batch), first error preserved');
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

test('a systemic network transport throw is transient: whole sub-batch uncollected, fail-loud, never make-failed', () => {
  // UrlFetchApp.fetch THROWS on every PATCH (a transport outage — DNS/timeout/connection — not an
  // HTTP response). The batch PATCH throws -> airtableUpsert_ maps it to code 0 -> attemptUpsert_
  // classifies transient -> per-record isolation; each individual PATCH throws too, so every record
  // is stuck (transient), nothing is make-failed (not poison), the whole sub-batch is left
  // uncollected, and the run ends Failed with the network-error text. With the unified isolation a
  // whole sub-batch is uncollected only when the outage is SYSTEMIC (here every PATCH throws); a
  // transport blip tripping on one record alone would now let its healthy siblings through.
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, fetchThrows: () => true, expectThrow: true });
  assert.equal(r.collected.length, 0, 'a systemic transport failure leaves the whole sub-batch uncollected');
  assert.equal(r.failed.length, 0, 'a transport failure is never make-failed (not poison)');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: network error: connection reset$/, 'counted once as a transient sub-batch failure with the network-error text');
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

test('mutation: retries disabled (backoffMs:[]) — a systemic 429 with no retry fails loud, sub-batch left uncollected', () => {
  // The mutation pair for the recovery test above: backoffMs:[] makes the wrapper take a single
  // attempt, so a 429 is never retried. Here every PATCH 429s (a systemic rate-limit), so the batch
  // 429 -> per-record isolation -> each individual 429 (still no retry) -> every record stuck ->
  // whole sub-batch uncollected, run Failed. Proves the retry above is the load-bearing recovery
  // (CLAUDE.md: a guard around a tested predicate needs its own mutation check). The 429 is systemic
  // on purpose: under the unified isolation a 429 tripping on one record alone would now let its
  // healthy siblings through, so an all-429 stub is what keeps the whole sub-batch uncollected here.
  const r = runCollector({ n: 5, budgetMs: 1e9, getDelta: 1, upsertCode: () => 429, backoffMs: [], expectThrow: true });
  assert.equal(r.collected.length, 0, 'with no retry the systemic 429 leaves the whole sub-batch uncollected');
  assert.equal(r.failed.length, 0, 'still never make-failed (transient, not poison)');
  assert.ok(r.threw, 'the run ends Failed (no retry to recover the blip)');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 429: ERR 429$/, 'fail-loud summary names the 429, counted once');
  assert.equal(r.upserts.length, 6, 'one batch attempt + five isolation attempts, each a single try (no retry)');
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
  // m1 fails its upsert TRANSIENTLY (503). Under the unified isolation path m1, alone in its
  // 1-record sub-batch, is re-sent individually and — with no healthy sibling — left uncollected
  // and fail-loud (a transient is never make-failed). 503 models a transient outage co-occurring
  // with a committed miss; a 422 would reach the same uncollected + fail-loud outcome via the
  // no-healthy-sibling guard, so the scenario stays unambiguous either way.
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
  assert.ok(r.logs.some(l => /Airtable individual upsert FAILED/.test(l)), 'the upsert failure did occur (via per-record isolation now)');
});

// ---------- Gmail-read retry (gmailReadWithRetry_) ----------

test('transient get heals in-run: a get that throws once then succeeds is COLLECTED, not make-failed, run Completed', () => {
  // The headline data-loss fix: a transient Gmail-read blip during get must NOT mis-quarantine the
  // message. get throws once for m0 then succeeds on the retry, so m0 is upserted + make-collected,
  // never make-failed, and the run ends Completed.
  const r = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, getThrows: (id, a) => id === 'm0' && a === 0 });
  assert.deepEqual(r.collected, ['m0'], 'the message recovered on retry and was make-collected');
  assert.equal(r.failed.length, 0, 'a transient read failure is NEVER make-failed (the old data-loss bug)');
  assert.ok(!r.threw, 'a recovered transient read does NOT fail the run');
  assert.ok(r.logs.some(l => l.includes('Collected 1 of 1')), 'run ends Completed with the message collected');
  assert.ok(!r.logs.some(l => /Gmail get FAILED/.test(l)), 'the in-run heal logs no FAILED line (the caller only sees success)');

  // Mutation: with retries disabled the SAME transient get is never retried -> the message is left
  // UNCOLLECTED (retried next run) and the run ends Failed — proving the retry is the load-bearing
  // recovery (mirrors the backoffMs:[] mutation on the 429-then-200 upsert test).
  const m = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, getThrows: (id, a) => id === 'm0' && a === 0, backoffMs: [], expectThrow: true });
  assert.equal(m.collected.length, 0, 'with no retry the transient get leaves the message uncollected');
  assert.equal(m.failed.length, 0, 'still never make-failed (transient, not poison)');
  assert.ok(m.threw, 'the run ends Failed (no retry to recover the read blip)');
  assert.match(m.threw.message, /^1 Gmail read\(s\) failed; first: m0: /, 'fail-loud names the read failure');
});

test('persistent get failure: message left UNCOLLECTED, NOT make-failed, run ends Failed naming the read failure', () => {
  // get throws on every attempt for m0 — a persistent read outage. After gmailReadWithRetry_'s 4
  // attempts the message is left uncollected (stays unlabelled -> re-presents next run), NEVER
  // make-failed (it is not poison), and the run ends Failed so the GAS failure email fires.
  // Mutation: routing the read failure into the make-failed branch would flip failed.length to 1.
  const r = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, getThrows: (id) => id === 'm0', expectThrow: true });
  assert.equal(r.collected.length, 0, 'a persistent read failure leaves the message uncollected');
  assert.equal(r.failed.length, 0, 'a persistent read failure is NEVER make-failed (not poison)');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(r.threw.message, /^1 Gmail read\(s\) failed; first: m0: gmail read blip #4$/, 'read-failure count + first error (after all 4 attempts) named');
  assert.ok(r.logs.some(l => /Gmail get FAILED \(transient\) for m0 — stays uncollected, retries next run\./.test(l)), 'the persistent read failure is logged');
});

test('parse-poison still make-faileds and does NOT trip the read canary (run stays Completed)', () => {
  // get SUCCEEDS; processMessage_ throws (undecodable body). The message is quarantined via the
  // SECOND, narrower try/catch (make-failed) — which must NOT increment the read-failure canary: a
  // deterministic parse poison is handled/quarantined, not an un-collected transient read. So the
  // run ends Completed even though one message was make-failed. This pins the narrow-catch split:
  // a parse poison and a transient read take different branches with different outcomes.
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, poison: [1] });
  assert.deepEqual(r.failed, ['m1'], 'the parse-poison message is make-failed (unchanged outcome)');
  assert.equal(r.collected.length, 2, 'its two siblings are collected');
  assert.ok(!r.collected.includes('m1'), 'the poison message is not make-collected');
  assert.ok(!r.threw, 'a quarantined parse-poison does NOT trip the read canary — run stays Completed');
  assert.ok(r.logs.some(l => l.includes('Collected 2 of 3')), 'completed summary logged');
  assert.ok(!r.logs.some(l => /Gmail get FAILED/.test(l)), 'a parse poison is never logged as a transient read failure');
});

test('list heals a transient blip: list throws once then succeeds, the run proceeds and collects normally', () => {
  // The once-per-run list is wrapped too: a single transient throw must not kill the whole run.
  // list throws on attempt 0 then succeeds on the retry, so the run lists, fetches, and collects
  // every message normally. Mutation lives in the next test (a persistent list failure fails loud).
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, listThrows: (a) => a === 0 });
  assert.equal(r.collected.length, 3, 'all messages collected after the list retry recovered');
  assert.equal(r.failed.length, 0, 'nothing make-failed');
  assert.ok(!r.threw, 'a recovered list blip does NOT fail the run (the spurious single-blip failure is gone)');
  assert.ok(r.logs.some(l => l.includes('Collected 3 of 3')), 'run completed normally');
});

test('persistent list failure ends the run Failed (the tagged read error propagates, no make-failed, nothing collected)', () => {
  // list throws on every attempt — a persistent outage. gmailReadWithRetry_'s tagged error
  // propagates out of collectJobEmailsLocked_ (the collectJobEmails finally only releases the lock),
  // so the run ends Failed with zero forward progress — same canary as the pre-wrapper unguarded
  // list, minus the spurious single-blip failure the heal test above proves is now absorbed.
  const r = runCollector({ n: 3, budgetMs: 1e9, getDelta: 1, listThrows: () => true, expectThrow: true });
  assert.ok(r.threw, 'a persistent list failure ends the run Failed');
  assert.match(r.threw.message, /^gmail list blip #4$/, 'the tagged read error (after 4 attempts) propagates out of the run');
  assert.equal(r.collected.length, 0, 'nothing collected');
  assert.equal(r.failed.length, 0, 'nothing make-failed');
});

test('F1 — read + upsert + footer failures co-occur: ONE thrown error names all three (none swallowed)', () => {
  // The widest F1 case: a transient READ failure, a transient UPSERT failure, and a committed
  // footer MISS all in one run. Each rides on work that won't re-present its signal on its own (the
  // missed-marker row committed + was labelled; an uncollected message retries but its SIGNAL would
  // be lost if a co-occurring throw swallowed it), so the run must throw ONE error naming every
  // signal, in the fixed precedence (reads, then writes, then the footer alarm). subBatch=1 = one
  // message per sub-batch: m0 = reed no-footer (commits, misses), m1 = persistent read failure,
  // m2 = transient 503 upsert. Mutation: dropping any signal from the composed throw flips the
  // exact-string assert below.
  const reedNoFooter = '<html><body><p>a reed job alert with no footer marker present</p></body></html>';
  const r = runCollector({
    n: 3, budgetMs: 1e9, getDelta: 1, subBatch: 1,
    from: (i) => (i === 0 ? 'jobs@reed.co.uk' : 'someone@x.com'),
    bodyHtml: (i) => (i === 0 ? reedNoFooter : '<html><body>hi</body></html>'),
    getThrows: (id) => id === 'm1',
    upsertCode: (i, recs) => (recs[0].fields.MessageId === 'm2' ? 503 : 200),
    expectThrow: true,
  });

  assert.ok(r.collected.includes('m0'), 'the missed-marker message committed + was labelled (so its signal must survive)');
  assert.ok(!r.collected.includes('m1'), 'the persistent-read-failure message is left uncollected');
  assert.ok(!r.collected.includes('m2'), 'the 503 upsert sub-batch is left uncollected');
  assert.equal(r.failed.length, 0, 'neither a transient read nor a transient upsert is ever make-failed');
  assert.ok(r.threw, 'the run ends Failed');
  assert.match(
    r.threw.message,
    /^1 Gmail read\(s\) failed; first: m1: gmail read blip #4\. Also 1 sub-batch upsert\(s\) failed; first: 503: ERR 503\. Also 1 footer marker miss\(es\); first: reed\.co\.uk msg=m0$/,
    'one error names all three signals, reads -> writes -> footer, none swallowed',
  );
  // Prove all three conditions really occurred (not just that the string was composed):
  assert.ok(r.logs.some(l => /Gmail get FAILED \(transient\) for m1/.test(l)), 'the read failure occurred');
  assert.ok(r.logs.some(l => /Airtable individual upsert FAILED \(transient 503\)/.test(l)), 'the upsert failure occurred (via per-record isolation now)');
  assert.ok(r.logs.includes('Footer: hits=0 misses=1 bytes_cut=0'), 'the footer miss occurred');
});

test('DRY_RUN still fails loud on a persistent read outage, but keeps suppressing the footer-miss alarm (Codex F1[P2], PR #25)', () => {
  // DRY_RUN does REAL reads, so a persistent read outage must NOT be silently swallowed — it is the
  // very failure this slice exists to surface. Earlier the read canary was built only in the
  // non-DRY_RUN branch, so a dry run logged the failure then returned "DRY_RUN complete" (Codex's
  // repro). Compose a dry run with BOTH a read failure and a footer miss: m1's get throws on every
  // attempt (read outage); m0 is a reed no-footer message whose read succeeds (a footer MISS). In
  // DRY_RUN nothing is written/labelled, the footer-miss alarm stays SUPPRESSED (side-effect-only),
  // but the read-failure alarm STILL throws so dry-run validation reports the outage. Mutation:
  // gating the read alarm behind !dryRun (the bug) makes r.threw null and flips the throw asserts.
  const reedNoFooter = '<html><body><p>a reed job alert with no footer marker present</p></body></html>';
  const r = runCollector({
    n: 2, budgetMs: 1e9, getDelta: 1, dryRun: true,
    from: (i) => (i === 0 ? 'jobs@reed.co.uk' : 'someone@x.com'),
    bodyHtml: (i) => (i === 0 ? reedNoFooter : '<html><body>hi</body></html>'),
    getThrows: (id) => id === 'm1',
    expectThrow: true,
  });
  assert.equal(r.upserts.length, 0, 'DRY_RUN sends no PATCH');
  assert.equal(r.collected.length, 0, 'DRY_RUN labels nothing make-collected');
  assert.equal(r.failed.length, 0, 'DRY_RUN never make-faileds');
  assert.ok(r.threw, 'a persistent read outage fails the run loud even in DRY_RUN');
  assert.match(
    r.threw.message,
    /^1 Gmail read\(s\) failed; first: m1: gmail read blip #4$/,
    'ONLY the read-failure alarm — the footer miss stays suppressed in DRY_RUN, the upsert never ran',
  );
  assert.ok(r.logs.some(l => /DRY_RUN complete:/.test(l)), 'the dry-run summary still logs before the throw');
  assert.ok(r.logs.includes('Footer: msg=m0 domain=reed.co.uk marker=miss bytes_cut=0'), 'the footer miss was detected (logged, just not thrown)');
});
