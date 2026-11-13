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
//   signin    { email }                       -> mail a portal link to that address if it is an affiliate's
//                                                to the address ON FILE
//   apply     { company_id, program, email, name, platform?, handle?, profile_url?, pitch?, website? }
//                                             -> open intake: creates a PROSPECT
//   brands    { token }                       -> the other brands this rep's email reps, for the menu
//   switch    { token, affiliate_id }         -> a fresh portal token for one of them
//   photo     { token, image } | { token, remove: true }
//                                             -> the rep sets (a JPEG the page made) or removes their photo
import { sha256hex, randomToken, sendAffiliateMail, renderMail, escapeHtml, formatMoney, affiliateLink, storeLinkFor, STORE_RE } from './affiliate-mail.mjs';

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
// A rep's photo: the page crops and re-encodes it as a small JPEG first, so a
// real one is tens of KB. Only the `photo` action may send a body this large.
export const PHOTO_MAX_BYTES = 300_000;
const MAX_PHOTO_BODY = 420 * 1024;
export const PHOTO_BUCKET = 'affiliate-feed-images';
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

// Affiliate links: affiliateLink / storeLinkFor live in affiliate-mail.mjs so the
// codes email (affiliate-invite) builds exactly the same links.
const IMAGE_RE = /^https:\/\/[^\s"'<>]+$/;
const PHOTO_RE = /^https:\/\/[^\s"'<>()\\]+$/;
// The storage path of a photo this rep uploaded, from its saved address, or
// null for anything else (the found photo, another folder, a foreign host).
function ownPhotoPath(url, folder) {
  const m = String(url || '').match(/\/storage\/v1\/object\/public\/affiliate-feed-images\/([^?#]+)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  return path.startsWith(`${folder}-`) && !path.includes('..') && path.endsWith('.jpg') ? path : null;
}
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
function fromBase64(v) {
  const t = String(v || '').replace(/^data:image\/jpeg;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  try { return Uint8Array.from(atob(t), (c) => c.charCodeAt(0)); } catch { return null; }
}
export { affiliateLink };

export function createPortalHandler({ service, siteUrl, resendKey, fetchImpl = fetch, now = () => new Date(), makeToken = randomToken, log = console.log }) {
  const portalUrl = (raw) => `${siteUrl.replace(/\/$/, '')}/v2/affiliates/portal.html?t=${encodeURIComponent(raw)}`;

  // `mailed` says the raw token will go ONLY to the address this mints it for
  // and is never returned to whoever asked -- true for sign-in and renewal.
  // The database then binds the token to that recipient (mailed_to_hash,
  // 20261110190000), and only a bound token may list or switch brands: a
  // staff-issued portal link and the one signup acceptance returns are held
  // by their requester, not by the mailbox. The address passed is the one
  // this function is about to mail to, and the database refuses if it is no
  // longer the affiliate's, so an edit racing the mint aborts it rather than
  // binding a token to an address the mail did not reach.
  async function mintPortalLink(subject, { mailed = false } = {}) {
    const raw = makeToken();
    const expires = new Date(now().getTime() + PORTAL_LINK_DAYS * 86400000).toISOString();
    const { error } = mailed
      ? await service.rpc('affiliate_portal_issue_mailed_token', {
        p_company_entity_id: subject.company_entity_id, p_program_id: subject.program_id,
        p_affiliate_id: subject.affiliate_id, p_token_hash: await sha256hex(raw), p_expires_at: expires,
        p_mailed_to: subject.contact_email,
      })
      : await service.rpc('affiliate_issue_access_token', {
        p_company_entity_id: subject.company_entity_id, p_program_id: subject.program_id,
        p_purpose: 'portal', p_token_hash: await sha256hex(raw), p_expires_at: expires,
        p_affiliate_id: subject.affiliate_id, p_prospect_id: null, p_created_by: null,
      });
    if (error) throw Object.assign(new Error(error.message), { db: error });
    return { url: portalUrl(raw), raw, expires_at: expires };
  }

  // Mails a fresh portal link to the affiliate's address ON FILE, never one
  // from the request. Failures are logged, not returned: callers answer the
  // same either way.
  async function mailPortalLink(subject, kind, footer) {
    try {
      const link = await mintPortalLink(subject, { mailed: true });
      const { data: co } = await service.from('entities').select('title').eq('id', subject.company_entity_id).maybeSingle();
      const brand = co?.title || 'Affiliate program';
      const { html, text } = renderMail({
        brand, heading: 'Your affiliate portal link',
        paragraphs: [`Hi ${escapeHtml(subject.display_name)}, here is your link to the ${escapeHtml(brand)} affiliate portal. It works for ${PORTAL_LINK_DAYS} days.`],
        cta: { url: link.url, label: 'Open my portal' },
        footer,
      });
      await sendAffiliateMail({ service, resendKey, fetchImpl }, {
        companyId: subject.company_entity_id, programId: subject.program_id, affiliateId: subject.affiliate_id,
        kind, to: subject.contact_email, subject: `${brand}: your affiliate portal link`, html, text,
      });
    } catch (err) {
      console.error(`[affiliate-portal] ${kind} failed`, err?.message);
    }
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
        store,
        store_link: affiliateLink(store, code, '/'),
        items: (Array.isArray(data.items) ? data.items : []).map((i) => ({
          kind: i.kind, title: i.title, note: i.note ?? null, event_on: i.event_on ?? null,
          image_url: IMAGE_RE.test(String(i.image_url || '')) ? i.image_url : null,
          link: i.product_path ? affiliateLink(store, code, i.product_path) : null,
        })),
      };
    } catch { return null; }
  }

  // The photo a card shows for this rep: none if they removed it, else their
  // own, else the one SILO found for them as a prospect (20261111020000).
  // Fail-soft: an unapplied migration or a read error is "no photo".
  async function repPhoto(t) {
    try {
      const { data: a, error } = await service.from('affiliates').select('photo_url, photo_hidden, from_prospect_id')
        .eq('id', t.affiliate_id).eq('company_entity_id', t.company_entity_id).maybeSingle();
      if (error || !a || a.photo_hidden === true) return { url: null, own: false };
      if (PHOTO_RE.test(String(a.photo_url || ''))) return { url: a.photo_url, own: true };
      if (!a.from_prospect_id) return { url: null, own: false };
      const { data: p } = await service.from('affiliate_prospects').select('evidence')
        .eq('id', a.from_prospect_id).eq('company_entity_id', t.company_entity_id).maybeSingle();
      const found = p?.evidence?.profile_image_url;
      return { url: p?.evidence?.profile_image_stored === true && PHOTO_RE.test(String(found || '')) ? found : null, own: false };
    } catch { return { url: null, own: false }; }
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

    const raw = await req.text();
    if (raw.length > MAX_PHOTO_BODY) return reply({ error: 'Request too large' }, 413);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const action = body?.action;
    if (action !== 'photo' && raw.length > MAX_BODY) return reply({ error: 'Request too large' }, 413);

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

    // ── sign in by email: no token ───────────────────────────────────────
    // The link always goes to the address on file, which is the address
    // typed, so a stranger can only make an affiliate's own inbox receive
    // their own link -- at most once per 10 minutes (the database decides).
    // The answer never says whether the address belongs to an affiliate.
    if (action === 'signin') {
      // The cooldown is named here because a silent drop reads as a bug: a
      // second request inside ten minutes is answered exactly like the first
      // and sends nothing. Saying so reveals nothing new -- the sentence is
      // the same whether or not the address belongs to an affiliate.
      const generic = reply({ status: 'sent_if_eligible', message: 'If that email belongs to an affiliate, a sign-in link is on its way. We send one every 10 minutes, so if you just asked, use the link already in your inbox.' });
      const email = String(clip(body?.email, 254) || '').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ error: 'Enter the email you signed up with.' }, 400);
      const { data, error } = await service.rpc('affiliate_portal_signin_subjects', { p_email: email });
      if (error) { console.error('[affiliate-portal] signin lookup failed', error.message); return generic; }
      for (const subject of (Array.isArray(data) ? data : []).slice(0, 10)) {
        await mailPortalLink(subject, 'portal_link', 'Someone asked to sign in to this portal with your email. If it was not you, you can ignore this email.');
      }
      return generic;
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
      await mailPortalLink(subject, 'link_renewal', 'You asked for this because an older link had expired. If you did not, you can ignore this email.');
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

    // ── one rep, several brands ──────────────────────────────────────────
    // Neither action decides anything here. The database (20261110190000)
    // answers only for a token bound to the address it was mailed to whose
    // affiliate STILL carries that address, and matches records on that bound
    // recipient rather than on today's contact_email, which a manager of a
    // company may edit. A staff-issued portal link and the one signup
    // acceptance returns are never bound, so they stay inside their one
    // company.
    if (action === 'brands' || action === 'switch') {
      if (t.purpose !== 'portal') return reply({ brands: [] });

      if (action === 'brands') {
        const { data, error } = await service.rpc('affiliate_portal_brands', { p_token_hash: hash });
        if (error) return dbError(error);
        // Names for a menu. Nothing of another brand's data travels with it.
        return reply({
          brands: await Promise.all((Array.isArray(data) ? data : []).map(async (b) => ({
            affiliate_id: b.affiliate_id,
            brand: b.company_title,
            brand_logo: await brandLogo(b.company_entity_id),
            program: b.program_name,
            is_current: b.is_current === true,
          }))),
        });
      }

      const wanted = String(body?.affiliate_id || '');
      if (!UUID_RE.test(wanted)) return reply({ error: 'Pick a brand from the list.' }, 400);
      // Mints without mailing, inheriting the binding: the session this
      // descends from reached the mailbox and the same person is switching
      // inside it, so a second switch must work too. The mint revokes only
      // that affiliate's own unused links, so an unopened portal email for
      // this brand is replaced by the session being opened now -- the "one
      // live link per subject" rule every other path follows.
      const raw = makeToken();
      const expires = new Date(now().getTime() + PORTAL_LINK_DAYS * 86400000).toISOString();
      const { error } = await service.rpc('affiliate_portal_switch_token', {
        p_token_hash: hash, p_affiliate_id: wanted,
        p_new_token_hash: await sha256hex(raw), p_expires_at: expires,
      });
      if (error) return dbError(error);
      return reply({ token: raw, expires_at: expires });
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

    // ── the rep's own photo ──────────────────────────────────────────────
    // The token decides whose photo this is; nothing in the body names an
    // affiliate or a company. Only a joined rep's portal link may change it.
    if (action === 'photo') {
      if (t.purpose !== 'portal' || !t.affiliate_id) return reply({ error: 'Finish signing up first.' }, 400);
      // Each upload gets its own object, and only the photo a request REPLACED
      // is deleted after its own update lands. Two tabs racing can at worst
      // leave an unused copy behind -- never a saved address whose image is gone.
      const folder = `${t.company_entity_id}/affiliate-photos/${t.affiliate_id}`;
      const bucket = service.storage.from(PHOTO_BUCKET);
      const { data: before, error: readErr } = await service.from('affiliates').select('photo_url')
        .eq('id', t.affiliate_id).eq('company_entity_id', t.company_entity_id).maybeSingle();
      if (readErr) {
        console.error('[affiliate-portal] photo read failed', readErr.message);
        return reply({ error: 'Photos are not available yet. Please try again later.' }, 503);
      }
      let patch;
      if (body.remove === true) {
        patch = { photo_url: null, photo_hidden: true };
      } else {
        const bytes = fromBase64(body.image);
        if (!bytes || !isJpeg(bytes)) return reply({ error: 'That photo could not be read. Try another image.' }, 400);
        if (bytes.length > PHOTO_MAX_BYTES) return reply({ error: 'That photo is too large. Try a smaller image.' }, 413);
        const path = `${folder}-${now().getTime()}-${makeToken().slice(0, 8)}.jpg`;
        const { error: upErr } = await bucket.upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
        if (upErr) { console.error('[affiliate-portal] photo upload failed', upErr.message); return reply({ error: 'The photo could not be saved. Please try again.' }, 500); }
        patch = { photo_url: bucket.getPublicUrl(path).data.publicUrl, photo_hidden: false };
      }
      const { data: rows, error } = await service.from('affiliates').update({ ...patch, updated_at: now().toISOString() })
        .eq('id', t.affiliate_id).eq('company_entity_id', t.company_entity_id).select('id');
      if (error) {
        console.error('[affiliate-portal] photo save failed', error.message);
        return reply({ error: 'Photos are not available yet. Please try again later.' }, 503);
      }
      if (!rows?.length) return reply({ error: 'This link has expired or is no longer valid.', code: 'invalid_link' }, 404);
      const old = ownPhotoPath(before?.photo_url, folder);
      if (old) await bucket.remove([old]).catch(() => {});
      return reply({ photo_url: patch.photo_url, own: !!patch.photo_url });
    }

    // Where this affiliate takes money. Set by THE AFFILIATE, from their own
    // portal link, and by nobody else: the person who owns the address is the
    // only one who can be right about it, and a payout sent to an address a
    // manager typed is a payment to whoever holds it. Deliberately separate
    // from contact_email -- where someone reads mail and where they take
    // money are different facts.
    if (action === 'payout_email') {
      if (t.purpose !== 'portal' || !t.affiliate_id) return reply({ error: 'Finish signing up first.' }, 400);
      const email = String(body?.email ?? '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply({ error: 'That does not look like an email address.' }, 400);
      }
      // PayPal's receiver field takes 127 single-byte characters. Refuse a
      // longer one here, rather than at the moment someone tries to pay.
      if (email.length > 127) {
        return reply({ error: 'That address is too long for PayPal (127 characters).' }, 400);
      }
      const { error } = await service.from('affiliate_payout_accounts').upsert({
        company_entity_id: t.company_entity_id,
        affiliate_id: t.affiliate_id,
        provider: 'paypal',
        payout_email: email || null,
      }, { onConflict: 'company_entity_id,affiliate_id,provider' });
      if (error) return dbError(error);
      return reply({ payout_email: email || null });
    }

    if (action === 'statement') {
      if (t.purpose !== 'portal') return reply({ error: 'Finish signing up first.' }, 400);
      const { data, error } = await service.rpc('affiliate_portal_statement', { p_token_hash: hash });
      if (error) return dbError(error);
      const feed = await portalFeed(hash);
      if (data && typeof data === 'object') {
        // A code still waiting to be created in Shopify is not the
        // affiliate's yet (20261110160000).
        if (Array.isArray(data.codes)) data.codes = data.codes.filter((c) => c?.status !== 'pending');
        // A link to a page of the brand's store applies the affiliate's code,
        // like every link in the feed. One on another site stays as it is.
        if (Array.isArray(data.links)) data.links = data.links.map((l) => ({ ...l, link: storeLinkFor(feed?.store, feed?.code, l.destination_url) }));
      }
      if (feed) delete feed.store;
      const photo = await repPhoto(t);
      // Only this affiliate's own payout address, and only the address.
      let payoutEmail = null;
      if (t.affiliate_id) {
        const { data: acct } = await service.from('affiliate_payout_accounts')
          .select('payout_email').eq('company_entity_id', t.company_entity_id)
          .eq('affiliate_id', t.affiliate_id).eq('provider', 'paypal').maybeSingle();
        payoutEmail = acct?.payout_email || null;
      }
      return reply({ brand: t.company_title, brand_logo: await brandLogo(t.company_entity_id), program: t.program_name, statement: data,
        feed, photo_url: photo.url, photo_own: photo.own, payout_email: payoutEmail,
        formatted: { earned: formatMoney(data?.totals?.earned_cents, data?.currency) } });
    }

    return reply({ error: `Unknown action ${action}` }, 400);
  };
}
