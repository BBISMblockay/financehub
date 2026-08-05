// payment-request-forward-melio — emails a payment request's submitted
// invoice/document to the company's Melio bill-pay forwarding inbox so
// Melio's AI can auto-draft the bill. Auth: caller must pass
// current_user_can_manage_payment_requests() (same gate as
// payment-request-notify). Idempotent to call repeatedly — each call
// re-sends and logs a fresh forwarded_to_melio activity row, so AP can
// re-forward if Melio's draft needs to be redone.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const MELIO_FORWARD_EMAIL = Deno.env.get('MELIO_FORWARD_EMAIL') || '';
const FROM = 'SILO <noreply@silo-baseballism.com>';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const BUCKET = 'payment-request-files';
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

type EmailAttachment = { filename: string; content: string };

function money(n: number | null): string {
  if (n == null) return '$0.00';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function isExternalFileLocation(value: string | null): boolean {
  const text = (value || '').trim();
  if (!text) return false;
  return /^https?:\/\//i.test(text) || /^(www\.)?jotform\.com\//i.test(text);
}

function normalizeExternalUrl(value: string | null): string | null {
  const text = (value || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(www\.)?jotform\.com\//i.test(text)) return `https://${text.replace(/^\/\//, '')}`;
  return text;
}

async function sendEmail(to: string, subject: string, html: string, attachments?: EmailAttachment[], replyTo?: string | null): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const body: Record<string, unknown> = { from: FROM, to: [to], subject, html };
  if (attachments?.length) body.attachments = attachments;
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('[payment-request-forward-melio] resend error', res.status, await res.text());
  return res.ok;
}

// Submitted documents (the source invoice) live outside the
// {requestId}/confirmation/ prefix — the inverse of
// fetchConfirmationAttachments() in payment-request-notify. Legacy rows
// with no payment_request_files entries fall back to the single
// file_path/file_url columns on payment_requests itself (matches
// filesForRequest() in v2/request_manager.html). External links
// (Jotform-era imports) can't be downloaded server-side, so those are
// surfaced as a link in the email body instead of an attachment.
async function fetchSubmittedAttachments(paymentRequestId: string, pr: Record<string, unknown>): Promise<{ attachments: EmailAttachment[]; externalLinks: string[] }> {
  const { data: files } = await db
    .from('payment_request_files')
    .select('file_name, file_path, file_url')
    .eq('payment_request_id', paymentRequestId)
    .not('file_path', 'like', '%/confirmation/%');

  const candidates = (files?.length ? files : (pr.file_path || pr.file_url ? [{ file_name: pr.file_name, file_path: pr.file_path, file_url: pr.file_url }] : [])) as
    { file_name: string | null; file_path: string | null; file_url: string | null }[];

  const attachments: EmailAttachment[] = [];
  const externalLinks: string[] = [];

  for (const file of candidates) {
    const externalUrl = normalizeExternalUrl(file.file_url) && isExternalFileLocation(file.file_url)
      ? normalizeExternalUrl(file.file_url)
      : (isExternalFileLocation(file.file_path) ? normalizeExternalUrl(file.file_path) : null);

    if (externalUrl) {
      externalLinks.push(externalUrl);
      continue;
    }
    if (!file.file_path) continue;

    const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(file.file_path);
    if (dlErr || !blob) {
      console.error('[payment-request-forward-melio] failed to download submitted file', file.file_path, dlErr);
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      console.error('[payment-request-forward-melio] submitted file too large to attach', file.file_path, bytes.byteLength);
      continue;
    }
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    attachments.push({ filename: file.file_name || 'invoice-document', content: btoa(binary) });
  }

  return { attachments, externalLinks };
}

function emailHtml(opts: {
  vendorName: string;
  amount: number | null;
  invoiceNumber: string | null;
  dueDate: string | null;
  poNumber: string | null;
  attachmentCount: number;
  externalLinks: string[];
}): string {
  const { vendorName, amount, invoiceNumber, dueDate, poNumber, attachmentCount, externalLinks } = opts;
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Payment request forwarded for bill pay</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        Forwarded from SILO Accounts Payable for <strong style="color:#fff">${vendorName}</strong>${invoiceNumber ? ` (invoice ${invoiceNumber})` : ''}.
        ${attachmentCount ? `${attachmentCount} document${attachmentCount > 1 ? 's are' : ' is'} attached.` : 'No downloadable attachment was found on this request.'}
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Amount due</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right;font-family:monospace">${money(amount)}</td>
        </tr>
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Due date</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${formatDate(dueDate)}</td>
        </tr>
        ${poNumber ? `
        <tr>
          <td style="color:#7f8b96;font-size:12px;padding:6px 0;border-top:1px solid #2a2f36">Internal PO #</td>
          <td style="color:#fff;font-size:13px;padding:6px 0;border-top:1px solid #2a2f36;text-align:right">${poNumber}</td>
        </tr>` : ''}
      </table>
      ${externalLinks.length ? `
      <p style="color:#7f8b96;font-size:12px;margin-top:16px">
        Legacy attachment${externalLinks.length > 1 ? 's' : ''} could not be attached automatically — open in SILO Request Manager instead:<br/>
        ${externalLinks.map(l => `<a href="${l}" style="color:#8fb4ff">${l}</a>`).join('<br/>')}
      </p>` : ''}
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

    if (!MELIO_FORWARD_EMAIL) {
      return new Response(JSON.stringify({ error: 'MELIO_FORWARD_EMAIL not configured' }), { status: 500, headers: CORS });
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
      return new Response(JSON.stringify({ error: 'Not authorized to forward payment requests' }), { status: 403, headers: CORS });
    }

    const { data: pr, error: prErr } = await db
      .from('payment_requests')
      .select('*')
      .eq('id', payment_request_id)
      .single();
    if (prErr || !pr) {
      return new Response(JSON.stringify({ error: 'Payment request not found' }), { status: 404, headers: CORS });
    }

    const vendorName = pr.vendor_name_manual || pr.vendor_name || 'Vendor';
    const { attachments, externalLinks } = await fetchSubmittedAttachments(payment_request_id, pr);

    if (!attachments.length && !externalLinks.length) {
      return new Response(JSON.stringify({ error: 'No submitted document on this request to forward' }), { status: 400, headers: CORS });
    }

    const emailSent = await sendEmail(
      MELIO_FORWARD_EMAIL,
      `${vendorName}${pr.invoice_number ? ` — Invoice ${pr.invoice_number}` : ''} — ${money(pr.amount_due)}`,
      emailHtml({
        vendorName,
        amount: pr.amount_due,
        invoiceNumber: pr.invoice_number,
        dueDate: pr.due_date,
        poNumber: pr.internal_po_number,
        attachmentCount: attachments.length,
        externalLinks,
      }),
      attachments,
      pr.requester_email || null,
    );

    if (!emailSent) {
      return new Response(
        JSON.stringify({ error: RESEND_KEY ? 'Email send failed' : 'RESEND_API_KEY not configured' }),
        { status: 502, headers: CORS },
      );
    }

    const now = new Date().toISOString();
    await db.from('payment_requests')
      .update({ melio_forwarded_at: now, melio_forwarded_by: userData.user.id })
      .eq('id', payment_request_id);

    await db.from('payment_request_activity').insert({
      payment_request_id,
      activity_type: 'forwarded_to_melio',
      message: `Forwarded to Melio (${MELIO_FORWARD_EMAIL}) with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}${externalLinks.length ? ` and ${externalLinks.length} external link${externalLinks.length === 1 ? '' : 's'}` : ''}`,
      created_by: userData.user.id,
      company_entity_id: pr.company_entity_id,
    });

    return new Response(JSON.stringify({ ok: true, email_sent: true, sent_at: now, attachment_count: attachments.length }), { headers: CORS });
  } catch (err) {
    console.error('[payment-request-forward-melio]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500, headers: CORS });
  }
});
