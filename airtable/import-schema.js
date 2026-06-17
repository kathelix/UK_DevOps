#!/usr/bin/env node
/**
 * Repeatable Meta-API → schema.json merge (drift snapshot).
 *
 * GETs the live base structure and merges it into airtable/schema.json so the
 * version-controlled schema carries the live field **ids** — which is what makes
 * apply-schema.js rename-safe (it matches by id when present). Run it to keep the
 * managed tables carrying their live ids — backfilling any table or field still
 * committed name-only — and whenever you want a fresh, diffable snapshot of live
 * structure before editing the schema.
 *
 * Philosophy (mirrors apply-schema.js — additive, never destructive):
 *   - Backfills `id` on every managed table + field (matched by id-or-name).
 *   - Adds a managed table that's live but missing from schema.json — scoped to a
 *     known allowlist so it never slurps unrelated tables into version control.
 *   - Preserves curated prose: it never clobbers a hand-written comment or
 *     description. New entries are seeded from the live text (nothing to clobber);
 *     existing entries keep their (possibly richer) curated text untouched.
 *   - Warns — never auto-edits — on type drift, leaving the reconcile to a human.
 *   - Idempotent: a second run with no live change rewrites nothing.
 *
 * The merge is a pure function (mergeLiveIntoSchema) so it's unit-testable with
 * fixtures — no token, no network. The CLI wrapper (require.main === module) does
 * the live GET + the write. The first run normalizes schema.json to canonical
 * 2-space JSON; subsequent runs produce clean, id-only diffs.
 *
 * Usage:  AIRTABLE_TOKEN=pat... node airtable/import-schema.js [path/to/schema.json]
 * Token scope required: schema.bases:read (this base).
 * Requires Node 18+ (built-in fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Only these tables are version-controlled; the import never pulls anything else
// live into schema.json. Keep in lockstep with schema.json's `tables`.
const MANAGED_TABLES = ['RawEmails', 'Vacancies'];

// Project a live field/table into the schema's shape (id first), carrying its
// structure and any live prose as a starting point. Used only when *adding* an
// entry that schema.json doesn't have yet — never to overwrite an existing one.
function liveFieldToSchema(liveField) {
  const out = { id: liveField.id, name: liveField.name, type: liveField.type };
  if (liveField.description) out.description = liveField.description;
  if (liveField.options) out.options = liveField.options;
  return out;
}

function liveTableToSchema(liveTable) {
  const out = { id: liveTable.id, name: liveTable.name };
  if (liveTable.description) out.description = liveTable.description;
  out.fields = (liveTable.fields || []).map(liveFieldToSchema);
  return out;
}

/**
 * Merge live structure into `schema` and return a new schema (the input is never
 * mutated) plus any drift warnings. Pure: no I/O, so it runs offline in tests.
 *
 *   mergeLiveIntoSchema(schema, liveTables[, managedTables]) -> { schema, warnings }
 *
 * `liveTables` is the Meta API's `.tables` array. `managedTables` defaults to the
 * allowlist above; pass an explicit list in tests.
 */
function mergeLiveIntoSchema(schema, liveTables, managedTables = MANAGED_TABLES) {
  const warnings = [];
  const out = JSON.parse(JSON.stringify(schema)); // deep clone — never mutate the caller's object
  out.tables = out.tables || [];

  for (const liveTable of liveTables) {
    if (!managedTables.includes(liveTable.name)) continue; // allowlist — ignore unrelated tables

    const idx = out.tables.findIndex(
      t => (t.id && t.id === liveTable.id) || t.name === liveTable.name
    );

    if (idx === -1) {
      out.tables.push(liveTableToSchema(liveTable)); // managed, live, but absent → add (seeded from live)
      continue;
    }

    // Existing managed table: backfill its id (id-first), preserve all its prose.
    let stable = out.tables[idx];
    if (!stable.id) {
      stable = { id: liveTable.id, ...stable };
      out.tables[idx] = stable;
    }
    stable.fields = stable.fields || [];

    for (const liveField of liveTable.fields) {
      const fidx = stable.fields.findIndex(
        f => (f.id && f.id === liveField.id) || f.name === liveField.name
      );

      if (fidx === -1) {
        stable.fields.push(liveFieldToSchema(liveField)); // live field absent from schema → add structure
        continue;
      }

      const sfield = stable.fields[fidx];
      if (!sfield.id) {
        stable.fields[fidx] = { id: liveField.id, ...sfield }; // backfill id only, preserve prose
      }
      if (sfield.type && sfield.type !== liveField.type) {
        warnings.push(
          `type drift on ${stable.name}.${sfield.name}: schema=${sfield.type} live=${liveField.type} (left as-is — reconcile manually)`
        );
      }
    }
  }

  return { schema: out, warnings };
}

async function api(method, url, token, body) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`${method} ${url} -> ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function main() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN env var is required');
  const schemaPath = process.argv[2] || path.join(__dirname, 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const base = `https://api.airtable.com/v0/meta/bases/${schema.baseId}/tables`;

  const liveTables = (await api('GET', base, token)).tables;
  const { schema: merged, warnings } = mergeLiveIntoSchema(schema, liveTables);

  for (const warning of warnings) console.warn(`WARN ${warning}`);

  // Compare at the data level (same compact serializer both sides) so formatting
  // alone never triggers a rewrite — that's what keeps a no-change run diff-free.
  if (JSON.stringify(schema) === JSON.stringify(merged)) {
    console.log('No structural changes — schema.json already in sync with the live base.');
    return;
  }
  fs.writeFileSync(schemaPath, JSON.stringify(merged, null, 2) + '\n');
  console.log('schema.json updated (ids backfilled / structure merged). Review the diff before committing.');
}

module.exports = { mergeLiveIntoSchema, MANAGED_TABLES };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
