// org-invite-send — emails an org invite link to the invited address.
// Auth: caller must be an active owner/admin/executive whose active company
// is the invite's entity. The caller passes the invite_id plus the raw token
// (returned once by create_org_invite); the function verifies the token's
// sha256 matches the pending invite row, so it can only ever email the
// address stored on the invite — never an arbitrary recipient. Sends via
// Resend when RESEND_API_KEY is configured; always returns the link so the
// admin can deliver it manually if email isn't set up.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const FROM = 'SILO <noreply@silo-baseballism.com>';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!res.ok) console.error('[org-invite-send] resend error', res.status, await res.text());
  return res.ok;
}

function emailHtml(orgTitle: string, inviterName: string, link: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">You&rsquo;ve been invited to join ${orgTitle}</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        ${inviterName} invited you to join <b>${orgTitle}</b> on SILO.
        Use the button below to sign in — or create your account — with this email address, and you&rsquo;ll land in the team automatically.
      </p>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:8px">Join ${orgTitle}</a>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">This link is tied to this email address and expires in 14 days. If it expires, ask ${inviterName} for a new one.</p>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO on behalf of ${inviterName}.</p>
  </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: CORS });
    }
    const uid = userData.user.id;

    const { invite_id, token } = await req.json();
    if (!invite_id || !token) {
      return new Response(JSON.stringify({ error: 'invite_id and token required' }), { status: 400, headers: CORS });
    }

    const { data: invite, error: iErr } = await db
      .from('org_invites')
      .select('id, entity_id, email, status, expires_at, token_hash')
      .eq('id', invite_id)
      .single();
    if (iErr || !invite) return new Response(JSON.stringify({ error: 'Invite not found' }), { status: 404, headers: CORS });
    if (invite.status !== 'pending') {
      return new Response(JSON.stringify({ error: 'Invite is no longer pending' }), { status: 400, headers: CORS });
    }
    if (invite.token_hash !== (await sha256hex(String(token)))) {
      return new Response(JSON.stringify({ error: 'Token does not match invite' }), { status: 403, headers: CORS });
    }

    const { data: caller } = await db
      .from('profiles')
      .select('name, email, role, is_active, active_company_id')
      .eq('id', uid)
      .single();
    const role = String(caller?.role || '').toLowerCase();
    const isAdmin = caller?.is_active && ['owner', 'admin', 'executive'].includes(role);
    if (!isAdmin || caller?.active_company_id !== invite.entity_id) {
      return new Response(JSON.stringify({ error: 'Not authorized for this invite' }), { status: 403, headers: CORS });
    }

    const { data: entity } = await db.from('entities').select('title').eq('id', invite.entity_id).single();
    const orgTitle = entity?.title || 'your team';
    const inviterName = caller?.name || caller?.email || 'A teammate';

    const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
    const link = `${origin}/pages/login.html?invite=${encodeURIComponent(String(token))}`;

    const emailSent = await sendEmail(
      invite.email,
      `You've been invited to join ${orgTitle} on SILO`,
      emailHtml(orgTitle, inviterName, link),
    );

    return new Response(JSON.stringify({ ok: true, email_sent: emailSent, link }), { headers: CORS });
  } catch (err) {
    console.error('[org-invite-send]', err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: CORS });
  }
});
