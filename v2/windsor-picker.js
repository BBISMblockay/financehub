// DOM-only controls. All labels are text, never vendor-provided HTML.
(function (root) {
  const sprite = { shopify: 'shopify', facebook: 'meta', google_ads: 'google-ads', tiktok: 'tiktok', quickbooks: 'quickbooks' };
  const brand = { youtube: '▶', tiktok: '♪', facebook: 'f', linkedin: 'in', google_ads: 'G',
    googleanalytics4: '▥', shopify: 'S', klaviyo: 'K' };
  // SILO's own integrations, by the id a source listing uses for the same
  // platform. These are the ones SILO's built-in reporting is built on, so the
  // picker offers them behind a disclosure rather than as a first choice: a
  // company that connects one here gets live queries but no built-in reports.
  // Shipping a new SILO integration means adding its id (and any alias the
  // listing may use) here, and nothing else. Ids absent from a listing are
  // simply never matched, so aliases are harmless.
  const NATIVE_INTEGRATIONS = {
    shopify: 'Shopify',
    facebook: 'Meta Ads', facebook_ads: 'Meta Ads', meta: 'Meta Ads',
    google_ads: 'Google Ads', adwords: 'Google Ads',
    googleanalytics4: 'Google Analytics 4', ga4: 'Google Analytics 4',
    google_search_console: 'Search Console', searchconsole: 'Search Console',
    tiktok: 'TikTok Ads', tiktok_ads: 'TikTok Ads',
    klaviyo: 'Klaviyo',
    quickbooks: 'QuickBooks', stripe: 'Stripe',
  };
  const nativeIntegration = (id) => NATIVE_INTEGRATIONS[String(id || '').toLowerCase()] || null;

  function integrationPicker({ search, list, status, onSelect, nativeGroup, nativeList, nativeCount }) {
    let items = []; let selected = null;
    const nativeTarget = nativeList || null;
    function render() {
      list.replaceChildren();
      nativeTarget?.replaceChildren();
      const term = search.value.trim().toLowerCase();
      const matches = items.filter((x) => `${x.name} ${x.id}`.toLowerCase().includes(term));
      // Without the extra containers every match renders in one list, exactly
      // as before: the grouping is presentation, never a filter.
      const native = nativeTarget ? matches.filter((x) => nativeIntegration(x.id)) : [];
      const offered = nativeTarget ? matches.filter((x) => !nativeIntegration(x.id)) : matches;
      if (nativeCount) nativeCount.textContent = String(native.length);
      if (nativeGroup) nativeGroup.hidden = !native.length;
      status.textContent = items.length ? `${offered.length} integrations${selected ? ` · Selected: ${selected.name}` : ''}` : 'No integrations loaded.';
      if (items.length && !matches.length) status.textContent = 'No integrations match your search. Try another name.';
      if (items.length && !offered.length && native.length) status.textContent = `${native.length} matching ${native.length === 1 ? 'integration is' : 'integrations are'} a SILO integration. Open the group below to connect one as a source anyway.`;
      for (const item of matches) {
        const target = nativeTarget && nativeIntegration(item.id) ? nativeTarget : list;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'bcn-btn bcn-btn--ghost';
        button.setAttribute('aria-pressed', String(selected?.id === item.id));
        let icon;
        if (sprite[item.id]) {
          icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('width', '24'); icon.setAttribute('height', '24');
          const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          use.setAttribute('href', `/assets/landing/integration-icons.svg#icon-${sprite[item.id]}`);
          icon.appendChild(use);
        } else {
          icon = document.createElement('span'); icon.className = 'bcn-pill';
          icon.textContent = brand[item.id] || item.name.slice(0, 2).toUpperCase();
          if (item.id === 'youtube') { icon.style.background = '#ff0000'; icon.style.color = '#ffffff'; }
        }
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon); button.appendChild(document.createTextNode(` ${item.name}`));
        button.addEventListener('click', () => { selected = item; onSelect(item); render();
          (nativeTarget?.querySelector('[aria-pressed="true"]') || list.querySelector('[aria-pressed="true"]'))?.focus(); });
        target.appendChild(button);
      }
    }
    search.addEventListener('input', render);
    return { setItems(next) { items = next; selected = null; onSelect(null); render(); } };
  }
  function fieldPicker({ search, list, status, report, onChange, max = 30 }) {
    let fields = []; let selected = new Set();
    function render() {
      list.replaceChildren();
      const term = search.value.trim().toLowerCase();
      const matches = fields.filter((f) => (!report?.value || !f.table || f.table === report.value) && `${f.name} ${f.id} ${f.table || ''}`.toLowerCase().includes(term));
      status.textContent = `${selected.size}/${max} fields selected · ${matches.length} matching fields. Account identity is required.`;
      const groups = new Set(fields.filter(f => selected.has(f.id) && f.table).map(f => f.table));
      if (groups.size > 1) status.textContent += ' Selection spans report groups; the source may reject this combination.';
      for (const f of matches) {
        const label = document.createElement('label'); label.className = 'wt-field-option';
        const input = document.createElement('input'); input.type = 'checkbox';
        input.value = f.id; input.checked = selected.has(f.id);
        input.disabled = f.id === 'account_id' || (!input.checked && selected.size >= max);
        input.addEventListener('change', () => {
          if (input.checked) selected.add(f.id); else selected.delete(f.id);
          onChange([...selected]); render();
          [...list.querySelectorAll('input')].find(el => el.value === f.id)?.focus();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${f.name}${f.table ? ` (${f.table})` : ''}`));
        label.title = `${f.id} · ${f.type}`;
        list.appendChild(label);
      }
    }
    search.addEventListener('input', render);
    report?.addEventListener('change', render);
    return {
      setFields(next, defaults) {
        fields = next; search.value = '';
        if (report) {
          report.replaceChildren();
          for (const name of ['', ...new Set(fields.map(f => f.table).filter(Boolean))]) {
            const option = document.createElement('option'); option.value = name; option.textContent = name || 'All report groups'; report.appendChild(option);
          }
        }
        selected = new Set(defaults.filter((id) => fields.some((f) => f.id === id)).slice(0, max));
        onChange([...selected]); render();
      },
      values() { return [...selected]; },
      label(id) { return fields.find((f) => f.id === id)?.name || id; },
    };
  }
  const SERVICE_UPDATE = 'Windsor needs a service update before connection setup and previews can be used. Ask a SILO administrator to finish the update, then try again. Existing connections do not need to be removed.';

  // Older brokers return numeric_fields only. That is a contract mismatch,
  // not evidence that the source lacks account identity. Never reconstruct
  // a preview from that response: the older preview also lacks the safety fix.
  function previewCatalogProblem(out) {
    if (!Array.isArray(out?.fields) || !Array.isArray(out?.default_fields)) return SERVICE_UPDATE;
    if (!out.fields.every((f) => f && typeof f.id === 'string')) return 'Windsor returned an unreadable field list. Preview is unavailable; try again.';
    const ids = new Set(out.fields.map((f) => f.id));
    if (!ids.has('account_id')) return 'Windsor did not list an account identity field for this source. Preview remains disabled.';
    if (!out.default_fields.includes('account_id') || out.default_fields.length > 30
        || !out.default_fields.every((id) => ids.has(id))) return 'Windsor could not prepare a valid field selection. Preview remains disabled; try again.';
    return null;
  }
  function discoveryError(action, status, out) {
    return action === 'connector_catalog' && status === 400 && out?.error === 'Unknown action' ? SERVICE_UPDATE : null;
  }
  root.WindsorPicker = { integrationPicker, fieldPicker, nativeIntegration, previewCatalogProblem, discoveryError, SERVICE_UPDATE };
})(window);
