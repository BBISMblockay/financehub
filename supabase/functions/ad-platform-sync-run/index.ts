import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createHandler } from './handler.mjs';
import { runConnectionSync } from './lib/ad-platforms-sync-core.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createHandler({
  service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  googleEnv: {
    GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
    GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
    GOOGLE_ADS_DEVELOPER_TOKEN: Deno.env.get('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '',
  },
  runConnectionSync,
}));
