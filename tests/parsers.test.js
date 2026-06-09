'use strict';

// Unit coverage for the two pure parsing helpers that shape stored fields:
//   parseFrom_    -> FromName / FromEmail (Sheets columns F/G)
//   decodeB64Url_ -> the decoded HTML body (both shapes the Gmail service returns)

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCollector } = require('./helpers/load-collector');

const { parseFrom_, decodeB64Url_ } = loadCollector();

test('parseFrom_ splits "Name <email>" and falls back to the raw address', () => {
  // Assert on primitive leaves (the returned object lives in the VM realm, so
  // deepStrictEqual against a Node literal would fail the prototype check).
  const eq = (input, name, email) => {
    const r = parseFrom_(input);
    assert.equal(r.name, name, `name for ${JSON.stringify(input)}`);
    assert.equal(r.email, email, `email for ${JSON.stringify(input)}`);
  };

  eq('"Some Name" <a@b.com>', 'Some Name', 'a@b.com');     // quoted display name
  eq('Bare Name <x@y.co>', 'Bare Name', 'x@y.co');         // unquoted display name
  eq('"ZipRecruiter"<jobs@ziprecruiter.co.uk>', 'ZipRecruiter', 'jobs@ziprecruiter.co.uk'); // no space before '<'
  eq('<only@addr.com>', 'only@addr.com', 'only@addr.com'); // empty name -> falls back to the address
  eq('plain@addr.com', 'plain@addr.com', 'plain@addr.com'); // bare address, no angle brackets
  eq('', '', '');                                          // empty
  eq('   ', '', '');                                       // whitespace only -> trimmed
});

test('decodeB64Url_ decodes the byte-array shape (Advanced Gmail Service)', () => {
  // body.data arrives as a NUMBER ARRAY from the Advanced Gmail Service.
  assert.equal(decodeB64Url_([72, 105]), 'Hi');
  assert.equal(decodeB64Url_([]), '');
});

test('decodeB64Url_ decodes the base64url string shape with any padding', () => {
  const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url'); // emitted without '=' padding
  for (const s of ['Hello', 'Hello World', 'a', 'ab', 'abc', 'pound £ sign']) {
    // exercises mod-4 lengths 0/2/3 and a multi-byte (UTF-8) payload
    assert.equal(decodeB64Url_(b64url(s)), s, `round-trip for ${JSON.stringify(s)}`);
  }
});

test('decodeB64Url_ maps the URL-safe alphabet (- and _) and tolerates whitespace', () => {
  // Byte vectors chosen so the base64url contains '-' (index 62) and '_' (index 63).
  const dash = Buffer.from([0xfb, 0xff, 0xff]); // -> "-___"
  const under = Buffer.from([0x7f, 0x7f, 0x7f]); // -> "f39_"
  assert.ok(dash.toString('base64url').includes('-'), 'vector should contain "-"');
  assert.ok(under.toString('base64url').includes('_'), 'vector should contain "_"');
  assert.equal(decodeB64Url_(dash.toString('base64url')), dash.toString('utf8'));
  assert.equal(decodeB64Url_(under.toString('base64url')), under.toString('utf8'));
  // embedded whitespace is stripped before decoding
  assert.equal(decodeB64Url_('SGVs bG8\n'), 'Hello');
});

test('decodeB64Url_ throws forensic errors on undecodable input', () => {
  // These mirror the diagnostics the collector logs when a message fails to decode.
  assert.throws(() => decodeB64Url_('!!!!'), /invalid char/);
  assert.throws(() => decodeB64Url_('A'), /impossible length/); // length mod 4 == 1
});
