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
const UNMAPPED = 'jobs@unmapped.example';    // no FOOTER_MARKERS key (cv-library is now mapped — footer-map-extension-3)

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
  // senders (jobs-co-uk, outsideir35, teksystems); haystack/talentsource24/applygateway were DEFERRED
  // then (Codex F1, PR #40: their address marker sits AFTER the footer action links, so a postal-line cut
  // would leave the unsubscribe/manage endpoints behind) but are now MAPPED by footer-map-extension-3
  // (2026-06-27) via a footer-START text marker / link mode (see below). jobs-co-uk
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
    // footer-milkround-append (2026-06-23): the in-corpus milkround mail is the StepStone DIGEST (same
    // shape as nijobs Template B). Marker A 'Manage all your subscriptions' (~0.85) is PRECEDED (~514 B
    // earlier) by a 'Change criteria for jobs by email' click.milkround.com per-recipient tracker (~0.84).
    // The single-marker-A cut HIT (5222 B) but LEFT that tracker; the array [A,B] takes the earliest valid
    // cut -> 5736 B (= 5222 + 514), removing the residual too. NOT a miss (production already A-cut these);
    // flagged by the 2026-06-23 footer-freshness scan. Re-measured from the shipped LF fixture.
    'milkround':          { from: 'info@jobs.milkround.com',        outcome: 'hit',  bytesCut: 5736, floor: 3000 }, // dot-boundary key; DIGEST array earliest-cut-wins at marker B (was 5222 at A alone)
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
    // --- fixture-raw-transport (2026-06-24): talent.com mapped from a parity-gated raw-RFC822 fixture (text mode) ---
    // Was DEFERRED (PR #50, get_thread QP-decode corruption); the byte-preserving raw transport produced a
    // faithful fixture (its pipeline output byte-reproduces stored CleanText, diffs only in length-neutral
    // redaction regions — tokens + the greeting name).
    // In-corpus fixture is the single-job ("More jobs like …") template; the text cut at the marker removes the
    // one-click unsubscribe (+ its tk= token) + Terms/Privacy/Cookie/Contact + postal. Re-measured from the LF fixture.
    'talent':             { from: 'no-reply@alerts.talent.com',      outcome: 'hit',  bytesCut: 2537, floor: 1500 }, // dot-boundary key (alerts.talent.com → talent.com)
    // --- footer-nexxt-com (2026-06-24; 2-marker array per Architect F1, PR #52): nexxt.com, the LAST
    // get_thread-QP-deferred sender, mapped via the same parity-gated raw-RFC822 transport. A 2-element array
    // [postal, optout-intro] with earliest-valid-cut-wins handles both differently-ordered templates: alert@
    // (postal-first) → the postal marker is the MIN index (cuts recipient email + postal + /optout + unsubscribe,
    // all after it; the optout-intro @95.9% is a later NON-winning candidate, so 1045 B is UNCHANGED from the scalar);
    // jfw@ (action-first) → the optout-intro is the MIN index (cuts /optout?ssid + postal, 442 B — was 252 at the
    // postal alone — so the array now REMOVES the jfw optout). Re-measured from the shipped LF fixtures.
    'nexxt':              { from: 'alert@email.nexxt.com',           outcome: 'hit',  bytesCut: 1045, floor: 700 }, // dot-boundary key (email.nexxt.com → nexxt.com); alert@ postal-first → postal marker (min)
    'nexxt-jfw':          { from: 'jfw@email.nexxt.com',             outcome: 'hit',  bytesCut: 442,  floor: 300 }, // dot-boundary key; jfw@ action-first → optout-intro marker (min) removes the /optout
    // --- footer-map-extension-3 (2026-06-27): un-defer haystack/talentsource24/applygateway (PR #40) + map cv-library.
    // The PR #40 DEFERRAL ("address line sits AFTER the action links") is undone by a footer-START text marker
    // (notice line / sign-off) or link mode (PR #50/#52). cv-library was simply never mapped. Re-measured from the
    // shipped LF fixtures; the per-recipient token lands after the cut anchor in every sample (see no-leak tests).
    'haystack':           { from: 'hello@haystackapp.io',           outcome: 'hit',  bytesCut: 1535, floor: 1000 }, // text 'You received this email because you'; cuts the sendgrid /asm/ unsubscribe+manage links (leaves a token-free address line above)
    'talentsource24':     { from: 'alerts@talentsource24.com',      outcome: 'hit',  bytesCut: 1067, floor: 700 },  // text 'Happy job hunting!'; cuts the footer ?guid= account links + postal (the DUPLICATE top-bar guid survives — tail cut can't reach it, §4 caveat)
    'applygateway':       { from: 'noreply@zip.applygateway.com',   outcome: 'hit',  bytesCut: 1269, floor: 800 },  // dot-boundary key (zip.applygateway.com → applygateway.com); link mode 'Unsubscribe from this email' snaps to the enclosing <a>, dropping the ~700-char unsubscribe JWT
    'cv-library':         { from: 'jobs@cv-library.co.uk',          outcome: 'hit',  bytesCut: 815,  floor: 600 }, // text 'CV-Library Ltd, Beacon House' (postal footer-start); the /uns/<token> unsubscribe <a> follows
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
    // footer-milkround-append: the array now ALSO removes the earlier 'Change criteria for jobs by email'
    // click.milkround.com residual that the A-only cut left (mirrors nijobs-digest); 'Unsubscribe' sits
    // after marker A and was already removed by the A-cut, so both must be gone after the array cut.
    'milkround':                    ['Unsubscribe from this email', 'Change criteria for jobs by email'],
    'ziprecruiter':                 ['/unsubscribe?token=', 'job_alerts'], // urlcut removes the per-recipient unsubscribe <a> entirely
    'cord':                         ['settings%2Fnotifications'],          // link snap removes the preferences/unsubscribe link + its JWT
    'jooble':                       ['redir/unsubscribe', 'Privacy Policy'],
    'efinancialcareers-jobs':       ['Manage your preferences'],
    'efinancialcareers-newsletter': ['Manage your preferences'],
    // fixture-raw-transport: the talent.com text cut must remove the one-click unsubscribe endpoint (its tk=
    // auth token sits after the marker; the cut takes the whole footer action block + postal with it).
    'talent':                       ['unsubscribe'],
    // footer-nexxt-com (2-marker array per Architect F1, PR #52): BOTH nexxt templates are action-block-correct, so
    // both cut their /optout endpoint + unsubscribe text. alert@ (postal-first): the postal marker wins (earliest
    // valid cut), removing the optout that follows it. jfw@ (action-first): the optout-intro marker wins, removing
    // the /optout that follows IT — the array is precisely what removes the jfw optout the scalar postal marker left.
    'nexxt':                        ['/optout', 'unsubscribe'],
    'nexxt-jfw':                    ['/optout', 'unsubscribe'],
    // footer-map-extension-3 (2026-06-27): the un-deferred/new senders. Each phrase is footer-ONLY in its fixture
    // (a terminal cut can't reach the header/top-bar copies, so phrases shared with a header are excluded —
    // notably talentsource24's top preferences bar keeps its own ?guid= links, §4 caveat).
    'cv-library':     ['/uns/', 'CAN_DYN'],                          // the unsubscribe <a> + its /uns/<token>=/CAN_DYN: per-recipient token
    'haystack':       ['/asm/unsubscribe', '/asm/'],                 // the sendgrid /asm/ unsubscribe + manage links (both carry the per-recipient data= token)
    'talentsource24': ['Edit this Job Alert', 'Remove my account', 'Powered by Allthetopbananas'], // footer-only anchor texts (the top-bar duplicate uses different labels for the same ?guid= URLs)
    'applygateway':   ['Unsubscribe from this email', '/unsubscribe?token=', 'job_alerts/00000000', 'Apply Gateway Ltd'], // link snap removes the unsubscribe/edit <a> (JWT in href) + postal
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
// A FOOTER_MARKERS value may be a single marker OR an array of candidate footer starts (covering different
// templates and/or multiple footer elements within one template). truncateAtFooter_
// normalizes to an array and footerCutIndexMulti_ takes the EARLIEST valid cut (footers are terminal, so the
// earliest start is the real footer). A 1-element / scalar entry is byte-identical to today — back-compat is
// pinned by the unchanged corpus goldens above. The first user is NIJobs, which ships two templates:
//   A) recommendation/"picked for you" — footer leads with 'Manage all your subscriptions' (marker B absent).
//   B) "N new \"X\" jobs" DIGEST — footer has 'Change criteria for jobs by email' (~0.81) THEN 'Manage all
//      your subscriptions' (~0.83). Production already HITS at A (cut 5422 B) but LEAVES the earlier
//      'Change criteria' click.nijobs.com per-recipient tracker; the array [A,B] cuts at B (5933 B) and
//      removes it. (This is residual-tracker removal on a hit, NOT a miss/alarm fix.)
// The second user is milkround (footer-milkround-append, 2026-06-23) — same StepStone family, same digest
// shape and SAME markers A/B. The in-corpus milkround mail is the digest only (every sample is "N new X jobs"),
// so unlike NIJobs there is no A-only template; the array [A,B] cuts at B (5736 B, was 5222 at A alone),
// dropping the same 'Change criteria' click.milkround.com residual. Flagged by the footer-freshness scan.

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

// ---------- milkround digest (slice footer-milkround-append, 2026-06-23) ----------
// milkround is the SECOND multi-marker user: same StepStone family as NIJobs, same digest shape and the SAME
// markers A/B. The in-corpus milkround mail is the digest ONLY (every stored sample is "N new X jobs in United
// Kingdom"), so unlike NIJobs there is no A-only / recommendation template — nothing for marker B to over-cut.
// The array [A,B] takes the earliest valid cut (B), dropping the 'Change criteria' click.milkround.com residual
// that the single-marker-A cut left. Confirmed byte-identical across the pre-cut fixture + 2 stored RawEmails
// samples (06-23 residual, 06-11 uncut); B earlier than A in both the fixture and the uncut stored footer.

test('milkround digest: BOTH markers present, B earlier than A → array cuts at B (residual removed)', () => {
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-milkround.html'), 'utf8'));
  const ia = pre.lastIndexOf('Manage all your subscriptions');
  const ib = pre.lastIndexOf('Change criteria for jobs by email');
  assert.ok(ia > -1, 'marker A IS present in the milkround digest (the production cut point)');
  assert.ok(ib > -1, 'marker B is present in the milkround digest');
  assert.ok(ib < ia, 'marker B sits earlier than marker A, so earliest-cut-wins selects B');
  const cutA = gas.footerCutIndex_(pre, MARK_A);
  const cutB = gas.footerCutIndex_(pre, MARK_B);
  assert.ok(cutB > -1 && cutA > -1 && cutB < cutA, 'both resolve, the B cut is earlier than the A cut');
  // the array resolves to EXACTLY the B cut — it does not over-cut to anything earlier (no spurious match)
  assert.equal(gas.footerCutIndexMulti_(pre, [MARK_A, MARK_B]), cutB, 'the array resolves to the earlier B cut');
  // end-to-end through the live FOOTER_MARKERS array
  const r = gas.truncateAtFooter_(pre, 'info@jobs.milkround.com');
  assert.equal(r.outcome, 'hit');
  assert.equal(r.bytesCut, 5736, 'array [A,B] cuts 5736 B (re-measure + update here in the same commit if intentional)');
  assert.ok(!r.html.includes('Change criteria for jobs by email'), 'the click.milkround.com residual tracker is GONE');
});

test('milkround digest mutation check: deleting marker B re-leaves the residual click.milkround.com tracker', () => {
  // If the B array element is removed, this MUST flip: the cut drops by 514 B and the per-recipient
  // 'Change criteria' tracker the A-cut leaves reappears in the kept text — proving B is actually exercised.
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-milkround.html'), 'utf8'));
  const withB    = pre.slice(0, gas.footerCutIndexMulti_(pre, [MARK_A, MARK_B])); // ships
  const withoutB = pre.slice(0, gas.footerCutIndexMulti_(pre, [MARK_A]));         // mutation: B deleted (old scalar)
  assert.equal(pre.length - withB.length, 5736, 'array [A,B] cuts 5736 B');
  assert.equal(pre.length - withoutB.length, 5222, 'with B deleted, only marker A cuts (5222 B — the old scalar value)');
  assert.equal(withoutB.length - withB.length, 514, 'marker B removes 514 B more than marker A alone');
  assert.ok(!withB.includes('Change criteria for jobs by email'), 'array [A,B]: the residual tracker is GONE');
  assert.ok(withoutB.includes('Change criteria for jobs by email'), 'B deleted: the residual tracker REAPPEARS');
});

test('milkround fixture: no per-recipient PII survives the redaction (leak-free committed capture)', () => {
  // Real digest capture, redacted length-neutrally: click.milkround.com tokens → TOKEN_REDACTED…, greeting name
  // → 'User', x-stepcast-id → padded. Guard the committed file so a real per-recipient token can't slip in.
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'email-milkround.html'), 'utf8');
  assert.ok(!/\r/.test(raw), 'fixture stays LF-only');
  assert.equal(raw.match(/ivan/gi), null, 'no recipient name leaks (any case)');
  assert.ok(!raw.includes('boiko') && !raw.includes('gmail.com'), 'no recipient address leaks');
  // every click.milkround.com URL path segment that is a long token must be the redacted form (TOKEN_REDACTED)
  // or the shared structural infix 'AAAmIhA~' (a campaign id common to all milkround links, not per-recipient).
  const leaks = [];
  for (const u of (raw.match(/https:\/\/click\.milkround\.com\/[^"]+/g) || [])) {
    const pathPart = u.replace(/^https:\/\/click\.milkround\.com\//, ''); // drop scheme+host (host > 16 chars)
    for (const seg of pathPart.split('/')) {
      if (seg.replace(/~+$/, '').length >= 16 && !seg.includes('TOKEN_REDACTED') && seg !== 'AAAmIhA~') leaks.push(seg);
    }
  }
  assert.deepEqual(leaks, [], 'every click.milkround.com per-recipient token is redacted');
});

// ---------- talent.com (slice fixture-raw-transport, 2026-06-24) ----------
// talent.com was DEFERRED in PR #50: the Gmail-MCP get_thread QP-decodes its raw-=NN tracking URLs to
// control bytes / U+FFFD, so get_thread could not produce a faithful fixture. The transport slice captured
// via a byte-preserving raw-RFC822 path and proved per-message byte-identity to stored CleanText, so the
// committed (redacted, LF) fixture's pipeline output byte-reproduces stored CleanText. text mode: the
// nearest <a> before the marker is the footer 'Personalize my jobs' CTA in digest templates but a body
// 'More Jobs' link in the single-job template (this in-corpus fixture), so link would over-cut the body.

test('talent fixture: faithful raw transport — no QP corruption, no per-recipient PII (leak-free capture)', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'email-talent.html'), 'utf8');
  assert.ok(!/\r/.test(raw), 'fixture stays LF-only');
  // The defining win of the raw transport: NONE of the get_thread QP-decode artifacts that deferred talent.com.
  assert.equal(raw.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|�/g), null, 'no C0 control bytes or U+FFFD (raw transport keeps literal =NN, unlike get_thread)');
  assert.equal(raw.match(/ivan/gi), null, 'no recipient name leaks (greeting was redacted Ivan -> User)');
  assert.ok(!raw.includes('boiko') && !raw.includes('gmail.com'), 'no recipient address leaks');
  assert.ok(!raw.includes(Buffer.from('boiko.ivan@gmail.com').toString('base64').replace(/=+$/, '')), 'no base64-encoded recipient address');
  // Every key the capture redacted must hold its placeholder — in both =literal and &#x3D; forms — so a future
  // edit can't silently reintroduce a real value (Codex F1, PR #51). Genuine per-recipient PII: email_id /
  // user_id / tk / search_id (each constant across the email -> identifies the recipient) + d_sent (per-send).
  // Over-redacted (per-template / per-campaign, not per-recipient, but guarded so the committed redaction can't
  // revert): template_id / t_id / c_id / c_name. pid/bpid VARY per job card (per-posting, like job titles — NOT
  // per-recipient), so they are legitimately kept and NOT checked.
  const REDACTED = /^TOKEN_REDACTEDA*$/, ZEROS = /^0+$/; // alnum-token vs numeric placeholder shapes
  const leaks = [];
  for (const key of ['email_id', 'user_id', 'tk', 'search_id', 'd_sent', 'template_id', 't_id', 'c_id', 'c_name']) {
    for (const m of raw.matchAll(new RegExp('(?:[?&]|amp;)' + key + '(?:=|&#x3D;)([^&"\\s>]+)', 'g'))) {
      if (!REDACTED.test(m[1]) && !ZEROS.test(m[1])) leaks.push(`${key}=${m[1].slice(0, 12)}`);
    }
  }
  assert.deepEqual(leaks, [], 'every redacted Talent token key holds its placeholder (no real value reintroduced)');
});

// ---------- nexxt.com (slice footer-nexxt-com, 2026-06-24; 2-marker array per Architect F1, PR #52) ----------
// nexxt.com was the LAST get_thread-QP-deferred sender (PR #50): get_thread QP-decodes its raw-=NN tracking URLs
// to control bytes / U+FFFD, so it could not produce a faithful fixture. The fixture-raw-transport raw-RFC822 path
// (PR #51) captured it byte-faithfully and proved per-message byte-identity to stored CleanText for all 4 messages.
// nexxt ships two differently-ORDERED templates, mapped by a 2-element marker ARRAY (postal + optout-intro,
// earliest-valid-cut-wins): alert@ (postal-first, committed primary, email-nexxt.html) and jfw@ (action-first,
// committed secondary, email-nexxt-jfw.html). Both are action-block-correct — the cut removes the /optout endpoint
// + unsubscribe text in BOTH templates (see the cross-template array test + FOOTER_ACTION_ENDPOINTS below). NB the
// committed fixtures are the UNCUT redacted captures (the cut runs at screening time), so this no-leak test guards
// the committed redaction itself. See docs/TECH_DESIGN.md §4 / the capture provenance folded into the PR body.
//
// Redaction manifest (length-neutral, by-shape): ten opaque query keys CONSTANT across the artifact (per-recipient)
// are redacted to a [0A]-only placeholder (structural %0a / - preserved); the recipient name (greeting) -> 'User'
// and the recipient address -> the synthetic placeholder 'userx.name@mailx.org' are the PR #51 F2 PII classes.
// Keys that VARY per job card (tcid/ttid/tv1/red/s + posting links) are per-posting, not per-recipient, and are
// legitimately kept (not scanned). The scan EXTRACTS AND VALIDATES every greeting + email occurrence (not merely
// placeholder presence), so an ADDITIVE leak — a second real name/email inserted while the placeholder stays —
// is caught too, not only an in-place un-redaction (Codex P2 re-review, PR #52). It still embeds no real recipient
// identity. Opaque-key occurrence counts are pinned so the scan can't silently miss one (matcher-is-a-hypothesis),
// and every class is mutation-proven below — both an un-redaction AND an additive insert must flip the scan red.
const NEXXT_KEYS = ['cid', 'emid', 'tv2', 'sid', 'pid', 'sd', 'sidxid', 'm', 'p', 'ssid'];
const NEXXT_NAME_PLACEHOLDER = '>User<';                  // redacted greeting (real name was replaced by 'User')
const NEXXT_ADDR_PLACEHOLDER = 'userx.name@mailx.org';    // synthetic placeholder address (alert@ only)
const NEXXT_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;  // every email-shaped token
const NEXXT_GREETING_RE = /capitalize[^>]*>([^<]+)</g;    // the text-transform:capitalize greeting span value(s)
const nexxtVals = (text, key) =>
  [...text.matchAll(new RegExp('(?<![A-Za-z0-9])' + key + '(?:=|%3d|&#x3d;)([^&"\'\\s>]+)', 'gi'))].map(m => m[1]);
// A redaction placeholder is [0A]-only after stripping the structural %0a / - that some keys preserve; a real
// captured token carries other hex/alphanumerics and fails this.
const nexxtIsPlaceholder = (v) => v.length > 0 && /^[0A]+$/.test(v.replace(/%0a/gi, '').replace(/-/g, ''));
const nexxtEmails = (text) => text.match(NEXXT_EMAIL_RE) || [];
const nexxtGreetings = (text) => [...text.matchAll(NEXXT_GREETING_RE)].map(m => m[1]);
// All leak findings in `text` (empty array = clean): a greeting set that is not exactly the single 'User'
// placeholder, an email set other than the expected one (so an ADDED email is caught, not only a changed one),
// or any opaque key whose value is not a placeholder. Extract-and-validate, so no real recipient identity is
// embedded and additive leaks are caught.
function nexxtLeaks(text, hasEmail) {
  const found = [];
  const greetings = nexxtGreetings(text);
  if (greetings.length !== 1 || greetings[0] !== 'User') found.push('recipient_name');
  const emails = nexxtEmails(text);
  const emailsOk = hasEmail ? (emails.length === 1 && emails[0] === NEXXT_ADDR_PLACEHOLDER) : emails.length === 0;
  if (!emailsOk) found.push('recipient_email');
  for (const key of NEXXT_KEYS) {
    if (nexxtVals(text, key).some(v => !nexxtIsPlaceholder(v))) found.push(key);
  }
  return found;
}

function nexxtNoLeak(file, counts, hasEmail) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
  assert.ok(!/\r/.test(raw), `${file}: fixture stays LF-only`);
  // the defining win of the raw transport: NONE of the get_thread QP-decode artifacts that deferred nexxt.com
  assert.equal(raw.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|�/g), null,
    `${file}: no C0 control bytes or U+FFFD (raw transport keeps literal =NN, unlike get_thread)`);
  // committed fixture is clean: extract-and-validate EVERY greeting + email occurrence, and every opaque key
  assert.deepEqual(nexxtGreetings(raw), ['User'], `${file}: exactly one greeting site, value 'User'`);
  assert.deepEqual(nexxtEmails(raw), hasEmail ? [NEXXT_ADDR_PLACEHOLDER] : [], `${file}: email set is exactly the expected placeholder(s)`);
  assert.deepEqual(nexxtLeaks(raw, hasEmail), [], `${file}: leak-free (no recipient PII, no un-redacted token)`);
  for (const key of NEXXT_KEYS) {
    assert.equal(nexxtVals(raw, key).length, counts[key], `${file}: ${key} occurrence count (scan must catch every one)`);
  }
  // mutation proofs — every class is load-bearing against BOTH an un-redaction (placeholder -> realistic value)
  // and an ADDITIVE insert (synthetic PII added while the placeholder stays). All synthetic: no real identity.
  const T = 'aZ9aZ9aZ9';                                     // not [0A]-shaped -> a leak
  const muts = [
    ['recipient_name',  raw.replace(NEXXT_NAME_PLACEHOLDER, '>John<')],                   // un-redact the greeting
    ['recipient_name',  raw + '<span style="text-transform:capitalize">Jane</span>'],     // ADDITIVE: a 2nd greeting site
    ['recipient_email', raw + ' please contact jane.roe@example.org'],                     // ADDITIVE: a 2nd email (both fixtures)
  ];
  if (hasEmail) muts.push(['recipient_email', raw.replace(NEXXT_ADDR_PLACEHOLDER, 'john.doe@example.com')]); // un-redact the address
  for (const key of NEXXT_KEYS) {
    const esc = nexxtVals(raw, key)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    muts.push([key, raw.replace(new RegExp('((?<![A-Za-z0-9])' + key + '(?:=|%3d|&#x3d;))' + esc, 'i'), '$1' + T)]);
  }
  for (const [cls, mutated] of muts) {
    assert.notEqual(mutated, raw, `${file}: ${cls} mutation actually changed the fixture`);
    assert.ok(nexxtLeaks(mutated, hasEmail).includes(cls), `${file}: ${cls} guard is load-bearing (un-redaction + additive)`);
  }
  // every recipient-PII + opaque-key class is guarded (manifest: recipient name/email + ten opaque keys)
  assert.deepEqual([...new Set(muts.map(m => m[0]))].sort(), ['recipient_email', 'recipient_name', ...NEXXT_KEYS].sort(),
    `${file}: every redaction class is guarded`);
}

test('nexxt alert@ fixture: leak-free capture; every redaction class mutation-proven (un-redaction + additive)', () => {
  nexxtNoLeak('email-nexxt.html', { cid: 22, emid: 22, tv2: 20, sid: 20, pid: 2, sd: 2, sidxid: 2, m: 5, p: 5, ssid: 1 }, true);
});

test('nexxt jfw@ fixture: leak-free capture; every redaction class mutation-proven (incl. additive; no recipient email present)', () => {
  nexxtNoLeak('email-nexxt-jfw.html', { cid: 4, emid: 4, tv2: 2, sid: 2, pid: 2, sd: 2, sidxid: 2, m: 5, p: 5, ssid: 1 }, false);
});

// ---------- nexxt.com 2-marker array (Architect F1, PR #52) ----------
// nexxt's two templates are differently ORDERED, so the domain key carries a 2-element array [A=postal,
// B=optout-intro] and earliest-valid-cut-wins (footerCutIndexMulti_) picks the right cut per template:
//   alert@ (postal-first):  A (~95.1%) < B (~95.9%)  -> A wins; B present but non-winning (can't over-cut)
//   jfw@   (action-first):  B (~88.6%) < A (~93.5%)  -> B wins; removes the /optout the scalar A-cut had LEFT
// Same footerCutIndexMulti_ mechanism as NIJobs/milkround, here for cross-TEMPLATE ordering (not a within-
// template residual). Both markers are plain text mode, floor-checked individually.
const NEXXT_A = 'sent by Nexxt, c/o Nexxt Inc';              // postal line
const NEXXT_B = 'If you wish to discontinue receiving this'; // optout intro (byte-identical prefix in both templates)

test('nexxt array: alert@ (postal-first) resolves to the postal cut; optout-intro present but non-winning (1045 B)', () => {
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nexxt.html'), 'utf8'));
  const iA = pre.lastIndexOf(NEXXT_A), iB = pre.lastIndexOf(NEXXT_B);
  assert.ok(iA > -1 && iB > -1, 'both markers present in alert@');
  assert.ok(iA < iB, 'alert@ is postal-first: A (postal) precedes B (optout-intro)');
  assert.equal(gas.footerCutIndexMulti_(pre, [NEXXT_A, NEXXT_B]), gas.footerCutIndex_(pre, NEXXT_A),
    'array resolves to the postal (min) cut');
  const r = gas.truncateAtFooter_(pre, 'alert@email.nexxt.com');
  assert.equal(r.outcome, 'hit');
  assert.equal(r.bytesCut, 1045, 'alert@ stays 1045 B (postal wins; B is a later non-winning candidate)');
  assert.ok(!r.html.includes('/optout') && !r.html.includes('unsubscribe'), 'the optout endpoint is removed');
});

test('nexxt array: jfw@ (action-first) resolves to the optout-intro cut, REMOVING the /optout (442 B)', () => {
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nexxt-jfw.html'), 'utf8'));
  const iA = pre.lastIndexOf(NEXXT_A), iB = pre.lastIndexOf(NEXXT_B);
  assert.ok(iA > -1 && iB > -1, 'both markers present in jfw@');
  assert.ok(iB < iA, 'jfw@ is action-first: B (optout-intro) precedes A (postal)');
  assert.equal(gas.footerCutIndexMulti_(pre, [NEXXT_A, NEXXT_B]), gas.footerCutIndex_(pre, NEXXT_B),
    'array resolves to the earlier optout-intro (min) cut');
  const r = gas.truncateAtFooter_(pre, 'jfw@email.nexxt.com');
  assert.equal(r.outcome, 'hit');
  assert.equal(r.bytesCut, 442, 'jfw@ cuts 442 B at the optout-intro (was 252 at the postal alone)');
  assert.ok(!r.html.includes('/optout') && !r.html.includes('unsubscribe'), 'the /optout endpoint is removed by the array');
});

test('nexxt array mutation: deleting marker B re-leaves the jfw@ /optout (proves B is exercised); alert@ unchanged', () => {
  const preJfw = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nexxt-jfw.html'), 'utf8'));
  const withB    = preJfw.slice(0, gas.footerCutIndexMulti_(preJfw, [NEXXT_A, NEXXT_B])); // ships
  const withoutB = preJfw.slice(0, gas.footerCutIndexMulti_(preJfw, [NEXXT_A]));          // mutation: B deleted (old scalar)
  assert.equal(preJfw.length - withB.length, 442, 'array [A,B] cuts 442 B');
  assert.equal(preJfw.length - withoutB.length, 252, 'with B deleted, only the postal marker A cuts (252 B — the old scalar value)');
  assert.ok(!withB.includes('/optout'), 'array [A,B]: the jfw /optout is GONE');
  assert.ok(withoutB.includes('/optout'), 'B deleted: the jfw /optout REAPPEARS (so B is precisely what removes it)');
  // alert@ is unaffected by B (A wins there): deleting B leaves its cut identical (B never over-cuts)
  const preAlert = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-nexxt.html'), 'utf8'));
  assert.equal(gas.footerCutIndexMulti_(preAlert, [NEXXT_A, NEXXT_B]), gas.footerCutIndexMulti_(preAlert, [NEXXT_A]),
    'alert@ cut is identical with or without B (postal wins)');
});

// ---------- applygateway link mode (slice footer-map-extension-3, 2026-06-27) ----------
// applygateway is the PR #40 "address-after-links" case the link mode unlocks: the unsubscribe <a>'s
// VISIBLE text is the marker 'Unsubscribe from this email' but its HREF carries a ~700-char per-recipient
// JWT (job_alerts/<UUID>/unsubscribe?token=<JWT>). A plain text cut would slice at the visible text and
// LEAVE the open <a href="…JWT…"> tag; link mode snaps the cut back to that enclosing <a> so the JWT goes.
test('applygateway link mode: cut snaps to the enclosing <a> (JWT href dropped), not the anchor text', () => {
  const pre = prePipeline(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-applygateway.html'), 'utf8'));
  const r = gas.truncateAtFooter_(pre, 'noreply@zip.applygateway.com');
  assert.equal(r.outcome, 'hit');
  const tail = pre.slice(r.html.length);
  // the discarded tail BEGINS at the enclosing anchor open tag (so the token-bearing href is in the tail)
  assert.ok(tail.startsWith('<a'), 'the cut starts at the enclosing <a>, so the JWT-bearing href is discarded');
  assert.ok(tail.includes('/unsubscribe?token='), 'the unsubscribe href (JWT) is in the discarded tail');
  // the kept text must NOT end mid-anchor (a text cut would leave the dangling <a href="…JWT…"> open tag)
  assert.ok(!/<a\b[^>]*$/.test(r.html), 'the kept text does not end with a dangling <a open tag');
  assert.ok(!r.html.includes('/unsubscribe?token='), 'no unsubscribe token href survives in the kept text');
  // text mode would resolve LATER (at the visible marker), proving link actually moved the cut back
  const linkIdx = gas.footerCutIndex_(pre, { text: 'Unsubscribe from this email', mode: 'link' });
  const textIdx = gas.footerCutIndex_(pre, 'Unsubscribe from this email');
  assert.ok(linkIdx > -1 && textIdx > -1 && linkIdx < textIdx, 'link snaps the cut earlier than the visible-text cut');
});

// ---------- footer-map-extension-3 no-leak guards (2026-06-27) ----------
// Four footer-mapped fixtures: three NEW raw captures (haystack / talentsource24 / applygateway) + the reused
// cv-library fixture. Each committed fixture is redacted length-neutrally; these tests guard EVERY redacted key —
// extract-and-validate the whole occurrence set per class, pin its count (matcher-is-a-hypothesis), and
// mutation-prove BOTH an un-redaction AND an additive insert flip the scan red, for EVERY key (PR #51/#52; PR #55
// F1/F2). NB the committed fixtures are the UNCUT redacted captures (the footer cut runs at screening time), so
// these guard the committed redaction itself.
//
// No real recipient identity is embedded in this test source (PR #55 F1): the recipient address never appears as
// an @-email in any fixture (assert the @-email set is empty), and every greeting site holds a non-PII value —
// 'User' (the redacted recipient name) or 'Candidate' (cv-library's own generic, never-personalised greeting).
// A real name or address inserted additively is caught because it is neither; the mutation proofs use only
// SYNTHETIC values.
//
// constant-vs-varying note: talentsource24's VisitJob alert-id (constant across all job cards) and per-send
// open/visit id (varies per send) are per-RECIPIENT and were additionally redacted to 0s here (the capture had
// left them); applygateway's tsid (constant 60× across all card redirects) likewise. applygateway's per-card
// job_activities `data=` JWT IS redacted too (token-shaped, over-redacted by shape — its payload carries
// recipient data). Per-POSTING ids that vary per card (cv-library/haystack job ids, talentsource24 'Ref no.'
// 32-hex) ride every kept job link and are NOT recipient PII, so they stay.
const GREETING_RE = /\bHi,?\s+([A-Za-z][A-Za-z'’-]*)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_GREETINGS = new Set(['User', 'Candidate']); // 'User' = redacted recipient name; 'Candidate' = cv-library's generic greeting
const greetingsIn = (t) => [...t.matchAll(GREETING_RE)].map((m) => m[1]);
const emailsIn = (t) => t.match(EMAIL_RE) || [];

const PLACEHOLDER_ZEROS = (v) => /^0+$/.test(v);
const PLACEHOLDER_ZERO_UUID = (v) => v === '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_TOK = (v) => /^TOKEN_REDACTEDA*$/.test(v);
const PLACEHOLDER_R = (v) => /^R+$/.test(v);
// Synthetic, correctly-SHAPED non-placeholder values the mutation proofs substitute in (no real identity):
const REALISH_DIGITS = '12345678';                              // matches \d+ / hex, fails ^0+$
const REALISH_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';    // 36 chars [0-9a-f-], not the all-zero UUID
const REALISH_TOK = 'aZ9bQ2cX1wK3';                             // matches a token slot, fails ^TOKEN_REDACTEDA*$
const REALISH_B64 = 'aGVsbG8x';                                 // matches a base64 slot, fails ^R+$

// Generic per-key scan: leak labels (empty = clean). Each key = {label, re (group 1 = the token value), ok
// (placeholder predicate), count (expected occurrences), realish (a synthetic, same-shape non-placeholder value
// the mutation proofs use)}. A wrong count OR a non-placeholder value both flag the key.
function keyLeaks(raw, keys) {
  const found = [];
  for (const k of keys) {
    const vals = [...raw.matchAll(k.re)].map((m) => m[1]);
    if (vals.length !== k.count) found.push(`${k.label}:count`);
    if (vals.some((v) => !k.ok(v))) found.push(`${k.label}:value`);
  }
  return found;
}

// Recipient-identity leaks (empty = clean): any @-email at all, or a greeting value outside the non-PII allow-set.
function identityLeaks(text) {
  const found = [];
  if (emailsIn(text).length !== 0) found.push('recipient_email');
  if (greetingsIn(text).some((g) => !ALLOWED_GREETINGS.has(g))) found.push('recipient_name');
  return found;
}

// One leak-free + mutation-proof pass over a fixture. expectedGreetings pins the exact greeting set (so an added
// greeting site is caught too). EVERY key is mutation-proven against BOTH an un-redaction (swap the 1st
// occurrence's placeholder for a realistic same-shape value → :value) AND an additive insert (append a 2nd
// realistic occurrence → :count); the recipient name + email guards are each additive-proven with SYNTHETIC
// values, so no real recipient identity is embedded.
function noLeak(file, expectedGreetings, keys) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
  assert.ok(!/\r/.test(raw), `${file}: fixture stays LF-only`);
  assert.deepEqual(emailsIn(raw), [], `${file}: no @-email appears (recipient address never present)`);
  assert.deepEqual(greetingsIn(raw), expectedGreetings, `${file}: greeting set is exactly the expected non-PII value(s)`);
  assert.deepEqual(identityLeaks(raw), [], `${file}: no recipient identity`);
  assert.deepEqual(keyLeaks(raw, keys), [], `${file}: every redacted key holds its placeholder`);
  for (const k of keys) {
    const m = [...raw.matchAll(k.re)][0];
    const realFull = m[0].replace(m[1], k.realish);                  // same shape, non-placeholder
    const unred = raw.replace(m[0], realFull);                       // un-redaction: swap the 1st occurrence
    assert.notEqual(unred, raw, `${file}: ${k.label} un-redaction changed the fixture`);
    assert.ok(keyLeaks(unred, keys).includes(`${k.label}:value`), `${file}: ${k.label} guard catches an un-redaction`);
    assert.ok(keyLeaks(raw + realFull, keys).includes(`${k.label}:count`), `${file}: ${k.label} guard catches an additive insert`);
  }
  // recipient name/email additive proofs — SYNTHETIC values only
  assert.ok(identityLeaks(raw + '<p>Hi, Syntheticname</p>').includes('recipient_name'), `${file}: recipient-name guard catches an additive name`);
  assert.ok(identityLeaks(raw + ' contact synthetic.user@example.org').includes('recipient_email'), `${file}: recipient-email guard catches an additive email`);
}

test('cv-library fixture: leak-free footer-token redaction (every key mutation-proven)', () => {
  // cv-library's greeting is the generic 'Hi Candidate' (×2, never personalised — not recipient PII). Its single
  // per-recipient token is the /uns/<base64>=/CAN_DYN:<token> unsubscribe link, redacted to R-runs. The regex
  // captures the token SLOT (not a fixed R-run) so a real base64/token in that slot is caught, not just an R-run.
  noLeak('email-cv-library.html', ['Candidate', 'Candidate'], [
    { label: 'uns_b64',     re: /\/uns\/([^=\/"\s]+)=\/CAN_DYN/g, ok: PLACEHOLDER_R, count: 1, realish: REALISH_B64 },
    { label: 'uns_can_dyn', re: /\/CAN_DYN:([^:\/"\s]+):/g,       ok: PLACEHOLDER_R, count: 1, realish: REALISH_B64 },
  ]);
});

test('haystack fixture: leak-free sendgrid-token redaction (every key mutation-proven)', () => {
  // No greeting site in this template (expected []). Redacted per-recipient keys: the SendGrid subuser host id, the
  // /asm/ user_id, the /asm/ data= token (unsubscribe + manage), and the ls/click + wf/open upn trackers.
  noLeak('email-haystack.html', [], [
    { label: 'sendgrid_host', re: /\/\/u(\d+)\.ct\.sendgrid\.net/g, ok: PLACEHOLDER_ZEROS, count: 11, realish: REALISH_DIGITS },
    { label: 'user_id',       re: /user_id=([^&"\s]+)/g,            ok: PLACEHOLDER_ZEROS, count: 2,  realish: REALISH_DIGITS },
    { label: 'asm_data',      re: /(?:[?&]|amp;)data=([^&"\s]+)/g,  ok: PLACEHOLDER_TOK,   count: 2,  realish: REALISH_TOK }, // preceded by &amp;
    { label: 'upn',           re: /(?:[?&]|amp;)upn=([^&"\s]+)/g,   ok: PLACEHOLDER_TOK,   count: 9,  realish: REALISH_TOK },
  ]);
});

test('talentsource24 fixture: leak-free redaction incl. the additionally-redacted alert/send ids (every key mutation-proven)', () => {
  // the recipient-name greeting was redacted to 'Hi,  User' (one site, value 'User'). Redacted per-recipient keys: account-link
  // guid (6×, footer + top-bar duplicate), the VisitJob alert id + per-send open/visit id (footer-map-extension-3
  // added these — the capture had left them un-redacted), the AlertOpen per-send pixel, and the reference param.
  noLeak('email-talentsource24.html', ['User'], [
    { label: 'guid',       re: /guid=([0-9a-fA-F-]+)/g,       ok: PLACEHOLDER_ZERO_UUID, count: 6,  realish: REALISH_UUID },
    { label: 'alert_id',   re: /VisitJob\/15\/(\d+)\/\d+\//g, ok: PLACEHOLDER_ZEROS,     count: 15, realish: REALISH_DIGITS },
    { label: 'send_id',    re: /VisitJob\/15\/\d+\/(\d+)\//g, ok: PLACEHOLDER_ZEROS,     count: 15, realish: REALISH_DIGITS },
    { label: 'alert_open', re: /AlertOpen\/(\d+)\.gif/g,      ok: PLACEHOLDER_ZEROS,     count: 1,  realish: REALISH_DIGITS },
    { label: 'reference',  re: /reference=([0-9a-fA-F]+)/g,   ok: PLACEHOLDER_ZEROS,     count: 15, realish: REALISH_DIGITS },
  ]);
});

test('applygateway fixture: leak-free redaction incl. the additionally-redacted tsid (every key mutation-proven)', () => {
  // No greeting site in this template (expected []). Redacted per-recipient keys: the job_alerts account UUID, the
  // unsubscribe/edit JWT (token=), the per-card job_activities/track data= token (recipient-bearing JWT payload —
  // redacted, NOT kept), and tsid (footer-map-extension-3 added it — constant 60× per-recipient/per-send).
  noLeak('email-applygateway.html', [], [
    { label: 'job_alert_uuid', re: /job_alerts\/([0-9a-f-]{36})/g,  ok: PLACEHOLDER_ZERO_UUID, count: 2,  realish: REALISH_UUID },
    { label: 'unsub_jwt',      re: /(?:[?&]|amp;)token=([^&"\s]+)/g, ok: PLACEHOLDER_TOK,       count: 2,  realish: REALISH_TOK },
    { label: 'activity_data',  re: /(?:[?&]|amp;)data=([^&"\s]+)/g,  ok: PLACEHOLDER_TOK,       count: 60, realish: REALISH_TOK },
    { label: 'tsid',           re: /tsid(?:=|%3[Dd])(\d+)/g,         ok: PLACEHOLDER_ZEROS,     count: 60, realish: REALISH_DIGITS },
  ]);
});
