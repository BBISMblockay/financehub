// review-portal — public (no SILO login) access to a single review via a
// signed link. The token IS the authorization: it maps to exactly one
// review, is sha256-hashed at rest, expires after 30 days, and completing
// the acknowledgment locks it. Associates without SILO accounts use this;
// nothing here touches PostgREST/RLS — all reads go through the service
// role scoped strictly by the token's review_id.
//
// Actions (POST JSON):
//   { token, action: 'get' }    -> review payload (never private notes)
//   { token, action: 'finish', response?, signed_name } -> sign + lock
//   { token, action: 'renew' }  -> expired token: email a fresh link to the
//                                  employee on file (rate-limited, 1/hour)
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
  if (!res.ok) console.error('[review-portal] resend error', res.status, await res.text());
  return res.ok;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const { token, action, response, signed_name } = await req.json();
    if (!token || !action) return json({ error: 'token and action required' }, 400);

    const hash = await sha256hex(String(token));
    const { data: tok } = await db.from('review_access_tokens').select('*').eq('token_hash', hash).single();
    if (!tok || tok.revoked) return json({ error: 'This link is no longer valid.' }, 404);

    const expired = new Date(tok.expires_at).getTime() < Date.now();

    const { data: review } = await db
      .from('reviews')
      .select('*, employees(id, name, email, job_title, location), review_templates(title, description)')
      .eq('id', tok.review_id)
      .single();
    if (!review) return json({ error: 'Review not found.' }, 404);

    if (action === 'renew') {
      if (!expired) return json({ error: 'Link is still valid.' }, 400);
      const { data: recent } = await db
        .from('review_access_tokens')
        .select('id')
        .eq('review_id', tok.review_id)
        .gt('created_at', new Date(Date.now() - 3600 * 1000).toISOString())
        .limit(1);
      if (recent?.length) return json({ error: 'A fresh link was requested recently — check your inbox, or try again in an hour.' }, 429);

      const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const { error: tErr } = await db.from('review_access_tokens').insert({
        review_id: tok.review_id,
        company_entity_id: review.company_entity_id,
        token_hash: await sha256hex(raw),
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      });
      if (tErr) return json({ error: 'Could not issue a new link.' }, 500);

      const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
      const link = `${origin}/pages/review.html?token=${raw}`;
      const sent = await sendEmail(
        review.employees.email,
        'Your fresh review link',
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px"><p style="font-size:14px">Hi ${review.employees.name}, here is a fresh link to your performance review:</p><a href="${link}" style="display:inline-block;background:#14181d;color:#fff;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none">Open your review</a><p style="color:#7f8b96;font-size:12px">This link expires in 30 days.</p></div>`,
      );
      return json({ renewed: true, email_sent: sent });
    }

    if (expired) return json({ expired: true, employee_name: review.employees?.name || '' });

    if (action === 'get') {
      const { data: questions } = await db
        .from('review_template_questions')
        .select('id, position, kind, label, help_text, options, required')
        .eq('template_id', review.template_id)
        .order('position');
      const { data: answers } = await db
        .from('review_answers')
        .select('question_id, value')
        .eq('review_id', review.id);
      const { data: goals } = await db
        .from('employee_goals')
        .select('id, title, description, target_date, status, review_id')
        .eq('employee_id', review.employees.id)
        .order('created_at');
      const { data: mgr } = await db.from('profiles').select('name, email').eq('id', review.manager_user_id).single();

      return json({
        review: {
          id: review.id,
          status: review.status,
          period_label: review.period_label,
          sent_at: review.sent_at,
          employee_response: review.employee_response,
          employee_signed_name: review.employee_signed_name,
          employee_signed_at: review.employee_signed_at,
        },
        employee: review.employees,
        template: review.review_templates,
        manager: { name: mgr?.name || mgr?.email || 'Manager' },
        questions: questions || [],
        answers: answers || [],
        goals: (goals || []).filter((g) => g.review_id === review.id || ['open', 'carried', 'achieved', 'dropped'].includes(g.status)),
        completed: !!tok.completed_at || review.status === 'finished',
      });
    }

    if (action === 'finish') {
      if (tok.completed_at || review.status === 'finished') return json({ error: 'This review is already signed.' }, 400);
      if (review.status !== 'sent') return json({ error: 'This review is not ready to sign.' }, 400);
      const name = String(signed_name || '').trim();
      if (!name) return json({ error: 'Type your full name to sign.' }, 400);

      const now = new Date().toISOString();
      const { error: uErr } = await db.from('reviews').update({
        status: 'finished',
        employee_response: String(response || '').trim() || null,
        employee_signed_name: name,
        employee_signed_at: now,
      }).eq('id', review.id);
      if (uErr) return json({ error: 'Could not save your acknowledgment.' }, 500);
      await db.from('review_access_tokens').update({ completed_at: now }).eq('id', tok.id);

      const { data: mgr } = await db.from('profiles').select('name, email').eq('id', review.manager_user_id).single();
      if (mgr?.email) {
        await sendEmail(
          mgr.email,
          `${review.employees.name} signed their performance review`,
          `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px"><p style="font-size:14px"><strong>${review.employees.name}</strong> acknowledged and signed their ${review.period_label ? review.period_label + ' ' : ''}review.</p>${response ? `<p style="font-size:13px;color:#444;border-left:3px solid #ddd;padding-left:12px;white-space:pre-wrap">${String(response).slice(0, 2000)}</p>` : ''}<p style="font-size:12px;color:#7f8b96">Open the Review Board in SILO to see the finished review.</p></div>`,
        );
      }
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error('[review-portal]', err);
    return json({ error: String(err?.message || err) }, 500);
  }
});
