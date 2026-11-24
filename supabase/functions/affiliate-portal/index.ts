// affiliate-portal -- public, token-authorized. See handler.mjs for the model.
//
// Called by the affiliate-facing pages (/v2/affiliates/join.html, portal.html,
// apply.html) with the project's anon key, which verify_jwt accepts, so it
// needs no NO_JWT_FUNCTIONS entry. That header is never read as an identity:
// the link token in the body is the authorization.
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (optional -- without it
// every mail is recorded as skipped and nothing else changes), SILO_APP_URL
// (the link base; falls back to SILO_SITE_URL).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPortalHandler } from './handler.mjs';

const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createPortalHandler({
  service,
  siteUrl: Deno.env.get('SILO_APP_URL') ?? Deno.env.get('SILO_SITE_URL') ?? 'https://get-silo.com',
  resendKey: Deno.env.get('RESEND_API_KEY') ?? '',
  // affiliate-invite makes a waiting code in Shopify by id, no session needed.
  makeShopifyCode: async (codeId: string) => {
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/affiliate-invite`, {
        method: 'POST', signal: ctl.signal,
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_shopify_codes', code_id: codeId }),
      });
    } catch (_) { /* the nightly run makes it */ } finally { clearTimeout(timer); }
  },
  // The same call for a PRODUCT code the database approved as it was asked
  // for (a product the company shared, 20261120030000).
  makeSeedCode: async (seedId: string) => {
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/affiliate-invite`, {
        method: 'POST', signal: ctl.signal,
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_shopify_codes', seed_id: seedId }),
      });
    } catch (_) { /* the nightly run makes it */ } finally { clearTimeout(timer); }
  },
}));
