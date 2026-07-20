// payment-request-submitted-notify — emails the requester a receipt
// confirmation the moment their payment request is submitted.
// Auth: caller must be the request's original submitter (created_by) —
// unlike payment-request-notify, this fires from the public intake
// form (v2/purchase_request.html) itself, not an AP action, so it is
// NOT gated by current_user_can_manage_payment_requests(). Attaches
// whatever the requester just uploaded as a receipt copy.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

const REQUEST_TYPE_LABELS: Record<string, string> = {
  invoice_vendor_payment: 'Invoice / vendor payment',
  inventory_deposit: 'Inventory deposit',
  inventory_balance: 'Inventory balance',
  inventory_freight: 'Inventory freight',
  employee_reimbursement: 'Employee reimbursement',
  customer_refund: 'Customer refund',
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
  if (!res.ok) console.error('[payment-request-submitted-notify] resend error', res.status, await res.text());
  return res.ok;
}

// Intake attachments live at {requestId}/{...} directly (no /confirmation/
// segment -- that subfolder is reserved for AP's later payment proof).
async function fetchSubmittedAttachments(paymentRequestId: string): Promise<EmailAttachment[]> {
  const { data: files, error } = await db
    .from('payment_request_files')
    .select('file_name, file_path')
    .eq('payment_request_id', paymentRequestId)
    .not('file_path', 'like', '%/confirmation/%');
  if (error || !files?.length) return [];

  const attachments: EmailAttachment[] = [];
  for (const file of files) {
    if (!file.file_path) continue;
    const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(file.file_path);
    if (dlErr || !blob) {
      console.error('[payment-request-submitted-notify] failed to download file', file.file_path, dlErr);
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      console.error('[payment-request-submitted-notify] file too large to attach', file.file_path, bytes.byteLength);
      continue;
    }
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    attachments.push({ filename: file.file_name || 'attachment', content: btoa(binary) });
  }
  return attachments;
}

function emailHtml(opts: {
  vendorName: string;
  amount: number | null;
  requestTypeLabel: string;
  invoiceNumber: string | null;
  submittedAt: string | null;
  attachmentCount: number;
}): string {
  const { vendorName, amount, requestTypeLabel, invoiceNumber, submittedAt, attachmentCount } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Your payment request was received</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        Your ${requestTypeLabel.toLowerCase()} request for <strong style="color:#fff">${vendorName}</strong>${invoiceNumber ? ` (invoice ${invoiceNumber})` : ''}
        has been submitted to AP.${attachmentCount ? ` A copy of what you attached is included.` : ''} We'll email you again once it's paid.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Amount</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right;font-family:monospace">${money(amount)}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Request type</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${requestTypeLabel}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Submitted</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${formatDate(submittedAt)}</td>
        </tr>
      </table>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">Questions about this request? Reach out to AP directly.</p>
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

    const { data: pr, error: prErr } = await db
      .from('payment_requests')
      .select('*')
      .eq('id', payment_request_id)
      .single();
    if (prErr || !pr) {
      return new Response(JSON.stringify({ error: 'Payment request not found' }), { status: 404, headers: CORS });
    }
    if (pr.created_by !== userData.user.id) {
      return new Response(JSON.stringify({ error: 'Not authorized for this request' }), { status: 403, headers: CORS });
    }
    if (!pr.requester_email) {
      return new Response(JSON.stringify({ error: 'No requester email on file for this request' }), { status: 400, headers: CORS });
    }

    const vendorName = pr.vendor_name_manual || pr.vendor_name || 'Vendor';
    const requestTypeLabel = REQUEST_TYPE_LABELS[pr.request_type] || pr.request_type || 'Payment';
    const attachments = await fetchSubmittedAttachments(payment_request_id);

    const emailSent = await sendEmail(
      pr.requester_email,
      `Your payment request for ${vendorName} was received`,
      emailHtml({
        vendorName,
        amount: pr.amount_due,
        requestTypeLabel,
        invoiceNumber: pr.invoice_number,
        submittedAt: pr.submitted_at ? pr.submitted_at.slice(0, 10) : null,
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

    await db.from('payment_request_activity').insert({
      payment_request_id,
      activity_type: 'notification_sent',
      message: `Emailed ${pr.requester_email}: submission confirmation${attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''}`,
      created_by: userData.user.id,
      company_entity_id: pr.company_entity_id,
    });

    return new Response(JSON.stringify({ ok: true, email_sent: true }), { headers: CORS });
  } catch (err) {
    console.error('[payment-request-submitted-notify]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
