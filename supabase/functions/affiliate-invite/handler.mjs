// affiliate-invite -- staff actions that mint affiliate links and send
// affiliates their TRANSACTIONAL mail.
//
// What this function will not do is the point of it:
//   * It never emails a PROSPECT. `signup_link` returns a URL for a person to
//     paste into outreach they send themselves (the export batch carries it).
//     Recruitment mail to someone who never asked is not transactional, and
//     sending it through SILO's provider would put SILO's sending domain
//     behind it.
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
//   signup_link { prospect_id, contact_email? }  -> creates the affiliate (invited) if needed,
//                                                   returns a 14-day signup URL
//   portal_link { affiliate_id, email? }          -> 90-day portal link. email=true MAILS it to the
//                                                   address on file and returns no URL (see mintMailed);
//                                                   otherwise it returns the URL for the caller to send
//   notify      { affiliate_id, kind: 'codes_and_links' | 'payout_status', payout_id? }
//   deliver_code_notices { code_id? }           -> mails "your code is live" for each notice the database
//                                                   owes; no session needed with a code_id, service key without
import { sha256hex, randomToken, sendAffiliateMail, renderMail, escapeHtml, formatMoney, affiliateLink, storeLinkFor } from './affiliate-mail.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
export const SIGNUP_LINK_DAYS = 14;
export const PORTAL_LINK_DAYS = 90;
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
    const { data: codes } = await service.from('affiliate_codes').select('code, starts_on, ends_on, status')
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
    const paras = live
      ? [`Hi ${escapeHtml(a.display_name)}, your ${escapeHtml(brand)} code <strong>${escapeHtml(live)}</strong> is live. Share it, or your link below, and you earn on every sale that uses it.`]
      : [`Hi ${escapeHtml(a.display_name)}, here are your current ${escapeHtml(brand)} affiliate details.`];
    if (codes?.length) paras.push(`<strong>Codes</strong><br>${codes.map((c) => `${escapeHtml(c.code)} (${escapeHtml(dates(c.starts_on, c.ends_on))})`).join('<br>')}`);
    const linkLines = [
      ...(shopLink ? [`${escapeHtml(shopLink)} (your code is applied at checkout)`] : []),
      ...(links || []).map((l) => {
        let u = current ? storeLinkFor(store, current.code, l.destination_url) : null;
        if (!u) {
          const x = new URL(l.destination_url);
          for (const [k, v] of [['utm_source', l.utm_source], ['utm_medium', l.utm_medium], ['utm_campaign', l.utm_campaign]]) if (v) x.searchParams.set(k, v);
          u = x.toString();
        }
        return `${escapeHtml(u)} (${escapeHtml(dates(l.starts_on, l.ends_on))})`;
      }),
    ];
    if (linkLines.length) paras.push(`<strong>Links</strong><br>${linkLines.join('<br>')}`);
    paras.push('A sale counts when the customer uses your code at checkout, within the dates shown.');
    const { html, text } = renderMail({ brand, heading: live ? 'Your code is live' : 'Your codes and links', paragraphs: paras, footer: 'Reply to this email with any questions.' });
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
    if (peek?.action === 'deliver_code_notices') {
      const codeId = UUID_RE.test(String(peek.code_id || '')) ? String(peek.code_id) : null;
      let isService = Boolean(serviceKey) && safeEqual(authHeader, `Bearer ${serviceKey}`);
      if (!isService && !codeId && isServiceToken) {
        try { isService = (await isServiceToken(authHeader.replace(/^Bearer\s+/, ''))) === true; }
        catch { isService = false; }
      }
      if (!codeId && !isService) return reply({ error: 'Unauthorized' }, 401);
      try { return reply({ delivered: await deliverCodeNotices({ code_id: codeId }) }); }
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

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const action = body?.action;

    try {
      if (action === 'signup_link') {
        if (!UUID_RE.test(String(body.prospect_id || ''))) return reply({ error: 'prospect_id is required' }, 400);
        const { data: p } = await service.from('affiliate_prospects')
          .select('id, program_id, display_name, platform, handle, profile_url, contact_email, status')
          .eq('id', body.prospect_id).eq('company_entity_id', company).maybeSingle();
        if (!p) return reply({ error: 'No such prospect in this company' }, 404);
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
        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false });
      }

      if (action === 'portal_link' || action === 'notify') {
        if (!UUID_RE.test(String(body.affiliate_id || ''))) return reply({ error: 'affiliate_id is required' }, 400);
        const { data: a } = await service.from('affiliates')
          .select('id, program_id, display_name, contact_email, status')
          .eq('id', body.affiliate_id).eq('company_entity_id', company).maybeSingle();
        if (!a) return reply({ error: 'No such affiliate in this company' }, 404);
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
          const amount = formatMoney(po.amount_cents, po.currency);
          const paras = [`Hi ${escapeHtml(a.display_name)}, your ${escapeHtml(brand)} affiliate payout of <strong>${escapeHtml(amount)}</strong> ${words[po.status]}.`];
          if (po.status === 'marked_paid' && po.external_reference) paras.push(`Payment reference: ${escapeHtml(po.external_reference)}`);
          const { html, text } = renderMail({ brand, heading: 'Payout update', paragraphs: paras, footer: 'Reply to this email if anything looks wrong.' });
          const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
            kind, to: a.contact_email, subject: `${brand}: payout ${po.status === 'marked_paid' ? 'paid' : 'update'}`, html, text, triggeredBy: actor });
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
