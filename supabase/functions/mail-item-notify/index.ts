// mail-item-notify — emails the assignee when mail is routed to them, or
// the original submitter when their mail item is marked done. Mailroom is
// an open shared-team-inbox model (see 20260721000000_mailroom_rebuild.sql),
// so unlike payment-request-notify there is no manage-permission RPC gate --
// any authenticated member of the item's active company may trigger this,
// matching mail_items' own RLS. The caller-scoped client below reads through
// mail_items_v so RLS ("same active company") is enforced, not bypassed.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
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

const PRIORITY_LABELS: Record<string, string> = {
  P0: 'Urgent',
  P1: 'High priority',
  P2: 'Normal',
  P3: 'Low priority',
};

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

async function sendEmail(sender: Sender, to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: sender.from, to: [to], subject, html,
      ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
  });
  if (!res.ok) console.error('[mail-item-notify] resend error', res.status, await res.text());
  return res.ok;
}

function mailLink(itemId: string): string {
  const origin = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';
  return `${origin}/v2/mailroom.html?item=${itemId}`;
}

function assignedEmailHtml(opts: {
  subject: string;
  sender: string | null;
  priority: string;
  dueDate: string | null;
  actionNeeded: string | null;
  link: string;
}): string {
  const { subject, sender, priority, dueDate, actionNeeded, link } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Mail routed to you</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        <strong style="color:#fff">${subject}</strong>${sender ? ` from ${sender}` : ''} was routed to you in the Mailroom queue.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Priority</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${priority}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Due</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${formatDate(dueDate)}</td>
        </tr>
        ${actionNeeded ? `
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Action needed</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${actionNeeded}</td>
        </tr>` : ''}
      </table>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:20px">Open in Mailroom</a>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO Mailroom.</p>
  </div>`;
}

function doneEmailHtml(opts: { subject: string; processedByName: string | null; link: string }): string {
  const { subject, processedByName, link } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Mail item resolved</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        <strong style="color:#fff">${subject}</strong>, which you logged in the Mailroom queue, has been marked done${processedByName ? ` by ${processedByName}` : ''}.
      </p>
      <a href="${link}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:20px">View in Mailroom</a>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO Mailroom.</p>
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

    const { mail_item_id, kind } = await req.json();
    if (!mail_item_id || !['assigned', 'done'].includes(kind)) {
      return new Response(
        JSON.stringify({ error: 'mail_item_id and a valid kind ("assigned" or "done") are required' }),
        { status: 400, headers: CORS },
      );
    }

    // Scoped to the caller's own session so mail_items_v's RLS
    // (company_entity_id = active_company_id()) governs visibility --
    // mailroom has no separate manage-permission gate to check, matching
    // the page's own open-to-any-active-company-member model.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: mi, error: miErr } = await callerClient
      .from('mail_items_v')
      .select('*')
      .eq('id', mail_item_id)
      .single();
    if (miErr || !mi) {
      return new Response(JSON.stringify({ error: 'Mail item not found' }), { status: 404, headers: CORS });
    }

    const link = mailLink(mi.id);
    let to: string | null;
    let subjectLine: string;
    let html: string;

    if (kind === 'assigned') {
      to = mi.assigned_to_email || null;
      if (!to) {
        return new Response(JSON.stringify({ error: 'No email on file for the assignee' }), { status: 400, headers: CORS });
      }
      subjectLine = `Mail routed to you: ${mi.subject}`;
      html = assignedEmailHtml({
        subject: mi.subject,
        sender: mi.sender,
        priority: PRIORITY_LABELS[mi.priority] || mi.priority || 'Normal',
        dueDate: mi.due_date,
        actionNeeded: mi.action_needed,
        link,
      });
    } else {
      to = mi.submitted_by_email || null;
      if (!to) {
        return new Response(JSON.stringify({ error: 'No email on file for the submitter' }), { status: 400, headers: CORS });
      }
      if (mi.status !== 'done') {
        return new Response(JSON.stringify({ error: 'Item is not marked done' }), { status: 400, headers: CORS });
      }
      subjectLine = `Resolved: ${mi.subject}`;
      html = doneEmailHtml({ subject: mi.subject, processedByName: mi.processed_by_name, link });
    }

    const sender = await resolveSender(mi.company_entity_id, 'general_ops', null);
    const emailSent = await sendEmail(sender, to, subjectLine, html);
    if (!emailSent) {
      return new Response(
        JSON.stringify({ error: RESEND_KEY ? 'Email send failed' : 'RESEND_API_KEY not configured' }),
        { status: 502, headers: CORS },
      );
    }

    await db.from('mail_item_activity').insert({
      mail_item_id: mi.id,
      activity_type: 'notification_sent',
      message: kind === 'assigned' ? `Emailed ${to}: routed to them` : `Emailed ${to}: item resolved`,
      created_by: userData.user.id,
      company_entity_id: mi.company_entity_id,
    });

    return new Response(JSON.stringify({ ok: true, email_sent: true }), { headers: CORS });
  } catch (err) {
    console.error('[mail-item-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
