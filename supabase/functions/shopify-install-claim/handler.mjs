// JWT-auth: a signed-in SILO admin says which workspace a Shopify store that
// was just installed belongs to. Logic in this file so node can execute it;
// index.ts wires the real collaborators.
//
//   POST { action: 'peek',  claim }                     -> the store + the
//        workspaces this person may attach it to, with what each would do
//   POST { action: 'claim', claim, company_entity_id }  -> attach it
//
// The claim token is the one the install callback put in the browser's URL
// fragment. Only its hash is ever stored or compared.
import { mayConnect } from './shopify-auth-lib.mjs';
import { isClaimToken, hashClaim, claimPlan } from './shopify-install-lib.mjs';

export function createClaimHandler({ admin }) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    const user = auth?.user;
    if (!user) return json({ error: 'Sign in first' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const action = body?.action;
    if (!['peek', 'claim'].includes(action) || !isClaimToken(body?.claim)) return json({ error: 'Bad request' }, 400);

    const claimHash = await hashClaim(body.claim);
    const { data: pending } = await admin.from('shopify_pending_installs')
      .select('shop_domain, shop_name, expires_at').eq('claim_hash', claimHash).maybeSingle();
    if (!pending || new Date(pending.expires_at).getTime() <= Date.now()) {
      return json({ outcome: 'expired' }, 410);
    }

    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();

    if (action === 'peek') {
      const { data: memberships, error: membershipError } = await admin.from('entity_memberships')
        .select('entity_id, role, entity:entities!inner(title, entity_type)')
        .eq('user_id', user.id).eq('entity.entity_type', 'company');
      if (profileError || membershipError) return json({ error: 'Could not read your workspaces' }, 500);
      const ids = (memberships ?? []).map((m) => m.entity_id);
      const { data: existing } = ids.length
        ? await admin.from('shopify_connections')
          .select('company_entity_id, is_active, auth_method, oauth_app')
          .eq('shop_domain', pending.shop_domain).in('company_entity_id', ids)
        : { data: [] };
      const byCompany = new Map((existing ?? []).map((c) => [c.company_entity_id, c]));
      const workspaces = (memberships ?? [])
        .filter((m) => mayConnect({ profile, profileError: null, membership: m, membershipError: null, companyId: m.entity_id }))
        .map((m) => ({
          company_entity_id: m.entity_id,
          title: m.entity?.title ?? 'Workspace',
          plan: claimPlan(byCompany.get(m.entity_id) ?? null),
        }));
      return json({
        shop_domain: pending.shop_domain,
        shop_name: pending.shop_name,
        expires_at: pending.expires_at,
        workspaces,
      });
    }

    // claim
    const company = body?.company_entity_id;
    if (typeof company !== 'string' || !/^[0-9a-f-]{36}$/i.test(company)) return json({ error: 'Choose a workspace' }, 400);
    const { data: membership, error: membershipError } = await admin.from('entity_memberships')
      .select('role').eq('entity_id', company).eq('user_id', user.id).maybeSingle();
    if (!mayConnect({ profile, profileError, membership, membershipError, companyId: company })) {
      return json({ error: 'You need to be an admin of that workspace to connect a store' }, 403);
    }
    const { data: rows, error } = await admin.rpc('shopify_claim_pending_install', {
      p_claim_hash: claimHash, p_company: company, p_user: user.id,
    });
    if (error) return json({ error: 'Could not save the connection' }, 500);
    const row = Array.isArray(rows) ? rows[0] : rows;
    const outcome = row?.outcome ?? 'expired';
    const status = outcome === 'expired' ? 410 : outcome === 'connected_other_way' ? 409 : 200;
    return json({ outcome, connection_id: row?.connection_id ?? null, shop_domain: row?.shop_domain ?? pending.shop_domain }, status);
  };
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
