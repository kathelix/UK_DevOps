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
//   - the SUB_BATCH_SIZE clamp (an out-of-range knob can't 422 or stall the loop);
//   - the offline link-cleanup wiring (HtmlLength stays original, CleanText is cleaned,
//     the per-run "Links:" metric is logged);
//   - the table-wrapper unwrap wiring (wrappers collapse out of CleanText, the per-email
//     and per-run "Unwrap:" metrics log in real AND DRY_RUN runs);
//   - the footer-cutoff wiring (a mapped sender's footer is cut from CleanText, the per-email
//     and per-run "Footer:" metrics log in real AND DRY_RUN; a MISS ends a real run Failed but
//     a DRY_RUN run never throws; an upsert failure takes precedence over the miss-throw).
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
// upsertCode(callIndex) lets a test force a non-200 Airtable response per request.
// expectThrow: true captures a thrown run-ending error into r.threw (the fail-loudly
// contract); without it any throw propagates and fails the calling test.
function runCollector({ n, budgetMs, getDelta, dryRun = false, subBatch = SUB_BATCH, poison = [], upsertCode = () => 200, bodyHtml = null, from = null, expectThrow = false }) {
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
        upserts.push({ count: recs.length, code, records: recs });
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

test('upsert failure: the failed sub-batch is NOT labelled, successes commit, and the run ends FAILED (fail loudly)', () => {
  // 422 on the FIRST sub-batch only; the rest succeed. Two invariants, both mutation-checked:
  //   1. "label make-collected ONLY if the upsert succeeded" — mislabelling the failed
  //      batch would drop never-written rows forever (QUERY excludes make-collected).
  //   2. Fail-loudly: a run with >=1 failed sub-batch must THROW after the loop (GAS
  //      failure emails fire only on Failed executions; a silent "Completed" would hide
  //      a hard write-block). The successful sub-batches' labels are applied BEFORE the
  //      throw — deleting the final throw flips the r.threw assert while every
  //      commit/label assert still passes.
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode: (i) => (i === 0 ? 422 : 200), expectThrow: true });
  assert.equal(r.collected.length, 7, 'only the 7 successfully-upserted messages are make-collected');
  for (const id of ['m0', 'm1', 'm2', 'm3', 'm4']) {
    assert.ok(!r.collected.includes(id), `${id} (its upsert 422'd) must NOT be make-collected`);
  }
  assert.ok(r.logs.some(l => /Airtable upsert FAILED for sub-batch starting at 0/.test(l)), 'failure logged');
  assert.ok(r.logs.some(l => l.includes('Collected 7 of 12')), 'summary still logged before the throw');
  assert.ok(r.threw, 'a run with a failed sub-batch must end by throwing (Failed execution)');
  assert.match(r.threw.message, /^1 sub-batch upsert\(s\) failed; first: 422: ERR 422$/, 'count + first error text in the message');
});

test('fail loudly: multiple failed sub-batches are counted, the FIRST error text wins, successes still commit', () => {
  // Sub-batches 0 (422) and 2 (500) fail; sub-batch 1 succeeds and is labelled.
  const r = runCollector({ n: 12, budgetMs: 1e9, getDelta: 1, upsertCode: (i) => (i === 0 ? 422 : i === 2 ? 500 : 200), expectThrow: true });
  assert.equal(r.collected.length, SUB_BATCH, 'the one successful sub-batch is still labelled');
  assert.ok(r.threw, 'run ends Failed');
  assert.match(r.threw.message, /^2 sub-batch upsert\(s\) failed; first: 422: ERR 422$/, 'failure count aggregated, first error preserved');
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

test('precedence: a run with BOTH an upsert failure and a footer miss throws the UPSERT error, not the footer one', () => {
  // The upsert 422s (data-integrity event) AND the reed marker is absent (footer miss). The
  // upsert-failure throw must win: misses recur next run and nothing is lost, but a write block
  // must surface. Pins the ordering of the two end-of-run throws in collectJobEmailsLocked_.
  const body = '<html><body><p>a reed job alert with no footer marker present</p></body></html>';
  const r = runCollector({ n: 1, budgetMs: 1e9, getDelta: 1, from: () => 'jobs@reed.co.uk', bodyHtml: () => body, upsertCode: () => 422, expectThrow: true });

  assert.ok(r.threw, 'the run ends Failed');
  assert.match(r.threw.message, /sub-batch upsert\(s\) failed/, 'the data-integrity upsert error surfaces');
  assert.doesNotMatch(r.threw.message, /footer marker miss/, 'the footer-miss throw is suppressed when an upsert failure takes precedence');
  // Prove both conditions really were present this run, so the precedence is meaningful:
  assert.ok(r.logs.includes('Footer: hits=0 misses=1 bytes_cut=0'), 'the footer miss did occur (rollup shows misses=1)');
  assert.ok(r.logs.some(l => /Airtable upsert FAILED/.test(l)), 'the upsert failure did occur');
});
