// Sends the founding invite to an early-access lead the moment they apply.
// Called ONLY by the onboarding-interest function, with the service-role key
// as its bearer. It is off unless ONBOARDING_AUTO_INVITE=true, and the daily
// cap lives in the database (claim_auto_invite), not here. The caller supplies
// just an email: the invite is minted for that stored lead, the link goes to
// that stored address, and nothing in the request chooses a recipient.
const DEFAULT_DAILY_CAP = 100;

type Dependencies = {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  enabled?: boolean;
  dailyCap?: number;
  resendKey?: string;
  mailFrom?: string;
  siteUrl?: string;
  fetch?: typeof globalThis.fetch;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function emailHtml(name: string, company: string, link: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#14181d;border-radius:12px;padding:28px;color:#fff">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em">SILO</div>
      <div style="margin-top:18px;font-size:16px;font-weight:700">Thanks, ${esc(name)} &mdash; set up ${esc(company)} on SILO</div>
      <p style="color:#b8c0c9;font-size:14px;line-height:1.6">
        We received your early-access request. Use the button below to sign in &mdash; or create your account &mdash; with this email address, and setup will start right away.
      </p>
      <a href="${esc(link)}" style="display:inline-block;background:#fff;color:#14181d;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:8px">Create your SILO</a>
      <p style="color:#7f8b96;font-size:12px;margin-top:20px">This link is tied to this email address and expires in 14 days.</p>
    </div>
  </div>`;
}

export function createHandler(deps: Dependencies) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  async function rpc(name: string, args: object) {
    return await fetcher(`${deps.supabaseUrl!.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: deps.serviceRoleKey!,
        Authorization: `Bearer ${deps.serviceRoleKey!}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!deps.supabaseUrl || !deps.serviceRoleKey) return json({ error: 'Unavailable.' }, 503);
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(bearer, deps.serviceRoleKey)) return json({ error: 'Not authorized.' }, 401);
    if (!deps.enabled) return json({ ok: true, skipped: 'disabled' });

    let email = '';
    try {
      const body = await req.json();
      email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    } catch { /* falls through to the check below */ }
    if (!email) return json({ error: 'email required' }, 400);

    const cap = Number.isInteger(deps.dailyCap) && deps.dailyCap! > 0 ? deps.dailyCap! : DEFAULT_DAILY_CAP;
    try {
      const claimRes = await rpc('claim_auto_invite', { p_email: email, p_daily_cap: cap });
      if (!claimRes.ok) return json({ error: 'Unavailable.' }, 503);
      const claim = await claimRes.json();
      if (claim?.claimed !== true) return json({ ok: true, skipped: String(claim?.reason || 'not_claimed') });

      const origin = (deps.siteUrl || 'https://silo-baseballism.com').replace(/\/$/, '');
      const link = `${origin}/v2/company-onboarding.html?invite=${encodeURIComponent(String(claim.token))}`;

      let sent = false;
      if (deps.resendKey) {
        try {
          const mail = await fetcher('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.resendKey}` },
            body: JSON.stringify({
              from: deps.mailFrom || 'SILO <noreply@silo-baseballism.com>',
              to: [claim.email],
              subject: 'Set up your SILO workspace',
              html: emailHtml(String(claim.name || ''), String(claim.company_name || 'your company'), link),
            }),
            signal: AbortSignal.timeout(8000),
          });
          sent = mail.ok;
        } catch { sent = false; }
      }

      // Record the outcome. If this call fails the invite stays pending and the
      // lead stays 'pending' with auto_invited_at set: a person sees it in the
      // queue, and the cap still counts it.
      try { await rpc('finish_auto_invite', { p_invite_id: claim.invite_id, p_sent: sent }); } catch { /* see above */ }
      return json({ ok: true, sent });
    } catch {
      // Never log the request, the token, or the address.
      return json({ error: 'Unavailable.' }, 503);
    }
  };
}
