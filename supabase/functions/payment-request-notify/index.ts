// payment-request-notify — emails the requester once AP marks a
// payment request completed/paid. Auth: caller must pass
// current_user_can_manage_payment_requests() (owner/admin membership,
// or finance/admin/exec department). Idempotent to call repeatedly —
// each call re-sends and logs a fresh notification_sent activity row,
// used both for the automatic send-on-mark-paid and the manual
// "Resend notification" button.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const FROM = 'SILO <noreply@silo-baseballism.com>';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const BUCKET = 'payment-request-files';
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  check: 'Check',
  wire: 'Wire transfer',
  flexfin: 'FlexFin',
  credit_card: 'Credit card',
  other: 'Other',
};

function money(n: number | null): string {
  if (n == null) return '$0.00';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

type EmailAttachment = { filename: string; content: string };

async function sendEmail(to: string, subject: string, html: string, attachments?: EmailAttachment[]): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const body: Record<string, unknown> = { from: FROM, to: [to], subject, html };
  if (attachments?.length) body.attachments = attachments;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('[payment-request-notify] resend error', res.status, await res.text());
  return res.ok;
}

// Confirmation documents live at {requestId}/confirmation/{...} in the
// payment-request-files bucket (matches isConfirmationFile() in
// v2/request_manager.html). Best-effort: a download/size failure on one
// file skips that file rather than failing the whole notification.
async function fetchConfirmationAttachments(paymentRequestId: string): Promise<EmailAttachment[]> {
  const { data: files, error } = await db
    .from('payment_request_files')
    .select('file_name, file_path')
    .eq('payment_request_id', paymentRequestId)
    .like('file_path', '%/confirmation/%');
  if (error || !files?.length) return [];

  const attachments: EmailAttachment[] = [];
  for (const file of files) {
    if (!file.file_path) continue;
    const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(file.file_path);
    if (dlErr || !blob) {
      console.error('[payment-request-notify] failed to download confirmation file', file.file_path, dlErr);
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      console.error('[payment-request-notify] confirmation file too large to attach', file.file_path, bytes.byteLength);
      continue;
    }
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    attachments.push({ filename: file.file_name || 'confirmation-document', content: btoa(binary) });
  }
  return attachments;
}

function emailHtml(opts: {
  vendorName: string;
  amount: number | null;
  paymentTypeLabel: string;
  paymentDetail: string | null;
  dateCompleted: string | null;
  invoiceNumber: string | null;
  attachmentCount: number;
}): string {
  const { vendorName, amount, paymentTypeLabel, paymentDetail, dateCompleted, invoiceNumber, attachmentCount } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Your payment request has been paid</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        Your payment request for <strong style="color:#fff">${vendorName}</strong>${invoiceNumber ? ` (invoice ${invoiceNumber})` : ''}
        has been paid.${attachmentCount ? ` The confirmation document${attachmentCount > 1 ? 's are' : ' is'} attached.` : ''}
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Amount</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right;font-family:monospace">${money(amount)}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Paid via</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${paymentTypeLabel}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Date paid</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${formatDate(dateCompleted)}</td>
        </tr>
        ${paymentDetail ? `
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Reference</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${paymentDetail}</td>
        </tr>` : ''}
      </table>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">Questions about this payment? Reach out to AP directly.</p>
    </div>
    <p style="color:#9aa3ad;font-size:11px;text-align:center;margin-top:14px">Sent by SILO Accounts Payable.</p>
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

    const { payment_request_id } = await req.json();
    if (!payment_request_id) {
      return new Response(JSON.stringify({ error: 'payment_request_id required' }), { status: 400, headers: CORS });
    }

    // Scope the permission check to the caller's own session so
    // current_user_can_manage_payment_requests() resolves auth.uid()
    // and active_company_id() correctly.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: canManage, error: permErr } = await callerClient.rpc('current_user_can_manage_payment_requests');
    if (permErr || !canManage) {
      return new Response(JSON.stringify({ error: 'Not authorized to notify requesters' }), { status: 403, headers: CORS });
    }

    const { data: pr, error: prErr } = await db
      .from('payment_requests')
      .select('*')
      .eq('id', payment_request_id)
      .single();
    if (prErr || !pr) {
      return new Response(JSON.stringify({ error: 'Payment request not found' }), { status: 404, headers: CORS });
    }
    if (!pr.completed) {
      return new Response(JSON.stringify({ error: 'Request is not marked completed/paid yet' }), { status: 400, headers: CORS });
    }
    if (!pr.requester_email) {
      return new Response(JSON.stringify({ error: 'No requester email on file for this request' }), { status: 400, headers: CORS });
    }

    const vendorName = pr.vendor_name_manual || pr.vendor_name || 'Vendor';
    const paymentTypeLabel = PAYMENT_TYPE_LABELS[pr.payment_type] || pr.payment_type || 'Payment';
    const attachments = await fetchConfirmationAttachments(payment_request_id);

    const emailSent = await sendEmail(
      pr.requester_email,
      `Your payment request for ${vendorName} has been paid`,
      emailHtml({
        vendorName,
        amount: pr.amount_due,
        paymentTypeLabel,
        paymentDetail: pr.payment_detail,
        dateCompleted: pr.date_completed,
        invoiceNumber: pr.invoice_number,
        attachmentCount: attachments.length,
      }),
      attachments,
    );

    if (!emailSent) {
      return new Response(
        JSON.stringify({ error: RESEND_KEY ? 'Email send failed' : 'RESEND_API_KEY not configured' }),
        { status: 502, headers: CORS },
      );
    }

    const now = new Date().toISOString();
    await db.from('payment_requests')
      .update({ paid_notification_sent_at: now, paid_notification_sent_by: userData.user.id })
      .eq('id', payment_request_id);

    await db.from('payment_request_activity').insert({
      payment_request_id,
      activity_type: 'notification_sent',
      message: `Emailed ${pr.requester_email}: payment confirmation (${paymentTypeLabel}, paid ${formatDate(pr.date_completed)})${attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''}`,
      created_by: userData.user.id,
      company_entity_id: pr.company_entity_id,
    });

    return new Response(JSON.stringify({ ok: true, email_sent: true, sent_at: now }), { headers: CORS });
  } catch (err) {
    console.error('[payment-request-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
