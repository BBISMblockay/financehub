import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createHandler } from './handler.mjs';

Deno.serve(createHandler({
  createDb: () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
  // Admin-only endpoint: 200 only for a genuine, unexpired service-role token.
  verifyServiceToken: async (token: string) => {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: token, authorization: `Bearer ${token}` },
    });
    await r.body?.cancel();
    return r.ok;
  },
}));
