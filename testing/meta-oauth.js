/* Meta App Review test page (/testing/meta-oauth.html).
 *
 * The page is a thin client: it signs the user in, then talks ONLY to
 *   meta-oauth-start  (return_to: 'review_test')  -> the Facebook dialog URL
 *   meta-oauth-review (status, list_assets, select_assets, verify, sync, stored)
 * Both functions re-check, on every call, that the caller's ACTIVE workspace is
 * allow-listed for App Review and that they administer it, and act only on
 * connections marked as review tests. The page never writes to the database
 * itself (pinned by scripts/tests/meta-oauth-review.test.mjs), so hiding or
 * editing anything here cannot widen what it can touch. */
(async function () {
  const cfg = window.__SILO_CONFIG__ || {};
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, type = 'info', ms = 0) {
    const el = $('status');
    el.className = `bcn-status bcn-status--${type}`;
    el.textContent = msg;
    el.hidden = false;
    if (ms) setTimeout(() => { el.hidden = true; }, ms);
  }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) { setStatus('Missing Supabase config', 'neg'); return; }
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const FUNCTIONS_URL = `${cfg.SUPABASE_URL}/functions/v1`;

  const { data: { session } } = await db.auth.getSession();
  if (!session?.user) {
    window.location.href = '/pages/login.html?next=' + encodeURIComponent('/testing/meta-oauth.html');
    return;
  }
  const co = await cfg.ensureActiveCompany?.(db) || null;

  const { callFunction, createAssetSession, withBusy } = window.SiloMetaReviewClient;

  // Always { status, data }: a rejected fetch arrives as status 0 + data.error.
  async function call(fn, body) {
    let token = '';
    try { token = (await db.auth.getSession()).data?.session?.access_token || ''; } catch (_) { /* sent without; the function answers 401 */ }
    return callFunction(fetch, `${FUNCTIONS_URL}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }
  const review = (action, extra = {}) => call('meta-oauth-review', { action, ...extra });

  // The return from Facebook: read it once, then clear it from the URL.
  const params = new URLSearchParams(window.location.search);
  const returned = {
    connected: params.get('oauth_connected') === '1',
    connectionId: params.get('connection_id'),
    reconnected: params.get('reconnected') === '1',
    error: params.get('oauth_error'),
  };
  if (params.toString()) history.replaceState(null, '', window.location.pathname);

  let connections = [];
  async function loadStatus() {
    const { status, data } = await review('status');
    if (status === 503) { $('mo-workspace').textContent = 'App Review test mode is not configured on the server.'; return false; }
    if (status === 403) {
      $('mo-workspace').textContent = `Not available in this workspace${co?.title ? ` (${co.title})` : ''}. `
        + 'This page works only in the App Review test workspace, for its admins. Switch workspace, then reload.';
      return false;
    }
    if (!data.ok) {
      $('mo-workspace').textContent = 'Could not check access. Reload the page to try again.';
      setStatus(data.error || `Could not load (HTTP ${status})`, 'neg');
      return false;
    }
    $('mo-workspace').textContent = `Workspace: ${data.company.title || data.company.id}`;
    connections = data.connections || [];
    $('mo-connect-card').hidden = false;
    $('mo-conns-card').hidden = false;
    renderConnections();
    return true;
  }

  function renderConnections() {
    const tbody = $('mo-conns');
    if (!connections.length) {
      tbody.innerHTML = '<tr><td class="mo-wrapcell" colspan="3">No test connection yet. Click Connect Meta.</td></tr>';
      return;
    }
    tbody.innerHTML = connections.map((c) => `<tr>
      <td class="mo-wrapcell"><strong>${esc(c.display_name)}</strong><br>
        <span class="mo-muted">token: <span class="bcn-mono">${esc(c.oauth.token_type || '—')}</span>
        · connected ${esc((c.oauth.connected_at || c.created_at || '').slice(0, 16).replace('T', ' '))}</span></td>
      <td class="mo-wrapcell bcn-mono">ad account: ${esc(c.meta_ad_account_id || '—')}<br>
        Page: ${esc(c.facebook_page_id || '—')}<br>Instagram: ${esc(c.instagram_business_account_id || '—')}</td>
      <td class="mo-wrapcell"><div class="mo-actions">
        <button class="bcn-btn bcn-btn--ghost" data-act="assets" data-id="${esc(c.id)}">Choose assets</button>
        <button class="bcn-btn bcn-btn--ghost" data-act="verify" data-id="${esc(c.id)}">Verify permissions</button>
        <button class="bcn-btn bcn-btn--ghost" data-act="sync" data-id="${esc(c.id)}">Sync now</button>
        <button class="bcn-btn bcn-btn--ghost" data-act="stored" data-id="${esc(c.id)}">Stored data</button>
        <button class="bcn-btn bcn-btn--ghost" data-act="reconnect" data-id="${esc(c.id)}">Reconnect</button>
      </div></td></tr>`).join('');
    tbody.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => ACTIONS[b.dataset.act](b.dataset.id, b)));
  }


  // ── Rendering the verify result as app UI, not a debug dump ──────────────
  // Meta's App Review (2026-10-26) rejected five permissions because the
  // screencast showed data the reviewer could not attribute to an asset, in a
  // raw JSON blob. These two helpers put the asset's NAME on screen and render
  // each result as labelled fields and small tables.
  const LABEL = {
    fan_count: 'Followers', followers_count: 'Followers', media_count: 'Posts',
    page_token_issued: 'Page access token issued', account_status: 'Account status',
    selected_page_listed: 'Selected Page is in the list', page_names: 'Pages',
    media_id: 'Media', posted_at: 'Posted', permalink: 'Link',
  };
  const labelFor = (k) => LABEL[k] || (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');
  const scalar = (v) => (v === true ? 'yes' : v === false ? 'no' : v === null || v === undefined ? '—' : esc(v));

  /** A list of like-shaped objects as a small table; anything else as labelled
   *  lines. Falls back to JSON only for a shape this does not know, so an
   *  unexpected answer is still visible rather than silently dropped. */
  function detailHtml(detail) {
    if (detail === null || detail === undefined) return '<span class="mo-muted">—</span>';
    if (typeof detail !== 'object') return `<div>${esc(detail)}</div>`;
    if (Array.isArray(detail)) return rowsTable(detail);
    return Object.entries(detail).map(([k, v]) => {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        return `<div class="mo-field"><span class="mo-field-k">${esc(labelFor(k))}</span></div>${rowsTable(v)}`;
      }
      if (Array.isArray(v)) {
        return `<div class="mo-field"><span class="mo-field-k">${esc(labelFor(k))}</span>
          <span class="mo-field-v">${v.length ? v.map(scalar).join(', ') : '—'}</span></div>`;
      }
      if (v && typeof v === 'object') {
        return `<div class="mo-field"><span class="mo-field-k">${esc(labelFor(k))}</span>
          <span class="mo-field-v">${Object.entries(v).map(([k2, v2]) => `${esc(labelFor(k2))}: ${scalar(v2)}`).join(' · ')}</span></div>`;
      }
      return `<div class="mo-field"><span class="mo-field-k">${esc(labelFor(k))}</span>
        <span class="mo-field-v">${scalar(v)}</span></div>`;
    }).join('');
  }

  function rowsTable(items) {
    if (!items.length) return '<div class="mo-muted">None returned</div>';
    if (typeof items[0] !== 'object' || items[0] === null) {
      return `<div class="mo-field-v">${items.map(scalar).join(', ')}</div>`;
    }
    // A metric series arrives as { metric, days:[{day,value}] }: render one
    // row per day under the metric's name, so a day's VALUE is on screen.
    if (items[0] && Array.isArray(items[0].days)) {
      return items.map((sv) => `<div class="mo-field"><span class="mo-field-k">${esc(sv.metric || 'metric')}</span></div>
        <table class="bcn-table mo-mini"><thead><tr><th class="bcn-th-left">Day</th><th>Value</th></tr></thead><tbody>
        ${(sv.days || []).map((d) => `<tr><td class="bcn-mono">${esc(d.day)}</td><td class="bcn-num">${scalar(d.value)}</td></tr>`).join('')
          || '<tr><td colspan="2" class="mo-muted">No days returned</td></tr>'}</tbody></table>`).join('');
    }
    const cols = [...new Set(items.flatMap((i) => Object.keys(i || {})))];
    return `<table class="bcn-table mo-mini"><thead><tr>${cols.map((c) => `<th class="bcn-th-left">${esc(labelFor(c))}</th>`).join('')}</tr></thead><tbody>
      ${items.map((i) => `<tr>${cols.map((c) => `<td class="mo-wrapcell">${scalar(i?.[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  /** The selected assets, by NAME, above the results. This is the single thing
   *  every one of the five rejections asked for. */
  function assetsHeaderHtml(assets) {
    const a = assets || {};
    const parts = [];
    if (a.ad_account) parts.push(`<span class="mo-asset"><b>Ad account</b> ${esc(a.ad_account.name || a.ad_account.id)}
      <small class="bcn-mono">${esc(a.ad_account.id)}${a.ad_account.currency ? ` · ${esc(a.ad_account.currency)}` : ''}</small></span>`);
    if (a.page) parts.push(`<span class="mo-asset"><b>Facebook Page</b> ${esc(a.page.name || a.page.id)}
      <small class="bcn-mono">${esc(a.page.id)}${a.page.fan_count == null ? '' : ` · ${esc(a.page.fan_count)} followers`}</small></span>`);
    if (a.instagram) parts.push(`<span class="mo-asset"><b>Instagram</b> ${a.instagram.username ? `@${esc(a.instagram.username)}` : esc(a.instagram.id)}
      <small class="bcn-mono">${esc(a.instagram.id)}${a.instagram.name ? ` · ${esc(a.instagram.name)}` : ''}</small></span>`);
    if (!parts.length) return '';
    return `<div class="mo-assets-head">${parts.join('')}</div>`;
  }

  function showResult(title, html) {
    $('mo-result-title').textContent = title;
    $('mo-result').innerHTML = html;
    $('mo-result-card').hidden = false;
  }

  async function startOAuth(btn, connectionId) {
    if (!co?.id) { setStatus('No active workspace', 'neg', 5000); return; }
    const { data } = await withBusy(btn, 'Redirecting…', () => call('meta-oauth-start', {
      company_entity_id: co.id, return_to: 'review_test', ...(connectionId ? { connection_id: connectionId } : {}),
    }));
    if (data.url) { window.location.href = data.url; return; }
    setStatus('Could not start: ' + (data.error || 'no dialog URL returned'), 'neg', 10000);
  }

  // The chooser's connection and its asset list live together; a slower answer
  // for an earlier click is dropped, so Save always targets what is shown.
  const assets = createAssetSession();
  async function chooseAssets(id) {
    const token = assets.begin(id);
    $('mo-save-assets').disabled = true;
    $('mo-assets-card').hidden = false;
    $('mo-assets').innerHTML = '<p class="mo-muted">Asking Meta what this login can reach…</p>';
    const { data } = await review('list_assets', { connection_id: id });
    if (!assets.isCurrent(token)) return;
    if (!data.ok) { $('mo-assets').innerHTML = `<p>✗ ${esc(data.error || 'Could not list assets')}</p>`; return; }
    assets.accept(token, data);
    const conn = connections.find((c) => c.id === id) || {};
    const accts = [`<label class="mo-choice"><input type="radio" name="mo-acct" value="" ${conn.meta_ad_account_id || data.ad_accounts.length ? '' : 'checked'}><span>No ad account</span></label>`]
      .concat(data.ad_accounts.map((a, i) => `<label class="mo-choice"><input type="radio" name="mo-acct" value="${esc(a.id)}"
        ${a.id === conn.meta_ad_account_id || (!conn.meta_ad_account_id && i === 0) ? 'checked' : ''}>
        <span>${esc(a.name || a.id)}<small class="bcn-mono">${esc(a.id)} · ${esc(a.currency || '')}</small></span></label>`)).join('');
    const pages = [`<label class="mo-choice"><input type="radio" name="mo-page" value="" ${conn.facebook_page_id ? '' : 'checked'}><span>No Page</span></label>`]
      .concat(data.pages.map((p) => `<label class="mo-choice"><input type="radio" name="mo-page" value="${esc(p.page_id)}"
        ${p.page_id === conn.facebook_page_id ? 'checked' : ''}>
        <span>${esc(p.page_name || p.page_id)}<small>${p.instagram_business_account_id
          ? `Instagram: @${esc(p.instagram_username || p.instagram_business_account_id)}` : 'no linked Instagram account'}</small></span></label>`)).join('');
    $('mo-assets').innerHTML = `${data.truncated ? '<p class="mo-muted">Meta has more assets than SILO lists here (1,000 per type). Only the listed ones can be chosen.</p>' : ''}
      <h3>Ad account</h3>${data.ad_accounts.length ? '' : '<p class="mo-muted">This login reaches no ad account. Page and Instagram can still be saved and verified; ads_read needs an ad account (reconnect and grant one).</p>'}${accts}
      <h3>Facebook Page</h3>${pages}${data.pages_error ? `<p class="mo-muted">Pages could not be listed: ${esc(data.pages_error)}</p>` : ''}
      <label class="mo-choice"><input type="checkbox" id="mo-include-ig" ${conn.instagram_business_account_id || !conn.facebook_page_id ? 'checked' : ''}>
        <span>Include the Page's linked Instagram account</span></label>`;
    $('mo-save-assets').disabled = false;
  }

  async function saveAssets(btn) {
    const active = assets.active();
    if (!active) { setStatus('Wait for the asset list to load', 'neg', 5000); return; }
    const acct = document.querySelector('input[name="mo-acct"]:checked')?.value || '';
    const page = document.querySelector('input[name="mo-page"]:checked')?.value || '';
    const pageRow = (active.data.pages || []).find((p) => p.page_id === page);
    const ig = $('mo-include-ig')?.checked && pageRow?.instagram_business_account_id ? pageRow.instagram_business_account_id : null;
    const { data } = await withBusy(btn, 'Saving…', () => review('select_assets', {
      connection_id: active.connectionId, ad_account_id: acct || null, page_id: page || null, instagram_business_account_id: ig,
    }));
    if (!data.ok) { setStatus('Not saved: ' + (data.error || 'unknown error'), 'neg', 10000); return; }
    setStatus('✓ Assets saved to this test connection. Next: Verify permissions.', 'pos', 8000);
    // A newer "Choose assets" click since this save keeps its chooser open.
    if (assets.isCurrent(active.token)) { assets.clear(active.token); $('mo-assets-card').hidden = true; }
    await loadStatus();
  }

  const ACTIONS = {
    assets: (id) => chooseAssets(id),
    reconnect: (id, btn) => startOAuth(btn, id),
    async verify(id, btn) {
      const { data } = await withBusy(btn, 'Checking…', () => review('verify', { connection_id: id }));
      if (!data.ok) { setStatus(data.error || 'Verify failed', 'neg', 10000); return; }
      showResult('Permission check (read-only; nothing stored)', `${assetsHeaderHtml(data.assets)}
        <table class="bcn-table"><thead><tr>
        <th class="bcn-th-left">Permission</th><th class="bcn-th-left">Graph call</th><th class="bcn-th-left">Result</th><th class="bcn-th-left">What came back</th></tr></thead><tbody>
        ${data.checks.map((c) => `<tr><td class="bcn-mono">${esc(c.permission)}</td><td class="mo-wrapcell bcn-mono">${esc(c.endpoint)}</td>
          <td><span class="bcn-pill ${c.ok === true ? 'bcn-pill--pos' : c.ok === false ? 'bcn-pill--neg' : ''}">${c.ok === true ? 'ok' : c.ok === false ? 'error' : 'skipped'}</span></td>
          <td class="mo-wrapcell">${typeof c.detail === 'string' ? esc(c.detail) : detailHtml(c.detail)}</td></tr>`).join('')}
        </tbody></table>`);
    },
    async sync(id, btn) {
      const { data } = await withBusy(btn, 'Syncing…', () => review('sync', { connection_id: id }));
      if (!data.ok) { setStatus('Sync failed: ' + (data.error || 'unknown error'), 'neg', 12000); return; }
      setStatus(`✓ Synced ${data.kpi_rows_upserted} daily campaign rows (${data.window?.startDate || ''} → ${data.window?.endDate || ''}).`, 'pos', 10000);
      ACTIONS.stored(id);
    },
    async stored(id) {
      const { data } = await review('stored', { connection_id: id });
      if (!data.ok) { setStatus(data.error || 'Could not read stored data', 'neg', 10000); return; }
      const s = data.stored;
      showResult('Stored in this workspace', `<p class="bcn-mono">marketing_kpis_daily: ${esc(s.marketing_kpis_daily)} ·
        meta_ad_performance_daily: ${esc(s.meta_ad_performance_daily)} · facebook_page_insights_daily: ${esc(s.facebook_page_insights_daily)} ·
        instagram_media_insights: ${esc(s.instagram_media_insights)} · instagram_account_profile: ${esc(s.instagram_account_profile)} ·
        instagram_account_insights_daily: ${esc(s.instagram_account_insights_daily)} · facebook_page_posts: ${esc(s.facebook_page_posts)}</p>
        <table class="bcn-table"><thead><tr><th class="bcn-th-left">Day</th><th class="bcn-th-left">Campaign</th><th>Impressions</th><th>Clicks</th><th>Spend</th></tr></thead><tbody>
        ${(s.recent_campaign_days || []).map((r) => `<tr><td class="bcn-mono">${esc(r.day_date)}</td><td class="mo-wrapcell">${esc(r.campaign_name)}</td>
          <td class="bcn-num">${esc(r.impressions)}</td><td class="bcn-num">${esc(r.clicks)}</td><td class="bcn-num">${esc(r.spend)}</td></tr>`).join('')
          || '<tr><td class="mo-wrapcell" colspan="5">Nothing synced yet.</td></tr>'}</tbody></table>
        <p class="mo-muted">Sync now stores daily campaign totals. Ad-level rows, Page insights and Instagram media are written by the nightly sync, which stays off for test connections unless it is switched on separately.</p>`);
    },
  };

  $('mo-connect').addEventListener('click', (e) => startOAuth(e.target, null));
  $('mo-save-assets').addEventListener('click', (e) => saveAssets(e.currentTarget));
  $('mo-cancel-assets').addEventListener('click', () => { assets.clear(); $('mo-assets-card').hidden = true; });

  if (!(await loadStatus())) return;
  if (returned.error) setStatus(`Meta connection did not complete: ${returned.error.replace(/_/g, ' ')}`, 'neg', 15000);
  if (returned.connected) {
    if (!connections.some((c) => c.id === returned.connectionId)) {
      setStatus('That connection belongs to a different workspace. Switch to it to finish.', 'neg', 12000);
    } else {
      setStatus(returned.reconnected ? '✓ Reconnected. Choose assets or verify.' : '✓ Connected. Choose the assets to use.', 'pos', 8000);
      chooseAssets(returned.connectionId);
    }
  }
})();
