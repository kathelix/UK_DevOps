'use strict';

// Regression coverage for CONFIG.CLEAN_REGEX — the single regex that turns a raw
// HTML email body into the stored CleanText (a 1:1 port of the retired Make.com "Text
// parser" module). The big win: pin its behavior on a CORPUS of real captured
// emails (a spread of senders/HTML styles) so a future "second cleaning pass"
// can't silently change what gets stored. This file tests the regex ONLY — the
// offline link-cleanup stage that runs before it is covered in link-cleanup.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector } = require('./helpers/load-collector');

const gas = loadCollector();
const clean = gas.clean;

test('CLEAN_REGEX carries the flags the original Make scenario exported (/gis)', () => {
  // Make-exported flags: global=true, sensitive=false, singleline=true -> g, i, s.
  // (Asserted via .flags, not `instanceof RegExp` — the regex is created in the
  // VM realm, so cross-realm instanceof is false.)
  assert.equal(gas.CLEAN_REGEX.flags, 'gis');
});

test('each alternative strips what it targets (focused cases)', () => {
  // head: everything up to and including <body ...> is removed
  assert.equal(clean('<html><head><style>x{y:1}</style></head><body>KEEP</body>'), 'KEEP');
  // tail: </body> and everything after it (also exercised by the real corpus below,
  // several of which end with </body></html>)
  assert.equal(clean('<body>KEEP</body><footer>DROP</footer></html>'), 'KEEP');
  // <img ...>, including self-closing, removed wholesale
  assert.equal(clean('<p>a<img src="x.png" alt="z" />b</p>'), '<p>ab</p>');
  // listed presentational attributes removed; element kept
  assert.equal(clean('<td style="color:red" width="5" bgcolor="#fff">hi</td>'), '<td>hi</td>');
  // HTML comments removed
  assert.equal(clean('<a><!-- tracking -->b</a>'), '<a>b</a>');
  // targeted invisible entities removed (figure space, tab, BOM, and &amp;-escaped form)
  assert.equal(clean('x&#8199;&#x2007;&#65279;&#9;y'), 'xy');
  assert.equal(clean('x&amp;#8199;y'), 'xy');
  // whitespace strictly between tags collapsed
  assert.equal(clean('<a>\n   \t  <b>'), '<a><b>');
  // non-listed attributes and visible text survive
  assert.equal(clean('<a href="http://x">Job</a>'), '<a href="http://x">Job</a>');
});

// Golden corpus: real captured job-alert emails from a spread of senders (sanitized of PII,
// LF-only), pinning CLEAN_REGEX behaviour across real-world HTML variety — table-heavy
// (reed, nijobs), div-heavy (ziprecruiter), Marketing-Cloud (welcometothejungle), digest
// (joblookup, cv-library, jobs4), whatjobs (an unclosed outer table/tr/td chain — issue #14
// fixtures), the footer-map-extension pair milkround (StepStone family, shares nijobs'
// footer) + procontractjobs (SendGrid), footer-map-extension-2's three mapped senders
// (jobs-co-uk, outsideir35, teksystems), and footer-cut-token-lead's token-lead senders
// (cord, jooble, efinancialcareers ×2 variants; nijobs/milkround/ziprecruiter re-captured at
// their drifted current templates). Each entry is [rawLength, cleanLength] (JS string
// .length, not UTF-8 bytes — emoji/£ are multi-byte). If CLEAN_REGEX or a fixture changes
// intentionally, eyeball the diff and update in the SAME commit.
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const GOLDEN = {
  'email-cord.html': [40283, 6496],
  'email-cv-library.html': [88696, 18008],
  'email-efinancialcareers-jobs.html': [41918, 8596],
  'email-efinancialcareers-newsletter.html': [79555, 21453],
  'email-jobs-co-uk.html': [44780, 18578],
  'email-jobs4.html': [25367, 5577],
  'email-joblookup.html': [54676, 11866],
  'email-jooble.html': [59601, 8502],
  'email-milkround.html': [70437, 35758],
  'email-nijobs.html': [42435, 19469],
  'email-outsideir35.html': [16923, 16207],
  'email-procontractjobs.html': [60992, 45086],
  'email-reed.html': [57460, 7576],
  'email-teksystems.html': [43093, 34006],
  'email-welcometothejungle.html': [52858, 5104],
  'email-whatjobs.html': [17169, 4252],
  'email-ziprecruiter.html': [130675, 108821],
};

test('fixture corpus exactly matches the golden manifest (no unused or unrecorded fixtures)', () => {
  // Every email-*.html must have a golden entry and vice versa — so a fixture can never sit in
  // the repo unread by a test (the trap that let a pre-cleaned, truncated fixture go unnoticed).
  const onDisk = fs.readdirSync(FIXTURES_DIR).filter(f => /^email-.*\.html$/.test(f)).sort();
  assert.deepEqual(onDisk, Object.keys(GOLDEN).sort());
});

for (const [file, [rawLen, cleanLen]] of Object.entries(GOLDEN)) {
  test(`CLEAN_REGEX golden: ${file}`, () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    assert.ok(!/\r/.test(raw), 'fixture must stay LF-only so golden lengths are platform-stable');
    const out = clean(raw);
    assert.ok(out.length < raw.length, 'cleaning should remove bytes');
    assert.ok(!/>\s+</.test(out), 'no whitespace should remain strictly between tags');
    assert.equal(raw.length, rawLen, 'raw length drift — eyeball the fixture diff, then update GOLDEN');
    assert.equal(out.length, cleanLen, 'clean length drift — eyeball the CLEAN_REGEX diff, then update GOLDEN');
  });
}
