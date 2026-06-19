'use strict';

// Coverage for the per-sender footer cutoff (slice feature/footer-cutoff, issue #14).
// truncateAtFooter_ is pure: for a sender whose registered domain is mapped in
// FOOTER_MARKERS, it slices the stored CleanText at the LAST occurrence of the domain's
// marker (marker included in the discarded tail) provided that match sits in the trailing
// FOOTER_POSITION_FLOOR portion of the text; an unmapped sender is a byte-identical no-op
// ('none'), a mapped sender whose marker is absent or too early is a byte-identical no-op
// that is flagged ('miss'). It runs in processMessage_ AFTER collapseTableWrappers_ (wiring
// pinned in collect-loop.test.js); these tests drive the pure function directly, plus a
// value-pinning corpus pass over the mapped fixtures through the full pipeline
// (link cleanup -> CLEAN_REGEX -> unwrap -> footer cutoff).
//
// All assertions are on primitives (strings / numbers) — VM-realm objects are never
// deepStrictEqual'd against Node literals (see tests/helpers/load-collector.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector } = require('./helpers/load-collector');

const gas = loadCollector();

// A real mapped marker to build synthetic cases from (whatjobs.com is keyed in FOOTER_MARKERS).
const MARK = gas.FOOTER_MARKERS['whatjobs.com'];
const WHATJOBS = 'jobalerts@whatjobs.com';   // exact-key sender
const REED = 'noreply@reed.co.uk';           // exact-key sender, different marker
const UNMAPPED = 'jobs@cv-library.co.uk';    // no FOOTER_MARKERS key

// ---------- outcomes: hit / miss / none ----------

test('hit: a marker in the trailing portion cuts the footer, marker included in the discarded tail', () => {
  const head = 'JOB BODY '.repeat(20);              // the kept content
  const text = head + MARK + ' unsubscribe one-click tail';
  const r = gas.truncateAtFooter_(text, WHATJOBS);
  assert.equal(r.outcome, 'hit');
  assert.equal(r.html, head, 'text is sliced at the marker; the marker and everything after it are gone');
  assert.equal(r.bytesCut, text.length - head.length, 'bytesCut = removed tail length (marker + footer)');
  assert.equal(r.domain, 'whatjobs.com', 'domain is the matched registered-domain key');
  assert.ok(r.html.indexOf(MARK) === -1, 'the marker does not survive the cut');
});

test('miss: a mapped sender whose marker is absent is a byte-identical no-op, flagged miss', () => {
  const text = 'a reed job alert body with no footer marker present at all '.repeat(10);
  const r = gas.truncateAtFooter_(text, REED);
  assert.equal(r.outcome, 'miss');
  assert.equal(r.html, text, 'miss leaves the text byte-identical (no cut)');
  assert.equal(r.bytesCut, 0);
  assert.equal(r.domain, 'reed.co.uk', 'miss still reports the matched key (for the per-email warn + run alarm)');
});

test('none: an unmapped sender is a byte-identical no-op with no domain, regardless of content', () => {
  const text = 'whatever ' + MARK + ' even if it happens to contain a known marker';
  const r = gas.truncateAtFooter_(text, UNMAPPED);
  assert.equal(r.outcome, 'none');
  assert.equal(r.html, text, 'unmapped senders are never cut');
  assert.equal(r.bytesCut, 0);
  assert.equal(r.domain, '', 'none reports no domain (no log line, no alarm)');
});

// ---------- domain keying: exact + dot-boundary, never bare-suffix ----------

test('dot-boundary keying: a subdomain sender (mail.uk.whatjobs.com) matches the whatjobs.com key', () => {
  const text = 'JOB '.repeat(40) + MARK + ' footer';
  const r = gas.truncateAtFooter_(text, 'jobalerts@mail.uk.whatjobs.com');
  assert.equal(r.outcome, 'hit', 'the registered-domain suffix matches across an address move');
  assert.equal(r.domain, 'whatjobs.com');
});

test('dot-boundary keying: a look-alike domain (notwhatjobs.com) does NOT match — no bare-suffix match', () => {
  const text = 'JOB '.repeat(40) + MARK + ' footer';
  const r = gas.truncateAtFooter_(text, 'jobalerts@notwhatjobs.com');
  assert.equal(r.outcome, 'none', 'notwhatjobs.com must not match the whatjobs.com key');
  assert.equal(r.domain, '');
});

test('domain extraction: the last @ wins and the domain is lowercased; a From with no @ never keys the map', () => {
  const text = 'JOB '.repeat(40) + MARK + ' footer';
  assert.equal(gas.truncateAtFooter_(text, 'a@b@WhatJobs.Com').outcome, 'hit', 'case-folded, last-@ domain matches');
  assert.equal(gas.truncateAtFooter_(text, 'no-at-sign-here').outcome, 'none', 'an address with no @ is unmapped');
});

// ---------- position floor ----------

test('position floor: an identical marker planted early (~9%) is a miss, not a cut', () => {
  // idx/len well under FOOTER_POSITION_FLOOR (0.5) -> the phrase is a body mention, not the footer.
  const text = 'pre ' + MARK + ' ' + 'X'.repeat(900);
  const idx = text.indexOf(MARK);
  assert.ok(idx / text.length < 0.5, 'precondition: the planted marker sits before the floor');
  const r = gas.truncateAtFooter_(text, WHATJOBS);
  assert.equal(r.outcome, 'miss', 'a too-early match is treated as a miss');
  assert.equal(r.html, text, 'and the text is left byte-identical');
});

test('position floor: the same marker just past the floor IS cut (pins the floor is load-bearing, not absent)', () => {
  // Mirror image of the planted-early case: move the marker past 0.5 and it must become a hit.
  const text = 'X'.repeat(60) + MARK + ' tail';
  const idx = text.indexOf(MARK);
  assert.ok(idx / text.length >= 0.5, 'precondition: the marker sits at/after the floor');
  assert.equal(gas.truncateAtFooter_(text, WHATJOBS).outcome, 'hit');
});

// ---------- lastIndexOf: the LAST occurrence is the real footer ----------

test('lastIndexOf: a marker appearing in a job description AND the footer cuts only at the footer', () => {
  // The phrase leaks into a listing early, then begins the real footer late. The early mention
  // must survive; only the trailing footer is removed (footers are terminal).
  const body = MARK + ' (this one is inside a job listing) ' + 'A'.repeat(200);
  const text = body + MARK + ' real footer to drop';
  const r = gas.truncateAtFooter_(text, WHATJOBS);
  assert.equal(r.outcome, 'hit');
  assert.equal(r.html, body, 'cut at the LAST occurrence, so the body mention is preserved');
  assert.ok(r.html.indexOf(MARK) === 0, 'the early body mention still survives in the kept text');
  assert.equal(r.bytesCut, text.length - body.length);
});

// ---------- value-pinning corpus test (the "research test", issue #14) ----------

test('corpus: full pipeline (link cleanup -> CLEAN_REGEX -> unwrap -> footer cutoff) per-fixture cut bytes', () => {
  // Corridors-not-goldens (CLAUDE.md): the slice prompt set acceptance FLOORS (reed >= 1000,
  // nijobs >= 900, joblookup >= 300, welcometothejungle >= 100, ziprecruiter >= 500,
  // whatjobs >= 1000, jobs4 >= 600, milkround >= 2500, procontractjobs >= 1700; cv-library
  // unmapped -> byte-identical). This pins what THIS implementation actually measures (2026-06-11;
  // milkround/procontractjobs added 2026-06-12) so a silent regression in the cut is visible.
  // whatjobs/jobs4 reproduce the Architect's measured values (1196 / 782) exactly; reed uses the
  // CORRECTED marker 'manage your contact preferences' (the v3 'Manage your job alerts' string is
  // absent from the stored fixture) and cuts 1311 B, matching the issue's research evidence.
  // The footer-map-extension slice added milkround (dot-boundary key jobs.milkround.com ->
  // milkround.com, reusing nijobs' GDPR marker, cuts 2799 B at 82.1%) and procontractjobs
  // (exact key, cuts 1965 B at 95.1%). footer-map-extension-2 (2026-06-19) added three MAPPED
  // senders (jobs-co-uk, outsideir35, teksystems); haystack/talentsource24/applygateway were
  // DEFERRED (Codex F1: their address marker sits AFTER the footer action links, so the cut would
  // leave the unsubscribe/manage endpoints behind — a marker must BEGIN the footer block). jobs-co-uk
  // uses the footer brand line 'Jobs.co.uk' (occ=2; lastIndexOf selects the ~95% footer copy), which
  // cuts the Edit-alert / Remove-account / account links + postal block (the FOOTER_ACTION_ENDPOINTS
  // assertion below pins that). Goldens are RE-MEASURED from the shipped LF fixtures, NOT derived from
  // the CRLF-era stored CleanLength (faithfulness proven by byte-identity to the stored CleanText after
  // CR-strip + per-recipient-token masking; see PR body / TECH_DESIGN §4). The lowest hit position is
  // still whatjobs at 67.7%, so the 0.5 floor holds with headroom.
  const FOOTER_GOLDEN = {
    'reed':               { from: 'noreply@reed.co.uk',             outcome: 'hit',  bytesCut: 1311, floor: 1000 },
    'whatjobs':           { from: 'jobalerts@mail.uk.whatjobs.com', outcome: 'hit',  bytesCut: 1196, floor: 1000 }, // dot-boundary key
    'jobs4':              { from: 'mailer@jobmails.io',             outcome: 'hit',  bytesCut: 782,  floor: 600 },
    'joblookup':          { from: 'alerts@joblookup.com',           outcome: 'hit',  bytesCut: 820,  floor: 300 },
    'nijobs':             { from: 'jobs@nijobs.com',                outcome: 'hit',  bytesCut: 1689, floor: 900 },
    'ziprecruiter':       { from: 'noreply@ziprecruiter.co.uk',     outcome: 'hit',  bytesCut: 547,  floor: 500 },
    'welcometothejungle': { from: 'hello@welcometothejungle.com',   outcome: 'hit',  bytesCut: 1135, floor: 100 },
    'milkround':          { from: 'info@jobs.milkround.com',        outcome: 'hit',  bytesCut: 2799, floor: 2500 }, // dot-boundary key; reuses nijobs' marker
    'procontractjobs':    { from: 'info@procontractjobs.com',       outcome: 'hit',  bytesCut: 1965, floor: 1700 }, // exact key
    // --- footer-map-extension-2 (2026-06-19): 3 mapped senders (re-measured LF goldens; markers begin the footer block) ---
    'outsideir35':        { from: 'alerts@email.outsideir35.org.uk',           outcome: 'hit',  bytesCut: 511,  floor: 80 },  // dot-boundary key
    'jobs-co-uk':         { from: 'alerts@jobs.co.uk',                         outcome: 'hit',  bytesCut: 916,  floor: 600 }, // marker 'Jobs.co.uk' (footer brand line)
    'teksystems':         { from: 'opportunities@careeralerts.teksystems.com', outcome: 'hit',  bytesCut: 4386, floor: 500 }, // dot-boundary key
    'cv-library':         { from: 'jobs@cv-library.co.uk',          outcome: 'none', bytesCut: 0,    floor: 0 }, // unmapped
  };

  // F1 (Codex, PR #40): a footer marker must BEGIN the footer action block, so the cut must REMOVE
  // that sender's footer action endpoints (unsubscribe/manage links + their per-recipient tokens),
  // not merely trim a trailing address. Each phrase below is footer-only in its fixture (header copies
  // excluded — a terminal cut can't reach the header, e.g. jobs.co.uk keeps its top "modify alerts"
  // CTA at ~4%, which is out of scope). This is the regression that catches a cut-too-late marker.
  const FOOTER_ACTION_ENDPOINTS = {
    'jobs-co-uk':   ['Edit this Job Alert', 'Remove my account'],
    'outsideir35':  ['unsubscribe'],
    'teksystems':   ['unsubscribe'],
  };
  for (const name of Object.keys(FOOTER_GOLDEN)) {
    const g = FOOTER_GOLDEN[name];
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', `email-${name}.html`), 'utf8');
    assert.ok(!/\r/.test(raw), `${name}: fixture must stay LF-only so golden values are platform-stable`);
    // the exact processMessage_ order, up to the footer stage
    const pre = gas.collapseTableWrappers_(gas.clean(gas.cleanLinksInHtml_(raw).html)).html;
    const r = gas.truncateAtFooter_(pre, g.from);

    assert.equal(r.outcome, g.outcome, `${name}: outcome`);
    assert.ok(r.bytesCut >= g.floor, `${name}: cut ${r.bytesCut} >= corridor floor ${g.floor}`);
    assert.equal(r.bytesCut, g.bytesCut, `${name}: exact cut bytes (re-measure + update in the same commit if intentional)`);
    assert.equal(r.html.length, pre.length - g.bytesCut, `${name}: bytesCut arithmetic`);
    assert.equal(r.html, pre.slice(0, pre.length - g.bytesCut), `${name}: kept text is exactly the pre-footer prefix`);
    if (g.outcome === 'none' || g.outcome === 'miss') {
      assert.equal(r.html, pre, `${name}: ${g.outcome} leaves the text byte-identical`);
    }
    // F1: prove the cut removed the footer action endpoints (not just that bytesCut is nonzero/exact).
    const endpoints = FOOTER_ACTION_ENDPOINTS[name];
    if (endpoints) {
      assert.equal(r.outcome, 'hit', `${name}: action-endpoint check only applies to a hit`);
      for (const phrase of endpoints) {
        assert.ok(pre.includes(phrase), `${name}: precondition — "${phrase}" is present before the cut`);
        assert.ok(!r.html.includes(phrase), `${name}: footer action endpoint "${phrase}" must be removed by the cut`);
      }
    }
  }
});
