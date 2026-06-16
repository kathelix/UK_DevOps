'use strict';

// Unit coverage for the pure Meta-API → schema.json merge:
//   mergeLiveIntoSchema(schema, liveTables[, managedTables]) -> { schema, warnings }
//
// Runs offline (no AIRTABLE_TOKEN, no network) — the CLI wrapper does the live GET
// + the write. The merge backfills ids, adds missing *managed* tables, preserves
// curated prose, warns (never auto-edits) on type drift, and is idempotent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeLiveIntoSchema, MANAGED_TABLES } = require('../airtable/import-schema.js');

// A name-only managed schema (no ids yet) plus the live base that carries them.
// Mirrors the real first-run shape: RawEmails is name-only in schema.json; the
// live base has ids; Vacancies is live but not yet in schema.
function fixtures() {
  const schema = {
    baseId: 'appX',
    comment: 'curated top-level comment',
    tables: [
      {
        name: 'RawEmails',
        description: 'CURATED table description — richer than live',
        fields: [
          { name: 'MessageId', type: 'singleLineText', description: 'curated field description' },
          { name: 'Status', type: 'singleSelect' },
        ],
      },
    ],
  };
  const liveTables = [
    {
      id: 'tblRAW',
      name: 'RawEmails',
      description: 'terse live description',
      fields: [
        { id: 'fldMSG', name: 'MessageId', type: 'singleLineText' },
        { id: 'fldSTAT', name: 'Status', type: 'singleSelect' },
      ],
    },
    {
      id: 'tblVAC',
      name: 'Vacancies',
      description: 'live vacancies description',
      fields: [
        { id: 'fldROLE', name: 'Role', type: 'singleLineText', description: 'Job title' },
        { id: 'fldLINK', name: 'Link', type: 'url' },
      ],
    },
    {
      id: 'tblUNREL',
      name: 'SomethingUnrelated',
      description: 'not version-controlled',
      fields: [{ id: 'fldZ', name: 'Z', type: 'number' }],
    },
  ];
  return { schema, liveTables };
}

test('mergeLiveIntoSchema backfills ids onto managed tables and fields by name', () => {
  const { schema, liveTables } = fixtures();
  const { schema: merged } = mergeLiveIntoSchema(schema, liveTables);

  const raw = merged.tables.find(t => t.name === 'RawEmails');
  assert.equal(raw.id, 'tblRAW', 'table id backfilled');
  assert.equal(raw.fields.find(f => f.name === 'MessageId').id, 'fldMSG', 'field id backfilled');
  assert.equal(raw.fields.find(f => f.name === 'Status').id, 'fldSTAT');
});

test('mergeLiveIntoSchema adds a managed table that is live but missing from schema', () => {
  const { schema, liveTables } = fixtures();
  const { schema: merged } = mergeLiveIntoSchema(schema, liveTables);

  const vac = merged.tables.find(t => t.name === 'Vacancies');
  assert.ok(vac, 'Vacancies (managed, live, absent) is added');
  assert.equal(vac.id, 'tblVAC');
  assert.deepEqual(vac.fields.map(f => f.name), ['Role', 'Link']);
  assert.equal(vac.fields[0].id, 'fldROLE');
});

test('mergeLiveIntoSchema ignores a live table not in the managed allowlist', () => {
  const { schema, liveTables } = fixtures();
  const { schema: merged } = mergeLiveIntoSchema(schema, liveTables);
  assert.equal(merged.tables.find(t => t.name === 'SomethingUnrelated'), undefined);
});

test('mergeLiveIntoSchema preserves curated comment/description (fills ids, not prose)', () => {
  const { schema, liveTables } = fixtures();
  const { schema: merged } = mergeLiveIntoSchema(schema, liveTables);

  assert.equal(merged.comment, 'curated top-level comment');
  const raw = merged.tables.find(t => t.name === 'RawEmails');
  assert.equal(raw.description, 'CURATED table description — richer than live', 'table prose not clobbered');
  assert.equal(
    raw.fields.find(f => f.name === 'MessageId').description,
    'curated field description',
    'field prose not clobbered'
  );
});

test('mergeLiveIntoSchema is idempotent — a second pass produces no change', () => {
  const { schema, liveTables } = fixtures();
  const once = mergeLiveIntoSchema(schema, liveTables).schema;
  const twice = mergeLiveIntoSchema(once, liveTables).schema;
  assert.deepStrictEqual(twice, once);
});

test('mergeLiveIntoSchema does not mutate the caller schema', () => {
  const { schema, liveTables } = fixtures();
  const before = JSON.parse(JSON.stringify(schema));
  mergeLiveIntoSchema(schema, liveTables);
  assert.deepStrictEqual(schema, before, 'input object is untouched (deep clone)');
});

test('mergeLiveIntoSchema warns, never auto-edits, on type drift', () => {
  const schema = {
    baseId: 'appX',
    tables: [{ name: 'RawEmails', fields: [{ name: 'HtmlLength', type: 'number' }] }],
  };
  const liveTables = [
    { id: 'tblRAW', name: 'RawEmails', fields: [{ id: 'fldH', name: 'HtmlLength', type: 'singleLineText' }] },
  ];
  const { schema: merged, warnings } = mergeLiveIntoSchema(schema, liveTables);

  // Type is left as the schema's (not auto-edited to live), and the drift is flagged.
  assert.equal(merged.tables[0].fields[0].type, 'number');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /type drift on RawEmails\.HtmlLength: schema=number live=singleLineText/);
});

test('MANAGED_TABLES is the documented two-table allowlist', () => {
  assert.deepEqual(MANAGED_TABLES, ['RawEmails', 'Vacancies']);
});
