#!/usr/bin/env node
/**
 * Idempotent, additive-only Airtable schema apply (Meta API).
 *
 * Reads airtable/schema.json, compares with the live base, then:
 *   - creates missing tables (with all their fields)
 *   - adds missing fields to existing tables
 * Tables and fields are matched by **id when present** (falling back to name for
 * entries that don't carry an id yet), so a field renamed in the Airtable UI is
 * reported as a rename-drift WARNING instead of being re-created as a duplicate.
 * Never deletes or retypes anything — the Meta API doesn't support it, and we
 * wouldn't want CI doing it anyway. Removals are manual.
 *
 * The diff is a pure function (planTableChanges) so it can be unit-tested with
 * fixtures — no token, no network. The CLI wrapper (require.main === module) does
 * the live GET + the POSTs around it.
 *
 * Usage:  AIRTABLE_TOKEN=pat... node airtable/apply-schema.js [path/to/schema.json]
 * Token scopes required: schema.bases:read, schema.bases:write (this base).
 * Requires Node 18+ (built-in fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve the entry in `candidates` that `want` refers to: by id when `want.id`
 * is set (the rename-safe path), otherwise by name (back-compat for entries with
 * no id yet). Returns undefined when nothing matches. Pure — used for both table
 * and field matching.
 */
function matchByIdOrName(want, candidates) {
  if (!candidates) return undefined;
  if (want.id) return candidates.find(c => c.id === want.id);
  return candidates.find(c => c.name === want.name);
}

/**
 * Plan the additive changes that bring `liveTable` up to `want`. Pure (no I/O),
 * so it's exercisable offline with fixtures. `liveTable` is the live table the
 * caller already matched to `want` (undefined ⇒ the whole table is missing).
 *
 * Returns { creates, adds, warnings }:
 *   - creates:  [want] when the table doesn't exist live (CLI POSTs a new table)
 *   - adds:     fields in `want` missing live (CLI POSTs each one) — additive
 *   - warnings: non-actionable drift the additive Meta API can't fix:
 *       * rename drift — a field matched by id whose live name differs; NOT added,
 *         so a UI rename can never become a duplicate field
 *       * type drift   — a field (matched by id-or-name) whose live type differs
 */
function planTableChanges(want, liveTable) {
  const creates = [];
  const adds = [];
  const warnings = [];

  if (!liveTable) {
    creates.push(want);
    return { creates, adds, warnings };
  }

  for (const field of want.fields) {
    const liveField = matchByIdOrName(field, liveTable.fields);

    if (!liveField) {
      adds.push(field); // new field (no id, or id not present live) — additive, as before
      continue;
    }

    // Matched by id but the names differ ⇒ the field was renamed in the UI.
    // Warn and do NOT add — name-only matching would have re-created a duplicate.
    if (field.id && liveField.id === field.id && liveField.name !== field.name) {
      warnings.push(
        `rename drift on ${want.name}: schema.json says ${field.name}, live is ${liveField.name} (${liveField.id}) — reconcile`
      );
    }

    // Type drift (matched by id-or-name) — report but never act on it.
    if (liveField.type !== field.type) {
      warnings.push(
        `type drift on ${want.name}.${field.name}: live=${liveField.type} desired=${field.type} (manual fix required)`
      );
    }
  }

  return { creates, adds, warnings };
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

  const live = (await api('GET', base, token)).tables;
  let changes = 0;

  for (const want of schema.tables) {
    const liveTable = matchByIdOrName(want, live);
    const { creates, adds, warnings } = planTableChanges(want, liveTable);

    for (const table of creates) {
      console.log(`CREATE table: ${table.name} (${table.fields.length} fields)`);
      await api('POST', base, token, {
        name: table.name,
        description: table.description || '',
        fields: table.fields,
      });
      changes++;
    }

    for (const field of adds) {
      console.log(`ADD field: ${want.name}.${field.name} (${field.type})`);
      await api('POST', `${base}/${liveTable.id}/fields`, token, field);
      changes++;
    }

    for (const warning of warnings) console.warn(`WARN ${warning}`);
  }

  console.log(changes === 0 ? 'No changes — schema up to date.' : `Done: ${changes} change(s) applied.`);
}

module.exports = { planTableChanges, matchByIdOrName };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
