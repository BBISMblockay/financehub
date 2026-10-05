/* Setup guides for integrations that need work on the OTHER side first.
 *
 * OAuth connections (Google, TikTok, QuickBooks, Connect with Shopify) are one
 * click and need no guide. These do: the person has to go to Shopify, Meta or
 * Redo, create something there (an app, a system user, a webhook), and bring a
 * credential back. A two-line hint under a form field was not enough for that,
 * so each guide is a step-by-step drawer: what you need first, numbered steps
 * with the outside links, values to copy, where it lands in SILO, and the
 * failures people actually hit.
 *
 * Guides are DATA. The page opens one with
 *   SiloIntegrationGuides.open(key, { ctx, onAction })
 * where ctx carries live values (Redo's webhook URL exists only once
 * connected) and onAction(actionId) lets the page jump to its own form.
 *
 * The Shopify scope list must equal PUBLIC_SCOPES in
 * scripts/lib/shopify-auth-lib.mjs -- the function refuses a token missing one,
 * so a guide listing a different set walks someone into a failure.
 * scripts/tests/integration-guides.test.mjs pins it.
 *
 * Browser: window.SiloIntegrationGuides. Node: module.exports (tests). */
(function (root) {
  const SHOPIFY_SCOPES = [
    'read_orders',
    'read_products',
    'read_inventory',
    'read_locations',
    'read_shopify_payments_payouts',
    'read_draft_orders',
    'read_reports',
    'read_publications',
  ];
  // The store's OWN app is custom-distributed in its own organization -- the
  // same kind of app as Baseballism's, which holds read_all_orders and so
  // backfills full history. Only SILO's PUBLIC app has to wait for Shopify to
  // approve that scope (hence its absence from PUBLIC_SCOPES). Without it the
  // Admin API returns just the last 60 days of orders, silently, so a history
  // import looks complete and is not. The own-app route therefore asks for it.
  const SHOPIFY_OWN_APP_SCOPES = SHOPIFY_SCOPES.concat(['read_all_orders']);
  const META_ADS_SCOPES = ['ads_read', 'business_management'];
  // pages_show_list is what lets Test's /me/accounts lookup list the Pages;
  // without it Meta refuses that call and the tester shows no Pages at all.
  const META_ORGANIC_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights'];
  const REDO_MARKETING_SCOPES = [
    'Campaigns',
    'Marketing automations',
    'Campaign analytics',
    'Marketing automation analytics',
    'Marketing templates',
  ];

  /* Step shape:
   *   title   short imperative
   *   body    HTML (trusted -- authored here, never from data)
   *   link    { href, label }   opens in a new tab
   *   copy    [{ label, value }] copy-to-clipboard chips
   *   note    HTML, a muted aside under the step
   * Anything from ctx is escaped before it reaches HTML. */
  const GUIDES = {
    shopify_dev_app: {
      title: 'Connect a Shopify store with its own app',
      summary: 'You create a small private app in Shopify, give it read-only access, and paste its Client ID and Client secret into SILO. SILO never sees your Shopify password.',
      time: 'About 10 minutes',
      needs: [
        'The <strong>store owner</strong> login (or a staff account allowed to develop apps)',
        'The store\'s <code>.myshopify.com</code> address',
      ],
      steps: [
        {
          title: 'Find the store\'s Shopify address',
          body: 'Open the store\'s Shopify admin. The address bar reads <code>admin.shopify.com/store/<strong>your-store</strong>/…</code> — the store address is <code><strong>your-store</strong>.myshopify.com</code>. It often differs from the store\'s public name.',
        },
        {
          title: 'Open Shopify\'s Dev Dashboard',
          body: 'Sign in with the <strong>same account that owns the store</strong>. The app must be created in the store\'s own Shopify organization — an app made under a different organization is refused when SILO asks for access.',
          link: { href: 'https://dev.shopify.com/dashboard', label: 'Open Dev Dashboard' },
        },
        {
          title: 'Create an app',
          body: 'Choose <strong>Create app</strong> and name it anything (e.g. <code>SILO</code>).',
        },
        {
          title: 'Give it read-only access, then release',
          body: 'Create a new <strong>version</strong> of the app. Under access scopes, add each of these, then <strong>Release</strong> the version. All are read-only; SILO cannot change anything in your store.',
          copy: [{ label: 'Copy all scopes', value: SHOPIFY_OWN_APP_SCOPES.join(',') }],
          scopes: SHOPIFY_OWN_APP_SCOPES,
          note: '<strong>Don\'t skip <code>read_all_orders</code>.</strong> Without it Shopify only returns the last 60 days of orders, so SILO cannot import your sales history. If Shopify asks you to request access to it, submit the request before releasing.',
        },
        {
          title: 'Install the app on the store',
          body: 'From the app\'s overview choose <strong>Install app</strong> and pick this store. Approve the access prompt.',
        },
        {
          title: 'Copy the Client ID and Client secret',
          body: 'In the app\'s <strong>Settings</strong>, copy the <strong>Client ID</strong> and the <strong>Client secret</strong>.',
          note: 'Treat the secret like a password. SILO checks the pair with Shopify before saving and stores the secret where only SILO\'s servers can read it.',
        },
        {
          title: 'Paste them into SILO',
          body: 'In <strong>Add Shopify store</strong>, enter the store address, Client ID and Client secret, then click <strong>Connect store</strong>.',
        },
        {
          title: 'Finish setup in SILO',
          body: 'On the new store row: <strong>Test</strong> (confirms every scope is granted), map its locations, then switch on <strong>Nightly sync</strong> and start the history import.',
        },
      ],
      troubleshooting: [
        { q: 'Shopify refused the app / "shop and app must belong to the same organization"', a: 'The app was created while signed in to a different Shopify organization. Sign in as the store owner, create the app again from the Dev Dashboard, and use the new Client ID and secret.' },
        { q: 'The store row warns about missing scopes', a: 'Add the missing scope in a new app version, release it, approve the update in the store admin if Shopify asks, then click <strong>Re-test</strong> in SILO.' },
        { q: 'The store row says order history is limited to 60 days', a: 'The app is missing <code>read_all_orders</code>. In the Dev Dashboard, add it to a new app version (request access if Shopify asks), release it, approve the update in the store admin, then click <strong>Re-test</strong> in SILO. Run the history import <em>after</em> the warning is gone — an import started without it only reaches 60 days back.' },
      ],
      action: { id: 'shopify_form', label: 'Go to the Shopify form' },
    },

    shopify_token: {
      title: 'Use an existing Shopify Admin API token',
      summary: 'Only for stores that created a "Develop apps" custom app in their admin before 2026. Shopify no longer lets stores create new ones — use the store\'s own app instead if you don\'t already have a token.',
      time: 'About 3 minutes',
      needs: ['The store owner login', 'An existing custom app in the store admin'],
      steps: [
        {
          title: 'Open the custom app',
          body: 'In the store admin go to <strong>Settings → Apps and sales channels → Develop apps</strong> and open the existing app.',
        },
        {
          title: 'Check its access',
          body: 'Under <strong>Configuration</strong>, the Admin API access should include these read scopes:',
          scopes: SHOPIFY_SCOPES,
        },
        {
          title: 'Copy the Admin API access token',
          body: 'Under <strong>API credentials</strong>, the token starts with <code>shpat_</code>. Shopify shows it only once; if it was never saved, it cannot be revealed again — use the store\'s own app route instead.',
        },
        {
          title: 'Paste it into SILO',
          body: 'In <strong>Add Shopify store</strong>, enter the store address, open <strong>Already have an Admin API token?</strong>, paste it and click <strong>Save token</strong>. Then Test the row.',
        },
      ],
      troubleshooting: [
        { q: '"Develop apps" is missing from the admin', a: 'The store has no legacy custom app and can no longer create one. Use <strong>Connect with your store\'s own app</strong>.' },
      ],
      action: { id: 'shopify_token_form', label: 'Go to the token field' },
    },

    meta_ads: {
      title: 'Connect Meta Ads with a System User token',
      summary: 'Meta has no one-click connect for this. Confirm a Business app in your portfolio, create a system user, assign your ad account, and generate a long-lived token.',
      time: 'About 15 minutes',
      needs: [
        '<strong>Admin</strong> access to the Meta Business portfolio that owns the ad account',
        'A Meta app of type <strong>Business</strong> (step 1 creates one if you have none)',
      ],
      steps: [
        {
          title: 'Make sure you have a Business app',
          body: 'If the portfolio already has an app, skip this. Otherwise create one of type <strong>Business</strong>, connected to the same portfolio. You need the app before a system user can generate a token.',
          link: { href: 'https://developers.facebook.com/apps', label: 'Open Meta for Developers' },
          note: 'After step 2, in Business settings → <strong>Accounts → Apps</strong>, assign the system user to this app — you pick that app when generating the token.',
        },
        {
          title: 'Create a system user',
          body: 'In Business settings go to <strong>Users → System users → Add</strong>. Name it <code>SILO</code>; the Admin role is fine.',
          link: { href: 'https://business.facebook.com/settings/system-users', label: 'Open System users' },
        },
        {
          title: 'Give it the ad account',
          body: 'On the system user choose <strong>Assign assets → Ad accounts</strong>, pick your ad account and grant view-performance (read) access. Repeat for each ad account SILO should report on.',
        },
        {
          title: 'Generate the token',
          body: 'Back on the system user choose <strong>Generate new token</strong>, pick the app, set expiration to <strong>Never</strong>, and tick these permissions:',
          scopes: META_ADS_SCOPES,
          note: 'Want organic Instagram and Facebook Page reporting too? Also tick the permissions in "Optional: organic insights" below before generating.',
        },
        {
          title: 'Copy the token',
          body: 'Meta shows the token (it starts with <code>EAA</code>) only once. Copy it now.',
        },
        {
          title: 'Paste it into SILO',
          body: 'Click <strong>Add Meta Ads token…</strong>, paste the token and save. Leave the ad account ID blank if unsure — <strong>Test</strong> lists the accounts the token can see so you can pick one. Then switch on Nightly sync.',
        },
      ],
      extra: {
        title: 'Optional: organic insights (Instagram posts, Facebook Page)',
        steps: [
          { title: 'Add four permissions to the token', body: 'Regenerate the token with these added alongside the two above:', scopes: META_ORGANIC_SCOPES },
          { title: 'Assign the Page to the system user', body: 'System user → <strong>Assign assets → Pages</strong> → your Page, at least Analyst access. Permissions alone don\'t grant Page access.' },
          { title: 'Link Instagram to the Page', body: 'The Instagram professional account must be linked to that Facebook Page.' },
          { title: 'Fill in the two IDs', body: 'Click <strong>Test</strong> on the Meta row — it lists the Pages the token can see with their linked Instagram account. Enter the <strong>Facebook Page ID</strong> and <strong>Instagram Business Account ID</strong> on the row.' },
        ],
      },
      troubleshooting: [
        { q: 'I regenerated the token — where does the new one go?', a: 'Use <strong>Replace token</strong> on the existing Meta row. Do not use Add Meta Ads token again; that creates a second connection for the same account.' },
        { q: 'Test lists no ad accounts', a: 'The ad account isn\'t assigned to the system user (step 3), or the token was generated without <code>ads_read</code>.' },
        { q: '"Could not derive a Page access token" / error #190', a: 'The Page isn\'t assigned to the system user. Assign it (organic step 2); no new token is needed.' },
      ],
      action: { id: 'meta_form', label: 'Go to the Meta form' },
    },

    redo: {
      title: 'Connect Redo returns and marketing',
      summary: 'Redo pushes every return to SILO through a webhook you add in Redo. An optional API token adds campaign and automation reporting.',
      time: 'About 5 minutes',
      needs: ['Admin access to your Redo merchant dashboard'],
      steps: (ctx) => [
        {
          title: 'Create the connection in SILO',
          body: ctx.redoWebhookUrl
            ? 'Done — your webhook URL and secret are on the Redo row in SILO.'
            : 'Click <strong>Connect Redo…</strong>. SILO creates a webhook URL and a secret just for your company and shows them on the Redo row.',
          copy: ctx.redoWebhookUrl ? [{ label: 'Copy webhook URL', value: ctx.redoWebhookUrl }] : null,
        },
        {
          title: 'Add a webhook in Redo',
          body: 'In Redo\'s merchant dashboard, add a webhook subscription:<ul>'
            + '<li><strong>URL</strong> — the webhook URL from SILO</li>'
            + '<li><strong>Event</strong> — Return event (all statuses)</li>'
            + '<li><strong>Auth secret</strong> — the webhook secret from SILO (use its Copy button)</li></ul>',
          note: 'If you ever click Regenerate on the secret in SILO, paste the new one into Redo too, or deliveries stop.',
        },
        {
          title: 'Optional: API token for marketing reporting',
          body: 'In Redo\'s merchant admin, open the API settings and create a token with these <strong>read</strong> scopes, then paste it into the API secret field on the Redo row:',
          scopes: REDO_MARKETING_SCOPES,
        },
        {
          title: 'Check it\'s working',
          body: '<strong>Last event</strong> on the Redo row updates on the next return status change. Redo may also resend recent returns right after the webhook is added.',
        },
      ],
      troubleshooting: [
        { q: 'Last event never updates', a: 'The URL or secret in Redo doesn\'t match SILO\'s. Copy both again from the Redo row.' },
        { q: 'Marketing numbers are missing', a: 'The API token is missing the marketing read scopes; the nightly records the sync as skipped. Create a token with all five scopes and paste it in.' },
      ],
      action: { id: 'redo_row', label: 'Go to the Redo row' },
    },
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const safeHref = (h) => (/^https:\/\/[^\s"'<>]+$/.test(String(h || '')) ? h : null);

  function resolve(key, ctx) {
    const g = GUIDES[key];
    if (!g) return null;
    const c = ctx || {};
    return { ...g, key, steps: typeof g.steps === 'function' ? g.steps(c) : g.steps };
  }

  function stepHtml(s, i) {
    const href = s.link && safeHref(s.link.href);
    const scopes = s.scopes && s.scopes.length
      ? `<div class="ig-scopes">${s.scopes.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : '';
    const copies = (s.copy || []).filter((c) => c && c.value).map((c, j) =>
      `<button type="button" class="ig-copy" data-copy="${i}:${j}">${esc(c.label)}</button>`).join('');
    return `<li class="ig-step">
      <div class="ig-step-num" aria-hidden="true">${i + 1}</div>
      <div class="ig-step-main">
        <div class="ig-step-title">${esc(s.title)}</div>
        <div class="ig-step-body">${s.body || ''}</div>
        ${scopes}
        ${(href || copies) ? `<div class="ig-step-actions">
          ${href ? `<a class="ig-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(s.link.label)} ↗</a>` : ''}
          ${copies}</div>` : ''}
        ${s.note ? `<div class="ig-step-note">${s.note}</div>` : ''}
      </div>
    </li>`;
  }

  function render(key, ctx) {
    const g = resolve(key, ctx);
    if (!g) return '';
    const offset = g.steps.length;
    return `
      <header class="ig-head">
        <div>
          <div class="ig-kicker">Setup guide · ${esc(g.time)}</div>
          <h2 class="ig-title" id="ig-title">${esc(g.title)}</h2>
        </div>
        <button type="button" class="ig-close" data-ig-close aria-label="Close guide">×</button>
      </header>
      <div class="ig-body">
        <p class="ig-summary">${g.summary}</p>
        ${g.needs && g.needs.length ? `<section class="ig-needs">
          <div class="ig-section-label">Before you start</div>
          <ul>${g.needs.map((n) => `<li>${n}</li>`).join('')}</ul>
        </section>` : ''}
        <ol class="ig-steps">${g.steps.map(stepHtml).join('')}</ol>
        ${g.extra ? `<details class="ig-extra">
          <summary>${esc(g.extra.title)}</summary>
          <ol class="ig-steps">${g.extra.steps.map((s, i) => stepHtml(s, offset + i)).join('')}</ol>
        </details>` : ''}
        ${g.troubleshooting && g.troubleshooting.length ? `<section class="ig-trouble">
          <div class="ig-section-label">If something goes wrong</div>
          ${g.troubleshooting.map((t) => `<details><summary>${esc(t.q)}</summary><div>${t.a}</div></details>`).join('')}
        </section>` : ''}
        <p class="ig-fineprint">Button names on the other site can shift slightly as they update their dashboards.</p>
      </div>
      ${g.action ? `<footer class="ig-foot">
        <button type="button" class="bcn-btn bcn-btn--ghost" data-ig-close>Close</button>
        <button type="button" class="bcn-btn bcn-btn--primary" data-ig-action="${esc(g.action.id)}">${esc(g.action.label)}</button>
      </footer>` : ''}`;
  }

  // Every copy chip's value, addressed by "<step index>:<chip index>" across
  // the main steps then the extra steps, the same numbering render() uses.
  function copyValues(key, ctx) {
    const g = resolve(key, ctx);
    const out = {};
    if (!g) return out;
    const all = g.steps.concat(g.extra ? g.extra.steps : []);
    all.forEach((s, i) => (s.copy || []).forEach((c, j) => { if (c && c.value) out[`${i}:${j}`] = c.value; }));
    return out;
  }

  let dialog = null;
  function open(key, opts) {
    const o = opts || {};
    const doc = root.document;
    if (!doc || !GUIDES[key]) return false;
    if (!dialog) {
      dialog = doc.createElement('dialog');
      dialog.className = 'ig-drawer';
      dialog.setAttribute('aria-labelledby', 'ig-title');
      doc.body.appendChild(dialog);
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    }
    dialog.innerHTML = render(key, o.ctx);
    const values = copyValues(key, o.ctx);
    dialog.querySelectorAll('[data-ig-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
    dialog.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const label = b.textContent;
      try {
        await root.navigator.clipboard.writeText(values[b.dataset.copy]);
        b.textContent = 'Copied ✓';
      } catch (_) {
        b.textContent = 'Copy failed — select it by hand';
      }
      setTimeout(() => { b.textContent = label; }, 1800);
    }));
    const act = dialog.querySelector('[data-ig-action]');
    if (act) act.addEventListener('click', () => {
      dialog.close();
      if (typeof o.onAction === 'function') o.onAction(act.dataset.igAction);
    });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    const body = dialog.querySelector('.ig-body');
    if (body) body.scrollTop = 0;
    return true;
  }

  const api = { GUIDES, SHOPIFY_SCOPES, SHOPIFY_OWN_APP_SCOPES, META_ADS_SCOPES, META_ORGANIC_SCOPES, REDO_MARKETING_SCOPES, resolve, render, copyValues, open, keys: () => Object.keys(GUIDES) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SiloIntegrationGuides = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
