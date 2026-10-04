import { createHandler } from './handler.ts';

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
}));
