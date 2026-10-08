// JWT-auth: everything the App Review test page (/testing/meta-oauth.html)
// does after Facebook Login, behind one gate. The page never writes to the
// database or calls another function itself; it calls this, and this checks,
// on EVERY action:
//
//   1. META_REVIEW_COMPANY_IDS is set (unset -> 503, nothing runs);
//   2. the caller's ACTIVE workspace is in it and the caller is an admin of it
//      (mayUseReviewWorkspace -- the same mayConnect rule as OAuth start);
//   3. for a connection action, the row is a meta_ads row of THAT workspace
//      marked meta.oauth.review_test (isReviewConnection). A pasted-token
//      connection never carries the mark, so nothing here can read, test,
//      sync or change one, in any workspace.
//
// Actions (POST { action, connection_id?, ... }):
//   status         the workspace and its review connections (never a token)
//   list_assets    ad accounts and Pages (+ linked Instagram) the token reaches,
//                  every page (paging.next, capped at MAX_DISCOVERY_PAGES)
//   select_assets  save the chosen ad account and/or Page (+ linked Instagram), after
//                  re-listing server-side: only an asset the token can reach is
//                  accepted. sync_enabled is NOT switched on (no nightly sync)
//   verify         read-only probe of each reporting permission, with the same
//                  Graph calls the sync makes; stores nothing
//   sync           Sync now -- forwards to ad-platform-sync-run with the
//                  caller's own JWT, which re-checks visibility under RLS
//   stored         what the sync has stored for this connection / workspace
import {
  META_GRAPH_VERSION, reviewCompanyIds, mayUseReviewWorkspace, isReviewConnection,
} from './meta-oauth-lib.mjs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const REVIEW_ACTIONS = ['status', 'list_assets', 'select_assets', 'verify', 'sync', 'stored'];

/** Page Insights metrics the probe asks for: the sync's own list
 *  (PAGE_INSIGHT_METRICS in scripts/lib/ad-platforms-sync-core.mjs, pinned
 *  equal by scripts/tests/meta-oauth-review.test.mjs). */
export const PROBE_PAGE_METRICS = ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements'];
/** Instagram media insights metrics: the sync's own request (pinned likewise). */
export const PROBE_IG_METRICS = 'views,reach,shares,saved';
/** Discovery fields: test-ad-platform-connection's own requests (pinned likewise). */
export const AD_ACCOUNT_FIELDS = 'id,name,currency';
export const PAGE_FIELDS = 'id,name,instagram_business_account{id,username}';

const CONNECTION_COLUMNS = 'id, company_entity_id, platform, display_name, is_active, sync_enabled, '
  + 'meta_ad_account_id, facebook_page_id, instagram_business_account_id, '
  + 'last_tested_at, last_test_success, last_test_error, meta, created_at';

/** Discovery follows paging.next up to this many pages (100 items each). */
export const MAX_DISCOVERY_PAGES = 10;

const graph = (path, params) => `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}?${new URLSearchParams(params)}`;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A connection as the page may see it: no token, no other meta keys. */
function publicConnection(c) {
  const o = c.meta?.oauth || {};
  return {
    id: c.id, display_name: c.display_name, is_active: c.is_active, sync_enabled: c.sync_enabled,
    meta_ad_account_id: c.meta_ad_account_id, facebook_page_id: c.facebook_page_id,
    instagram_business_account_id: c.instagram_business_account_id,
    last_tested_at: c.last_tested_at, last_test_success: c.last_test_success, last_test_error: c.last_test_error,
    created_at: c.created_at,
    oauth: { token_type: o.token_type ?? null, client_business_id: o.client_business_id ?? null, connected_at: o.connected_at ?? null },
  };
}

export function createReviewHandler({ env, admin, fetchImpl, now = () => Date.now() }) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
  // A Graph GET. The URL carries the token, so it is never returned or logged;
  // only Meta's own error message is.
  const getGraph = async (url) => {
    let res;
    try { res = await fetchImpl(url); } catch (err) { return { ok: false, error: String(err?.message ?? err).slice(0, 300) }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) return { ok: false, error: String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
    return { ok: true, data };
  };

  // Every page of a Graph list. paging.next carries the token, so it is
  // followed only to graph.facebook.com over https; anything else stops the
  // walk and is reported as truncated rather than sent the token.
  const getAllPages = async (firstUrl) => {
    const items = [];
    let url = firstUrl;
    for (let page = 0; url && page < MAX_DISCOVERY_PAGES; page += 1) {
      const r = await getGraph(url);
      if (!r.ok) return page === 0 ? r : { ok: true, items, truncated: true, error: r.error };
      items.push(...(r.data.data ?? []));
      const next = r.data.paging?.next;
      let safe = null;
      try { const u = new URL(next); if (u.protocol === 'https:' && u.hostname === 'graph.facebook.com') safe = u.toString(); } catch { /* none */ }
      if (next && !safe) return { ok: true, items, truncated: true };
      url = safe;
    }
    return { ok: true, items, truncated: Boolean(url) };
  };

  async function listAssets(token) {
    const accts = await getAllPages(graph('me/adaccounts', { fields: AD_ACCOUNT_FIELDS, limit: '100', access_token: token }));
    if (!accts.ok) return { ok: false, error: `Meta adaccounts: ${accts.error}` };
    const pages = await getAllPages(graph('me/accounts', { fields: PAGE_FIELDS, limit: '100', access_token: token }));
    return {
      ok: true,
      truncated: Boolean(accts.truncated || pages.truncated),
      ad_accounts: accts.items.map((a) => ({ id: String(a.id), name: a.name ?? null, currency: a.currency ?? null })),
      pages: pages.ok ? pages.items.map((p) => ({
        page_id: String(p.id), page_name: p.name ?? null,
        instagram_business_account_id: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null,
        instagram_username: p.instagram_business_account?.username ?? null,
      })) : [],
      pages_error: pages.ok ? null : pages.error,
    };
  }

  async function verify(conn) {
    const token = conn.access_token;
    const out = [];
    const add = (permission, endpoint, r, detail) => out.push({ permission, endpoint, ok: r === 'skip' ? null : r.ok, detail: r === 'skip' ? detail : (r.ok ? detail : r.error) });
    const act = conn.meta_ad_account_id;
    const page = conn.facebook_page_id;
    const ig = conn.instagram_business_account_id;

    if (act) {
      const a = await getGraph(graph(act, { fields: 'id,name,currency,account_status', access_token: token }));
      add('ads_read', `GET /${act}?fields=id,name,currency,account_status`, a, a.ok ? { name: a.data.name ?? null, currency: a.data.currency ?? null, account_status: a.data.account_status ?? null } : null);
      const ins = await getGraph(graph(`${act}/insights`, { fields: 'spend,impressions,clicks', date_preset: 'last_30d', access_token: token }));
      const row = ins.ok ? (ins.data.data ?? [])[0] ?? null : null;
      add('ads_read', `GET /${act}/insights?fields=spend,impressions,clicks&date_preset=last_30d`, ins,
        ins.ok ? { spend: row?.spend ?? null, impressions: row?.impressions ?? null, clicks: row?.clicks ?? null, rows: (ins.data.data ?? []).length } : null);
    } else add('ads_read', 'GET /{ad-account}', 'skip', 'No ad account selected');

    const pl = await getGraph(graph('me/accounts', { fields: 'id,name', limit: '50', access_token: token }));
    add('pages_show_list', 'GET /me/accounts?fields=id,name', pl,
      pl.ok ? { pages: (pl.data.data ?? []).length, selected_page_listed: page ? (pl.data.data ?? []).some((p) => String(p.id) === String(page)) : null } : null);

    let pageToken = null;
    if (page) {
      const pt = await getGraph(graph(page, { fields: 'access_token', access_token: token }));
      pageToken = pt.ok ? pt.data.access_token ?? null : null;
      // The Page token itself is never returned: only whether one was issued.
      add('pages_read_engagement', `GET /${page}?fields=access_token`, pt.ok && !pageToken ? { ok: false, error: 'No Page access token issued' } : pt,
        { page_token_issued: Boolean(pageToken) });
      const fc = await getGraph(graph(page, { fields: 'fan_count', access_token: token }));
      add('pages_read_engagement', `GET /${page}?fields=fan_count`, fc, fc.ok ? { fan_count: fc.data.fan_count ?? null } : null);
      const until = isoDay(now() - 86400000);
      const since = isoDay(now() - 7 * 86400000);
      const pi = await getGraph(graph(`${page}/insights`, {
        metric: PROBE_PAGE_METRICS.join(','), period: 'day', since, until, access_token: pageToken || token,
      }));
      add('read_insights', `GET /${page}/insights?metric=${PROBE_PAGE_METRICS.join(',')}&period=day&since=${since}&until=${until}`, pi,
        pi.ok ? { series: (pi.data.data ?? []).map((s) => ({ metric: s.name, points: (s.values ?? []).length })) } : null);
    } else {
      add('pages_read_engagement', 'GET /{page}?fields=access_token|fan_count', 'skip', 'No Page selected');
      add('read_insights', 'GET /{page}/insights', 'skip', 'No Page selected');
    }

    if (ig) {
      const media = await getGraph(graph(`${ig}/media`, { fields: 'id,media_type,timestamp,permalink', limit: '3', access_token: token }));
      const items = media.ok ? media.data.data ?? [] : [];
      add('instagram_basic', `GET /${ig}/media?fields=id,media_type,timestamp,permalink&limit=3`, media,
        media.ok ? { media: items.map((m) => ({ id: m.id, media_type: m.media_type ?? null, timestamp: m.timestamp ?? null, permalink: m.permalink ?? null })) } : null);
      if (items[0]?.id) {
        const mi = await getGraph(graph(`${items[0].id}/insights`, { metric: PROBE_IG_METRICS, access_token: token }));
        add('instagram_manage_insights', `GET /${items[0].id}/insights?metric=${PROBE_IG_METRICS}`, mi,
          mi.ok ? { metrics: Object.fromEntries((mi.data.data ?? []).map((r) => [r.name, r.values?.[0]?.value ?? r.total_value?.value ?? null])) } : null);
      } else add('instagram_manage_insights', 'GET /{ig-media}/insights', 'skip', 'No Instagram media to read insights for');
    } else {
      add('instagram_basic', 'GET /{ig-user}/media', 'skip', 'No Instagram account selected');
      add('instagram_manage_insights', 'GET /{ig-media}/insights', 'skip', 'No Instagram account selected');
    }
    return out;
  }

  async function stored(conn) {
    const count = async (table, col, val) => {
      const { count: c, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
      return error ? null : c ?? 0;
    };
    const { data: recent } = await admin.from('marketing_kpis_daily')
      .select('day_date, campaign_name, impressions, clicks, spend')
      .eq('connection_id', conn.id).eq('company_entity_id', conn.company_entity_id)
      .order('day_date', { ascending: false }).limit(7);
    return {
      marketing_kpis_daily: await count('marketing_kpis_daily', 'connection_id', conn.id),
      meta_ad_performance_daily: await count('meta_ad_performance_daily', 'connection_id', conn.id),
      // Company-grain tables: the review workspace holds only review data.
      facebook_page_insights_daily: await count('facebook_page_insights_daily', 'company_entity_id', conn.company_entity_id),
      instagram_media_insights: await count('instagram_media_insights', 'company_entity_id', conn.company_entity_id),
      recent_campaign_days: recent ?? [],
    };
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const allowlist = reviewCompanyIds(env.META_REVIEW_COMPANY_IDS);
    if (!allowlist.length) return json({ error: 'App Review test mode is not configured' }, 503);

    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    const user = auth?.user;
    if (!user) return json({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const action = body?.action;
    if (!REVIEW_ACTIONS.includes(action)) return json({ error: 'Unknown action' }, 400);

    // The workspace is the caller's ACTIVE one, read here; never the body's.
    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();
    const companyId = profile?.active_company_id ?? null;
    const { data: membership, error: membershipError } = companyId
      ? await admin.from('entity_memberships').select('role').eq('entity_id', companyId).eq('user_id', user.id).maybeSingle()
      : { data: null, error: null };
    if (!mayUseReviewWorkspace({ allowlist, companyId, profile, profileError, membership, membershipError })) {
      return json({ error: 'This workspace is not an App Review test workspace, or you are not its admin', code: 'not_review_workspace' }, 403);
    }

    if (action === 'status') {
      const { data: rows, error } = await admin.from('ad_platform_connections')
        .select(CONNECTION_COLUMNS).eq('company_entity_id', companyId).eq('platform', 'meta_ads');
      if (error) return json({ error: 'Could not read connections' }, 500);
      const { data: co } = await admin.from('entities').select('id, title').eq('id', companyId).maybeSingle();
      return json({
        ok: true,
        company: { id: companyId, title: co?.title ?? null },
        connections: (rows ?? []).filter((c) => isReviewConnection(c, companyId)).map(publicConnection),
      });
    }

    const connectionId = typeof body?.connection_id === 'string' ? body.connection_id : '';
    if (!connectionId) return json({ error: 'connection_id required' }, 400);
    const { data: conn, error: connErr } = await admin.from('ad_platform_connections')
      .select('*').eq('id', connectionId).eq('company_entity_id', companyId).maybeSingle();
    if (connErr || !isReviewConnection(conn, companyId)) return json({ error: 'Connection not found' }, 404);
    if (!conn.access_token) return json({ error: 'No Meta token stored on this connection' }, 409);

    if (action === 'list_assets') return json(await listAssets(conn.access_token));

    if (action === 'select_assets') {
      const pick = (k) => (typeof body?.[k] === 'string' && body[k].trim() ? body[k].trim() : null);
      const adAccountId = pick('ad_account_id');
      const pageId = pick('page_id');
      const igId = pick('instagram_business_account_id');
      // Either asset may be left out (a login can reach Pages and no ad
      // account, or the reverse); choosing nothing at all is not a selection.
      if (!adAccountId && !pageId) return json({ error: 'Choose an ad account or a Page' }, 400);
      if (igId && !pageId) return json({ error: 'Choose the Page the Instagram account is linked to' }, 400);
      // Re-listed here, never trusted from the page: only what this token reaches.
      const assets = await listAssets(conn.access_token);
      if (!assets.ok) return json({ ok: false, error: assets.error }, 502);
      if (adAccountId && !assets.ad_accounts.some((a) => a.id === adAccountId)) return json({ error: 'That ad account is not available to this connection' }, 400);
      const pageRow = pageId ? assets.pages.find((p) => p.page_id === pageId) : null;
      if (pageId && !pageRow) return json({ error: 'That Page is not available to this connection' }, 400);
      if (igId && pageRow.instagram_business_account_id !== igId) return json({ error: 'That Instagram account is not linked to the chosen Page' }, 400);
      const { data: updated, error } = await admin.from('ad_platform_connections')
        .update({
          meta_ad_account_id: adAccountId, facebook_page_id: pageId, instagram_business_account_id: igId,
          updated_at: new Date(now()).toISOString(), updated_by: user.id,
        })
        .eq('id', conn.id).eq('company_entity_id', companyId).select('id');
      if (error) return json({ error: 'Could not save the selection' }, 500);
      if (updated?.length !== 1) return json({ error: 'Connection not found' }, 404);
      return json({ ok: true, connection_id: conn.id });
    }

    if (action === 'verify') return json({ ok: true, checks: await verify(conn) });

    if (action === 'sync') {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: 'Sync is not configured' }, 503);
      let res;
      try {
        res = await fetchImpl(`${env.SUPABASE_URL}/functions/v1/ad-platform-sync-run`, {
          method: 'POST',
          headers: { Authorization: authHeader, apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection_id: conn.id }),
        });
      } catch (err) { return json({ ok: false, error: `Sync could not start: ${String(err?.message ?? err).slice(0, 200)}` }, 502); }
      const data = await res.json().catch(() => ({ ok: false, error: `Sync answered HTTP ${res.status}` }));
      return json(data, res.status);
    }

    return json({ ok: true, stored: await stored(conn) });
  };
}
