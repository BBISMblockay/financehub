// platform-invite-send — emails a FOUNDING invite link (create_platform_invite)
// to the address stored on the invite. Sibling of org-invite-send, which
// covers teammate invites into an existing workspace.
// Auth: the caller must be a platform admin (is_platform_admin(), asked as the
// caller so RLS/definer logic judges their own token). The caller passes
// invite_id plus the raw token returned once by create_platform_invite; the
// function verifies the token's sha256 matches the pending row, so it can only
// ever email the address stored on that invite -- never an arbitrary
// recipient. Always returns the link so the admin can deliver it manually if
// email isn't configured.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const FROM_FALLBACK = Deno.env.get('SILO_MAIL_FROM') || 'SILO <noreply@silo-baseballism.com>';

type Sender = { from: string; replyTo: string | null };

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

// Per-request, never module-level: an isolate serves concurrent requests.
async function resolveSender(
  companyId: string | null | undefined,
  actorEmail?: string | null,
): Promise<Sender> {
  const fallback: Sender = { from: FROM_FALLBACK, replyTo: actorEmail ?? null };
  if (!companyId) return fallback;
  try {
    const { data, error } = await db.rpc('resolve_notification_sender', {
      p_company_entity_id: companyId,
      p_purpose: 'general_ops',
      p_actor_email: actorEmail ?? null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.from_header) return fallback;
    return { from: row.from_header as string, replyTo: (row.reply_to as string | null) ?? null };
  } catch {
    return fallback;
  }
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendEmail(sender: Sender, to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: sender.from, to: [to], subject, html,
      ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
  });
  if (!res.ok) console.error('[platform-invite-send] resend error', res.status, await res.text());
  return res.ok;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function emailHtml(suggestedCompany: string | null, link: string): string {
  const what = suggestedCompany ? `<b>${esc(suggestedCompany)}</b>` : 'your company';
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Your SILO workspace is ready to set up</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        You&rsquo;ve been invited to create ${what} on SILO.
        Use the button below to sign in &mdash; or create your account &mdash; with this email address, and setup will start right away.
      </p>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:8px">Create your SILO</a>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">This link is tied to this email address and expires in 14 days.</p>
    </div>
  </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const authorization = req.headers.get('Authorization');
    const jwt = (authorization || '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Not authenticated' }, 401);

    // Third-party tokens (20261020030000): everything below runs with the
    // service role, which the Data API's pre-request hook never sees. This
    // check is pure, so it comes before the network round trip the two-step
    // gate makes. See supabase/functions/CLAUDE.md.
    const integ = checkIntegrationToken(req.headers.get('Authorization'));
    if (!integ.ok) return json({ error: integ.message, code: integ.code }, integ.status);
    // Two-step login: everything below runs with the service role, which the
    // Data API's gate never sees. Ask as the caller before the first such call.
    const mfa = await checkMfaSession({
      supabaseUrl: Deno.env.get('SUPABASE_URL'),
      anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
      authorization,
    });
    if (!mfa.ok) return json({ error: mfa.message, code: mfa.code }, mfa.status);

    // Authorize as the CALLER: platform-admin authority is judged by the DB
    // on the caller's own token, not by a role string read here.
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authorization! } },
    });
    const { data: isPlatformAdmin, error: paErr } = await asCaller.rpc('is_platform_admin');
    if (paErr || isPlatformAdmin !== true) return json({ error: 'Not authorized' }, 403);

    const { invite_id, token } = await req.json();
    if (!invite_id || !token) return json({ error: 'invite_id and token required' }, 400);

    const { data: invite, error: iErr } = await db
      .from('platform_invites')
      .select('id, email, suggested_company, status, expires_at, token_hash')
      .eq('id', invite_id)
      .single();
    if (iErr || !invite) return json({ error: 'Invite not found' }, 404);
    if (invite.status !== 'pending' || new Date(invite.expires_at) < new Date()) {
      return json({ error: 'Invite is no longer pending' }, 400);
    }
    if (invite.token_hash !== (await sha256hex(String(token)))) {
      return json({ error: 'Token does not match invite' }, 403);
    }

    const { data: caller } = await db
      .from('profiles')
      .select('email, active_company_id')
      .eq('id', userData.user.id)
      .single();

    const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
    const link = `${origin}/v2/company-onboarding.html?invite=${encodeURIComponent(String(token))}`;

    const sender = await resolveSender(caller?.active_company_id, caller?.email);
    const emailSent = await sendEmail(
      sender,
      invite.email,
      'Your SILO workspace is ready to set up',
      emailHtml(invite.suggested_company, link),
    );

    return json({ ok: true, email_sent: emailSent, link });
  } catch (err) {
    console.error('[platform-invite-send]', err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
