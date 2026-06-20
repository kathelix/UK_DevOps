/**
 * UK DevOps - Vacancies backup (off-platform CSV snapshot to Google Drive)
 *
 * Why: Airtable has NO API-schedulable / off-site backup — native snapshots are
 * usage-based, UI-only, plan-bound and IN-platform (they die with the base/account; a
 * Team -> Free billing lapse can purge them). The Vacancies table is the pipeline's only
 * irreplaceable asset (Ivan's Applied/Skipped decision history). RawEmails is regenerable
 * from Gmail, so it is NOT backed up here. This script reads the whole Vacancies table and
 * writes it as a dated CSV into a fixed Drive folder, on its own daily time trigger.
 * Design + restore caveat: docs/TECH_DESIGN.md §5; runbook: docs/OPERATIONS.md.
 *
 * Additive and self-contained: this is a SEPARATE .gs file in the same Apps Script project
 * as gmail-collector.gs. All .gs files share ONE global namespace, so this file deliberately
 * does NOT redeclare CONFIG / airtableUrl_ / isTransientWriteFailure_ (collector symbols) — it
 * uses uniquely-named BACKUP.* config and backup*_ helpers, builds the Vacancies endpoint
 * itself, and reuses only the trivially-generic collector helper airtableToken_(). A
 * `git revert` of this file + the appsscript.json Drive scope + .claspignore line + docs fully
 * removes it; the collector's intake/screening/dedup/triggers are untouched.
 *
 * SETUP (one-time, manual — runtime state, not deployed):
 *   1. Script Properties already hold AIRTABLE_TOKEN (shared with the collector); the
 *      backup only READS it. data.records:read is sufficient. Optionally set
 *      BACKUP_FOLDER_ID to override the destination folder below.
 *   2. Run backupVacancies() once -> authorize the new Drive scope (added to appsscript.json).
 *   3. Triggers -> Add trigger -> backupVacancies, time-driven, day timer, late hour
 *      (cadence recorded ONCE in docs/TECH_DESIGN.md §7) — OR call ensureDailyBackupTrigger_()
 *      once from the editor to install exactly one daily trigger programmatically.
 */

// Uniquely-named config object (NOT the collector's CONFIG — one global namespace).
const BACKUP = {
  // Airtable source: the live Vacancies decisions store (base + table ids, rename-safe).
  AIRTABLE_BASE_ID: 'appV9puNHinuRKTk9',
  VACANCIES_TABLE: 'tbl3abC60VRQWb21w',
  // Destination Drive folder (fixed). Overridable at runtime via the BACKUP_FOLDER_ID Script
  // Property (read by backupFolderId_), mirroring the collector's getIntProp_ override convention.
  // https://drive.google.com/drive/u/0/folders/1sJYnFr5lusPM0VhfLqp6mBOYHwWfDq5w
  DRIVE_FOLDER_ID: '1sJYnFr5lusPM0VhfLqp6mBOYHwWfDq5w',
  FILENAME_PREFIX: 'Vacancies_',
  // London for both the filename date and the trigger hour (matches appsscript.json timeZone).
  TIME_ZONE: 'Europe/London',
  // Daily backup hour for ensureDailyBackupTrigger_ (a manual GAS-console trigger is the other
  // option). Late so the day's Applied/Skipped writes are captured. Cadence registry (the single
  // prose source for collect/purge/backup times): docs/TECH_DESIGN.md §7.
  TRIGGER_HOUR: 23,
  // Light transient-retry backoff (ms) for the once-a-day Airtable READ — mirrors the collector's
  // RETRY_BACKOFF_MS contract (one entry per retry => [1s,2s,4s] = 3 retries / 4 attempts). A GET
  // is idempotent so a transport throw is retried too; a missed day self-heals on the next run.
  RETRY_BACKOFF_MS: [1000, 2000, 4000],
  // Vacancies columns in canonical order, mirrored from airtable/schema.json (id = rename-safe,
  // name = the human CSV header). A unit test asserts this stays byte-identical to schema.json's
  // Vacancies table (id + name + order), so this embedded copy can't silently drift — the runtime
  // can't read airtable/schema.json (clasp pushes only apps-script/**), hence the guarded mirror.
  VACANCIES_FIELDS: [
    { id: 'fldPxVR6FTbdV4nEn', name: 'Role' },
    { id: 'fldv5NoMPKxDbuvmc', name: 'Recruiter' },
    { id: 'fldyxDS4z1rn9N6fm', name: 'Type' },
    { id: 'fldtMUI44BWtBvpGs', name: 'Rate/Salary' },
    { id: 'fldx0JREP7vvYiHjW', name: 'Status' },
    { id: 'fldOCTCdsyPtuJuA5', name: 'Date' },
    { id: 'fldbnGIrNk8e1dmvK', name: 'Notes' },
    { id: 'fldz2C7r1hSNrET4i', name: 'Link' },
  ],
};

// ---------- pure helpers (side-effect-free, unit-tested) ----------

// RFC 4180 quoting for one CSV field: wrap in double quotes and double any embedded quote
// IFF the value contains a comma, double-quote, CR or LF; otherwise return it verbatim.
function csvCell_(value) {
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Serialize one Airtable cell value to a CSV string per the backup contract:
//   missing/null/undefined -> ''   (so a blank cell is empty, not the literal "null")
//   string                 -> as-is
//   number / boolean       -> String()
//   object with .name      -> .name  (singleSelect / collaborator-shaped values)
//   array / other object   -> JSON.stringify  (nothing silently dropped)
function serializeCell_(value) {
  if (value === null || value === undefined) return '';
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean') return String(value);
  if (t === 'object') {
    if (typeof value.name === 'string') return value.name; // singleSelect-as-object etc.
    return JSON.stringify(value);                           // arrays / other objects
  }
  return String(value);
}

// Resolve the value for one column descriptor against an Airtable record. Records are fetched
// with returnFieldsByFieldId=true, so field values are keyed by field id (rename-safe).
//   kind 'id'          -> record.id          (the recXXXX record id)
//   kind 'createdTime' -> record.createdTime (Airtable-assigned)
//   kind 'field'       -> record.fields[col.fieldId]
function cellValue_(record, col) {
  if (col.kind === 'id') return record.id;
  if (col.kind === 'createdTime') return record.createdTime;
  return (record.fields || {})[col.fieldId];
}

// Build the ordered column descriptors for the CSV:
//   leading: recordId, createdTime (make a future restore/dedupe clean), then
//   schemaFields in canonical order (header = the human name), then
//   any field id seen in `records` but absent from the schema, appended (header = the raw
//   field id) so a not-yet-schema'd Airtable field is never silently dropped.
// schemaFields: [{ id, name }, ...] — BACKUP.VACANCIES_FIELDS at runtime, airtable/schema.json
// in the drift test.
function vacanciesColumns_(schemaFields, records) {
  const columns = [
    { header: 'recordId', kind: 'id' },
    { header: 'createdTime', kind: 'createdTime' },
  ];
  const seen = {};
  for (const f of schemaFields) {
    columns.push({ header: f.name, kind: 'field', fieldId: f.id });
    seen[f.id] = true;
  }
  for (const rec of (records || [])) {
    const fields = rec.fields || {};
    for (const fid in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, fid)) continue;
      if (seen[fid]) continue;
      seen[fid] = true;
      columns.push({ header: fid, kind: 'field', fieldId: fid }); // unschema'd field — append, don't drop
    }
  }
  return columns;
}

// Render records + column descriptors to an RFC 4180 CSV string (CRLF row separators, header
// row of column names, UTF-8 when written). Pure: 0 records yields a header-only document.
function vacanciesToCsv_(records, columns) {
  const rows = [columns.map(c => csvCell_(c.header)).join(',')];
  for (const rec of (records || [])) {
    rows.push(columns.map(c => csvCell_(serializeCell_(cellValue_(rec, c)))).join(','));
  }
  return rows.join('\r\n');
}

// The dated backup filename for a pre-formatted 'YYYY-MM-DD' London date string.
// Kept timezone-free (the caller formats the date) so it is trivially unit-testable.
function backupFileName_(dateStr) {
  return BACKUP.FILENAME_PREFIX + dateStr + '.csv';
}

// Empty-result guard (pure): a fetch returning 0 records is suspicious (an Airtable outage that
// slipped past the retries, or a misconfigured query) — refuse to overwrite a good prior CSV with
// an empty one. Only > 0 rows are ever written. The entry point throws when this returns false.
function shouldWriteBackup_(recordCount) {
  return recordCount > 0;
}

// 429 / any 5xx are transient (retryable); 200 and a deterministic 4xx are not. Mirrors the
// collector's isTransientWriteFailure_ contract under a unique name (one global namespace).
function backupIsTransientStatus_(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

// ---------- side-effectful helpers (Drive / Airtable / triggers; manual-verified) ----------

// Light transient-retry/backoff wrapper around the Airtable GET — mirrors the collector's
// airtableFetchWithRetry_ contract for an idempotent read: retry ONLY a transient outcome
// (429/5xx, or a UrlFetchApp transport throw — safe to re-send since a GET has no side effect),
// pass a 200 or deterministic 4xx straight back, and after the backoffs are exhausted return the
// last transient response (so the caller's non-200 throw fires) or re-throw the last transport
// error if every attempt threw. No runtime-budget predicate — this runs once a day, not in the
// collector's 6-min loop. Only the transport call is guarded; getResponseCode() is classified
// outside the catch so a response-shape bug propagates with its own stack (CLAUDE.md narrow-catch).
function backupFetchWithRetry_(url, params) {
  const backoffs = BACKUP.RETRY_BACKOFF_MS;
  let lastResp = null;
  let lastErr = null;
  for (let attempt = 0; ; attempt++) {
    let resp = null;
    try {
      resp = UrlFetchApp.fetch(url, params); // only the transport call is guarded
    } catch (e) {
      lastErr = e; // idempotent GET: a transport throw is safe to retry
    }
    if (resp !== null) {
      if (!backupIsTransientStatus_(resp.getResponseCode())) return resp; // 200 / deterministic 4xx
      lastResp = resp; // transient 429/5xx — remember in case retries are exhausted
    }
    if (attempt >= backoffs.length) break; // retries exhausted
    Utilities.sleep(backoffs[attempt]);
  }
  if (lastResp) return lastResp; // exhausted with a transient response: the caller throws on non-200
  throw lastErr;                 // every attempt threw a transport error
}

// The Vacancies REST endpoint (built here, NOT via the collector's RawEmails-bound airtableUrl_).
function backupVacanciesUrl_() {
  return 'https://api.airtable.com/v0/' + BACKUP.AIRTABLE_BASE_ID + '/' +
    encodeURIComponent(BACKUP.VACANCIES_TABLE);
}

// The destination Drive folder id: the BACKUP_FOLDER_ID Script Property when set to a non-blank
// value, else BACKUP.DRIVE_FOLDER_ID. (getStrProp_ does not exist in this project — only
// getIntProp_ — so read the string property directly, like the collector reads DRY_RUN.)
function backupFolderId_() {
  const override = PropertiesService.getScriptProperties().getProperty('BACKUP_FOLDER_ID');
  return (override && override.trim()) ? override.trim() : BACKUP.DRIVE_FOLDER_ID;
}

// GET the whole Vacancies table, following Airtable offset pagination to exhaustion (the REST API
// caps a page at 100 records; Vacancies is well under that today but paginate to be future-proof).
// returnFieldsByFieldId=true makes values rename-safe (keyed by field id). Any non-200 after the
// retries throws (fail-loud -> Failed execution -> GAS failure email), never a silent partial list.
function fetchAllVacancies_() {
  const token = airtableToken_(); // reuse the collector's generic helper (throws if AIRTABLE_TOKEN unset)
  const base = backupVacanciesUrl_();
  const records = [];
  let offset = null;
  do {
    const url = base + '?pageSize=100&returnFieldsByFieldId=true' +
      (offset ? '&offset=' + encodeURIComponent(offset) : '');
    const resp = backupFetchWithRetry_(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code !== 200) {
      throw new Error('Airtable Vacancies list error ' + code + ': ' + resp.getContentText().slice(0, 500));
    }
    const page = JSON.parse(resp.getContentText());
    for (const r of (page.records || [])) records.push(r);
    offset = page.offset || null;
  } while (offset);
  return records;
}

// Write the CSV into the destination folder, REPLACING an existing same-name file's contents
// (idempotent — a re-run the same day updates the one file, never creates a duplicate). text/csv,
// UTF-8. Needs a Drive scope wide enough to open a PRE-EXISTING user folder by id (drive.file only
// covers app-created/opened files), so appsscript.json carries https://www.googleapis.com/auth/drive.
function writeCsvToDrive_(fileName, csv) {
  const folder = DriveApp.getFolderById(backupFolderId_());
  const existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    const file = existing.next();
    file.setContent(csv); // replace contents in place
    return file.getId();
  }
  return folder.createFile(fileName, csv, 'text/csv').getId();
}

// Daily entry point (the trigger handler). Build the entire CSV in memory FIRST, then write — so a
// read/serialize failure never leaves a partial or empty file clobbering a good backup. Fail-loud:
// an Airtable read failure (after retries) or a 0-record result throws; the Drive write throws on
// its own failure. On success, logs the filename + row/column counts.
function backupVacancies() {
  const records = fetchAllVacancies_();
  if (!shouldWriteBackup_(records.length)) {
    Logger.log('Vacancies backup ABORTED: 0 records fetched — refusing to overwrite a good prior CSV ' +
      'with an empty one. If the Vacancies table is genuinely empty this is expected; otherwise an ' +
      'Airtable read problem slipped past the retries — investigate before trusting the backup.');
    throw new Error('Vacancies backup aborted: 0 records fetched (empty-result guard).');
  }
  const columns = vacanciesColumns_(BACKUP.VACANCIES_FIELDS, records);
  const csv = vacanciesToCsv_(records, columns); // fully built BEFORE any write
  const dateStr = Utilities.formatDate(new Date(), BACKUP.TIME_ZONE, 'yyyy-MM-dd');
  const fileName = backupFileName_(dateStr);
  writeCsvToDrive_(fileName, csv);
  Logger.log('Vacancies backup written: %s (%s records, %s columns).',
    fileName, String(records.length), String(columns.length));
}

// Optional: install exactly one daily time-driven trigger on backupVacancies at BACKUP.TRIGGER_HOUR,
// deleting any existing trigger for the handler first (idempotent — safe to re-run). The hour is
// interpreted in the script's timezone (Europe/London per appsscript.json). Needs script.scriptapp
// (already in the manifest). The GAS-console route (Triggers -> Add) is the equivalent manual path.
function ensureDailyBackupTrigger_() {
  const handler = 'backupVacancies';
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger(handler).timeBased().atHour(BACKUP.TRIGGER_HOUR).everyDays(1).create();
}
