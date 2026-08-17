// sample-notify — email + Slack for product_samples events. Fired by a
// Postgres trigger (notify_sample_events(), see
// supabase/migrations/20260817190000_sample_notifications.sql), not called
// by the browser, so there is no user JWT to verify (verify_jwt: false,
// same posture as notify-slack for POs — this project has no mechanism for
// a Postgres trigger to attach a Supabase-signed JWT to an outbound
// net.http_post call). Payload shape is validated strictly instead.
//
// Two event types, both requested directly: a sample arriving, and someone
// flagging which sizes are needed. Recipients are the active company's
// `logistics` department profiles, resolved at send time rather than
// hardcoded, so the list stays correct as staff changes — matches how
// mail_items resolves an assignee by email rather than storing one.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const SLACK_WEBHOOK = Deno.env.get('SLACK_SAMPLES_WEBHOOK_URL') || '';
const FROM = 'SILO <noreply@silo-baseballism.com>';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

type SampleRecord = {
  id: string;
  company_entity_id: string | null;
  product_title: string | null;
  sample_ref: string | null;
  factory_name: string | null;
  size_requests: string | null;
  sample_status: string | null;
};

const KNOWN_TYPES = ['SAMPLE_RECEIVED', 'SAMPLE_SIZE_REQUEST'] as const;
type EventType = (typeof KNOWN_TYPES)[number];

function sampleLink(id: string): string {
  const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
  return `${origin}/v2/products.html?tab=samples&sample=${id}`;
}

async function sendEmail(to: string[], subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY || !to.length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) console.error('[sample-notify] resend error', res.status, await res.text());
  return res.ok;
}

async function sendSlack(text: string): Promise<boolean> {
  if (!SLACK_WEBHOOK) return false;
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) console.error('[sample-notify] slack error', res.status, await res.text());
  return res.ok;
}

function emailHtml(opts: { headline: string; body: string; link: string }): string {
  const { headline, body, link } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">${headline}</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">${body}</p>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:20px">Open sample</a>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO — Products / Samples.</p>
  </div>`;
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] as string));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => null);
    const type = body?.type as EventType | undefined;
    const record = body?.record as SampleRecord | undefined;

    if (!type || !KNOWN_TYPES.includes(type)) {
      return new Response(JSON.stringify({ error: `type must be one of ${KNOWN_TYPES.join(', ')}` }), { status: 400, headers: CORS });
    }
    if (!record?.id || !record?.company_entity_id) {
      return new Response(JSON.stringify({ error: 'record with id and company_entity_id is required' }), { status: 400, headers: CORS });
    }

    // Scoped through entity_memberships, not a bare profiles.department
    // filter — a user can belong to more than one company, and
    // profiles.active_company_id is a per-session pointer, not "the only
    // company this person is in". Filtering by department alone would leak
    // every company's logistics team into every other company's sample
    // emails.
    //
    // Two plain queries, not a nested embed — entity_memberships.user_id is
    // a FK to auth.users, not profiles, so PostgREST can't auto-detect a
    // relationship for `profiles!inner(...)` here. The same shape of embed
    // failure (silent, empty results) already bit the Reviews team-picker
    // for exactly this reason — see docs/ops/CHANGELOG.md, 2026-08 —
    // fixed there the same way: memberships first, then profiles .in().
    const { data: memberships } = await db
      .from('entity_memberships')
      .select('user_id')
      .eq('entity_id', record.company_entity_id);
    const userIds = (memberships || []).map((m) => m.user_id).filter(Boolean);

    let toEmails: string[] = [];
    if (userIds.length) {
      const { data: profiles } = await db
        .from('profiles')
        .select('email')
        .in('id', userIds)
        .eq('department', 'logistics')
        .eq('is_active', true);
      toEmails = (profiles || []).map((p) => p.email).filter(Boolean) as string[];
    }

    const link = sampleLink(record.id);
    const title = record.product_title || 'Untitled sample';
    const ref = record.sample_ref ? ` (${record.sample_ref})` : '';

    let subject: string;
    let html: string;
    let slackText: string;

    if (type === 'SAMPLE_RECEIVED') {
      subject = `Sample received: ${title}`;
      html = emailHtml({
        headline: 'Sample received',
        body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} was logged as received${record.factory_name ? ` from ${esc(record.factory_name)}` : ''}.`,
        link,
      });
      slackText = `:package: *Sample received* — ${title}${ref}${record.factory_name ? ` from ${record.factory_name}` : ''}\n${link}`;
    } else {
      subject = `Sizes requested: ${title}`;
      html = emailHtml({
        headline: 'Sizes requested',
        body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} needs sizes pulled: <strong style="color:#fff">${esc(record.size_requests)}</strong>.`,
        link,
      });
      slackText = `:straight_ruler: *Sizes requested* — ${title}${ref}: *${record.size_requests}*\n${link}`;
    }

    const [emailSent, slackSent] = await Promise.all([
      sendEmail(toEmails, subject, html),
      sendSlack(slackText),
    ]);

    return new Response(JSON.stringify({ ok: true, email_sent: emailSent, slack_sent: slackSent, recipients: toEmails.length }), { headers: CORS });
  } catch (err) {
    console.error('[sample-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
