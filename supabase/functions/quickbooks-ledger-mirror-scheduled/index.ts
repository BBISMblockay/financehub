import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { verifySchedulerIdentity } from './oidc.mjs';
import { createLedgerMirrorHandler } from './handler.mjs';

const env = (name: string) => Deno.env.get(name) ?? '';
Deno.serve(createLedgerMirrorHandler({
  env, verifyIdentity: verifySchedulerIdentity,
  createDb: () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')),
  fetchImpl: fetch,
}));
