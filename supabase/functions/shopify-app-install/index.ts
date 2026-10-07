// PUBLIC (verify_jwt off): Shopify opens this URL. Logic in handler.mjs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createInstallHandler } from './handler.mjs';

const handle = createInstallHandler({
  env: {
    SHOPIFY_PUBLIC_CLIENT_ID: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_ID'),
    SHOPIFY_PUBLIC_CLIENT_SECRET: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_SECRET'),
    SILO_APP_URL: Deno.env.get('SILO_APP_URL'),
    SHOPIFY_INSTALL_CALLBACK_URL: Deno.env.get('SHOPIFY_INSTALL_CALLBACK_URL')
      ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1/shopify-app-install`,
  },
  db: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetchImpl: fetch,
});

Deno.serve(handle);
