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
  // Deep links verified 2026-10-05: each resolves to Meta login with ?next= pointing
  // at the same path (business.facebook.com/settings/*, developers.facebook.com/apps).
  const META_BUSINESS_SETTINGS = 'https://business.facebook.com/settings';
  const META_SYSTEM_USERS = 'https://business.facebook.com/settings/system-users';
  const META_PORTFOLIO_APPS = 'https://business.facebook.com/settings/apps';
  const META_DEVELOPERS_APPS = 'https://developers.facebook.com/apps';
  const META_SYSTEM_USER_HELP = 'https://www.facebook.com/business/help/503306463479099';
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
      summary: 'Meta splits this across two sites: create/register a <strong>Business app</strong> once, then do everything else in <strong>Business settings → System users</strong> (create user, assign assets, generate token) without leaving that screen.',
      time: 'About 15 minutes',
      needs: [
        '<strong>Admin</strong> access to the Meta Business portfolio that owns the ad account',
        'After each link opens, confirm the <strong>correct business portfolio</strong> is selected (top-left on Business settings)',
        'A Meta app of type <strong>Business</strong> linked to that portfolio (step 1 — Meta requires this before system users)',
      ],
      steps: [
        {
          title: 'Register a Business app on the portfolio',
          body: '<strong>A — Create (only if you have no app yet):</strong> In Meta for Developers, <strong>Create app</strong> → type <strong>Business</strong> → connect it to the same Business portfolio that owns your ad account.<br><br>'
            + '<strong>B — Add it to the portfolio (required either way):</strong> In Business settings go to <strong>Accounts → Apps → Add</strong>, and connect the app. SILO needs the app to appear here before a system user can generate a token.',
          links: [
            { href: META_DEVELOPERS_APPS, label: 'Meta for Developers (create app)' },
            { href: META_PORTFOLIO_APPS, label: 'Business settings → Apps' },
          ],
          note: 'If the app already shows under Accounts → Apps, skip A and continue to step 2.',
        },
        {
          title: 'Open System users (your home base for the rest)',
          body: 'Go to <strong>Users → System users</strong> in the left sidebar. The next three steps all happen on the <strong>same system user</strong> record — you should not need another Meta product tab until you paste the token into SILO.',
          links: [
            { href: META_SYSTEM_USERS, label: 'Open System users' },
            { href: META_BUSINESS_SETTINGS, label: 'Business settings home' },
          ],
          note: 'Pick the correct business portfolio in the top-left if Meta prompts you.',
        },
        {
          title: 'Create the system user',
          body: 'Click <strong>Add new system user</strong> (or <strong>Add</strong>), name it <code>SILO</code>, and create it. Meta’s <strong>Admin</strong> system user role is fine for setup.',
        },
        {
          title: 'Assign the app and ad account (same user)',
          body: 'With <code>SILO</code> selected, use <strong>Assign assets</strong> (or <strong>Add assets</strong> / the <strong>⋯</strong> menu) twice:<ul>'
            + '<li><strong>Apps</strong> → your Business app → enable <strong>Develop app</strong> (or full app access). Without this, token generation will not list the app.</li>'
            + '<li><strong>Ad accounts</strong> → each account SILO should report → <strong>View performance</strong> (read) access.</li></ul>',
          link: { href: META_SYSTEM_USER_HELP, label: 'Meta’s official walkthrough' },
        },
        {
          title: 'Generate and copy the token',
          body: 'Still on that system user, choose <strong>Generate new token</strong> → select the Business app from step 1 → expiration <strong>Never</strong> → tick:',
          scopes: META_ADS_SCOPES,
          note: 'Want organic Instagram and Facebook Page reporting too? Also tick the permissions in "Optional: organic insights" below before generating. Meta shows the token (starts with <code>EAA</code>) <strong>once</strong> — copy it before closing the dialog.',
        },
        {
          title: 'Paste it into SILO',
          body: 'Click <strong>Add Meta Ads token…</strong> (or <strong>Replace token</strong> on an existing row), paste the token, and save. Leave the ad account ID blank if unsure — <strong>Test</strong> lists accounts the token can see. Then switch on <strong>Nightly sync</strong>.',
        },
      ],
      extra: {
        title: 'Optional: organic insights (Instagram posts, Facebook Page)',
        steps: [
          { title: 'Add four permissions to the token', body: 'Regenerate the token with these added alongside the two above:', scopes: META_ORGANIC_SCOPES },
          {
            title: 'Assign the Page to the system user',
            body: 'Back in Business settings → <strong>Users → System users</strong>, open the same <code>SILO</code> user → <strong>Assign assets → Pages</strong> → your Page with at least Analyst access. Token permissions alone do not grant Page access.',
            link: { href: META_SYSTEM_USERS, label: 'Open System users' },
          },
          { title: 'Link Instagram to the Page', body: 'The Instagram professional account must be linked to that Facebook Page.' },
          { title: 'Fill in the two IDs', body: 'Click <strong>Test</strong> on the Meta row — it lists the Pages the token can see with their linked Instagram account. Enter the <strong>Facebook Page ID</strong> and <strong>Instagram Business Account ID</strong> on the row.' },
        ],
      },
      troubleshooting: [
        { q: 'I regenerated the token — where does the new one go?', a: 'Use <strong>Replace token</strong> on the existing Meta row. Do not use Add Meta Ads token again; that creates a second connection for the same account.' },
        { q: 'Test lists no ad accounts', a: 'The ad account is not assigned to the system user (step 4), or the token was generated without <code>ads_read</code>.' },
        { q: 'Generate token does not list my app', a: 'The app is missing under Accounts → Apps (step 1B), or the system user does not have <strong>Develop app</strong> on that app (step 4).' },
        { q: 'Links open the wrong business', a: 'Use the portfolio picker (top-left in Business settings) before continuing. Every deep link keeps you in Business settings once signed in.' },
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

  function stepLinks(s) {
    const out = [];
    const push = (L) => {
      if (!L || !L.href || !L.label) return;
      const href = safeHref(L.href);
      if (href && !out.some((x) => x.href === href)) out.push({ href, label: L.label });
    };
    push(s.link);
    (s.links || []).forEach(push);
    return out;
  }

  function stepHtml(s, i) {
    const links = stepLinks(s);
    const scopes = s.scopes && s.scopes.length
      ? `<div class="ig-scopes">${s.scopes.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : '';
    const copies = (s.copy || []).filter((c) => c && c.value).map((c, j) =>
      `<button type="button" class="ig-copy" data-copy="${i}:${j}">${esc(c.label)}</button>`).join('');
    const linkHtml = links.map((L) =>
      `<a class="ig-link" href="${esc(L.href)}" target="_blank" rel="noopener noreferrer">${esc(L.label)} ↗</a>`).join('');
    return `<li class="ig-step">
      <div class="ig-step-num" aria-hidden="true">${i + 1}</div>
      <div class="ig-step-main">
        <div class="ig-step-title">${esc(s.title)}</div>
        <div class="ig-step-body">${s.body || ''}</div>
        ${scopes}
        ${(linkHtml || copies) ? `<div class="ig-step-actions">${linkHtml}${copies}</div>` : ''}
        ${s.note ? `<div class="ig-step-note">${s.note}</div>` : ''}
      </div>
    </li>`;
  }

  const ONBOARDING_PRINT_ORDER = [
    { key: 'shopify_dev_app', section: 'Shopify — store-owned app (recommended)' },
    { key: 'shopify_token', section: 'Shopify — legacy Admin API token' },
    { key: 'meta_ads', section: 'Meta Ads — system user token' },
    { key: 'redo', section: 'Redo — returns & marketing' },
  ];

  function stepHtmlPrint(s, i) {
    const links = stepLinks(s);
    const scopes = s.scopes && s.scopes.length
      ? `<div class="ig-scopes">${s.scopes.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : '';
    const linkLines = links.map((L) =>
      `<p class="ig-print-url"><span class="ig-print-url-label">${esc(L.label)}</span> `
      + `<a href="${esc(L.href)}">${esc(L.href)}</a></p>`).join('');
    const copies = (s.copy || []).filter((c) => c && c.value).map((c) =>
      `<p class="ig-print-copy"><span class="ig-print-copy-label">${esc(c.label)}</span> `
      + `<code class="ig-print-code">${esc(c.value)}</code></p>`).join('');
    return `<li class="ig-step ig-step--print">
      <div class="ig-step-num" aria-hidden="true">${i + 1}</div>
      <div class="ig-step-main">
        <div class="ig-step-title">${esc(s.title)}</div>
        <div class="ig-step-body">${s.body || ''}</div>
        ${scopes}
        ${linkLines}${copies}
        ${s.note ? `<div class="ig-step-note">${s.note}</div>` : ''}
      </div>
    </li>`;
  }

  function renderGuidePrint(key, ctx) {
    const g = resolve(key, ctx);
    if (!g) return '';
    let n = 0;
    const main = g.steps.map((s) => stepHtmlPrint(s, n++)).join('');
    const extra = g.extra
      ? `<section class="ig-print-extra">
          <h3 class="ig-print-extra-title">${esc(g.extra.title)}</h3>
          <ol class="ig-print-steps">${g.extra.steps.map((s) => stepHtmlPrint(s, n++)).join('')}</ol>
        </section>` : '';
    const trouble = g.troubleshooting && g.troubleshooting.length
      ? `<section class="ig-print-trouble">
          <h3 class="ig-section-label">If something goes wrong</h3>
          ${g.troubleshooting.map((t) => `<div class="ig-print-faq"><p class="ig-print-q">${esc(t.q)}</p><div class="ig-print-a">${t.a}</div></div>`).join('')}
        </section>` : '';
    return `<article class="ig-print-guide" id="guide-${esc(key)}">
      <header class="ig-print-guide-head">
        <p class="ig-kicker">Setup guide · ${esc(g.time)}</p>
        <h2 class="ig-print-guide-title">${esc(g.title)}</h2>
        <p class="ig-summary">${g.summary}</p>
      </header>
      ${g.needs && g.needs.length ? `<section class="ig-needs ig-needs--print">
        <div class="ig-section-label">Before you start</div>
        <ul>${g.needs.map((item) => `<li>${item}</li>`).join('')}</ul>
      </section>` : ''}
      <ol class="ig-print-steps">${main}</ol>
      ${extra}
      ${trouble}
      <p class="ig-fineprint">Button names on the other site can shift slightly as they update their dashboards.</p>
      <p class="ig-print-silo">In SILO: Workspace → Settings → <strong>Integrations</strong> (<code>/v2/integrations.html</code>).</p>
    </article>`;
  }

  function renderOnboardingDocument(ctx, opts) {
    const o = opts || {};
    const generated = o.generatedOn || new Date().toISOString().slice(0, 10);
    const sections = ONBOARDING_PRINT_ORDER.map(({ key, section }) => {
      const body = renderGuidePrint(key, ctx);
      if (!body) return '';
      return `<section class="ig-print-part">
        <h2 class="ig-print-part-title">${esc(section)}</h2>
        ${body}
      </section>`;
    }).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SILO — Integration setup guides</title>
  <style>${ONBOARDING_PRINT_CSS}</style>
</head>
<body>
  <header class="ig-print-cover">
    <p class="ig-print-brand">SILO</p>
    <h1>Integration setup guides</h1>
    <p class="ig-print-lead">Step-by-step instructions for connections that need work in Shopify, Meta, or Redo before credentials land in SILO. Same content as the setup drawers on the Integrations page.</p>
    <p class="ig-print-meta">Generated ${esc(generated)} · SILO Integrations: <a href="/v2/integrations.html">/v2/integrations.html</a></p>
    <section class="ig-print-toc">
      <h2 class="ig-section-label">Contents</h2>
      <ol>${ONBOARDING_PRINT_ORDER.map(({ key, section }) =>
        `<li><a href="#guide-${esc(key)}">${esc(section)}</a></li>`).join('')}</ol>
    </section>
    <p class="ig-print-oauth">One-click in SILO (no separate guide): Google Ads, GA4, TikTok Ads, QuickBooks Online, Shopify OAuth, and Stripe Connect.</p>
  </header>
  ${sections}
</body>
</html>`;
  }

  const ONBOARDING_PRINT_CSS = `
    @page { margin: 0.72in; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0 0 48px; font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #0f172a; }
    a { color: #2563eb; word-break: break-all; }
    code { font-family: ui-monospace, "IBM Plex Mono", monospace; font-size: 9.5pt; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0 4px; }
    .ig-print-cover { page-break-after: always; padding: 0 0 24px; border-bottom: 2px solid #0f172a; margin-bottom: 28px; }
    .ig-print-brand { margin: 0 0 8px; font-family: ui-monospace, monospace; font-size: 10pt; letter-spacing: .12em; font-weight: 700; }
    .ig-print-cover h1 { margin: 0 0 12px; font-size: 22pt; letter-spacing: -.02em; }
    .ig-print-lead { margin: 0 0 12px; color: #334155; max-width: 42em; }
    .ig-print-meta { margin: 0 0 18px; font-size: 9.5pt; color: #64748b; }
    .ig-print-oauth { margin: 16px 0 0; font-size: 10pt; color: #475569; }
    .ig-section-label { margin: 0 0 8px; font-family: ui-monospace, monospace; font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #64748b; }
    .ig-print-toc ol { margin: 0; padding-left: 20px; }
    .ig-print-part { page-break-before: always; }
    .ig-print-part-title { margin: 0 0 16px; font-size: 14pt; color: #1e293b; }
    .ig-print-guide-head { margin-bottom: 14px; }
    .ig-kicker { margin: 0 0 4px; font-family: ui-monospace, monospace; font-size: 9pt; letter-spacing: .06em; text-transform: uppercase; color: #64748b; }
    .ig-print-guide-title { margin: 0 0 8px; font-size: 16pt; }
    .ig-summary { margin: 0; color: #334155; }
    .ig-needs--print { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin: 14px 0; }
    .ig-needs--print ul { margin: 0; padding-left: 18px; }
    .ig-print-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .ig-step--print { display: flex; gap: 10px; break-inside: avoid; page-break-inside: avoid; }
    .ig-step-num { flex: 0 0 22px; height: 22px; border-radius: 50%; background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; font-family: ui-monospace, monospace; font-size: 10pt; font-weight: 600; display: flex; align-items: center; justify-content: center; }
    .ig-step-main { flex: 1; min-width: 0; }
    .ig-step-title { font-weight: 700; margin-bottom: 2px; }
    .ig-step-body { color: #334155; }
    .ig-step-body ul { margin: 4px 0 0; padding-left: 18px; }
    .ig-scopes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .ig-step-note { margin-top: 6px; font-size: 10pt; color: #64748b; }
    .ig-print-url { margin: 6px 0 0; font-size: 10pt; }
    .ig-print-url-label { font-weight: 600; display: block; color: #0f172a; }
    .ig-print-copy { margin: 6px 0 0; }
    .ig-print-copy-label { font-weight: 600; display: block; margin-bottom: 2px; }
    .ig-print-code { display: block; white-space: pre-wrap; word-break: break-all; padding: 6px 8px; margin-top: 2px; }
    .ig-print-extra { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; }
    .ig-print-extra-title { margin: 0 0 10px; font-size: 12pt; }
    .ig-print-trouble { margin-top: 18px; }
    .ig-print-faq { margin-top: 10px; break-inside: avoid; }
    .ig-print-q { margin: 0 0 4px; font-weight: 700; }
    .ig-print-a { margin: 0; color: #334155; }
    .ig-fineprint { margin: 16px 0 0; font-size: 9pt; color: #64748b; }
    .ig-print-silo { margin: 8px 0 0; font-size: 10pt; color: #475569; }
  `;

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

  const api = {
    GUIDES, SHOPIFY_SCOPES, SHOPIFY_OWN_APP_SCOPES,
    META_BUSINESS_SETTINGS, META_SYSTEM_USERS, META_PORTFOLIO_APPS, META_DEVELOPERS_APPS, META_SYSTEM_USER_HELP,
    META_ADS_SCOPES, META_ORGANIC_SCOPES, REDO_MARKETING_SCOPES,
    ONBOARDING_PRINT_ORDER,
    resolve, render, renderGuidePrint, renderOnboardingDocument, copyValues, open,
    keys: () => Object.keys(GUIDES),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SiloIntegrationGuides = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
