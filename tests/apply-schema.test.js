'use strict';

// Unit coverage for the pure diff logic that makes apply-schema.js rename-safe:
//   planTableChanges(want, liveTable) -> { creates, adds, warnings }
//   matchByIdOrName(want, candidates) -> the matched entry | undefined
//
// These run offline (no AIRTABLE_TOKEN, no network) — the CLI wrapper does the
// live GET/POSTs around these functions. The headline guarantee: a field renamed
// in the Airtable UI is matched by id and reported as drift, NOT re-created as a
// duplicate (the old name-only matching footgun).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planTableChanges, matchByIdOrName } = require('../airtable/apply-schema.js');

// A want-field with an id matching a live field of the SAME name → no-op.
test('planTableChanges (a): id-matched field, same name → no add, no warning', () => {
  const want = { name: 'T', fields: [{ id: 'fldA', name: 'Role', type: 'singleLineText' }] };
  const live = { id: 'tblT', name: 'T', fields: [{ id: 'fldA', name: 'Role', type: 'singleLineText' }] };

  const { creates, adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(creates, []);
  assert.deepEqual(adds, []);
  assert.deepEqual(warnings, []);
});

// THE FOOTGUN TEST: a field renamed in the UI (id matches, name differs) must
// produce a rename-drift warning and NOT be added. We also prove the pre-fix
// name-only matching would have re-created it as a duplicate.
test('planTableChanges (b): id-matched field, different name → rename-drift warning, no add', () => {
  const want = { name: 'Vacancies', fields: [{ id: 'fldX', name: 'NewName', type: 'singleLineText' }] };
  const live = { id: 'tblV', name: 'Vacancies', fields: [{ id: 'fldX', name: 'OldName', type: 'singleLineText' }] };

  const { creates, adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(creates, []);
  assert.deepEqual(adds, [], 'a renamed field must NOT be added (no duplicate)');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /schema\.json says NewName, live is OldName \(fldX\)/);

  // Pre-fix behaviour was name-only: `live.fields.some(f => f.name === field.name)`.
  // Against the renamed live field that lookup misses, so the old code WOULD have
  // POSTed a second "NewName" field — the duplicate this slice prevents.
  const oldCodeWouldFind = live.fields.some(f => f.name === want.fields[0].name);
  assert.equal(oldCodeWouldFind, false, 'old name-only matching misses the rename → would duplicate');
});

// A genuinely new field (no id, absent live) is added — additive, as before.
test('planTableChanges (c): new field with no id, not live → add', () => {
  const want = { name: 'T', fields: [{ name: 'Brand', type: 'singleLineText' }] };
  const live = { id: 'tblT', name: 'T', fields: [{ id: 'fldA', name: 'Role', type: 'singleLineText' }] };

  const { creates, adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(creates, []);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].name, 'Brand');
  assert.deepEqual(warnings, []);
});

// Back-compat: a name-only entry (no id) matching a live name is a no-op.
test('planTableChanges (d): name-only field matching a live name → no add (back-compat)', () => {
  const want = { name: 'T', fields: [{ name: 'Role', type: 'singleLineText' }] };
  const live = { id: 'tblT', name: 'T', fields: [{ id: 'fldA', name: 'Role', type: 'singleLineText' }] };

  const { creates, adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(adds, []);
  assert.deepEqual(warnings, []);
});

// Type drift (matched by id-or-name) is still reported, never acted on.
test('planTableChanges (e): type drift → warning, no add', () => {
  const want = { name: 'T', fields: [{ name: 'Count', type: 'number' }] };
  const live = { id: 'tblT', name: 'T', fields: [{ id: 'fldC', name: 'Count', type: 'singleLineText' }] };

  const { adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(adds, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /type drift on T\.Count: live=singleLineText desired=number/);
});

// A renamed field whose type ALSO drifted surfaces both signals independently.
test('planTableChanges: rename drift and type drift co-occur', () => {
  const want = { name: 'T', fields: [{ id: 'fldX', name: 'NewName', type: 'number' }] };
  const live = { id: 'tblT', name: 'T', fields: [{ id: 'fldX', name: 'OldName', type: 'singleLineText' }] };

  const { adds, warnings } = planTableChanges(want, live);
  assert.deepEqual(adds, []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some(w => /schema\.json says NewName, live is OldName/.test(w)));
  assert.ok(warnings.some(w => /type drift/.test(w)));
});

// Table not found live → create the whole table (CLI POSTs it).
test('planTableChanges: missing table → create', () => {
  const want = { name: 'BrandNew', fields: [{ name: 'A', type: 'singleLineText' }, { name: 'B', type: 'number' }] };

  const { creates, adds, warnings } = planTableChanges(want, undefined);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].name, 'BrandNew');
  assert.deepEqual(adds, []);
  assert.deepEqual(warnings, []);
});

test('matchByIdOrName: id wins when set; name is the fallback', () => {
  const list = [
    { id: 'tbl1', name: 'Alpha' },
    { id: 'tbl2', name: 'Beta' },
  ];
  // id set → matched by id even if a different-named entry, and an id miss is undefined
  assert.equal(matchByIdOrName({ id: 'tbl2', name: 'whatever' }, list).name, 'Beta');
  assert.equal(matchByIdOrName({ id: 'tblNope' }, list), undefined);
  // no id → matched by name
  assert.equal(matchByIdOrName({ name: 'Alpha' }, list).id, 'tbl1');
  assert.equal(matchByIdOrName({ name: 'Missing' }, list), undefined);
  assert.equal(matchByIdOrName({ name: 'x' }, undefined), undefined);
});

// Acceptance criterion: applying the committed Vacancies entry against the live
// base is a NO-OP. The fixture mirrors the live Vacancies field list (ids/names/
// types pulled from the Meta API 2026-06-16); ties the real schema.json to a test.
test('schema.json Vacancies plans ZERO changes against the live field list (no-op apply)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'airtable', 'schema.json'), 'utf8'));
  const vacancies = schema.tables.find(t => t.name === 'Vacancies');
  assert.ok(vacancies, 'Vacancies must be under version control');
  assert.equal(vacancies.id, 'tbl3abC60VRQWb21w');
  assert.equal(vacancies.fields.length, 8);
  assert.ok(vacancies.fields.every(f => /^fld/.test(f.id)), 'every Vacancies field carries an id');

  const liveVacancies = {
    id: 'tbl3abC60VRQWb21w',
    name: 'Vacancies',
    fields: [
      { id: 'fldPxVR6FTbdV4nEn', name: 'Role', type: 'singleLineText' },
      { id: 'fldv5NoMPKxDbuvmc', name: 'Recruiter', type: 'singleLineText' },
      { id: 'fldyxDS4z1rn9N6fm', name: 'Type', type: 'singleSelect' },
      { id: 'fldtMUI44BWtBvpGs', name: 'Rate/Salary', type: 'singleLineText' },
      { id: 'fldx0JREP7vvYiHjW', name: 'Status', type: 'singleSelect' },
      { id: 'fldOCTCdsyPtuJuA5', name: 'Date', type: 'date' },
      { id: 'fldbnGIrNk8e1dmvK', name: 'Notes', type: 'multilineText' },
      { id: 'fldz2C7r1hSNrET4i', name: 'Link', type: 'url' },
    ],
  };

  const { creates, adds, warnings } = planTableChanges(vacancies, liveVacancies);
  assert.deepEqual(creates, [], 'Vacancies already exists live — nothing to create');
  assert.deepEqual(adds, [], 'every Vacancies field already exists by id — nothing to add');
  assert.deepEqual(warnings, [], 'names and types match live — no drift');
});

// The stale "Vacancies … NOT managed here" comment must be gone.
test('schema.json comment no longer claims Vacancies is unmanaged', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'airtable', 'schema.json'), 'utf8'));
  assert.doesNotMatch(schema.comment, /NOT managed/i);
});
