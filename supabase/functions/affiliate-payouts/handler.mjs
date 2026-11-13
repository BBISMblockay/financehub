// affiliate-payouts -- sends a company's approved affiliate payouts from THAT
// COMPANY's own PayPal business account.
//
// WHOSE MONEY THIS IS
//
// SILO's platform PayPal is not in the path, holds nothing and funds nothing.
// The credentials used here belong to the company, the balance debited is the
// company's, and the company is the payer of record for its own affiliates --
// their 1099s, their liability. That is not a detail: a platform-funded rail
// would make SILO a party to its customers' payroll. See
// docs/ops/affiliate-studio.md.
//
// WHAT IT WILL NOT DO
//   * It never takes the company from the request body. The company is the
//     caller's own active company, read through their JWT.
//   * It never decides authority itself. The FIRST thing it does is ask the
//     database, AS THE CALLER, whether they may approve affiliate money -- a
//     caller-token PostgREST call whose error aborts, which is also what makes
//     the two-step-login and third-party-token hooks apply here
//     (supabase/functions/CLAUDE.md). Only then does it use the service role.
//   * It never pays a payout a person has not approved. `send` refuses
//     anything that is not already approved, in the database, under the
//     program money lock.
//   * It never decides that a payment happened. Every state written here is
//     what PayPal answered, and a call that did not answer leaves the attempt
//     in state `unknown`, which BLOCKS another attempt until it has been
//     reconciled. An HTTP call to a payment API has three outcomes, not two.
//
// Actions (all POST, all JWT-authenticated):
//   status                                      -> is the rail connected, and what did it last do
//   connect { environment, client_id, client_secret }
//                                               -> verify the credentials against PayPal, then store
//   disconnect                                  -> stop using it; the secret is cleared
//   test                                        -> re-verify the stored credentials
//   send { payout_id }                          -> claim an attempt and send it
//   refresh { payout_id? }                      -> re-read open attempts from PayPal and record them

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

// The same zero-decimal set as public.affiliate_currency_minor_units(), which
// is what every money column in this module is stored in. Pinned identical by
// scripts/tests/affiliate-payouts.test.mjs: a mismatch would send 100x or
// 1/100th of the amount owed, in real money, silently.
export const ZERO_DECIMAL = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
export const minorUnits = (currency) => (ZERO_DECIMAL.includes(String(currency || '').toUpperCase()) ? 1 : 100);

// Minor units -> the decimal string PayPal wants. Done with integers, never
// with a float: (1999 / 100).toFixed(2) is fine and 0.1 + 0.2 is not, and a
// money path should not have to know which case it is in.
export function majorAmount(cents, currency) {
  const units = minorUnits(currency);
  const n = BigInt(cents);
  if (units === 1) return n.toString();
  // The sign is carried separately. BigInt division truncates toward zero, so
  // -5n / 100n is 0n and a naive version would turn -5 cents into "0.05".
  // Nothing should hand this a negative amount (affiliate_payouts refuses one),
  // which is exactly why it must not be quietly wrong if anything ever does.
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, '0')}`;
}

// PayPal's transaction_status vocabulary -> SILO's narrower one. Anything
// unrecognised stays `sent`: an unknown status is "we do not know yet", never
// "paid" and never "it failed", and the provider's own word is kept alongside.
export const ITEM_STATE = {
  SUCCESS: 'paid',
  UNCLAIMED: 'unclaimed',
  RETURNED: 'returned',
  REFUNDED: 'returned',
  REVERSED: 'returned',
  CANCELED: 'returned',
  CANCELLED: 'returned',
  FAILED: 'refused',
  DENIED: 'refused',
  BLOCKED: 'refused',
  PENDING: 'sent',
  PROCESSING: 'sent',
  ONHOLD: 'sent',
  NEW: 'sent',
};
export const itemState = (status) => ITEM_STATE[String(status || '').toUpperCase()] || 'sent';

// A batch PayPal refused or cancelled outright, with no items to read: in
// those states nothing was paid, so recording a refusal (which frees another
// attempt) is safe. Every OTHER batch status with no items is treated as still
// open, because the money may have gone.
export const BATCH_REFUSED = ['DENIED', 'CANCELED', 'CANCELLED'];

export function createPayoutsHandler({ service, userClientFor, fetchImpl = fetch, now = () => new Date() }) {
  // ── PayPal plumbing ──────────────────────────────────────────────────────
  async function token({ environment, client_id, client_secret }) {
    const host = PAYPAL_HOSTS[environment];
    const basic = btoa(`${client_id}:${client_secret}`);
    const res = await fetchImpl(`${host}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = body?.error_description || body?.message || `HTTP ${res.status}`;
      const err = new Error(`PayPal would not accept these credentials: ${why}`);
      err.status = res.status === 401 ? 400 : 502;
      throw err;
    }
    return body.access_token;
  }

  async function paypal(creds, path, { method = 'GET', body, requestId } = {}) {
    const access = await token(creds);
    const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };
    // The idempotency key. The SAME attempt replayed after a timeout is
    // recognised by PayPal as the same request rather than paid twice.
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetchImpl(`${PAYPAL_HOSTS[creds.environment]}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { ok: res.ok, status: res.status, body: parsed, raw: text };
  }

  // PayPal rejects a sender_batch_id reused within 30 days and answers with a
  // link to the ORIGINAL batch. That is a 4xx, and it must never be read as a
  // refusal: the batch exists and may already have paid, so treating it as
  // "nothing moved" is how the same commission gets paid twice.
  const DUPLICATE_RE = /ALREADY_EXISTS|ALREADY_USED|DUPLICATE|IDEMPOTEN/i;
  const isDuplicate = (e) => DUPLICATE_RE.test(`${e.code} ${e.message}`);
  // The original batch's id, out of the HATEOAS links PayPal sends with that
  // error (or anywhere else in the answer it appears).
  function batchIdFrom(body) {
    const links = Array.isArray(body?.links) ? body.links : [];
    for (const l of links) {
      const m = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)/.exec(String(l?.href || ''));
      if (m) return m[1];
    }
    // Nothing else. A value GUESSED out of an error body could be any token
    // PayPal happened to name, and a wrong batch id here would be read as
    // this payout's own payment below.
    return body?.batch_header?.payout_batch_id || null;
  }

  const paypalError = (r) => {
    const d = Array.isArray(r.body?.details) ? r.body.details[0] : null;
    return {
      code: d?.issue || r.body?.name || `HTTP_${r.status}`,
      message: d?.description || r.body?.message || r.raw?.slice(0, 300) || `HTTP ${r.status}`,
    };
  };

  // Is the Payouts API actually usable with these credentials? A GET for a
  // batch id that cannot exist answers without sending anybody money:
  // "not found" means the API is ours to call, while an authorization failure
  // means PayPal has not enabled Payouts on the account yet -- which is a
  // configuration state the company fixes at PayPal, not an outage.
  async function probePayouts(creds) {
    const r = await paypal(creds, '/v1/payments/payouts/SILO0PROBE0NOTABATCH');
    if (r.status === 404 || r.status === 400 || r.status === 422) return { payouts_enabled: true };
    if (r.status === 401 || r.status === 403) {
      const e = paypalError(r);
      return { payouts_enabled: false, error: `PayPal has not enabled Payouts on this account yet (${e.code}). Request access at paypal.com/payoutsweb/landing.` };
    }
    if (r.ok) return { payouts_enabled: true };
    const e = paypalError(r);
    return { payouts_enabled: null, error: `PayPal answered ${e.code}: ${e.message}` };
  }

  // ── Connection row ───────────────────────────────────────────────────────
  async function connectionFor(company) {
    const { data, error } = await service
      .from('affiliate_payout_connections')
      .select('*').eq('company_entity_id', company).eq('provider', 'paypal').maybeSingle();
    if (error) throw new Error(`affiliate_payout_connections: ${error.message}`);
    return data || null;
  }

  // What the browser is allowed to know. Never the credentials.
  const publicStatus = (c) => (c ? {
    connected: Boolean(c.is_active && c.client_id && c.client_secret),
    environment: c.environment,
    account_email: c.account_email,
    payouts_enabled: c.payouts_enabled,
    last_tested_at: c.last_tested_at,
    last_test_success: c.last_test_success,
    last_test_error: c.last_test_error,
    last_send_at: c.last_send_at,
  } : { connected: false });

  async function saveTest(company, patch) {
    const { error } = await service.from('affiliate_payout_connections')
      .update({ ...patch, updated_at: now().toISOString() })
      .eq('company_entity_id', company).eq('provider', 'paypal');
    if (error) throw new Error(`affiliate_payout_connections: ${error.message}`);
  }

  // ── Recording an answer ──────────────────────────────────────────────────
  async function record(sendId, state, extra = {}) {
    const { error } = await service.rpc('affiliate_payout_send_record', {
      p_send: sendId,
      p_state: state,
      p_provider_batch_id: extra.batchId ?? null,
      p_provider_item_id: extra.itemId ?? null,
      p_provider_status: extra.providerStatus ?? null,
      p_error_code: extra.errorCode ?? null,
      p_error_message: extra.errorMessage ?? null,
      p_fee_cents: extra.feeCents ?? null,
      p_actor: extra.actor ?? null,
    });
    if (error) throw new Error(`affiliate_payout_send_record: ${error.message}`);
  }

  // One open attempt, re-read from PayPal and recorded. Used by `refresh` and
  // straight after a send, so the page never has to guess.
  async function reconcile(creds, send, actor) {
    // The attempt and the connection must be the same PayPal account. A
    // company that tests in sandbox and then connects live still has its
    // sandbox attempts open, and an attempt with no batch id is RE-POSTED
    // below: re-posting a sandbox attempt to the live host would be a real
    // payment nobody asked for, and polling a sandbox batch id on live just
    // 404s forever. Neither is allowed to be silent.
    if (send.environment && creds.environment && send.environment !== creds.environment) {
      throw Object.assign(
        new Error(`This attempt was made on the ${send.environment} PayPal account. Reconnect that account to check it.`),
        { status: 409 },
      );
    }
    if (!send.provider_batch_id) {
      // PayPal collapses a repeated batch id for THIRTY DAYS and no longer.
      // Past that the replay below would not be answered with the original
      // batch, it would create a second payment -- so it is refused, and the
      // key is named for someone to look up in their PayPal activity.
      const ageDays = send.created_at
        ? (now().getTime() - new Date(send.created_at).getTime()) / 86400000
        : 0;
      if (ageDays > 29) {
        return {
          state: send.state,
          code: 'KEY_EXPIRED',
          message: `This attempt is ${Math.floor(ageDays)} days old. PayPal stops recognising a repeated batch id after 30 days, so asking again could pay a second time. Look up ${send.sender_batch_id} in your PayPal activity, then void this payout and build it again if nothing was sent.`,
        };
      }
      // The attempt never got as far as a batch id. We cannot tell from here
      // whether PayPal accepted it, and the key is what makes asking safe:
      // re-POSTing the same PayPal-Request-Id returns the original batch
      // rather than creating a second one.
      const r = await paypal(creds, '/v1/payments/payouts', {
        method: 'POST', requestId: send.request_id, body: batchBody(send),
      });
      if (r.ok || r.status === 201) {
        const batchId = r.body?.batch_header?.payout_batch_id || null;
        await record(send.id, 'sent', { batchId, providerStatus: r.body?.batch_header?.batch_status, actor });
        return { state: 'sent', batch_id: batchId };
      }
      const e = paypalError(r);
      if (r.status >= 400 && r.status < 500 && isDuplicate(e)) {
        // This attempt was already accepted. Pick the original batch up and
        // read its real state instead of calling it refused.
        const existing = batchIdFrom(r.body);
        if (!existing) return { state: 'unknown', ...e };
        await record(send.id, 'sent', { batchId: existing, providerStatus: e.code, actor });
        return reconcile(creds, { ...send, provider_batch_id: existing, state: 'sent' }, actor);
      }
      if (r.status >= 400 && r.status < 500) {
        await record(send.id, 'refused', { errorCode: e.code, errorMessage: e.message, actor });
        return { state: 'refused', ...e };
      }
      return { state: 'unknown', ...e };
    }

    const r = await paypal(creds, `/v1/payments/payouts/${encodeURIComponent(send.provider_batch_id)}`);
    if (!r.ok) {
      const e = paypalError(r);
      return { state: send.state, ...e };
    }
    // Is this batch this attempt's? The id can reach here from PayPal's own
    // duplicate error, so it is checked against the key WE chose before a
    // single word of it is believed. Marking a payout paid from somebody
    // else's batch is the worst outcome available to this function.
    const theirs = r.body?.batch_header?.sender_batch_header?.sender_batch_id || null;
    if (theirs && send.sender_batch_id && theirs !== send.sender_batch_id) {
      return {
        state: send.state,
        code: 'BATCH_NOT_OURS',
        message: `PayPal batch ${send.provider_batch_id} belongs to ${theirs}, not to this attempt. Nothing was changed.`,
      };
    }
    const batchStatus = r.body?.batch_header?.batch_status;
    const items = r.body?.items || [];
    // The item we sent, by our own sender_item_id. A batch already proved to
    // be ours (its sender_batch_id is the key we chose) and holding exactly
    // one item is that item, whatever PayPal calls the field -- otherwise a
    // field moving in their response would leave the attempt stuck in `sent`
    // forever. A batch holding several items is only ever read by the id.
    const senderItemId = (x) => x?.payout_item?.sender_item_id ?? x?.sender_item_id ?? null;
    const item = items.find((x) => senderItemId(x) === send.request_id)
      || (items.length === 1 && !senderItemId(items[0]) ? items[0] : null);
    if (!item) {
      if (items.length) {
        return {
          state: send.state,
          code: 'ITEM_NOT_OURS',
          message: `PayPal batch ${send.provider_batch_id} holds no item for this attempt. Nothing was changed.`,
        };
      }
      if (BATCH_REFUSED.includes(String(batchStatus || '').toUpperCase())) {
        await record(send.id, 'refused', { providerStatus: batchStatus, errorCode: batchStatus, errorMessage: 'PayPal refused the batch.', actor });
        return { state: 'refused', providerStatus: batchStatus };
      }
      return { state: send.state, providerStatus: batchStatus };
    }
    const state = itemState(item.transaction_status);
    const fee = item.payout_item_fee?.value;
    const errs = item.errors || null;
    await record(send.id, state, {
      batchId: r.body?.batch_header?.payout_batch_id || send.provider_batch_id,
      itemId: item.payout_item_id || null,
      providerStatus: item.transaction_status || batchStatus,
      errorCode: errs?.name || null,
      errorMessage: errs?.message || null,
      feeCents: fee == null ? null : Math.round(Number(fee) * minorUnits(item.payout_item_fee?.currency || send.currency)),
      actor,
    });
    return { state, providerStatus: item.transaction_status, item_id: item.payout_item_id || null };
  }

  function batchBody(send) {
    return {
      sender_batch_header: {
        sender_batch_id: send.sender_batch_id,
        email_subject: 'You have an affiliate payment',
        email_message: 'Your affiliate commission has been sent.',
      },
      items: [{
        recipient_type: 'EMAIL',
        receiver: send.payout_email,
        amount: { value: majorAmount(send.amount_cents, send.currency), currency: send.currency },
        sender_item_id: send.request_id,
        note: 'Affiliate commission',
      }],
    };
  }

  // ── The handler ──────────────────────────────────────────────────────────
  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply({ error: 'Unauthorized' }, 401);
    const { data: { user } = {}, error: authErr } = await service.auth.getUser(jwt);
    if (authErr || !user) return reply({ error: 'Unauthorized' }, 401);

    // THE GATE, asked of the database as this user, before anything else and
    // before any service-role call. Money authority, not the manager gate:
    // can_approve_affiliate_commissions() is the same gate journal entries
    // use, and causing a payment is not something an affiliate manager may do
    // on their own.
    const caller = userClientFor(jwt);
    const { data: mayApprove, error: gateErr } = await caller.rpc('can_approve_affiliate_commissions');
    if (gateErr) return reply({ error: gateErr.message }, 403);
    if (!mayApprove) {
      return reply({ error: 'Sending an affiliate payout needs the same authority as approving one.' }, 403);
    }

    const { data: profile } = await service
      .from('profiles').select('active_company_id, is_active').eq('id', user.id).single();
    if (!profile?.is_active) return reply({ error: 'Account is not active' }, 403);
    const company = profile.active_company_id;
    if (!company) return reply({ error: 'No active company. Sign in again and pick a company.' }, 400);

    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    try {
      if (action === 'status') {
        return reply(publicStatus(await connectionFor(company)));
      }

      if (action === 'connect') {
        const environment = body.environment === 'live' ? 'live' : 'sandbox';
        const client_id = String(body.client_id || '').trim();
        const client_secret = String(body.client_secret || '').trim();
        if (!client_id || !client_secret) return reply({ error: 'Both the client ID and the secret are needed.' }, 400);

        // Verified BEFORE it is stored: a credential that does not work is
        // not a connection, and storing it would leave the page claiming the
        // rail is ready.
        await token({ environment, client_id, client_secret });
        const probe = await probePayouts({ environment, client_id, client_secret });

        const row = {
          company_entity_id: company, provider: 'paypal', environment,
          client_id, client_secret, is_active: true,
          payouts_enabled: probe.payouts_enabled,
          last_tested_at: now().toISOString(),
          last_test_success: probe.payouts_enabled !== false,
          last_test_error: probe.error ?? null,
          updated_at: now().toISOString(), updated_by: user.id,
        };
        const existing = await connectionFor(company);
        if (existing) {
          const { error } = await service.from('affiliate_payout_connections')
            .update(row).eq('company_entity_id', company).eq('provider', 'paypal');
          if (error) throw new Error(error.message);
        } else {
          const { error } = await service.from('affiliate_payout_connections')
            .insert({ ...row, created_by: user.id });
          if (error) throw new Error(error.message);
        }
        return reply({ ...publicStatus(await connectionFor(company)), warning: probe.error ?? null });
      }

      if (action === 'test') {
        const c = await connectionFor(company);
        if (!c?.client_id || !c?.client_secret) return reply({ error: 'PayPal is not connected yet.' }, 400);
        try {
          await token(c);
          const probe = await probePayouts(c);
          await saveTest(company, {
            payouts_enabled: probe.payouts_enabled,
            last_tested_at: now().toISOString(),
            last_test_success: probe.payouts_enabled !== false,
            last_test_error: probe.error ?? null,
          });
        } catch (e) {
          await saveTest(company, {
            last_tested_at: now().toISOString(), last_test_success: false, last_test_error: e.message,
          });
          return reply({ ...publicStatus(await connectionFor(company)), error: e.message }, 400);
        }
        return reply(publicStatus(await connectionFor(company)));
      }

      if (action === 'disconnect') {
        const { error } = await service.from('affiliate_payout_connections')
          .update({
            is_active: false, client_secret: null, payouts_enabled: null,
            last_test_error: null, last_test_success: null,
            updated_at: now().toISOString(), updated_by: user.id,
          })
          .eq('company_entity_id', company).eq('provider', 'paypal');
        if (error) throw new Error(error.message);
        return reply({ connected: false });
      }

      if (action === 'send') {
        const payoutId = String(body.payout_id || '');
        if (!UUID_RE.test(payoutId)) return reply({ error: 'A payout id is required.' }, 400);
        const c = await connectionFor(company);
        if (!c?.is_active || !c.client_id || !c.client_secret) {
          return reply({ error: 'Connect PayPal first.' }, 400);
        }

        // The database decides whether this payout may be sent and reserves
        // the attempt, inside the program money lock. Everything that could
        // make this wrong -- not approved, no address, already in flight, an
        // earlier attempt that never answered -- is refused there rather than
        // here, because two tabs reach this code at the same time and only
        // the database can serialise them.
        const { data: claim, error: claimErr } = await service.rpc('affiliate_payout_send_claim', {
          // The company is the CALLER's own, read from their profile above. It
          // is the tenant boundary for this call: the function runs as the
          // service role, so RLS is not.
          p_payout: payoutId, p_company: company, p_environment: c.environment, p_actor: user.id,
        });
        if (claimErr) return reply({ error: claimErr.message }, 409);

        const send = {
          id: claim.send_id,
          request_id: claim.request_id,
          sender_batch_id: claim.sender_batch_id,
          amount_cents: claim.amount_cents,
          currency: claim.currency,
          payout_email: claim.payout_email,
          environment: c.environment,
          provider_batch_id: null,
          state: 'unknown',
        };

        let outcome;
        try {
          outcome = await reconcile(c, send, user.id);
        } catch (e) {
          // The call itself fell over. The attempt stays `unknown`, which is
          // the truth: it may have been accepted. The next `refresh` replays
          // the same idempotency key and finds out.
          return reply({
            state: 'unknown',
            error: `PayPal did not answer (${e.message}). The payment may have gone through — use Check status before trying again.`,
          }, 502);
        }

        await saveTest(company, { last_send_at: now().toISOString() });

        // One immediate re-read, so a payment that already succeeded shows as
        // paid rather than leaving the page saying "sent" for a minute.
        if (outcome.state === 'sent' && outcome.batch_id) {
          try {
            const after = await reconcile(c, { ...send, provider_batch_id: outcome.batch_id, state: 'sent' }, user.id);
            outcome = { ...outcome, ...after };
          } catch { /* the state on file is already correct and refreshable */ }
        }
        return reply(outcome);
      }

      if (action === 'refresh') {
        const c = await connectionFor(company);
        if (!c?.client_id || !c?.client_secret) return reply({ error: 'PayPal is not connected yet.' }, 400);
        let q = service.from('affiliate_payout_sends')
          .select('id, payout_id, request_id, sender_batch_id, provider_batch_id, amount_cents, currency, payout_email, state, environment, created_at')
          .eq('company_entity_id', company)
          .in('state', ['unknown', 'sent', 'unclaimed'])
          .order('created_at', { ascending: true })
          .limit(50);
        if (body.payout_id) {
          if (!UUID_RE.test(String(body.payout_id))) return reply({ error: 'A payout id is required.' }, 400);
          q = q.eq('payout_id', body.payout_id);
        }
        const { data: open, error } = await q;
        if (error) throw new Error(`affiliate_payout_sends: ${error.message}`);

        const results = [];
        for (const send of open || []) {
          try {
            results.push({ payout_id: send.payout_id, ...(await reconcile(c, send, user.id)) });
          } catch (e) {
            results.push({ payout_id: send.payout_id, state: send.state, error: e.message });
          }
        }
        return reply({ checked: results.length, results });
      }

      return reply({ error: `Unknown action ${action}` }, 400);
    } catch (e) {
      return reply({ error: e.message }, e.status || 500);
    }
  };
}
