/**
 * UK DevOps - Gmail Collector (Google Apps Script port of the Make.com scenario)
 *
 * Faithful reproduction of blueprint "UK DevOps - Gmail Collector":
 *   Gmail search -> Text parser (regex replace) -> store row -> add 'make-collected' label
 * Destination changed from Google Sheets to Airtable (table: RawEmails).
 * No other behavior changes. Improvements come later, iteratively.
 *
 * SETUP (one-time):
 *   1. script.google.com -> New project -> paste this file.
 *   2. Left sidebar "Services" (+) -> add "Gmail API" (Advanced Gmail Service).
 *   3. Project Settings -> Script Properties -> add:
 *        AIRTABLE_TOKEN = <your Airtable PAT with data.records:write on the Job Search base>
 *   4. Create the Airtable table (see gmail-collector-setup.md for the field list).
 *   5. Run collectJobEmails() once manually -> authorize scopes.
 *   6. Triggers -> Add trigger -> collectJobEmails, time-driven, daily 4-5am.
 */

const CONFIG = {
  // Module 1 (google-email:executeEmailSearchQuery), parameter "q" - verbatim:
  QUERY: 'label:job-vacancies -label:job-vacancies/make-collected -label:job-vacancies/make-processing -label:job-vacancies/make-failed',
  // Module 3 (updateEmailLabels) adds this label after a successful write:
  COLLECTED_LABEL_NAME: 'job-vacancies/make-collected',
  // Applied to messages that fail processing (decode errors etc.) so they
  // don't head-of-line block the queue; excluded by QUERY. Created on demand.
  FAILED_LABEL_NAME: 'job-vacancies/make-failed',
  // One run handles a full day's batch (~25/day inflow). Tested at 1 and 5.
  MAX_MESSAGES: 25,
  // Timeout safety: stop fetching once a run has been going this long, well under
  // Apps Script's ~6 min limit. Remaining messages are resumed on the next run.
  MAX_RUNTIME_MS: 300000,
  AIRTABLE_BASE_ID: 'appV9puNHinuRKTk9',
  AIRTABLE_TABLE: 'RawEmails',
  // Upsert merge key (Gmail message id): re-collecting the same message updates
  // its row instead of duplicating it. Used by airtableUpsert_.
  DEDUPE_FIELD: 'MessageId',
  // Make's 49k cap (Sheets cell limit) dropped. 100k is Airtable's hard
  // long-text limit - safety truncation only, not a design choice:
  CLEAN_TEXT_LIMIT: 100000,
};

// Module 5 (regexp:Replace) - pattern verbatim.
// Make flags: global=true, sensitive=false, singleline=true, multiline=false  =>  /gis
const CLEAN_REGEX = /(?:^.*?<body[^>]*>|<\/body>.*$|<img\b[^>]*>|\s(?:style|class|id|width|height|align|valign|bgcolor|border|cellpadding|cellspacing|role|aria-[\w-]+|data-[\w-]+)="[^"]*"|<!--[\s\S]*?-->|(?:&#8199;|&#x2007;|&amp;#8199;|&amp;#x2007;|&#65279;|&amp;#65279;|&#9;|&amp;#9;)|(?<=>)\s+(?=<))/gis;

function collectJobEmails() {
  // Single-flight guard: overlapping scheduled runs cause duplicate writes and
  // label races. tryLock(0) returns immediately; if another run holds the lock,
  // exit cleanly and let it finish — this run's messages stay uncollected (no
  // make-collected label) and are picked up on the next run.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another collector run holds the lock; exiting to avoid overlap.');
    return;
  }
  try {
    collectJobEmailsLocked_();
  } finally {
    lock.releaseLock();
  }
}

// One collector run. Always invoked under the script lock (see collectJobEmails).
function collectJobEmailsLocked_() {
  // Script Property DRY_RUN=true -> log would-be writes/labels, touch nothing.
  const dryRun = PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'true';
  const executionId = Utilities.getUuid(); // Sheets column A: {{executionId}}
  const collectedAt = new Date().toISOString(); // Sheets column B: {{now}}
  const startMs = Date.now(); // anchor for the MAX_RUNTIME_MS timeout-safety budget

  const listResp = Gmail.Users.Messages.list('me', {
    q: CONFIG.QUERY,
    maxResults: CONFIG.MAX_MESSAGES,
  });
  const messageRefs = (listResp.messages || []);
  if (messageRefs.length === 0) {
    Logger.log('No new messages. Done.');
    return;
  }

  const labelsById = getLabelsById_();
  const collectedLabelId = getCollectedLabelId_(labelsById);

  const records = []; // {fields:..., messageId:...}
  for (let i = 0; i < messageRefs.length; i++) {
    // Timeout safety: stop before Apps Script's ~6 min execution limit. Unfetched
    // messages have no make-collected label, so the next run resumes them. Pairs
    // with the MAX_MESSAGES batch size.
    if (isOverRuntimeBudget_(startMs, Date.now())) {
      Logger.log('Runtime budget (%s ms) exceeded; deferring %s remaining message(s) to next run.',
        CONFIG.MAX_RUNTIME_MS, messageRefs.length - i);
      break;
    }
    const ref = messageRefs[i];
    let msg, headers;
    try {
      msg = Gmail.Users.Messages.get('me', ref.id, { format: 'full' });
      headers = headerMap_(msg.payload.headers || []);
      processMessage_(msg, headers, records, executionId, collectedAt, labelsById);
    } catch (e) {
      // Isolate poisoned messages: log forensics, label make-failed (real runs only)
      // so the queue is not head-of-line blocked, and continue.
      Logger.log('FAILED message %s | from: %s | subject: %s | error: %s',
        ref.id,
        headers ? (headers['from'] || '?') : '?',
        headers ? (headers['subject'] || '?') : '?',
        e.message);
      if (msg && msg.payload) Logger.log('MIME tree: %s', mimeTree_(msg.payload));
      if (dryRun) {
        Logger.log('DRY_RUN: would label message %s as %s', ref.id, CONFIG.FAILED_LABEL_NAME);
      } else {
        const failedLabelId = getOrCreateLabelId_(CONFIG.FAILED_LABEL_NAME, labelsById);
        Gmail.Users.Messages.modify({ addLabelIds: [failedLabelId] }, 'me', ref.id);
        Logger.log('Labeled %s as %s — excluded from future runs; inspect manually.', ref.id, CONFIG.FAILED_LABEL_NAME);
      }
    }
  }

  if (dryRun) {
    for (const r of records) {
      Logger.log(
        'DRY_RUN would write: %s | %s | %s | html=%s clean=%s | then add label "%s"',
        r.fields.MessageId, r.fields.FromEmail, r.fields.Subject,
        r.fields.HtmlLength, r.fields.CleanLength, CONFIG.COLLECTED_LABEL_NAME
      );
      Logger.log('DRY_RUN CleanText preview (first 500 chars):\n%s', r.fields.CleanText.substring(0, 500));
    }
    Logger.log('DRY_RUN complete: %s message(s) inspected, nothing written, nothing labeled.', records.length);
    return;
  }

  // Upsert to Airtable first, then label as collected ONLY the messages whose batch
  // succeeded (same ordering as Make: row -> then label). Upsert keyed on MessageId
  // makes the write idempotent: a crash between the write and the labeling re-updates
  // the existing row on the next run instead of creating a duplicate.
  let written = 0;
  for (let i = 0; i < records.length; i += 10) { // Airtable max 10 records/request
    const batch = records.slice(i, i + 10);
    const ok = airtableUpsert_(batch.map(r => ({ fields: r.fields })));
    if (!ok) {
      Logger.log('Airtable upsert FAILED for batch starting at %s - those messages stay uncollected and will retry next run.', i);
      continue;
    }
    for (const r of batch) {
      Gmail.Users.Messages.modify({ addLabelIds: [collectedLabelId] }, 'me', r.messageId);
      written++;
    }
  }
  Logger.log('Collected %s of %s message(s).', written, records.length);
}

// Timeout-safety predicate (pure, unit-tested): true once a run has used its
// MAX_RUNTIME_MS budget. Split out of the fetch loop so the boundary is testable
// without a live clock; called as isOverRuntimeBudget_(startMs, Date.now()).
function isOverRuntimeBudget_(startMs, nowMs) {
  return nowMs - startMs > CONFIG.MAX_RUNTIME_MS;
}

function processMessage_(msg, headers, records, executionId, collectedAt, labelsById) {
  const from = parseFrom_(headers['from'] || ''); // {name, email} - split per Sheets columns F/G
  const htmlBody = extractHtmlBody_(msg.payload) || '';
  const cleanText = htmlBody.replace(CLEAN_REGEX, '');

  records.push({
    messageId: msg.id,
    fields: {
        'MessageId': msg.id,                                       // C: {{1.id}}
        'ExecutionId': executionId,                                // A: {{executionId}}
        'CollectedAt': collectedAt,                                // B: {{now}}
        'ThreadId': msg.threadId,                                  // D: {{1.threadId}}
        'EmailDate': new Date(Number(msg.internalDate)).toISOString(), // E: {{1.internalDate}}
        'FromName': from.name,                                     // F: {{1.fromName}}
        'FromEmail': from.email,                                   // G: {{1.fromEmail}}
        'Subject': headers['subject'] || '',                       // H: {{1.subject}}
        'Snippet': msg.snippet || '',                              // I: {{1.snippet}}
        'UserLabels': userLabelNames_(msg.labelIds, labelsById),   // J: {{1.userLabelFolders[].name}}
        'HtmlLength': htmlBody.length,                             // K: {{length(1.htmlBody)}}
        'CleanLength': cleanText.length,                           // L: {{length(5.text)}}
        'CleanText': cleanText.substring(0, CONFIG.CLEAN_TEXT_LIMIT), // M: cleaned text (49k Sheets cap dropped)
        'Status': 'New', // queue field for the screening pipeline (only addition vs Make)
      },
    });
}

// ---------- helpers ----------

function headerMap_(headers) {
  const map = {};
  for (const h of headers) map[h.name.toLowerCase()] = h.value;
  return map;
}

// "Some Name <a@b.com>" -> {name:"Some Name", email:"a@b.com"}; bare address -> name = email
function parseFrom_(from) {
  const m = from.match(/^\s*"?(.*?)"?\s*<(.+?)>\s*$/);
  if (m) return { name: m[1] || m[2], email: m[2] };
  return { name: from.trim(), email: from.trim() };
}

// Walk MIME tree, return first text/html part decoded (matches Make's htmlBody).
function extractHtmlBody_(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return decodeB64Url_(payload.body.data);
  }
  for (const part of (payload.parts || [])) {
    const found = extractHtmlBody_(part);
    if (found) return found;
  }
  return '';
}

function decodeB64Url_(data) {
  // Apps Script's Advanced Gmail Service auto-decodes 'byte'-format fields:
  // body.data arrives as a NUMBER ARRAY (bytes), not a base64 string.
  // (Diagnosed from: 'invalid char "," at index 2' — a comma-joined array.)
  if (Array.isArray(data)) {
    return Utilities.newBlob(data).getDataAsString('UTF-8');
  }
  // String shape (plain Gmail API behavior), kept as fallback:
  // normalize to the standard alphabet with correct padding,
  // and fail with a FORENSIC error instead of "Could not decode string".
  let s = String(data || '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  const bad = s.match(/[^A-Za-z0-9+\/]/);
  if (bad) {
    throw new Error('base64: invalid char ' + JSON.stringify(bad[0]) +
      ' (code ' + bad[0].charCodeAt(0) + ') at index ' + bad.index + ' of ' + s.length);
  }
  const rem = s.length % 4;
  if (rem === 1) throw new Error('base64: impossible length ' + s.length + ' (mod 4 = 1) — data truncated?');
  if (rem === 2) s += '==';
  if (rem === 3) s += '=';
  return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString('UTF-8');
}

function getLabelsById_() {
  const map = {};
  for (const l of (Gmail.Users.Labels.list('me').labels || [])) map[l.id] = l;
  return map;
}

function getCollectedLabelId_(labelsById) {
  for (const id in labelsById) {
    if (labelsById[id].name === CONFIG.COLLECTED_LABEL_NAME) return id;
  }
  throw new Error('Label not found: ' + CONFIG.COLLECTED_LABEL_NAME);
}

// Find a label by name; create it if missing (e.g. make-failed may not exist yet).
function getOrCreateLabelId_(name, labelsById) {
  for (const id in labelsById) {
    if (labelsById[id].name === name) return id;
  }
  const created = Gmail.Users.Labels.create(
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    'me'
  );
  labelsById[created.id] = created;
  Logger.log('Created label: %s (%s)', name, created.id);
  return created.id;
}

// Compact one-line MIME structure for failure forensics,
// e.g. multipart/alternative(text/plain[data:432], text/html[data:51280])
function mimeTree_(payload) {
  if (!payload) return '?';
  const self = payload.mimeType +
    (payload.body && payload.body.data ? '[data:' + payload.body.data.length + ']' : '') +
    (payload.body && payload.body.attachmentId ? '[attachment]' : '');
  const parts = (payload.parts || []).map(mimeTree_);
  return parts.length ? self + '(' + parts.join(', ') + ')' : self;
}

// User labels only (type "user"), names joined - mirrors Sheets column J.
function userLabelNames_(labelIds, labelsById) {
  return (labelIds || [])
    .map(id => labelsById[id])
    .filter(l => l && l.type === 'user')
    .map(l => l.name)
    .join(', ');
}

// Build the Airtable upsert request body (pure, unit-tested): merge on
// CONFIG.DEDUPE_FIELD so a re-collected message updates its row instead of
// duplicating it. Split out of airtableUpsert_ so the upsert contract can be
// tested without a live UrlFetchApp call.
function buildUpsertPayload_(records) {
  return {
    performUpsert: { fieldsToMergeOn: [CONFIG.DEDUPE_FIELD] },
    records: records,
    typecast: true,
  };
}

// Upsert a batch (<=10 records) into Airtable, merging on CONFIG.DEDUPE_FIELD so a
// re-collected message updates its existing row instead of creating a duplicate.
// Upsert requires PATCH + performUpsert (the POST create endpoint has no upsert).
function airtableUpsert_(records) {
  const token = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
  if (!token) throw new Error('Script property AIRTABLE_TOKEN is not set.');
  const url = 'https://api.airtable.com/v0/' + CONFIG.AIRTABLE_BASE_ID + '/' +
    encodeURIComponent(CONFIG.AIRTABLE_TABLE);
  const resp = UrlFetchApp.fetch(url, {
    method: 'patch', // upsert is PATCH-only; records without an id match on fieldsToMergeOn
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(buildUpsertPayload_(records)),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() === 200) return true;
  Logger.log('Airtable upsert error %s: %s', resp.getResponseCode(), resp.getContentText().slice(0, 500));
  return false;
}
