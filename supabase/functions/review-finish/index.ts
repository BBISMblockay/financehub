// review-finish — a SILO-authenticated employee signs their own review
// in-app (the my-review page). Counterpart to review-portal's 'finish' for
// associates: here the JWT is the identity, and the caller must be the
// profile linked to the review's employee record. Marks the review
// finished, locks any outstanding access tokens, and emails the manager.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
// The sender address is configuration, not a constant. A second tenant's
// invite, review or payment email arriving from a Baseballism address reads
// as either a mistake or a leak of who else uses SILO. SILO_MAIL_FROM is an
// edge-function secret; the literal stays as the fallback so nothing changes
// for Baseballism until that secret is set.
// The sender identity is PER TENANT and resolved at send time, not
// configured: a single env string cannot carry one company's name for one
// email and another's for the next. resolve_notification_sender() is the one
// definition of both halves (20260920170000) -- it returns the From header
// built from the company's own title, and the Reply-To for this KIND of
// notification, falling back to the tenant's general contact, then the person
// who triggered it, then an owner-admin, and NEVER to a SILO address.
//
// Deliberately NOT a module-level mutable: a Deno isolate serves concurrent
// requests, so a shared `sender` would put one tenant's name and reply address
// on another tenant's email. It is passed explicitly instead.
const FROM_FALLBACK = Deno.env.get('SILO_MAIL_FROM') || 'SILO <noreply@silo-baseballism.com>';

type Sender = { from: string; replyTo: string | null };

async function resolveSender(
  companyId: string | null | undefined,
  purpose: string,
  actorEmail?: string | null,
): Promise<Sender> {
  const fallback: Sender = { from: FROM_FALLBACK, replyTo: actorEmail ?? null };
  if (!companyId) return fallback;
  try {
    const { data, error } = await db.rpc('resolve_notification_sender', {
      p_company_entity_id: companyId,
      p_purpose: purpose,
      p_actor_email: actorEmail ?? null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    // A resolution failure must not stop the notification: the message
    // matters more than the header. Falling back still never names SILO as
    // the reply address -- it just carries no Reply-To at all.
    if (error || !row?.from_header) return fallback;
    return { from: row.from_header as string, replyTo: (row.reply_to as string | null) ?? null };
  } catch {
    return fallback;
  }
}

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function sendEmail(sender: Sender, to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: sender.from, to: [to], subject, html,
      ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
  });
  if (!res.ok) console.error('[review-finish] resend error', res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Not authenticated' }, 401);
    const uid = userData.user.id;

    const { review_id, response, signed_name } = await req.json();
    if (!review_id) return json({ error: 'review_id required' }, 400);
    const name = String(signed_name || '').trim();
    if (!name) return json({ error: 'Type your full name to sign.' }, 400);

    const { data: review } = await db
      .from('reviews')
      .select('*, employees(id, name, profile_id)')
      .eq('id', review_id)
      .single();
    if (!review) return json({ error: 'Review not found.' }, 404);
    if (review.employees?.profile_id !== uid) return json({ error: 'This is not your review.' }, 403);
    if (review.status === 'finished') return json({ error: 'This review is already signed.' }, 400);
    if (review.status !== 'sent') return json({ error: 'This review is not ready to sign.' }, 400);

    const now = new Date().toISOString();
    const { error: uErr } = await db.from('reviews').update({
      status: 'finished',
      employee_response: String(response || '').trim() || null,
      employee_signed_name: name,
      employee_signed_at: now,
    }).eq('id', review_id);
    if (uErr) return json({ error: 'Could not save your acknowledgment.' }, 500);

    // Lock the email-link tokens too so both paths agree it's done.
    await db.from('review_access_tokens').update({ completed_at: now }).eq('review_id', review_id).is('completed_at', null);

    const { data: mgr } = await db.from('profiles').select('name, email').eq('id', review.manager_user_id).single();
    if (mgr?.email) {
      const sender = await resolveSender(review.company_entity_id, 'hr_comp', null);
      await sendEmail(sender, 
        mgr.email,
        `${review.employees.name} signed their performance review`,
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px"><p style="font-size:14px"><strong>${review.employees.name}</strong> acknowledged and signed their ${review.period_label ? review.period_label + ' ' : ''}review in SILO.</p>${response ? `<p style="font-size:12px;font-weight:600;color:#7f8b96;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.04em">Employee's Comments</p><p style="font-size:13px;color:#444;border-left:3px solid #ddd;padding-left:12px;white-space:pre-wrap;margin-top:0">${String(response).slice(0, 2000)}</p>` : ''}<p style="font-size:12px;color:#7f8b96">Open the Review Board in SILO to see the finished review.</p></div>`,
      );
    }
    return json({ ok: true });
  } catch (err) {
    console.error('[review-finish]', err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
