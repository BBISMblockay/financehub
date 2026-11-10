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
//   portal_link { affiliate_id, email? }          -> 90-day portal URL; mails it if email=true
//   notify      { affiliate_id, kind: 'codes_and_links' | 'payout_status', payout_id? }
import { sha256hex, randomToken, sendAffiliateMail, renderMail, escapeHtml, formatMoney } from './affiliate-mail.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
export const SIGNUP_LINK_DAYS = 14;
export const PORTAL_LINK_DAYS = 90;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export function createInviteHandler({ service, userClientFor, siteUrl, resendKey, fetchImpl = fetch, now = () => new Date(), makeToken = randomToken }) {
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

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authHeader)) return reply({ error: 'Unauthorized' }, 401);

    // 1. Authority, answered by the database AS THE CALLER. An error here is a
    //    refused session (expired, password-only with 2FA enrolled, revoked
    //    integration token) and aborts before any service-role call.
    const caller = userClientFor(authHeader);
    const { data: mayManage, error: gateErr } = await caller.rpc('can_manage_affiliate_programs');
    if (gateErr) return reply({ error: 'Your session could not be verified. Sign in again.' }, 401);
    if (mayManage !== true) return reply({ error: 'Managing affiliates needs Affiliate Studio access for this company.' }, 403);
    const { data: company, error: coErr } = await caller.rpc('active_company_id');
    if (coErr || !company) return reply({ error: 'No active company. Pick a company and try again.' }, 400);
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

        let { data: aff } = await service.from('affiliates').select('id, status')
          .eq('company_entity_id', company).eq('from_prospect_id', p.id).maybeSingle();
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
          const link = await mint({ company, program: a.program_id, purpose: 'portal', affiliateId: a.id, days: PORTAL_LINK_DAYS, createdBy: actor });
          let mail = null;
          if (body.email === true) {
            const { html, text } = renderMail({ brand, heading: 'Your affiliate portal',
              paragraphs: [`Hi ${escapeHtml(a.display_name)}, here is your link to the ${escapeHtml(brand)} affiliate portal: your codes, links, earnings and payouts.`],
              cta: { url: link.url, label: 'Open my portal' }, footer: `This link is personal to you and works for ${PORTAL_LINK_DAYS} days.` });
            mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
              kind: 'portal_link', to: a.contact_email, subject: `${brand}: your affiliate portal`, html, text, triggeredBy: actor });
          }
          return reply({ portal_url: link.url, expires_at: link.expires_at, email: mail?.status ?? 'not_requested', reason: mail?.reason ?? null });
        }

        const kind = body.kind;
        if (kind === 'codes_and_links') {
          const { data: codes } = await service.from('affiliate_codes').select('code, starts_on, ends_on, status')
            .eq('company_entity_id', company).eq('affiliate_id', a.id).eq('status', 'active');
          const { data: links } = await service.from('affiliate_links').select('destination_url, utm_source, utm_medium, utm_campaign, starts_on, ends_on')
            .eq('company_entity_id', company).eq('affiliate_id', a.id).eq('status', 'active');
          if (!codes?.length && !links?.length) return reply({ error: 'This affiliate has no active code or link to send.' }, 409);
          const dates = (s, e) => `${s}${e ? ` to ${e}` : ' onward'}`;
          const paras = [`Hi ${escapeHtml(a.display_name)}, here are your current ${escapeHtml(brand)} affiliate details.`];
          if (codes?.length) paras.push(`<strong>Codes</strong><br>${codes.map((c) => `${escapeHtml(c.code)} (${escapeHtml(dates(c.starts_on, c.ends_on))})`).join('<br>')}`);
          if (links?.length) paras.push(`<strong>Links</strong><br>${links.map((l) => {
            const u = new URL(l.destination_url);
            for (const [k, v] of [['utm_source', l.utm_source], ['utm_medium', l.utm_medium], ['utm_campaign', l.utm_campaign]]) if (v) u.searchParams.set(k, v);
            return `${escapeHtml(u.toString())} (${escapeHtml(dates(l.starts_on, l.ends_on))})`;
          }).join('<br>')}`);
          paras.push('A sale counts when the customer uses your code at checkout, within the dates shown.');
          const { html, text } = renderMail({ brand, heading: 'Your codes and links', paragraphs: paras, footer: 'Reply to this email with any questions.' });
          const mail = await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: a.program_id, affiliateId: a.id,
            kind, to: a.contact_email, subject: `${brand}: your affiliate codes and links`, html, text, triggeredBy: actor });
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
