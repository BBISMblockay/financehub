// comp-request-notify — emails the finance team when a manager submits a
// compensation adjustment request, and emails the requesting manager back
// once finance records a decision. Two `action`s, one function, mirroring
// the payment-request-submitted-notify / payment-request-notify split but
// combined here since both sides are small.
//
// Auth:
//   action: 'submitted' — caller must be the request's created_by (same
//     "requester triggers their own receipt" shape as
//     payment-request-submitted-notify — this fires from the manager's own
//     submit action, not a finance action).
//   action: 'decided'   — caller must pass
//     current_user_can_manage_comp_requests(), re-checked via an
//     anon-key client scoped to the caller's JWT so the RPC resolves
//     auth.uid() as the caller, not the service role (same pattern as
//     payment-request-notify).
// Idempotent to call repeatedly — each call re-sends and logs a fresh
// comp_adjustment_request_activity row.
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
const SITE_URL = Deno.env.get('SILO_SITE_URL') || 'https://silo-baseballism.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  raise: 'Raise',
  bonus: 'Bonus',
  promotion: 'Promotion',
  equity: 'Equity',
  other: 'Other',
};

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  in_review: 'In review',
  needs_info: 'Needs more information',
  approved: 'Approved',
  denied: 'Denied',
};

function money(n: number | null): string {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

async function sendEmail(sender: Sender, to: string[], subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY || !to.length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: sender.from, to, subject, html,
      ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
  });
  if (!res.ok) console.error('[comp-request-notify] resend error', res.status, await res.text());
  return res.ok;
}

function shell(bodyHtml: string, footer: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      ${bodyHtml}
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">${footer}</p>
  </div>`;
}

function detailRows(rows: Array<[string, string]>): string {
  return `<table style="width:100%;border-collapse:collapse;margin-top:12px">` +
    rows.map(([label, value]) => `
      <tr>
        <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">${label}</td>
        <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${value}</td>
      </tr>`).join('') +
    `</table>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: CORS });
    }

    const { comp_adjustment_request_id, action } = await req.json();
    if (!comp_adjustment_request_id || !['submitted', 'decided'].includes(action)) {
      return new Response(JSON.stringify({ error: 'comp_adjustment_request_id and action ("submitted" | "decided") are required' }), { status: 400, headers: CORS });
    }

    const { data: reqRow, error: reqErr } = await db
      .from('comp_adjustment_requests_v')
      .select('*')
      .eq('id', comp_adjustment_request_id)
      .single();
    if (reqErr || !reqRow) {
      return new Response(JSON.stringify({ error: 'Request not found' }), { status: 404, headers: CORS });
    }

    const typeLabel = ADJUSTMENT_TYPE_LABELS[reqRow.adjustment_type] || reqRow.adjustment_type || 'Adjustment';
    const link = `${SITE_URL}/v2/comp-requests.html?id=${comp_adjustment_request_id}`;

    if (action === 'submitted') {
      if (reqRow.created_by !== userData.user.id) {
        return new Response(JSON.stringify({ error: 'Not authorized for this request' }), { status: 403, headers: CORS });
      }

      // entity_memberships first, then profiles .eq() — a bare
      // profiles.department filter would leak other companies' finance
      // teams into this company's email (same fix already applied in
      // sample-notify's logistics fallback). Deliberately department =
      // 'finance' only, NOT the broader admin/exec fallback
      // current_user_can_manage_comp_requests() itself uses for who CAN
      // act on a request — comp data is more sensitive than AP, and at
      // Baseballism today admin/exec would have pulled in 11 recipients
      // instead of the actual finance team.
      const { data: memberships } = await db
        .from('entity_memberships')
        .select('user_id')
        .eq('entity_id', reqRow.company_entity_id);
      const userIds = (memberships || []).map((m) => m.user_id).filter(Boolean);
      let toEmails: string[] = [];
      if (userIds.length) {
        const { data: financeProfiles } = await db
          .from('profiles')
          .select('email')
          .in('id', userIds)
          .eq('department', 'finance')
          .eq('is_active', true);
        toEmails = (financeProfiles || []).map((p) => p.email).filter(Boolean) as string[];
      }

      const html = shell(`
        <div style="margin-top:18px;font-size:16px;font-weight:700">New compensation request to review</div>
        <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
          ${reqRow.requested_by_name || reqRow.requested_by_email || 'A manager'} submitted a ${typeLabel.toLowerCase()} request for
          <strong style="color:#fff">${reqRow.employee_name}</strong>.
        </p>
        ${detailRows([
          ['Type', typeLabel],
          ['Current', money(reqRow.current_compensation)],
          ['Proposed', money(reqRow.proposed_compensation)],
          ['Effective', formatDate(reqRow.effective_date)],
        ])}
        <p style="color:#7f8b96;font-size:12px;margin-top:20px">Review it in SILO → Team → Compensation.</p>
      `, 'Sent by SILO Team.');

      const sender = await resolveSender(reqRow.company_entity_id, 'hr_comp', null);
      const emailSent = await sendEmail(sender, toEmails, `Comp request: ${reqRow.employee_name} (${typeLabel})`, html);

      await db.from('comp_adjustment_request_activity').insert({
        request_id: comp_adjustment_request_id,
        activity_type: 'notification_sent',
        message: emailSent
          ? `Emailed finance (${toEmails.length}): new submission`
          : (RESEND_KEY ? 'Email send failed or no finance recipients on file' : 'RESEND_API_KEY not configured — link only'),
        created_by: userData.user.id,
        company_entity_id: reqRow.company_entity_id,
      });

      return new Response(JSON.stringify({ ok: true, email_sent: emailSent, recipient_count: toEmails.length, link }), { headers: CORS });
    }

    // action === 'decided'
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: canManage, error: permErr } = await callerClient.rpc('current_user_can_manage_comp_requests');
    if (permErr || !canManage) {
      return new Response(JSON.stringify({ error: 'Not authorized to send a decision notification' }), { status: 403, headers: CORS });
    }
    if (!reqRow.requested_by_email) {
      return new Response(JSON.stringify({ error: 'No requester email on file for this request' }), { status: 400, headers: CORS });
    }

    const statusLabel = STATUS_LABELS[reqRow.status] || reqRow.status;
    const decisionColor = reqRow.status === 'approved' ? '#3ddc84' : reqRow.status === 'denied' ? '#ff6b6b' : '#f2c94c';
    const html = shell(`
      <div style="margin-top:18px;font-size:16px;font-weight:700">
        Your comp request was <span style="color:${decisionColor}">${statusLabel.toLowerCase()}</span>
      </div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        The ${typeLabel.toLowerCase()} request for <strong style="color:#fff">${reqRow.employee_name}</strong> is now
        <strong style="color:#fff">${statusLabel.toLowerCase()}</strong>.
        ${reqRow.finance_notes ? `<br/><br/>Note from finance: "${reqRow.finance_notes}"` : ''}
      </p>
      ${detailRows([
        ['Type', typeLabel],
        ['Proposed', money(reqRow.proposed_compensation)],
        ['Reviewed by', reqRow.reviewed_by_name || reqRow.reviewed_by_email || '—'],
      ])}
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">Questions about this decision? Reach out to finance directly.</p>
    `, 'Sent by SILO Team.');

    const sender = await resolveSender(reqRow.company_entity_id, 'hr_comp', null);
    const emailSent = await sendEmail(sender, [reqRow.requested_by_email], `Comp request for ${reqRow.employee_name}: ${statusLabel}`, html);

    await db.from('comp_adjustment_request_activity').insert({
      request_id: comp_adjustment_request_id,
      activity_type: 'notification_sent',
      message: emailSent
        ? `Emailed ${reqRow.requested_by_email}: ${statusLabel.toLowerCase()}`
        : (RESEND_KEY ? 'Email send failed' : 'RESEND_API_KEY not configured — link only'),
      created_by: userData.user.id,
      company_entity_id: reqRow.company_entity_id,
    });

    return new Response(JSON.stringify({ ok: true, email_sent: emailSent, link }), { headers: CORS });
  } catch (err) {
    console.error('[comp-request-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
