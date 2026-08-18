// sample-notify — email + Slack for product_samples events. Fired by a
// Postgres trigger (notify_sample_events(), see
// supabase/migrations/20260817190000_sample_notifications.sql), not called
// by the browser, so there is no user JWT to verify (verify_jwt: false,
// same posture as notify-slack for POs — this project has no mechanism for
// a Postgres trigger to attach a Supabase-signed JWT to an outbound
// net.http_post call). Payload shape is validated strictly instead.
//
// Five event types: a sample being requested, arriving, becoming ready in
// the warehouse, someone flagging which sizes are needed, and a sample
// being assigned to a specific person. Recipients: when record.assigned_to
// is set, only that person is emailed directly (a stored assignee, added
// 20260818130000, same shape as mail_items.assigned_to). Otherwise this
// falls back to the active company's `logistics` department profiles,
// resolved at send time rather than hardcoded, so the list stays correct
// as staff changes.
//
// When there's an assignee, they're also DMed on Slack (in addition to,
// not instead of, the existing #samples-channel webhook post below — that
// channel is a separate, optional team-wide feed). There's no stored Slack
// user id anywhere in this repo, so the DM is resolved the same way the
// email is: by the assignee's SILO email, via Slack's
// users.lookupByEmail — this only works if that address matches a real
// account in the Baseballism Slack workspace. Silently skipped (no error)
// if SLACK_BOT_TOKEN is unset or the lookup/open/post fails, same
// optional-secret posture as RESEND_API_KEY / SLACK_SAMPLES_WEBHOOK_URL.
//
// Every attempt is also logged to sample_notification_log (20260818150000)
// — this trigger's net.http_post is fire-and-forget from Postgres, so
// without a row somewhere the browser has no way to know whether anyone
// was actually reached. Logging is best-effort: wrapped so a logging
// failure never turns a real send into an error response.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const SLACK_WEBHOOK = Deno.env.get('SLACK_SAMPLES_WEBHOOK_URL') || '';
const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') || '';
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
  request_source: string | null;
  created_by: string | null;
  assigned_to: string | null;
};

const KNOWN_TYPES = [
  'SAMPLE_REQUESTED',
  'SAMPLE_RECEIVED',
  'SAMPLE_WAREHOUSE_READY',
  'SAMPLE_SIZE_REQUEST',
  'SAMPLE_ASSIGNED',
] as const;
type EventType = (typeof KNOWN_TYPES)[number];

function sampleLink(id: string): string {
  const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
  return `${origin}/v2/products.html?tab=samples&sample=${id}`;
}

type SendResult = { sent: boolean; reason?: string };

async function sendEmail(to: string[], subject: string, html: string): Promise<SendResult> {
  if (!RESEND_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  if (!to.length) return { sent: false, reason: 'no recipient' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[sample-notify] resend error', res.status, body);
    return { sent: false, reason: `resend ${res.status}` };
  }
  return { sent: true };
}

async function sendSlack(text: string): Promise<SendResult> {
  if (!SLACK_WEBHOOK) return { sent: false, reason: 'SLACK_SAMPLES_WEBHOOK_URL not set' };
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[sample-notify] slack error', res.status, body);
    return { sent: false, reason: `webhook ${res.status}` };
  }
  return { sent: true };
}

// DMs a specific person on Slack by looking up their SILO email against
// the workspace, opening (or reusing) a DM with them, then posting. Three
// Slack API calls chained because there's no stored Slack user id to skip
// straight to chat.postMessage with — see header comment.
async function sendSlackDM(email: string | null, text: string): Promise<SendResult> {
  if (!SLACK_BOT_TOKEN) return { sent: false, reason: 'SLACK_BOT_TOKEN not set' };
  if (!email) return { sent: false, reason: 'no assignee email' };
  try {
    const lookupRes = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const lookup = await lookupRes.json();
    if (!lookup.ok || !lookup.user?.id) {
      // users_not_found just means this person's SILO email isn't in the
      // Slack workspace — expected for some staff, not worth logging as an
      // error every time.
      if (lookup.error && lookup.error !== 'users_not_found') {
        console.error('[sample-notify] slack lookupByEmail error', lookup.error);
      }
      return { sent: false, reason: lookup.error === 'users_not_found' ? 'email not in Slack workspace' : `lookup: ${lookup.error}` };
    }

    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ users: lookup.user.id }),
    });
    const opened = await openRes.json();
    if (!opened.ok || !opened.channel?.id) {
      console.error('[sample-notify] slack conversations.open error', opened.error);
      return { sent: false, reason: `open DM: ${opened.error}` };
    }

    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: opened.channel.id, text }),
    });
    const posted = await postRes.json();
    if (!posted.ok) {
      console.error('[sample-notify] slack chat.postMessage error', posted.error);
      return { sent: false, reason: `post: ${posted.error}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[sample-notify] slack DM error', err);
    return { sent: false, reason: String((err as Error)?.message || err) };
  }
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

    let toEmails: string[] = [];
    let assigneeEmail: string | null = null;
    let recipientLabel: string | null = null;
    if (record.assigned_to) {
      // A specific person was picked for this sample — notify only them,
      // not the whole department. Still gated on is_active so an
      // offboarded assignee doesn't silently eat the notification.
      const { data: assignee } = await db
        .from('profiles')
        .select('name, email')
        .eq('id', record.assigned_to)
        .eq('is_active', true)
        .maybeSingle();
      if (assignee?.email) {
        toEmails = [assignee.email];
        assigneeEmail = assignee.email;
        recipientLabel = assignee.name || assignee.email;
      } else {
        recipientLabel = 'assignee (inactive or not found)';
      }
    } else {
      // No assignee set — fall back to the whole logistics department,
      // scoped through entity_memberships rather than a bare
      // profiles.department filter, since a user can belong to more than
      // one company and profiles.active_company_id is only a per-session
      // pointer. Filtering by department alone would leak every company's
      // logistics team into every other company's sample emails.
      //
      // Two plain queries, not a nested embed — entity_memberships.user_id
      // is a FK to auth.users, not profiles, so PostgREST can't
      // auto-detect a relationship for `profiles!inner(...)` here. The
      // same shape of embed failure (silent, empty results) already bit
      // the Reviews team-picker for exactly this reason — see
      // docs/ops/CHANGELOG.md, 2026-08 — fixed there the same way:
      // memberships first, then profiles .in().
      const { data: memberships } = await db
        .from('entity_memberships')
        .select('user_id')
        .eq('entity_id', record.company_entity_id);
      const userIds = (memberships || []).map((m) => m.user_id).filter(Boolean);

      if (userIds.length) {
        const { data: profiles } = await db
          .from('profiles')
          .select('email')
          .in('id', userIds)
          .eq('department', 'logistics')
          .eq('is_active', true);
        toEmails = (profiles || []).map((p) => p.email).filter(Boolean) as string[];
      }
      recipientLabel = `Logistics dept (${toEmails.length})`;
    }

    const link = sampleLink(record.id);
    const title = record.product_title || 'Untitled sample';
    const ref = record.sample_ref ? ` (${record.sample_ref})` : '';

    // Only looked up when actually needed for phrasing below — a name on
    // the message is what Chris/Blake's Slack thread (2026-08-17) actually
    // asked for, not just "sizes requested".
    let requesterName: string | null = null;
    const needsRequesterName =
      record.request_source === 'catalog_photo_request' &&
      (type === 'SAMPLE_SIZE_REQUEST' || type === 'SAMPLE_REQUESTED');
    if (needsRequesterName && record.created_by) {
      const { data: requester } = await db.from('profiles').select('name').eq('id', record.created_by).single();
      requesterName = requester?.name || null;
    }

    // Only looked up for SAMPLE_ASSIGNED, to say who did the assigning.
    let assignerName: string | null = null;
    if (type === 'SAMPLE_ASSIGNED' && record.created_by) {
      const { data: creator } = await db.from('profiles').select('name').eq('id', record.created_by).single();
      assignerName = creator?.name || null;
    }

    let subject: string;
    let html: string;
    let slackText: string;

    if (type === 'SAMPLE_REQUESTED') {
      const who = requesterName || 'Someone';
      if (record.request_source === 'catalog_photo_request') {
        subject = `Photo sample requested: ${title}`;
        html = emailHtml({
          headline: 'Photo sample requested',
          body: `<strong style="color:#fff">${esc(who)}</strong> has requested a photo sample pull from bulk/on-hand inventory — <strong style="color:#fff">${esc(title)}</strong>${esc(ref)}.`,
          link,
        });
        slackText = `:camera: *${who} requested a photo sample* — ${title}${ref}\n${link}`;
      } else {
        subject = `Sample requested: ${title}`;
        html = emailHtml({
          headline: 'Sample requested',
          body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} was requested${record.factory_name ? ` from ${esc(record.factory_name)}` : ''}.`,
          link,
        });
        slackText = `:memo: *Sample requested* — ${title}${ref}${record.factory_name ? ` from ${record.factory_name}` : ''}\n${link}`;
      }
    } else if (type === 'SAMPLE_RECEIVED') {
      subject = `Sample received: ${title}`;
      html = emailHtml({
        headline: 'Sample received',
        body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} was logged as received${record.factory_name ? ` from ${esc(record.factory_name)}` : ''}.`,
        link,
      });
      slackText = `:package: *Sample received* — ${title}${ref}${record.factory_name ? ` from ${record.factory_name}` : ''}\n${link}`;
    } else if (type === 'SAMPLE_WAREHOUSE_READY') {
      subject = `Sample ready: ${title}`;
      html = emailHtml({
        headline: 'Sample ready for pickup',
        body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} is ready for pickup in the warehouse.`,
        link,
      });
      slackText = `:white_check_mark: *Sample ready for pickup* — ${title}${ref}\n${link}`;
    } else if (type === 'SAMPLE_ASSIGNED') {
      const who = assignerName || 'Someone';
      subject = `Sample assigned to you: ${title}`;
      html = emailHtml({
        headline: 'A sample was assigned to you',
        body: `<strong style="color:#fff">${esc(who)}</strong> assigned <strong style="color:#fff">${esc(title)}</strong>${esc(ref)} to you.`,
        link,
      });
      slackText = `:inbox_tray: *${who} assigned a sample to a teammate* — ${title}${ref}\n${link}`;
    } else if (record.request_source === 'catalog_photo_request') {
      // Distinct phrasing per Chris: this is a pull from existing bulk/
      // on-hand stock for a photo shoot, not a pre-production sample
      // request — the two are different things at Baseballism and the
      // message should say which one this is.
      const who = requesterName || 'Someone';
      subject = `Photo sample sizes requested: ${title}`;
      html = emailHtml({
        headline: 'Photo sample sizes requested',
        body: `<strong style="color:#fff">${esc(who)}</strong> has requested photo samples from bulk/on-hand inventory — <strong style="color:#fff">${esc(title)}</strong>${esc(ref)}: <strong style="color:#fff">${esc(record.size_requests)}</strong>.`,
        link,
      });
      slackText = `:camera: *${who} requested photo samples from bulk/on-hand inventory* — ${title}${ref}: *${record.size_requests}*\n${link}`;
    } else {
      subject = `Sizes requested: ${title}`;
      html = emailHtml({
        headline: 'Sizes requested',
        body: `<strong style="color:#fff">${esc(title)}</strong>${esc(ref)} needs sizes pulled: <strong style="color:#fff">${esc(record.size_requests)}</strong>.`,
        link,
      });
      slackText = `:straight_ruler: *Sizes requested* — ${title}${ref}: *${record.size_requests}*\n${link}`;
    }

    const [emailResult, slackResult, slackDmResult] = await Promise.all([
      sendEmail(toEmails, subject, html),
      sendSlack(slackText),
      sendSlackDM(assigneeEmail, slackText),
    ]);

    // Best-effort and awaited (not fire-and-forget) — the edge runtime can
    // tear down right after the response is sent, so an un-awaited insert
    // here risks never actually happening. Wrapped so a logging failure
    // still can't turn an otherwise-successful send into an error response.
    try {
      const { error: logErr } = await db.from('sample_notification_log').insert({
        company_entity_id: record.company_entity_id,
        sample_id: record.id,
        event_type: type,
        recipient_label: recipientLabel,
        email_sent: emailResult.sent,
        email_reason: emailResult.reason || null,
        slack_sent: slackResult.sent,
        slack_reason: slackResult.reason || null,
        slack_dm_sent: slackDmResult.sent,
        slack_dm_reason: slackDmResult.reason || null,
        recipients_count: toEmails.length,
      });
      if (logErr) console.error('[sample-notify] log insert error', logErr.message);
    } catch (logErr) {
      console.error('[sample-notify] log insert error', logErr);
    }

    return new Response(JSON.stringify({
      ok: true,
      email_sent: emailResult.sent,
      slack_sent: slackResult.sent,
      slack_dm_sent: slackDmResult.sent,
      recipients: toEmails.length,
    }), { headers: CORS });
  } catch (err) {
    console.error('[sample-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
