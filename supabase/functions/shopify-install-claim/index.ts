// JWT-auth: attach a just-installed Shopify store to a SILO workspace.
// Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClaimHandler } from './handler.mjs';
import { checkMfaSession } from './mfa-gate.mjs';

const handle = createClaimHandler({
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  checkMfa: (authorization: string) => checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization,
  }),
});

Deno.serve(handle);
