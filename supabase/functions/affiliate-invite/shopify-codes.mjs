// SILO makes an affiliate's discount code in the brand's Shopify itself
// (Blake 2026-11-17: "We ask a lot of user to use silo"). Before this, a
// person's own AI did it over MCP (codes:create, 20261110160000); that route
// stays, and a code SILO cannot make here simply waits for it, as before.
//
// Pure apart from fetch: the handler passes the connection and token in.
//
// What it makes is exactly what silo_api_codes_to_create tells an AI to make:
// a discount CODE (not automatic), the exact code text, percent_off off the
// whole order, all products, all customers, starting at the start of
// starts_on and ending at the end of ends_on in the company's timezone, no
// minimum, no usage limit. A discount SILO already made with this exact code
// (titled "Affiliate: ...") is adopted, never duplicated -- that is what makes
// a retry safe. A DIFFERENT discount that happens to use the text (a store
// promo, someone else's code) is never adopted: crediting matches orders by
// code text, so adopting it would pay this affiliate for every order that
// used the promo. That is refused as 'taken'.
//
// Fail soft, by name, never by guessing:
//   needs_scope  the store has not granted write_discounts (reconnect)
//   no_store     the program has no single Shopify store SILO can tell
//   taken        the store already has another discount with this code
//   failed       Shopify said no, or did not answer
// In every one of those the code stays 'pending'.

export const CODE_SCOPE = 'write_discounts';
export const DEFAULT_API_VERSION = '2025-01';

/**
 * The one Shopify connection a program's codes go in, or null.
 * The program's own pick (shop_domains, exactly one), else the store address
 * when it is a connected myshopify domain, else the company's only active
 * store. Several and no pick means the brand says which: never a guess.
 */
export function pickConnection(program, connections) {
  const live = (connections || []).filter((c) => c && c.is_active !== false);
  const byDomain = (d) => live.find((c) => String(c.shop_domain || '').toLowerCase() === String(d || '').toLowerCase()) || null;
  const picked = Array.isArray(program?.shop_domains) ? program.shop_domains.filter(Boolean) : [];
  if (picked.length === 1) return byDomain(picked[0]);
  if (picked.length > 1) return null;
  try {
    const host = new URL(String(program?.store_url || '')).host;
    if (host.endsWith('.myshopify.com')) { const c = byDomain(host); if (c) return c; }
  } catch { /* no usable store address */ }
  return live.length === 1 ? live[0] : null;
}

const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/**
 * Do the program's affiliate links open THIS store? Links go to the
 * program's store address; a code made in another store would not apply
 * there. No address yet, or a store Shopify did not describe: no objection.
 */
export function storeMatches(program, conn) {
  if (!program?.store_url || !conn?.shop_hosts?.length) return true;
  let host;
  try { host = bareHost(new URL(program.store_url).host); } catch { return true; }
  return conn.shop_hosts.includes(host);
}

/** The UTC instant a calendar day starts in a timezone (YYYY-MM-DD in, ISO out). */
export function dayStartIso(day, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) throw new Error(`Not a date: ${day}`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const offset = (at) => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
      return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
    } catch { return 0; }
  };
  // Twice, so a day that starts just after a clock change lands right.
  let at = guess - offset(guess);
  at = guess - offset(at);
  return new Date(at).toISOString();
}

/** The day after a YYYY-MM-DD day. */
export function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The Shopify input for one code (DiscountCodeBasicInput). */
export function discountInput(code, tz) {
  const pct = Number(code.discount_percent);
  if (!(pct > 0 && pct <= 100)) throw new Error('This code has no percent off to give.');
  const text = String(code.code || '').trim();
  if (!text) throw new Error('This code has no text.');
  return {
    title: `${SILO_TITLE}${String(code.affiliate || text).slice(0, 200)}`,
    code: text,
    startsAt: dayStartIso(code.starts_on, tz),
    // The last second of ends_on, so Shopify shows that day as the last one.
    endsAt: code.ends_on ? new Date(Date.parse(dayStartIso(nextDay(code.ends_on), tz)) - 1000).toISOString() : null,
    customerSelection: { all: true },
    customerGets: { value: { percentage: Math.round(pct * 100) / 10000 }, items: { all: true } },
    appliesOncePerCustomer: false,
  };
}

const SCOPES_Q = 'query SiloScopes { currentAppInstallation { accessScopes { handle } } shop { myshopifyDomain primaryDomain { host } } }';
export const SILO_TITLE = 'Affiliate: ';
const FIND_Q = `query SiloFindCode($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename
  ... on DiscountCodeBasic { title } ... on DiscountCodeBxgy { title } ... on DiscountCodeFreeShipping { title } ... on DiscountCodeApp { title } } } }`;
const CREATE_M = `mutation SiloCreateCode($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field code message }
  }
}`;

export class ShopifyCodeError extends Error {
  constructor(message, kind = 'failed') { super(message); this.kind = kind; }
}

/** One Admin GraphQL call. Throws ShopifyCodeError with a short reason. */
export async function adminGraphql({ shop, token, apiVersion, query, variables, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`https://${shop}/admin/api/${apiVersion || DEFAULT_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
  } catch (e) { throw new ShopifyCodeError(`Shopify did not answer (${e?.message || 'network'})`); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) {
    throw new ShopifyCodeError('Shopify refused SILO\'s access to this store. Reconnect it in Integrations.', 'needs_scope');
  }
  if (!res.ok) throw new ShopifyCodeError(`Shopify answered ${res.status}`);
  const errs = json?.errors;
  if (errs) {
    const msg = Array.isArray(errs) ? errs.map((e) => e?.message).filter(Boolean).join('; ') : String(errs);
    if (/access denied|scope|not approved/i.test(msg)) throw new ShopifyCodeError('This store has not let SILO make discounts. Reconnect it in Integrations.', 'needs_scope');
    throw new ShopifyCodeError(`Shopify: ${msg.slice(0, 200)}`);
  }
  return json?.data ?? {};
}

/** Does this token carry write_discounts? Asked of Shopify, not of a stored list. */
export async function canMakeCodes(conn, fetchImpl = fetch) {
  const data = await adminGraphql({ shop: conn.shop_domain, token: conn.access_token, apiVersion: conn.api_version, query: SCOPES_Q, fetchImpl });
  const handles = (data?.currentAppInstallation?.accessScopes || []).map((s) => s?.handle);
  // Which addresses this store answers to, for storeMatches below.
  conn.shop_hosts = [data?.shop?.myshopifyDomain, data?.shop?.primaryDomain?.host].filter(Boolean).map(bareHost);
  return handles.includes(CODE_SCOPE);
}

/**
 * Make (or adopt) one code in Shopify. Returns { id, adopted }.
 * The lookup runs first so a code SILO already made is adopted, and runs
 * again after a TAKEN refusal, for the race where it appeared in between.
 * Any other discount with the same text throws 'taken'.
 */
export async function makeCode(conn, code, tz, fetchImpl = fetch) {
  const call = (query, variables) => adminGraphql({ shop: conn.shop_domain, token: conn.access_token, apiVersion: conn.api_version, query, variables, fetchImpl });
  const text = String(code.code).trim();
  const find = async () => {
    const node = (await call(FIND_Q, { code: text }))?.codeDiscountNodeByCode;
    if (!node?.id) return null;
    const d = node.codeDiscount || {};
    if (d.__typename === 'DiscountCodeBasic' && String(d.title || '').startsWith(SILO_TITLE)) return node.id;
    throw new ShopifyCodeError(`${text} is already a different discount in this Shopify store`, 'taken');
  };
  const existing = await find();
  if (existing) return { id: existing, adopted: true };
  const data = await call(CREATE_M, { basicCodeDiscount: discountInput(code, tz) });
  const out = data?.discountCodeBasicCreate;
  const errs = out?.userErrors || [];
  if (out?.codeDiscountNode?.id && !errs.length) return { id: out.codeDiscountNode.id, adopted: false };
  if (errs.some((e) => e?.code === 'TAKEN' || /taken|already/i.test(String(e?.message)))) {
    const again = await find();
    if (again) return { id: again, adopted: true };
  }
  throw new ShopifyCodeError(`Shopify refused the code: ${errs.map((e) => e?.message).filter(Boolean).join('; ').slice(0, 200) || 'no reason given'}`);
}
