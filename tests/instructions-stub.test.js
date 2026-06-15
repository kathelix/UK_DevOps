'use strict';

// Contract coverage for the externalized-instructions loading mechanism (M6.1).
//
// The claude.ai project field is a thin BOOTSTRAP POINTER (PROJECT_FIELD_STUB.md)
// that reads the canonical, VERSION-ed instructions from the mounted repo file.
// These assertions are the only automated guard on that contract — the live field
// itself lives outside the repo — so they pin the load-contract invariants, not the
// exact prose (the stub wording may be refined):
//   1. the stub points at the EXACT canonical path, and that file actually exists
//      (a dangling pointer would silently break every run),
//   2. the stub carries the fail-loud / no-fallback / version-echo safety trio,
//   3. the canonical file carries a VERSION: line for the stub to echo.
// Pure fs reads — no collector harness needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const CANONICAL_REL = 'instructions/Claude_project_instructions.md';
const STUB_REL = 'instructions/PROJECT_FIELD_STUB.md';

const stub = fs.readFileSync(path.join(repoRoot, STUB_REL), 'utf8');
const canonical = fs.readFileSync(path.join(repoRoot, CANONICAL_REL), 'utf8');

test('stub points at the exact canonical instructions path, and it exists', () => {
  assert.ok(
    stub.includes(CANONICAL_REL),
    `stub must reference ${CANONICAL_REL} verbatim so the field loads the right file`,
  );
  // The pointer must not dangle — if the canonical file is moved/renamed without
  // updating the stub, the live run would fail to load and this catches it offline.
  assert.ok(
    fs.existsSync(path.join(repoRoot, CANONICAL_REL)),
    `${CANONICAL_REL} must exist at the path the stub points at`,
  );
});

test('stub requires the mounted UK_DevOps folder as the source', () => {
  assert.match(stub, /UK_DevOps/, 'stub must name the mounted UK_DevOps folder');
});

test('stub carries the version-echo instruction', () => {
  assert.match(stub, /VERSION:/, 'stub must instruct echoing the loaded VERSION:');
  assert.match(stub, /echo/i, 'stub must instruct the run to echo the version');
});

test('stub carries the fail-loud, no-fallback contract', () => {
  // Fail loud: an absent folder halts the run.
  assert.match(stub, /\bSTOP\b/, 'stub must tell the run to STOP when the folder is absent');
  // No fallback from any of the three forbidden sources.
  assert.match(stub, /memory/i, 'stub must forbid the from-memory fallback');
  assert.match(stub, /cache|cached/i, 'stub must forbid the cached/previous-copy fallback');
  assert.match(stub, /network/i, 'stub must forbid the network fallback');
});

test('canonical instructions file carries a VERSION: line for the stub to echo', () => {
  // Presence only, not a pinned value — the body bumps to 2.0 at the M6.2 cutover.
  assert.match(
    canonical,
    /^VERSION:\s*\d+\.\d+\b/m,
    'canonical file must carry a "VERSION: x.y" line',
  );
});
