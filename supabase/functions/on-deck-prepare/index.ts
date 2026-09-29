import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createHandler } from './handler.mjs';

Deno.serve(createHandler({
  createDb: () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
}));
