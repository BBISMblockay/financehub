import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createHandler, githubDispatcher } from './handler.mjs';
const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
Deno.serve(createHandler({ service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  }),
  dispatch: githubDispatcher({ token: Deno.env.get('INTEGRATION_BOOTSTRAP_GITHUB_TOKEN') || '' }),
  log: console.error,
}));
