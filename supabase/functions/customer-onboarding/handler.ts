// customer-onboarding -- PUBLIC (verify_jwt off): the applicant has no SILO
// login and never will, so the TOKEN is the entire authorization. Same model
// as review-portal and org-invite-redeem.
//
// ── The shape of the trust here ────────────────────────────────────────────
// Nothing in a request body names which account is being acted on. Every
// action resolves the token to an account through
// customer_onboarding_resolve_token(), and that account id is the only one
// used. A body carrying customer_account_id, company_entity_id,
// stripe_customer_id or approved_payment_terms reaches nothing: those columns
// are not constructible from validateSubmission()'s output, and the submission
// RPC does not name them either.
//
// ── Two tokens, on purpose ─────────────────────────────────────────────────
// The emailed onboarding token (14 days) is CONSUMED by the submission, which
// issues a card_setup continuation (2 hours) in the same transaction. The link
// that sits in an inbox for a fortnight is therefore not the link that can
// open a payment-method capture session.
//
// ── Card capture ───────────────────────────────────────────────────────────
// Stripe Checkout in `mode: 'setup'` on the TENANT'S connected account. That
// cannot move money: billing still runs through stripe-invoice, which is
// JWT-only and gated by can_manage_client_invoices(). What this function can
// do is create a customer and save a card against it, both bound to the one
// account its token names.
//
// A retry REPLAYS the same session rather than minting a second one -- the
// rule the Billing surface needed two corrections to get right. See
// decideSetupSession(): only a status Stripe stated definitively releases the
// claim, and an unknown status refuses rather than restarting.
//
// Secrets: STRIPE_SECRET_KEY, SILO_SITE_URL (optional).
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17.7.0';
import {
  ACCOUNT_TYPES,
  CONSENT_TEXT,
  CONSENT_VERSION,
  certificatePath,
  consentIsCurrent,
  decideSetupSession,
  validateSubmission,
} from './onboarding-rules.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const SITE_URL = Deno.env.get('SILO_SITE_URL') ?? 'https://silo-baseballism.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { httpClient: Stripe.createFetchHttpClient() });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

class OnboardingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve a raw token to the account it names, or refuse with a reason a
 * person can act on. "Not found" and "expired" produce different next steps --
 * retype the link, versus ask for a new one -- so they are never collapsed.
 */
async function resolve(token: unknown, purpose: 'onboarding' | 'card_setup') {
  if (typeof token !== 'string' || token.length < 16) {
    throw new OnboardingError('This link is not valid', 404);
  }
  const { data, error } = await db.rpc('customer_onboarding_resolve_token', {
    p_token: token,
    p_purpose: purpose,
  });
  if (error) throw new Error(`customer_onboarding_resolve_token: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    const reason = row?.reason ?? 'not_found';
    const message = reason === 'expired'
      ? 'This link has expired — ask your contact for a new one'
      : reason === 'consumed'
      ? 'This link has already been used'
      : reason === 'revoked'
      ? 'This link was cancelled — ask your contact for a new one'
      : 'This link is not valid';
    throw new OnboardingError(message, reason === 'expired' ? 410 : 404);
  }
  return {
    inviteId: row.invite_id as string,
    accountId: row.customer_account_id as string,
    company: row.company_entity_id as string,
    email: row.email as string,
  };
}

/* The tenant's own name, shown to the applicant. Read here rather than
   trusted from the page: the caller is anonymous and the company comes from
   the resolved token. Falls back to neutral wording rather than a blank, and
   a lookup failure is never fatal -- a missing heading must not cost somebody
   their application. */
async function companyTitle(companyId: string): Promise<string> {
  const { data } = await db
    .from('entities').select('title').eq('id', companyId).maybeSingle();
  return data?.title || 'our team';
}

async function loadAccount(accountId: string) {
  const { data, error } = await db
    .from('customer_accounts')
    .select([
      'id', 'company_entity_id', 'status', 'account_type', 'legal_name', 'contact_email',
      'stripe_customer_id', 'card_setup_status', 'card_setup_session_id',
      'card_setup_attempt', 'card_payment_method_id',
      'card_brand', 'card_last4', 'card_exp_month', 'card_exp_year',
      'default_payment_method_set_at',
      'off_session_consent_at', 'off_session_consent_version',
    ].join(','))
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`customer_accounts: ${error.message}`);
  return data as any;
}

export async function handleCustomerOnboarding(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return reply({ error: 'A JSON body is required' }, 400);
  }

  try {
    switch (body?.action) {
      case 'open_peek':        return reply(await openPeek(body));
      case 'open_submit':      return reply(await openSubmit(body));
      case 'peek':             return reply(await peek(body));
      case 'submit':           return reply(await submit(body));
      case 'certificate_url':  return reply(await certificateUrl(body));
      case 'certificate_done': return reply(await certificateDone(body));
      case 'consent':          return reply(await consent(body));
      case 'start_card_setup': return reply(await startCardSetup(body));
      case 'status':           return reply(await status(body));
      default:                 return reply({ error: `Unknown action ${body?.action}` }, 400);
    }
  } catch (e) {
    if (e instanceof OnboardingError) return reply({ error: e.message }, e.status);
    const message = (e as Error)?.message ?? String(e);
    console.error('customer-onboarding failed', body?.action, message);
    return reply({ error: message }, 502);
  }
}

// ── The open door ──────────────────────────────────────────────────────────
// A shareable link, not an emailed one. There is no token: the URL carries a
// company KEY, and the company must have switched the public form on. A
// company that has not is indistinguishable from one that does not exist --
// the RPC returns no row either way -- so this cannot be used to find out
// which tenants are here.

const OPEN_REASONS: Record<string, { message: string; status: number }> = {
  open_unavailable: {
    message: 'This application link is not active. Ask your contact for a current one.',
    status: 404,
  },
  open_bad_email: { message: 'A valid email address is required', status: 400 },
  open_bad_type: { message: 'Choose an account type from the list', status: 400 },
  open_duplicate: {
    message: 'We already have an application for that email address. '
      + 'Contact us and we will pick it up from there.',
    status: 409,
  },
};

/* Map the RPC's OWN reason codes to something an applicant can act on --
   and nothing else. 28000 is what open_customer_application raises
   deliberately; every other error is a fault, and a fault answered with a
   4xx would tell an applicant their application was rejected when the truth
   is that the database was unreachable, while never reaching console.error
   or the 502 path. The invited door draws the same line. */
function openError(error: { code?: string; message?: string } | string): Error {
  const message = typeof error === 'string' ? error : (error?.message ?? '');
  const deliberate = typeof error === 'string' || error?.code === '28000';
  if (deliberate) {
    for (const [reason, mapped] of Object.entries(OPEN_REASONS)) {
      if (message.includes(reason)) return new OnboardingError(mapped.message, mapped.status);
    }
  }
  return new Error(`open_customer_application: ${message || 'unknown failure'}`);
}

async function openPeek(body: any) {
  const key = String(body?.company ?? '').trim();
  const { data, error } = await db.rpc('peek_open_customer_application', {
    p_company_key: key,
  });
  if (error) throw new Error(`peek_open_customer_application: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.company_entity_id) throw openError('open_unavailable');
  return {
    ok: true,
    open: true,
    company_title: row.company_title ?? 'our team',
    // The applicant chooses, so the page is told what the database will
    // accept rather than carrying its own copy of the list.
    account_types: ACCOUNT_TYPES,
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,
  };
}

async function openSubmit(body: any) {
  const key = String(body?.company ?? '').trim();

  // Same validation, same shape, same refusal as the invited door: a
  // stranger's application is held to exactly the standard an invited one is.
  const { ok, errors, payload } = validateSubmission(body?.form);
  if (!ok) throw new OnboardingError(errors.join('. '), 422);

  // The applicant's own email is the account's contact address. Taken from
  // the PRIMARY contact by name rather than by position -- validateSubmission
  // guarantees a primary exists with a valid email, but not that it is first
  // in the array.
  const primary = (payload.contacts ?? []).find((c: any) => c.contact_type === 'primary');
  const email = String(primary?.email ?? '').trim();

  const { data, error } = await db.rpc('open_customer_application', {
    p_company_key: key,
    p_account_type: String(body?.account_type ?? 'wholesale'),
    p_email: email,
    p_payload: payload,
  });
  if (error) throw openError(error);

  return {
    ok: true,
    customer_account_id: data?.customer_account_id,
    continuation_token: data?.continuation_token,
    expires_at: data?.expires_at,
  };
}

// ── peek: what the form shows before anything is typed ─────────────────────
async function peek(body: any) {
  const tok = await resolve(body?.token, 'onboarding');
  const account = await loadAccount(tok.accountId);
  return {
    ok: true,
    email: tok.email,
    company_title: await companyTitle(tok.company),
    account_type: account.account_type,
    legal_name: account.legal_name,
    status: account.status,
    // Sent so the page renders the exact words that will be stored, rather
    // than its own copy which would drift from the record.
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,
  };
}

// ── submit: the whole application, in one database transaction ─────────────
async function submit(body: any) {
  const tok = await resolve(body?.token, 'onboarding');

  const { ok, errors, payload } = validateSubmission(body?.form);
  if (!ok) throw new OnboardingError(errors.join('. '), 422);

  const { data, error } = await db.rpc('submit_customer_account', {
    p_token: body.token,
    p_payload: payload,
  });
  if (error) {
    // 28000 is what the RPC raises when the token or the account state says
    // the application is over -- a replay after approval, most likely. That is
    // the applicant's answer, not a server fault.
    if (error.code === '28000') {
      throw new OnboardingError('This application has already been completed', 409);
    }
    throw new Error(`submit_customer_account: ${error.message}`);
  }

  return {
    ok: true,
    customer_account_id: tok.accountId,
    continuation_token: (data as any).continuation_token,
    expires_at: (data as any).expires_at,
  };
}

// ── certificate_url: a signed upload URL for the resale certificate ────────
// The applicant is anonymous, so they cannot write to a private bucket under
// any policy. A service-role signed URL bypasses RLS for one object at one
// path -- which is why the bucket has no anon policy: there would be nothing
// behind it.
async function certificateUrl(body: any) {
  const purpose = body?.purpose === 'card_setup' ? 'card_setup' : 'onboarding';
  const tok = await resolve(body?.token, purpose);

  // The path is derived from the resolved account id, never from the request.
  // A filename supplied by the applicant could otherwise carry `../` or point
  // at another account's folder.
  const path = certificatePath(tok.accountId, body?.content_type);
  if (!path) {
    throw new OnboardingError('Upload a PDF, JPG, PNG or HEIC', 415);
  }

  // The tax profile row must exist before the object does: the storage
  // policy's EXISTS reads THIS table, so an object uploaded without it is
  // unreadable by everyone, including the finance user who asked for it.
  //
  // But the row is created WITHOUT the path or the timestamp. Writing those
  // here would record a certificate before one exists, and the upload is a
  // direct browser PUT that can fail after this point -- storage rejects it,
  // the connection drops, the applicant closes the tab. The page treats that
  // failure as non-fatal (the application itself is already saved), so finance
  // would be left with "certificate on file" and a signed link to an object
  // that was never written. `certificate_done` stamps them, and only after
  // confirming the object is really there.
  const { error: tpErr } = await db
    .from('customer_account_tax_profiles')
    .upsert(
      {
        company_entity_id: tok.company,
        customer_account_id: tok.accountId,
      },
      { onConflict: 'customer_account_id' },
    );
  if (tpErr) throw new Error(`customer_account_tax_profiles: ${tpErr.message}`);

  const { data, error } = await db.storage
    .from('customer-account-files')
    .createSignedUploadUrl(path, { upsert: true });
  if (error) throw new Error(`createSignedUploadUrl: ${error.message}`);

  return { ok: true, path, signed_url: data.signedUrl, token: data.token };
}

// ── certificate_done: record the certificate only once it exists ───────────
// Called by the page after its PUT returns ok. It does NOT take the page's
// word for that: it lists the object and matches the name, so a PUT that
// reported success but stored nothing, or a call made without any upload at
// all, records no certificate.
async function certificateDone(body: any) {
  const purpose = body?.purpose === 'card_setup' ? 'card_setup' : 'onboarding';
  const tok = await resolve(body?.token, purpose);

  const path = certificatePath(tok.accountId, body?.content_type);
  if (!path) throw new OnboardingError('Upload a PDF, JPG, PNG or HEIC', 415);
  const name = path.slice(tok.accountId.length + 1);

  const { data: listed, error: listErr } = await db.storage
    .from('customer-account-files')
    .list(tok.accountId, { search: name });
  if (listErr) throw new Error(`storage.list: ${listErr.message}`);
  const found = (listed ?? []).some((o: any) => o?.name === name);
  if (!found) {
    // Not an error the applicant caused, and not one to paper over: the
    // certificate is simply not there, so nothing is recorded and the
    // application stands without it.
    return { ok: false, reason: 'not_found' };
  }

  const { error: tpErr } = await db
    .from('customer_account_tax_profiles')
    .update({
      resale_certificate_path: path,
      resale_certificate_uploaded_at: new Date().toISOString(),
    })
    .eq('customer_account_id', tok.accountId);
  if (tpErr) throw new Error(`customer_account_tax_profiles: ${tpErr.message}`);

  return { ok: true, path };
}

// ── consent: recorded BEFORE a session can be created ──────────────────────
async function consent(body: any) {
  const tok = await resolve(body?.token, 'card_setup');
  if (body?.accepted !== true) {
    throw new OnboardingError('Authorization is required to save a card', 400);
  }
  // The stored text is this module's constant, never what the page sent -- a
  // page that had drifted would otherwise write its own words into the record
  // that exists to prove what was agreed.
  const { error } = await db.rpc('record_customer_account_consent', {
    p_account_id: tok.accountId,
    p_version: CONSENT_VERSION,
    p_text: CONSENT_TEXT,
  });
  if (error) throw new Error(`record_customer_account_consent: ${error.message}`);
  return { ok: true, consent_version: CONSENT_VERSION };
}

// ── start_card_setup ───────────────────────────────────────────────────────
async function startCardSetup(body: any) {
  if (!STRIPE_KEY) throw new OnboardingError('Card capture is not configured', 503);
  const tok = await resolve(body?.token, 'card_setup');
  const account = await loadAccount(tok.accountId);

  if (!consentIsCurrent(account)) {
    throw new OnboardingError('Authorization is required before a card can be saved', 428);
  }

  // The tenant's own connected account. Read from the account's company, never
  // from the request.
  // Only the account id is read. `charges_enabled` is deliberately NOT a gate
  // here: setup mode saves a payment method and moves no money, so a tenant
  // still finishing Stripe onboarding can collect a card from a customer
  // already signing up. Selecting a capability flag and then ignoring it reads
  // like a check that is not there, so it is not selected at all.
  const { data: connected, error: connErr } = await db
    .from('stripe_connect_accounts')
    .select('stripe_account_id')
    .eq('company_entity_id', tok.company)
    .maybeSingle();
  if (connErr) throw new Error(`stripe_connect_accounts: ${connErr.message}`);
  if (!connected?.stripe_account_id) {
    throw new OnboardingError('This merchant is not set up to take cards yet', 409);
  }
  const opts = { stripeAccount: connected.stripe_account_id };

  // ── An existing session is REPLAYED, never replaced ──────────────────────
  const { data: claimRows, error: claimErr } = await db.rpc('claim_customer_card_setup', {
    p_account_id: tok.accountId,
  });
  if (claimErr) throw new Error(`claim_customer_card_setup: ${claimErr.message}`);
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as any;
  let attempt = (claim?.attempt ?? 0) as number;

  if (!claim?.allowed) {
    if (claim?.reason === 'already_captured') {
      return { ok: true, already_captured: true };
    }
    if (claim?.reason === 'consent_required') {
      throw new OnboardingError('Authorization is required before a card can be saved', 428);
    }
    if (claim?.reason === 'session_open' && claim.existing_session_id) {
      // Ask Stripe rather than believing the mirror -- and let ITS answer
      // decide. An error that is not a definitive "gone" refuses: a network
      // blip reading as "expired" is how a second live session gets opened
      // beside the one the applicant still has open.
      const existing = await lookupSession(claim.existing_session_id, opts);
      const decision = decideSetupSession(existing.status);
      if (decision.action === 'replay') {
        return { ok: true, url: existing.url, replayed: true };
      }
      if (decision.action === 'refuse') {
        if (decision.reason === 'already_completed') {
          return { ok: true, already_captured: true };
        }
        throw new OnboardingError(
          'The card step could not be checked just now — please try again shortly', 503);
      }
      // 'restart': Stripe stated the session is expired or gone. The release
      // bumps the attempt, and the create below MUST use the bumped value --
      // reusing the one read before it would replay the expired session's
      // idempotency key and hand out its dead URL.
      const { data: bumped, error: relErr } = await db.rpc('release_customer_card_setup', {
        p_company: tok.company, p_session_id: claim.existing_session_id,
      });
      if (relErr) throw new Error(`release_customer_card_setup: ${relErr.message}`);
      if (bumped == null) {
        // Nothing was released: another delivery or tab moved this account on
        // while we were asking Stripe. Re-read rather than creating a session
        // against a state that no longer holds.
        throw new OnboardingError(
          'The card step moved on while it was being checked — please reload', 409);
      }
      // The release left the row 'abandoned'. It must be CLAIMED again before a
      // session is created, or note_customer_card_setup_session() -- which only
      // writes against a live claim -- would land nowhere and the applicant
      // would be told to try again, forever. (Found by re-reading the
      // integrated path: both halves were individually correct and the seam
      // between them was not.)
      const { data: reclaimRows, error: reclaimErr } = await db.rpc(
        'claim_customer_card_setup', { p_account_id: tok.accountId });
      if (reclaimErr) throw new Error(`claim_customer_card_setup: ${reclaimErr.message}`);
      const reclaim = (Array.isArray(reclaimRows) ? reclaimRows[0] : reclaimRows) as any;
      if (!reclaim?.allowed) {
        throw new OnboardingError(
          'The card step moved on while it was being checked — please reload', 409);
      }
      attempt = reclaim.attempt as number;
    } else if (claim?.reason === 'session_open') {
      // Claimed, but no session id recorded: a previous attempt was killed
      // between taking the claim and hearing back from Stripe. There is
      // nothing to ask Stripe about yet, and the claim goes stale on its own
      // in ten minutes -- so say that, rather than "not available", which
      // reads as a permanent refusal for a state that clears itself.
      throw new OnboardingError(
        'The card step is already being started — try again in a few minutes', 409);
    } else {
      throw new OnboardingError('The card step is not available for this application', 409);
    }
  }

  // ── The Stripe customer ──────────────────────────────────────────────────
  let customerId: string | null = account.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        name: account.legal_name ?? undefined,
        email: account.contact_email ?? undefined,
        metadata: {
          silo_company_entity_id: tok.company,
          silo_customer_account_id: tok.accountId,
        },
      },
      // Keyed on the ACCOUNT, not on an attempt: every retry for this
      // applicant replays the same key, so Stripe returns the first customer
      // rather than making a second one whose invoice history would split.
      { ...opts, idempotencyKey: `silo-customer-account-${tok.accountId}` },
    );
    customerId = customer.id;

    // Bind before the session exists. A crash between these two calls leaves a
    // bound customer and no session -- recoverable. The reverse would leave a
    // session against a customer SILO has no record of, which the webhook
    // would then reject as a customer_mismatch.
    const { error: bindErr } = await db.rpc('bind_customer_account_stripe_customer', {
      p_account_id: tok.accountId, p_customer_id: customerId,
    });
    if (bindErr) throw new Error(`bind_customer_account_stripe_customer: ${bindErr.message}`);

    await db.rpc('stripe_sync_invoice_customer', {
      p_company: tok.company,
      p_account: connected.stripe_account_id,
      p_payload: JSON.parse(JSON.stringify(customer)),
      p_synced_at: new Date().toISOString(),
    });
  }

  // ── The setup session ────────────────────────────────────────────────────
  const returnBase = `${SITE_URL}/v2/customer-onboarding.html?token=${encodeURIComponent(body.token)}`;
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'setup',
      customer: customerId!,
      // No `currency`: it is optional in setup mode with a card, and asserting
      // USD here would be SILO guessing on behalf of a tenant whose Connect
      // account may be denominated in something else. Omitting it lets the
      // account's own currency stand.
      payment_method_types: ['card'],
      // `setup_intent_data` accepts description / metadata / on_behalf_of and
      // NOTHING ELSE -- Stripe rejects an unknown parameter outright, so a
      // `usage: 'off_session'` here (the first version of this call) would have
      // made every card-setup attempt fail at Stripe. It was also redundant:
      // a SetupIntent's `usage` already defaults to off_session, which is the
      // behaviour the consent text authorises. `deno check` against the pinned
      // types is what caught it; the fake Stripe in the handler suite could
      // not, which is why that suite now pins the accepted keys.
      setup_intent_data: {
        metadata: {
          silo_company_entity_id: tok.company,
          silo_customer_account_id: tok.accountId,
        },
      },
      metadata: {
        silo_company_entity_id: tok.company,
        silo_customer_account_id: tok.accountId,
      },
      success_url: `${returnBase}&card=saved`,
      cancel_url: `${returnBase}&card=cancelled`,
    },
    // The attempt -- not the status -- is what distinguishes one session from
    // the next. See card_setup_attempt's comment in the migration.
    { ...opts, idempotencyKey: `silo-setup-${tok.accountId}-${attempt}` },
  );

  // Fail-closed: if SILO cannot record which session this is, the webhook that
  // completes it has no account to attach the card to -- so the URL is not
  // handed out at all.
  const { data: noted, error: noteErr } = await db.rpc('note_customer_card_setup_session', {
    p_account_id: tok.accountId, p_session_id: session.id,
  });
  if (noteErr) throw new Error(`note_customer_card_setup_session: ${noteErr.message}`);
  if (noted !== true) {
    throw new OnboardingError(
      'The card step could not be started just now — please try again shortly', 503);
  }

  return { ok: true, url: session.url, replayed: false };
}

/**
 * What Stripe says about a session. ONLY a definitive 404/resource_missing is
 * "gone"; every other failure is reported as unknown, because a catch-all that
 * returned "missing" would let a 5xx release the claim and open a second
 * payable session beside one still open.
 */
async function lookupSession(sessionId: string, opts: any) {
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId, opts);
    return { status: s.status as string, url: s.url as string | null };
  } catch (e: any) {
    const missing = e?.statusCode === 404 || e?.code === 'resource_missing';
    return { status: missing ? 'missing' : null, url: null };
  }
}

// ── status: what the page polls after returning from Stripe ────────────────
async function status(body: any) {
  const tok = await resolve(body?.token, 'card_setup');
  const account = await loadAccount(tok.accountId);
  return {
    ok: true,
    status: account.status,
    card_setup_status: account.card_setup_status,
    // Carried for the same reason as consent_text below: somebody returning
    // from Stripe holds only the card-setup token, and the page still has to
    // name the company they are applying to.
    company_title: await companyTitle(tok.company),
    // Carried here as well as on peek(), because someone who reloads after
    // submitting holds only the CARD-SETUP token -- peek would (correctly)
    // refuse it, and the card screen still has to render the exact words the
    // authorisation will be stored as.
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,
    // Display metadata only. There is nothing else stored to return.
    card: account.card_payment_method_id || account.card_last4
      ? {
        brand: account.card_brand,
        last4: account.card_last4,
        exp_month: account.card_exp_month,
        exp_year: account.card_exp_year,
        is_invoice_default: !!account.default_payment_method_set_at,
      }
      : null,
  };
}
