import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { createHandler } from './handler.mjs';

// Caller-scoped reads only. No remote document URLs or DB writes.
// The service key is read for ONE purpose: the ai_credit_* RPCs (revoked from
// anon and authenticated), so a browser cannot settle its own extraction at
// zero. Without it the extraction is unmetered, exactly as before credits.
Deno.serve(createHandler({
  makeClient: createClient,
  env: (name: string) => Deno.env.get(name) || '',
  makeCreditClient: () => {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    return key ? createClient(Deno.env.get('SUPABASE_URL') || '', key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  },
}));
