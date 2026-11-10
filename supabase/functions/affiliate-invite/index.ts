// affiliate-invite -- JWT-auth staff actions for Affiliate Studio: mint signup
// and portal links, and send affiliates transactional mail. Never emails a
// prospect. See handler.mjs.
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, RESEND_API_KEY
// (optional: without it every mail is recorded as skipped), SILO_APP_URL.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createInviteHandler } from './handler.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createInviteHandler({
  service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  siteUrl: Deno.env.get('SILO_APP_URL') ?? Deno.env.get('SILO_SITE_URL') ?? 'https://get-silo.com',
  resendKey: Deno.env.get('RESEND_API_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
}));
