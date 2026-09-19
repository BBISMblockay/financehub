// Loads a Stripe Edge Function's REAL handler and runs it under node.
//
// The four handlers are roughly a thousand lines of orchestration that no test
// executed until this existed: `deno check` proves types, not behaviour, and
// the database suite proves the SQL those handlers call, not the calling. This
// repo has already shipped a dead-zone reference inside an orchestrator whose
// core carried 91 passing assertions (CLAUDE.md, 2026-09-09), which is exactly
// the shape that was left open here.
//
// Same mechanism as scripts/tests/plaid-finance-handler.test.mjs: read
// handler.ts, strip the types, strip the Deno-only imports, and run it in a vm
// whose globals are fakes. Nothing is re-implemented -- the code under test is
// the code that deploys.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const ROOT = new URL('../../../', import.meta.url);

/**
 * A Supabase double that stores rows and applies the .eq()/.is() filters the
 * handlers actually use, so an assertion can be about WHICH row was read or
 * written rather than about a call having happened.
 */
export function fakeSupabase({
  tables = {}, rpcs = {}, user = null, authError = false, gates = {}, storage = {},
} = {}) {
  const calls = [];
  const store = new Map(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const rowsOf = (t) => { if (!store.has(t)) store.set(t, []); return store.get(t); };
  const matches = (row, filters) => filters.every(([kind, col, val]) =>
    kind === 'is' ? (row[col] ?? null) === val : row[col] === val);

  function builder(table, op, payload) {
    const filters = [];
    const state = { columns: null, head: false };
    const resolve = () => {
      const hit = rowsOf(table).filter((r) => matches(r, filters));
      if (op === 'select') {
        calls.push({ query: table, op, filters: [...filters] });
        return { data: hit, error: null, count: hit.length };
      }
      for (const row of hit) Object.assign(row, payload);
      calls.push({ query: table, op, filters: [...filters], payload, affected: hit.length });
      return { data: hit, error: null, count: hit.length };
    };
    const api = {
      select(columns, opts = {}) { state.columns = columns; state.head = !!opts.head; return api; },
      eq(col, val) { filters.push(['eq', col, val]); return api; },
      is(col, val) { filters.push(['is', col, val]); return api; },
      order() { return api; },
      limit() { return api; },
      async maybeSingle() { const r = resolve(); return { data: r.data[0] ?? null, error: r.error }; },
      async single() {
        const r = resolve();
        return r.data[0]
          ? { data: r.data[0], error: null }
          : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      },
      then(onFulfilled, onRejected) { return Promise.resolve(resolve()).then(onFulfilled, onRejected); },
    };
    return api;
  }

  const client = {
    auth: {
      async getUser(jwt) {
        calls.push({ auth: 'getUser', jwt });
        if (authError || !user || !jwt) return { data: { user: null }, error: { message: 'bad jwt' } };
        return { data: { user }, error: null };
      },
    },
    from: (table) => ({
      select: (columns, opts) => builder(table, 'select').select(columns, opts),
      update: (patch) => builder(table, 'update', patch),
      insert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const r of list) rowsOf(table).push({ ...r });
        calls.push({ query: table, op: 'insert', payload: list });
        return Promise.resolve({ data: list, error: null });
      },
      // Enough of PostgREST's upsert to exercise the tax-profile write: match
      // on the declared conflict column, merge if present, insert if not.
      upsert: (rows, opts = {}) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const key = opts.onConflict;
        for (const r of list) {
          const hit = key ? rowsOf(table).find((x) => x[key] === r[key]) : null;
          if (hit) Object.assign(hit, r); else rowsOf(table).push({ ...r });
        }
        calls.push({ query: table, op: 'upsert', payload: list, onConflict: key });
        return Promise.resolve({ data: list, error: null });
      },
    }),
    storage: {
      from: (bucket) => ({
        async createSignedUploadUrl(path, opts) {
          calls.push({ storage: bucket, op: 'createSignedUploadUrl', path, opts });
          const scripted = storage[`${bucket}:${path}`] ?? storage[bucket];
          if (scripted instanceof Error) return { data: null, error: { message: scripted.message } };
          return {
            data: { signedUrl: `https://storage.test/${bucket}/${path}?t=sig`, token: 'upload-token' },
            error: null,
          };
        },
      }),
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (!(name in rpcs)) throw new Error(`fake-supabase: unstubbed rpc ${name}`);
      const handler = rpcs[name];
      const out = typeof handler === 'function' ? await handler(args) : handler;
      return out && Object.prototype.hasOwnProperty.call(out, 'data')
        ? out : { data: out ?? null, error: null };
    },
  };

  // The caller-scoped client the handlers build with the anon key and the
  // user's Authorization header. It exists so a gate is the DATABASE's answer
  // about this user rather than a claim the function makes on their behalf, so
  // the double keeps it separate: its rpc results come from `gates`, and the
  // key and header it was built with are recorded and asserted.
  const callerClient = (key, opts) => ({
    async rpc(name, args) {
      calls.push({ gate: name, args, key, authorization: opts?.global?.headers?.Authorization ?? null });
      if (!(name in gates)) throw new Error(`fake-supabase: unstubbed gate ${name}`);
      const value = typeof gates[name] === 'function' ? await gates[name](args) : gates[name];
      return { data: value, error: null };
    },
  });

  return { client, callerClient, calls, store, rowsOf };
}

/**
 * A Stripe double. Every method records its call and returns whatever the
 * script says; a scripted Error is thrown instead, so failure paths are
 * exercised rather than described.
 */
export function fakeStripe(script = {}) {
  const calls = [];
  const answer = (path, args) => {
    calls.push({ path, args });
    const scripted = script[path];
    const value = typeof scripted === 'function' ? scripted(args, calls) : scripted;
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`fake-stripe: unscripted call ${path}`);
    return value;
  };
  const m = (path) => async (...args) => answer(path, args);

  const Stripe = function StripeCtor() {
    return {
      webhooks: { constructEventAsync: m('webhooks.constructEventAsync') },
      checkout: { sessions: {
        retrieve: m('checkout.sessions.retrieve'), create: m('checkout.sessions.create'),
        expire: m('checkout.sessions.expire'),
      } },
      subscriptions: { retrieve: m('subscriptions.retrieve'), list: m('subscriptions.list') },
      invoices: {
        retrieve: m('invoices.retrieve'), list: m('invoices.list'), create: m('invoices.create'),
        finalizeInvoice: m('invoices.finalizeInvoice'), sendInvoice: m('invoices.sendInvoice'),
        voidInvoice: m('invoices.voidInvoice'), markUncollectible: m('invoices.markUncollectible'),
      },
      invoiceItems: { create: m('invoiceItems.create') },
      customers: {
        create: m('customers.create'), retrieve: m('customers.retrieve'),
        update: m('customers.update'),
      },
      // The setup-mode capture path: Checkout attaches the method to the
      // Customer, the SetupIntent is what names it, and making it the invoice
      // default is a third, separate call. All three are doubled so the
      // "attached but not default" state can be exercised rather than assumed.
      setupIntents: { retrieve: m('setupIntents.retrieve') },
      paymentMethods: { retrieve: m('paymentMethods.retrieve') },
      accounts: { create: m('accounts.create'), retrieve: m('accounts.retrieve') },
      accountLinks: { create: m('accountLinks.create') },
      billingPortal: { sessions: { create: m('billingPortal.sessions.create') } },
    };
  };
  Stripe.createFetchHttpClient = () => ({});
  Stripe.createSubtleCryptoProvider = () => ({});
  return { Stripe, calls, pathsCalled: () => calls.map((c) => c.path) };
}

const HANDLERS = {
  'stripe-webhook': 'handleStripeWebhook',
  'stripe-connect': 'handleStripeConnect',
  'stripe-invoice': 'handleStripeInvoice',
  'stripe-billing': 'handleStripeBilling',
  'customer-onboarding': 'handleCustomerOnboarding',
};

/**
 * @param mutate  optional (source) => source, to break a guard deliberately and
 *                prove the assertion that covers it actually fails.
 */
export async function loadHandler(fn, { config = {}, db, stripe, modules = {}, mutate } = {}) {
  const name = HANDLERS[fn];
  if (!name) throw new Error(`unknown function ${fn}`);
  const source = await readFile(new URL(`supabase/functions/${fn}/handler.ts`, ROOT), 'utf8');

  let code = source
    .replace(/import \{ createClient \} from 'npm:@supabase\/supabase-js@2';\n/, '')
    .replace(/import Stripe from 'npm:stripe@[\d.]+';\n/, '')
    .replace(/import \{[\s\S]*?\} from '\.\/[\w-]+\.mjs';\n/g, '')
    .replace(`export async function ${name}`, `async function ${name}`)
    + `\nDeno.serve(${name});\n`;
  if (mutate) {
    const before = code;
    code = mutate(code);
    if (code === before) throw new Error(`${fn}: mutation matched nothing`);
  }

  const runnable = stripTypeScriptTypes(code, { mode: 'strip' });

  let served = null;
  const env = {
    SUPABASE_URL: 'https://silo.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SUPABASE_ANON_KEY: 'anon-key',
    STRIPE_SECRET_KEY: 'sk_test_synthetic',
    SILO_SITE_URL: 'https://silo.test',
    ...config,
  };

  vm.runInNewContext(runnable, {
    ...modules,
    Request, Response, URL, URLSearchParams, crypto: webcrypto,
    console: { log() {}, error() {}, warn() {} },
    // The service client and the caller-scoped client are told apart exactly as
    // the handlers build them: the second one carries the user's Authorization.
    createClient: (_url, key, opts) =>
      (opts?.global?.headers?.Authorization ? db.callerClient(key, opts) : db.client),
    Stripe: stripe.Stripe,
    Deno: { env: { get: (k) => env[k] }, serve: (cb) => { served = cb; } },
  }, { filename: `${fn}/handler.ts` });

  if (!served) throw new Error(`${fn}: handler never reached Deno.serve`);
  return async function request({ method = 'POST', body, headers = {}, jwt = 'good-jwt' } = {}) {
    const res = await served(new Request('https://silo.test/fn', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...headers,
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    }));
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  };
}
