import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { prepareCoding } from '../card-categorize/prepare.ts';
import { verifySchedulerIdentity } from './oidc.mjs';
import { createScheduledPrepareHandler } from './handler.mjs';

const env = (name: string) => Deno.env.get(name) ?? '';
Deno.serve(createScheduledPrepareHandler({
  env, verifyIdentity: verifySchedulerIdentity,
  createDb: () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')),
  // The same preparation service the bookkeeper's endpoint uses, called with an
  // explicit company and import and no person.
  prepare: prepareCoding,
}));
