// JWT-auth: start Facebook Login for Business for Meta Ads. Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createStartHandler } from './handler.mjs';

const handle = createStartHandler({
  env: {
    META_APP_ID: Deno.env.get('META_APP_ID'),
    META_LOGIN_CONFIG_ID: Deno.env.get('META_LOGIN_CONFIG_ID'),
    META_OAUTH_REDIRECT_URI: Deno.env.get('META_OAUTH_REDIRECT_URI')
      ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1/meta-oauth-callback`,
    META_REVIEW_COMPANY_IDS: Deno.env.get('META_REVIEW_COMPANY_IDS'),
  },
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
});

Deno.serve(handle);
