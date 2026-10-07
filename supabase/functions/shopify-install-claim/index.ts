// JWT-auth: attach a just-installed Shopify store to a SILO workspace.
// Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClaimHandler } from './handler.mjs';

const handle = createClaimHandler({
  admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
});

Deno.serve(handle);
