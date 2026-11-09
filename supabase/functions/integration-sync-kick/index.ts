import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createHandler } from './handler.mjs';
import { syncKlaviyoConnection } from './lib/klaviyo-sync-core.mjs';
import { syncRedoMarketingConnection } from './lib/redo-marketing-sync-core.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// The OAuth app's credentials, read from the SERVER's environment and never
// from the request. An OAuth connection whose access token has expired cannot
// be refreshed without them, and the core answers that with a plain error --
// so a kick on an expired grant would have failed where the nightly, which
// passes these, succeeds. Absent (a deployment with no Klaviyo OAuth app),
// nothing changes: a private-key connection never reaches the refresh path.
const klaviyoOauth = {
  clientId: Deno.env.get('KLAVIYO_CLIENT_ID') ?? '',
  clientSecret: Deno.env.get('KLAVIYO_CLIENT_SECRET') ?? '',
};

Deno.serve(createHandler({
  service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  // Keyed by the `core` name in KICK_INTEGRATIONS, so the request path never
  // branches on which integration it is holding. Per-integration server
  // credentials are closed over here rather than threaded through the handler,
  // which has no business holding them.
  cores: {
    syncKlaviyoConnection: (args: Record<string, unknown>) =>
      syncKlaviyoConnection({ ...args, ...klaviyoOauth }),
    syncRedoMarketingConnection,
  },
  log: console.log,
}));
