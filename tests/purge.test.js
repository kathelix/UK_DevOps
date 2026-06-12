'use strict';

// Coverage for the RawEmails purge job (slice collector/purge-and-fail-loudly):
//   resolvePurgeThresholds_   -> the HIGH>LOW coherence check + both-defaults fallback
//   buildPurgePlan_           -> the pure delete plan (boundaries, low-water target,
//                                eligible-capped)
//   chunk_                    -> REST DELETE batching (10/request cap)
//   purgeEligibilityFormula_  -> THE guard: Processed-only + min-age, pinned verbatim
//   purgeRawEmailsLocked_     -> integration: count pagination, server-side filter in
//                                the request, oldest-first deletes, starvation warning,
//                                emergency throw, DRY_RUN, fail-loud non-200s
//
// The LockService wrapper (purgeRawEmails) is deliberately untested, same as the
// collector's collectJobEmails wrapper — pure side effect around the locked run.
//
// Realm note: arrays returned by VM-realm functions are spread ([...x]) or asserted by
// length/index, never deepStrictEqual'd against Node literals (prototype mismatch).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

// ---------- pure helpers ----------

test('resolvePurgeThresholds_ passes a coherent pair through; HIGH <= LOW falls back to BOTH defaults', () => {
  const { resolvePurgeThresholds_, CONFIG } = loadCollector();

  let t = resolvePurgeThresholds_(700, 500);
  assert.equal(t.high, 700);
  assert.equal(t.low, 500);
  assert.equal(t.fellBack, false);

  t = resolvePurgeThresholds_(400, 500); // inverted pair
  assert.equal(t.high, CONFIG.PURGE_HIGH_WATER, 'inverted pair -> default high');
  assert.equal(t.low, CONFIG.PURGE_LOW_WATER, 'inverted pair -> default low (BOTH fall back)');
  assert.equal(t.fellBack, true);

  t = resolvePurgeThresholds_(500, 500); // equal is incoherent too (nothing to purge down to)
  assert.equal(t.fellBack, true, 'high == low is rejected, not accepted as a zero-width band');
});

test('buildPurgePlan_ boundaries: at high -> empty; high+1 -> down to LOW; capped by eligible; oldest first', () => {
  const { buildPurgePlan_ } = loadCollector();
  const ids = (n) => Array.from({ length: n }, (_, i) => 'rec' + i);

  assert.equal(buildPurgePlan_(700, 700, 500, ids(700)).length, 0, 'count == high: no-op (strict >)');
  assert.equal(buildPurgePlan_(0, 700, 500, []).length, 0, 'empty table: no-op');

  let plan = buildPurgePlan_(701, 700, 500, ids(650));
  assert.equal(plan.length, 201, 'high+1 deletes down to LOW (701 - 500), not just below HIGH');
  assert.equal(plan[0], 'rec0', 'oldest first (input order preserved)');
  assert.equal(plan[200], 'rec200');

  plan = buildPurgePlan_(800, 700, 500, ids(40));
  assert.equal(plan.length, 40, 'eligible < needed: delete ALL eligible, never invent ids');
  assert.equal(plan[39], 'rec39');
});

test('chunk_ splits the plan into REST-cap batches of 10', () => {
  const { chunk_ } = loadCollector();
  const ids = Array.from({ length: 25 }, (_, i) => 'r' + i);

  const batches = chunk_(ids, 10);
  assert.equal(batches.length, 3, '25 ids -> 10 + 10 + 5');
  assert.equal(batches[0].length, 10);
  assert.equal(batches[2].length, 5);
  assert.equal(batches[2][4], 'r24', 'order preserved across batches');
  assert.equal(chunk_([], 10).length, 0, 'empty plan -> no batches');
  assert.equal(chunk_(ids.slice(0, 20), 10).length, 2, 'exact multiple -> no empty tail batch');
});

test("purgeEligibilityFormula_ pins THE guard verbatim: Status='Processed' only, min-age 2 days", () => {
  const { purgeEligibilityFormula_, CONFIG } = loadCollector();
  assert.equal(CONFIG.PURGE_MIN_AGE_DAYS, 2, 'the CONFIG min-age constant this slice ships');
  assert.equal(
    purgeEligibilityFormula_(),
    "AND({Status}='Processed', IS_BEFORE({CollectedAt}, DATEADD(NOW(), -2, 'days')))",
    'weakening the Processed-only / min-age filter must flip this test'
  );
  assert.ok(!purgeEligibilityFormula_().includes("'New'"), "the formula never selects Status='New'");
});

// ---------- integration: drive purgeRawEmailsLocked_ with stubbed globals ----------

// The stub models a RawEmails table of `total` records (ids rec0..rec<total-1>, oldest
// first); the eligible (Processed + old enough) subset is the OLDEST `eligibleCount` of
// them. GETs paginate at 100 via Airtable-style offsets; a GET carrying filterByFormula
// serves the eligible subset, sorted asc like the real API. DELETEs record their ids.
function runPurge({ total, eligibleCount, props = {}, dryRun = false, listCode = 200, deleteCode = 200, expectThrow = false }) {
  const gas = loadCollector();
  const allIds = Array.from({ length: total }, (_, i) => 'rec' + i);
  const eligibleIds = allIds.slice(0, eligibleCount);
  const calls = { lists: [], deletes: [] };

  function pageOf(ids, offsetParam) {
    const start = offsetParam ? parseInt(offsetParam, 10) : 0;
    const page = ids.slice(start, start + 100);
    const body = { records: page.map(id => ({ id, fields: { MessageId: 'mid-' + id } })) };
    if (start + 100 < ids.length) body.offset = String(start + 100);
    return body;
  }

  gas.setGlobals({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => {
          if (k === 'DRY_RUN') return dryRun ? 'true' : null;
          if (k === 'AIRTABLE_TOKEN') return 'tok';
          return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null;
        },
      }),
    },
    Utilities: { sleep: () => {} }, // rate-limit pacing is a no-op under test
    UrlFetchApp: {
      fetch: (url, opts) => {
        if ((opts.method || 'get').toLowerCase() === 'delete') {
          const ids = [...url.matchAll(/records%5B%5D=([^&]+)/g)].map(m => decodeURIComponent(m[1]));
          calls.deletes.push(ids);
          return {
            getResponseCode: () => deleteCode,
            getContentText: () => (deleteCode === 200 ? JSON.stringify({ records: ids.map(id => ({ id, deleted: true })) }) : 'DELETE ERR'),
          };
        }
        calls.lists.push(url);
        if (listCode !== 200) return { getResponseCode: () => listCode, getContentText: () => 'LIST ERR' };
        const offsetMatch = url.match(/[?&]offset=([^&]+)/);
        const body = pageOf(url.includes('filterByFormula=') ? eligibleIds : allIds,
          offsetMatch && decodeURIComponent(offsetMatch[1]));
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      },
    },
  });

  let threw = null;
  try {
    gas.purgeRawEmailsLocked_();
  } catch (e) {
    if (!expectThrow) throw e; // an unexpected throw must fail the calling test
    threw = e;
  }

  const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };
  return { calls, threw, logs: gas.logs.map(fmt), deletedIds: calls.deletes.flat() };
}

test('over high-water: deletes the oldest eligible down to low-water, paginated count, batches of <=10', () => {
  const r = runPurge({ total: 750, eligibleCount: 300 });

  assert.equal(r.deletedIds.length, 250, '750 -> low-water 500 means 250 deletes');
  assert.equal(r.deletedIds[0], 'rec0', 'oldest first');
  assert.equal(r.deletedIds[249], 'rec249', 'stops exactly at the low-water mark');
  assert.ok(r.calls.deletes.every(b => b.length <= 10), "no DELETE exceeds the REST API's 10-record cap");
  assert.equal(r.calls.deletes.length, 25, '250 ids / 10 per request');

  const countLists = r.calls.lists.filter(u => !u.includes('filterByFormula='));
  assert.equal(countLists.length, 8, '750 records / pageSize 100 -> 8 paginated count calls');
  assert.ok(r.calls.lists.every(u => u.includes('fields%5B%5D=MessageId') && u.includes('pageSize=100')),
    'every list call is the cheap single-field 100-page form');

  assert.ok(r.logs.some(l => l === 'Purge: count=750 high=700 low=500 eligible=300 deleted=250 remaining=500'),
    'the once-per-run summary log line, exact format');
});

test("eligibility cannot touch Status='New': the Processed filter is IN the request and every deleted id came from it", () => {
  // Acceptance criterion 3: assert the actual filter sent to Airtable, not just the
  // helper. eligibleCount=60 < needed (250), so the run also proves it deletes ONLY
  // what the filtered list returned and never reaches into the unfiltered count list.
  const r = runPurge({ total: 750, eligibleCount: 60 });

  const eligibleLists = r.calls.lists.filter(u => u.includes('filterByFormula='));
  assert.ok(eligibleLists.length >= 1, 'eligible rows are requested via filterByFormula');
  const expectedFilter = 'filterByFormula=' +
    encodeURIComponent("AND({Status}='Processed', IS_BEFORE({CollectedAt}, DATEADD(NOW(), -2, 'days')))");
  assert.ok(eligibleLists.every(u => u.includes(expectedFilter)),
    'the exact Processed-only + min-age formula is sent to Airtable (server-side enforcement)');
  assert.ok(eligibleLists.every(u => u.includes('sort%5B0%5D%5Bfield%5D=CollectedAt') && u.includes('sort%5B0%5D%5Bdirection%5D=asc')),
    'oldest-first is a server-side sort, not an assumption');

  assert.equal(r.deletedIds.length, 60, 'eligible < needed: only the eligible are deleted');
  assert.ok(r.deletedIds.every(id => Number(id.slice(3)) < 60),
    'no id outside the filtered (Processed) set is ever deleted');
  assert.ok(r.logs.some(l => l === 'Purge: count=750 high=700 low=500 eligible=60 deleted=60 remaining=690'));
});

test('never deletes at/below high-water, even with eligible rows present (mutation-checked)', () => {
  // count == high exactly, and EVERY row is eligible — if the count<=high early exit
  // were removed, the run would list and delete 200 rows, flipping both asserts.
  const r = runPurge({ total: 700, eligibleCount: 700 });
  assert.equal(r.deletedIds.length, 0, 'no DELETE call at count == high');
  assert.equal(r.calls.lists.filter(u => u.includes('filterByFormula=')).length, 0,
    'the eligibility list is never even requested below the trigger');
  assert.ok(r.logs.some(l => l === 'Purge: count=700 high=700 — nothing to do.'), 'no-op log line, exact format');
});

test('starvation (normal pre-M6): over high-water with 0 eligible warns and exits cleanly — until PURGE_EMERGENCY', () => {
  // Below the emergency threshold: log the capacity warning, do not throw.
  let r = runPurge({ total: 720, eligibleCount: 0 });
  assert.equal(r.threw, null);
  assert.equal(r.deletedIds.length, 0);
  assert.ok(r.logs.some(l => l === 'Purge: over high-water (720) but 0 eligible rows — capacity risk, manual action may be needed.'));

  // Boundary: 949 still warns…
  r = runPurge({ total: 949, eligibleCount: 0 });
  assert.equal(r.threw, null, 'PURGE_EMERGENCY - 1 still exits cleanly');

  // …950 throws (Failed execution -> failure email BEFORE Airtable blocks writes).
  r = runPurge({ total: 950, eligibleCount: 0, expectThrow: true });
  assert.ok(r.threw, 'count >= PURGE_EMERGENCY with 0 eligible must throw — deleting the throw flips this');
  assert.match(r.threw.message, /count=950 >= PURGE_EMERGENCY=950/);
  assert.match(r.threw.message, /manual action required/);
  assert.equal(r.deletedIds.length, 0, 'the emergency path never deletes anything');
});

test('DRY_RUN: logs the full plan (count, eligible, would-delete ids) and deletes nothing', () => {
  const r = runPurge({ total: 750, eligibleCount: 300, dryRun: true });
  assert.equal(r.deletedIds.length, 0, 'no DELETE call in DRY_RUN');
  const planLog = r.logs.find(l => l.startsWith('DRY_RUN: would delete'));
  assert.ok(planLog, 'plan logged');
  assert.ok(planLog.startsWith('DRY_RUN: would delete 250 of 300 eligible row(s), oldest first: rec0, rec1,'),
    'plan names the would-delete ids, oldest first');
  assert.ok(r.logs.some(l => l === 'Purge: count=750 high=700 low=500 eligible=300 deleted=0 remaining=750 (DRY_RUN — nothing deleted)'),
    'summary line shows deleted=0 and flags DRY_RUN');
});

test('thresholds are runtime-tunable Script Properties; HIGH<=LOW falls back to both defaults (logged)', () => {
  // Tuned down: HIGH=600 / LOW=400 make a 650-row table purgeable.
  let r = runPurge({ total: 650, eligibleCount: 650, props: { PURGE_HIGH_WATER: '600', PURGE_LOW_WATER: '400' } });
  assert.equal(r.deletedIds.length, 250, '650 -> tuned low-water 400');
  assert.ok(r.logs.some(l => l === 'Purge: count=650 high=600 low=400 eligible=650 deleted=250 remaining=400'));

  // Incoherent pair: BOTH fall back to defaults (700/500) -> 650 <= 700 -> nothing to do.
  r = runPurge({ total: 650, eligibleCount: 650, props: { PURGE_HIGH_WATER: '400', PURGE_LOW_WATER: '500' } });
  assert.equal(r.deletedIds.length, 0, 'the half-valid pair is not trusted');
  assert.ok(r.logs.some(l => l === 'Purge thresholds misconfigured (high 400 <= low 500); using defaults high=700 low=500.'));
  assert.ok(r.logs.some(l => l === 'Purge: count=650 high=700 — nothing to do.'));
});

test('a PERSISTENT transient (503) on list still fails loud — after the retry wrapper exhausts its backoff', () => {
  // airtableListRecords_ now goes through airtableFetchWithRetry_, so a 503 is retried [1s,2s,4s]
  // (sleep is a no-op under test) — 4 attempts on the first count page — before the FINAL 503
  // trips the same fail-loud throw as before. A transient that persists past the retries behaves
  // exactly as it used to: Failed execution -> failure email, never a silent partial list.
  const r = runPurge({ total: 750, eligibleCount: 300, listCode: 503, expectThrow: true });
  assert.ok(r.threw);
  assert.match(r.threw.message, /Airtable list error 503: LIST ERR/);
  assert.equal(r.calls.lists.length, 4, '1 + 3 retries on the count list before giving up');
  assert.equal(r.deletedIds.length, 0, 'a failed list never reaches the delete phase');
});

test('a deterministic 4xx (422) on delete passes straight through the wrapper and throws on the first DELETE', () => {
  // 422 is NOT transient, so airtableFetchWithRetry_ returns it on attempt 1 (no backoff burned on
  // a validation reject) and airtableDeleteRecords_ throws — the first failed DELETE stops the run.
  const r = runPurge({ total: 750, eligibleCount: 300, deleteCode: 422, expectThrow: true });
  assert.ok(r.threw);
  assert.match(r.threw.message, /Airtable delete error 422: DELETE ERR/);
  assert.equal(r.calls.deletes.length, 1, 'a deterministic 4xx is not retried (throw, not continue)');
});

test('a PERSISTENT transient (503) on delete is retried, then fails loud on the FINAL non-200', () => {
  // The purge fires deletes back-to-back at ~4 req/s, where a 429/5xx is the likeliest blip. A 503
  // is a server-side reject that removed nothing, so it is safe to retry (unlike a transport throw,
  // which DELETE never retries — retryOnThrow:false). Here the 503 persists, so the first batch is
  // attempted 4 times (1 + 3 retries) and then the final 503 throws — fail-loud preserved.
  const r = runPurge({ total: 750, eligibleCount: 300, deleteCode: 503, expectThrow: true });
  assert.ok(r.threw);
  assert.match(r.threw.message, /Airtable delete error 503: DELETE ERR/);
  assert.equal(r.calls.deletes.length, 4, '1 + 3 retries on the first DELETE batch before giving up');
  assert.ok(r.calls.deletes.every(b => b.length <= 10), 'each retried DELETE still respects the 10-id cap');
});
