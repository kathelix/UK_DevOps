'use strict';

// Coverage for tracker-URL resolution (slice feature/tracker-url-resolution):
//   harvestHrefs_ / dedupe_       -> pull href values out of the HTML, in order, deduped
//   decodeEntities_               -> &amp; etc. decoded so we fetch the REAL url
//   hostOf_ / pathOf_             -> the URL-shape primitives behind classification
//   classifyTracker_             -> tracker vs non-tracker (exact + '*.suffix' wildcard + path pin)
//   isJunkLink_                   -> unsubscribe/manage/pixel/cv-upload rejected even on a tracker host
//   resolveTracker_               -> the header-only 3xx hop loop (single/multi/max/non-3xx/exception)
//   resolveTrackersInHtml_        -> the whole per-message path: harvest -> classify -> junk-filter ->
//                                    dedupe -> resolve (capped) -> IN-PLACE swap, plus the found/resolved
//                                    metric, the shared cap, dry-run, and the disabled byte-identical parity
//   logTrackerSummary_            -> the per-run "Trackers:" structured log
//
// The fetch is injected (resolveTracker_(url, fetchFn) / ctx.fetchFn) so these feed canned
// 302/Location sequences with no real network. Returned objects live in the VM realm, so we
// assert on primitive leaves (.html / .found / .label / numbers), never deepStrictEqual.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

// A UrlFetchApp-style response with a status code and (optional) Location header.
function resp(code, location) {
  return {
    getResponseCode: () => code,
    getAllHeaders: () => (location === undefined ? {} : { Location: location }),
  };
}

// fetchFn from a { url: resp | 'throw' } map; records the urls it was called with. Unmapped
// urls default to a bare 200 (a dead end -> unresolved), which keeps the chains explicit.
function cannedFetch(map) {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    const r = map[url];
    if (r === 'throw') throw new Error('simulated network failure');
    return r || resp(200);
  };
  fn.calls = calls;
  return fn;
}

// A fresh run-scoped ctx like collectJobEmailsLocked_ builds, with an injected fetch.
function makeCtx(overrides) {
  return Object.assign(
    { maxResolutions: 100, dryRun: false, fetchFn: cannedFetch({}), used: 0, attempted: 0, found: 0, resolved: 0, tally: {} },
    overrides || {}
  );
}

// Realistic tracker / canonical shapes used across the swap + resolve tests.
const REED_TRACKER = 'https://clicks.reed.co.uk/f/a/AbC123xy/applicant';
const REED_CANON = 'https://www.reed.co.uk/jobs/devops-engineer/53219455';
const NIJOBS_TRACKER = 'https://click.nijobs.com/f/a/Zz9/job';
const NIJOBS_CANON = 'https://www.nijobs.com/job/9912345';

// ---------- harvestHrefs_ / dedupe_ ----------

test('harvestHrefs_ pulls every href value (both quote styles), in order, skipping empties', () => {
  const { harvestHrefs_ } = loadCollector();
  const html = `<a href="https://a.test/1">x</a><img src="p.png"><a href='https://b.test/2'>y</a><a href="">z</a>`;
  const hrefs = harvestHrefs_(html);
  assert.equal(hrefs.length, 2, 'two non-empty hrefs (the empty href is skipped)');
  assert.equal(hrefs[0], 'https://a.test/1');
  assert.equal(hrefs[1], 'https://b.test/2', "single-quoted href captured too");
});

test('harvestHrefs_ keeps duplicates (the dedupe is a separate, explicit step)', () => {
  const { harvestHrefs_ } = loadCollector();
  const html = `<a href="https://x.test/1">a</a><a href="https://x.test/1">b</a>`;
  assert.equal(harvestHrefs_(html).length, 2);
});

test('dedupe_ keeps first occurrence, drops later repeats, preserves order', () => {
  const { dedupe_ } = loadCollector();
  // Join to a primitive: the returned array lives in the VM realm (deepStrictEqual vs a Node
  // literal would fail the prototype check).
  assert.equal(dedupe_(['b', 'a', 'b', 'c', 'a']).join(','), 'b,a,c');
});

// ---------- decodeEntities_ ----------

test('decodeEntities_ turns &amp; (and numeric/hex/named forms) into the real URL', () => {
  const { decodeEntities_ } = loadCollector();
  assert.equal(decodeEntities_('https://t/x?u=1&amp;s=2'), 'https://t/x?u=1&s=2', 'the dominant &amp; case');
  assert.equal(decodeEntities_('a&#38;b'), 'a&b', 'numeric decimal entity');
  assert.equal(decodeEntities_('a&#x26;b'), 'a&b', 'numeric hex entity');
  assert.equal(decodeEntities_('a&amp;b&amp;c'), 'a&b&c', 'all occurrences');
  assert.equal(decodeEntities_('https://t/x?u=1&s=2'), 'https://t/x?u=1&s=2', 'already-decoded url is unchanged');
});

// ---------- hostOf_ / pathOf_ ----------

test('hostOf_ lowercases the host and strips the port; pathOf_ returns the path (default /)', () => {
  const { hostOf_, pathOf_ } = loadCollector();
  assert.equal(hostOf_('https://Clicks.Reed.CO.uk/f/a/x?z=1'), 'clicks.reed.co.uk');
  assert.equal(hostOf_('http://host.test:8080/p'), 'host.test');
  assert.equal(hostOf_('not-a-url'), '', 'non-http(s) -> empty host');
  assert.equal(pathOf_('https://h.test/dispatch?z=1'), '/dispatch');
  assert.equal(pathOf_('https://h.test'), '/', 'no path -> /');
  assert.equal(pathOf_('https://h.test?z=1'), '/', 'query-only -> /');
});

// ---------- classifyTracker_ ----------

test('classifyTracker_ matches exact tracker hosts and ignores non-trackers', () => {
  const { classifyTracker_ } = loadCollector();
  assert.equal(classifyTracker_(REED_TRACKER).label, 'reed', 'exact host clicks.reed.co.uk');
  assert.equal(classifyTracker_('https://CLICKS.REED.CO.UK/f/a/x').label, 'reed', 'host match is case-insensitive');
  assert.equal(classifyTracker_(REED_CANON), null, 'www.reed.co.uk is the canonical, not a tracker');
  assert.equal(classifyTracker_('https://www.linkedin.com/jobs/view/789'), null, 'unrelated host');
});

test('classifyTracker_ honours the "*.suffix" wildcard for both apex and subdomains', () => {
  const { classifyTracker_ } = loadCollector();
  assert.equal(classifyTracker_('https://u4567.ct.sendgrid.net/ls/click?upn=x').label, 'sendgrid', 'subdomain of ct.sendgrid.net');
  assert.equal(classifyTracker_('https://web.jobmails.io/c/abc').label, 'jobmails', 'subdomain of jobmails.io');
  assert.equal(classifyTracker_('https://jobmails.io/c/abc').label, 'jobmails', 'apex matches *.jobmails.io too');
  assert.equal(classifyTracker_('https://notjobmails.io/c/abc'), null, 'a host that merely ENDS in jobmails.io without a dot boundary is not matched');
});

test('classifyTracker_ enforces the path pin on shared hosts (no over-clicking real pages)', () => {
  const { classifyTracker_ } = loadCollector();
  // joblookup.com is only a tracker on /dispatch; uk.whatjobs.com only on /jbe...
  assert.equal(classifyTracker_('https://joblookup.com/dispatch?j=1').label, 'joblookup');
  assert.equal(classifyTracker_('https://joblookup.com/jobs/devops-123'), null, 'a real listing page on the same host is NOT a tracker');
  assert.equal(classifyTracker_('https://uk.whatjobs.com/jbe/abc').label, 'whatjobs');
  assert.equal(classifyTracker_('https://uk.whatjobs.com/job/abc'), null, 'non-/jbe path on whatjobs is not a tracker');
});

// ---------- isJunkLink_ ----------

test('isJunkLink_ rejects non-job links even though they sit on a tracker host', () => {
  const { isJunkLink_, classifyTracker_ } = loadCollector();
  const junk = [
    'https://clicks.reed.co.uk/f/a/x/unsubscribe',
    'https://clicks.reed.co.uk/manage-alerts/123',
    'https://click.nijobs.com/email-settings',
    'https://clicks.reed.co.uk/view-in-browser/x',
    'https://clicks.reed.co.uk/tracking-pixel.gif',
    'https://click.nijobs.com/cv-upload',
    'https://clicks.reed.co.uk/preferences',
  ];
  for (const u of junk) {
    assert.ok(classifyTracker_(u), `${u} is on a tracker host`);
    assert.ok(isJunkLink_(u), `${u} must be junk-filtered`);
  }
  assert.ok(!isJunkLink_(REED_TRACKER), 'a real job tracker is not junk');
  assert.ok(!isJunkLink_(NIJOBS_TRACKER), 'a real job tracker is not junk');
});

// ---------- resolveTracker_ (the 3xx hop loop) ----------

test('resolveTracker_ returns the canonical on a single 302 hop', () => {
  const { resolveTracker_ } = loadCollector();
  const fetch = cannedFetch({ [REED_TRACKER]: resp(302, REED_CANON) });
  assert.equal(resolveTracker_(REED_TRACKER, fetch), REED_CANON);
  assert.equal(fetch.calls.length, 1, 'one fetch: the canonical is never itself fetched');
});

test('resolveTracker_ follows multiple tracker hops to the first non-tracker URL', () => {
  const { resolveTracker_ } = loadCollector();
  const hop1 = 'https://click.nijobs.com/f/a/hop1';
  const hop2 = 'https://u9.ct.sendgrid.net/ls/click?upn=hop2';
  const fetch = cannedFetch({
    [REED_TRACKER]: resp(302, hop1),
    [hop1]: resp(301, hop2),
    [hop2]: resp(302, NIJOBS_CANON),
  });
  assert.equal(resolveTracker_(REED_TRACKER, fetch), NIJOBS_CANON, 'first non-tracker reached');
  assert.equal(fetch.calls.length, 3, 'three tracker hops fetched, canonical not fetched');
});

test('resolveTracker_ gives up after RESOLVE_MAX_HOPS while still on a tracker (-> unresolved)', () => {
  const { resolveTracker_, CONFIG } = loadCollector();
  // A chain of tracker->tracker redirects longer than the hop budget never reaches a canonical.
  const chain = {};
  for (let i = 0; i < CONFIG.RESOLVE_MAX_HOPS + 2; i++) {
    chain[`https://clicks.reed.co.uk/f/a/${i}`] = resp(302, `https://clicks.reed.co.uk/f/a/${i + 1}`);
  }
  const fetch = cannedFetch(chain);
  assert.equal(resolveTracker_('https://clicks.reed.co.uk/f/a/0', fetch), null, 'still a tracker after max hops');
  assert.equal(fetch.calls.length, CONFIG.RESOLVE_MAX_HOPS, 'fetches are capped at RESOLVE_MAX_HOPS');
});

test('resolveTracker_ leaves the original on a non-3xx, missing/relative Location, or exception', () => {
  const { resolveTracker_ } = loadCollector();
  assert.equal(resolveTracker_(REED_TRACKER, cannedFetch({ [REED_TRACKER]: resp(200) })), null, '200 -> unresolved');
  assert.equal(resolveTracker_(REED_TRACKER, cannedFetch({ [REED_TRACKER]: resp(404) })), null, '404 -> unresolved');
  assert.equal(resolveTracker_(REED_TRACKER, cannedFetch({ [REED_TRACKER]: resp(302) })), null, '302 without Location -> unresolved');
  assert.equal(resolveTracker_(REED_TRACKER, cannedFetch({ [REED_TRACKER]: resp(302, '/jobs/123') })), null, 'relative Location -> unresolved (v1 does not join)');
  assert.equal(resolveTracker_(REED_TRACKER, cannedFetch({ [REED_TRACKER]: 'throw' })), null, 'fetch exception -> unresolved');
});

// ---------- resolveTrackersInHtml_ (per-message path: swap + metric + cap) ----------

test('resolveTrackersInHtml_ swaps a resolved tracker href in place and counts it', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  // The href is entity-encoded (&amp;) as it is in real HTML.
  const encoded = 'https://clicks.reed.co.uk/f/a/x?u=1&amp;s=2';
  const decoded = 'https://clicks.reed.co.uk/f/a/x?u=1&s=2';
  const fetch = cannedFetch({ [decoded]: resp(302, REED_CANON) });
  const ctx = makeCtx({ fetchFn: fetch });
  const html = `<a href="${encoded}">DevOps Engineer</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(fetch.calls[0], decoded, 'entity-decoded URL is what gets fetched (not the &amp; form)');
  assert.ok(out.html.includes(REED_CANON), 'canonical is swapped into the HTML');
  assert.ok(!out.html.includes('clicks.reed.co.uk'), 'the tracker is gone from the HTML');
  assert.equal(out.found, 1);
  assert.equal(out.resolved, 1);
  assert.equal(ctx.found, 1);
  assert.equal(ctx.resolved, 1);
  assert.equal(ctx.attempted, 1);
  assert.equal(ctx.tally.reed.found, 1);
  assert.equal(ctx.tally.reed.resolved, 1);
});

test('resolveTrackersInHtml_ resolves a repeated tracker once and swaps EVERY occurrence', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({ [REED_TRACKER]: resp(302, REED_CANON) });
  const ctx = makeCtx({ fetchFn: fetch });
  const html = `<a href="${REED_TRACKER}">title</a> ... <a href="${REED_TRACKER}">apply</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(fetch.calls.length, 1, 'deduped within the message -> one fetch');
  assert.equal(out.html.split(REED_CANON).length - 1, 2, 'both occurrences swapped to the canonical');
  assert.ok(!out.html.includes('clicks.reed.co.uk'), 'no tracker left');
  assert.equal(out.found, 1, 'distinct trackers, not occurrences');
  assert.equal(out.resolved, 1);
});

test('resolveTrackersInHtml_ leaves non-tracker and junk links untouched and uncounted', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({});
  const ctx = makeCtx({ fetchFn: fetch });
  const html = `<a href="https://www.linkedin.com/jobs/view/789">real link</a>` +
    `<a href="https://clicks.reed.co.uk/f/a/x/unsubscribe">opt out</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(out.html, html, 'HTML is byte-identical: nothing resolvable');
  assert.equal(out.found, 0, 'a non-tracker and a junk-on-tracker link are both uncounted');
  assert.equal(fetch.calls.length, 0, 'no network for non-trackers or junk');
});

test('resolveTrackersInHtml_ keeps the original when a tracker fails to resolve', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({ [REED_TRACKER]: resp(200) }); // dead end -> unresolved
  const ctx = makeCtx({ fetchFn: fetch });
  const html = `<a href="${REED_TRACKER}">x</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(out.html, html, 'unresolved tracker stays in place');
  assert.equal(out.found, 1, 'still counted as found (the denominator)');
  assert.equal(out.resolved, 0);
  assert.equal(ctx.tally.reed.found, 1);
  assert.equal(ctx.tally.reed.resolved, 0, 'the found bump created the bucket; resolved stays 0 for an unresolved tracker');
});

test('resolveTrackersInHtml_ shares the cap across the run: once hit, later trackers are found-not-resolved', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({
    [REED_TRACKER]: resp(302, REED_CANON),
    [NIJOBS_TRACKER]: resp(302, NIJOBS_CANON),
  });
  const ctx = makeCtx({ maxResolutions: 1, fetchFn: fetch });
  const html = `<a href="${REED_TRACKER}">a</a><a href="${NIJOBS_TRACKER}">b</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(out.found, 2, 'both trackers detected');
  assert.equal(out.resolved, 1, 'only the first is resolved (cap = 1)');
  assert.equal(ctx.attempted, 1, 'only one network attempt');
  assert.equal(fetch.calls.length, 1, 'the second tracker is never fetched');
  assert.ok(out.html.includes(REED_CANON), 'first tracker swapped');
  assert.ok(out.html.includes(NIJOBS_TRACKER), 'second tracker left in place (cap hit)');
});

test('resolveTrackersInHtml_ with maxResolutions=0 is a pure no-op: no fetch, byte-identical HTML', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({ [REED_TRACKER]: resp(302, REED_CANON) });
  const ctx = makeCtx({ maxResolutions: 0, fetchFn: fetch });
  const html = `<a href="${REED_TRACKER}">x</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(out.html, html, 'disabled -> CleanText source is byte-identical to pre-slice');
  assert.equal(out.found, 0);
  assert.equal(out.resolved, 0);
  assert.equal(fetch.calls.length, 0, 'kill-switch makes ZERO network calls');
});

test('resolveTrackersInHtml_ on a body with no trackers is a byte-identical no-op', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({});
  const ctx = makeCtx({ fetchFn: fetch });
  const html = '<p>No links here at all.</p>';
  const out = resolveTrackersInHtml_(html, ctx);
  assert.equal(out.html, html);
  assert.equal(out.found, 0);
  assert.equal(out.resolved, 0);
  assert.equal(fetch.calls.length, 0);
});

test('resolveTrackersInHtml_ in dry-run counts trackers but never clicks or swaps', () => {
  const { resolveTrackersInHtml_ } = loadCollector();
  const fetch = cannedFetch({ [REED_TRACKER]: resp(302, REED_CANON) });
  const ctx = makeCtx({ dryRun: true, fetchFn: fetch });
  const html = `<a href="${REED_TRACKER}">x</a>`;

  const out = resolveTrackersInHtml_(html, ctx);

  assert.equal(out.html, html, 'dry-run does not swap (CleanText preview is today\'s text)');
  assert.equal(out.found, 1, 'the would-be tracker is still counted');
  assert.equal(out.resolved, 0, 'nothing resolved in a dry run');
  assert.equal(fetch.calls.length, 0, 'a dry run clicks nothing');
  assert.equal(ctx.attempted, 0);
});

// ---------- logTrackerSummary_ ----------

// Render a captured Logger.log call (arg-array) into its final %s-substituted string.
const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };

test('logTrackerSummary_ prints the rate and per-host found/resolved', () => {
  const gas = loadCollector();
  const ctx = makeCtx({ found: 8, resolved: 6, attempted: 8, tally: { reed: { found: 5, resolved: 5 }, sendgrid: { found: 3, resolved: 1 } } });
  gas.logTrackerSummary_(ctx);
  const line = gas.logs.map(fmt).find(l => l.startsWith('Trackers:'));
  assert.ok(line.includes('found=8 resolved=6 (75%)'), 'rate = resolved/found');
  assert.ok(line.includes('reed 5/5'), 'per-host resolved/found');
  assert.ok(line.includes('sendgrid 1/3'));
  assert.ok(!line.includes('attempted='), 'attempted omitted when the cap was not hit');
});

test('logTrackerSummary_ adds attempted=N only when the cap stopped us short of found', () => {
  const gas = loadCollector();
  const ctx = makeCtx({ found: 10, resolved: 6, attempted: 6, tally: { reed: { found: 10, resolved: 6 } } });
  gas.logTrackerSummary_(ctx);
  const line = gas.logs.map(fmt).find(l => l.startsWith('Trackers:'));
  assert.ok(line.includes('attempted=6'), 'attempted shown because attempted (6) < found (10)');
});

test('logTrackerSummary_ reports the disabled, zero-found, and dry-run cases distinctly', () => {
  let gas = loadCollector();
  gas.logTrackerSummary_(makeCtx({ maxResolutions: 0 }));
  assert.ok(gas.logs.map(fmt).some(l => l.includes('resolution disabled (MAX_RESOLUTIONS_PER_RUN=0)')));

  gas = loadCollector();
  gas.logTrackerSummary_(makeCtx({ found: 0 }));
  assert.ok(gas.logs.map(fmt).some(l => l.includes('found=0 (no known trackers this run)')));

  gas = loadCollector();
  gas.logTrackerSummary_(makeCtx({ dryRun: true, found: 4, tally: { reed: { found: 4, resolved: 0 } } }));
  assert.ok(gas.logs.map(fmt).some(l => l.includes('found=4') && l.includes('dry run')));
});
