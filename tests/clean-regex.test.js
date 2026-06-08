'use strict';

// Regression coverage for CONFIG.CLEAN_REGEX — the single regex that turns a raw
// HTML email body into the stored CleanText (a 1:1 port of the Make.com "Text
// parser" module). The big win: pin its behavior on a real captured email so a
// future "second cleaning pass" can't silently change what gets stored.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector } = require('./helpers/load-collector');

const FIXTURE = path.join(__dirname, 'fixtures', 'email.html');
const gas = loadCollector();
const clean = gas.clean;

test('CLEAN_REGEX carries the flags Make exported (/gis)', () => {
  // Make flags: global=true, sensitive=false, singleline=true -> g, i, s.
  // (Asserted via .flags, not `instanceof RegExp` — the regex is created in the
  // VM realm, so cross-realm instanceof is false.)
  assert.equal(gas.CLEAN_REGEX.flags, 'gis');
});

test('each alternative strips what it targets (focused cases)', () => {
  // head: everything up to and including <body ...> is removed
  assert.equal(clean('<html><head><style>x{y:1}</style></head><body>KEEP</body>'), 'KEEP');
  // tail: </body> and everything after it (the real fixture has no </body>, so
  // this branch is only covered here)
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

test('regression: real ZipRecruiter job-alert email cleans to the golden output', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  assert.ok(!/\r/.test(raw), 'fixture must stay LF-only so the golden length is platform-stable');

  const out = clean(raw);

  // Cleaning shrinks the body and removes the head/style block, images, comments,
  // presentational attributes, and inter-tag whitespace.
  assert.ok(out.length < raw.length, 'cleaning should remove bytes');
  for (const gone of ['<style', '<head', '@media', 'viewport', '<img', '<!--', 'style="', 'class="']) {
    assert.ok(!out.includes(gone), `expected ${JSON.stringify(gone)} to be stripped`);
  }
  assert.ok(!/>\s+</.test(out), 'no whitespace should remain between tags');
  // Real content survives the clean.
  assert.ok(out.includes('Engineer'), 'job-title text should survive cleaning');

  // Golden values. If CLEAN_REGEX or the fixture changes intentionally, eyeball the
  // diff and update these two numbers in the same commit.
  assert.equal(raw.length, 55811);
  assert.equal(out.length, 51222);
});
