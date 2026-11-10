// affiliate-mail.mjs -- the one implementation of how Affiliate Studio sends a
// TRANSACTIONAL email to an affiliate and records what happened.
//
// Shipped as a verbatim copy in BOTH affiliate edge functions
// (affiliate-portal, affiliate-invite) because a cross-directory import would
// show both as permanently drifted in deployment-drift-check.
// scripts/tests/affiliate-edge.test.mjs pins the two copies byte for byte:
// edit affiliate-portal/affiliate-mail.mjs and re-copy it.
//
// Never used for prospect outreach. The `kind` vocabulary below matches the
// CHECK on affiliate_notifications, which has no outreach value; an unknown
// kind is refused before anything is sent.

export const NOTIFICATION_KINDS = new Set([
  'signup_confirmation', 'portal_link', 'codes_and_links', 'payout_status', 'link_renewal',
]);

const encoder = new TextEncoder();

/** Hex SHA-256, the only form a link token is ever stored in. */
export async function sha256hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url. The raw token exists only in the link. */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatMoney(cents, currency) {
  const code = String(currency || 'USD').toUpperCase();
  const zero = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'].includes(code);
  const major = Number(cents || 0) / (zero ? 1 : 100);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(major); }
  catch { return `${major.toFixed(zero ? 0 : 2)} ${code}`; }
}

/**
 * Who the mail is from and where a reply goes. From is the tenant's name on
 * SILO's authenticated sending address (resolve_notification_sender); Reply-To
 * is the program's DESIGNATED EMPLOYEE when one is set, because that is the
 * person the affiliate is working with -- falling back to the tenant's
 * general-ops contact, and never to a SILO mailbox.
 */
export async function resolveAffiliateSender(service, { companyId, programId, fallbackFrom }) {
  let from = fallbackFrom;
  let replyTo = null;
  try {
    const { data } = await service.rpc('resolve_notification_sender', {
      p_company_entity_id: companyId, p_purpose: 'general_ops', p_actor_email: null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.from_header) from = row.from_header;
    if (row?.reply_to) replyTo = row.reply_to;
  } catch { /* the message matters more than the header */ }
  if (programId) {
    const { data: prog } = await service.from('affiliate_programs')
      .select('owner_user_id').eq('id', programId).eq('company_entity_id', companyId).maybeSingle();
    if (prog?.owner_user_id) {
      const { data: owner } = await service.from('profiles').select('email').eq('id', prog.owner_user_id).maybeSingle();
      if (owner?.email) replyTo = owner.email;
    }
  }
  return { from, replyTo };
}

/**
 * Send one transactional email and record the outcome. Never throws for a
 * delivery problem: the caller's action (accepting terms, minting a link) has
 * already succeeded, and the record says whether the mail did.
 *
 * Checks the suppression list first -- an affiliate who complained or asked
 * to stop is not mailed even transactionally -- and records a skip.
 */
export async function sendAffiliateMail(deps, msg) {
  const { service, resendKey, fetchImpl = fetch, fallbackFrom = 'SILO <notifications@get-silo.com>' } = deps;
  const { companyId, programId = null, affiliateId = null, kind, to, subject, html, text, triggeredBy = null } = msg;
  if (!NOTIFICATION_KINDS.has(kind)) throw new Error(`unknown affiliate notification kind ${kind}`);

  const record = async (status, extra = {}) => {
    const { error } = await service.from('affiliate_notifications').insert({
      company_entity_id: companyId, program_id: programId, affiliate_id: affiliateId,
      kind, to_email: to || '(none)', subject, status, triggered_by: triggeredBy, ...extra,
    });
    if (error) console.error('[affiliate-mail] could not record delivery result', error.message);
    return { status, ...extra };
  };

  if (!to || !String(to).includes('@')) return record('skipped', { reason: 'no address on file' });

  const { data: allowed, error: supErr } = await service.rpc('affiliate_outreach_can_contact', {
    p_company_entity_id: companyId, p_program_id: programId, p_email: to, p_handle: null, p_profile_url: null,
  });
  if (supErr) return record('skipped', { reason: `suppression check failed: ${supErr.message}` });
  if (allowed !== true) return record('skipped', { reason: 'address is on the suppression list' });

  if (!resendKey) return record('skipped', { reason: 'RESEND_API_KEY not set' });

  const sender = await resolveAffiliateSender(service, { companyId, programId, fallbackFrom });
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: sender.from, to: [to], subject, html, text,
        ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return record('failed', { reason: `resend ${res.status}: ${String(body?.message || '').slice(0, 200)}` });
    return record('sent', { provider_message_id: body?.id ?? null });
  } catch (err) {
    return record('failed', { reason: String(err?.message || err).slice(0, 200) });
  }
}

/** A minimal, brand-neutral layout. The tenant's name comes from data. */
export function renderMail({ brand, heading, paragraphs = [], cta = null, footer = '' }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f8;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#14181d">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
<div style="font-weight:800;font-size:15px;margin-bottom:16px">${escapeHtml(brand)}</div>
<div style="background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:22px">
<h1 style="font-size:19px;margin:0 0 12px">${escapeHtml(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:14px;line-height:1.55;margin:0 0 12px">${p}</p>`).join('\n')}
${cta ? `<p style="margin:18px 0 4px"><a href="${escapeHtml(cta.url)}" style="background:#14181d;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px">${escapeHtml(cta.label)}</a></p>` : ''}
</div>
<p style="font-size:12px;color:#77828d;margin-top:14px;line-height:1.5">${footer}</p>
</div></body></html>`;
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [heading, '', ...paragraphs.map(strip), ...(cta ? ['', `${cta.label}: ${cta.url}`] : []), '', strip(footer)].join('\n');
  return { html, text };
}

// ── Affiliate links ───────────────────────────────────────────────────────
// The brand's own store, through Shopify's /discount/CODE address so the
// affiliate's code is applied at checkout, then on to the page. The UTMs ride
// inside the redirect so they reach the landing page. Commission still comes
// only from the code on the order, so a click on a link can never credit an
// order twice. (20261110150000; shared with affiliate-invite 20261110160000.)
export const STORE_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PATH_RE = /^\/[A-Za-z0-9/_.~%-]*$/;
export function affiliateLink(store, code, path = '/', query = '', hash = '') {
  if (!STORE_RE.test(String(store || '')) || !code) return null;
  const p = PATH_RE.test(String(path || '')) && !String(path).startsWith('//') ? path : '/';
  // The page's own query (a variant, a search) is kept; the UTMs are merged in.
  const q = new URLSearchParams(String(query || ''));
  for (const [k, v] of [['utm_source', 'affiliate'], ['utm_medium', 'affiliate'], ['utm_campaign', String(code)]]) q.set(k, v);
  const h = /^#[A-Za-z0-9_.~%=&-]*$/.test(String(hash || '')) ? hash : '';
  return `${store}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`${p}?${q}${h}`)}`;
}

// A page someone typed as a full address, turned into the affiliate's link
// when it is on the brand's own store (www. or not); null otherwise, so the
// caller keeps the plain address rather than sending it through the store.
export function storeLinkFor(store, code, url) {
  if (!STORE_RE.test(String(store || '')) || !code) return null;
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  const bare = (h) => String(h).toLowerCase().replace(/^www\./, '');
  if (u.protocol !== 'https:' || bare(u.hostname) !== bare(new URL(store).hostname)) return null;
  return affiliateLink(store, code, u.pathname || '/', u.search, u.hash);
}
