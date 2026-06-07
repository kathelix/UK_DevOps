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
  // Make used limit=1 per run; here one run handles a full day's batch:
  MAX_MESSAGES: 1,
  AIRTABLE_BASE_ID: 'appV9puNHinuRKTk9',
  AIRTABLE_TABLE: 'RawEmails',
  // Make's 49k cap (Sheets cell limit) dropped. 100k is Airtable's hard
  // long-text limit - safety truncation only, not a design choice:
  CLEAN_TEXT_LIMIT: 100000,
};

// Module 5 (regexp:Replace) - pattern verbatim.
// Make flags: global=true, sensitive=false, singleline=true, multiline=false  =>  /gis
const CLEAN_REGEX = /(?:^.*?<body[^>]*>|<\/body>.*$|<img\b[^>]*>|\s(?:style|class|id|width|height|align|valign|bgcolor|border|cellpadding|cellspacing|role|aria-[\w-]+|data-[\w-]+)="[^"]*"|<!--[\s\S]*?-->|(?:&#8199;|&#x2007;|&amp;#8199;|&amp;#x2007;|&#65279;|&amp;#65279;|&#9;|&amp;#9;)|(?<=>)\s+(?=<))/gis;

function collectJobEmails() {
  // Script Property DRY_RUN=true -> log would-be writes/labels, touch nothing.
  const dryRun = PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'true';
  const executionId = Utilities.getUuid(); // Sheets column A: {{executionId}}
  const collectedAt = new Date().toISOString(); // Sheets column B: {{now}}

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
  for (const ref of messageRefs) {
    const msg = Gmail.Users.Messages.get('me', ref.id, { format: 'full' });
    const headers = headerMap_(msg.payload.headers || []);
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

  // Write to Airtable first; label as collected ONLY the messages whose batch succeeded
  // (same ordering as Make: Sheets row -> then label).
  let written = 0;
  for (let i = 0; i < records.length; i += 10) { // Airtable max 10 records/request
    const batch = records.slice(i, i + 10);
    const ok = airtableCreate_(batch.map(r => ({ fields: r.fields })));
    if (!ok) {
      Logger.log('Airtable write FAILED for batch starting at %s - those messages stay uncollected and will retry next run.', i);
      continue;
    }
    for (const r of batch) {
      Gmail.Users.Messages.modify({ addLabelIds: [collectedLabelId] }, 'me', r.messageId);
      written++;
    }
  }
  Logger.log('Collected %s of %s message(s).', written, records.length);
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
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
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

// User labels only (type "user"), names joined - mirrors Sheets column J.
function userLabelNames_(labelIds, labelsById) {
  return (labelIds || [])
    .map(id => labelsById[id])
    .filter(l => l && l.type === 'user')
    .map(l => l.name)
    .join(', ');
}

function airtableCreate_(records) {
  const token = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
  if (!token) throw new Error('Script property AIRTABLE_TOKEN is not set.');
  const url = 'https://api.airtable.com/v0/' + CONFIG.AIRTABLE_BASE_ID + '/' +
    encodeURIComponent(CONFIG.AIRTABLE_TABLE);
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ records: records, typecast: true }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() === 200) return true;
  Logger.log('Airtable error %s: %s', resp.getResponseCode(), resp.getContentText().slice(0, 500));
  return false;
}
