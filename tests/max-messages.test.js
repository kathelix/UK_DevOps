'use strict';

// Coverage for the runtime-tunable MAX_MESSAGES Script Property (slice
// collector/max-messages-prop):
//   parseIntProp_ -> the pure, non-clamping property parser (the contract)
//   getIntProp_   -> the thin wrapper: reads the property, warns on a set-but-invalid value
//   collectJobEmailsLocked_ -> the 0-disable short-circuit (no fetch) and the maxResults
//                              wiring (the resolved cap reaches Gmail.Users.Messages.list)
//
// parseIntProp_ is tested with the slice's bounds (min=0, max=500). The 0-disable and
// wiring paths are driven through the real run with stubbed Apps Script globals: the
// integration test asserts Gmail.Users.Messages.list is never called when disabled, which
// a pure unit test of the parser cannot.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

// Render a captured Logger.log call (arg-array) into its final %s-substituted string.
const fmt = (args) => { let i = 1; return String(args[0]).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')); };

test('parseIntProp_ accepts only digit strings in [0, 500]; everything else -> default (no clamping)', () => {
  const { parseIntProp_ } = loadCollector();
  const D = 25; // the slice's fallback (CONFIG.MAX_MESSAGES)
  // Valid: in-range digit strings (incl. boundaries and surrounding whitespace).
  assert.equal(parseIntProp_(undefined, D, 0, 500), D, 'unset -> default');
  assert.equal(parseIntProp_(null, D, 0, 500), D, 'null -> default');
  assert.equal(parseIntProp_('', D, 0, 500), D, 'blank -> default');
  assert.equal(parseIntProp_('   ', D, 0, 500), D, 'whitespace-only -> default (trims to empty)');
  assert.equal(parseIntProp_('0', D, 0, 500), 0, '"0" -> 0 (the disable switch, NOT the default)');
  assert.equal(parseIntProp_('1', D, 0, 500), 1);
  assert.equal(parseIntProp_('50', D, 0, 500), 50);
  assert.equal(parseIntProp_(' 50 ', D, 0, 500), 50, 'trimmed before parsing');
  assert.equal(parseIntProp_('010', D, 0, 500), 10, 'leading zeros parsed as decimal (radix 10), not octal -> 10');
  assert.equal(parseIntProp_('500', D, 0, 500), 500, 'upper boundary accepted');
  // Invalid: non-integer / signed / decimal / out-of-range -> default, never coerced.
  assert.equal(parseIntProp_('abc', D, 0, 500), D, 'non-numeric -> default');
  assert.equal(parseIntProp_('5.5', D, 0, 500), D, 'decimal -> default (not floored)');
  assert.equal(parseIntProp_('-1', D, 0, 500), D, 'negative -> default (not 0)');
  assert.equal(parseIntProp_('9999', D, 0, 500), D, 'over max -> default (NOT clamped to 500)');
});

test('getIntProp_ returns the parsed value for a valid property, silently', () => {
  const gas = loadCollector();
  gas.setGlobals({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => '3' }) } });
  assert.equal(gas.getIntProp_('MAX_MESSAGES', 25, 0, 500), 3);
  assert.ok(!gas.logs.some(a => fmt(a).includes('Ignoring')), 'a valid value logs no warning');
});

test('getIntProp_ does NOT warn when a valid value equals the fallback (not a misconfig)', () => {
  // The set-but-invalid warning must key on validity, not on value === fallback —
  // otherwise legitimately setting MAX_MESSAGES=25 (the default) would log a false warning.
  const gas = loadCollector();
  gas.setGlobals({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => '25' }) } });
  assert.equal(gas.getIntProp_('MAX_MESSAGES', 25, 0, 500), 25);
  assert.ok(!gas.logs.some(a => fmt(a).includes('Ignoring')), 'value equal to the default is still valid');
});

test('getIntProp_ warns (name, bad value, range, default) on a set-but-invalid value', () => {
  const gas = loadCollector();
  gas.setGlobals({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'abc' }) } });
  assert.equal(gas.getIntProp_('MAX_MESSAGES', 25, 0, 500), 25, 'falls back to the default');
  const warn = gas.logs.map(fmt).find(l => l.includes('Ignoring'));
  assert.ok(warn, 'a warning is logged so the misconfig is visible in Executions');
  assert.ok(warn.includes('MAX_MESSAGES'), 'names the property');
  assert.ok(warn.includes('abc'), 'shows the bad value');
  assert.ok(warn.includes('[0, 500]'), 'states the accepted range');
  assert.ok(warn.includes('25'), 'states the default in use');
});

test('getIntProp_ warns on an out-of-range value too (9999 -> default, not clamped)', () => {
  const gas = loadCollector();
  gas.setGlobals({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => '9999' }) } });
  assert.equal(gas.getIntProp_('MAX_MESSAGES', 25, 0, 500), 25);
  assert.ok(gas.logs.map(fmt).some(l => l.includes('Ignoring') && l.includes('9999')), 'out-of-range warned');
});

test('getIntProp_ is silent for an unset or blank property (clearing the field is not a misconfig)', () => {
  for (const raw of [null, '', '   ']) {
    const gas = loadCollector();
    gas.setGlobals({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => raw }) } });
    assert.equal(gas.getIntProp_('MAX_MESSAGES', 25, 0, 500), 25, `raw=${JSON.stringify(raw)} -> default`);
    assert.ok(!gas.logs.some(a => fmt(a).includes('Ignoring')), `raw=${JSON.stringify(raw)} logs no warning`);
  }
});

// --- Integration: drive the real run with stubbed Apps Script globals. ---

// Run collectJobEmailsLocked_ with MAX_MESSAGES set to `prop`. Captures the maxResults
// passed to Gmail.Users.Messages.list (or null if list is never called) and any side
// effects. list returns no messages, so the run exits right after the list call — enough
// to assert the wiring without stubbing the whole pipeline.
function runWithProp(prop) {
  const gas = loadCollector();
  let listMaxResults = null;
  let listCalls = 0;
  const labelCalls = [];
  const upserts = [];
  gas.setGlobals({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) =>
      k === 'MAX_MESSAGES' ? prop : k === 'AIRTABLE_TOKEN' ? 'tok' : null }) },
    Utilities: { getUuid: () => 'uuid-test', newBlob: (d) => ({ getDataAsString: () => Buffer.from(d).toString('utf8') }), base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')) },
    Gmail: {
      Users: {
        Messages: {
          list: (_user, params) => { listCalls++; listMaxResults = params.maxResults; return { messages: [] }; },
          get: () => { throw new Error('Gmail.get must not be called on this path'); },
          modify: (body, _user, id) => { labelCalls.push({ id, label: body.addLabelIds[0] }); },
        },
        // If the 0-disable short-circuit regresses, the run reaches getLabelsById_ here.
        Labels: { list: () => { throw new Error('Labels.list must not be called when disabled'); } },
      },
    },
    UrlFetchApp: { fetch: () => { upserts.push(1); return { getResponseCode: () => 200, getContentText: () => '' }; } },
  });

  gas.collectJobEmailsLocked_();
  return { listMaxResults, listCalls, labelCalls, upserts, logs: gas.logs.map(fmt) };
}

test('MAX_MESSAGES=0 short-circuits before any Gmail fetch (no list, no writes, no labels)', () => {
  const r = runWithProp('0');
  assert.equal(r.listCalls, 0, 'Gmail.Users.Messages.list must NOT be called when processing is disabled');
  assert.equal(r.upserts.length, 0, 'no Airtable writes');
  assert.equal(r.labelCalls.length, 0, 'no labels applied');
  assert.ok(r.logs.some(l => l.includes('MAX_MESSAGES=0') && l.includes('processing disabled')), 'disabled no-op logged');
});

test('an unset property fetches CONFIG.MAX_MESSAGES (parity: behaves exactly as today)', () => {
  const r = runWithProp(null);
  assert.equal(r.listMaxResults, 25, 'maxResults falls back to the source default (25)');
  assert.ok(r.logs.some(l => l.includes('Run config: MAX_MESSAGES=25')), 'effective config logged');
});

test('a valid property overrides the cap; the resolved value reaches maxResults', () => {
  const r = runWithProp('3');
  assert.equal(r.listMaxResults, 3, 'the override (3) is passed to Gmail.Users.Messages.list');
  assert.ok(r.logs.some(l => l.includes('Run config: MAX_MESSAGES=3')), 'effective config logged');
  // Upper boundary through the real wiring (parser-level 500 is covered above): the
  // documented Gmail hard cap reaches maxResults unclamped, not just any in-range value.
  const top = runWithProp('500');
  assert.equal(top.listMaxResults, 500, "the upper-boundary override (500, Gmail's hard cap) reaches maxResults");
});

test('a garbage property falls back to the default cap (maxResults=25, never maxResults=0)', () => {
  const r = runWithProp('abc');
  assert.equal(r.listMaxResults, 25, 'invalid value falls back to 25, so the run still fetches');
  assert.ok(r.logs.map(String).some(l => l.includes('Ignoring')), 'the misconfig is warned');
});
