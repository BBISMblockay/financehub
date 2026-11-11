// affiliate-discovery-run -- JWT-auth "Search now" for Affiliate Studio. See
// handler.mjs.
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, DATAFORSEO_LOGIN and
// DATAFORSEO_PASSWORD (the same search account the weekly GitHub workflow
// uses; without them the function answers 503 and the weekly run still works).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createDiscoveryRunHandler } from './handler.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createDiscoveryRunHandler({
  service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  credentials: {
    login: Deno.env.get('DATAFORSEO_LOGIN') ?? '',
    password: Deno.env.get('DATAFORSEO_PASSWORD') ?? '',
  },
}));
