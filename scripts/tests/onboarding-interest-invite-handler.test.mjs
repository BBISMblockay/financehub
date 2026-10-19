// Runs the real onboarding-interest-invite handler and the real trigger in
// onboarding-interest under Node, mocking only fetch. Nothing reaches a live
// service and no credential is loaded.
// Mutation: AUTO_INVITE_HANDLER_MUTATION=no-auth|no-flag|mail-fail-marks-sent|trusts-body-recipient|no-escape
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../../', import.meta.url);
const load = async (rel, swaps = []) => {
  let src = await readFile(new URL(rel, root), 'utf8');
  for (const [a, b] of swaps) { assert.ok(src.includes(a), a); src = src.replace(a, b); }
  return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(src)).toString('base64'));
};
const mutation = process.env.AUTO_INVITE_HANDLER_MUTATION || '';
const M = {
  'no-auth': [['if (!timingSafeEqual(bearer, deps.serviceRoleKey)) return json({ error: \'Not authorized.\' }, 401);', '']],
  'no-flag': [["if (!deps.enabled) return json({ ok: true, skipped: 'disabled' });", '']],
  'mail-fail-marks-sent': [['sent = mail.ok;', 'sent = true;']],
  'trusts-body-recipient': [['to: [claim.email],', 'to: [email],']],
  'no-escape': [['const esc = (s: string) => s.replace(', 'const esc = (s: string) => s.replace(/(?!)/, ']],
}[mutation] || [];
const { createHandler, emailHtml } = await load('supabase/functions/onboarding-interest-invite/handler.ts', M);

const SECRET = 'service-secret';
const base = { supabaseUrl: 'https://x.supabase.co', serviceRoleKey: SECRET, enabled: true, dailyCap: 100, resendKey: 'rk', siteUrl: 'https://silo.example' };
const claimed = { claimed: true, invite_id: 'inv-1', token: 'tok123', email: 'lead@example.com', name: 'Pat <b>', company_name: 'Acme & Co' };

function harness({ claim = claimed, mailOk = true, ...over } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/rpc/claim_auto_invite')) return Response.json(claim);
    if (String(url).endsWith('/rpc/finish_auto_invite')) return new Response(null, { status: 204 });
    if (String(url).startsWith('https://api.resend.com')) return new Response('{}', { status: mailOk ? 200 : 500 });
    throw new Error('unexpected ' + url);
  };
  return { calls, handler: createHandler({ ...base, fetch, ...over }) };
}
const req = (body = { email: 'lead@example.com' }, auth = `Bearer ${SECRET}`, method = 'POST') =>
  new Request('https://x/f', { method, headers: { authorization: auth, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
let n = 0;
const test = async (name, fn) => { await fn(); console.log(`ok ${++n} - ${name}`); };

await test('claims, emails the stored address a link, then records sent', async () => {
  const { handler, calls } = harness();
  const res = await handler(req());
  assert.deepEqual(await res.json(), { ok: true, sent: true });
  assert.deepEqual(calls.map((c) => c.url.split('/').slice(-1)[0]), ['claim_auto_invite', 'emails', 'finish_auto_invite']);
  assert.deepEqual(calls[0].body, { p_email: 'lead@example.com', p_daily_cap: 100 });
  const mail = calls[1].body;
  assert.deepEqual(mail.to, ['lead@example.com']);
  assert.match(mail.html, /https:\/\/silo\.example\/v2\/company-onboarding\.html\?invite=tok123/);
  assert.deepEqual(calls[2].body, { p_invite_id: 'inv-1', p_sent: true });
});
await test('the recipient is the stored lead, never the request body', async () => {
  const { handler, calls } = harness({ claim: { ...claimed, email: 'stored@example.com' } });
  await handler(req({ email: 'attacker-chosen@example.com' }));
  assert.deepEqual(calls[1].body.to, ['stored@example.com']);
});
await test('a failed email revokes via finish(false) and says sent:false', async () => {
  const { handler, calls } = harness({ mailOk: false });
  assert.deepEqual(await (await handler(req())).json(), { ok: true, sent: false });
  assert.deepEqual(calls.at(-1).body, { p_invite_id: 'inv-1', p_sent: false });
});
await test('no email key means not sent, never a false success', async () => {
  const { handler, calls } = harness({ resendKey: '' });
  assert.equal((await (await handler(req())).json()).sent, false);
  assert.ok(!calls.some((c) => c.url.includes('resend')));
});
await test('refuses a caller without the service-role bearer, before any database call', async () => {
  for (const auth of ['', 'Bearer nope', `Bearer ${SECRET}x`]) {
    const { handler, calls } = harness();
    assert.equal((await handler(req(undefined, auth))).status, 401);
    assert.equal(calls.length, 0);
  }
  assert.equal((await harness().handler(req(undefined, undefined, 'GET'))).status, 405);
});
await test('does nothing unless switched on', async () => {
  const { handler, calls } = harness({ enabled: false });
  assert.deepEqual(await (await handler(req())).json(), { ok: true, skipped: 'disabled' });
  assert.equal(calls.length, 0);
});
await test('a cap or already-handled lead sends nothing', async () => {
  for (const reason of ['cap', 'already_handled', 'invite_exists', 'no_lead']) {
    const { handler, calls } = harness({ claim: { claimed: false, reason } });
    assert.deepEqual(await (await handler(req())).json(), { ok: true, skipped: reason });
    assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['claim_auto_invite']);
  }
});
await test('the daily cap defaults to 100 and passes the configured one', async () => {
  const a = harness({ dailyCap: undefined }); await a.handler(req());
  assert.equal(a.calls[0].body.p_daily_cap, 100);
  const b = harness({ dailyCap: 7 }); await b.handler(req());
  assert.equal(b.calls[0].body.p_daily_cap, 7);
});
await test('lead-supplied text cannot inject markup into the email', async () => {
  const html = emailHtml('<script>x</script>', '"><img src=x>', 'https://a/?x="y');
  assert.ok(!/<script>|<img/.test(html));
});
await test('missing body or config fails closed', async () => {
  assert.equal((await harness().handler(req({}))).status, 400);
  assert.equal((await harness({ supabaseUrl: '' }).handler(req())).status, 503);
});

// The trigger in onboarding-interest: one extra call, only when switched on,
// and the visitor's response never changes.
const { createHandler: createIntake } = await load('supabase/functions/onboarding-interest/handler.ts');
const intake = (autoInvite, inviteFails = false) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/onboarding-interest-invite')) { if (inviteFails) throw new Error('down'); return Response.json({ ok: true }); }
    return Response.json({ accepted: true, retry_after_seconds: 0 });
  };
  return { calls, handler: createIntake({ supabaseUrl: 'https://x.supabase.co', serviceRoleKey: SECRET, fetch, autoInvite }) };
};
const lead = () => new Request('https://x/f', { method: 'POST', headers: { origin: 'https://get-silo.com', 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Pat', company_name: 'Acme', email: 'Lead@Example.com', website: '' }) });
await test('intake asks the invite function only when switched on, with just the email', async () => {
  const on = intake(true); const r = await on.handler(lead());
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(on.calls.length, 2);
  assert.equal(on.calls[1].url, 'https://x.supabase.co/functions/v1/onboarding-interest-invite');
  assert.deepEqual(JSON.parse(on.calls[1].init.body), { email: 'lead@example.com' });
  assert.equal(on.calls[1].init.headers.Authorization, `Bearer ${SECRET}`);
  const off = intake(false); await off.handler(lead());
  assert.equal(off.calls.length, 1);
});
await test('an invite-function failure never changes what the visitor sees', async () => {
  const { handler } = intake(true, true);
  const r = await handler(lead());
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
});
console.log(`${n} auto-invite handler checks passed`);
