// affiliate-mail.mjs -- the one implementation of how Affiliate Studio sends a
// TRANSACTIONAL email to an affiliate and records what happened.
//
// Shipped as a verbatim copy in BOTH affiliate edge functions
// (affiliate-portal, affiliate-invite) because a cross-directory import would
// show both as permanently drifted in deployment-drift-check.
// scripts/tests/affiliate-edge.test.mjs pins the two copies byte for byte:
// edit affiliate-portal/affiliate-mail.mjs and re-copy it.
//
// Never used for prospect outreach ('signup_invite' is the onboarding invite
// to someone a manager added or who applied -- affiliate-invite INVITE_SOURCES). The `kind` vocabulary below matches the
// CHECK on affiliate_notifications, which has no outreach value; an unknown
// kind is refused before anything is sent.

export const NOTIFICATION_KINDS = new Set([
  'signup_confirmation', 'portal_link', 'codes_and_links', 'payout_status', 'link_renewal',
  'signup_invite', 'seed_code', 'earnings',
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
    // Affiliates see the brand, not SILO (Blake 2026-11-17): "Brand - SILO
    // <x@...>" is sent as "Brand <x@...>". A company's own sender is kept.
    if (row?.from_header) from = String(row.from_header).replace(/^\s*(.+?)\s+-\s+SILO\s*</, '$1 <');
    if (row?.reply_to) replyTo = row.reply_to;
  } catch { /* the message matters more than the header */ }
  let rep = null;
  if (programId) {
    try {
      const { data: prog } = await service.from('affiliate_programs')
        .select('owner_user_id').eq('id', programId).eq('company_entity_id', companyId).maybeSingle();
      if (prog?.owner_user_id) {
        const { data: owner } = await service.from('profiles').select('email, name').eq('id', prog.owner_user_id).maybeSingle();
        if (owner?.email) { replyTo = owner.email; rep = { email: owner.email, name: owner.name || null }; }
      }
    } catch { /* no rep named: the email still goes */ }
  }
  // The brand's logo from Settings -> Company, the same one the rep portal
  // shows (Blake 2026-11-18). Only a company-logos bucket address is used.
  let logoUrl = null;
  try {
    const { data } = await service.from('company_settings').select('logo_url').eq('company_entity_id', companyId).maybeSingle();
    if (typeof data?.logo_url === 'string' && LOGO_RE.test(data.logo_url)) logoUrl = data.logo_url;
  } catch { /* no logo: the brand name stands alone */ }
  return { from, replyTo, rep, logoUrl };
}

export const LOGO_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/company-logos\/[0-9a-f-]{36}\/logo-[0-9]{10,16}\.(png|jpg|jpeg|webp)$/;

/**
 * Fills the two marks renderMail leaves: the brand's logo beside its name at
 * the top, and the sign-off naming the program's rep (Blake 2026-11-18:
 * "reply to the rep of program's email", "use the logo on the sign off").
 * With neither, the marks are simply removed.
 */
export function brandMail({ html, text }, { brand = '', rep = null, logoUrl = null } = {}) {
  const font = MAIL_FONT;
  const logo = logoUrl ? `<td style="padding-right:10px"><img src="${escapeHtml(logoUrl)}" alt="" height="36" style="display:block;height:36px;width:auto;border:0;border-radius:6px"></td>` : '';
  let signoff = '';
  if (rep?.email) {
    const who = rep.name ? escapeHtml(rep.name) : 'Your contact';
    const mark = logoUrl
      ? `<td style="width:48px;vertical-align:middle;padding-right:12px"><img src="${escapeHtml(logoUrl)}" alt="" width="48" style="display:block;width:48px;height:auto;max-height:48px;border:0;border-radius:8px"></td>`
      : `<td style="vertical-align:middle;padding-right:12px"><div style="width:40px;height:40px;border-radius:20px;background:#14181d;color:#fff;font:700 15px/40px ${font};text-align:center">${escapeHtml(String(rep.name || brand || rep.email).trim().charAt(0).toUpperCase())}</div></td>`;
    signoff = `<tr><td style="border-top:1px solid #e6e9ec;padding:18px 32px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${mark}
<td style="vertical-align:middle;font-family:${font}"><div style="font:700 14px/1.3 ${font};color:#14181d">Questions? ${who}</div>
<div style="font:400 13px/1.4 ${font}"><a href="mailto:${escapeHtml(rep.email)}" style="color:#14181d">${escapeHtml(rep.email)}</a> <span style="color:#7b8691">&middot; ${escapeHtml(brand)}</span></div></td></tr></table></td></tr>`;
  }
  return {
    html: String(html).replace('<!--silo:logo-->', logo).replace('<!--silo:signoff-->', signoff),
    text: rep?.email ? `${text}\n\nQuestions? ${rep.name ? `${rep.name}, ` : ''}${rep.email}` : text,
  };
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
  const { companyId, programId = null, affiliateId = null, kind, to, subject, html, text, triggeredBy = null, payoutId = null, idempotencyKey = null } = msg;
  if (!NOTIFICATION_KINDS.has(kind)) throw new Error(`unknown affiliate notification kind ${kind}`);

  const record = async (status, extra = {}) => {
    const { error } = await service.from('affiliate_notifications').insert({
      company_entity_id: companyId, program_id: programId, affiliate_id: affiliateId,
      kind, to_email: to || '(none)', subject, status, triggered_by: triggeredBy,
      // The paid payout a notice announces (20261117030000), so it is sent once.
      ...(payoutId ? { payout_id: payoutId } : {}), ...extra,
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
  const branded = brandMail({ html, text }, { brand: String(sender.from).replace(/\s*<.*$/, '').replace(/^"|"$/g, ''), rep: sender.rep, logoUrl: sender.logoUrl });
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}`,
        // The same message asked for twice (a retry after an unknown outcome) is sent once.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify({ from: sender.from, to: [to], subject, html: branded.html, text: branded.text,
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
export const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MAIL_MONO = "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

// Email-safe (tables, inline styles), so it holds up in Gmail, Outlook and
// Apple Mail. Redesigned 2026-11-18 (Blake: "enhance our design for
// transactional emails"): optional eyebrow, product photo, a code card with a
// terms line, a stats row and pill buttons. The logo and the rep's sign-off
// are filled in at send time by brandMail.
export function renderMail({ brand, heading, eyebrow = '', paragraphs = [], image = null, cta = null, ctas = null,
  code = null, codeNote = '', stats = null, footer = '' }) {
  const font = MAIL_FONT, mono = MAIL_MONO;
  const ink = '#14181d', ink2 = '#4a545e', ink3 = '#7b8691', line = '#e6e9ec';
  // Buttons, never a long address in the text (Blake 2026-11-17). The first is
  // the main one; any others sit beside it, outlined.
  const buttons = (ctas || (cta ? [cta] : [])).filter((b) => b && b.url && b.label);
  const btn = (b, i) => `<a href="${escapeHtml(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:13px 22px;border-radius:999px;font:700 15px/1 ${font};text-decoration:none;${i === 0
    ? `background:${ink};color:#fff;border:1px solid ${ink}` : `background:#fff;color:${ink};border:1px solid #cfd5db`}">${escapeHtml(b.label)}</a>`;
  const img = image && /^https:\/\//.test(String(image.url || ''))
    ? `<tr><td align="center" style="background:#f7f8f9;padding:24px 24px 8px"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt || '')}" width="260" style="display:inline-block;width:260px;max-width:100%;height:auto;border:0"></td></tr>` : '';
  const statRow = Array.isArray(stats) && stats.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;border:1px solid ${line};border-radius:12px"><tr>${stats.map((x, i) => `<td style="padding:16px 18px;${i ? `border-left:1px solid ${line};` : ''}"><div style="font:600 11px/1 ${font};text-transform:uppercase;letter-spacing:.08em;color:${ink3}">${escapeHtml(x.label)}</div><div style="font:700 22px/1.2 ${mono};color:${ink};margin-top:8px">${escapeHtml(x.value)}</div></td>`).join('')}</tr></table>` : '';
  const codeCard = code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 6px"><tr><td align="center" style="background:#f7f8f9;border:2px dashed ${ink};border-radius:14px;padding:20px 12px">
<div style="font:600 11px/1 ${font};text-transform:uppercase;letter-spacing:.12em;color:${ink3};margin-bottom:10px">Your code</div>
<div style="font:700 28px/1.1 ${mono};letter-spacing:.08em;color:${ink};word-break:break-all">${escapeHtml(code)}</div>
${codeNote ? `<div style="font:500 13px/1.4 ${font};color:${ink2};margin-top:10px">${escapeHtml(codeNote)}</div>` : ''}</td></tr></table>` : '';
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f2f3f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><!--silo:logo--><td style="font:800 18px/1 ${font};color:${ink};letter-spacing:-.01em">${escapeHtml(brand)}</td></tr></table></td></tr>
<tr><td style="background:#fff;border:1px solid ${line};border-top:5px solid ${ink};border-radius:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${img}
<tr><td style="padding:28px 32px 30px;font-family:${font};color:${ink}">
${eyebrow ? `<div style="font:700 11px/1 ${mono};letter-spacing:.12em;text-transform:uppercase;color:${ink};margin:0 0 12px">${escapeHtml(eyebrow)}</div>` : ''}
<h1 style="font:800 26px/1.2 ${font};letter-spacing:-.02em;margin:0 0 14px;color:${ink}">${escapeHtml(heading)}</h1>
${paragraphs.map((p) => `<p style="font:400 15px/1.6 ${font};color:${ink2};margin:0 0 12px">${p}</p>`).join('\n')}
${statRow}${codeCard}
${buttons.length ? `<p style="margin:22px 0 0">${buttons.map(btn).join('')}</p>` : ''}
</td></tr>
<!--silo:signoff-->
</table></td></tr>
<tr><td style="padding:18px 8px 0;font:400 12px/1.5 ${font};color:${ink3};text-align:center">${footer}</td></tr>
</table></td></tr></table></body></html>`;
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [heading, '', ...paragraphs.map(strip), ...(code ? ['', `Code: ${code}`, ...(codeNote ? [codeNote] : [])] : []),
    ...(Array.isArray(stats) ? stats.map((x) => `${x.label}: ${x.value}`) : []),
    ...buttons.flatMap((b) => ['', `${b.label}: ${b.url}`]), ...(footer ? ['', strip(footer)] : [])].join('\n');
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
