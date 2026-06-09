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
  // Per-run fetch cap (the default). Overridable at runtime via the MAX_MESSAGES Script
  // Property — integer 0–500, where 0 = processing disabled — without a code change or
  // redeploy (resolved by getIntProp_; see docs/OPERATIONS.md). One run handles a full
  // day's batch (~25/day inflow). Tested at 1 and 5.
  MAX_MESSAGES: 25,
  // Timeout safety: stop starting new sub-batches once a run has been going this long,
  // well under Apps Script's ~6 min limit. Deferred messages resume on the next run.
  // TODO: could be made runtime-tunable via getIntProp_('MAX_RUNTIME_MS', …) with its own bounds; deferred — isOverRuntimeBudget_ reads CONFIG directly, and timeout behaviour is out of the MAX_MESSAGES slice's scope.
  MAX_RUNTIME_MS: 300000,
  // Commit granularity: process the queue in sub-batches of this many messages
  // (fetch -> upsert -> label, each committed before the next), so a timeout or crash
  // loses at most one sub-batch and every run makes forward progress. Clamped at runtime
  // to [1, 10] (clampSubBatchSize_): >10 exceeds Airtable's records/request cap, <1 would
  // stall the loop.
  SUB_BATCH_SIZE: 5,
  AIRTABLE_BASE_ID: 'appV9puNHinuRKTk9',
  AIRTABLE_TABLE: 'RawEmails',
  // Upsert merge key (Gmail message id): re-collecting the same message updates
  // its row instead of duplicating it. Used by airtableUpsert_.
  DEDUPE_FIELD: 'MessageId',
  // Make's 49k cap (Sheets cell limit) dropped. 100k is Airtable's hard
  // long-text limit - safety truncation only, not a design choice:
  CLEAN_TEXT_LIMIT: 100000,

  // --- Tracker-URL resolution (slice feature/tracker-url-resolution) ---
  // Resolve known email tracking-redirect hrefs to their canonical destination and swap
  // them IN PLACE inside the HTML before CLEAN_REGEX, so CleanText carries real links
  // instead of trackers (and shrinks — a tracker is often ~10x its canonical). Only the
  // hosts in TRACKERS are ever network-resolved; that bounds the calls/clicks AND defines
  // the resolution-rate metric's denominator. See docs/OPERATIONS.md.
  //
  // Per-run resolution cap (the default). Runtime-tunable via the MAX_RESOLUTIONS_PER_RUN
  // Script Property (integer 0–MAX_RESOLUTIONS_CAP, resolved by getIntProp_; 0 = resolution
  // disabled = the collector behaves exactly as pre-slice — a kill-switch / A-B knob). The
  // cap is shared across the whole run: once hit, later messages still DETECT their trackers
  // (counted found-not-resolved) but skip the network resolve.
  MAX_RESOLUTIONS_PER_RUN: 100,
  // Upper bound getIntProp_ accepts for the MAX_RESOLUTIONS_PER_RUN property (misconfig
  // guard; the real limiter is MAX_RUNTIME_MS). Out-of-range values fall back to the default.
  MAX_RESOLUTIONS_CAP: 1000,
  // Follow at most this many 3xx hops per tracker URL before giving up (leaving the original).
  RESOLVE_MAX_HOPS: 5,
  // Browser-ish User-Agent for the redirect probes — some trackers 403 obvious bots, and we
  // only read the Location header (we never load the destination page; see resolveTracker_).
  RESOLVE_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Known tracker host patterns (starter set harvested from this inbox; extend via the
  // per-host run log). host: exact ('clicks.reed.co.uk') or wildcard ('*.jobmails.io' →
  // the apex and any subdomain). Optional path: only URLs whose path starts with it count
  // (so a shared host like joblookup.com only resolves its /dispatch redirector, not real
  // listing pages). label: the per-host bucket in the run's "Trackers:" log.
  TRACKERS: [
    { host: 'clicks.reed.co.uk', label: 'reed' },
    { host: 'click.nijobs.com', label: 'nijobs' },
    { host: '*.ct.sendgrid.net', label: 'sendgrid' },
    { host: '*.jobmails.io', label: 'jobmails' },
    { host: '*.pstmrk.it', label: 'postmark' },
    { host: 'www.alertsclk.com', label: 'alertsclk' },
    { host: 'joblookup.com', path: '/dispatch', label: 'joblookup' },
    { host: 'uk.whatjobs.com', path: '/jbe', label: 'whatjobs' },
    { host: 'alerts.jobs.co.uk', path: '/click', label: 'jobsco' },
    { host: 'alerts.talentsource24.com', label: 'talentsource24' },
  ],
  // Never resolve these even on a tracker host — they are not job links and clicking them
  // has side effects (an unsubscribe one-click can actually unsubscribe). Matched as a
  // case-insensitive substring of the decoded URL. Junk links are excluded from BOTH the
  // network resolve and the found/resolved metric (TrackersFound is post-junk-filter).
  RESOLVE_JUNK_REGEX: /(unsubscribe|manage[-_]?alert|email[-_]?settings|preference|view[-_]?in[-_]?browser|tracking[-_]?pixel|\/pixel|\bbeacon\b|cv[-_]?upload|upload[-_]?cv|opt[-_]?out)/i,
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

  // Per-run fetch cap, tunable from Script Properties without a redeploy. Unset / blank /
  // garbage / out-of-range falls back to CONFIG.MAX_MESSAGES (parity with the shipped
  // default); 0 is an explicit "process nothing this run" switch — distinct from DRY_RUN,
  // which still fetches + cleans and only skips writes/labels.
  const maxMessages = getIntProp_('MAX_MESSAGES', CONFIG.MAX_MESSAGES, 0, 500);
  // Per-run tracker-resolution cap, tunable from Script Properties without a redeploy. Same
  // getIntProp_ contract as MAX_MESSAGES (unset/blank/garbage/out-of-range → CONFIG default).
  // 0 = resolution disabled (kill-switch); distinct from MAX_MESSAGES=0, which skips the run.
  const maxResolutions = getIntProp_('MAX_RESOLUTIONS_PER_RUN', CONFIG.MAX_RESOLUTIONS_PER_RUN, 0, CONFIG.MAX_RESOLUTIONS_CAP);
  Logger.log('Run config: MAX_MESSAGES=%s (source default %s); MAX_RESOLUTIONS_PER_RUN=%s (source default %s).',
    maxMessages, CONFIG.MAX_MESSAGES, maxResolutions, CONFIG.MAX_RESOLUTIONS_PER_RUN);
  if (maxMessages === 0) {
    Logger.log('MAX_MESSAGES=0 — processing disabled this run; no fetch, no writes, no labels.');
    return; // deliberate no-op; lock released by the finally wrapper in collectJobEmails.
    // NB: fetch-nothing is the early return, NOT maxResults:0 — that value is ambiguous
    // (Gmail may treat 0 as unset and apply its default page size), so returning is the
    // unambiguous "fetch nothing". The 0 never reaches the list call below.
  }

  const executionId = Utilities.getUuid(); // Sheets column A: {{executionId}}
  const collectedAt = new Date().toISOString(); // Sheets column B: {{now}}
  const startMs = Date.now(); // anchor for the MAX_RUNTIME_MS timeout-safety budget

  const listResp = Gmail.Users.Messages.list('me', {
    q: CONFIG.QUERY,
    maxResults: maxMessages,
  });
  const messageRefs = (listResp.messages || []);
  if (messageRefs.length === 0) {
    Logger.log('No new messages. Done.');
    return;
  }

  const labelsById = getLabelsById_();
  const collectedLabelId = getCollectedLabelId_(labelsById);

  // Run-scoped tracker-resolution state, threaded into processMessage_. The cap (used vs
  // maxResolutions) is shared across every message in the run; the per-host tally and the
  // found/resolved/attempted totals feed the end-of-run "Trackers:" log. dryRun is honoured
  // inside resolveTrackersInHtml_: a dry run still DETECTS trackers (so the preview reports
  // the would-be count) but never clicks or swaps — clicking is an external side effect.
  const resolveCtx = {
    maxResolutions: maxResolutions,
    dryRun: dryRun,
    fetchFn: trackerFetch_,
    used: 0, attempted: 0, found: 0, resolved: 0,
    tally: {}, // { <label>: { found, resolved } }
  };

  // Process the queue in sub-batches of CONFIG.SUB_BATCH_SIZE: fetch -> upsert ->
  // label, committing each sub-batch before starting the next. The single budget guard
  // sits at the TOP of the loop, so once over budget we stop *starting* sub-batches and
  // defer the rest; work already committed in earlier sub-batches is durable. Almost no
  // time has elapsed at the start, so the first sub-batch effectively always runs —
  // every run makes forward progress even under slow fetch, and a timeout/crash loses
  // at most one in-flight sub-batch (re-collected next run, made idempotent by the
  // MessageId upsert). Residual window: within a started sub-batch the <=SUB_BATCH_SIZE
  // label calls are unchecked, so a hard-limit kill can still half-label that one
  // sub-batch — bounded, not eliminated, by the same idempotency.
  let collected = 0;
  let inspected = 0;
  // Clamp the configured sub-batch size to a safe stride: a 0/negative value would never
  // advance `start` (infinite loop), and a value > 10 exceeds Airtable's records/request
  // cap (the oversized PATCH is rejected 422 and the sub-batch would never commit).
  const subBatchSize = clampSubBatchSize_(CONFIG.SUB_BATCH_SIZE);
  if (subBatchSize !== CONFIG.SUB_BATCH_SIZE) {
    Logger.log('CONFIG.SUB_BATCH_SIZE=%s is out of range [1,10]; using %s.', CONFIG.SUB_BATCH_SIZE, subBatchSize);
  }
  for (let start = 0; start < messageRefs.length; start += subBatchSize) {
    if (isOverRuntimeBudget_(startMs, Date.now())) {
      Logger.log('Runtime budget (%s ms) exceeded; deferring %s message(s) to next run.',
        CONFIG.MAX_RUNTIME_MS, messageRefs.length - start);
      break;
    }

    // Fetch + parse this sub-batch; isolate poisoned messages (label make-failed on
    // real runs) so one bad message does not block its neighbours or the queue.
    const records = []; // {fields:..., messageId:...}
    for (const ref of messageRefs.slice(start, start + subBatchSize)) {
      let msg, headers;
      try {
        msg = Gmail.Users.Messages.get('me', ref.id, { format: 'full' });
        headers = headerMap_(msg.payload.headers || []);
        processMessage_(msg, headers, records, executionId, collectedAt, labelsById, resolveCtx);
      } catch (e) {
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
    inspected += records.length;
    if (records.length === 0) continue;

    if (dryRun) {
      for (const r of records) {
        Logger.log(
          'DRY_RUN would write: %s | %s | %s | html=%s clean=%s trackersFound=%s | then add label "%s"',
          r.fields.MessageId, r.fields.FromEmail, r.fields.Subject,
          r.fields.HtmlLength, r.fields.CleanLength, r.fields.TrackersFound, CONFIG.COLLECTED_LABEL_NAME
        );
        Logger.log('DRY_RUN CleanText preview (first 500 chars):\n%s', r.fields.CleanText.substring(0, 500));
      }
      continue; // touch nothing
    }

    // Upsert the sub-batch first (<=SUB_BATCH_SIZE <= Airtable's 10/request cap), then
    // label as collected ONLY if the upsert succeeded (same ordering as Make: row ->
    // label). The MessageId upsert makes a re-collected message update its row instead
    // of duplicating it, so the write-then-label ordering is crash-safe.
    const ok = airtableUpsert_(records.map(r => ({ fields: r.fields })));
    if (!ok) {
      Logger.log('Airtable upsert FAILED for sub-batch starting at %s - those messages stay uncollected and will retry next run.', start);
      continue;
    }
    for (const r of records) {
      Gmail.Users.Messages.modify({ addLabelIds: [collectedLabelId] }, 'me', r.messageId);
      collected++;
    }
  }

  logTrackerSummary_(resolveCtx);
  if (dryRun) {
    Logger.log('DRY_RUN complete: %s message(s) inspected, nothing written, nothing labeled.', inspected);
  } else {
    Logger.log('Collected %s of %s message(s).', collected, messageRefs.length);
  }
}

// Timeout-safety predicate (pure, unit-tested): true once a run has used its
// MAX_RUNTIME_MS budget. Split out of the fetch loop so the boundary is testable
// without a live clock; called as isOverRuntimeBudget_(startMs, Date.now()).
function isOverRuntimeBudget_(startMs, nowMs) {
  return nowMs - startMs > CONFIG.MAX_RUNTIME_MS;
}

// Clamp the sub-batch stride to [1, 10] (pure, unit-tested): >=1 keeps the loop
// advancing; <=10 keeps each upsert within Airtable's records/request cap.
function clampSubBatchSize_(n) {
  return Math.max(1, Math.min(n, 10));
}

// Parse a Script Property value as an integer in [min, max] (pure, unit-tested).
// Returns `raw` as an integer ONLY if, after trimming, it is all digits (/^\d+$/) and
// lands within [min, max]; otherwise returns `fallback`. Deliberately strict and
// non-clamping: a sign, decimal point, blank, or out-of-range value is a misconfig, not
// something to coerce or nudge to a bound — so it cleanly falls back to the default.
function parseIntProp_(raw, fallback, min, max) {
  if (raw == null) return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return fallback;        // non-digits / sign / decimal / blank -> default
  const n = parseInt(s, 10);
  return (n >= min && n <= max) ? n : fallback; // out of range -> default (no clamping)
}

// Read an integer Script Property, delegating validation to parseIntProp_. When the
// property IS set to a non-blank value that parseIntProp_ rejects, log a warning (name,
// bad value, accepted range) so the misconfig is visible in Executions. Unset or blank
// falls back silently — clearing the field is not a misconfig.
function getIntProp_(name, fallback, min, max) {
  const raw = PropertiesService.getScriptProperties().getProperty(name);
  // `null` fallback doubles as a "rejected" sentinel: parseIntProp_ only ever returns an
  // integer in [min, max] for a valid `raw`, so a null result means raw was absent/invalid
  // — this distinguishes a rejected value from a valid one that happens to equal `fallback`.
  const parsed = parseIntProp_(raw, null, min, max);
  if (parsed !== null) return parsed;
  if (raw != null && String(raw).trim() !== '') {
    Logger.log('Ignoring Script property %s=%s — not an integer in [%s, %s]; using default %s.',
      name, JSON.stringify(raw), min, max, fallback);
  }
  return fallback;
}

function processMessage_(msg, headers, records, executionId, collectedAt, labelsById, resolveCtx) {
  const from = parseFrom_(headers['from'] || ''); // {name, email} - split per Sheets columns F/G
  const htmlBody = extractHtmlBody_(msg.payload) || '';
  // Resolve known tracker hrefs to their canonical destination and swap them in place,
  // working on the HTML BEFORE CLEAN_REGEX (href values carry entity-encoded ampersands —
  // resolveTrackersInHtml_ decodes to fetch but swaps the original encoded string). With
  // resolution disabled or no trackers present, resolution.html === htmlBody, so cleanText
  // is byte-identical to pre-slice. HtmlLength stays the ORIGINAL html length (parity with
  // Make's length(1.htmlBody)); only CleanText/CleanLength reflect the swap's shrinkage.
  const resolution = resolveTrackersInHtml_(htmlBody, resolveCtx);
  const cleanText = resolution.html.replace(CLEAN_REGEX, '');

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
        'HtmlLength': htmlBody.length,                             // K: {{length(1.htmlBody)}} — original html
        'CleanLength': cleanText.length,                           // L: {{length(5.text)}} — post-swap, post-clean
        'CleanText': cleanText.substring(0, CONFIG.CLEAN_TEXT_LIMIT), // M: cleaned text (49k Sheets cap dropped)
        'TrackersFound': resolution.found,                         // distinct known trackers detected (post junk-filter)
        'TrackersResolved': resolution.resolved,                   // of those, how many reached a canonical + were swapped
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

// ---------- tracker-URL resolution ----------

// Harvest, classify, junk-filter, resolve and in-place-swap tracker hrefs in one HTML body.
// Returns { html, found, resolved } for this message and mutates the run-scoped ctx
// (shared cap `used`/`maxResolutions`, the `attempted`/`found`/`resolved` totals, and the
// per-host `tally`). Side-effect-free w.r.t. ctx when disabled. The fetch is taken from
// ctx.fetchFn so tests can inject canned 302/Location sequences (no real network).
//
// Contract preserved for parity: when resolution is disabled (maxResolutions === 0) OR the
// body has no known, non-junk tracker hrefs, the returned html is the input unchanged, so
// the downstream CleanText is byte-identical to pre-slice.
function resolveTrackersInHtml_(htmlBody, ctx) {
  // Kill-switch / pre-slice parity: no harvest, no network, byte-identical output.
  if (!ctx || ctx.maxResolutions === 0) return { html: htmlBody, found: 0, resolved: 0 };

  // Dedupe within the message on the exact (still-encoded) href string: resolve each once,
  // and a split/join swap then replaces ALL of its occurrences in the body.
  const uniqueHrefs = dedupe_(harvestHrefs_(htmlBody));
  let html = htmlBody;
  let found = 0;
  let resolved = 0;

  for (const rawHref of uniqueHrefs) {
    const url = decodeEntities_(rawHref); // real URL (href values carry &amp; etc.)
    const tracker = classifyTracker_(url);
    if (!tracker) continue;               // not a known tracker host → leave untouched, uncounted
    if (isJunkLink_(url)) continue;       // unsubscribe/manage/pixel/cv-upload → never resolve, uncounted

    found++;
    ctx.found++;
    bumpTally_(ctx.tally, tracker.label, 'found');

    if (ctx.dryRun) continue;                       // dry run: count the would-be work, never click/swap
    if (ctx.used >= ctx.maxResolutions) continue;   // shared cap hit → found-not-resolved (counted above)

    ctx.used++;
    ctx.attempted++;
    const canonical = resolveTracker_(url, ctx.fetchFn);
    if (!canonical) continue;                        // unresolved → original tracker stays in place

    resolved++;
    ctx.resolved++;
    bumpTally_(ctx.tally, tracker.label, 'resolved');
    html = html.split(rawHref).join(canonical);      // swap the ORIGINAL encoded string, all occurrences
  }

  return { html: html, found: found, resolved: resolved };
}

// All href attribute values in an HTML string (both quote styles), still entity-encoded and
// in document order. Empty hrefs are skipped. Pure.
function harvestHrefs_(html) {
  const out = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const v = (m[1] !== undefined ? m[1] : m[2]);
    if (v) out.push(v);
  }
  return out;
}

// Order-preserving de-duplication of a string array. Pure.
function dedupe_(arr) {
  const seen = {};
  const out = [];
  for (const s of arr) {
    if (!Object.prototype.hasOwnProperty.call(seen, s)) { seen[s] = true; out.push(s); }
  }
  return out;
}

// Decode the HTML entities that appear in href values so we fetch the real URL. The
// dominant case is &amp; → & between query params; numeric (&#38; / &#x26;) and the other
// common named entities are handled too. Pure. (Operates only on harvested href strings, so
// the figure-space/BOM entities CLEAN_REGEX targets are not a concern here.)
function decodeEntities_(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Classify a (decoded) URL against CONFIG.TRACKERS. Returns { label } if its host matches a
// tracker pattern (exact or '*.suffix' wildcard) AND, when the pattern pins a path, the URL's
// path starts with it; otherwise null. Pure.
function classifyTracker_(url) {
  const h = hostOf_(url);
  if (!h) return null;
  for (const t of CONFIG.TRACKERS) {
    let hostOk;
    if (t.host.charAt(0) === '*' && t.host.charAt(1) === '.') {
      const suffix = t.host.slice(2);                    // '*.jobmails.io' → 'jobmails.io'
      hostOk = (h === suffix) || h.slice(-(suffix.length + 1)) === ('.' + suffix);
    } else {
      hostOk = (h === t.host);
    }
    if (!hostOk) continue;
    if (t.path && pathOf_(url).indexOf(t.path) !== 0) continue; // path pinned but doesn't match
    return { label: t.label || 'other' };
  }
  return null;
}

// True if a (decoded) URL is a non-job link we must never resolve even on a tracker host.
// Pure; matches CONFIG.RESOLVE_JUNK_REGEX as a case-insensitive substring.
function isJunkLink_(url) {
  return CONFIG.RESOLVE_JUNK_REGEX.test(String(url));
}

// Resolve one tracker URL to its canonical destination by following 3xx redirects via header
// reads ONLY (we never load the destination page, so destination CAPTCHA/bot-walls are
// irrelevant). Returns the first non-tracker URL reached, or null if unresolved — a non-3xx
// response, a missing/relative Location, still-a-tracker after RESOLVE_MAX_HOPS hops, or any
// fetch exception all leave the original in place. fetchFn(url) is injected for testability.
function resolveTracker_(url, fetchFn) {
  let current = url;
  for (let hop = 0; hop < CONFIG.RESOLVE_MAX_HOPS; hop++) {
    let resp;
    try {
      resp = fetchFn(current);
    } catch (e) {
      return null; // network/timeout exception → unresolved, keep the original
    }
    const code = resp.getResponseCode();
    if (code < 300 || code >= 400) return null;            // non-3xx → never reached a canonical
    const loc = locationHeader_(resp);
    if (!loc || !/^https?:\/\//i.test(loc)) return null;   // no Location, or relative (v1 doesn't join) → unresolved
    if (!classifyTracker_(loc)) return loc;                // first non-tracker host reached → canonical
    current = loc;                                          // still a tracker → keep following
  }
  return null;                                             // max hops, still a tracker → unresolved
}

// Production fetch for resolveTracker_: a single non-following 3xx probe with a browser-ish
// UA. muteHttpExceptions so a 4xx/5xx returns a response (→ unresolved) instead of throwing.
// NB: UrlFetchApp has no per-call timeout (~60s default); a hanging tracker can cost up to
// ~60s/hop. The per-run MAX_RESOLUTIONS cap and the MAX_RUNTIME_MS budget bound the blast
// radius (the run defers the rest) — see docs/OPERATIONS.md and the slice PR.
function trackerFetch_(url) {
  return UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: false,
    muteHttpExceptions: true,
    headers: { 'User-Agent': CONFIG.RESOLVE_USER_AGENT },
  });
}

// Case-insensitive Location header read from a UrlFetchApp-style response. Handles both
// getAllHeaders() (V8) and the older getHeaders(), and an array value (repeated header).
function locationHeader_(resp) {
  const headers = (resp.getAllHeaders ? resp.getAllHeaders() : (resp.getHeaders ? resp.getHeaders() : {})) || {};
  for (const k in headers) {
    if (k.toLowerCase() === 'location') {
      const v = headers[k];
      return Array.isArray(v) ? (v[0] || '') : (v || '');
    }
  }
  return '';
}

// Lowercased host of an http(s) URL, port stripped. '' if not an http(s) URL. Pure.
function hostOf_(url) {
  const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url));
  return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
}

// Lowercased path of an http(s) URL (the part after the host, up to ? or #), defaulting to
// '/' when absent. Used only for tracker path-prefix matching. Pure.
function pathOf_(url) {
  const m = /^https?:\/\/[^\/?#]*([^?#]*)/i.exec(String(url));
  const p = m ? m[1] : '';
  return (p || '/').toLowerCase();
}

// Increment a per-host tally bucket ({ found, resolved }), creating it on first use.
function bumpTally_(tally, label, key) {
  const t = tally[label] || (tally[label] = { found: 0, resolved: 0 });
  t[key]++;
}

// End-of-run structured resolution log: overall rate + per-host found/resolved so we can see
// which tracker families fail and extend CONFIG.TRACKERS. attempted=N is shown only when the
// per-run cap stopped us short of `found`.
function logTrackerSummary_(ctx) {
  if (!ctx || ctx.maxResolutions === 0) {
    Logger.log('Trackers: resolution disabled (MAX_RESOLUTIONS_PER_RUN=0).');
    return;
  }
  if (ctx.found === 0) {
    Logger.log('Trackers: found=0 (no known trackers this run).');
    return;
  }
  const perHost = Object.keys(ctx.tally).sort()
    .map(function (h) { return h + ' ' + ctx.tally[h].resolved + '/' + ctx.tally[h].found; })
    .join(', ');
  if (ctx.dryRun) {
    Logger.log('Trackers: found=%s (dry run — resolution skipped, nothing clicked) | %s', ctx.found, perHost);
    return;
  }
  const pct = Math.round((ctx.resolved / ctx.found) * 100);
  const attemptedStr = (ctx.attempted < ctx.found) ? (' attempted=' + ctx.attempted) : '';
  // The '%' rides inside a %s argument (pct + '%') rather than a literal %% — Logger.log's
  // handling of %% is not worth relying on, and this renders identically either way.
  Logger.log('Trackers: found=%s resolved=%s (%s)%s | %s', ctx.found, ctx.resolved, pct + '%', attemptedStr, perHost);
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
