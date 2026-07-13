// review-send — manager sends a review to the employee.
// Auth: caller must be the review's manager or an exec/owner of the same
// company. Creates a 30-day access token (sha256-hashed at rest), marks the
// review 'sent', and emails the employee a secure link via Resend when
// RESEND_API_KEY is configured. Always returns the link so the manager can
// deliver it manually if email isn't set up yet.
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

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

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
  if (!res.ok) console.error('[review-send] resend error', res.status, await res.text());
  return res.ok;
}

function emailHtml(employeeName: string, managerName: string, period: string, link: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Your performance review is ready</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        Hi ${employeeName},<br/><br/>
        ${managerName} has completed your ${period ? period + ' ' : ''}performance review.
        Use the button below to read it, add your response, and sign your acknowledgment.
      </p>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:8px">Open your review</a>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">This link is unique to you and expires in 30 days. If it expires, the page will offer to email you a fresh one.</p>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO on behalf of ${managerName}. Questions? Reply to your manager directly.</p>
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

    const { review_id } = await req.json();
    if (!review_id) return new Response(JSON.stringify({ error: 'review_id required' }), { status: 400, headers: CORS });

    const { data: review, error: rErr } = await db
      .from('reviews')
      .select('*, employees(name, email), review_templates(title)')
      .eq('id', review_id)
      .single();
    if (rErr || !review) return new Response(JSON.stringify({ error: 'Review not found' }), { status: 404, headers: CORS });
    if (review.status === 'finished') {
      return new Response(JSON.stringify({ error: 'Review is already finished' }), { status: 400, headers: CORS });
    }

    const { data: caller } = await db.from('profiles').select('id, name, email, role, active_company_id').eq('id', uid).single();
    const role = String(caller?.role || '').toLowerCase();
    const isExec = ['owner', 'executive'].includes(role);
    const isManager = review.manager_user_id === uid;
    const sameCompany = caller?.active_company_id === review.company_entity_id;
    if (!sameCompany || (!isManager && !isExec)) {
      return new Response(JSON.stringify({ error: 'Not authorized for this review' }), { status: 403, headers: CORS });
    }

    // Fresh token per send; revoke any prior ones.
    await db.from('review_access_tokens').update({ revoked: true }).eq('review_id', review_id).eq('revoked', false);

    const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const { error: tErr } = await db.from('review_access_tokens').insert({
      review_id,
      company_entity_id: review.company_entity_id,
      token_hash: await sha256hex(raw),
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    if (tErr) return new Response(JSON.stringify({ error: `Token create failed: ${tErr.message}` }), { status: 500, headers: CORS });

    const { error: uErr } = await db.from('reviews')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', review_id);
    if (uErr) return new Response(JSON.stringify({ error: `Status update failed: ${uErr.message}` }), { status: 500, headers: CORS });

    const origin = req.headers.get('origin') || Deno.env.get('SILO_SITE_URL') || '';
    const link = `${origin}/pages/review.html?token=${raw}`;

    // Manager profile name for the email; fall back to the review's manager.
    let managerName = caller?.name || caller?.email || 'Your manager';
    if (!isManager) {
      const { data: mgr } = await db.from('profiles').select('name, email').eq('id', review.manager_user_id).single();
      managerName = mgr?.name || mgr?.email || managerName;
    }

    const emailSent = await sendEmail(
      review.employees.email,
      `Your ${review.period_label ? review.period_label + ' ' : ''}performance review is ready`,
      emailHtml(review.employees.name, managerName, review.period_label || '', link),
    );

    return new Response(JSON.stringify({ ok: true, email_sent: emailSent, link }), { headers: CORS });
  } catch (err) {
    console.error('[review-send]', err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: CORS });
  }
});
