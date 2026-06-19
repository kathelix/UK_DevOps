'use strict';

// Coverage for the single-child table-wrapper unwrap (slice feature/collapse-table-wrappers,
// issue #13). collapseTableWrappers_ is pure: a <table> whose content is exactly one <tr>
// (optionally via a single <tbody>) holding exactly one <td>, whose content is exactly ONE
// element and no non-whitespace text, is replaced by that element, repeated to fixpoint with
// a pass cap. It runs in processMessage_ AFTER CLEAN_REGEX (wiring pinned in
// collect-loop.test.js); these tests drive the pure function directly, plus a value-pinning
// corpus pass over every fixture through the full pipeline (link cleanup -> CLEAN_REGEX ->
// unwrap).
//
// All assertions are on primitives (strings / numbers) — VM-realm objects are never
// deepStrictEqual'd against Node literals (see tests/helpers/load-collector.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCollector } = require('./helpers/load-collector');

const gas = loadCollector();

// k wrapper tables around <div>x</div>, innermost first.
function chain(k) {
  let s = '<div>x</div>';
  for (let i = 0; i < k; i++) s = '<table><tr><td>' + s + '</td></tr></table>';
  return s;
}

// Assert html comes back byte-identical with zero metrics (the parity contract).
function assertNoop(html, label) {
  const r = gas.collapseTableWrappers_(html);
  assert.equal(r.html, html, `${label}: byte-identical`);
  assert.equal(r.tables, 0, `${label}: no table collapsed`);
  assert.equal(r.bytesSaved, 0, `${label}: no bytes saved`);
}

// ---------- the wrapper pattern collapses ----------

test('collapses a plain <table><tr><td> wrapper to its single inner element', () => {
  const r = gas.collapseTableWrappers_('<table><tr><td><div>x</div></td></tr></table>');
  assert.equal(r.html, '<div>x</div>');
  assert.equal(r.tables, 1);
  assert.equal(r.bytesSaved, 33, 'bytesSaved = input length - output length');
});

test('collapses a wrapper routed via a single <tbody>', () => {
  const r = gas.collapseTableWrappers_('<table><tbody><tr><td><a href="u">j</a></td></tr></tbody></table>');
  assert.equal(r.html, '<a href="u">j</a>');
  assert.equal(r.tables, 1);
});

test('collapses attr-bearing wrapper tags (CLEAN_REGEX leaves colspan/lang/title etc.) and keeps the child verbatim', () => {
  const r = gas.collapseTableWrappers_(
    '<table lang="en"><tbody><tr><td colspan="2" rowspan="1"><div title="keep">x</div></td></tr></tbody></table>');
  assert.equal(r.html, '<div title="keep">x</div>', 'skeleton attrs dropped with the skeleton; child attrs untouched');
  assert.equal(r.tables, 1);
});

test('collapses regardless of tag case, preserving the kept element\'s original case', () => {
  const r = gas.collapseTableWrappers_('<TABLE><TR><TD><DIV>x</DIV></TD></TR></TABLE>');
  assert.equal(r.html, '<DIV>x</DIV>');
  assert.equal(r.tables, 1);
});

test('collapses across whitespace-only text between skeleton tags (standalone correctness; post-CLEAN_REGEX there is none)', () => {
  const r = gas.collapseTableWrappers_('<table>\n  <tr>\n    <td>\n      <div>x</div>\n    </td>\n  </tr>\n</table>');
  assert.equal(r.html, '<div>x</div>');
  assert.equal(r.tables, 1);
});

test('a void element (<br>) counts as the single element child', () => {
  const r = gas.collapseTableWrappers_('<table><tr><td><br></td></tr></table>');
  assert.equal(r.html, '<br>');
  assert.equal(r.tables, 1);
});

test('tokenizer is quote-aware: a ">" inside a quoted attribute does not end the tag', () => {
  const r = gas.collapseTableWrappers_('<table><tr><td><a title="x>y" href="u">j</a></td></tr></table>');
  assert.equal(r.html, '<a title="x>y" href="u">j</a>');
  assert.equal(r.tables, 1);
});

test('sibling wrappers all collapse in one call, surrounding content untouched', () => {
  const r = gas.collapseTableWrappers_(
    '<p>a</p><table><tr><td><i>1</i></td></tr></table><p>b</p><table><tr><td><b>2</b></td></tr></table>');
  assert.equal(r.html, '<p>a</p><i>1</i><p>b</p><b>2</b>');
  assert.equal(r.tables, 2);
});

test('a nested wrapper chain collapses fully (the live triple-wrapper shape)', () => {
  const r = gas.collapseTableWrappers_(chain(3));
  assert.equal(r.html, '<div>x</div>');
  assert.equal(r.tables, 3);
});

test('a wrapper AROUND a content table collapses; the content table survives verbatim', () => {
  const content = '<table><tr><td>A</td><td>B</td></tr></table>';
  const r = gas.collapseTableWrappers_('<table><tr><td>' + content + '</td></tr></table>');
  assert.equal(r.html, content);
  assert.equal(r.tables, 1);
});

// ---------- content tables are never touched ----------

test('multi-row table preserved', () => {
  assertNoop('<table><tr><td><div>a</div></td></tr><tr><td><div>b</div></td></tr></table>', 'multi-row');
});

test('multi-row tbody preserved', () => {
  assertNoop('<table><tbody><tr><td><div>a</div></td></tr><tr><td><div>b</div></td></tr></tbody></table>', 'multi-row tbody');
});

test('multi-cell row preserved', () => {
  assertNoop('<table><tr><td><div>a</div></td><td><div>b</div></td></tr></table>', 'multi-cell');
});

test('header cell (<th>) preserved — a th never matches the wrapper pattern', () => {
  assertNoop('<table><tr><th><div>x</div></th></tr></table>', 'th');
});

test('a <thead> route preserved — only a single <tbody> is descended through', () => {
  assertNoop('<table><thead><tr><td><div>x</div></td></tr></thead></table>', 'thead');
});

test('td mixing text with an element preserved', () => {
  assertNoop('<table><tr><td>Apply <a href="u">now</a></td></tr></table>', 'text+element td');
});

test('td with text only, and a fully empty td, preserved (no element to keep)', () => {
  assertNoop('<table><tr><td>just text</td></tr></table>', 'text-only td');
  assertNoop('<table><tr><td></td></tr></table>', 'empty td');
});

test('td with two element children preserved', () => {
  assertNoop('<table><tr><td><div>a</div><div>b</div></td></tr></table>', 'two children');
});

test('a literal entity (&nbsp;) in the td counts as text — entity decoding is out of scope (#13)', () => {
  assertNoop('<table><tr><td>&nbsp;<div>x</div></td></tr></table>', 'entity text');
});

test('non-whitespace text directly inside table/tr skeleton preserved', () => {
  assertNoop('<table>stray<tr><td><div>x</div></td></tr></table>', 'text in table');
  assertNoop('<table><tr>stray<td><div>x</div></td></tr></table>', 'text in tr');
});

// ---------- malformed HTML is a no-op, never a mangle ----------

test('unclosed td disqualifies the table (strict pairing, no recovery guessing)', () => {
  assertNoop('<table><tr><td><div>x</div></tr></table>', 'unclosed td');
});

test('a stray close tag directly inside the td disqualifies the table', () => {
  assertNoop('<table><tr><td></p><div>x</div></td></tr></table>', 'stray close in td');
});

test('an unclosed table never matches (its open tag stays unpaired)', () => {
  assertNoop('<table><tr><td><div>x</div></td></tr>', 'unclosed table');
});

test('an unterminated tag at EOF is treated as text, not guessed at', () => {
  assertNoop('<table><tr><td><div>x</div></td></tr></table', 'EOF inside tag');
});

test('unmatched junk INSIDE the kept element is fine — the element is opaque and kept verbatim', () => {
  // The stray </p> lives inside the div (the kept child), not on the skeleton chain.
  const r = gas.collapseTableWrappers_('<table><tr><td><div>a</p>b</div></td></tr></table>');
  assert.equal(r.html, '<div>a</p>b</div>');
  assert.equal(r.tables, 1);
});

// ---------- parity + the pass cap ----------

test('byte-identical no-op with zero metrics when there is nothing to unwrap (parity contract)', () => {
  assertNoop('<p>hello <b>world</b></p> no tables at all', 'table-free html');
});

test('pass cap: a 25-deep chain fully collapses; a 30-deep chain stops at the cap with 5 wrappers left', () => {
  // One pass collapses every OUTERMOST wrapper, so a pure k-chain consumes k passes. The cap
  // is 25 (MAX_UNWRAP_PASSES): removing the cap, or breaking the per-pass outermost logic,
  // flips one of these. Real emails nest 3-4 deep — the cap is generous headroom, and a
  // capped result is still valid output (just under-collapsed).
  const r25 = gas.collapseTableWrappers_(chain(25));
  assert.equal(r25.html, '<div>x</div>', '25-deep collapses fully');
  assert.equal(r25.tables, 25);
  const r30 = gas.collapseTableWrappers_(chain(30));
  assert.equal(r30.tables, 25, 'cap reached');
  assert.equal((r30.html.match(/<table>/g) || []).length, 5, '5 wrappers survive the cap');
  assert.equal(r30.html, chain(5), 'the survivors are the innermost 5, intact');
});

// ---------- value-pinning corpus test (the "research test", issue #13) ----------

test('corpus: full pipeline (link cleanup -> CLEAN_REGEX -> unwrap) per-fixture wrapper counts and bytes saved', () => {
  // Pinned to what THIS implementation measures (2026-06-11), per the slice prompt: the
  // issue's research table came from a scratch parser; the acceptance corridor was
  // cv-library >= 35, joblookup >= 15, nijobs >= 28, reed >= 16, welcometothejungle >= 34,
  // ziprecruiter exactly 0 — this implementation reproduces the research values exactly.
  // Issue #14 added two fixtures here too: jobs4 (one genuine single-child wrapper, >= 1) and
  // whatjobs (its outer table/tr/td chain is never closed, so strict pairing correctly no-ops
  // and the inner tables are all genuine content tables — pinned at exactly 0, byte-identical,
  // like ziprecruiter). The footer-map-extension slice added milkround (3 wrappers, 115 B) and
  // procontractjobs (25 wrappers, 4805 B), both pinned exact (measured 2026-06-12).
  // footer-map-extension-2 (2026-06-19) added three mapped senders, re-measured from the shipped LF
  // fixtures: jobs-co-uk (2, 66), teksystems (8, 2354), and outsideir35 (0 — div layout, no
  // single-child wrappers). If the fixture or the unwrap changes intentionally, eyeball the diff and
  // update these in the same commit; a silent drop in the win is the regression this test catches.
  const GOLDEN = {
    'cv-library': { tables: 40, bytesSaved: 1320 },
    'jobs-co-uk': { tables: 2, bytesSaved: 66 },
    'jobs4': { tables: 1, bytesSaved: 33 },
    'joblookup': { tables: 17, bytesSaved: 561 },
    'milkround': { tables: 3, bytesSaved: 115 },
    'nijobs': { tables: 31, bytesSaved: 1183 },
    'outsideir35': { tables: 0, bytesSaved: 0 },
    'procontractjobs': { tables: 25, bytesSaved: 4805 },
    'reed': { tables: 18, bytesSaved: 594 },
    'teksystems': { tables: 8, bytesSaved: 2354 },
    'welcometothejungle': { tables: 38, bytesSaved: 1254 },
    'whatjobs': { tables: 0, bytesSaved: 0 }, // unclosed outer table/tr/td: strict pairing MUST no-op
    'ziprecruiter': { tables: 0, bytesSaved: 0 }, // div-based layout: MUST stay a no-op
  };
  for (const name of Object.keys(GOLDEN)) {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', `email-${name}.html`), 'utf8');
    assert.ok(!/\r/.test(raw), `${name}: fixture must stay LF-only so golden values are platform-stable`);
    const cleaned = gas.clean(gas.cleanLinksInHtml_(raw).html); // the exact processMessage_ order
    const r = gas.collapseTableWrappers_(cleaned);
    assert.equal(r.tables, GOLDEN[name].tables, `${name}: wrapper tables collapsed`);
    assert.equal(r.bytesSaved, GOLDEN[name].bytesSaved, `${name}: bytes saved`);
    assert.equal(r.bytesSaved, cleaned.length - r.html.length, `${name}: bytesSaved arithmetic`);
    if (GOLDEN[name].tables === 0) {
      assert.equal(r.html, cleaned, `${name}: zero wrappers means byte-identical output`);
    }
  }
});
