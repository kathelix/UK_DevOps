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
 *        AIRTABLE_TOKEN = <your Airtable PAT with data.records:read+write on the Job
 *          Search base — read is required by purgeRawEmails (count/list); re-scope or
 *          replace an older write-only PAT before enabling the purge trigger>
 *   4. Create the Airtable table (see gmail-collector-setup.md for the field list).
 *   5. Run collectJobEmails() once manually -> authorize scopes.
 *   6. Triggers -> Add trigger -> collectJobEmails, time-driven. Cadence is tuned in
 *      the GAS console and recorded ONCE in docs/TECH_DESIGN.md section 7 — triggers
 *      are runtime state; the console is the live authority.
 *   7. Triggers -> Add trigger -> purgeRawEmails, time-driven, nightly (time recorded
 *      in the same TECH_DESIGN section; the RawEmails janitor — see the purge section
 *      at the bottom of this file).
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
  // --- RawEmails purge job (purgeRawEmails; own nightly trigger, docs/TECH_DESIGN.md §7) ---
  // The Airtable FREE plan caps a base at 1,000 records across ALL tables, so RawEmails
  // shares the budget with Vacancies (crossed 2026-06-10 — see docs/KNOWN_ISSUES.md).
  // When the RawEmails count exceeds the high-water mark, the purge deletes the oldest
  // eligible rows until the count is back at the low-water mark. Both runtime-tunable
  // via Script Properties of the same names (getIntProp_, bounds [0, 1000]; a resolved
  // HIGH <= LOW is incoherent and falls back to BOTH defaults).
  PURGE_HIGH_WATER: 700,
  PURGE_LOW_WATER: 500,
  // Hard eligibility floor (deliberately NOT runtime-tunable): only Status='Processed'
  // rows with CollectedAt older than this many days are ever deleted. Status='New' rows
  // (the unscreened queue) are NEVER deleted in code — an emergency purge of
  // unprocessed rows is a manual/owner action, not a code path. Enforced server-side
  // by purgeEligibilityFormula_.
  PURGE_MIN_AGE_DAYS: 2,
  // Capacity alarm: at/above this count with NOTHING eligible to purge, throw so the
  // execution ends Failed and the GAS failure email fires BEFORE Airtable starts
  // blocking writes at the 1,000-record cap.
  PURGE_EMERGENCY: 950,
  // Records per REST DELETE request — the REST API's cap (NB: differs from the
  // Airtable scripting-environment batch cap of 50).
  PURGE_DELETE_BATCH: 10,
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
  // NB: numeric args to Logger.log are String()-wrapped throughout this file. On the live
  // GAS runtime '%s' marshals a JS number to a Java Double, so an integer prints as "114.0";
  // String(114) -> "114" preserves the documented integer log format. (The Node test harness
  // substitutes %s the JS way, so it can't catch this — observed live 2026-06-10.)
  Logger.log('Run config: MAX_MESSAGES=%s (source default %s).', String(maxMessages), String(CONFIG.MAX_MESSAGES));
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
  // Same per-run tally for the table-wrapper unwrap (collapseTableWrappers_, applied after
  // CLEAN_REGEX in processMessage_): wrapper tables collapsed + chars dropped, logged once
  // after the loop next to the Links: line.
  const unwrapStats = { tables: 0, bytesSaved: 0 };
  // Per-run tally for the per-sender footer cutoff (truncateAtFooter_, applied after the
  // unwrap in processMessage_): hits = footers cut, misses = mapped senders whose marker was
  // absent/too-early (a likely template change), bytesCut = chars dropped. The first miss's
  // domain + msg id seed the end-of-run alarm message. Logged once after the loop next to the
  // Links:/Unwrap: lines; a miss ends a REAL run Failed (see below) so the GAS failure email fires.
  const footerStats = { hits: 0, misses: 0, bytesCut: 0, firstMissDomain: '', firstMissMsgId: '' };
  // Fail-loudly accumulator, incremented in the sub-batch loop on each write failure that
  // leaves records stuck — a transient sub-batch (429/5xx/throw), a transient individual
  // retry, or a systemic 4xx sub-batch (every record rejected, no healthy sibling). A
  // make-failed poison record (isolated, with a healthy sibling) is handled, NOT counted.
  // Mid-run behaviour is unchanged (skip labelling, continue — the data-integrity contract:
  // failed messages stay unlabelled and retry next run), but a run with any such failure
  // must END Failed: GAS failure emails fire only on Failed executions, so a hard Airtable
  // write-block would otherwise stall RawEmails silently while every run shows "Completed".
  // Re-raised after the summary logs.
  const upsertFailures = { count: 0, first: '' };
  // Clamp the configured sub-batch size to a safe stride: a 0/negative value would never
  // advance `start` (infinite loop), and a value > 10 exceeds Airtable's records/request
  // cap (the oversized PATCH is rejected 422 and the sub-batch would never commit).
  const subBatchSize = clampSubBatchSize_(CONFIG.SUB_BATCH_SIZE);
  if (subBatchSize !== CONFIG.SUB_BATCH_SIZE) {
    Logger.log('CONFIG.SUB_BATCH_SIZE=%s is out of range [1,10]; using %s.', String(CONFIG.SUB_BATCH_SIZE), String(subBatchSize));
  }
  for (let start = 0; start < messageRefs.length; start += subBatchSize) {
    if (isOverRuntimeBudget_(startMs, Date.now())) {
      Logger.log('Runtime budget (%s ms) exceeded; deferring %s message(s) to next run.',
        String(CONFIG.MAX_RUNTIME_MS), String(messageRefs.length - start));
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
        processMessage_(msg, headers, records, executionId, collectedAt, labelsById, linkStats, unwrapStats, footerStats);
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
          String(r.fields.HtmlLength), String(r.fields.CleanLength), CONFIG.COLLECTED_LABEL_NAME
        );
        Logger.log('DRY_RUN CleanText preview (first 500 chars):\n%s', r.fields.CleanText.substring(0, 500));
      }
      continue; // touch nothing
    }

    // Upsert the sub-batch first (<=SUB_BATCH_SIZE <= Airtable's 10/request cap), then
    // label as collected ONLY if the upsert succeeded (same ordering as Make: row ->
    // label). The MessageId upsert makes a re-collected message update its row instead
    // of duplicating it, so the write-then-label ordering is crash-safe.
    const batch = attemptUpsert_(records.map(r => ({ fields: r.fields })));
    if (batch.kind === 'ok') {
      for (const r of records) {
        Gmail.Users.Messages.modify({ addLabelIds: [collectedLabelId] }, 'me', r.messageId);
        collected++;
      }
      continue;
    }
    if (batch.kind === 'transient') {
      // 429/5xx/outage, or a network throw: leave the WHOLE sub-batch uncollected and retry
      // next run (write-then-label means an unlabelled message re-presents). Count toward the
      // fail-loud throw; never make-failed — a transient is not poison.
      upsertFailures.count++;
      if (!upsertFailures.first) upsertFailures.first = batch.first;
      Logger.log('Airtable upsert FAILED (transient %s) for sub-batch starting at %s — those messages stay uncollected and will retry next run.', String(batch.code), String(start));
      continue;
    }

    // batch.kind === 'poison': a deterministic 4xx rejected the whole PATCH (Airtable batch
    // writes are all-or-nothing), so >=1 record is a record-specific reject. Re-send each
    // record on its OWN PATCH — through airtableUpsert_ (via attemptUpsert_), so the deferred
    // retry/backoff wrapper composes later — to tell a poison record (4xx) apart from a
    // healthy sibling (200) or a transient blip (429/5xx/throw). This isolates poison from
    // its good siblings on the WRITE side, mirroring the per-message read-side isolation above.
    Logger.log('Airtable upsert returned %s for sub-batch starting at %s — re-sending its %s record(s) individually to isolate the reject.',
      String(batch.code), String(start), String(records.length));
    const isolated = records.map(function (r) { return { r: r, res: attemptUpsert_([{ fields: r.fields }]) }; });
    // Quarantine guard (prevents mass-quarantine on a systemic error): only make-failed a
    // poison record if >=1 sibling upserted 200 — proof the endpoint/auth/schema is healthy
    // and the 4xx is record-specific. Zero successes => systemic (bad auth, wrong endpoint,
    // schema drift): make-failed NONE so a deploy mistake can't quarantine the whole queue;
    // leave it all uncollected for a human and fail loud.
    const anyHealthy = isolated.some(function (o) { return o.res.kind === 'ok'; });
    for (const o of isolated) {
      if (o.res.kind === 'ok') {
        Gmail.Users.Messages.modify({ addLabelIds: [collectedLabelId] }, 'me', o.r.messageId);
        collected++;
      } else if (o.res.kind === 'transient') {
        // Rate-limit/outage on this record's PATCH (including one provoked by firing the
        // individual PATCHes in quick succession) — retry next run, never make-failed.
        upsertFailures.count++;
        if (!upsertFailures.first) upsertFailures.first = o.res.first;
        Logger.log('Airtable individual upsert FAILED (transient %s) for message %s — stays uncollected, retries next run.', String(o.res.code), o.r.messageId);
      } else if (anyHealthy) {
        // Record-specific poison with a proven-healthy sibling: quarantine it so its good
        // siblings stop being re-fetched (and the run stops failing) every run. make-failed
        // excludes it from CONFIG.QUERY; deterministic, so a retry would only reject again.
        const failedLabelId = getOrCreateLabelId_(CONFIG.FAILED_LABEL_NAME, labelsById);
        Gmail.Users.Messages.modify({ addLabelIds: [failedLabelId] }, 'me', o.r.messageId);
        Logger.log('Labeled %s as %s — deterministic Airtable reject (%s) with >=1 healthy sibling; excluded from future runs, inspect manually.',
          o.r.messageId, CONFIG.FAILED_LABEL_NAME, String(o.res.code));
      } else {
        // Systemic: every record 4xx, no healthy sibling. Do NOT quarantine — leave uncollected
        // and count toward the fail-loud throw so a human fixes the auth/endpoint/schema cause.
        upsertFailures.count++;
        if (!upsertFailures.first) upsertFailures.first = o.res.first;
        Logger.log('Airtable individual upsert FAILED (%s) for message %s — every record in the sub-batch was rejected (systemic, not record-specific); NOT quarantined, left for manual fix.',
          String(o.res.code), o.r.messageId);
      }
    }
  }

  // Offline link-cleanup metric — once per run, log line only (no Airtable field). Logged in
  // both real and DRY_RUN paths since the cleanup runs in processMessage_ either way.
  Logger.log('Links: decoded=%s utm_stripped=%s bytes_saved=%s',
    String(linkStats.decoded), String(linkStats.utmStripped), String(linkStats.bytesSaved));
  // Table-wrapper unwrap rollup (per-email lines carry msg=<id>; this run total doesn't).
  Logger.log('Unwrap: tables=%s bytes_saved=%s',
    String(unwrapStats.tables), String(unwrapStats.bytesSaved));
  // Per-sender footer cutoff rollup (per-email lines carry msg=<id>; this run total doesn't).
  // Always logged, both paths — the cutoff runs in processMessage_ either way.
  Logger.log('Footer: hits=%s misses=%s bytes_cut=%s',
    String(footerStats.hits), String(footerStats.misses), String(footerStats.bytesCut));

  if (dryRun) {
    Logger.log('DRY_RUN complete: %s message(s) inspected, nothing written, nothing labeled.', String(inspected));
  } else {
    Logger.log('Collected %s of %s message(s).', String(collected), String(messageRefs.length));
    // Footer-miss summary, built once and surfaced whether it stands alone or is folded into the
    // upsert-failure throw below. '' when there were no misses this run.
    const footerMissMsg = footerStats.misses > 0
      ? footerStats.misses + ' footer marker miss(es); first: ' +
        footerStats.firstMissDomain + ' msg=' + footerStats.firstMissMsgId
      : '';
    if (upsertFailures.count > 0) {
      // The upsert failure is the PRIMARY signal (a data-integrity event) and is named first. But
      // a footer miss in a sub-batch that DID commit is already make-collected and will NOT recur
      // — so the upsert throw must not silently swallow it (F1, PR #17): fold the footer-miss
      // summary into the SAME thrown error, so the one GAS failure email carries both signals.
      // Thrown only AFTER the loop and the summary logs: every successful sub-batch is already
      // committed and labelled, so no work is lost — the throw only flips the execution to Failed
      // to trigger the GAS failure notification.
      let msg = upsertFailures.count + ' sub-batch upsert(s) failed; first: ' + upsertFailures.first;
      if (footerMissMsg) msg += '. Also ' + footerMissMsg;
      throw new Error(msg);
    }
    // Footer-marker miss alarm (no upsert failure this run). Fires only AFTER the loop and the
    // summary: every cut row is already committed, the throw only flips the execution to Failed so
    // the GAS failure email tells Ivan to update the changed marker. The cost (owner-accepted
    // 2026-06-10): a changed template fails ~48 runs/day until the marker is fixed.
    if (footerMissMsg) {
      throw new Error(footerMissMsg);
    }
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

// Classify an Airtable write HTTP status (pure, unit-tested): true for a transient,
// retry-worthy failure — 429 (rate limit) or any 5xx (Airtable-side outage) — false for
// everything else, including the deterministic 4xx rejects (400/401/404/422) that the
// sub-batch loop isolates per-record and may make-failed. Split out of the loop so the
// poison-vs-transient boundary is testable in isolation, mirroring isOverRuntimeBudget_.
function isTransientWriteFailure_(code) {
  return code === 429 || (code >= 500 && code <= 599);
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
      name, JSON.stringify(raw), String(min), String(max), String(fallback));
  }
  return fallback;
}

function processMessage_(msg, headers, records, executionId, collectedAt, labelsById, linkStats, unwrapStats, footerStats) {
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
  // Collapse layout-only single-child table wrappers AFTER CLEAN_REGEX (bare-tag matching
  // is simpler post-regex; see the stage banner above collapseTableWrappers_). Byte-identical
  // no-op when nothing matches. The per-email metric logs in real and DRY_RUN runs alike —
  // the unwrap runs here either way; numeric args String()-wrapped (PR #12 convention).
  const unwrap = collapseTableWrappers_(linkClean.html.replace(CLEAN_REGEX, ''));
  unwrapStats.tables += unwrap.tables;
  unwrapStats.bytesSaved += unwrap.bytesSaved;
  Logger.log('Unwrap: msg=%s tables=%s bytes_saved=%s', msg.id, String(unwrap.tables), String(unwrap.bytesSaved));
  // Per-sender footer cutoff AFTER the unwrap (the marker is matched against the fully-cleaned
  // text). Opt-in: an unmapped sender ('none') is a byte-identical no-op with no log line and no
  // alarm. A mapped 'hit' slices the footer (marker included) off CleanText; a 'miss' (marker
  // absent or too early — a likely template change) leaves CleanText untouched but is logged and
  // counted so the run can end Failed and fire the GAS failure email (see collectJobEmailsLocked_).
  // Per-email line logs for mapped senders only, in real and DRY_RUN alike; numeric args
  // String()-wrapped (PR #12 convention). domain=<d> is the matched FOOTER_MARKERS key (the
  // actionable identity for the marker-miss runbook), not the raw sender host.
  const footer = truncateAtFooter_(unwrap.html, from.email);
  if (footer.outcome === 'hit') {
    footerStats.hits++;
    footerStats.bytesCut += footer.bytesCut;
    Logger.log('Footer: msg=%s domain=%s marker=hit bytes_cut=%s', msg.id, footer.domain, String(footer.bytesCut));
  } else if (footer.outcome === 'miss') {
    footerStats.misses++;
    if (!footerStats.firstMissMsgId) {
      footerStats.firstMissDomain = footer.domain;
      footerStats.firstMissMsgId = msg.id;
    }
    Logger.log('Footer: msg=%s domain=%s marker=miss bytes_cut=0', msg.id, footer.domain);
  }
  const cleanText = footer.html;

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

// ---------- collapse single-child table wrappers (pure, unit-tested) ----------
// Job-alert senders wrap content in layout-only single-child table chains —
// <table><tr><td>…one element…</td></tr></table>, often several levels deep
// (issue #13; live example jobs4 2026-06-10 opens with a triple wrapper). After
// CLEAN_REGEX these skeletons carry zero information but still cost screening
// tokens on every email. This stage collapses them: a <table> whose content is
// exactly one <tr> (optionally via a single <tbody>) holding exactly one <td>,
// whose content is exactly ONE element and no non-whitespace text, is replaced
// by that element, repeated to fixpoint. Runs in processMessage_ AFTER
// CLEAN_REGEX (bare-tag matching is simpler post-regex); only CleanText /
// CleanLength reflect it — HtmlLength stays the original body length (Make
// parity). Semantics ported from the retired v3 Python design §3.5
// (BeautifulSoup collapse_table_wrappers) as a pure string/stack function — no
// DOM library, per the no-library policy (docs/TECH_DESIGN.md §4).
//
// Conservative by construction:
//   - A table collapses only when its whole skeleton chain tokenizes into
//     strictly matched open/close pairs; any unmatched tag, stray close, or
//     stray text leaves it untouched (malformed HTML is a no-op, never a
//     mangle, and the kept element is preserved VERBATIM — unparsed).
//   - Content tables never match: multi-row, multi-cell, <th>, or a <td>
//     mixing text with elements.
//   - Tags are tokenized as <td[^>]*> — CLEAN_REGEX strips a fixed attribute
//     list, so colspan/rowspan/lang/title etc. survive; never assume bare tags.
//   - Byte-identical no-op when nothing matches (parity, as link cleanup).

// HTML void elements: an open tag of one of these is a complete element child,
// not an unclosed pair. (<img> is stripped by CLEAN_REGEX before this stage but
// the function stays standalone-correct.)
const VOID_TAGS = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
  link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
};

// Fixpoint pass cap (issue #13 guardrail). Each pass strictly shrinks the
// string, so the loop terminates on its own; the cap additionally bounds the
// work on pathological nesting. One pass collapses every OUTERMOST wrapper, so
// passes consumed = deepest wrapper chain, not total wrapper count — real
// emails run 3-4 deep, 25 is generous headroom.
const MAX_UNWRAP_PASSES = 25;

// Scan one tag starting at s[at] === '<'. Returns { type:'open'|'close'|'void',
// name, start, end } or null when this is not a well-formed tag (no valid name
// — e.g. '<!--', '<3', '< ' — or EOF before '>'); the caller folds a null back
// into text, which downstream treats as content (disables collapsing around it
// rather than guessing). Quote-aware: a '>' inside a quoted attribute value
// does not end the tag.
function scanTag_(s, at) {
  const n = s.length;
  let i = at + 1;
  let type = 'open';
  if (s.charAt(i) === '/') { type = 'close'; i++; }
  const nameStart = i;
  while (i < n && /[a-zA-Z0-9-]/.test(s.charAt(i))) i++;
  const name = s.slice(nameStart, i).toLowerCase();
  if (!/^[a-z]/.test(name)) return null;
  let quote = '';
  while (i < n) {
    const c = s.charAt(i);
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      const selfClose = type === 'open' && s.charAt(i - 1) === '/';
      const isVoid = type === 'open' && (selfClose || VOID_TAGS[name] === 1);
      return { type: isVoid ? 'void' : type, name: name, start: at, end: i + 1 };
    }
    i++;
  }
  return null; // EOF inside the tag
}

// Tokenize html into tags and text runs: [{ type:'open'|'close'|'void'|'text',
// name, start, end }] with positions into the input string. Output is emitted
// only as verbatim slices of the input, so tokenizing is lossless.
function tokenizeHtml_(s) {
  const tokens = [];
  let textStart = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charAt(i) !== '<') { i++; continue; }
    const tag = scanTag_(s, i);
    if (tag === null) { i++; continue; } // not a tag: the '<' stays text
    if (textStart < i) tokens.push({ type: 'text', name: '', start: textStart, end: i });
    tokens.push(tag);
    i = tag.end;
    textStart = i;
  }
  if (textStart < s.length) tokens.push({ type: 'text', name: '', start: textStart, end: s.length });
  return tokens;
}

// Pair open/close tags with a strict stack: a close tag matches ONLY the
// innermost open tag of the same name (proper nesting; no recovery guessing —
// on a mismatch both sides stay unmatched and childrenOf_ reports the region
// broken). Returns match[k] = partner token index, or -1 when unmatched.
function matchPairs_(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const stack = []; // indices of pending open tokens
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'open') {
      stack.push(k);
    } else if (t.type === 'close') {
      if (stack.length > 0 && tokens[stack[stack.length - 1]].name === t.name) {
        const o = stack.pop();
        match[o] = k;
        match[k] = o;
      }
    }
  }
  return match;
}

// Direct children of the matched pair opening at openIdx. Whitespace-only text
// is skipped; kids holds the open/void token index of each direct child
// element (a matched open jumps its whole subtree — internals stay opaque and
// verbatim). broken = an unmatched tag sits directly inside this node; such a
// node is never collapsed.
function childrenOf_(s, tokens, match, openIdx) {
  const out = { broken: false, hasText: false, kids: [] };
  const closeIdx = match[openIdx];
  let k = openIdx + 1;
  while (k < closeIdx) {
    const t = tokens[k];
    if (t.type === 'text') {
      if (/\S/.test(s.slice(t.start, t.end))) out.hasText = true;
      k++;
    } else if (t.type === 'void') {
      out.kids.push(k);
      k++;
    } else if (t.type === 'open' && match[k] !== -1) {
      out.kids.push(k);
      k = match[k] + 1;
    } else {
      out.broken = true; // unmatched open, or a stray close
      return out;
    }
  }
  return out;
}

// Test one matched <table> against the wrapper pattern: exactly one <tr>
// (optionally via a single <tbody>) holding exactly one <td> whose content is
// exactly one element and no non-whitespace text. Returns the token index of
// the element to keep, or -1 when this is a content table (multi-row,
// multi-cell, <th>, mixed text) or malformed.
function wrapperKeepChild_(s, tokens, match, tableIdx) {
  const tableKids = childrenOf_(s, tokens, match, tableIdx);
  if (tableKids.broken || tableKids.hasText || tableKids.kids.length !== 1) return -1;
  let trIdx = tableKids.kids[0];
  if (tokens[trIdx].type === 'open' && tokens[trIdx].name === 'tbody') {
    const tbodyKids = childrenOf_(s, tokens, match, trIdx);
    if (tbodyKids.broken || tbodyKids.hasText || tbodyKids.kids.length !== 1) return -1;
    trIdx = tbodyKids.kids[0];
  }
  if (tokens[trIdx].type !== 'open' || tokens[trIdx].name !== 'tr') return -1;
  const trKids = childrenOf_(s, tokens, match, trIdx);
  if (trKids.broken || trKids.hasText || trKids.kids.length !== 1) return -1;
  const tdIdx = trKids.kids[0];
  if (tokens[tdIdx].type !== 'open' || tokens[tdIdx].name !== 'td') return -1;
  const tdKids = childrenOf_(s, tokens, match, tdIdx);
  if (tdKids.broken || tdKids.hasText || tdKids.kids.length !== 1) return -1;
  return tdKids.kids[0];
}

// One collapse pass: tokenize, pair-match, find every wrapper table, apply the
// OUTERMOST collapses (a nested wrapper sits inside a kept element and is taken
// by the next pass). Returns { html, collapsed }; html is the SAME string when
// nothing collapsed, keeping the no-op byte-identical.
function collapseTableWrappersOnce_(s) {
  const tokens = tokenizeHtml_(s);
  const match = matchPairs_(tokens);
  const repl = []; // { from, to, keepFrom, keepTo } in document order
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type !== 'open' || tokens[k].name !== 'table' || match[k] === -1) continue;
    const keep = wrapperKeepChild_(s, tokens, match, k);
    if (keep === -1) continue;
    const keepTo = tokens[keep].type === 'void' ? tokens[keep].end : tokens[match[keep]].end;
    repl.push({ from: tokens[k].start, to: tokens[match[k]].end, keepFrom: tokens[keep].start, keepTo: keepTo });
  }
  if (repl.length === 0) return { html: s, collapsed: 0 };
  let out = '';
  let pos = 0;
  let collapsed = 0;
  for (const r of repl) {
    if (r.from < pos) continue; // nested inside a collapse already applied this pass
    out += s.slice(pos, r.from) + s.slice(r.keepFrom, r.keepTo);
    pos = r.to;
    collapsed++;
  }
  out += s.slice(pos);
  return { html: out, collapsed: collapsed };
}

// Collapse single-child table wrappers to fixpoint (capped). Pure; returns
// { html, tables, bytesSaved } — tables = wrapper tables removed, bytesSaved =
// chars dropped (skeleton tags + the whitespace between them). With nothing to
// unwrap the output is byte-identical to the input and both metrics are 0.
function collapseTableWrappers_(html) {
  const original = String(html);
  let s = original;
  let tables = 0;
  for (let pass = 0; pass < MAX_UNWRAP_PASSES; pass++) {
    const r = collapseTableWrappersOnce_(s);
    if (r.collapsed === 0) break;
    tables += r.collapsed;
    s = r.html;
  }
  return { html: s, tables: tables, bytesSaved: original.length - s.length };
}

// ---------- per-sender footer cutoff (pure, unit-tested) ----------
// Sender footers carry the riskiest links in the corpus — one-click action endpoints
// (unsubscribe, "pause forever", 1-click feedback) plus legal boilerplate (issue #14).
// Cutting the footer out of CleanText removes them from the data the screening layer
// reads at all; token saving is secondary but real. Runs in processMessage_ AFTER
// collapseTableWrappers_, so the marker is matched against the fully-cleaned text
// (links → CLEAN_REGEX → unwrap → THIS). Only CleanText/CleanLength reflect the cut;
// HtmlLength stays the original body length (Make parity), as with the earlier stages.
//
// OPT-IN by registered domain. FOOTER_MARKERS maps a registered domain → the literal
// marker string that begins that sender's footer in the STORED CleanText byte-form
// (entities survive CLEAN_REGEX, so markers are chosen entity-free from the corpus, not
// from rendered email text). An unmapped sender is untouched and never alarms.
//
// Markers outlive sender addresses (whatjobs moved mail.whatjobs.co.uk → mail.uk.whatjobs.com
// in 2026 but kept its footer), so the map is keyed by registered domain, matched by exact
// equality OR a dot-boundary suffix (domain === key || domain.endsWith('.' + key)) — keys are
// full registered domains, and the leading dot is what makes it a boundary: 'mail.uk.whatjobs.com'
// matches 'whatjobs.com' but the look-alike 'notwhatjobs.com' does not (a bare endsWith(key)
// would wrongly match it). Each marker is confirmed against ≥2 stored CleanText samples before
// adoption; a domain that cannot be confirmed twice stays unmapped.
const FOOTER_MARKERS = {
  // reed: the seed map proposed 'Manage your job alerts' (v3), but that exact string is ABSENT
  // from the stored reed CleanText — the real footer reads "…manage your contact preferences or
  // unsubscribe." The corrected marker cuts 1,311 B at 81.2%, matching the issue's own research
  // evidence (reed 1,311 B) exactly. Confirm-before-pin caught the transcription slip (see PR #14).
  'reed.co.uk': 'manage your contact preferences',
  'whatjobs.com': 'Overall, how relevant are these jobs',
  'jobmails.io': 'Please do not reply to this email',
  'joblookup.com': 'Pause Your Job Alerts',
  'nijobs.com': 'In order to avoid that third parties',
  'ziprecruiter.co.uk': 'Unsubscribe from this email',
  'welcometothejungle.com': 'Receive these notifications:',
  // milkround is StepStone family and ships the same GDPR footer sentence as nijobs — keep this
  // as an independent entry (duplicate string, NOT a shared constant): either sender can change
  // its template without the other. Confirmed against 4 stored milkround CleanText samples.
  'milkround.com': 'In order to avoid that third parties',
  'procontractjobs.com': 'Pro Contract Jobs Team',  // confirmed against 10 stored samples
};

// A footer marker is only believed when it sits in the trailing portion of the text: the
// same phrase can leak into a job description earlier in the body, and a sender template
// can change so the footer disappears. The match index must be at least this fraction of
// the way through the text; an earlier (or absent) match is a MISS, not a cut. Corpus
// footers all start ≥ ~68% in, so 0.5 holds with headroom (pinned by a test).
const FOOTER_POSITION_FLOOR = 0.5;

// Registered-domain part of a From address (lowercased): everything after the last '@'.
// '' when there is no '@' (so an address-less / malformed From never keys the map).
function footerDomainOf_(fromEmail) {
  const s = String(fromEmail);
  const at = s.lastIndexOf('@');
  if (at === -1) return '';
  return s.slice(at + 1).trim().toLowerCase();
}

// Look up the footer marker for a sender domain, matching a FOOTER_MARKERS key by exact
// equality OR dot-boundary suffix (domain === key || domain.endsWith('.' + key)). First
// matching key in insertion order wins. Returns { key, marker } or null when unmapped.
function footerMarkerFor_(domain) {
  for (const key in FOOTER_MARKERS) {
    if (domain === key || domain.endsWith('.' + key)) {
      return { key: key, marker: FOOTER_MARKERS[key] };
    }
  }
  return null;
}

// Cut a mapped sender's footer off the (already fully-cleaned) text, marker included
// (v3 semantics: the marker phrase goes with the discarded tail). Pure; returns
// { html, outcome, bytesCut, domain }:
//   - 'none'  unmapped sender — text returned byte-identical, domain '' (no log, no alarm)
//   - 'miss'  mapped sender whose marker is absent OR fails the position floor — text
//             returned byte-identical, domain = matched key (per-email warn + run alarm)
//   - 'hit'   marker found in the trailing portion — text sliced at the LAST occurrence
//             (footers are terminal; the last occurrence is the real one even if the phrase
//             also appears in a job description above). domain = matched key.
function truncateAtFooter_(html, fromEmail) {
  const text = String(html);
  const domain = footerDomainOf_(fromEmail);
  const entry = domain ? footerMarkerFor_(domain) : null;
  if (!entry) return { html: text, outcome: 'none', bytesCut: 0, domain: '' };
  const idx = text.lastIndexOf(entry.marker);
  if (idx === -1 || idx < FOOTER_POSITION_FLOOR * text.length) {
    return { html: text, outcome: 'miss', bytesCut: 0, domain: entry.key };
  }
  const cut = text.slice(0, idx);
  return { html: cut, outcome: 'hit', bytesCut: text.length - cut.length, domain: entry.key };
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

// Shared Airtable REST plumbing: the RawEmails table endpoint and the bearer token
// (throws if the Script Property is unset — fail loud, no silent skip).
function airtableUrl_() {
  return 'https://api.airtable.com/v0/' + CONFIG.AIRTABLE_BASE_ID + '/' +
    encodeURIComponent(CONFIG.AIRTABLE_TABLE);
}

function airtableToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
  if (!token) throw new Error('Script property AIRTABLE_TOKEN is not set.');
  return token;
}

// Upsert a batch (<=10 records) into Airtable, merging on CONFIG.DEDUPE_FIELD so a
// re-collected message updates its existing row instead of creating a duplicate.
// Upsert requires PATCH + performUpsert (the POST create endpoint has no upsert).
// Returns the numeric HTTP response code (200 = success); the caller branches on it —
// 200 → label make-collected, 429/5xx (isTransientWriteFailure_) → transient retry next
// run, any other 4xx → deterministic reject the sub-batch loop isolates per-record. On a
// non-200 the error body is still logged, and `failures` (optional, the run's fail-loudly
// accumulator) has its count incremented and first error captured, so the caller can end
// the execution Failed after the loop (see collectJobEmailsLocked_).
function airtableUpsert_(records, failures) {
  const token = airtableToken_();
  const resp = UrlFetchApp.fetch(airtableUrl_(), {
    method: 'patch', // upsert is PATCH-only; records without an id match on fieldsToMergeOn
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(buildUpsertPayload_(records)),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 200) return code;
  Logger.log('Airtable upsert error %s: %s', String(code), resp.getContentText().slice(0, 500));
  if (failures) {
    failures.count++;
    if (!failures.first) failures.first = code + ': ' + resp.getContentText().slice(0, 500);
  }
  return code;
}

// Attempt one Airtable upsert — the whole sub-batch, or a single record during isolation —
// and classify the outcome for the poison-isolation logic. Returns
// { kind: 'ok' | 'transient' | 'poison', code, first }:
//   - 'ok'        HTTP 200: the record(s) are written; safe to label make-collected.
//   - 'transient' HTTP 429/5xx OR a network-level throw: a rate-limit/outage, NOT a record
//                 problem — leave uncollected and retry next run, never make-failed.
//   - 'poison'    any other 4xx: a deterministic, likely record-specific reject.
// `first` is the '<code>: <body>' (or 'network error: …') text for the fail-loud summary
// ('' on success). Re-uses airtableUpsert_'s own error log + capture via a throwaway probe,
// so the Airtable error body still lands in the execution log. A network throw is caught
// here (treated as transient) so one record's blip can't abort isolation of its siblings.
function attemptUpsert_(records) {
  const probe = { count: 0, first: '' };
  let code;
  try {
    code = airtableUpsert_(records, probe);
  } catch (e) {
    return { kind: 'transient', code: 0, first: 'network error: ' + (e && e.message ? e.message : e) };
  }
  if (code === 200) return { kind: 'ok', code: code, first: '' };
  if (isTransientWriteFailure_(code)) return { kind: 'transient', code: code, first: probe.first };
  return { kind: 'poison', code: code, first: probe.first };
}

// ---------- RawEmails purge job (janitor) ----------
// Keeps RawEmails inside its share of the Airtable free plan's 1,000-records-per-BASE
// cap (shared across all tables — crossed 2026-06-10, see docs/KNOWN_ISSUES.md). Runs
// on its OWN nightly time trigger (manual setup, runtime state; time recorded in
// docs/TECH_DESIGN.md §7, runbook in docs/OPERATIONS.md). Over the high-water mark it
// deletes the OLDEST eligible rows
// down to the low-water mark; eligibility (Status='Processed' AND old enough) is
// enforced server-side by purgeEligibilityFormula_, so Status='New' rows structurally
// cannot be deleted. Any Airtable non-200 throws: Failed execution -> failure email.

function purgeRawEmails() {
  // Same script lock as the collector — the purge must never run concurrently with a
  // collector run (interleaved deletes vs upserts). tryLock(0): if the lock is held,
  // skip this night entirely; the next nightly run catches up.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another run holds the script lock; skipping this purge run.');
    return;
  }
  try {
    purgeRawEmailsLocked_();
  } finally {
    lock.releaseLock();
  }
}

// One purge run. Always invoked under the script lock (see purgeRawEmails).
function purgeRawEmailsLocked_() {
  // Reuses the collector's DRY_RUN Script Property: log the full plan, delete nothing.
  const dryRun = PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'true';

  const t = resolvePurgeThresholds_(
    getIntProp_('PURGE_HIGH_WATER', CONFIG.PURGE_HIGH_WATER, 0, 1000),
    getIntProp_('PURGE_LOW_WATER', CONFIG.PURGE_LOW_WATER, 0, 1000)
  );
  if (t.fellBack) {
    Logger.log('Purge thresholds misconfigured (high %s <= low %s); using defaults high=%s low=%s.',
      String(t.rejectedHigh), String(t.rejectedLow), String(t.high), String(t.low));
  }

  // Total record count: a paginated single-field list is the cheapest REST way to
  // count (~2 calls at steady state; there is no count endpoint).
  const count = airtableListRecords_('fields%5B%5D=MessageId&pageSize=100').length;
  if (count <= t.high) {
    Logger.log('Purge: count=%s high=%s — nothing to do.', String(count), String(t.high));
    return;
  }

  // Over high water: list what is actually deletable, oldest first (server-side sort).
  const eligibleIds = airtableListRecords_(
    'fields%5B%5D=MessageId&pageSize=100' +
    '&filterByFormula=' + encodeURIComponent(purgeEligibilityFormula_()) +
    '&sort%5B0%5D%5Bfield%5D=CollectedAt&sort%5B0%5D%5Bdirection%5D=asc'
  ).map(r => r.id);

  if (eligibleIds.length === 0) {
    // Pre-M6 this is the NORMAL state: nothing is ever Status='Processed' until the
    // screening cutover, so the purge can only watch. But at the emergency threshold
    // the watchdog must bark: throw -> Failed execution -> failure email, before
    // Airtable starts blocking writes at the cap.
    if (count >= CONFIG.PURGE_EMERGENCY) {
      throw new Error('Purge: count=' + count + ' >= PURGE_EMERGENCY=' + CONFIG.PURGE_EMERGENCY +
        ' with 0 eligible rows — base is nearly at the 1,000-record cap and the purge cannot help; manual action required.');
    }
    Logger.log('Purge: over high-water (%s) but 0 eligible rows — capacity risk, manual action may be needed.', String(count));
    return;
  }

  const plan = buildPurgePlan_(count, t.high, t.low, eligibleIds);

  if (dryRun) {
    Logger.log('DRY_RUN: would delete %s of %s eligible row(s), oldest first: %s',
      String(plan.length), String(eligibleIds.length), plan.join(', '));
    Logger.log('Purge: count=%s high=%s low=%s eligible=%s deleted=0 remaining=%s (DRY_RUN — nothing deleted)',
      String(count), String(t.high), String(t.low), String(eligibleIds.length), String(count));
    return;
  }

  let deleted = 0;
  for (const batch of chunk_(plan, CONFIG.PURGE_DELETE_BATCH)) {
    airtableDeleteRecords_(batch); // throws on non-200 (no retry wrapper in this slice)
    deleted += batch.length;
    // Pace the delete burst under Airtable's 5 req/s/base rate limit: a full purge is
    // dozens of back-to-back DELETEs, and a 429 would fail the run mid-plan.
    Utilities.sleep(250);
  }
  Logger.log('Purge: count=%s high=%s low=%s eligible=%s deleted=%s remaining=%s',
    String(count), String(t.high), String(t.low), String(eligibleIds.length), String(deleted), String(count - deleted));
}

// Resolve the high/low-water pair (pure, unit-tested): HIGH must exceed LOW for the
// plan to make sense; an inverted or equal pair (a Script Property misconfig) falls
// back to BOTH CONFIG defaults rather than trusting half of a bad pair.
function resolvePurgeThresholds_(high, low) {
  if (high <= low) {
    return {
      high: CONFIG.PURGE_HIGH_WATER, low: CONFIG.PURGE_LOW_WATER,
      fellBack: true, rejectedHigh: high, rejectedLow: low,
    };
  }
  return { high: high, low: low, fellBack: false };
}

// Build the delete plan (pure, unit-tested): [] at/below the high-water mark;
// otherwise enough of the oldest eligible ids (eligibleIds arrives sorted CollectedAt
// asc) to bring the count down to the low-water mark, capped at what is eligible.
function buildPurgePlan_(count, high, low, eligibleIds) {
  if (count <= high) return [];
  return eligibleIds.slice(0, Math.max(0, count - low));
}

// Split an array into consecutive slices of `size` (pure; the last may be shorter).
function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// THE eligibility guard, applied server-side via filterByFormula: only rows that are
// BOTH Status='Processed' AND at least PURGE_MIN_AGE_DAYS old are ever listed for
// deletion, so an unprocessed (Status='New') row can never enter the delete plan.
// Pinned verbatim by tests/purge.test.js — do not weaken without an owner decision.
function purgeEligibilityFormula_() {
  return "AND({Status}='Processed', IS_BEFORE({CollectedAt}, DATEADD(NOW(), -" +
    CONFIG.PURGE_MIN_AGE_DAYS + ", 'days')))";
}

// GET all records matching `query` (a pre-encoded query string), following Airtable's
// offset pagination to exhaustion. Returns the raw record objects. Purge contract:
// any non-200 throws (Failed execution -> failure email), never a silent partial list.
function airtableListRecords_(query) {
  const token = airtableToken_();
  const records = [];
  let offset = null;
  do {
    const url = airtableUrl_() + '?' + query + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 500));
    }
    const page = JSON.parse(resp.getContentText());
    for (const r of (page.records || [])) records.push(r);
    offset = page.offset || null;
  } while (offset);
  return records;
}

// DELETE one batch of record ids — at most PURGE_DELETE_BATCH (10), the REST API's
// records-per-DELETE cap. Throws on any non-200 (same fail-loud contract as the list).
function airtableDeleteRecords_(ids) {
  const token = airtableToken_();
  const url = airtableUrl_() + '?' + ids.map(id => 'records%5B%5D=' + encodeURIComponent(id)).join('&');
  const resp = UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Airtable delete error ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 500));
  }
}
