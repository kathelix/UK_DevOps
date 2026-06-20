'use strict';

// Unit coverage for the pure helpers of apps-script/vacancies-backup.gs — the daily
// off-platform Vacancies -> CSV Drive backup. The side-effectful entry point
// (backupVacancies / Drive + Airtable I/O) is covered by the manual verification in the
// PR body; here we pin the pure CSV/column/guard logic and the schema-drift guard.
//
// Realm caveat (same as the collector suites): values built in the VM realm have the VM's
// prototypes, so we assert on primitive leaves / serialized strings, never object identity.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVacanciesBackup } = require('./helpers/load-vacancies-backup');

const {
  BACKUP,
  csvCell_,
  serializeCell_,
  vacanciesColumns_,
  vacanciesToCsv_,
  backupFileName_,
  shouldWriteBackup_,
  backupIsTransientStatus_,
} = loadVacanciesBackup();

test('csvCell_ quotes only fields needing it (RFC 4180), doubling embedded quotes', () => {
  // Plain fields pass through verbatim.
  assert.equal(csvCell_('plain'), 'plain');
  assert.equal(csvCell_(''), '');
  assert.equal(csvCell_('a b c'), 'a b c');
  // Comma -> quoted.
  assert.equal(csvCell_('a,b'), '"a,b"');
  // Embedded double-quote -> quoted AND the quote doubled.
  assert.equal(csvCell_('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell_('"'), '""""');
  // Newline (LF) and carriage return -> quoted.
  assert.equal(csvCell_('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell_('line1\r\nline2'), '"line1\r\nline2"');
  assert.equal(csvCell_('has\rcr'), '"has\rcr"');
});

test('serializeCell_ applies the backup serialization contract', () => {
  // missing / null / undefined -> empty string
  assert.equal(serializeCell_(null), '');
  assert.equal(serializeCell_(undefined), '');
  // string as-is; number / boolean stringified
  assert.equal(serializeCell_('Applied'), 'Applied');
  assert.equal(serializeCell_(42), '42');
  assert.equal(serializeCell_(0), '0');
  assert.equal(serializeCell_(true), 'true');
  // object with a .name -> .name (singleSelect-as-object / collaborator-shaped)
  assert.equal(serializeCell_({ name: 'Contract', color: 'blue' }), 'Contract');
  // array -> JSON string (nothing dropped)
  assert.equal(serializeCell_(['a', 'b']), '["a","b"]');
  // other object without a usable .name -> JSON string
  assert.equal(serializeCell_({ foo: 1 }), '{"foo":1}');
  // empty-string name is still an object branch but name is '' -> falls to .name === '' (a string)
  assert.equal(serializeCell_({ name: '' }), '');
});

test('vacanciesColumns_ orders recordId, createdTime, schema fields, then appends unschema-d fields', () => {
  const schemaFields = [
    { id: 'fldA', name: 'Role' },
    { id: 'fldB', name: 'Status' },
  ];
  // A record carrying an extra field id not in the schema must NOT be dropped.
  const records = [{ id: 'rec1', fields: { fldA: 'x', fldZ: 'surprise' } }];
  const cols = vacanciesColumns_(schemaFields, records);

  // Assert on primitive leaves. cols is a VM-realm array, so `.map()` returns a VM-realm array
  // whose prototype trips deepStrictEqual — Array.from() re-homes it into this (Node) realm first.
  const headers = Array.from(cols.map(c => c.header));
  const kinds = Array.from(cols.map(c => c.kind));
  assert.deepEqual(headers, ['recordId', 'createdTime', 'Role', 'Status', 'fldZ']);
  assert.deepEqual(kinds, ['id', 'createdTime', 'field', 'field', 'field']);
  // The leading columns carry no fieldId; the schema + extra columns map to their field ids.
  assert.equal(cols[2].fieldId, 'fldA');
  assert.equal(cols[3].fieldId, 'fldB');
  assert.equal(cols[4].fieldId, 'fldZ'); // appended unschema-d field keeps its id as header AND key
});

test('vacanciesToCsv_ renders header + rows with serialization, column order and CRLF separators', () => {
  const schemaFields = [
    { id: 'fldRole', name: 'Role' },
    { id: 'fldType', name: 'Type' },
    { id: 'fldNotes', name: 'Notes' },
  ];
  const records = [
    {
      id: 'rec1',
      createdTime: '2026-06-20T10:00:00.000Z',
      fields: {
        fldRole: 'DevOps, Senior',                 // comma -> must be quoted
        fldType: { name: 'Contract' },             // singleSelect object -> .name
        // fldNotes missing -> empty string
      },
    },
    {
      id: 'rec2',
      createdTime: '2026-06-20T11:00:00.000Z',
      fields: {
        fldRole: 'SRE',
        fldType: 'Permanent',                      // singleSelect as plain string
        fldNotes: 'line1\nline2',                  // newline -> must be quoted
      },
    },
  ];
  const cols = vacanciesColumns_(schemaFields, records);
  const csv = vacanciesToCsv_(records, cols);

  const expected = [
    'recordId,createdTime,Role,Type,Notes',
    'rec1,2026-06-20T10:00:00.000Z,"DevOps, Senior",Contract,',
    'rec2,2026-06-20T11:00:00.000Z,SRE,Permanent,"line1\nline2"',
  ].join('\r\n');
  assert.equal(csv, expected);
});

test('vacanciesToCsv_ on 0 records yields a header-only document (no trailing separator)', () => {
  const schemaFields = [{ id: 'fldRole', name: 'Role' }];
  const cols = vacanciesColumns_(schemaFields, []);
  const csv = vacanciesToCsv_([], cols);
  assert.equal(csv, 'recordId,createdTime,Role');
  assert.equal(csv.indexOf('\r\n'), -1, 'header-only output has no row separator');
});

test('backupFileName_ builds the dated CSV name for a fixed London date', () => {
  assert.equal(backupFileName_('2026-06-20'), 'Vacancies_2026-06-20.csv');
  assert.equal(backupFileName_('2025-01-01'), 'Vacancies_2025-01-01.csv');
});

test('shouldWriteBackup_ refuses an empty result and allows any non-empty one', () => {
  assert.equal(shouldWriteBackup_(0), false); // 0 rows -> abort, don't clobber a good backup
  assert.equal(shouldWriteBackup_(1), true);
  assert.equal(shouldWriteBackup_(133), true);
});

test('backupIsTransientStatus_ classifies 429/5xx transient, 200 and 4xx not', () => {
  for (const c of [429, 500, 502, 503, 599]) {
    assert.equal(backupIsTransientStatus_(c), true, `${c} should be transient`);
  }
  for (const c of [200, 400, 401, 404, 422, 499, 600]) {
    assert.equal(backupIsTransientStatus_(c), false, `${c} should not be transient`);
  }
});

test('BACKUP.VACANCIES_FIELDS stays in lockstep with airtable/schema.json (id + name + order)', () => {
  // The runtime can't read schema.json (clasp pushes only apps-script/**), so the column order
  // is mirrored in the .gs. This guard fails the moment the mirror drifts from the SSOT.
  const schemaPath = path.join(__dirname, '..', 'airtable', 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const vacancies = schema.tables.find(t => t.id === BACKUP.VACANCIES_TABLE);
  assert.ok(vacancies, 'Vacancies table (BACKUP.VACANCIES_TABLE) present in schema.json');

  const schemaFields = vacancies.fields.map(f => `${f.id}|${f.name}`);
  // BACKUP.VACANCIES_FIELDS is a VM-realm array; Array.from() re-homes the mapped result into this
  // realm so deepStrictEqual compares the primitive-string leaves, not the (differing) prototype.
  const embedded = Array.from(BACKUP.VACANCIES_FIELDS.map(f => `${f.id}|${f.name}`));
  assert.deepEqual(embedded, schemaFields);
});

test('BACKUP source ids match airtable/schema.json base + Vacancies table', () => {
  const schemaPath = path.join(__dirname, '..', 'airtable', 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(BACKUP.AIRTABLE_BASE_ID, schema.baseId);
  assert.ok(schema.tables.some(t => t.id === BACKUP.VACANCIES_TABLE && t.name === 'Vacancies'));
});
