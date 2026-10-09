// Edge-function guards from the 2026-10-08 security audit.
//
// These functions are Deno handlers wired straight into Deno.serve, so a node
// test cannot execute them; `deno check` (sync-tests.yml) proves they compile.
// What this file pins is that each guard is present AND sits on the path the
// attack used -- ordering included where order is the fix. A refactor that
// drops one fails here with the finding it reopens named in the message.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const before = (src, a, b, why) => {
  const i = src.indexOf(a); const j = src.indexOf(b);
  assert.ok(i >= 0, `missing: ${a.slice(0, 80)}`);
  assert.ok(j >= 0, `missing: ${b.slice(0, 80)}`);
  assert.ok(i < j, why);
};

// ── sample-notify: the body is a pointer, never content ─────────────────────
test('sample-notify re-reads the sample by id and uses that row, not the body', () => {
  const s = read('supabase/functions/sample-notify/index.ts');
  assert.match(s, /const claimed = body\?\.record as Partial<SampleRecord>/);
  assert.match(s, /\.from\('product_samples'\)\s*\.select\(SAMPLE_COLUMNS\)\s*\.eq\('id', claimed\.id\)/);
  assert.match(s, /row\.company_entity_id !== claimed\.company_entity_id/);
  assert.match(s, /const record = row as SampleRecord;/);
  assert.doesNotMatch(s, /const record = body\?\.record/, 'body.record must not be the record again');
});
test('sample-notify: a signed-in caller must see the sample under RLS; only then may it pick a member assignee', () => {
  const s = read('supabase/functions/sample-notify/index.ts');
  before(s, "caller.from('product_samples').select('id').eq('id', claimed.id)", 'record.assigned_to = claimed.assigned_to',
    'RLS visibility must be proven before any caller-chosen assignee is honoured');
  assert.match(s, /if \(jwt && claimed\.assigned_to/);
  assert.match(s, /\.from\('entity_memberships'\)\s*\.select\('user_id'\)\s*\.eq\('entity_id', record\.company_entity_id\)\s*\.eq\('user_id', claimed\.assigned_to\)/);
});
test('sample-notify: #samples is Baseballism-only and Slack text is escaped', () => {
  const s = read('supabase/functions/sample-notify/index.ts');
  assert.match(s, /record\.company_entity_id !== SLACK_CHANNEL_COMPANY_ID/);
  for (const line of s.split('\n').filter((l) => l.includes('slackText = `'))) {
    assert.doesNotMatch(line, /\$\{(title|ref|who|record\.factory_name|record\.size_requests)\}/, `unescaped Slack field: ${line.trim()}`);
  }
  assert.match(s, /if \(!jwt\) return new Response\(JSON\.stringify\(\{ ok: true \}\)/, 'unsigned callers learn no delivery detail');
});

// ── notify IDORs: the caller's RLS read is the authority ────────────────────
test('payment-request-notify reads the request as the caller, not the service role', () => {
  const s = read('supabase/functions/payment-request-notify/index.ts');
  assert.match(s, /const \{ data: pr, error: prErr \} = await callerClient\s*\.from\('payment_requests'\)/);
  assert.match(s, /\.eq\('id', payment_request_id\)\s*\.eq\('company_entity_id', pr\.company_entity_id\);/);
});
test('comp-request-notify "decided" proves RLS visibility before sending', () => {
  const s = read('supabase/functions/comp-request-notify/index.ts');
  before(s, "await callerClient\n      .from('comp_adjustment_requests')", "sendEmail(sender, [reqRow.requested_by_email]",
    'the decision email must not go out before the caller is shown to see the request');
  assert.doesNotMatch(s, /<strong style="color:#fff">\$\{reqRow\.employee_name\}/);
  assert.match(s, /Note from finance: "\$\{esc\(reqRow\.finance_notes\)\}"/);
});

// ── payment emails: recipient, attachments, escaping ────────────────────────
test('submitted-notify only mails a person in the request\'s company', () => {
  const s = read('supabase/functions/payment-request-submitted-notify/index.ts');
  before(s, "Receipts are only sent to people in this workspace", 'const emailSent = await sendEmail(',
    'the recipient check must run before the send');
  assert.match(s, /String\(p\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\) === requesterEmail/);
  assert.doesNotMatch(s, /\.ilike\('email'/, 'ILIKE treats % and _ in a typed address as wildcards');
});
for (const fn of ['payment-request-notify', 'payment-request-submitted-notify', 'payment-request-forward-melio']) {
  test(`${fn}: attachments only from {requestId}/ and the email body is escaped`, () => {
    const s = read(`supabase/functions/${fn}/index.ts`);
    assert.match(s, /if \(!file\.file_path\.startsWith\(`\$\{[^}]+\}\/`\) \|\| file\.file_path\.includes\('\.\.'\)\) continue;/);
    before(s, "file.file_path.includes('..')) continue;", '.download(file.file_path)', 'the path guard must precede the download');
    assert.match(s, /const vendorName = esc\(opts\.vendorName\);/);
    assert.match(s, /const invoiceNumber = esc\(opts\.invoiceNumber\);/);
  });
}
test('forward-melio: legacy links are http(s) only', () => {
  const s = read('supabase/functions/payment-request-forward-melio/index.ts');
  assert.match(s, /function safeHref\(u: string\)/);
  assert.doesNotMatch(s, /<a href="\$\{l\}"/);
});

// ── Shopify ─────────────────────────────────────────────────────────────────
test('shopify-sync-run gates on mayConnect for the connection\'s company, never the global role alone', () => {
  const s = read('supabase/functions/shopify-sync-run/index.ts');
  assert.match(s, /if \(!mayConnect\(\{ profile, profileError, membership, membershipError, companyId: visible\.company_entity_id \}\)\)/);
  assert.doesNotMatch(s, /\['owner', 'admin'\]\.includes\(String\(profile\.role\)\)/);
  assert.equal((s.match(/await assertCompanyAdmin\(userClient, admin, userId, connectionId\)/g) || []).length, 2,
    'both connection loaders must go through the company gate');
});
test('shopify-sync-run scopes every sync_jobs update to the connection', () => {
  const s = read('supabase/functions/shopify-sync-run/index.ts');
  assert.match(s, /\.eq\('id', jobId\)\s*\.eq\('connection_id', connection\.id\)\s*\.eq\('company_entity_id', connection\.company_entity_id\);/);
  assert.doesNotMatch(s, /updateJob\(admin, (?!connection,)/);
});
test('test-shopify-connection: no request-supplied host, stored host normalised', () => {
  const s = read('supabase/functions/test-shopify-connection/index.ts');
  assert.doesNotMatch(s, /let \{ shop_domain, access_token \} = body/);
  assert.match(s, /if \(!connectionId\) \{/);
  assert.match(s, /const domain = normalizeShopDomain\(shop_domain\);/);
});

// ── Reviews, Redo ───────────────────────────────────────────────────────────
test('review-send judges exec authority with is_exec_or_owner(), as the caller', () => {
  const s = read('supabase/functions/review-send/index.ts');
  assert.match(s, /await callerClient\.rpc\('is_exec_or_owner'\)/);
  assert.doesNotMatch(s, /\['owner', 'executive'\]\.includes\(role\)/);
});
test('redo-webhook: constant-time secret compare and one 401 for every refusal', () => {
  const s = read('supabase/functions/redo-webhook/index.ts');
  assert.match(s, /async function secretsMatch\(given: string, expected: string\)/);
  assert.doesNotMatch(s, /authHeader !== connection\.webhook_secret/);
  assert.doesNotMatch(s, /No active Redo connection for this company/);
});

console.log(`\n${passed} passed`);
