// JWT-auth: the App Review test page's only server entry point
// (/testing/meta-oauth.html). Every action re-checks the review workspace and
// the review row. Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createReviewHandler } from './handler.mjs';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';

const handle = createReviewHandler({
  env: {
    META_REVIEW_COMPANY_IDS: Deno.env.get('META_REVIEW_COMPANY_IDS'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    // debug_token must be called with an APP credential, not the token being
    // inspected. Both are already set for meta-oauth-callback's code exchange;
    // Supabase secrets are project-wide, so nothing new has to be configured.
    META_APP_ID: Deno.env.get('META_APP_ID'),
    META_APP_SECRET: Deno.env.get('META_APP_SECRET'),
  },
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetchImpl: fetch,
  checkIntegration: (authorization: string) => checkIntegrationToken(authorization),
  checkMfa: (authorization: string) => checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization,
  }),
});

Deno.serve(handle);
