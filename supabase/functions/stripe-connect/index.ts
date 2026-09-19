// stripe-connect -- JWT-auth: onboard a tenant onto their OWN Stripe account
// (Connect Standard) and keep SILO's mirror of its capabilities current.
//
// Actions:
//   start   -- create the connected account if the company has none, then mint
//              a fresh hosted-onboarding AccountLink and return its URL.
//   refresh -- re-fetch the account from Stripe and sync. Called on return
//              from onboarding, by the Refresh button, and by the invoicing
//              page when it needs to know whether invoicing works yet.
//
// THE COMPANY IS NEVER TAKEN FROM THE REQUEST BODY. It is read from the
// caller's own `profiles.active_company_id` with the service-role client. A
// body-supplied company id is caller-controlled input, and here it would mean
// attaching a Stripe account to somebody else's tenant.
//
// Gate: is_owner_admin_of_active_company(). Connecting a merchant account
// commits the company's legal identity and its payout bank account; 28 of 29
// Baseballism profiles are membership 'admin', so is_admin_user() is not the
// right authority for that. The gate is evaluated by a CALLER-SCOPED client,
// so it is the database's answer about this user, not a claim this function
// makes on their behalf (the payment-request-notify pattern).
//
// An AccountLink is single-use and expires in minutes, so `start` always mints
// a new one and NEVER stores it.
//
// Secrets: STRIPE_SECRET_KEY. Link base: SILO_SITE_URL (default
// https://silo-baseballism.com).
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17.7.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const SITE_URL = Deno.env.get('SILO_SITE_URL') ?? 'https://silo-baseballism.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { httpClient: Stripe.createFetchHttpClient() });

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!STRIPE_KEY) return reply({ error: 'STRIPE_SECRET_KEY is not configured' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !user) return reply({ error: 'Unauthorized' }, 401);

  const { data: profile } = await db
    .from('profiles')
    .select('active_company_id, is_active, email, name')
    .eq('id', user.id)
    .single();

  if (!profile?.is_active) return reply({ error: 'Account is not active' }, 403);
  const company = profile.active_company_id;
  if (!company) {
    return reply({ error: 'No active company. Sign in again and pick a company.' }, 400);
  }

  // The gate, answered by the database AS THIS USER.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: isOwnerAdmin } = await caller.rpc('is_owner_admin_of_active_company');
  if (!isOwnerAdmin) {
    return reply({ error: 'Only an owner-admin can connect the company Stripe account' }, 403);
  }

  const { action, return_path } = await req.json().catch(() => ({}));

  const { data: existing } = await db
    .from('stripe_connect_accounts')
    .select('stripe_account_id, account_type')
    .eq('company_entity_id', company)
    .maybeSingle();

  try {
    if (action === 'refresh') {
      if (!existing?.stripe_account_id) return reply({ connected: false });
      return reply(await syncAccount(company, existing.stripe_account_id));
    }

    if (action !== 'start') return reply({ error: `Unknown action ${action}` }, 400);

    let accountId = existing?.stripe_account_id ?? null;

    if (!accountId) {
      // Creating a connected account is CLAIMED per company before Stripe is
      // called. Two tabs (or a double-click on a slow link) otherwise both
      // read no row and both create an account, and the tenant ends up with
      // two merchant identities in their own Stripe -- which is their real
      // business record and cannot be deleted from here. The claim is a row
      // rather than a lock because it spans an HTTP call.
      const { data: claimRows, error: claimErr } = await db.rpc('stripe_claim_connect_setup', {
        p_company: company, p_user: user.id,
      });
      if (claimErr) throw new Error(`stripe_claim_connect_setup: ${claimErr.message}`);
      const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;

      if (claim?.outcome === 'in_flight') {
        return reply({
          error: 'Stripe setup for this company is already in progress — finish it in the tab '
            + 'that started it, or wait a moment and refresh. Starting again here would open a '
            + 'second Stripe account in your name.',
        }, 409);
      }

      if (claim?.outcome === 'adopt') {
        // A previous attempt got an account out of Stripe and died before the
        // mirror write. Adopt it; creating another would duplicate a real
        // merchant account for the sake of a lost response.
        accountId = claim.stripe_account_id;
        await syncAccount(company, accountId!);
        await db.rpc('stripe_release_connect_setup', { p_company: company });
      } else if (claim?.outcome === 'claimed') {
        const { data: entity } = await db
          .from('entities').select('title').eq('id', company).maybeSingle();

        // Standard: the client owns the account, keeps their own dashboard, and
        // carries their own dispute liability. See the migration header for why
        // SILO does not take that on.
        const account = await stripe.accounts.create({
          type: 'standard',
          email: profile.email ?? undefined,
          business_profile: { name: entity?.title ?? undefined },
          // Stamped so an account found in SILO's Stripe dashboard can be traced
          // back to a tenant. NEVER read back as authorization -- the client
          // owns this account and can edit its metadata.
          metadata: { silo_company_entity_id: company, silo_created_by: user.id },
        });
        accountId = account.id;

        // Recorded against the claim FIRST, before the mirror write: this is
        // the line that makes a crash in the next few milliseconds recoverable
        // rather than a second Stripe account ten minutes later.
        await db.rpc('stripe_note_connect_setup_account', {
          p_company: company, p_account: account.id,
        });

        // Persist BEFORE handing the browser to Stripe: if the redirect is lost,
        // the next `start` must resume this account rather than create a second
        // one. A second connected account is not a duplicate row somebody can
        // delete -- it is a second merchant identity in the client's Stripe.
        await rpc('stripe_sync_connect_account', {
          p_company: company, p_payload: account, p_synced_at: new Date().toISOString(),
        });

        // The mirror is now the record; the claim has done its job. Released
        // only on success -- a failure above deliberately LEAVES the claim
        // standing, so a retry hits `adopt` or `in_flight` rather than
        // creating a second account.
        await db.rpc('stripe_release_connect_setup', { p_company: company });
      } else {
        // already_bound: another attempt completed between this function's
        // first read and its claim.
        const { data: bound } = await db
          .from('stripe_connect_accounts')
          .select('stripe_account_id')
          .eq('company_entity_id', company)
          .maybeSingle();
        accountId = bound?.stripe_account_id ?? null;
        if (!accountId) throw new Error('Connect setup is already bound but no account is readable');
      }
    }

    const base = `${SITE_URL}/v2/invoicing.html`;
    const link = await stripe.accountLinks.create({
      account: accountId,
      // refresh_url is where Stripe sends the user when the link has EXPIRED
      // (they are single-use and short-lived), so it must lead somewhere that
      // can mint a new one rather than to a dead page.
      refresh_url: `${base}?stripe=refresh`,
      return_url: `${base}?stripe=return${return_path ? `&next=${encodeURIComponent(return_path)}` : ''}`,
      type: 'account_onboarding',
    });

    return reply({ url: link.url, stripe_account_id: accountId });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.error('stripe-connect failed', message);
    return reply({ error: message }, 502);
  }
});

async function syncAccount(company: string, accountId: string) {
  const account = await stripe.accounts.retrieve(accountId);
  await rpc('stripe_sync_connect_account', {
    p_company: company, p_payload: account, p_synced_at: new Date().toISOString(),
  });
  // Returned from the FETCH, not from the mirror: the caller asked what Stripe
  // says, and reading the row back would answer with whatever the monotonic
  // guard decided to keep.
  return {
    connected: true,
    stripe_account_id: account.id,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    details_submitted: account.details_submitted,
    disabled_reason: (account.requirements as any)?.disabled_reason ?? null,
    currently_due: (account.requirements as any)?.currently_due ?? [],
  };
}

async function rpc(name: string, args: Record<string, unknown>) {
  const payload = JSON.parse(JSON.stringify(args.p_payload));
  const { error } = await db.rpc(name, { ...args, p_payload: payload });
  if (error) throw new Error(`${name}: ${error.message}`);
}
