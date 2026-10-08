// PUBLIC (verify_jwt off): Meta's OAuth redirect target. Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCallbackHandler } from './handler.mjs';

const handle = createCallbackHandler({
  env: {
    META_APP_ID: Deno.env.get('META_APP_ID'),
    META_APP_SECRET: Deno.env.get('META_APP_SECRET'),
    META_OAUTH_REDIRECT_URI: Deno.env.get('META_OAUTH_REDIRECT_URI')
      ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1/meta-oauth-callback`,
    SILO_APP_URL: Deno.env.get('SILO_APP_URL'),
    META_REVIEW_COMPANY_IDS: Deno.env.get('META_REVIEW_COMPANY_IDS'),
  },
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetchImpl: fetch,
});

Deno.serve(handle);
