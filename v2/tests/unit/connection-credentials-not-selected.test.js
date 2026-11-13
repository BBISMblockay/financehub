'use strict';
// No browser page may ask PostgREST for a stored integration credential.
//
// WHY THIS EXISTS. The connection tables carry live credentials in plaintext
// columns -- shopify_connections.access_token, quickbooks_connections
// .access_token / .refresh_token, klaviyo_connections .api_key / .access_token
// / .refresh_token, ad_platform_connections .access_token / .refresh_token.
// Their row policies admit any ADMIN of the company, and is_admin_user()
// passes for nearly every profile in SILO, so without column privileges a
// workspace admin could read their tenant's live QuickBooks, Klaviyo, Google
// Ads, Meta and TikTok credentials straight out of the REST API. The database
// side is closed: 20260928120000 for Shopify and 20261113010000 for the other
// three revoke table SELECT and re-grant every column EXCEPT these.
//
// That revoke is what makes this test necessary rather than redundant. Once a
// column is revoked, Postgres refuses `SELECT *` on the whole table -- so a
// page that reaches for `select('*')`, or names a credential, does not quietly
// leak: it BREAKS, with "permission denied for column access_token", and the
// card renders as Unavailable. That is exactly what happened to the QuickBooks
// card in the first draft of 20261113010000, which revoked the grant while
// v2/integrations.html still called .select('*') (loadQboConnection). Caught
// in preflight, not in production -- this test is so the next one is too.
//
// The check is deliberately dumb and textual: find every supabase-js select on
// one of these tables in browser source and look at the column string. An
// unreadable call (a variable whose value is built elsewhere) is reported too,
// because a column list this test cannot see is a column list nobody reviews.
// Known-good constants are resolved by name from the same file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const scanDirs = ['v2', 'v3', 'pages', 'assets'];
// `legacy/` is archived and must not be edited; `tests` holds fixtures that
// name these columns on purpose.
const skipDirs = new Set(['.git', '.claude', 'node_modules', 'legacy', 'tests', 'data', 'docs']);

const GUARDED = ['shopify_connections', 'quickbooks_connections', 'klaviyo_connections', 'ad_platform_connections'];
const CREDENTIALS = ['access_token', 'refresh_token', 'api_key', 'client_secret'];
// Not credentials, and every one of them is deliberately still selectable: an
// EXPIRY is what the cards render to say "reconnect needed", and credential_ref
// names a secret without being one.
const ALLOWED_LOOKALIKES = new Set([
  'token_expires_at', 'refresh_token_expires_at', 'access_token_expires_at', 'credential_ref',
]);
// A select whose column list arrives through a local variable, where a person
// has read the call sites. ONE entry, and it is covered another way: the
// Shopify loader's `query(cols)` helper is called only with
// SHOPIFY_CONNECTION_COLUMNS and SHOPIFY_BASE_COLUMNS, and the *_COLUMNS sweep
// at the bottom of this file reads both by name. Adding an entry here without
// that second cover is how a credential gets back into a page.
const REVIEWED_INDIRECTION = new Set(['v2/integrations.html shopify_connections']);

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(html|js)$/.test(entry.name)) files.push(full);
  }
})(path.join(root, scanDirs[0]));
for (const d of scanDirs.slice(1)) {
  const p = path.join(root, d);
  if (fs.existsSync(p)) (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js)$/.test(entry.name)) files.push(full);
    }
  })(p);
}

/** `const NAME = [...].join(',')` or `const NAME = '...'` in the same file. */
function resolveConstant(source, name) {
  const arr = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (arr) return arr[1];
  const str = new RegExp(`${name}\\s*=\\s*['"\`]([^'"\`]*)['"\`]`).exec(source);
  if (str) return str[1];
  const spread = new RegExp(`${name}\\s*=\\s*\\[\\.\\.\\.(\\w+)([\\s\\S]*?)\\]`).exec(source);
  if (spread) return (resolveConstant(source, spread[1]) || '') + spread[2];
  return null;
}

const offences = [];
let checked = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  for (const table of GUARDED) {
    // .from('table') ... .select(<args>) -- the select may sit on a later line.
    const re = new RegExp(`from\\(\\s*['"\`]${table}['"\`]\\s*\\)([\\s\\S]{0,400}?)\\.select\\(([^)]*)\\)`, 'g');
    for (const m of source.matchAll(re)) {
      const between = m[1];
      // A .insert()/.update()/.upsert()/.delete() before the .select() means
      // the select is a RETURNING list, judged the same way.
      const raw = m[2].trim();
      checked += 1;
      const line = source.slice(0, m.index).split('\n').length;
      const where = `${rel}:${line} ${table}`;

      if (raw === '' || raw === "'*'" || raw === '"*"' || raw === '`*`') {
        offences.push(`${where} -> select(${raw || ''}) selects every column, which is refused once a credential column is revoked`);
        continue;
      }
      let cols = null;
      const literal = /^['"`]([^'"`]*)['"`]$/.exec(raw);
      if (literal) cols = literal[1];
      else if (/^[A-Z][A-Z0-9_]*$/.test(raw)) cols = resolveConstant(source, raw);
      else if (/^['"`]/.test(raw)) cols = raw.replace(/['"`+\s]/g, ' ');   // concatenated literals
      if (cols === null) {
        if (REVIEWED_INDIRECTION.has(`${rel} ${table}`)) continue;
        offences.push(`${where} -> select(${raw}) names a column list this test cannot read; inline it or use a *_COLUMNS constant in the same file`);
        continue;
      }
      if (cols.includes('*')) {
        offences.push(`${where} -> its column list contains '*'`);
        continue;
      }
      for (const cred of CREDENTIALS) {
        const named = new RegExp(`\\b${cred}\\b`).exec(cols);
        if (!named) continue;
        const token = new RegExp(`\\b[a-z_]*${cred}[a-z_]*\\b`).exec(cols)[0];
        if (ALLOWED_LOOKALIKES.has(token)) continue;
        offences.push(`${where} -> selects the credential column '${token}'`);
      }
    }
  }
}

// ── Second pass: the column-list constants themselves ──────────────────────
// A select may reach its list through a variable (see REVIEWED_INDIRECTION),
// so the lists are also read directly by name. This is what would catch
// 'access_token' being appended to SHOPIFY_BASE_COLUMNS.
let constants = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*_COLUMNS?)\s*=/g)) {
    const name = m[1];
    const cols = resolveConstant(source, name);
    if (cols === null) continue;
    constants += 1;
    for (const cred of CREDENTIALS) {
      const token = new RegExp(`\\b[a-z_]*${cred}[a-z_]*\\b`).exec(cols);
      if (!token || ALLOWED_LOOKALIKES.has(token[0])) continue;
      offences.push(`${rel} ${name} -> lists the credential column '${token[0]}'`);
    }
  }
}

// ── Third pass: no .upsert() on a credential-bearing table ─────────────────
// An upsert is not a plain insert. PostgREST resolves
// .upsert({...}, { onConflict }) to ON CONFLICT DO UPDATE SET col = EXCLUDED
// .col, and PostgreSQL requires SELECT on a column whose EXCLUDED value is
// read -- regardless of whether anything is returned. So on these tables an
// upsert is refused OUTRIGHT ("permission denied for table ..."), even though
// INSERT and UPDATE are both still granted. v2/integrations.html's Klaviyo
// Connect button used exactly that shape and would have started failing the
// moment 20261113010000 applied; it now inserts and falls back to an update on
// 23505. This is the guard that stops the shape coming back, because the
// failure is invisible until a real admin pastes a real key.
let upserts = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  for (const table of GUARDED) {
    const call = new RegExp(`from\\(\\s*['"\`]${table}['"\`]\\s*\\)([\\s\\S]{0,400})`, 'g');
    for (const m of source.matchAll(call)) {
      upserts += 1;
      const verb = /\.(upsert|insert|update|delete|select)\s*\(/.exec(m[1]);
      if (verb && verb[1] === 'upsert') {
        offences.push(`${rel} ${table} -> uses .upsert(); credential SELECT is revoked, so ` +
          `ON CONFLICT DO UPDATE is refused outright. Insert, then update on 23505.`);
      }
    }
  }
}

assert.deepEqual(offences, [], `a browser page asks for a stored credential, or for every column of a table that holds one:\n  ${offences.join('\n  ')}`);
assert.ok(checked >= 6, `expected to find the known selects on these tables, found ${checked} -- did the scan stop matching?`);
assert.ok(constants >= 3, `expected to read the known *_COLUMNS constants, found ${constants} -- did the scan stop matching?`);
assert.ok(upserts >= 10, `expected to find the known calls on these tables, found ${upserts} -- did the scan stop matching?`);
console.log(`connection credentials: ${checked} select(s), ${constants} column-list constant(s) and ${upserts} call(s) on ${GUARDED.length} credential-bearing tables across ${files.length} files, none names a credential or '*' and none upserts`);
