// JWT-auth: the App Review test page's only server entry point
// (/testing/meta-oauth.html). Every action re-checks the review workspace and
// the review row. Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createReviewHandler } from './handler.mjs';

const handle = createReviewHandler({
  env: {
    META_REVIEW_COMPANY_IDS: Deno.env.get('META_REVIEW_COMPANY_IDS'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
  },
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetchImpl: fetch,
});

Deno.serve(handle);
