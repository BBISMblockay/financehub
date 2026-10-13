import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCategorizeHandler } from './prepare.ts';
import { checkMfaSession } from './mfa-gate.mjs';

Deno.serve(createCategorizeHandler({
  createDb: () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  checkMfa: (authorization: string) => checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization,
  }),
}));
