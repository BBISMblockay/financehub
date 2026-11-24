/* Shopify customers: marketing consent, as it stands NOW.
 *
 * Blake asked whether SILO pulls Shopify's "accepts marketing" column. It did
 * not, and that column no longer exists in Shopify either -- consent is
 * emailMarketingConsent / smsMarketingConsent, each a STATE plus an opt-in
 * level and the moment it last changed.
 *
 * Consent is CUSTOMER-level and it changes after the order, so deriving it
 * from the customer embedded in each order would freeze it at the moment of
 * purchase and an unsubscribe would be invisible until that person bought
 * again. Hence a job of its own against its own resource.
 *
 * WHY THIS IS NOT IN shopify-sync-core.mjs: that file is shipped as a
 * BYTE-IDENTICAL copy inside supabase/functions/ad-platform-sync-run/lib/
 * (pinned by scripts/tests/ad-platform-sync-run.test.mjs). Appending to it
 * would oblige a redeploy of an edge function that has nothing to do with
 * customers, and leave deployment-drift-check red until that happened. This
 * module imports what it needs from there instead, and the nightly is its
 * only caller.
 */

import {
  grantedScopes,
  maxIso,
  readMeta,
  shopifyGraphql,
  shopifyNumericId,
  sleep,
  upsertInChunks,
} from './shopify-sync-core.mjs';
// The scope this job needs. NOT added to JOB_SCOPES in shopify-scopes.mjs,
// deliberately: that module ships BYTE-IDENTICAL inside two edge functions
// (ad-platform-sync-run, test-shopify-connection), neither of which syncs
// customers, so putting it there would oblige a redeploy of both and leave
// deployment-drift-check red until that happened -- for a map entry nothing
// over there reads. It belongs with the job it gates until one of those
// functions is being deployed for its own reasons.
export const CUSTOMERS_SCOPES = ['read_customers'];

/** The same semantics as scopesMissingForJob(), over CUSTOMERS_SCOPES. */
export function customersScopesMissing(granted) {
  const set = new Set(granted || []);
  return CUSTOMERS_SCOPES.filter((s) => !set.has(s));
}

// Shopify's customers connection serves at most 250 a page; 100 keeps the
// query cost well inside the points budget while a walk runs for pages on end.
export const CUSTOMERS_PAGE_SIZE = 100;
// A nightly run must not turn into a full re-walk of the customer base, so a
// run has a page budget and stops cleanly when it runs out, handing the next
// run its cursor. A first pull of a large store spreads across a few nights
// rather than dragging one night out.
export const CUSTOMERS_MAX_PAGES_PER_RUN = 250;
// A FULL DAY of overlap, not minutes. Shopify's own search-syntax docs
// (checked against the 2025-01 `customers` query on 2026-11-24) describe
// `updated_at` as matching "a whole day" and give only day-granular examples,
// and they are silent on whether the sub-second part of a timestamp survives.
// A day's overlap is correct under either reading, costs a page or two, and
// the upsert is idempotent -- whereas a ten-minute overlap would depend on a
// precision the docs do not promise.
export const CUSTOMERS_WATERMARK_OVERLAP_MINUTES = 24 * 60;

const THROTTLE_MESSAGE = /throttl|rate limit|too many requests|exceeded .*(rate|limit)/i;
const THROTTLE_BASE_WAIT_MS = 2_000;
const THROTTLE_MAX_WAIT_MS = 60_000;
const THROTTLE_TRIES = 6;

/** Shopify's consent states arrive SCREAMING_CASE. Stored lowercase, which is
 *  how the table's comment, the generated `email_subscribed` column and every
 *  report read them. An empty string is not a state. */
export function normalizeConsentValue(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s || null;
}

/** `updatedAtMin` null means "the whole customer base", which is what a first
 *  run asks for. */
export function customersQueryFilter(updatedAtMin) {
  if (!updatedAtMin) return null;
  return `updated_at:>='${updatedAtMin}'`;
}

/** Shopify answers a partially-approved app with the data it will disclose AND
 *  an error for every field it redacted, so this is not a transport failure to
 *  retry -- it is a standing fact about the app's protected customer data
 *  approval, true again tomorrow night. Recorded as a skip with the reason,
 *  like a missing scope. (Protected customer data is a separate approval from
 *  the read_customers scope: name, email, phone and address are each approved
 *  individually.) */
export function customersAccessRefused(message) {
  return /access denied|not approved|protected customer data|redacted|insufficient permission/i
    .test(String(message || ''));
}

/** A cursor Shopify will not accept any more -- a stored continuation that has
 *  gone stale, or one from a query whose filter has changed. The walk restarts
 *  from its filter rather than failing: the upsert is idempotent, so the cost
 *  is repeated pages, and the alternative is a store that never progresses. */
export function customersCursorRejected(message) {
  return /cursor|after argument|invalid.*pagination/i.test(String(message || ''));
}

/** The table and the sync_jobs CHECK value both arrive with 20261124020000.
 *  Code deploys by merge and migrations apply by hand, so this WILL run for a
 *  while against a database that has neither. That is a skip, not a failure:
 *  anything else would turn the nightly red for every store until the SQL
 *  lands. */
export function customersNotInstalled(message) {
  return /shopify_customers/i.test(String(message || ''))
    && /(does not exist|could not find|schema cache|42P01|PGRST205)/i.test(String(message || ''));
}

export function customerConsentRow(node, { connection, syncedAt, batchId }) {
  const emailConsent = node?.emailMarketingConsent || {};
  const smsConsent = node?.smsMarketingConsent || {};
  const addr = node?.defaultAddress || {};
  const name = [node?.firstName, node?.lastName].filter(Boolean).join(' ')
    || node?.displayName || null;

  return {
    company_entity_id: connection.company_entity_id,
    connection_id: connection.id,
    shop_domain: connection.shop_domain,
    customer_id: shopifyNumericId(node?.legacyResourceId ?? node?.id),
    email: node?.email || null,
    phone: node?.phone || null,
    first_name: node?.firstName || null,
    last_name: node?.lastName || null,
    customer_name: name,
    state: normalizeConsentValue(node?.state),
    verified_email: typeof node?.verifiedEmail === 'boolean' ? node.verifiedEmail : null,
    tags: Array.isArray(node?.tags) ? (node.tags.join(', ') || null) : (node?.tags || null),
    // numberOfOrders is an UnsignedInt64 and amountSpent.amount a Decimal,
    // both serialised as STRINGS. Number(null) would be 0 -- a measurement we
    // do not have.
    orders_count: node?.numberOfOrders == null ? null : Number(node.numberOfOrders),
    total_spent: node?.amountSpent?.amount == null ? null : Number(node.amountSpent.amount),
    currency: node?.amountSpent?.currencyCode || null,
    email_consent_state: normalizeConsentValue(emailConsent.marketingState),
    email_consent_opt_in_level: normalizeConsentValue(emailConsent.marketingOptInLevel),
    email_consent_updated_at: emailConsent.consentUpdatedAt || null,
    sms_consent_state: normalizeConsentValue(smsConsent.marketingState),
    sms_consent_opt_in_level: normalizeConsentValue(smsConsent.marketingOptInLevel),
    sms_consent_collected_from: normalizeConsentValue(smsConsent.consentCollectedFrom),
    sms_consent_updated_at: smsConsent.consentUpdatedAt || null,
    city: addr.city || null,
    province_code: addr.provinceCode || null,
    country_code: addr.countryCodeV2 || null,
    shopify_created_at: node?.createdAt || null,
    shopify_updated_at: node?.updatedAt || null,
    synced_at: syncedAt,
    sync_batch_id: batchId || null,
  };
}

// Checked field by field against the Admin GraphQL 2025-01 reference on
// 2026-11-24. Two things to know when this is next touched:
//
//   * `email`, `phone`, `emailMarketingConsent` and `smsMarketingConsent` are
//     marked deprecated in 2025-01 and are still the only read path --
//     Shopify's own pages name no replacement for READING consent (the named
//     successors are the write mutations). So re-check this selection on an
//     API version bump rather than guessing a mapping now.
//   * `numberOfOrders` and `legacyResourceId` are UnsignedInt64 and
//     `amountSpent.amount` is Decimal, all three serialised as strings.
export const CUSTOMERS_QUERY = `
  query SiloCustomers($first: Int!, $cursor: String, $filter: String) {
    customers(first: $first, after: $cursor, query: $filter, sortKey: UPDATED_AT, reverse: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        email
        phone
        firstName
        lastName
        displayName
        state
        verifiedEmail
        tags
        numberOfOrders
        createdAt
        updatedAt
        amountSpent { amount currencyCode }
        emailMarketingConsent { marketingState marketingOptInLevel consentUpdatedAt }
        smsMarketingConsent { marketingState marketingOptInLevel consentUpdatedAt consentCollectedFrom }
        defaultAddress { city provinceCode countryCodeV2 }
      }
    }
  }
`;

/** A GraphQL call that waits out a throttle instead of failing the stage.
 *  shopifyGraphql() throws on any `errors` entry; only THROTTLED is worth
 *  retrying, and a customers walk is long enough to meet one. */
async function graphqlThrottleAware(connection, query, variables, { gql = shopifyGraphql, tries = THROTTLE_TRIES, onThrottle = null } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await gql(connection, query, variables);
    } catch (err) {
      const message = String(err?.message || err);
      if (!THROTTLE_MESSAGE.test(message) || attempt >= tries - 1) throw err;
      const ceiling = Math.min(THROTTLE_MAX_WAIT_MS, THROTTLE_BASE_WAIT_MS * (2 ** attempt));
      const waitMs = Math.round(THROTTLE_BASE_WAIT_MS + Math.random() * (ceiling - THROTTLE_BASE_WAIT_MS));
      if (onThrottle) onThrottle({ attempt: attempt + 1, waitMs, message });
      await sleep(waitMs);
    }
  }
}

/** Pull customers CHANGED since the last completed walk (everything, on a
 *  first run) and store their current marketing consent.
 *
 *  Why GraphQL and not REST like the order feeds: consent lives in
 *  emailMarketingConsent / smsMarketingConsent, REST is the legacy surface
 *  Shopify has stopped extending, and the GraphQL `customers` connection
 *  sorts by UPDATED_AT -- which is what makes a budgeted, resumable walk
 *  possible at all.
 *
 *  Resuming is a CURSOR, not a timestamp. An earlier version re-derived the
 *  window from the newest row written, which is correct only while timestamps
 *  are distinct: a bulk import can leave more customers sharing one
 *  `updated_at` than a run's budget covers, and then every run would re-walk
 *  the same pages, store the same watermark and never reach the rest (found
 *  in review of this PR). So while a walk is incomplete its cursor and its
 *  own filter are stored and reused verbatim, and the overlapping incremental
 *  window is only computed once a walk has FINISHED.
 */
export async function runCustomersSync(supabase, connection, {
  batchId,
  maxPages = CUSTOMERS_MAX_PAGES_PER_RUN,
  pageSize = CUSTOMERS_PAGE_SIZE,
  gql = shopifyGraphql,
  onProgress = null,
} = {}) {
  const granted = grantedScopes(connection);
  const missing = customersScopesMissing(granted);
  if (missing.length) {
    return { skipped: true, missing };
  }

  const syncedAt = new Date().toISOString();
  const meta = readMeta(connection);
  const stored = meta.last_customer_sync_at || null;
  // An unfinished walk owns the window: its filter is reused exactly, so the
  // sort it is paging through does not move under the cursor.
  const resumed = meta.customer_walk && typeof meta.customer_walk === 'object'
    && meta.customer_walk.cursor
    ? meta.customer_walk
    : null;
  const firstRun = !stored && !resumed;

  const filter = resumed
    ? (resumed.filter ?? null)
    : customersQueryFilter(stored
      ? new Date(new Date(stored).getTime() - CUSTOMERS_WATERMARK_OVERLAP_MINUTES * 60_000).toISOString()
      : null);

  let cursor = resumed ? resumed.cursor : null;
  let restartedFromCursorLoss = false;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  let watermark = stored;
  let complete = false;

  const refused = (err) => ({
    job_type: 'customers_sync',
    skipped: true,
    access_refused: true,
    reason: `Shopify refused customer fields: ${String(err?.message || err).slice(0, 300)}`,
    pages_fetched: pages,
    customers_fetched: fetched,
    customers_upserted: upserted,
  });

  while (pages < maxPages) {
    let data;
    try {
      data = await graphqlThrottleAware(connection, CUSTOMERS_QUERY, {
        first: pageSize, cursor, filter,
      }, { gql, onThrottle: onProgress });
    } catch (err) {
      if (customersAccessRefused(err?.message)) return refused(err);
      // A stored cursor Shopify no longer accepts: restart this walk from its
      // filter once, rather than failing the store for ever.
      if (cursor && customersCursorRejected(err?.message) && !restartedFromCursorLoss) {
        restartedFromCursorLoss = true;
        cursor = null;
        continue;
      }
      throw err;
    }
    pages += 1;

    const conn = data?.customers;
    const nodes = conn?.nodes || [];
    fetched += nodes.length;

    const rows = nodes
      .map((node) => customerConsentRow(node, { connection, syncedAt, batchId }))
      .filter((r) => r.customer_id);

    if (rows.length) {
      try {
        upserted += await upsertInChunks(
          supabase, 'shopify_customers', rows,
          'company_entity_id,shop_domain,customer_id',
        );
      } catch (err) {
        if (customersNotInstalled(err?.message)) {
          return {
            skipped: true,
            not_installed: true,
            reason: 'shopify_customers is not in the database yet (migration 20261124020000 not applied)',
          };
        }
        throw err;
      }
      // Only what is now STORED moves the watermark, and it is the NEWEST row
      // written rather than the last one in the page: the watermark must not
      // depend on the connection's sort staying exactly as it is.
      for (const r of rows) watermark = maxIso(watermark, r.shopify_updated_at);
    }

    if (onProgress) onProgress({ pages, fetched, upserted });

    if (!conn?.pageInfo?.hasNextPage || !conn?.pageInfo?.endCursor) {
      complete = true;
      cursor = null;
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }

  return {
    job_type: 'customers_sync',
    first_run: firstRun,
    resumed: Boolean(resumed),
    cursor_restart: restartedFromCursorLoss || undefined,
    window_since: filter,
    pages_fetched: pages,
    customers_fetched: fetched,
    customers_upserted: upserted,
    complete,
    // The page budget ran out: there is more to pull and the next run picks up
    // from this cursor, with this same filter. Not an error.
    more_available: !complete,
    // The continuation to store, or null once the walk finished. The caller
    // writes both this and the watermark.
    customer_walk: complete ? null : { cursor, filter: filter ?? null, updated_at: syncedAt },
    // The incremental window for the NEXT walk only moves when this one
    // finished; an unfinished walk keeps the window it started with, so
    // nothing between here and the end of the walk can be skipped.
    last_customer_sync_at: complete ? (watermark || stored || null) : (stored || null),
  };
}
