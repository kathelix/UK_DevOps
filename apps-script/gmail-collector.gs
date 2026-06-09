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
  Logger.log('Run config: MAX_MESSAGES=%s (source default %s).', maxMessages, CONFIG.MAX_MESSAGES);
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
  // Per-run tally for the offline link-cleanup step (see cleanLinksInHtml_), accumulated
  // across sub-batches in processMessage_ and logged once after the loop. decoded = embedded
  // destinations recovered, utmStripped = URLs that had >=1 utm_ param removed, bytesSaved =
  // total chars removed across all in-place swaps. Pure/offline — no network, no schema field.
  const linkStats = { decoded: 0, utmStripped: 0, bytesSaved: 0 };
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
        processMessage_(msg, headers, records, executionId, collectedAt, labelsById, linkStats);
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
          'DRY_RUN would write: %s | %s | %s | html=%s clean=%s | then add label "%s"',
          r.fields.MessageId, r.fields.FromEmail, r.fields.Subject,
          r.fields.HtmlLength, r.fields.CleanLength, CONFIG.COLLECTED_LABEL_NAME
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

  // Offline link-cleanup metric — once per run, log line only (no Airtable field). Logged in
  // both real and DRY_RUN paths since the cleanup runs in processMessage_ either way.
  Logger.log('Links: decoded=%s utm_stripped=%s bytes_saved=%s',
    linkStats.decoded, linkStats.utmStripped, linkStats.bytesSaved);

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

function processMessage_(msg, headers, records, executionId, collectedAt, labelsById, linkStats) {
  const from = parseFrom_(headers['from'] || ''); // {name, email} - split per Sheets columns F/G
  const htmlBody = extractHtmlBody_(msg.payload) || '';
  // Offline link cleanup (NO network): decode trackers that embed their destination in a
  // query param (URL/path-guarded) and strip utm_* analytics params, in place, BEFORE
  // CLEAN_REGEX. With neither present this is a byte-identical no-op, so CleanText matches
  // the pre-cleanup output exactly. HtmlLength stays the ORIGINAL html length (Make parity);
  // only CleanText / CleanLength reflect the cleanup.
  const linkClean = cleanLinksInHtml_(htmlBody);
  linkStats.decoded += linkClean.decoded;
  linkStats.utmStripped += linkClean.utmStripped;
  linkStats.bytesSaved += linkClean.bytesSaved;
  const cleanText = linkClean.html.replace(CLEAN_REGEX, '');

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

// ---------- offline link cleanup (pure, unit-tested; makes NO network calls) ----------
// Before CLEAN_REGEX we mechanically clean URLs in the HTML body, click-free: (a) decode
// trackers that embed their destination in a query param, then (b) strip utm_* analytics
// params. We deliberately never fetch/follow anything — probing tracker links can trigger
// side-effect endpoints (one-click unsubscribe, 1-click-apply) and opaque tracker tokens
// are server-expandable only. Opaque-token resolution stays at the screening layer.

// Trailing punctuation trimmed off a harvested URL (sentence/markup punctuation the greedy
// match would otherwise swallow). A linear character walk from the end, NOT an anchored regex:
// a pattern like /[.,…]+$/ backtracks O(n^2) on a long run of trailing-punct chars followed by
// a non-match, and since the harvest char class is a superset of this set the whole run lands
// in one token — a sender-controlled URL could exploit that to stall the run. '>', '"', "'"
// cannot occur (excluded by the harvest char class) but are kept for completeness with the slice.
const URL_TRAILING_PUNCT = '.,;:!?)]}>"\'';
function trimTrailingPunct_(s) {
  let end = s.length;
  while (end > 0 && URL_TRAILING_PUNCT.indexOf(s.charAt(end - 1)) !== -1) end--;
  return s.slice(0, end);
}

// Harvest every URL in the HTML — href="…" values AND bare-text URLs — with one regex, trim
// trailing punctuation, and dedupe (first occurrence wins, order preserved). The char class
// stops only at whitespace / quotes / <>, so a query separator — whether the encoded '&amp;'
// (ZipRecruiter) or a raw '&' (CV-Library, Google Analytics) — stays part of the URL; both
// occur in real job-alert HTML. We return the original (still entity-encoded) string so the
// in-place swap replaces every occurrence verbatim.
// KNOWN LIMITATION: a BARE-TEXT URL (not inside an href="…", so not bounded by a quote)
// immediately followed by a content entity (&nbsp;, &hellip;, &#160;, …) absorbs that entity
// into the match — '&' is indistinguishable from a raw query separator here. It only matters if
// that URL also carries utm_/an embedded destination (so it gets rewritten); href-bounded URLs
// (the real corpus — see tests/fixtures/email-cv-library.html) are unaffected. Documented in
// docs/KNOWN_ISSUES.md rather than fixed, because excluding '&' would truncate the real raw-'&'
// trackers above.
function harvestUrls_(html) {
  const re = /https?:\/\/[^\s"'<>]+/g;
  const seen = {};
  const out = [];
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const url = trimTrailingPunct_(m[0]);
    if (url && !Object.prototype.hasOwnProperty.call(seen, url)) {
      seen[url] = true;
      out.push(url);
    }
  }
  return out;
}

// Split a URL into { base, query, fragment }: base is everything before '?'; query is between
// '?' and '#' WITHOUT the leading '?' (null when absent); fragment includes the leading '#'
// ('' when absent). Fragment is split off first so a '?' inside a fragment is not treated as a
// query delimiter.
function splitUrl_(url) {
  const s = String(url);
  const hashAt = s.indexOf('#');
  const fragment = hashAt === -1 ? '' : s.slice(hashAt);
  const beforeFrag = hashAt === -1 ? s : s.slice(0, hashAt);
  const qAt = beforeFrag.indexOf('?');
  if (qAt === -1) return { base: beforeFrag, query: null, fragment: fragment };
  return { base: beforeFrag.slice(0, qAt), query: beforeFrag.slice(qAt + 1), fragment: fragment };
}

// scheme://host of a URL (no path/query/fragment), for prepending to an absolute-path
// destination. Returns '' if the string is not an absolute http(s) URL.
function schemeHostOf_(url) {
  const m = String(url).match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1] : '';
}

// URL-decode a single query-param value, returning null if it is malformed (so the caller
// skips it rather than throwing). decodeURIComponent leaves '+' alone — we are decoding a URL
// component, not form data, so '+' must stay '+'.
function decodeComponent_(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return null;
  }
}

// (a) DECODE EMBEDDED DESTINATION. Walk the query params in document order; for the FIRST
// param whose URL-decoded value is EITHER an absolute http(s) URL OR an absolute path ('/…',
// not protocol-relative '//…'), return that as the destination — prepending the tracker's own
// scheme+host for a path. There is NO param-name list: the "value must be a URL/path" guard is
// the whole filter (decided with Ivan — zero list to maintain, maximally future-proof; the
// accepted cost is a non-destination URL-valued param earlier in document order being
// mis-picked, rare in click-trackers). Returns null when no param qualifies (URL unchanged by
// this step). The guard is what stops false positives on params like ?r=5 or ?u=alice.
function decodeEmbeddedDestination_(url) {
  const parts = splitUrl_(url);
  if (parts.query === null || parts.query === '') return null;
  const params = parts.query.split(/&amp;|&/); // both separators occur in an HTML-body URL
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const rawVal = param.slice(eq + 1);
    if (!rawVal) continue;
    const decoded = decodeComponent_(rawVal);
    if (decoded === null) continue;
    // A real destination is a single URL token: it never contains whitespace or HTML
    // delimiters. decodeURIComponent turns %3C / %3E / %22 / %20 into live <, >, ", space, so
    // an un-guarded decode would let a sender-controlled tracker inject HTML structure that
    // CLEAN_REGEX then acts on (a decoded "</body>" truncates CleanText). Reject any decoded
    // value outside the harvest token shape ([^\s"'<>]+) — what we reinsert stays a valid URL.
    if (/[\s"'<>]/.test(decoded)) continue;
    if (/^https?:\/\//i.test(decoded)) return decoded; // absolute URL destination
    if (decoded.charAt(0) === '/' && decoded.charAt(1) !== '/') {
      const origin = schemeHostOf_(url);
      if (origin) return origin + decoded; // absolute-path destination -> tracker's own origin
    }
  }
  return null;
}

// (b) STRIP UTM. Remove every query param whose NAME (case-insensitive) starts with 'utm_',
// preserving all other params, their order, their original '&'/'&amp;' separators, and any
// #fragment. Returns the URL UNCHANGED (byte-identical) when no utm_ param is present, so a
// link with nothing to strip is left exactly as-is (parity). { url, stripped }.
function stripUtm_(url) {
  const parts = splitUrl_(url);
  if (parts.query === null || parts.query === '') return { url: String(url), stripped: false };
  // Tokenize keeping separators: 'a=1&amp;utm=x&b=2' -> ['a=1','&amp;','utm=x','&','b=2']
  // (params at even indices, the separator that PRECEDED each at the odd index before it).
  const tokens = parts.query.split(/(&amp;|&)/);
  const kept = []; // { raw, sep }
  let removed = false;
  for (let i = 0; i < tokens.length; i += 2) {
    const raw = tokens[i];
    const eq = raw.indexOf('=');
    const name = (eq === -1 ? raw : raw.slice(0, eq)).toLowerCase();
    if (name.indexOf('utm_') === 0) { removed = true; continue; }
    kept.push({ raw: raw, sep: i === 0 ? '' : tokens[i - 1] });
  }
  if (!removed) return { url: String(url), stripped: false };
  let q = '';
  for (let i = 0; i < kept.length; i++) q += (i === 0 ? '' : kept[i].sep) + kept[i].raw;
  const rebuilt = parts.base + (q ? '?' + q : '') + parts.fragment;
  return { url: rebuilt, stripped: true };
}

// Clean one URL: decode embedded destination (a) THEN strip utm_ (b) — a decoded destination
// may itself carry utm. Returns the URL UNCHANGED when neither step changes anything (parity).
// { url, decoded, utmStripped }.
function cleanUrl_(url) {
  const dest = decodeEmbeddedDestination_(url);
  const decoded = dest !== null;
  const stripResult = stripUtm_(decoded ? dest : String(url));
  return { url: stripResult.url, decoded: decoded, utmStripped: stripResult.stripped };
}

// Clean every URL in the HTML body in place (offline): compute the cleaned form of each UNIQUE
// URL once (harvestUrls_ dedupes), then swap via ONE position-based pass with the same regex.
// Using replace() over the ORIGINAL string — rather than repeated split/join on `out` — means a
// freshly-inserted cleaned destination is never re-scanned, so a URL that is a substring of
// another (or that a decoded destination happens to contain) can't be corrupted by a later
// swap. A URL whose cleaned form equals the original is left byte-identical, so html with no
// qualifying URLs comes back unchanged (parity). decoded / utmStripped are counted once per
// changed unique URL; bytesSaved is the net chars removed. The regex MUST match harvestUrls_'s.
// Returns { html, decoded, utmStripped, bytesSaved }.
function cleanLinksInHtml_(html) {
  const original = String(html);
  const changed = {}; // trimmedUrl -> { cleaned, decoded, utmStripped } (only URLs that change)
  for (const url of harvestUrls_(original)) {
    const res = cleanUrl_(url);
    if (res.url !== url) changed[url] = { cleaned: res.url, decoded: res.decoded, utmStripped: res.utmStripped };
  }
  let decoded = 0;
  let utmStripped = 0;
  const counted = {};
  const out = original.replace(/https?:\/\/[^\s"'<>]+/g, function (match) {
    const url = trimTrailingPunct_(match);
    const info = changed[url];
    if (!info) return match; // unchanged URL -> leave the occurrence byte-identical
    if (!Object.prototype.hasOwnProperty.call(counted, url)) {
      counted[url] = true;
      if (info.decoded) decoded++;
      if (info.utmStripped) utmStripped++;
    }
    return info.cleaned + match.slice(url.length); // preserve any trimmed trailing punctuation
  });
  return { html: out, decoded: decoded, utmStripped: utmStripped, bytesSaved: original.length - out.length };
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
