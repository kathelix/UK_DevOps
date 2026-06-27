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
// Mirrors the original first-run shape (RawEmails was name-only in schema.json
// before its ids were backfilled 2026-06-17); the live base has ids; Vacancies
// is live but not yet in schema.
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

test('MANAGED_TABLES is the documented three-table allowlist', () => {
  assert.deepEqual(MANAGED_TABLES, ['RawEmails', 'Vacancies', 'PostTopics']);
});

// Fixed-point guard on the *real* committed schema. The live field ids were captured
// from the production base (appV9puNHinuRKTk9) via the Airtable MCP on 2026-06-17 and
// backfilled into airtable/schema.json token-free, by feeding this same literal to
// mergeLiveIntoSchema. Re-running the merge against the committed schema must therefore
// be a no-op with zero warnings — pinning schema.json as a fixed point so a future
// hand-edit that drops an id or drifts a type fails loudly here. Only id/name/type are
// needed: the merge backfills id and checks type, preserving each field's own prose.
const committedSchema = require('../airtable/schema.json');
const LIVE_TABLES = [
  {
    id: 'tblm8d89dUVG16Bk0',
    name: 'RawEmails',
    fields: [
      { id: 'fldZ8YqUloxk4ASTT', name: 'MessageId', type: 'singleLineText' },
      { id: 'fldozyipyl25yPacJ', name: 'ExecutionId', type: 'singleLineText' },
      { id: 'fldD9AJWyzghCetED', name: 'CollectedAt', type: 'dateTime' },
      { id: 'fldJyZVs6sqzJxe2K', name: 'ThreadId', type: 'singleLineText' },
      { id: 'fldvSWEKHFYjXXFq7', name: 'EmailDate', type: 'dateTime' },
      { id: 'fld8WHi0qNfqyq3kE', name: 'FromName', type: 'singleLineText' },
      { id: 'fldYpA9VwsmBgBdHh', name: 'FromEmail', type: 'singleLineText' },
      { id: 'fldJL9Ef4Ix5yq45a', name: 'Subject', type: 'singleLineText' },
      { id: 'fld1dU9mUnQcaoEhA', name: 'Snippet', type: 'multilineText' },
      { id: 'flddjvljetvX5noLB', name: 'UserLabels', type: 'singleLineText' },
      { id: 'fldairypVjtaqv2Ng', name: 'HtmlLength', type: 'number' },
      { id: 'fldo7yWY11FI1noZ5', name: 'CleanLength', type: 'number' },
      { id: 'fldjVAoDoLlAofeTT', name: 'CleanText', type: 'multilineText' },
      { id: 'fld4l6CSqEqHMgRWi', name: 'Status', type: 'singleSelect' },
    ],
  },
  {
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
  },
];

test('committed schema.json is a fixed point of the merge against the captured live ids (no drift, no-op)', () => {
  const { schema: merged, warnings } = mergeLiveIntoSchema(committedSchema, LIVE_TABLES);
  assert.deepEqual(warnings, [], 'no type-drift warnings — every committed type matches live');
  assert.deepStrictEqual(merged, committedSchema, 'merge is a no-op: every managed table/field already carries its live id');
});
