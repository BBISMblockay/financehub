// Thin wrapper: identify the caller, establish their company, then run
// handler.mjs. See that file for what the test actually does.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';
import { runKlaviyoTest } from './handler.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authorization = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authorization.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  // Third-party tokens (20261020030000): the reads below use the service role,
  // which the Data API's pre-request hook never sees. Pure check first.
  const integ = checkIntegrationToken(authorization);
  if (!integ.ok) return json({ error: integ.message, code: integ.code }, integ.status);

  // Two-step login (20261014000000): this function works only with the service
  // role after getUser, so it must ask the gate as the caller.
  const mfa = await checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization,
  });
  if (!mfa.ok) return json({ error: mfa.message, code: mfa.code }, mfa.status);

  // The company is the caller's own active company, never a value from the
  // body (supabase/functions/CLAUDE.md), and the caller must administer it:
  // the credential this test exercises is readable only by an admin.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, active_company_id, is_active')
    .eq('id', user.id)
    .maybeSingle();
  const companyEntityId = profile?.active_company_id || null;
  if (!profile || profile.is_active !== true || !companyEntityId) {
    return json({ error: 'No active company for this user' }, 403);
  }
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', companyEntityId)
    .eq('user_id', user.id)
    .maybeSingle();
  const isAdmin = membership
    ? ['owner_admin', 'admin'].includes(String(membership.role))
    : ['owner', 'admin', 'executive'].includes(String(profile.role));
  if (!isAdmin) return json({ error: 'Admin access required' }, 403);

  const { status, body } = await runKlaviyoTest({ supabase, companyEntityId });
  return json(body, status);
});
