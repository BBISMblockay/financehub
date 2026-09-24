// scripts/redo-marketing-probe.mjs -- read-only diagnostic: does Redo's
// Reporting API (Marketing) return campaign and automation data for us?
//
// Redo's marketing reporting is NOT on the v2.2 REST API the returns sync
// uses (an earlier version of this probe tried 18 REST paths and found none).
// It is a GraphQL endpoint, per the "Redo Reporting API -- Marketing" doc Redo
// sent 2026-09:
//
//   POST https://api.getredo.com/v3/account/{storeId}/graphql
//   Authorization: Bearer <token>
//
// The token needs READ scopes Campaigns, Marketing automations, Campaign
// analytics, Marketing automation analytics, Marketing templates. The returns
// token on redo_connections.api_secret was minted for returns_read and will
// most likely answer INSUFFICIENT_SCOPE -- which this probe reports by name.
//
// Token resolution, first hit wins:
//   1. REDO_MARKETING_API_TOKEN (+ REDO_STORE_ID) -- a new marketing-scoped
//      token, no Supabase needed. Lets the probe run before anything is stored.
//   2. redo_connections.api_secret / meta.redo_store_id for
//      REDO_COMPANY_ENTITY_ID (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//
// Queries only; nothing is created or modified on Redo's side or in SILO.
// Prints counts, a few campaign/automation names with their totals, the
// GraphQL cost, and every error with its extensions.code -- never the token.
//
//   REDO_MARKETING_API_TOKEN=... REDO_STORE_ID=... node scripts/redo-marketing-probe.mjs
//   PROBE_START=2026-08-01 PROBE_END=2026-09-22 (optional; default last 30 days)

const TOKEN_ENV = process.env.REDO_MARKETING_API_TOKEN || '';
const STORE_ENV = process.env.REDO_STORE_ID || '';
const COMPANY_ENTITY_ID = process.env.REDO_COMPANY_ENTITY_ID || '';

function isoDay(d) { return d.toISOString().slice(0, 10); }
const END = process.env.PROBE_END || isoDay(new Date(Date.now() - 86400000));
const START = process.env.PROBE_START || isoDay(new Date(Date.now() - 31 * 86400000));

const MONEY = 'amount currency';
const TOTALS = `
  recipients sends delivered failures openRate clickThroughRate conversionRate
  unsubscribes unsubscribeRate orders newCustomerOrders returningCustomerOrders
  revenue { ${MONEY} } newCustomerRevenue { ${MONEY} } returningCustomerRevenue { ${MONEY} }
  spend { ${MONEY} } revenuePerSend { ${MONEY} } revenuePerRecipient { ${MONEY} }
  averageOrderValue { ${MONEY} }`;

const PING = '{ campaigns(first: 1) { nodes { id name } } }';

const CAMPAIGNS = `
query CampaignReport($start: Date!, $end: Date!, $first: Int!, $after: String) {
  campaigns(first: $first, after: $after, orderBy: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name tags channel sentAt
      emailVariants { position abTestWeight template { subject previewText } }
      analytics { messaging(startDate: $start, endDate: $end) {
        totals { ${TOTALS} }
        series { date sends orders revenue { ${MONEY} } }
      } }
    }
  }
}`;

const AUTOMATIONS = `
query AutomationReport($start: Date!, $end: Date!, $first: Int!, $after: String) {
  marketingAutomations(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name category enabled
      analytics { messaging(startDate: $start, endDate: $end) {
        totals { ${TOTALS}
          byChannel { channel sends delivered openRate clickThroughRate orders
            revenue { ${MONEY} } spend { ${MONEY} } }
        }
      } }
    }
  }
}`;

async function resolveCredentials() {
  if (TOKEN_ENV) {
    if (!STORE_ENV) throw new Error('REDO_MARKETING_API_TOKEN is set but REDO_STORE_ID is not');
    return { token: TOKEN_ENV, storeId: STORE_ENV, source: 'REDO_MARKETING_API_TOKEN' };
  }
  if (!COMPANY_ENTITY_ID) {
    throw new Error('Set REDO_MARKETING_API_TOKEN + REDO_STORE_ID, or REDO_COMPANY_ENTITY_ID to use the stored returns token');
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from('redo_connections')
    .select('api_secret, meta')
    .eq('company_entity_id', COMPANY_ENTITY_ID)
    .single();
  if (error || !data?.api_secret) {
    throw new Error(`No redo_connections.api_secret for company ${COMPANY_ENTITY_ID}: ${error?.message || 'not found'}`);
  }
  const storeId = STORE_ENV || data.meta?.redo_store_id;
  if (!storeId) throw new Error('redo_connections.meta.redo_store_id is not set (or pass REDO_STORE_ID)');
  return { token: data.api_secret, storeId, source: 'redo_connections.api_secret (returns token)' };
}

async function gql(creds, label, query, variables = {}) {
  const url = `https://api.getredo.com/v3/account/${creds.storeId}/graphql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  const cost = body?.extensions?.cost;
  console.log(`\n[${label}] HTTP ${res.status}${cost != null ? `  cost=${JSON.stringify(cost)}` : ''}`);
  if (!body) { console.log(`  non-JSON body: ${text.slice(0, 300).replace(/\s+/g, ' ')}`); return null; }
  for (const e of body.errors || []) {
    console.log(`  ERROR ${e.extensions?.code || ''} ${e.message}${e.path ? ` @ ${e.path.join('.')}` : ''}`);
  }
  return body.data || null;
}

const money = (m) => (m ? `${m.amount} ${m.currency}` : 'null');
const pct = (r) => (r == null ? 'null' : `${(r * 100).toFixed(2)}%`);

async function pageAll(creds, label, query, field) {
  const nodes = [];
  let after = null;
  for (let page = 1; page <= 20; page++) {
    const data = await gql(creds, `${label} p${page}`, query, { start: START, end: END, first: 100, after });
    const conn = data?.[field];
    if (!conn) break;
    nodes.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

function summarise(kind, nodes) {
  const withActivity = nodes.filter((n) => (n.analytics?.messaging?.totals?.sends || 0) > 0);
  let revenue = 0; let orders = 0; let sends = 0;
  for (const n of withActivity) {
    const t = n.analytics.messaging.totals;
    revenue += Number(t.revenue?.amount || 0); orders += t.orders || 0; sends += t.sends || 0;
  }
  console.log(`\n== ${kind}: ${nodes.length} returned, ${withActivity.length} with sends in ${START}..${END}`);
  console.log(`   window totals: sends=${sends} orders=${orders} revenue=${revenue.toFixed(2)}`);
  const top = withActivity
    .sort((a, b) => Number(b.analytics.messaging.totals.revenue?.amount || 0) - Number(a.analytics.messaging.totals.revenue?.amount || 0))
    .slice(0, 8);
  for (const n of top) {
    const t = n.analytics.messaging.totals;
    const extra = kind === 'Campaigns'
      ? `channel=${n.channel} sentAt=${n.sentAt} subject="${n.emailVariants?.[0]?.template?.subject ?? '(null)'}" seriesDays=${n.analytics.messaging.series?.length ?? 0}`
      : `category=${n.category} enabled=${n.enabled} channels=${(t.byChannel || []).map((c) => c.channel).join('/')}`;
    console.log(`   - ${n.name} | sends=${t.sends} open=${pct(t.openRate)} ctr=${pct(t.clickThroughRate)} orders=${t.orders} (new ${t.newCustomerOrders}/ret ${t.returningCustomerOrders}) rev=${money(t.revenue)} spend=${money(t.spend)} | ${extra}`);
  }
}

async function main() {
  const creds = await resolveCredentials();
  console.log(`[probe] store=${creds.storeId} token=${creds.source} window=${START}..${END}`);

  const ping = await gql(creds, 'ping', PING);
  if (!ping) {
    console.log('  ping returned no data -- check the errors above (401 = token/store wrong, INSUFFICIENT_SCOPE = scope missing)');
    process.exit(1);
  }

  summarise('Campaigns', await pageAll(creds, 'campaigns', CAMPAIGNS, 'campaigns'));
  summarise('Automations', await pageAll(creds, 'automations', AUTOMATIONS, 'marketingAutomations'));
}

main().catch((err) => {
  console.error('[probe] fatal', err.message);
  process.exit(1);
});
