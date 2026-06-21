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

// ---------- link / urlcut modes: synthetic token-before-anchor cases ----------
// These drive footerCutIndex_ directly on tiny strings so the snap (link) / href-match (urlcut)
// logic is covered independent of the large real-capture fixtures. The defining property of a
// token-LEAD footer: the per-recipient token sits BEFORE the marker, so a plain text cut leaves it.

const HEAD = 'JOB BODY CONTENT '.repeat(20); // ~340 chars of kept body, pushes the footer past the 0.5 floor

test('link mode: snaps the cut back to the enclosing <a>, dropping the token a text cut would leave', () => {
  const token = 'SECRET_tok_AbC123xyz_perRecipient';
  const text = HEAD + `<a href="https://t.test/c/${token}">Manage all your subscriptions</a> trailing`;
  const markerIdx = text.lastIndexOf('Manage all your subscriptions');

  const cut = gas.footerCutIndex_(text, { text: 'Manage all your subscriptions', mode: 'link' });
  assert.ok(cut > -1, 'link mode resolves a cut');
  assert.ok(cut < markerIdx, 'link snaps BEFORE the marker text, to the <a> opening');
  const kept = text.slice(0, cut);
  assert.ok(!kept.includes(token), 'the per-recipient token (before the marker) is removed by the snap');
  assert.ok(!kept.includes('Manage all your subscriptions'), 'the marker text is gone too');

  // Contrast: a plain STRING marker (text mode) cuts AT the text, LEAVING the <a href> token — the trap.
  const textCut = gas.footerCutIndex_(text, 'Manage all your subscriptions');
  assert.equal(textCut, markerIdx, 'text mode cuts at the marker text');
  assert.ok(text.slice(0, textCut).includes(token), 'text mode leaves the leading token — exactly what link mode fixes');
});

test('link mode: marker in a <span> preceded by an empty tracked <a> snaps to that <a> (efc shape)', () => {
  const token = 'TRACK_Xy9z_pq_emptyAnchor';
  const text = HEAD + `<a href="https://t.test/p/${token}"></a><span>You received this email because you</span> end`;
  const markerIdx = text.lastIndexOf('You received this email because you');
  const cut = gas.footerCutIndex_(text, { text: 'You received this email because you', mode: 'link' });
  assert.ok(cut > -1 && cut < markerIdx);
  assert.ok(!text.slice(0, cut).includes(token), 'snap to the empty preceding <a> removes its token');
});

test('link mode: a marker before the 0.5 floor is a miss (floor applies to the resolved index)', () => {
  const text = `<a href="https://t.test/${'T'.repeat(12)}">early</a>` + 'X'.repeat(600);
  assert.equal(gas.footerCutIndex_(text, { text: 'early', mode: 'link' }), -1);
});

test('link mode FAILS CLOSED: marker present but NO safe anchor is a miss, not a token-leaking text cut (F1)', () => {
  // The per-recipient token sits before the marker but is NOT inside an <a> (the template lost/moved
  // the anchor). A text-index fallback would report `hit`, strip the visible text, and silently LEAVE
  // the token — link mode must fail loud (miss) so the marker-miss alarm + screening tail scan flag it.
  const token = 'LEAKtok_perRecipient_aB12xyz';
  const text = HEAD + `token=${token} Manage all your subscriptions trailing`;
  assert.equal(gas.footerCutIndex_(text, { text: 'Manage all your subscriptions', mode: 'link' }), -1);
  // and end-to-end: a mapped sender in this shape is a `miss` (byte-identical no-op), not a leaking hit
  const r = gas.truncateAtFooter_(text, 'update@cord.co'); // cord is a link-mode sender; force this shape
  // (cord's real marker differs, so this synthetic text is a `none`/`miss` for cord — assert the token
  //  is never silently dropped-with-a-hit; the point is footerCutIndex_ above returns -1 for link.)
  assert.ok(r.outcome !== 'hit' || r.html.includes(token) === false);
});

test('link mode FAILS CLOSED: an anchor BELOW the floor with the marker above it is a miss (F1)', () => {
  // The only anchor (carrying a token) sits early/below the floor; the marker sits past the floor with
  // no anchor after it. The snap is floor-bounded, so it finds nothing -> miss (never a cut that keeps
  // the early token).
  const token = 'EARLYtok_belowFloor_Q9';
  const text = `<a href="https://t.test/${token}">x</a>` + 'Z'.repeat(400) + ' Customer Support trailing';
  assert.ok(text.lastIndexOf('Customer Support') / text.length >= 0.5, 'precondition: marker past the floor');
  assert.ok(text.indexOf('<a') / text.length < 0.5, 'precondition: the only anchor is below the floor');
  assert.equal(gas.footerCutIndex_(text, { text: 'Customer Support', mode: 'link' }), -1);
});

test('urlcut mode: cuts at the <a> whose href matches, removing a footer link that has no anchor text', () => {
  const pat = 'x\\.test/job_alerts/[^"/]+/unsubscribe\\?token=';
  const text = HEAD + `<a href="https://x.test/job_alerts/abc-123/unsubscribe?token=SECRETJWE_perRecip">`;
  const cut = gas.footerCutIndex_(text, { urlPattern: pat, mode: 'urlcut' });
  assert.ok(cut > -1, 'urlcut resolves a cut even with no anchor text to match');
  const kept = text.slice(0, cut);
  assert.ok(!kept.includes('unsubscribe?token='), 'the matched <a> (and its token) is removed entirely');
  assert.ok(!kept.includes('SECRETJWE_perRecip'));
});

test('urlcut mode: a pre-floor decoy match is ignored; the LAST match at/after the floor is the cut', () => {
  const pat = 'x\\.test/job_alerts/[^"/]+/unsubscribe\\?token=';
  // decoy unsubscribe link early (body), real one in the footer past the floor
  const text = `<a href="https://x.test/job_alerts/decoy/unsubscribe?token=EARLY">d</a>`
    + 'X'.repeat(600)
    + `<a href="https://x.test/job_alerts/real-1/unsubscribe?token=LATEtok">`;
  const cut = gas.footerCutIndex_(text, { urlPattern: pat, mode: 'urlcut' });
  assert.ok(cut > 0.5 * text.length, 'cut is the footer (past-floor) match, not the early decoy');
  assert.ok(text.slice(0, cut).includes('EARLY'), 'the pre-floor decoy link is left intact (above the footer)');
  assert.ok(!text.slice(0, cut).includes('LATEtok'), 'the footer unsubscribe token is removed');
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
  // assertion below pins that). footer-cut-token-lead (2026-06-20) added the TOKEN-LEAD senders, where
  // the per-recipient token sits BEFORE the marker text so a plain text cut would leave it: nijobs +
  // milkround drifted to a 'Manage all your subscriptions' link (mode:'link' snaps to the enclosing <a>),
  // ziprecruiter to a bare unsubscribe <a> with no anchor text (mode:'urlcut'), and the new cord / jooble /
  // efinancialcareers (×2 variants — the broadened 'You received this email because you' marker catches
  // both the job-alert and newsletter templates). Goldens are RE-MEASURED from the shipped LF fixtures,
  // NOT derived from the CRLF-era stored CleanLength (faithfulness proven by byte-identity to the stored
  // CleanText after LF + per-recipient-token mask + whitespace-collapse — the Gmail-MCP transport
  // normalizes trailing whitespace; see PR body / TECH_DESIGN §4). The lowest hit position is still
  // whatjobs at 67.7%, so the 0.5 floor holds with headroom.
  const FOOTER_GOLDEN = {
    'reed':               { from: 'noreply@reed.co.uk',             outcome: 'hit',  bytesCut: 1311, floor: 1000 },
    'whatjobs':           { from: 'jobalerts@mail.uk.whatjobs.com', outcome: 'hit',  bytesCut: 1196, floor: 1000 }, // dot-boundary key
    'jobs4':              { from: 'mailer@jobmails.io',             outcome: 'hit',  bytesCut: 782,  floor: 600 },
    'joblookup':          { from: 'alerts@joblookup.com',           outcome: 'hit',  bytesCut: 820,  floor: 300 },
    'nijobs':             { from: 'info@jobs.nijobs.com',          outcome: 'hit',  bytesCut: 5536, floor: 3000 }, // Template A (recommendation): link mode 'Manage all your subscriptions' (marker B absent -> array == single marker)
    // footer-multi-marker (2026-06-21): NIJobs "N new X jobs" DIGEST (Template B). Same sender, but the
    // footer has TWO elements in order: 'Change criteria for jobs by email' (~0.81, a click.nijobs.com
    // per-recipient tracker) THEN 'Manage all your subscriptions' (~0.83). The single-marker-A cut HITS
    // (cut 5422 B) but LEAVES the earlier 'Change criteria' tracker; the array [A,B] takes the earliest
    // valid cut -> 5933 B (= 5422 + 511), removing that residual too. NOT a miss (production already
    // A-cut these; stored CleanLength == footerCutIndex_(A)). Re-measured from the shipped LF fixture.
    'nijobs-digest':      { from: 'info@jobs.nijobs.com',          outcome: 'hit',  bytesCut: 5933, floor: 3000 }, // Template B (digest): array earliest-cut-wins at marker B
    'ziprecruiter':       { from: 'alerts@ziprecruiter.co.uk',     outcome: 'hit',  bytesCut: 1461, floor: 800 },  // drifted -> urlcut (unsubscribe href)
    'welcometothejungle': { from: 'hello@welcometothejungle.com',   outcome: 'hit',  bytesCut: 1135, floor: 100 },
    'milkround':          { from: 'info@jobs.milkround.com',        outcome: 'hit',  bytesCut: 5222, floor: 3000 }, // dot-boundary key; drifted -> link mode (same as nijobs)
    'procontractjobs':    { from: 'info@procontractjobs.com',       outcome: 'hit',  bytesCut: 1965, floor: 1700 }, // exact key
    // --- footer-map-extension-2 (2026-06-19): 3 mapped senders (re-measured LF goldens; markers begin the footer block) ---
    'outsideir35':        { from: 'alerts@email.outsideir35.org.uk',           outcome: 'hit',  bytesCut: 511,  floor: 80 },  // dot-boundary key
    'jobs-co-uk':         { from: 'alerts@jobs.co.uk',                         outcome: 'hit',  bytesCut: 916,  floor: 600 }, // marker 'Jobs.co.uk' (footer brand line)
    'teksystems':         { from: 'opportunities@careeralerts.teksystems.com', outcome: 'hit',  bytesCut: 4386, floor: 500 }, // dot-boundary key
    // --- footer-cut-token-lead (2026-06-20): token-lead footers (link/urlcut modes; re-measured LF goldens) ---
    'cord':                         { from: 'update@cord.co',                   outcome: 'hit', bytesCut: 1136, floor: 700 }, // link: snap to the per-recipient <a> wrapping the marker
    'jooble':                       { from: 'subscribe@uk.jooble.org',          outcome: 'hit', bytesCut: 827,  floor: 500 }, // dot-boundary key; link: snap to the footer-nav lead <a>
    'efinancialcareers-jobs':       { from: 'emails@efinancialcareers.com',     outcome: 'hit', bytesCut: 1739, floor: 1000 }, // link: marker in a <span> preceded by an empty tracked <a>; job-alert variant
    'efinancialcareers-newsletter': { from: 'emails@efinancialcareers.com',     outcome: 'hit', bytesCut: 1264, floor: 700 },  // same broadened marker also cuts the newsletter variant
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
    // footer-cut-token-lead: each phrase is a token-LEAD footer endpoint that a plain text cut would
    // LEAVE (the per-recipient token sits before the marker); link/urlcut must remove it.
    'nijobs':                       ['Unsubscribe from this email'],
    // footer-multi-marker: the digest's residual footer tracker that marker A alone LEAVES and marker B
    // removes (a token-LEAD click.nijobs.com 'Change criteria' link). Its removal is the whole point.
    'nijobs-digest':                ['Change criteria for jobs by email'],
    'milkround':                    ['Unsubscribe from this email'],
    'ziprecruiter':                 ['/unsubscribe?token=', 'job_alerts'], // urlcut removes the per-recipient unsubscribe <a> entirely
    'cord':                         ['settings%2Fnotifications'],          // link snap removes the preferences/unsubscribe link + its JWT
    'jooble':                       ['redir/unsubscribe', 'Privacy Policy'],
    'efinancialcareers-jobs':       ['Manage your preferences'],
    'efinancialcareers-newsletter': ['Manage your preferences'],
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

// ---------- multi-marker arrays (slice footer-multi-marker, 2026-06-21) ----------
// A FOOTER_MARKERS value may be a single marker OR an array of markers (one per template). truncateAtFooter_
// normalizes to an array and footerCutIndexMulti_ takes the EARLIEST valid cut (footers are terminal, so the
// earliest start is the real footer). A 1-element / scalar entry is byte-identical to today — back-compat is
// pinned by the unchanged corpus goldens above. The first user is NIJobs, which ships two templates:
//   A) recommendation/"picked for you" — footer leads with 'Manage all your subscriptions' (marker B absent).
//   B) "N new \"X\" jobs" DIGEST — footer has 'Change criteria for jobs by email' (~0.81) THEN 'Manage all
//      your subscriptions' (~0.83). Production already HITS at A (cut 5422 B) but LEAVES the earlier
//      'Change criteria' click.nijobs.com per-recipient tracker; the array [A,B] cuts at B (5933 B) and
//      removes it. (This is residual-tracker removal on a hit, NOT a miss/alarm fix.)

test('footerCutIndexMulti_: returns the resolving marker index, or the MINIMUM when several resolve', () => {
  const head = 'JOB BODY CONTENT '.repeat(30);              // pad past the 0.5 floor
  const text = head + 'AAA Footer Alpha BBB Footer Beta CCC';
  const alpha = gas.footerCutIndex_(text, 'Footer Alpha');  // earlier
  const beta  = gas.footerCutIndex_(text, 'Footer Beta');   // later
  assert.ok(alpha > -1 && beta > -1 && alpha < beta, 'precondition: both markers resolve, Alpha earlier');

  assert.equal(gas.footerCutIndexMulti_(text, ['Nope Absent', 'Footer Beta']), beta, 'only marker[1] resolves → its index');
  assert.equal(gas.footerCutIndexMulti_(text, ['Footer Alpha', 'Nope Absent']), alpha, 'only marker[0] resolves → its index');
  assert.equal(gas.footerCutIndexMulti_(text, ['Nope Absent', 'Also Absent']), -1, 'neither resolves → -1');
  assert.equal(gas.footerCutIndexMulti_(text, ['Footer Alpha', 'Footer Beta']), alpha, 'both resolve → the MINIMUM index');
  assert.equal(gas.footerCutIndexMulti_(text, ['Footer Beta', 'Footer Alpha']), alpha, 'min is order-independent');
});

// the exact processMessage_ pre-footer pipeline (mirrors the corpus test)
const prePipeline = (raw) => gas.collapseTableWrappers_(gas.clean(gas.cleanLinksInHtml_(raw).html)).html;
const MARK_A = { text: 'Manage all your subscriptions', mode: 'link' };
const MARK_B = { text: 'Change criteria for jobs by email', mode: 'link' };

test('cross-template: NIJobs Template A (recommendation) has marker B ABSENT → array cut == single marker A', () => {
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nijobs.html'), 'utf8'));
  assert.equal(pre.lastIndexOf('Change criteria for jobs by email'), -1, 'marker B is absent from Template A');
  assert.equal(gas.footerCutIndexMulti_(pre, [MARK_A, MARK_B]), gas.footerCutIndex_(pre, MARK_A),
    'with B absent the array resolves to exactly marker A');
  assert.equal(gas.truncateAtFooter_(pre, 'info@jobs.nijobs.com').bytesCut, 5536, 'array cuts Template A identically (5536 B)');
});

test('cross-template: NIJobs Template B (digest) has BOTH markers, B earlier than A → array cuts at B', () => {
  // Corrected guardrail (v1 wrongly asserted "marker A absent in the digest"). Marker A IS present — it is
  // the current production cut point; the array adds the EARLIER marker B so the residual tracker goes too.
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nijobs-digest.html'), 'utf8'));
  const ia = pre.lastIndexOf('Manage all your subscriptions');
  const ib = pre.lastIndexOf('Change criteria for jobs by email');
  assert.ok(ia > -1, 'marker A IS present in the digest (do NOT assert its absence — that was the v1 error)');
  assert.ok(ib > -1, 'marker B is present in the digest');
  assert.ok(ib < ia, 'marker B sits earlier than marker A, so earliest-cut-wins selects B');
  const cutA = gas.footerCutIndex_(pre, MARK_A);
  const cutB = gas.footerCutIndex_(pre, MARK_B);
  assert.ok(cutB < cutA, 'the resolved B cut is earlier than the A cut');
  assert.equal(gas.footerCutIndexMulti_(pre, [MARK_A, MARK_B]), cutB, 'the array resolves to the earlier B cut');
});

test('mutation check: deleting the Template B marker re-leaves the residual click.nijobs.com tracker', () => {
  // If the B array element is removed, this MUST flip: the cut drops by 511 B and the per-recipient
  // 'Change criteria' tracker the A-cut leaves reappears in the kept text — proving B is actually exercised.
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nijobs-digest.html'), 'utf8'));
  const withB    = pre.slice(0, gas.footerCutIndexMulti_(pre, [MARK_A, MARK_B])); // ships
  const withoutB = pre.slice(0, gas.footerCutIndexMulti_(pre, [MARK_A]));         // mutation: B deleted
  assert.equal(pre.length - withB.length, 5933, 'array [A,B] cuts 5933 B');
  assert.equal(pre.length - withoutB.length, 5422, 'with B deleted, only marker A cuts (5422 B)');
  assert.equal(withoutB.length - withB.length, 511, 'marker B removes 511 B more than marker A alone');
  assert.ok(!withB.includes('Change criteria for jobs by email'), 'array [A,B]: the residual tracker is GONE');
  assert.ok(withoutB.includes('Change criteria for jobs by email'), 'B deleted: the residual tracker REAPPEARS');
});

test('digest fixture: no per-recipient PII survives the redaction (leak-free committed capture)', () => {
  // Real capture, redacted length-neutrally: click.nijobs.com tokens → TOKEN_REDACTED…, greeting name →
  // 'User', x-stepcast-id → zeros. Guard the committed file so a real per-recipient token can't slip in.
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nijobs-digest.html'), 'utf8');
  assert.ok(!/\r/.test(raw), 'fixture stays LF-only');
  assert.equal(raw.match(/ivan/gi), null, 'no recipient name leaks (any case)');
  assert.ok(!raw.includes('boiko') && !raw.includes('gmail.com'), 'no recipient address leaks');
  assert.equal(raw.match(/click\.nijobs\.com\/(?:f\/a|q)\/(?!TOKEN_REDACTED)/g), null,
    'every click.nijobs.com tracking token (links + open pixels) is redacted');
});
