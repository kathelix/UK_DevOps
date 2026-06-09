'use strict';

// Coverage for the offline link-cleanup stage (slice feature/offline-link-cleanup). Every
// function here is pure and OFFLINE — no fetch, no network of any kind. Under test:
//   harvestUrls_                -> pull every URL (href + bare text) out of the HTML, trimmed, deduped
//   splitUrl_ / schemeHostOf_   -> the URL-shape primitives the decode step builds on
//   decodeEmbeddedDestination_  -> (a) decode the FIRST query param whose value is a URL/path
//   stripUtm_                   -> (b) drop utm_* params, preserving order / separators / #fragment
//   cleanUrl_                   -> (a) then (b) for one URL; byte-identical when nothing changes
//   cleanLinksInHtml_           -> harvest -> clean -> in-place swap + the per-run metric
//
// Returned objects / arrays live in the VM realm, so we assert on primitive leaves (.url,
// .decoded, strings, numbers, Array#join) — never deepStrictEqual against a Node literal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector } = require('./helpers/load-collector');

const gas = loadCollector();

// ---------- harvestUrls_ ----------

test('harvestUrls_ finds href="…" values AND bare-text URLs, both quote styles', () => {
  const html = `<a href="https://a.test/1">x</a> visit https://b.test/2 now <a href='https://c.test/3'>y</a>`;
  const urls = gas.harvestUrls_(html).join('\n');
  assert.match(urls, /^https:\/\/a\.test\/1$/m, 'double-quoted href');
  assert.match(urls, /^https:\/\/b\.test\/2$/m, 'bare-text URL');
  assert.match(urls, /^https:\/\/c\.test\/3$/m, 'single-quoted href');
});

test('harvestUrls_ trims trailing punctuation but keeps the URL itself', () => {
  assert.equal(gas.harvestUrls_('see http://t.test/job?x=1).')[0], 'http://t.test/job?x=1');
  assert.equal(gas.harvestUrls_('end http://t.test/a?b=c,')[0], 'http://t.test/a?b=c');
});

test('harvestUrls_ dedupes — each unique URL once, first-occurrence order', () => {
  const html = `<a href="https://x.test/1">a</a><a href="https://x.test/1">b</a><a href="https://y.test/2">c</a>`;
  assert.equal(gas.harvestUrls_(html).join(','), 'https://x.test/1,https://y.test/2');
});

// ---------- trimTrailingPunct_ (linear, ReDoS-safe) ----------

test('trimTrailingPunct_ strips a trailing run of the punctuation set, and only trailing', () => {
  assert.equal(gas.trimTrailingPunct_('http://t.test/job?x=1).'), 'http://t.test/job?x=1');
  assert.equal(gas.trimTrailingPunct_('http://t.test/a,b'), 'http://t.test/a,b', 'inner punctuation kept');
  assert.equal(gas.trimTrailingPunct_('http://t.test/a'), 'http://t.test/a', 'nothing to trim');
});

test('trimTrailingPunct_ is linear on a pathological input (the anchored-regex ReDoS worst case)', () => {
  // A long punct run followed by a non-punct char is /[…]+$/'s O(n^2) worst case (the old impl
  // took ~16s at 100k). The char-walk returns instantly; a generous bound makes a regression
  // (revert to the anchored regex) flip this assertion rather than just slow the suite.
  const worst = 'http://t.test/' + ')'.repeat(100000) + 'a';
  const t0 = process.hrtime.bigint();
  assert.equal(gas.trimTrailingPunct_(worst), worst, 'trailing non-punct char => nothing trimmed');
  assert.equal(gas.trimTrailingPunct_('http://t.test/a' + ')'.repeat(100000)), 'http://t.test/a', 'full run trimmed');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `expected linear time, took ${ms.toFixed(1)}ms`);
});

// ---------- splitUrl_ / schemeHostOf_ ----------

test('splitUrl_ separates base, query (no leading ?), and fragment (with leading #)', () => {
  const p = gas.splitUrl_('https://h.test/p?a=1&b=2#frag');
  assert.equal(p.base, 'https://h.test/p');
  assert.equal(p.query, 'a=1&b=2');
  assert.equal(p.fragment, '#frag');
  const q = gas.splitUrl_('https://h.test/p');
  assert.equal(q.query, null);
  assert.equal(q.fragment, '');
  const r = gas.splitUrl_('https://h.test/p#sec?notquery'); // '?' inside the fragment is not a delimiter
  assert.equal(r.query, null);
  assert.equal(r.fragment, '#sec?notquery');
});

test('schemeHostOf_ returns scheme://host only (keeps the port), empty for non-http(s)', () => {
  assert.equal(gas.schemeHostOf_('http://www.cv-library.co.uk/refer/1?url=/x'), 'http://www.cv-library.co.uk');
  assert.equal(gas.schemeHostOf_('https://h.test:8080/p'), 'https://h.test:8080');
  assert.equal(gas.schemeHostOf_('/relative/path'), '');
});

// ---------- decodeEmbeddedDestination_ (step a) ----------

test('decode: cv-library-style ?url= relative path -> tracker origin + path (utm still encoded at this step)', () => {
  const url = 'http://www.cv-library.co.uk/refer/100145?url=%2Fjob%2F123%2FDevOps%3Futm_source%3Dx%26utm_medium%3Demail';
  assert.equal(gas.decodeEmbeddedDestination_(url),
    'http://www.cv-library.co.uk/job/123/DevOps?utm_source=x&utm_medium=email');
});

test('decode: absolute embedded http(s) URL is taken verbatim', () => {
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=https%3A%2F%2Fdest.example%2Fjob%2F9'),
    'https://dest.example/job/9');
});

test('decode: the URL/path guard rejects non-URL values (?r=5, ?u=alice) and no-query -> null', () => {
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?r=5'), null);
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=alice'), null);
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r'), null);
});

test('decode: FIRST qualifying param in document order wins (no name list) — incl. the accepted mis-pick', () => {
  // Two URL-valued params: the FIRST is taken even when a "more obvious" one follows. This is
  // the deliberate trade-off for a zero-maintenance value-guard (decided with Ivan).
  assert.equal(
    gas.decodeEmbeddedDestination_('https://t.test/r?img=https%3A%2F%2Fcdn.test%2Flogo.png&url=https%3A%2F%2Fdest.test%2Fjob'),
    'https://cdn.test/logo.png');
  // A non-qualifying param before a qualifying one is skipped through to the real destination.
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?id=42&dest=%2Fjob%2F7'), 'https://t.test/job/7');
});

test('decode: protocol-relative //host is NOT treated as an absolute path', () => {
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?url=%2F%2Fevil.test%2Fx'), null);
});

test('decode: rejects a value that decodes to HTML delimiters / whitespace (no structure injection)', () => {
  // %3C/%3E/%22/%20 decode to live <, >, ", space — inserting those could alter the HTML
  // CLEAN_REGEX sees (a decoded </body> truncates CleanText). Such a value is not a valid URL
  // token, so it is skipped (left as the original tracker), not decoded.
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=' + encodeURIComponent('https://dest.test/</body>')), null, 'angle brackets');
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=' + encodeURIComponent('https://dest.test/a"x')), null, 'double quote');
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=' + encodeURIComponent('/path with space')), null, 'whitespace');
  // A clean destination (no delimiters) still decodes — the guard only rejects the unsafe shape.
  assert.equal(gas.decodeEmbeddedDestination_('https://t.test/r?u=' + encodeURIComponent('https://dest.test/job/9?a=1&b=2')), 'https://dest.test/job/9?a=1&b=2');
});

// ---------- stripUtm_ (step b) ----------

test('stripUtm_ removes every utm_* param, keeps the rest in order + the #fragment', () => {
  const r = gas.stripUtm_('https://h.test/p?a=1&utm_source=s&b=2&utm_medium=m&utm_campaign=c&utm_term=t&utm_content=co&utm_id=i&c=3#sec');
  assert.equal(r.url, 'https://h.test/p?a=1&b=2&c=3#sec');
  assert.equal(r.stripped, true);
});

test('stripUtm_ handles BOTH &amp; and & separators and is case-insensitive on the name', () => {
  const r = gas.stripUtm_('https://h.test/p?a=1&amp;UTM_Source=s&amp;b=2');
  assert.equal(r.url, 'https://h.test/p?a=1&amp;b=2', 'surviving &amp; separator preserved');
  assert.equal(r.stripped, true);
  const r2 = gas.stripUtm_('https://h.test/p?utm_source=s&b=2');
  assert.equal(r2.url, 'https://h.test/p?b=2', 'leading utm dropped, b promoted to first (no stray separator)');
});

test('stripUtm_ does NOT touch a param/path that merely contains "utm" (name must START with utm_)', () => {
  const url = 'https://h.test/utm_guide?utm=1&flutm_x=2&myutm_source=3';
  const r = gas.stripUtm_(url);
  assert.equal(r.url, url);
  assert.equal(r.stripped, false);
});

test('stripUtm_ drops the whole "?" when every param was utm_', () => {
  const r = gas.stripUtm_('https://h.test/p?utm_source=s&utm_medium=m#frag');
  assert.equal(r.url, 'https://h.test/p#frag');
  assert.equal(r.stripped, true);
});

test('stripUtm_ returns the URL byte-identical when there is no utm_ (parity)', () => {
  const url = 'https://h.test/p?a=1&b=2#x';
  const r = gas.stripUtm_(url);
  assert.equal(r.url, url);
  assert.equal(r.stripped, false);
});

// ---------- cleanUrl_ : decode THEN utm ----------

test('cleanUrl_ applies decode then utm-strip — a decoded destination carrying utm is fully cleaned', () => {
  const url = 'http://www.cv-library.co.uk/refer/100145?url=%2Fjob%2F123%2FDevOps%3Futm_source%3Dx%26utm_medium%3Demail';
  const r = gas.cleanUrl_(url);
  assert.equal(r.url, 'http://www.cv-library.co.uk/job/123/DevOps');
  assert.equal(r.decoded, true);
  assert.equal(r.utmStripped, true);
});

test('cleanUrl_ leaves a URL with neither embedded-dest nor utm byte-identical (parity)', () => {
  const url = 'https://www.linkedin.com/jobs/view/789?ref=email';
  const r = gas.cleanUrl_(url);
  assert.equal(r.url, url);
  assert.equal(r.decoded, false);
  assert.equal(r.utmStripped, false);
});

test('cleanUrl_ strips utm even with no embedded destination', () => {
  const r = gas.cleanUrl_('https://board.test/job/55?utm_source=alert&ref=keep');
  assert.equal(r.url, 'https://board.test/job/55?ref=keep');
  assert.equal(r.decoded, false);
  assert.equal(r.utmStripped, true);
});

// ---------- cleanLinksInHtml_ : in-place swap + metric ----------

test('cleanLinksInHtml_ swaps ALL occurrences of a changed URL and tallies the metric', () => {
  const tracker = 'http://t.test/r?url=%2Fjob%2F9%3Futm_source%3Dx';
  const html = `<a href="${tracker}">A</a> ... <a href="${tracker}">again</a>`;
  const res = gas.cleanLinksInHtml_(html);
  assert.equal(res.decoded, 1, 'one UNIQUE changed url -> decoded counted once (not per occurrence)');
  assert.equal(res.utmStripped, 1);
  assert.ok(!res.html.includes('/r?url='), 'every occurrence of the tracker is gone');
  assert.equal((res.html.match(/http:\/\/t\.test\/job\/9/g) || []).length, 2, 'both occurrences swapped to the clean dest');
  assert.equal(res.bytesSaved, html.length - res.html.length);
  assert.ok(res.bytesSaved > 0);
});

test('cleanLinksInHtml_ on html with no qualifying URLs is byte-identical, metric all zero (parity + zero case)', () => {
  const html = `<a href="https://www.example.com/page?ref=1">x</a> bare https://other.test/a#frag`;
  const res = gas.cleanLinksInHtml_(html);
  assert.equal(res.html, html, 'no decode, no utm -> output identical to input');
  assert.equal(res.decoded, 0);
  assert.equal(res.utmStripped, 0);
  assert.equal(res.bytesSaved, 0);
});

test('cleanLinksInHtml_ counts decode-only and utm-only independently', () => {
  const decodeOnly = 'https://t.test/r?u=https%3A%2F%2Fd.test%2Fj'; // decode, no utm on the destination
  const utmOnly = 'https://board.test/j/1?utm_source=x&k=v';        // utm, no embedded destination
  const html = `<a href="${decodeOnly}">a</a><a href="${utmOnly}">b</a>`;
  const res = gas.cleanLinksInHtml_(html);
  assert.equal(res.decoded, 1);
  assert.equal(res.utmStripped, 1);
});

test('cleanLinksInHtml_ does NOT corrupt a decoded destination that embeds another harvested URL', () => {
  // A decodes to a destination that literally contains B (a separate harvested URL). With
  // repeated split/join, processing B after A would strip utm inside A's freshly-inserted
  // destination; the single position-based pass never re-scans inserted text, so both are clean.
  const B = 'https://b.test/x?utm_source=z';
  const A = 'https://t.test/r?u=' + encodeURIComponent('https://landing.test/p?next=' + B);
  const html = `<a href="${A}">a</a> and <a href="${B}">b</a>`;
  const res = gas.cleanLinksInHtml_(html);
  // A's decoded destination is preserved verbatim — its embedded ...?utm_source=z is part of the
  // `next=` value (not a top-level param), so it must survive intact.
  assert.ok(res.html.includes('href="https://landing.test/p?next=https://b.test/x?utm_source=z"'),
    "A's decoded destination is not corrupted by B's swap");
  // Standalone B IS utm-stripped.
  assert.ok(res.html.includes('href="https://b.test/x"'), 'standalone B is utm-stripped');
});

test('cleanLinksInHtml_ + CLEAN_REGEX: a tracker decoding to </body> cannot truncate CleanText (F1)', () => {
  // Codex F1 repro: a sender-controlled tracker whose decoded value contains </body>. The
  // unsafe value is rejected by decode, so the tracker is left in place (still %-encoded) and
  // the HTML structure CLEAN_REGEX sees is unchanged — no truncation of trailing content.
  const tracker = 'https://t.test/r?u=' + encodeURIComponent('https://dest.test/</body>');
  const html = `<html><body>before <a href="${tracker}">job</a> after</body></html>`;
  const cleaned = gas.cleanLinksInHtml_(html);
  assert.equal(cleaned.decoded, 0, 'the unsafe destination is not decoded');
  const re = gas.CLEAN_REGEX;
  re.lastIndex = 0;
  const full = cleaned.html.replace(re, '');
  assert.ok(full.includes('after'), 'trailing content after the link is preserved (not truncated)');
  assert.ok(!full.includes('</body>'), 'no injected </body> materializes into CleanText');
});

test('cleanLinksInHtml_ cleans an href URL even when an HTML entity follows the closing quote', () => {
  // The href closing quote bounds the URL, so a following &nbsp; is NOT absorbed — the real
  // (href-based) corpus is unaffected by the bare-text-plus-entity limitation documented on
  // harvestUrls_ / in KNOWN_ISSUES.
  const tracker = 'http://t.test/r?url=%2Fjob%2F9%3Futm_source%3Dx';
  const html = `<a href="${tracker}">job</a>&nbsp;apply now`;
  const res = gas.cleanLinksInHtml_(html);
  assert.ok(res.html.includes('href="http://t.test/job/9"'), 'href URL decoded + utm-stripped');
  assert.ok(res.html.includes('&nbsp;apply now'), 'the following entity + text are untouched');
  assert.equal(res.decoded, 1);
});

// ---------- end-to-end: a real cv-library tracker email ----------

test('end-to-end: real cv-library job-alert email — cleaner decodes trackers + strips utm, shrinking CleanText', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'email-cv-library.html');
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  assert.ok(!/\r/.test(raw), 'fixture must stay LF-only so the golden lengths are platform-stable');

  const res = gas.cleanLinksInHtml_(raw);

  // Real trackers decoded and utm stripped.
  assert.ok(res.decoded > 0, 'embedded destinations recovered');
  assert.ok(res.utmStripped > 0, 'utm params stripped');
  assert.ok(res.bytesSaved > 0, 'cleanup removes bytes');
  // The opaque /refer/<id>?url= tracker is replaced by the real job URL, utm-free.
  assert.ok(!res.html.includes('/refer/100145?url='), 'no cv-library refer-tracker survives');
  assert.ok(res.html.includes('http://www.cv-library.co.uk/job/225117624/DevOps-Engineer'),
    'a known destination job URL is surfaced');
  assert.ok(!/utm_[a-z]/i.test(res.html), 'no utm_ param remains anywhere');

  // Full pipeline (link cleanup THEN CLEAN_REGEX) yields a smaller CleanText than the regex
  // alone — the link stage is doing real work on top of the existing clean.
  const re = gas.CLEAN_REGEX;
  re.lastIndex = 0;
  const regexOnly = raw.replace(re, '');
  re.lastIndex = 0;
  const fullPipeline = res.html.replace(re, '');
  assert.ok(fullPipeline.length < regexOnly.length, 'link cleanup shrinks the stored CleanText further');

  // Golden values. If the fixture or the cleaner changes intentionally, eyeball the diff and
  // update these in the same commit.
  assert.equal(raw.length, 88696);
  assert.equal(res.decoded, 24);
  assert.equal(res.utmStripped, 24);
  assert.equal(res.bytesSaved, 4464);
  assert.equal(regexOnly.length, 18008);
  assert.equal(fullPipeline.length, 14574);
});
