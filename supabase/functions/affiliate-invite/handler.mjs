// affiliate-invite -- staff actions that mint affiliate links and send
// affiliates their TRANSACTIONAL mail.
//
// What this function will not do is the point of it:
//   * It never cold-emails a creator SILO FOUND. `signup_link` returns a URL
//     for a person to paste into outreach they send themselves (the export
//     batch carries it). Recruitment mail to someone who never asked is not
//     transactional, and sending it through SILO's provider would put SILO's
//     sending domain behind it. The one invite SILO does mail (`email: true`)
//     goes only to someone a manager added by hand or who applied
//     (INVITE_SOURCES): onboarding, not prospecting (Blake 2026-11-17).
//   * It never takes the company from the request. The company is the
//     caller's own active company, read through their JWT.
//   * It never decides authority itself. The FIRST thing it does is ask the
//     database, as the caller, whether they may manage affiliate programs --
//     a caller-token PostgREST call whose error aborts, which is also what
//     makes the two-step-login and third-party-token hooks apply here
//     (supabase/functions/CLAUDE.md). Only after that does it use the
//     service role, and only to write what the caller was just allowed to.
//
// Actions:
//   signup_link { prospect_id, contact_email?, email? } -> creates the affiliate (invited) if needed,
//                                                   returns a 14-day signup URL; email=true also
//                                                   MAILS it, for INVITE_SOURCES only
//   portal_link { affiliate_id, email? }          -> 90-day portal link. email=true MAILS it to the
//                                                   address on file and returns no URL (see mintMailed);
//                                                   otherwise it returns the URL for the caller to send
//   notify      { affiliate_id, kind: 'codes_and_links' | 'payout_status', payout_id? }
//   create_shopify_codes { code_ids? | code_id } -> SILO makes the waiting (pending) codes in the
//                                                   brand's Shopify itself (shopify-codes.mjs), then mails
//                                                   "your code is live". A staff session: its own company.
//                                                   No session: one code_id only (the portal, right after
//                                                   signup). Service key, no id: every company (nightly).
//   deliver_code_notices { code_id? }           -> mails "your code is live" for each notice the database
//                                                   owes; no session needed with a code_id, service key without
import { sha256hex, randomToken, sendAffiliateMail, renderMail, escapeHtml, formatMoney, affiliateLink, storeLinkFor } from './affiliate-mail.mjs';
import { ensureShopifyAccessToken } from './shopify-auth-lib.mjs';
import { pickConnection, canMakeCodes, makeCode, endCode, storeMatches, productIdForPath } from './shopify-codes.mjs';

// Mail that was not sent ON PURPOSE (see affiliate-mail.mjs): never retried.
const DELIBERATE_SKIPS = new Set(['no address on file', 'address is on the suppression list']);
// A paid-payout email claim older than this was abandoned and may be taken again.
const PAID_CLAIM_STALE_MS = 15 * 60 * 1000;
// Pages of 25 pending codes the nightly sweep walks (createShopifyCodes).
export const SWEEP_PAGES = 8;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
export const SIGNUP_LINK_DAYS = 14;
export const PORTAL_LINK_DAYS = 90;
// How far back the nightly earnings notice looks (a missed night is still covered).
export const EARNINGS_LOOKBACK_H = 72;
// Prospects SILO may email an onboarding invite: added by a manager, or
// applied themselves. Never 'serp' / 'ai_research' / 'csv_import' -- a
// creator a search found has not asked to hear from this brand.
export const INVITE_SOURCES = new Set(['manual', 'applied']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A date (YYYY-MM-DD) as the company's own calendar day; UTC when the zone
// is missing or unknown.
export function localDay(at, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return at.toISOString().slice(0, 10); }
}
// Constant-time string compare (no early exit on the first differing byte).
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export function createInviteHandler({ service, userClientFor, siteUrl, resendKey, serviceKey = '', isServiceToken = null, fetchImpl = fetch, now = () => new Date(), makeToken = randomToken }) {
  const base = siteUrl.replace(/\/$/, '');

  async function mint({ company, program, purpose, affiliateId, prospectId, days, createdBy }) {
    const raw = makeToken();
    const expires = new Date(now().getTime() + days * 86400000).toISOString();
    const { data, error } = await service.rpc('affiliate_issue_access_token', {
      p_company_entity_id: company, p_program_id: program, p_purpose: purpose,
      p_token_hash: await sha256hex(raw), p_expires_at: expires,
      p_affiliate_id: affiliateId ?? null, p_prospect_id: prospectId ?? null, p_created_by: createdBy,
    });
    if (error) throw new Error(error.message);
    const page = purpose === 'signup' ? 'join' : 'portal';
    return { token_id: data, url: `${base}/v2/affiliates/${page}.html?t=${encodeURIComponent(raw)}`, expires_at: expires };
  }

  // A portal link that will go ONLY to the rep's own address, bound to it by
  // the database (20261110190000) so the portal treats it as mailbox proof
  // and lets that rep move between the brands the same address reps. The
  // caller never sees the raw value -- a link a manager holds is not proof of
  // anything, and that is what `mint` above is for. `mailedTo` is the address
  // this is about to be sent to; the database refuses if it is no longer the
  // affiliate's, so an edit racing the mint aborts it.
  async function mintMailed({ company, program, affiliateId, mailedTo, days }) {
    const raw = makeToken();
    const expires = new Date(now().getTime() + days * 86400000).toISOString();
    const { error } = await service.rpc('affiliate_portal_issue_mailed_token', {
      p_company_entity_id: company, p_program_id: program, p_affiliate_id: affiliateId,
      p_token_hash: await sha256hex(raw), p_expires_at: expires, p_mailed_to: mailedTo,
    });
    if (error) throw new Error(error.message);
    return { url: `${base}/v2/affiliates/portal.html?t=${encodeURIComponent(raw)}`, expires_at: expires };
  }


  // The rep's current codes and links, mailed. Used by the Studio button and
  // by the automatic "your code is live" notice. Returns null when the rep
  // has nothing live to send.
  async function sendCodesAndLinks({ company, a, brand, actor, live = null }) {
    const { data: codes } = await service.from('affiliate_codes').select('code, starts_on, ends_on, status, discount_percent')
      .eq('company_entity_id', company).eq('affiliate_id', a.id).eq('status', 'active');
    const { data: links } = await service.from('affiliate_links').select('destination_url, utm_source, utm_medium, utm_campaign, starts_on, ends_on')
      .eq('company_entity_id', company).eq('affiliate_id', a.id).eq('status', 'active');
    if (!codes?.length && !links?.length) return null;
    const dates = (s, e) => `${s}${e ? ` to ${e}` : ' onward'}`;
    // Links apply the affiliate's code (20261110160000): the store the
    // brand named, or its only Shopify store -- never a guess among several.
    const { data: store } = await service.rpc('affiliate_program_store_url', { p_company: company, p_program: a.program_id });
    // The company's own calendar day, as the portal feed and the Shopify
    // instructions use, not UTC's.
    const { data: tz } = await service.rpc('silo_company_timezone', { p_company_entity_id: company });
    const today = localDay(now(), tz);
    const current = (codes || []).find((c) => c.starts_on <= today && (!c.ends_on || c.ends_on >= today));
    const shopLink = current ? affiliateLink(store, current.code, '/') : null;
    const shown = live || current?.code || (codes || [])[0]?.code || null;
    const paras = live
      ? [`Hi ${escapeHtml(a.display_name)}, your ${escapeHtml(brand)} code is live. Share it, or your link, and you earn on every sale that uses it.`]
      : [`Hi ${escapeHtml(a.display_name)}, here is your ${escapeHtml(brand)} code.`];
    // Only codes that still work: one that ended is not 'also yours'.
    const others = (codes || []).filter((c) => c.code !== shown && (!c.ends_on || c.ends_on >= today));
    if (others.length) paras.push(`Also yours: ${others.map((c) => `<strong>${escapeHtml(c.code)}</strong> (${escapeHtml(dates(c.starts_on, c.ends_on))})`).join(', ')}.`);
    const own = (codes || []).find((c) => c.code === shown);
    if (own?.ends_on) paras.push(`Works ${escapeHtml(dates(own.starts_on, own.ends_on))}.`);
    paras.push('Your portal has a ready link for every product and post you can share.');
    // Buttons, not addresses (Blake 2026-11-17). The portal link goes only to
    // the rep's own address, so it is a mailed (bound) one.
    let portal = null;
    try { if (a.contact_email) portal = await mintMailed({ company, program: a.program_id, affiliateId: a.id, mailedTo: a.contact_email, days: PORTAL_LINK_DAYS }); }
    catch (e) { console.error('[affiliate-invite] portal link for code mail', e?.message); }
    const ctas = [
      ...(shopLink ? [{ url: shopLink, label: 'Shop with my code' }] : []),
      ...(portal ? [{ url: portal.url, label: 'Open my portal' }] : []),
    ];
    // A link the brand added by hand with no store behind it still has to reach them.
    const loose = (links || []).filter((l) => !(current && storeLinkFor(store, current.code, l.destination_url)));
    for (const l of loose.slice(0, 3)) {
      const x = new URL(l.destination_url);
      for (const [k, v] of [['utm_source', l.utm_source], ['utm_medium', l.utm_medium], ['utm_campaign', l.utm_campaign]]) if (v) x.searchParams.set(k, v);
      ctas.push({ url: x.toString(), label: x.hostname.replace(/^www\./, '') });
    }
    const { html, text } = renderMail({ brand, eyebrow: live ? 'You are in' : 'Your code', heading: live ? 'Your code is live' : 'Your code', paragraphs: paras, code: shown, ctas,
      codeNote: own?.discount_percent ? `${Number(own.discount_percent)}% off for your audience` : '',
      footer: 'A sale counts when the customer uses your code at checkout.' });
    return sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
      kind: 'codes_and_links', to: a.contact_email,
      subject: live ? `${brand}: your code ${live} is live` : `${brand}: your affiliate codes and links`, html, text, triggeredBy: actor });
  }

  // Internal: mails each rep whose code just went live (the AI marked it
  // created in Shopify). Called with the service key only -- by the mcp
  // function right after the mark, and by the nightly run as a sweep. Each
  // notice is claimed once in the database, so a repeat call sends nothing.
  async function deliverCodeNotices(body) {
    const codeId = body?.code_id && UUID_RE.test(String(body.code_id)) ? String(body.code_id) : null;
    const { data: due, error } = await service.rpc('affiliate_claim_code_notices', { p_code: codeId, p_limit: 50 });
    if (error) throw new Error(error.message);
    const results = [];
    for (const n of due || []) {
      try {
        const { data: a } = await service.from('affiliates').select('id, program_id, display_name, contact_email, status')
          .eq('id', n.affiliate_id).eq('company_entity_id', n.company_entity_id).maybeSingle();
        if (!a || a.status !== 'active') { results.push({ code_id: n.code_id, email: 'skipped' }); continue; }
        const { data: co } = await service.from('entities').select('title').eq('id', n.company_entity_id).maybeSingle();
        const mail = await sendCodesAndLinks({ company: n.company_entity_id, a, brand: co?.title || 'Affiliate program', actor: null, live: n.code });
        results.push({ code_id: n.code_id, email: mail?.status ?? 'skipped' });
      } catch (err) {
        console.error('[affiliate-invite] code notice', n.code_id, err?.message);
        results.push({ code_id: n.code_id, email: 'failed' });
      }
    }
    return results;
  }

  // SILO makes waiting codes in Shopify (Blake 2026-11-17). Only codes a
  // person or the signup trigger already queued as 'pending'; each result is
  // named (created / adopted / needs_scope / no_store / failed / skipped) and
  // anything but created/adopted leaves the code pending for the next try or
  // for the brand's own AI (codes:create), exactly as before.
  // The Shopify store a program's codes are made in, ready to write, or why not.
  const newStoreCaches = () => ({ conns: new Map(), ready: new Map(), tzs: new Map(), progs: new Map() });
  async function storeFor(co, programId, caches) {
    const { conns, ready, tzs, progs } = caches;
    if (!conns.has(co)) {
      const { data } = await service.from('shopify_connections')
        .select('id, company_entity_id, shop_domain, is_active, access_token, api_version, auth_method, token_expires_at')
        .eq('company_entity_id', co);
      conns.set(co, data || []);
      const { data: tz } = await service.rpc('silo_company_timezone', { p_company_entity_id: co });
      tzs.set(co, tz || 'UTC');
    }
    if (!progs.has(programId)) {
      const { data } = await service.from('affiliate_programs').select('id, store_url, shop_domains')
        .eq('id', programId).eq('company_entity_id', co).maybeSingle();
      progs.set(programId, data);
    }
    const conn = pickConnection(progs.get(programId), conns.get(co));
    if (!conn) return { status: 'no_store', reason: 'Pick the program\'s Shopify store in Setup.' };
    if (!ready.has(conn.id)) {
      let ok = false;
      try {
        await ensureShopifyAccessToken(service, conn, { fetchImpl });
        ok = Boolean(conn.access_token) && await canMakeCodes(conn, fetchImpl);
        // A store's own Dev Dashboard app: a token minted before the
        // owner allowed discounts lacks it for up to a day. Mint once more.
        if (!ok && conn.auth_method === 'client_credentials') {
          conn.token_expires_at = null;
          await ensureShopifyAccessToken(service, conn, { fetchImpl });
          ok = await canMakeCodes(conn, fetchImpl);
        }
      }
      catch (e) { console.error('[affiliate-invite] shopify scope check', conn.shop_domain, e?.message); ok = e?.kind === 'needs_scope' ? false : null; }
      ready.set(conn.id, ok);
    }
    const r = ready.get(conn.id);
    if (r === false) {
      return { status: 'needs_scope', reason: conn.auth_method === 'client_credentials'
        ? 'allow write_discounts on your Shopify app in the Dev Dashboard, then release it'
        : 'reconnect Shopify in Integrations so SILO can make codes' };
    }
    if (r !== true) return { status: 'failed', reason: 'Shopify did not answer. Try again.' };
    if (!storeMatches(progs.get(programId), conn)) {
      return { status: 'no_store', reason: `the program's store address is not ${conn.shop_domain}; fix it in Setup` };
    }
    return { conn };
  }

  // Earnings notices (Blake 2026-11-17): once a night, each active affiliate
  // credited since their last notice gets one short email with the total and
  // a portal button. Looks back at most EARNINGS_LOOKBACK_H, so a first run
  // never mails a backlog. Service key only (the nightly run).
  async function deliverEarningsNotices() {
    const since = new Date(now().getTime() - EARNINGS_LOOKBACK_H * 3600 * 1000).toISOString();
    const { data: rows, error } = await service.from('affiliate_commission_ledger')
      .select('company_entity_id, program_id, affiliate_id, amount_cents, currency, created_at, order_id')
      .eq('kind', 'accrual').gt('created_at', since).order('created_at').limit(2000);
    if (error) throw new Error(error.message);
    const by = new Map();
    for (const r of rows || []) {
      const k = `${r.company_entity_id}|${r.affiliate_id}|${r.currency}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    const results = [];
    for (const list of [...by.values()].slice(0, 200)) {
      const f = list[0];
      try {
        const { data: last } = await service.from('affiliate_notifications').select('created_at')
          .eq('company_entity_id', f.company_entity_id).eq('affiliate_id', f.affiliate_id).eq('kind', 'earnings').eq('status', 'sent')
          .order('created_at', { ascending: false }).limit(1);
        const after = last?.[0]?.created_at || null;
        const fresh = list.filter((r) => !after || r.created_at > after);
        const cents = fresh.reduce((t, r) => t + Number(r.amount_cents || 0), 0);
        if (!fresh.length || cents <= 0) continue;
        const { data: a } = await service.from('affiliates').select('id, program_id, display_name, contact_email, status')
          .eq('id', f.affiliate_id).eq('company_entity_id', f.company_entity_id).maybeSingle();
        if (!a || a.status !== 'active') continue;
        const { data: co } = await service.from('entities').select('title').eq('id', f.company_entity_id).maybeSingle();
        const brand = co?.title || 'Affiliate program';
        const orders = new Set(fresh.map((r) => r.order_id).filter(Boolean)).size || fresh.length;
        const amount = formatMoney(cents, f.currency);
        let portal = null;
        try { if (a.contact_email) portal = await mintMailed({ company: f.company_entity_id, program: a.program_id, affiliateId: a.id, mailedTo: a.contact_email, days: PORTAL_LINK_DAYS }); }
        catch (e) { console.error('[affiliate-invite] portal link for earnings mail', e?.message); }
        const { html, text } = renderMail({ brand, eyebrow: 'Earnings', heading: `You earned ${amount}`,
          stats: [{ label: 'Orders', value: String(orders) }, { label: 'Earned', value: amount }],
          paragraphs: [`Hi ${escapeHtml(a.display_name)}, you earned <strong>${escapeHtml(amount)}</strong> on ${orders} ${orders === 1 ? 'order' : 'orders'} with ${escapeHtml(brand)}.`,
            `It is paid to your PayPal after ${escapeHtml(brand)}'s refund window.`],
          ctas: portal ? [{ url: portal.url, label: 'See my earnings' }] : [] });
        const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: f.company_entity_id, programId: a.program_id, affiliateId: a.id,
          kind: 'earnings', to: a.contact_email, subject: `${brand}: you earned ${amount}`, html, text, triggeredBy: null });
        results.push({ affiliate_id: a.id, email: mail?.status ?? 'skipped', cents });
      } catch (e) {
        console.error('[affiliate-invite] earnings notice', f.affiliate_id, e?.message);
        results.push({ affiliate_id: f.affiliate_id, email: 'failed' });
      }
    }
    return results;
  }

  // Product seeding codes, made by SILO like every other code (Blake
  // 2026-11-17: "All codes in studio should follow that path"). An approved
  // claim already holds its text and terms; this makes it in Shopify as that
  // one product, one use, then mails the code to that affiliate only. Anything
  // short of made leaves the claim approved, so the next run (or the brand's
  // own AI, codes:create) can still make it.
  async function createSeedCodes({ company = null, claimIds = null, actor = null }) {
    let q = service.from('affiliate_seed_claims')
      .select('id, company_entity_id, program_id, affiliate_id, product_title, product_path, code, discount_percent, multiple, goal_days, feed_item_id')
      .eq('state', 'approved').is('shopify_discount_id', null).not('code', 'is', null)
      .order('decided_at', { ascending: true }).limit(25);
    if (company) q = q.eq('company_entity_id', company);
    if (claimIds?.length) q = q.in('id', claimIds);
    const { data: claims, error } = await q;
    if (error) throw new Error(error.message);
    const results = [];
    const caches = newStoreCaches();
    for (const c of claims || []) {
      const co = c.company_entity_id;
      const out = { seed_id: c.id, code: c.code };
      try {
        const st = await storeFor(co, c.program_id, caches);
        if (st.status) { results.push({ ...out, status: st.status, reason: st.reason }); continue; }
        const { conn } = st;
        const productId = await productIdForPath(conn, c.product_path, fetchImpl);
        if (!productId) { results.push({ ...out, status: 'no_product', reason: `${c.product_title} is not a product in ${conn.shop_domain}` }); continue; }
        const tz = caches.tzs.get(co);
        const { data: a } = await service.from('affiliates').select('id, program_id, display_name, contact_email, status')
          .eq('id', c.affiliate_id).eq('company_entity_id', co).maybeSingle();
        const made = await makeCode(conn, { code: c.code, starts_on: localDay(now(), tz), ends_on: null,
          discount_percent: c.discount_percent, product_id: productId, affiliate: a?.display_name }, tz, fetchImpl);
        const { data: upd, error: uErr } = await service.from('affiliate_seed_claims')
          .update({ state: 'code_ready', shopify_discount_id: made.id, code_created_at: now().toISOString(), code_created_via_app: 'SILO' })
          .eq('id', c.id).eq('company_entity_id', co).eq('state', 'approved').select('id');
        if (uErr) { results.push({ ...out, status: 'failed', reason: uErr.message.replace(/^[a-z_]+:\s*/, '') }); continue; }
        if (!upd?.length) { results.push({ ...out, status: 'skipped', reason: 'No longer waiting.' }); continue; }
        results.push({ ...out, status: made.adopted ? 'adopted' : 'created', shopify_discount_id: made.id, shop: conn.shop_domain });
        try { if (a?.status === 'active') await sendSeedCode({ company: co, a, claim: c, actor }); }
        catch (e) { console.error('[affiliate-invite] seed notice', c.id, e?.message); }
      } catch (e) {
        console.error('[affiliate-invite] seed code', c.id, e?.message);
        const kind = ['needs_scope', 'taken'].includes(e?.kind) ? e.kind : 'failed';
        results.push({ ...out, status: kind, reason: String(e?.message || 'failed').slice(0, 240) });
      }
    }
    return results;
  }

  async function sendSeedCode({ company, a, claim, actor }) {
    const { data: co } = await service.from('entities').select('title').eq('id', company).maybeSingle();
    const brand = co?.title || 'Affiliate program';
    const { data: store } = await service.rpc('affiliate_program_store_url', { p_company: company, p_program: a.program_id });
    const shop = affiliateLink(store, claim.code, claim.product_path || '/');
    const pct = Number(claim.discount_percent);
    const paras = [
      `Hi ${escapeHtml(a.display_name)}, your ${escapeHtml(brand)} request for <strong>${escapeHtml(claim.product_title)}</strong> is approved.`,
      `Sell ${escapeHtml(String(Number(claim.multiple)))}× what you pay within ${escapeHtml(String(claim.goal_days))} days and ${escapeHtml(brand)} pays it back.`,
    ];
    // The product's own photo, from the item the brand shared to the portal.
    let image = null;
    if (claim.feed_item_id) {
      try {
        const { data: item } = await service.from('affiliate_feed_items').select('image_url, title')
          .eq('id', claim.feed_item_id).eq('company_entity_id', company).maybeSingle();
        if (item?.image_url) image = { url: item.image_url, alt: item.title || claim.product_title };
      } catch { /* no photo: the email still goes */ }
    }
    const { html, text } = renderMail({ brand, eyebrow: 'Product request approved', heading: claim.product_title || 'Your product code', image,
      paragraphs: paras, code: claim.code, codeNote: `${pct}% off this product · one use · for you only`,
      ctas: shop ? [{ url: shop, label: 'Get it now' }] : [], footer: 'Please do not share this code.' });
    return sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
      kind: 'seed_code', to: a.contact_email, subject: `${brand}: your code for ${claim.product_title}`, html, text, triggeredBy: actor });
  }

  async function createShopifyCodes({ company = null, codeIds = null, actor = null, from = null }) {
    // Keyset pages of 25 by (created_at, id). A code SILO cannot make stays
    // pending, so re-reading the first page would let one company's waiting
    // codes hide every newer one; the sweep walks past them instead, up to
    // SWEEP_PAGES pages a run. A staff call or a single code is one page.
    const pages = !company && !codeIds?.length ? SWEEP_PAGES : 1;
    const codes = [];
    // The sweep resumes where the caller's last request stopped (next, below).
    let after = from && UUID_RE.test(String(from.id || '')) && !Number.isNaN(Date.parse(from.created_at || '')) ? { id: String(from.id), created_at: String(from.created_at) } : null;
    let more = false;
    for (let page = 0; page < pages; page++) {
      let q = service.from('affiliate_codes')
        .select('id, company_entity_id, program_id, affiliate_id, code, starts_on, ends_on, discount_percent, created_at, created_by')
        .eq('status', 'pending').order('created_at').order('id').limit(25);
      if (company) q = q.eq('company_entity_id', company);
      if (codeIds?.length) q = q.in('id', codeIds);
      if (after) q = q.or(`created_at.gt."${after.created_at}",and(created_at.eq."${after.created_at}",id.gt.${after.id})`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      codes.push(...(data || []));
      if (!data || data.length < 25) { more = false; break; }
      after = data[data.length - 1];
      more = true;
    }
    const next = pages > 1 && more ? { created_at: after.created_at, id: after.id } : null;
    const results = [];
    const caches = newStoreCaches();
    for (const c of codes || []) {
      const co = c.company_entity_id;
      const out = { code_id: c.id, code: c.code };
      try {
        const st = await storeFor(co, c.program_id, caches);
        if (st.status) { results.push({ ...out, status: st.status, reason: st.reason }); continue; }
        const { conn } = st;
        const tzs = caches.tzs;
        const { data: a } = await service.from('affiliates').select('display_name').eq('id', c.affiliate_id).eq('company_entity_id', co).maybeSingle();
        let made;
        try { made = await makeCode(conn, { ...c, affiliate: a?.display_name }, tzs.get(co), fetchImpl); }
        catch (e) {
          // A code SILO picked by itself on joining (created_by null) has not
          // been shown to anyone yet: take the next free text and try again.
          // A code a person chose is theirs to change.
          if (e?.kind !== 'taken' || c.created_by) throw e;
          made = null;
          const stem = String(c.code);
          for (const l of 'BCD') {
            if (made) break;
            const text = `${stem}${l}`;
            const { data: re, error: rErr } = await service.from('affiliate_codes').update({ code: text })
              .eq('id', c.id).eq('company_entity_id', co).eq('status', 'pending').select('id');
            if (rErr || !re?.length) continue;
            c.code = text; out.code = text;
            try { made = await makeCode(conn, { ...c, affiliate: a?.display_name }, tzs.get(co), fetchImpl); }
            catch (e2) { if (e2?.kind !== 'taken') throw e2; }
          }
          if (!made) throw e;
        }
        // Conditional on still pending: a code cancelled (or made by the AI)
        // meanwhile is left as it is. Activating runs the overlap guard.
        const { data: upd, error: uErr } = await service.from('affiliate_codes')
          .update({ status: 'active', shopify_discount_id: made.id, shopify_created_at: now().toISOString(), shopify_created_via_app: 'SILO', changed_by: actor })
          .eq('id', c.id).eq('company_entity_id', co).eq('status', 'pending').select('id');
        if (uErr) { results.push({ ...out, status: 'failed', reason: uErr.message.replace(/^[a-z_]+:\s*/, '') }); continue; }
        if (!upd?.length) { results.push({ ...out, status: 'skipped', reason: 'No longer waiting.' }); continue; }
        results.push({ ...out, status: made.adopted ? 'adopted' : 'created', shopify_discount_id: made.id, shop: conn.shop_domain });
        try { await deliverCodeNotices({ code_id: c.id }); } catch (e) { console.error('[affiliate-invite] live notice', c.id, e?.message); }
      } catch (e) {
        console.error('[affiliate-invite] shopify code', c.id, e?.message);
        const kind = ['needs_scope', 'taken'].includes(e?.kind) ? e.kind : 'failed';
        const reason = kind === 'taken' ? `${String(e.message)}; give this affiliate a different code, or Cancel it and add it as made by hand if it is theirs` : String(e?.message || 'failed');
        results.push({ ...out, status: kind, reason: reason.slice(0, 240) });
      }
    }
    results.next = next;
    return results;
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authHeader)) return reply({ error: 'Unauthorized' }, 401);

    // deliver_code_notices sends only mail the database already owes (a code
    // went live) and claims each notice once, so it needs no staff session:
    //   * with a code_id, any caller the platform admits (the mcp function
    //     calls it right after the AI marks a code created, with the public
    //     key -- mcp holds no service key). The worst a stranger can do is
    //     make that one owed email go out a few seconds sooner, once.
    //   * without one (the sweep across every company), a service key only.
    //     The runtime's own key is compared in constant time first. Failing
    //     that, Auth itself is asked whether the presented key may act as the
    //     service role: the key this runtime injects and the one the nightly
    //     workflow holds are both genuine service keys but need not be the
    //     same string, and comparing bytes refused the sweep every night from
    //     its first run (2026-11-11 to 11-13: `deliver_code_notices 401`).
    //     Any doubt -- no probe, a probe error, anything but `true` -- refuses.
    let peek = null;
    try { peek = await req.clone().json(); } catch { /* handled below */ }
    // Without a staff session: one code by id (the portal, right after a
    // signup queued it -- the worst a stranger can do is make an owed code
    // appear in Shopify sooner), or every company with a service key.
    if (peek?.action === 'create_shopify_codes') {
      const codeId = UUID_RE.test(String(peek.code_id || '')) ? String(peek.code_id) : null;
      // One PRODUCT code by id, on the same terms as code_id above: the
      // portal asks right after a shared product was claimed, which the
      // database already approved (20261120030000). The claim decides what is
      // made; the id only brings it forward from tonight's sweep.
      const seedId = UUID_RE.test(String(peek.seed_id || '')) ? String(peek.seed_id) : null;
      if (seedId && !codeId) {
        try { return reply({ results: await createSeedCodes({ claimIds: [seedId] }) }); }
        catch (err) { console.error('[affiliate-invite] seed code by id', err?.message); return reply({ error: 'Could not make codes' }, 500); }
      }
      let sweep = false;
      if (!codeId) {
        sweep = Boolean(serviceKey) && safeEqual(authHeader, `Bearer ${serviceKey}`);
        if (!sweep && isServiceToken && !Array.isArray(peek.code_ids)) {
          try { sweep = (await isServiceToken(authHeader.replace(/^Bearer\s+/, ''))) === true; } catch { sweep = false; }
        }
      }
      if (codeId || sweep) {
        try {
          const results = await createShopifyCodes({ codeIds: codeId ? [codeId] : null, from: codeId ? null : peek.after });
          const next = results.next ?? null;
          // The sweep's first request also makes approved product codes.
          if (sweep && !peek.after) results.push(...await createSeedCodes({}));
          return reply({ results, next });
        }
        catch (err) { console.error('[affiliate-invite] shopify codes', err?.message); return reply({ error: 'Could not make codes' }, 500); }
      }
      // Otherwise a staff session, below: that person's own company.
    }
    if (peek?.action === 'deliver_code_notices') {
      const codeId = UUID_RE.test(String(peek.code_id || '')) ? String(peek.code_id) : null;
      let isService = Boolean(serviceKey) && safeEqual(authHeader, `Bearer ${serviceKey}`);
      if (!isService && !codeId && isServiceToken) {
        try { isService = (await isServiceToken(authHeader.replace(/^Bearer\s+/, ''))) === true; }
        catch { isService = false; }
      }
      if (!codeId && !isService) return reply({ error: 'Unauthorized' }, 401);
      try {
        const delivered = await deliverCodeNotices({ code_id: codeId });
        // The nightly run (service, no code) also sends the earnings notices.
        let earnings = null;
        if (isService && !codeId) {
          try { earnings = await deliverEarningsNotices(); } catch (e) { console.error('[affiliate-invite] earnings notices', e?.message); }
        }
        return reply({ delivered, earnings });
      }
      catch (err) { console.error('[affiliate-invite] notices', err?.message); return reply({ error: 'Could not deliver notices' }, 500); }
    }

    // 1. Authority, answered by the database AS THE CALLER. An error here is a
    //    refused session (expired, password-only with 2FA enrolled, revoked
    //    integration token) and aborts before any service-role call.
    //    The permission AND the company come back from ONE statement: asked as
    //    two requests, a person who manages company A could switch to company
    //    B between them and have B's rows written under A's authorization.
    const caller = userClientFor(authHeader);
    const { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');
    if (gateErr) return reply({ error: 'Your session could not be verified. Sign in again.' }, 401);
    if (!company || !UUID_RE.test(String(company))) {
      return reply({ error: 'Managing affiliates needs Affiliate Studio access for your active company.' }, 403);
    }
    // Who, for the audit columns. Read only AFTER the caller-token gate above
    // has accepted the session.
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const { data: who } = await service.auth.getUser(jwt);
    const actor = who?.user?.id ?? null;

    // 1b. WHICH programs. affiliate_managed_company() answers "manages at
    //     least one program of this company", and since 20261121210000 a
    //     grant may name ONE program -- so the company is no longer the whole
    //     answer for an action that takes a row id from the request. The
    //     database trigger cannot help here: it sees the service client, not
    //     the staff caller behind it. So every such action asks the caller's
    //     own session whether that program is theirs, before the service role
    //     reads or mints anything for it (review of #1350).
    const allowProgram = async (programId) => {
      if (!programId) return true;
      const { data, error } = await caller.rpc('can_manage_affiliate_program', { p_program: programId });
      // Before that migration is applied the function does not exist, and
      // nobody is scoped: the company gate above is then the whole answer,
      // exactly as it was. Any other error refuses.
      if (error) return error.code === '42883' || /could not find the function|does not exist/i.test(String(error.message || ''));
      return data === true;
    };
    const refuseProgram = () => reply({ error: 'That belongs to a program you were not given access to.' }, 403);

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const action = body?.action;

    try {
      if (action === 'create_shopify_codes') {
        const ids = Array.isArray(body.code_ids) ? body.code_ids.filter((x) => UUID_RE.test(String(x))).slice(0, 25) : null;
        const seedIds = Array.isArray(body.seed_ids) ? body.seed_ids.filter((x) => UUID_RE.test(String(x))).slice(0, 25) : null;
        // Asked by id, the ids decide which programs are touched, so they are
        // checked before Shopify is called for any of them. Asked for none,
        // the sweep reads only what this caller can already see.
        for (const [tbl, want] of [['affiliate_codes', ids], ['affiliate_seed_claims', seedIds]]) {
          if (!want?.length) continue;
          const { data: rows } = await service.from(tbl).select('program_id')
            .eq('company_entity_id', company).in('id', want);
          for (const r of rows || []) if (!await allowProgram(r.program_id)) return refuseProgram();
        }
        // Product codes only when asked by id (Studio, right after approving).
        if (seedIds?.length && !ids?.length) return reply({ results: await createSeedCodes({ company, claimIds: seedIds, actor }) });
        const results = await createShopifyCodes({ company, codeIds: ids?.length ? ids : null, actor });
        if (!ids?.length) results.push(...await createSeedCodes({ company, actor }));
        return reply({ results });
      }

      // Turn ended codes off in Shopify (audit 2026-11-18). Only codes this
      // company already retired in SILO, and only ones SILO knows by
      // Shopify id. Each outcome is stored on the code, so "off", "could not"
      // and "never tried" are three different records.
      if (action === 'end_shopify_codes') {
        // Every id asked for gets an outcome: more than 25 is refused, never
        // cut short (review on #1331), and an id that is not a retired code
        // of this company says so.
        const ids = Array.isArray(body.code_ids) ? [...new Set(body.code_ids.filter((x) => UUID_RE.test(String(x))))] : [];
        if (!ids.length) return reply({ error: 'code_ids are required' }, 400);
        if (ids.length > 25) return reply({ error: 'At most 25 codes at a time.' }, 400);
        const { data: codes, error: cErr } = await service.from('affiliate_codes')
          .select('id, company_entity_id, program_id, code, status, shopify_discount_id, shopify_ended_at')
          .eq('company_entity_id', company).eq('status', 'retired').in('id', ids);
        if (cErr) throw new Error(cErr.message);
        const caches = newStoreCaches();
        const results = [];
        for (const c of codes || []) {
          const out = { code_id: c.id, code: c.code };
          // Every id asked for gets an outcome, including this one: a code of
          // a program this caller was not given is left exactly as it is.
          if (!await allowProgram(c.program_id)) {
            results.push({ ...out, status: 'not_yours', reason: 'a program you were not given access to, so it was left as it is' });
            continue;
          }
          if (c.shopify_ended_at) { results.push({ ...out, status: 'ended' }); continue; }
          if (!c.shopify_discount_id) { results.push({ ...out, status: 'manual', reason: 'SILO did not make this code. Turn it off in Shopify yourself.' }); continue; }
          let status; let reason = null;
          try {
            const st = await storeFor(company, c.program_id, caches);
            if (st.status) { status = st.status; reason = st.reason; }
            else status = await endCode(st.conn, c.shopify_discount_id, fetchImpl);
          } catch (e) { status = 'failed'; reason = String(e?.message || 'failed').slice(0, 240); }
          const done = status === 'ended' || status === 'gone';
          await service.from('affiliate_codes')
            .update(done ? { shopify_ended_at: now().toISOString(), shopify_end_error: null } : { shopify_end_error: reason || status })
            .eq('id', c.id).eq('company_entity_id', company).eq('status', 'retired');
          results.push({ ...out, status: done ? 'ended' : status, reason });
        }
        const seen = new Set((codes || []).map((c) => c.id));
        for (const id of ids) if (!seen.has(id)) results.push({ code_id: id, status: 'not_retired', reason: 'not a retired code of this company, so it was left as it is' });
        return reply({ results });
      }

      if (action === 'signup_link') {
        if (!UUID_RE.test(String(body.prospect_id || ''))) return reply({ error: 'prospect_id is required' }, 400);
        const { data: p } = await service.from('affiliate_prospects')
          .select('id, program_id, display_name, platform, handle, profile_url, contact_email, status, source')
          .eq('id', body.prospect_id).eq('company_entity_id', company).maybeSingle();
        if (!p) return reply({ error: 'No such prospect in this company' }, 404);
        if (!await allowProgram(p.program_id)) return refuseProgram();
        if (!['approved', 'invited'].includes(p.status)) {
          return reply({ error: `Approve this prospect first (it is ${p.status}).` }, 409);
        }
        const email = String(body.contact_email || p.contact_email || '').trim().toLowerCase();
        if (!email.includes('@')) return reply({ error: 'An email address is needed to create the affiliate record.' }, 400);

        const { data: ok } = await service.rpc('affiliate_outreach_can_contact', {
          p_company_entity_id: company, p_program_id: p.program_id, p_email: email, p_handle: p.handle, p_profile_url: p.profile_url,
        });
        if (ok !== true) return reply({ error: 'This contact is on the suppression list.' }, 409);

        let { data: aff } = await service.from('affiliates').select('id, status, terms_accepted_at')
          .eq('company_entity_id', company).eq('from_prospect_id', p.id).maybeSingle();
        // A follow-up written against another prospect row for the same
        // email reuses the program's record for that email (one per email per
        // program), as affiliate_outreach_mint_signup does (20261110120000).
        if (!aff) {
          const like = email.replace(/[\\%_]/g, (c) => `\\${c}`);
          ({ data: aff } = await service.from('affiliates').select('id, status, terms_accepted_at')
            .eq('company_entity_id', company).eq('program_id', p.program_id).ilike('contact_email', like).maybeSingle());
        }
        if (aff && (aff.status === 'active' || aff.status === 'paused')) {
          return reply({ error: 'This person is already an affiliate of this program. Send them a portal link instead.' }, 409);
        }
        if (aff && aff.status === 'terminated') {
          if (aff.terms_accepted_at) return reply({ error: 'This person was an affiliate of this program and was ended.' }, 409);
          // An invite someone ended is reopened by a new invite.
          const { error: rErr } = await service.from('affiliates').update({ status: 'invited', updated_at: now().toISOString(), changed_by: actor })
            .eq('id', aff.id).eq('company_entity_id', company);
          if (rErr) return reply({ error: rErr.message }, 500);
          aff = { ...aff, status: 'invited' };
        }
        if (!aff) {
          const { data: created, error: aErr } = await service.from('affiliates').insert({
            company_entity_id: company, program_id: p.program_id, display_name: p.display_name || p.handle || email,
            contact_email: email, platform: p.platform, handle: p.handle, profile_url: p.profile_url,
            status: 'invited', from_prospect_id: p.id, created_by: actor,
          }).select('id, status').single();
          if (aErr) return reply({ error: /duplicate|unique/i.test(aErr.message) ? 'An affiliate with this email already exists in this program.' : aErr.message }, 409);
          aff = created;
        }
        if (aff.status === 'active') return reply({ error: 'This person is already an active affiliate. Send them a portal link instead.' }, 409);

        const link = await mint({ company, program: p.program_id, purpose: 'signup', affiliateId: aff.id, days: SIGNUP_LINK_DAYS, createdBy: actor });
        await service.from('affiliate_prospects').update({ status: 'invited', affiliate_id: aff.id, updated_at: now().toISOString() })
          .eq('id', p.id).eq('company_entity_id', company);
        // The live outreach draft carries the link it offers, so revoking the
        // token is how a link in an unsent draft dies.
        await service.from('affiliate_outreach_drafts').update({ token_id: link.token_id })
          .eq('company_entity_id', company).eq('prospect_id', p.id).in('state', ['draft', 'approved', 'exported']);
        if (body.email !== true) return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false, email: 'not_requested', reason: null });
        if (!INVITE_SOURCES.has(p.source)) {
          return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false, email: 'not_sent', reason: 'found by a search, so send it yourself' });
        }
        const { data: co } = await service.from('entities').select('title').eq('id', company).maybeSingle();
        const { data: prog } = await service.from('affiliate_programs').select('name').eq('id', p.program_id).eq('company_entity_id', company).maybeSingle();
        const brand = co?.title || 'Affiliate program';
        const name = p.display_name || p.handle || 'there';
        const { html, text } = renderMail({ brand, eyebrow: "You're invited", heading: `Join the ${brand} affiliate program`,
          paragraphs: [`Hi ${escapeHtml(name)}, ${escapeHtml(brand)} has invited you to join ${escapeHtml(prog?.name || 'its affiliate program')}. Open the link to read the terms and sign up. You get your own code and a portal for your sales and payouts.`],
          cta: { url: link.url, label: 'Join now' }, footer: `This link is personal to you and works for ${SIGNUP_LINK_DAYS} days. Not expecting this? You can ignore it.` });
        const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: p.program_id, affiliateId: aff.id,
          kind: 'signup_invite', to: email, subject: `${brand}: you're invited to our affiliate program`, html, text, triggeredBy: actor });
        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: mail?.status === 'sent', email: mail?.status ?? 'not_sent', reason: mail?.reason ?? null });
      }

      if (action === 'portal_link' || action === 'notify') {
        if (!UUID_RE.test(String(body.affiliate_id || ''))) return reply({ error: 'affiliate_id is required' }, 400);
        const { data: a } = await service.from('affiliates')
          .select('id, program_id, display_name, contact_email, status')
          .eq('id', body.affiliate_id).eq('company_entity_id', company).maybeSingle();
        if (!a) return reply({ error: 'No such affiliate in this company' }, 404);
        // Before anything is minted or mailed: a portal token is that rep's
        // session, so a manager of another program must not be handed one.
        if (!await allowProgram(a.program_id)) return refuseProgram();
        if (!['active', 'paused'].includes(a.status)) return reply({ error: `This affiliate is ${a.status}.` }, 409);
        const { data: co } = await service.from('entities').select('title').eq('id', company).maybeSingle();
        const brand = co?.title || 'Affiliate program';

        if (action === 'portal_link') {
          // Mailing it and handing it back are different things, and a link
          // cannot be both: one that reaches the rep's inbox is bound to that
          // address and carries the brand menu, one the caller receives is
          // not. So email=true mints bound and returns no URL. If the mail
          // did NOT go out, the caller still needs something to send by hand:
          // mint an ordinary link, which revokes the bound one it replaces
          // (affiliate_issue_access_token keeps one live link per subject).
          if (body.email === true) {
            const sent = await mintMailed({ company, program: a.program_id, affiliateId: a.id, mailedTo: a.contact_email, days: PORTAL_LINK_DAYS });
            const { html, text } = renderMail({ brand, heading: 'Your affiliate portal',
              paragraphs: [`Hi ${escapeHtml(a.display_name)}, here is your link to the ${escapeHtml(brand)} affiliate portal: your codes, links, earnings and payouts.`],
              cta: { url: sent.url, label: 'Open my portal' }, footer: `This link is personal to you and works for ${PORTAL_LINK_DAYS} days.` });
            const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
              kind: 'portal_link', to: a.contact_email, subject: `${brand}: your affiliate portal`, html, text, triggeredBy: actor });
            if (mail?.status === 'sent') return reply({ portal_url: null, expires_at: sent.expires_at, email: 'sent', reason: null });
            const fallback = await mint({ company, program: a.program_id, purpose: 'portal', affiliateId: a.id, days: PORTAL_LINK_DAYS, createdBy: actor });
            return reply({ portal_url: fallback.url, expires_at: fallback.expires_at, email: mail?.status ?? 'not_sent', reason: mail?.reason ?? null });
          }
          const link = await mint({ company, program: a.program_id, purpose: 'portal', affiliateId: a.id, days: PORTAL_LINK_DAYS, createdBy: actor });
          return reply({ portal_url: link.url, expires_at: link.expires_at, email: 'not_requested', reason: null });
        }

        const kind = body.kind;
        if (kind === 'codes_and_links') {
          const mail = await sendCodesAndLinks({ company, a, brand, actor });
          if (!mail) return reply({ error: 'This affiliate has no active code or link to send.' }, 409);
          return reply({ email: mail.status, reason: mail.reason ?? null });
        }
        if (kind === 'payout_status') {
          if (!UUID_RE.test(String(body.payout_id || ''))) return reply({ error: 'payout_id is required' }, 400);
          const { data: po } = await service.from('affiliate_payouts').select('id, status, amount_cents, currency, marked_paid_at, external_reference')
            .eq('id', body.payout_id).eq('company_entity_id', company).eq('affiliate_id', a.id).maybeSingle();
          if (!po) return reply({ error: 'No such payout for this affiliate' }, 404);
          // Only states that are TRUE are announced. "Approved" means a person
          // signed off the amount; "paid" means a person recorded the payment
          // with a reference. A draft is not news to send anyone.
          const words = { approved: 'has been approved and is being prepared', exported: 'has been approved and sent for payment', marked_paid: 'has been paid' };
          if (!words[po.status]) return reply({ error: `A ${po.status} payout is not announced to the affiliate.` }, 409);
          // A paid payout is announced ONCE, however many paths or tabs ask
          // (Record as paid, a PayPal send, the Studio's catch-up on load).
          // Two marks on the payout (20261117040000):
          //   paid_notice_done_at    -- terminal: sent, or skipped on purpose.
          //   paid_notice_claimed_at -- a send in flight. One conditional
          //     update takes it, so of two concurrent asks only one sends. A
          //     claim older than PAID_CLAIM_STALE_MS was abandoned (a crash, a
          //     release that failed) and may be taken again; the provider's
          //     idempotency key keeps a retry of an unknown outcome to one email.
          // Unreadable state fails closed -- no claim, no email.
          const paid = po.status === 'marked_paid';
          if (paid) {
            const stale = new Date(Date.now() - PAID_CLAIM_STALE_MS).toISOString();
            const { data: claim, error: claimErr } = await service.from('affiliate_payouts')
              .update({ paid_notice_claimed_at: new Date().toISOString() })
              .eq('id', po.id).eq('company_entity_id', company).eq('status', 'marked_paid').is('paid_notice_done_at', null)
              .or(`paid_notice_claimed_at.is.null,paid_notice_claimed_at.lt.${stale}`)
              .select('id');
            if (claimErr) return reply({ email: 'not_sent', reason: 'could not reserve the payout email; it is tried again later' });
            if (!Array.isArray(claim) || !claim.length) return reply({ email: 'already_sent', reason: null });
            // A send whose done mark was lost is still on the log: finish it, send nothing.
            const { data: prior, error: priorErr } = await service.from('affiliate_notifications').select('id')
              .eq('company_entity_id', company).eq('payout_id', po.id).eq('kind', 'payout_status').eq('status', 'sent').limit(1);
            if (priorErr) return reply({ email: 'not_sent', reason: 'could not read the email log; it is tried again later' });
            if (Array.isArray(prior) && prior.length) {
              await service.from('affiliate_payouts').update({ paid_notice_done_at: new Date().toISOString() }).eq('id', po.id).eq('company_entity_id', company);
              return reply({ email: 'already_sent', reason: null });
            }
          }
          const amount = formatMoney(po.amount_cents, po.currency);
          const paras = [`Hi ${escapeHtml(a.display_name)}, your ${escapeHtml(brand)} affiliate payout of <strong>${escapeHtml(amount)}</strong> ${words[po.status]}.`];
          if (po.status === 'marked_paid' && po.external_reference) paras.push(`Payment reference: ${escapeHtml(po.external_reference)}`);
          const { html, text } = renderMail({ brand, eyebrow: 'Payout', heading: po.status === 'marked_paid' ? `You were paid ${amount}` : 'Payout update', paragraphs: paras });
          const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
            kind, to: a.contact_email, subject: `${brand}: payout ${po.status === 'marked_paid' ? 'paid' : 'update'}`, html, text, triggeredBy: actor,
            ...(paid ? { payoutId: po.id, idempotencyKey: `silo-payout-paid-${po.id}` } : {}) });
          // A send that did not go out for a reason SILO can fix (the
          // do-not-contact check or the mail provider failed) gives the
          // reservation back, so a later load retries. A deliberate skip
          // keeps it: there is no address, or the person asked not to hear.
          // Sent, or skipped on purpose (no address, asked not to hear): done.
          // Anything else gives the claim back so a later load retries; if
          // either write fails, the claim goes stale and is taken again.
          if (paid) {
            const done = mail.status === 'sent' || DELIBERATE_SKIPS.has(mail.reason);
            const { error: markErr } = await service.from('affiliate_payouts')
              .update(done ? { paid_notice_done_at: new Date().toISOString() } : { paid_notice_claimed_at: null })
              .eq('id', po.id).eq('company_entity_id', company);
            if (markErr) console.error('[affiliate-invite] could not record the payout email outcome', markErr.message);
          }
          return reply({ email: mail.status, reason: mail.reason ?? null });
        }
        return reply({ error: 'kind must be codes_and_links or payout_status' }, 400);
      }

      return reply({ error: `Unknown action ${action}` }, 400);
    } catch (err) {
      console.error('[affiliate-invite]', err?.message);
      return reply({ error: String(err?.message || 'Something went wrong').replace(/^[a-z_]+:\s*/, '') }, 500);
    }
  };
}
