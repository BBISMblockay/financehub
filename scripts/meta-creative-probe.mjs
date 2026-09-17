// scripts/meta-creative-probe.mjs — READ ONLY. Writes nothing, anywhere.
//
// WHY. After the 2026-09-17 backfill, 2,468 of 4,079 creatives carry a
// destination. The largest remaining block is 423 SHARE ads holding
// $2,347,906 of spend, and 409 of those ($2,346,434) have body_source
// 'creative_body' -- they carry their own copy, so they are not empty
// page-post shells. Their ad names ("All Releases Catalog", "Dynamic
// Products", "Recently Restocked", "Low Funnel Retarget Catalog") suggest
// catalog / Dynamic Product Ads, where the click goes to a product from the
// feed rather than to one landing page.
//
// A NAME IS NOT EVIDENCE -- v3 learned that when a KPI titled "Total sales"
// showed MLB sales. So this asks Meta what is actually on the creative, and
// reports it rather than concluding from the name.
//
// What it answers, per ad:
//   1. Which creative fields Meta will even serve for it (the account refuses
//      some, and a refusal is data -- it is how effective_object_url was
//      caught).
//   2. EVERY url-shaped string anywhere in the returned object, with its JSON
//      PATH. That is the decisive output: if a destination exists on the
//      creative at all, this finds it and names the field the resolver would
//      have to read. If none exists, that is the proof it is absent rather
//      than missed.
//   3. Whether the creative names a product set / template (the catalog
//      shape), and whether it names a page post the resolver never fetches
//      -- the post lookup is gated on missing BODY, not missing LINK
//      (ad-platforms-sync-core.mjs:781), so an ad with copy and no link never
//      has its post read.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: META_PROBE_AD_IDS (comma-separated, overrides the query),
//           META_PROBE_LIMIT (default 25), META_PROBE_COMPANY_ID,
//           META_PROBE_CONNECTION_ID.

import { createClient } from '@supabase/supabase-js';
import { META_API_VERSION, fetchFacebookPageAccessToken } from './lib/ad-platforms-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const EXPLICIT_IDS = (process.env.META_PROBE_AD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.META_PROBE_LIMIT || 25);
const ONLY_COMPANY_ID = process.env.META_PROBE_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.META_PROBE_CONNECTION_ID || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* Fields worth asking for. Deliberately WIDER than the sync's list: the point
 * is to discover what exists, so a field the sync would never request belongs
 * here. Anything the account refuses is dropped and RECORDED -- the refusal
 * is a finding, not an error. */
const PROBE_FIELDS = [
  'id', 'name', 'object_type', 'object_story_id', 'effective_object_story_id',
  'object_story_spec', 'asset_feed_spec', 'product_set_id', 'url_tags',
  'object_url', 'template_url', 'template_url_spec', 'link_destination_display_url',
  'call_to_action_type', 'instagram_permalink_url', 'effective_instagram_media_id',
];

/** The field name Meta names in an unknown-field error, or null. */
function refusedField(text) {
  const m = /nonexisting field \(([^)]+)\)/i.exec(text) || /Unknown field(?:s)?[: ]+([A-Za-z0-9_]+)/i.exec(text);
  return m ? m[1].trim().replace(/[{(].*$/, '') : null;
}

/** GET a node, dropping exactly the field Meta refuses until it answers.
 *  Returns { data, dropped[] } or { error }. The token never enters a log. */
async function getWithNegotiation(nodeId, fields, token, label) {
  const active = [...fields];
  const dropped = [];
  for (;;) {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${nodeId}`
      + `?fields=${encodeURIComponent(active.join(','))}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) {
      try { return { data: JSON.parse(text), dropped }; }
      catch { return { error: `${label}: non-JSON response` }; }
    }
    const named = refusedField(text);
    const idx = named ? active.indexOf(named) : -1;
    if (idx === -1 || active.length <= 1) {
      return { error: `${label} ${res.status}: ${text.slice(0, 220)}`, dropped };
    }
    active.splice(idx, 1);
    dropped.push(named);
  }
}

/** Every url-shaped string in an object, with its JSON path. THE decisive
 *  output: it cannot miss a destination by looking in the wrong place,
 *  because it looks everywhere. */
function urlsWithPaths(node, path = '', out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node.trim())) out.push({ path: path || '(root)', url: node.trim() });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => urlsWithPaths(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) urlsWithPaths(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

async function main() {
  let q = supabase.from('ad_platform_connections').select('*')
    .eq('platform', 'meta_ads').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);
  const { data: conns, error } = await q.order('created_at');
  if (error) throw new Error(`connection load failed: ${error.message}`);
  if (!conns?.length) { console.log('[probe] no active meta_ads connection'); return; }
  const conn = conns[0];
  const token = conn.access_token;
  if (!token) throw new Error('connection has no access_token');

  let adIds = EXPLICIT_IDS;
  if (!adIds.length) {
    // The block being investigated: SHARE, no destination, carries its own
    // copy. Ordered newest-synced so a small sample is representative of the
    // shape rather than of one old campaign.
    const { data, error: qErr } = await supabase
      .from('meta_ad_creatives')
      .select('ad_id')
      .eq('company_entity_id', conn.company_entity_id)
      .eq('object_type', 'SHARE')
      .is('link_url', null)
      .eq('body_source', 'creative_body')
      .order('synced_at', { ascending: false })
      .limit(LIMIT);
    if (qErr) throw new Error(`candidate load failed: ${qErr.message}`);
    adIds = (data || []).map((r) => String(r.ad_id));
  }
  adIds = [...new Set(adIds)].slice(0, LIMIT);
  console.log(`[probe] READ ONLY. ${adIds.length} ad(s), api ${META_API_VERSION}\n`);

  const tally = {
    ads: 0, creative_read_failed: 0,
    with_any_url: 0, with_product_set: 0, with_template: 0,
    with_story_id: 0, post_read_ok: 0, post_with_url: 0,
  };
  const pathHits = new Map();   // json path -> count, across ads
  const refusals = new Map();   // refused field -> count
  let pageToken = null;

  for (const adId of adIds) {
    tally.ads += 1;
    const ad = await getWithNegotiation(adId, ['id', 'name', 'creative{' + PROBE_FIELDS.join(',') + '}'], token, `ad ${adId}`);
    if (ad.error) {
      tally.creative_read_failed += 1;
      console.log(`--- ad ${adId}\n    READ FAILED: ${ad.error}`);
      continue;
    }
    for (const d of ad.dropped) refusals.set(d, (refusals.get(d) || 0) + 1);
    const creative = ad.data?.creative || {};
    const urls = urlsWithPaths(creative);
    const storyId = creative.object_story_id || creative.effective_object_story_id || null;

    if (urls.length) tally.with_any_url += 1;
    if (creative.product_set_id) tally.with_product_set += 1;
    if (creative.template_url || creative.template_url_spec
        || creative.object_story_spec?.template_data) tally.with_template += 1;
    if (storyId) tally.with_story_id += 1;
    for (const u of urls) pathHits.set(u.path, (pathHits.get(u.path) || 0) + 1);

    console.log(`--- ad ${adId}  ${String(ad.data?.name || '').slice(0, 44)}`);
    console.log(`    object_type=${creative.object_type ?? '?'}`
      + `  product_set_id=${creative.product_set_id ?? '-'}`
      + `  story_id=${storyId ?? '-'}`);
    console.log(`    object_story_spec keys: ${Object.keys(creative.object_story_spec || {}).join(',') || '(none)'}`);
    if (creative.object_story_spec?.template_data) {
      console.log(`    template_data keys: ${Object.keys(creative.object_story_spec.template_data).join(',')}`);
    }
    console.log(urls.length
      ? urls.map((u) => `    URL  ${u.path} = ${u.url}`).join('\n')
      : '    URL  (none anywhere in the creative)');

    // The post the resolver never reads for these ads: its lookup is gated on
    // missing BODY, and these have body. Ask whether the post carries a link.
    if (storyId) {
      if (pageToken === null) pageToken = (await fetchFacebookPageAccessToken(conn)) || token;
      const post = await getWithNegotiation(
        storyId, ['permalink_url', 'attachments{target,url,title,unshimmed_url}'], pageToken, `post ${storyId}`);
      if (post.error) {
        console.log(`    POST read failed: ${post.error}`);
      } else {
        tally.post_read_ok += 1;
        const pUrls = urlsWithPaths(post.data);
        if (pUrls.length) tally.post_with_url += 1;
        console.log(pUrls.length
          ? pUrls.map((u) => `    POST ${u.path} = ${u.url}`).join('\n')
          : '    POST (no url on the post either)');
      }
    }
    console.log('');
  }

  console.log('=== summary ===');
  console.log(JSON.stringify(tally, null, 2));
  console.log('\nurl paths seen on the creative (path -> ads):');
  console.log([...pathHits.entries()].sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `  ${n.toString().padStart(4)}  ${p}`).join('\n') || '  (none)');
  console.log('\nfields this account REFUSED (field -> ads):');
  console.log([...refusals.entries()].sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `  ${n.toString().padStart(4)}  ${f}`).join('\n') || '  (none)');
}

main().catch((err) => { console.error('[probe] fatal', err); process.exit(1); });
