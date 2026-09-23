import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCategorizeHandler } from './prepare.ts';

Deno.serve(createCategorizeHandler({
  createDb: () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
}));
