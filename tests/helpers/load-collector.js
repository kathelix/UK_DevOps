'use strict';

/**
 * Load apps-script/gmail-collector.gs into an isolated VM context and expose its
 * pure / near-pure functions for unit testing under `node --test`.
 *
 * Why a VM loader instead of require():
 *   - gmail-collector.gs is deployed verbatim by clasp (.claspignore pushes only
 *     that file + appsscript.json). It must stay free of any require/module.exports
 *     test scaffolding, so it cannot be require()'d as a Node module.
 *   - It references Apps Script globals (Gmail, UrlFetchApp, LockService,
 *     PropertiesService, Utilities, Logger) that do not exist in Node.
 *
 * So the file is read verbatim and run in a fresh vm context seeded with minimal
 * stubs. An in-memory epilogue copies the bindings we test onto the context global
 * (top-level `const` does not attach to a vm global on its own). The file on disk
 * is never modified.
 *
 * Realm caveats (see tests for how they are handled):
 *   - Values created in the vm realm have the vm's prototypes, so cross-realm
 *     `assert.deepStrictEqual(vmObject, nodeLiteral)` fails on the prototype check.
 *     Assert on primitive leaves, on `Object.keys(...)`, or on JSON round-trips.
 *   - A regex from the vm realm is not `instanceof` Node's RegExp; assert on
 *     `.source` / `.flags` / behavior instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', '..', 'apps-script', 'gmail-collector.gs');

// Bindings copied out of the script for testing.
const EXPORTS = [
  'CONFIG',
  'CLEAN_REGEX',
  'parseFrom_',
  'decodeB64Url_',
  'isOverRuntimeBudget_',
  'clampSubBatchSize_',
  'gmailReadWithRetry_', // idempotent Gmail-read retry/backoff wrapper (Messages.get / Messages.list)
  'isTransientWriteFailure_', // write-failure classifier (429/5xx transient vs deterministic 4xx)
  'parseIntProp_',
  'getIntProp_',
  // repeatedly-transient write strike counter (Script Properties, wretry:<messageId>)
  'TRANSIENT_STRIKE_PREFIX',     // the 'wretry:' namespace constant (pinned by a unit test)
  'shouldQuarantineTransient_',  // pure: count >= max
  'loadTransientStrikes_',       // read wretry:* props -> { messageId: int } map
  'bumpTransientStrike_',        // +1 in-memory + persist setProperty
  'clearTransientStrike_',       // drop in-memory + deleteProperty (no-op if never struck)
  'buildUpsertPayload_',
  'airtableFetchWithRetry_', // transient-retry/backoff wrapper around the Airtable fetch
  'airtableUpsert_',
  // offline link cleanup (pure)
  'trimTrailingPunct_',
  'harvestUrls_',
  'splitUrl_',
  'schemeHostOf_',
  'decodeEmbeddedDestination_',
  'stripUtm_',
  'cleanUrl_',
  'cleanLinksInHtml_',
  'collapseTableWrappers_', // single-child table-wrapper unwrap (pure; applied after CLEAN_REGEX)
  'truncateAtFooter_', // per-sender footer cutoff (pure; applied after the unwrap)
  'FOOTER_MARKERS',    // domain-keyed footer marker map (read by the corpus test)
  'collectJobEmailsLocked_', // one collector run (no lock); driven by the integration test
  // RawEmails purge job (pure helpers + the lock-free run, driven by tests/purge.test.js)
  'resolvePurgeThresholds_',
  'buildPurgePlan_',
  'chunk_',
  'purgeEligibilityFormula_',
  'purgeRawEmailsLocked_',
];

// Minimal Apps Script global stubs. Utilities is backed by Node's Buffer so
// decodeB64Url_ runs for real; the rest are placeholders that individual tests
// override via setGlobals() only when exercising a function that touches them.
function defaultStubs(logs) {
  return {
    Logger: { log: (...args) => logs.push(args) },
    Utilities: {
      // GAS: Utilities.newBlob(byte[]).getDataAsString(charset)
      newBlob(data) {
        return { getDataAsString: () => Buffer.from(data).toString('utf8') };
      },
      // GAS: Utilities.base64Decode(str) -> byte[]
      base64Decode(s) {
        return Array.from(Buffer.from(String(s), 'base64'));
      },
    },
    // Declared so references resolve; tests that call airtableUpsert_ set these.
    PropertiesService: undefined,
    UrlFetchApp: undefined,
    LockService: undefined,
    Gmail: undefined,
  };
}

function loadCollector() {
  const source = fs.readFileSync(GS_PATH, 'utf8');
  const logs = [];
  const context = vm.createContext(defaultStubs(logs));
  const epilogue = `\n;globalThis.__GAS_EXPORTS__ = { ${EXPORTS.join(', ')} };`;
  vm.runInContext(source + epilogue, context, { filename: 'gmail-collector.gs' });

  return Object.assign({}, context.__GAS_EXPORTS__, {
    // Lines captured from Logger.log during a call (array of arg-arrays).
    logs,
    // Install/override Apps Script globals seen by the loaded functions.
    setGlobals(overrides) { Object.assign(context, overrides); },
    // Apply CLEAN_REGEX to html (resets the /g regex's lastIndex first).
    clean(html) {
      const re = context.__GAS_EXPORTS__.CLEAN_REGEX;
      re.lastIndex = 0;
      return String(html).replace(re, '');
    },
  });
}

module.exports = { loadCollector, GS_PATH };
