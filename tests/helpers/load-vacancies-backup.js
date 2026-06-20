'use strict';

/**
 * Load apps-script/vacancies-backup.gs into an isolated VM context and expose its
 * pure helpers for unit testing under `node --test`. Sibling of load-collector.js —
 * same rationale (the .gs file is deployed verbatim by clasp and references Apps
 * Script globals that don't exist in Node, so it can't be require()'d), same realm
 * caveats (assert on primitive leaves / serialized forms, never object identity).
 *
 * Only the PURE helpers are exported. The side-effectful entry points (backupVacancies,
 * fetchAllVacancies_, writeCsvToDrive_, ensureDailyBackupTrigger) reference Drive /
 * UrlFetchApp / ScriptApp and the collector's airtableToken_ (a different .gs file in the
 * same GAS namespace) — none defined in this single-file VM context. That's fine: those
 * references resolve at CALL time, and the tests never call them. Drive/Airtable I/O is
 * covered by the manual verification documented in the PR (see slice acceptance criteria).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', '..', 'apps-script', 'vacancies-backup.gs');

// Pure bindings copied out of the script for testing.
const EXPORTS = [
  'BACKUP',
  'csvCell_',
  'serializeCell_',
  'cellValue_',
  'vacanciesColumns_',
  'vacanciesToCsv_',
  'backupFileName_',
  'shouldWriteBackup_',
  'backupIsTransientStatus_',
];

// Minimal Apps Script global stubs — only Logger is needed at load time; the rest are
// placeholders so any top-level reference resolves (there are none today, but mirror the
// collector loader's shape for consistency).
function defaultStubs(logs) {
  return {
    Logger: { log: (...args) => logs.push(args) },
    Utilities: undefined,
    PropertiesService: undefined,
    UrlFetchApp: undefined,
    DriveApp: undefined,
    ScriptApp: undefined,
  };
}

function loadVacanciesBackup() {
  const source = fs.readFileSync(GS_PATH, 'utf8');
  const logs = [];
  const context = vm.createContext(defaultStubs(logs));
  const epilogue = `\n;globalThis.__GAS_EXPORTS__ = { ${EXPORTS.join(', ')} };`;
  vm.runInContext(source + epilogue, context, { filename: 'vacancies-backup.gs' });

  return Object.assign({}, context.__GAS_EXPORTS__, { logs });
}

module.exports = { loadVacanciesBackup, GS_PATH };
