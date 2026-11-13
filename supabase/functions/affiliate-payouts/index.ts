// Thin by design: the handler lives in handler.mjs so it can be driven from
// node (scripts/tests/affiliate-payouts.test.mjs) without a Deno runtime. The
// same split affiliate-invite and stripe-connect use, and for the same reason
// -- an orchestrator no test executes is where this repository has shipped a
// dead-zone reference before.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPayoutsHandler } from './handler.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const service = createClient(SUPABASE_URL, SERVICE_KEY);
const handle = createPayoutsHandler({
  service,
  userClientFor: (jwt: string) => createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  }),
});

Deno.serve(handle);
