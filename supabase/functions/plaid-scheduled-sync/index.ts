import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { handlePlaidFinance } from '../plaid-finance/handler.ts';
import { verifySchedulerIdentity } from './oidc.mjs';
import { createScheduledHandler } from './handler.mjs';

const env = (name: string) => Deno.env.get(name) ?? '';
Deno.serve(createScheduledHandler({
  env, verifyIdentity: verifySchedulerIdentity,
  createDb: () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')),
  // In-process call: the platform never rewrites or forwards this credential.
  // Reuse the existing account/tenant checks, sync leases and atomic ingestion.
  syncAccount: (id: string) => handlePlaidFinance(new Request('https://internal.invalid/plaid-finance', {
    method: 'POST', headers: { Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'sync_background', account_id: id }),
  })),
}));
