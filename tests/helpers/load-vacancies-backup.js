'use strict';

/**
 * Load apps-script/vacancies-backup.gs into an isolated VM context and expose its
 * pure helpers for unit testing under `node --test`. Sibling of load-collector.js —
 * same rationale (the .gs file is deployed verbatim by clasp and references Apps
 * Script globals that don't exist in Node, so it can't be require()'d), same realm
 * caveats (assert on primitive leaves / serialized forms, never object identity).
 *
 * The pure helpers plus the `backupVacancies` entry point are exported. The side-effectful
 * paths reference Drive / UrlFetchApp / PropertiesService / Utilities and the collector's
 * airtableToken_ (a different .gs file in the same GAS namespace) — none defined in this
 * single-file VM context. Those references resolve at CALL time, so the pure-helper tests
 * (which never call them) load fine, and the entry-point test injects stubs via setGlobals()
 * to drive backupVacancies through its empty-result guard and a one-write success path.
 * Real Drive/Airtable I/O stays in the manual verification documented in the PR.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', '..', 'apps-script', 'vacancies-backup.gs');

// Bindings copied out of the script for testing — the pure helpers plus the backupVacancies
// entry point (driven through injected stubs to pin the empty-result guard wiring).
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
  'backupVacancies',
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

  return Object.assign({}, context.__GAS_EXPORTS__, {
    // Lines captured from Logger.log during a call (array of arg-arrays).
    logs,
    // Install/override globals seen by the loaded functions — including the collector's
    // airtableToken_, which lives in a different .gs file (one GAS namespace at runtime).
    setGlobals(overrides) { Object.assign(context, overrides); },
  });
}

module.exports = { loadVacanciesBackup, GS_PATH };
