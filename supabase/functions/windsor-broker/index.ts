// JWT-auth: Windsor.ai tenant broker (test phase). Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createWindsorHandler } from './handler.mjs';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';

const handle = createWindsorHandler({
  env: { WINDSOR_API_KEY: Deno.env.get('WINDSOR_API_KEY') },
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetchImpl: (url: string, init: RequestInit) => fetch(url, init),
  checkIntegration: (authorization: string) => checkIntegrationToken(authorization),
  checkMfa: (authorization: string) => checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization,
  }),
});

Deno.serve(handle);
