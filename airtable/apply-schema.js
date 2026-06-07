#!/usr/bin/env node
/**
 * Idempotent, additive-only Airtable schema apply (Meta API).
 *
 * Reads airtable/schema.json, compares with the live base, then:
 *   - creates missing tables (with all their fields)
 *   - adds missing fields to existing tables
 * Never deletes or retypes anything — the Meta API doesn't support it,
 * and we wouldn't want CI doing it anyway. Removals are manual.
 *
 * Usage:  AIRTABLE_TOKEN=pat... node airtable/apply-schema.js [path/to/schema.json]
 * Token scopes required: schema.bases:read, schema.bases:write (this base).
 * Requires Node 18+ (built-in fetch).
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.AIRTABLE_TOKEN;
const schemaPath = process.argv[2] || path.join(__dirname, 'schema.json');

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`${method} ${url} -> ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

(async () => {
  if (!TOKEN) throw new Error('AIRTABLE_TOKEN env var is required');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const base = `https://api.airtable.com/v0/meta/bases/${schema.baseId}/tables`;

  const live = (await api('GET', base)).tables;
  let changes = 0;

  for (const want of schema.tables) {
    const have = live.find(t => t.name === want.name);

    if (!have) {
      console.log(`CREATE table: ${want.name} (${want.fields.length} fields)`);
      await api('POST', base, {
        name: want.name,
        description: want.description || '',
        fields: want.fields,
      });
      changes++;
      continue;
    }

    for (const field of want.fields) {
      if (!have.fields.some(f => f.name === field.name)) {
        console.log(`ADD field: ${want.name}.${field.name} (${field.type})`);
        await api('POST', `${base}/${have.id}/fields`, field);
        changes++;
      }
    }

    // Report (but never act on) drift the API can't fix.
    for (const field of want.fields) {
      const liveField = have.fields.find(f => f.name === field.name);
      if (liveField && liveField.type !== field.type) {
        console.warn(
          `WARN type drift on ${want.name}.${field.name}: live=${liveField.type} desired=${field.type} (manual fix required)`
        );
      }
    }
  }

  console.log(changes === 0 ? 'No changes — schema up to date.' : `Done: ${changes} change(s) applied.`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
