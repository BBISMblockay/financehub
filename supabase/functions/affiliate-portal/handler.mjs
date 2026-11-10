// affiliate-portal -- the affiliate-facing side of Affiliate Studio.
//
// NO SILO LOGIN. The caller is an affiliate or an applicant, never a workspace
// member, and the authorization is the link token in the request body: it is
// hashed here and the hash is the only thing the database ever sees. The
// request's own Authorization header is the project anon key (what a public
// page sends) and is never read as an identity.
//
// Every database call goes through a SECURITY DEFINER function granted to the
// service role only (20261110086000), each of which re-checks the token, its
// expiry and its revocation itself. Nothing here builds a query from a
// company id or affiliate id taken from the body -- the token decides both.
// The one exception is `apply`, which names a company and a program slug in
// the public URL: that is not authorization, and affiliate_portal_apply()
// refuses unless the program is active AND open to applications, with the
// same message either way so the form cannot probe which programs exist.
//
// Actions:
//   resolve   { token }                       -> brand, program terms, rate, status
//   accept    { token, signed_name, terms_version, platform_terms_version?, contact_name? }
//                                             -> activates; mails a portal link
//   statement { token }                       -> earnings summary, codes, links, payouts
//   renew     { token }                       -> expired portal link: mail a new one
//                                                to the address ON FILE
//   apply     { company_id, program, email, name, platform?, handle?, profile_url?, pitch?, website? }
//                                             -> open intake: creates a PROSPECT
import { sha256hex, randomToken, sendAffiliateMail, renderMail, escapeHtml, formatMoney } from './affiliate-mail.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

export const PORTAL_LINK_DAYS = 90;
// The SILO platform terms every affiliate accepts with the brand's program
// terms (/legal/affiliate-terms.html, whose meta tag carries the same number;
// scripts/tests/affiliate-edge.test.mjs pins the two). Bump both together.
export const PLATFORM_TERMS_VERSION = 1;
const MAX_BODY = 16 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

// A database refusal becomes a message a person can act on, without leaking
// internals. Our own functions raise with a "fn_name: " prefix; strip it.
function dbError(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '').replace(/^[a-z_]+:\s*/, '');
  if (code === '42501') return reply({ error: msg || 'Not permitted' }, 403);
  if (code === '40001') return reply({ error: msg, code: 'terms_changed' }, 409);
  if (code === '54000') return reply({ error: msg }, 429);
  if (code === 'P0001' || code === '23505' || code === '23514' || code === '22023') return reply({ error: msg }, 400);
  console.error('[affiliate-portal] database error', code, error?.message);
  return reply({ error: 'Something went wrong. Please try again.' }, 500);
}

const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// The company's logo (Settings -> Company, 20261110140000): the same shape the
// company_settings CHECK enforces, re-checked here so the page only ever gets
// an image in a Supabase company-logos bucket.
const LOGO_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/company-logos\/[0-9a-f-]{36}\/logo-[0-9]{10,16}\.(png|jpg|jpeg|webp)$/;

// Affiliate links (20261110150000): the brand's own store, through Shopify's
// /discount/CODE address so the affiliate's code is applied at checkout, then
// on to the page. The UTMs ride inside the redirect so they reach the landing
// page. Commission still comes only from the code on the order, so a click on
// a link can never credit an order twice.
const STORE_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PATH_RE = /^\/[A-Za-z0-9/_.~%-]*$/;
const IMAGE_RE = /^https:\/\/[^\s"'<>]+$/;
export function affiliateLink(store, code, path = '/') {
  if (!STORE_RE.test(String(store || '')) || !code) return null;
  const p = PATH_RE.test(String(path || '')) && !String(path).startsWith('//') ? path : '/';
  const q = new URLSearchParams({ utm_source: 'affiliate', utm_medium: 'affiliate', utm_campaign: String(code) });
  return `${store}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`${p}?${q}`)}`;
}

export function createPortalHandler({ service, siteUrl, resendKey, fetchImpl = fetch, now = () => new Date(), makeToken = randomToken, log = console.log }) {
  const portalUrl = (raw) => `${siteUrl.replace(/\/$/, '')}/v2/affiliates/portal.html?t=${encodeURIComponent(raw)}`;

  async function mintPortalLink(subject) {
    const raw = makeToken();
    const expires = new Date(now().getTime() + PORTAL_LINK_DAYS * 86400000).toISOString();
    const { error } = await service.rpc('affiliate_issue_access_token', {
      p_company_entity_id: subject.company_entity_id, p_program_id: subject.program_id,
      p_purpose: 'portal', p_token_hash: await sha256hex(raw), p_expires_at: expires,
      p_affiliate_id: subject.affiliate_id, p_prospect_id: null, p_created_by: null,
    });
    if (error) throw Object.assign(new Error(error.message), { db: error });
    return { url: portalUrl(raw), expires_at: expires };
  }

  // Fail-soft: no logo, an unapplied migration or a read error all mean the
  // page shows the initial badge, never an error.
  async function brandLogo(companyId) {
    try {
      const { data, error } = await service.from('company_settings').select('logo_url')
        .eq('company_entity_id', companyId).maybeSingle();
      const u = error ? null : data?.logo_url;
      return typeof u === 'string' && LOGO_RE.test(u) ? u : null;
    } catch { return null; }
  }

  // The portal feed: what the program shared, each with this affiliate's own
  // link. Fail-soft: an unapplied migration or a read error is "no feed".
  async function portalFeed(hash) {
    try {
      const { data, error } = await service.rpc('affiliate_portal_feed', { p_token_hash: hash });
      if (error || !data || typeof data !== 'object') return null;
      const code = Array.isArray(data.codes) && data.codes.length ? String(data.codes[0]) : null;
      const store = STORE_RE.test(String(data.store_url || '')) ? data.store_url : null;
      return {
        code,
        store_link: affiliateLink(store, code, '/'),
        items: (Array.isArray(data.items) ? data.items : []).map((i) => ({
          kind: i.kind, title: i.title, note: i.note ?? null, event_on: i.event_on ?? null,
          image_url: IMAGE_RE.test(String(i.image_url || '')) ? i.image_url : null,
          link: i.product_path ? affiliateLink(store, code, i.product_path) : null,
        })),
      };
    } catch { return null; }
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply({ error: 'Request too large' }, 413);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const action = body?.action;

    // ── open applications: no token, a public program ────────────────────
    if (action === 'apply') {
      // A honeypot field real people never see. A bot that fills it gets the
      // same answer as a person, and nothing is written.
      if (body.website) return reply({ status: 'received' });
      if (!UUID_RE.test(String(body.company_id || ''))) return reply({ error: 'Invalid link' }, 400);
      const { data, error } = await service.rpc('affiliate_portal_apply', {
        p_company_entity_id: body.company_id,
        p_program_slug: clip(body.program, 40),
        p_email: clip(body.email, 254),
        p_display_name: clip(body.name, 120),
        p_platform: clip(body.platform, 20) || 'web',
        p_handle: clip(body.handle, 80),
        p_profile_url: clip(body.profile_url, 500),
        p_pitch: clip(body.pitch, 2000),
      });
      if (error) return dbError(error);
      return reply({ status: data?.status || 'received' });
    }

    const token = String(body?.token || '');
    if (!TOKEN_RE.test(token)) return reply({ error: 'This link is not valid.' }, 400);
    const hash = await sha256hex(token);

    if (action === 'renew') {
      const { data, error } = await service.rpc('affiliate_portal_renew_subject', { p_token_hash: hash });
      if (error) return dbError(error);
      const subject = Array.isArray(data) ? data[0] : null;
      // The same answer whether or not the link was renewable: this endpoint
      // must not confirm which old links belong to real affiliates.
      const generic = reply({ status: 'sent_if_eligible', message: 'If this link belongs to an active affiliate, a new one is on its way to the address on file.' });
      if (!subject) return generic;
      try {
        const link = await mintPortalLink(subject);
        const { data: co } = await service.from('entities').select('title').eq('id', subject.company_entity_id).maybeSingle();
        const brand = co?.title || 'Affiliate program';
        const { html, text } = renderMail({
          brand, heading: 'Your new affiliate portal link',
          paragraphs: [`Hi ${escapeHtml(subject.display_name)}, here is a fresh link to your ${escapeHtml(brand)} affiliate portal. It works for ${PORTAL_LINK_DAYS} days.`],
          cta: { url: link.url, label: 'Open my portal' },
          footer: 'You asked for this because an older link had expired. If you did not, you can ignore this email.',
        });
        await sendAffiliateMail({ service, resendKey, fetchImpl }, {
          companyId: subject.company_entity_id, programId: subject.program_id, affiliateId: subject.affiliate_id,
          kind: 'link_renewal', to: subject.contact_email, subject: `${brand}: your affiliate portal link`, html, text,
        });
      } catch (err) {
        console.error('[affiliate-portal] renew failed', err?.message);
      }
      return generic;
    }

    const { data: rows, error: rErr } = await service.rpc('affiliate_portal_resolve', { p_token_hash: hash });
    if (rErr) return dbError(rErr);
    const t = Array.isArray(rows) ? rows[0] : null;
    if (!t) return reply({ error: 'This link has expired or is no longer valid.', code: 'invalid_link' }, 404);
    await service.rpc('affiliate_portal_touch_token', { p_token_hash: hash });

    if (action === 'resolve') {
      return reply({
        purpose: t.purpose,
        brand: t.company_title,
        brand_logo: await brandLogo(t.company_entity_id),
        program: { name: t.program_name, status: t.program_status, terms_markdown: t.terms_markdown,
          terms_version: t.terms_version, currency: t.currency,
          commission: { kind: t.commission_kind, percent: t.commission_percent, fixed_cents: t.commission_fixed_cents } },
        affiliate: t.affiliate_id ? { display_name: t.affiliate_display_name, status: t.affiliate_status,
          terms_version_accepted: t.terms_version_accepted, terms_accepted_at: t.terms_accepted_at } : null,
        expires_at: t.expires_at,
      });
    }

    if (action === 'accept') {
      if (t.purpose !== 'signup') return reply({ error: 'This link is for the portal, not for signing up.' }, 400);
      const signed = clip(body.signed_name, 120);
      if (!signed) return reply({ error: 'Type your full name to accept.' }, 400);
      // A page that showed the platform terms sends their version; one that
      // showed an older version is asked to reload. A page from before the
      // platform terms existed sends none, and the record says so (null).
      const platformVersion = body.platform_terms_version == null ? null : Number(body.platform_terms_version);
      if (platformVersion !== null && platformVersion !== PLATFORM_TERMS_VERSION) {
        return reply({ error: 'The platform terms were updated. Reload the page to read the current version.', code: 'terms_changed' }, 409);
      }
      const acceptance = {
        platform_terms_version: platformVersion,
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
        user_agent: clip(req.headers.get('user-agent'), 300),
        // The exact text that was on screen, so "which terms did they accept"
        // is answerable even after the program's terms are edited again.
        terms_sha256: await sha256hex(String(t.terms_markdown ?? '')),
      };
      const { data: res, error } = await service.rpc('affiliate_portal_accept_terms', {
        p_token_hash: hash, p_signed_name: signed, p_terms_version: Number(body.terms_version),
        p_acceptance: acceptance, p_contact_name: clip(body.contact_name, 120), p_payout_note: null,
      });
      if (error) return dbError(error);

      // The terms are accepted whatever happens next; the link and the mail
      // are a convenience on top, and each failure is reported, not hidden.
      let link = null;
      let mail = null;
      try {
        link = await mintPortalLink({ company_entity_id: t.company_entity_id, program_id: t.program_id, affiliate_id: t.affiliate_id });
        const { html, text } = renderMail({
          brand: t.company_title,
          heading: `You're in: ${t.program_name}`,
          paragraphs: [
            `Hi ${escapeHtml(t.affiliate_display_name || signed)}, thanks for joining the ${escapeHtml(t.company_title)} affiliate program. You accepted version ${Number(res?.terms_version)} of the program terms.`,
            'Your portal shows your codes, links, earnings and payouts. Keep this email: the link below is personal to you.',
          ],
          cta: { url: link.url, label: 'Open my affiliate portal' },
          footer: `This link works for ${PORTAL_LINK_DAYS} days; the portal can send you a fresh one after that.`,
        });
        mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, {
          companyId: t.company_entity_id, programId: t.program_id, affiliateId: t.affiliate_id,
          kind: 'signup_confirmation', to: t.affiliate_contact_email,
          subject: `${t.company_title}: welcome to the affiliate program`, html, text,
        });
      } catch (err) {
        log('[affiliate-portal] post-acceptance link/mail failed', err?.message);
      }
      return reply({ status: res?.status || 'active', already_accepted: !!res?.already_accepted,
        portal_url: link?.url ?? null, confirmation_email: mail?.status ?? 'not_sent' });
    }

    if (action === 'statement') {
      if (t.purpose !== 'portal') return reply({ error: 'Finish signing up first.' }, 400);
      const { data, error } = await service.rpc('affiliate_portal_statement', { p_token_hash: hash });
      if (error) return dbError(error);
      return reply({ brand: t.company_title, brand_logo: await brandLogo(t.company_entity_id), program: t.program_name, statement: data,
        feed: await portalFeed(hash),
        formatted: { earned: formatMoney(data?.totals?.earned_cents, data?.currency) } });
    }

    return reply({ error: `Unknown action ${action}` }, 400);
  };
}
