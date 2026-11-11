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
}));
