// DOM-only controls. All labels are text, never vendor-provided HTML.
(function (root) {
  const sprite = { shopify: 'shopify', facebook: 'meta', google_ads: 'google-ads', tiktok: 'tiktok', quickbooks: 'quickbooks' };
  const brand = { youtube: '▶', tiktok: '♪', facebook: 'f', linkedin: 'in', google_ads: 'G',
    googleanalytics4: '▥', shopify: 'S', klaviyo: 'K' };
  function integrationPicker({ search, list, status, onSelect }) {
    let items = []; let selected = null;
    function render() {
      list.replaceChildren();
      const term = search.value.trim().toLowerCase();
      const matches = items.filter((x) => `${x.name} ${x.id}`.toLowerCase().includes(term));
      status.textContent = items.length ? `${matches.length} integrations${selected ? ` · Selected: ${selected.name}` : ''}` : 'No integrations loaded.';
      for (const item of matches) {
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
        button.addEventListener('click', () => { selected = item; onSelect(item); render(); });
        list.appendChild(button);
      }
    }
    search.addEventListener('input', render);
    return { setItems(next) { items = next; selected = null; onSelect(null); render(); } };
  }
  function fieldPicker({ search, list, status, onChange, max = 30 }) {
    let fields = []; let selected = new Set();
    function render() {
      list.replaceChildren();
      const term = search.value.trim().toLowerCase();
      const matches = fields.filter((f) => `${f.name} ${f.id} ${f.table || ''}`.toLowerCase().includes(term));
      status.textContent = `${selected.size}/${max} fields selected · ${matches.length} matching fields. Account identity is required.`;
      for (const f of matches) {
        const label = document.createElement('label'); label.className = 'wt-field-option';
        const input = document.createElement('input'); input.type = 'checkbox';
        input.value = f.id; input.checked = selected.has(f.id);
        input.disabled = f.id === 'account_id' || (!input.checked && selected.size >= max);
        input.addEventListener('change', () => {
          if (input.checked) selected.add(f.id); else selected.delete(f.id);
          onChange([...selected]); render();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${f.name}${f.table ? ` (${f.table})` : ''}`));
        label.title = `${f.id} · ${f.type}`;
        list.appendChild(label);
      }
    }
    search.addEventListener('input', render);
    return {
      setFields(next, defaults) {
        fields = next; search.value = '';
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
  root.WindsorPicker = { integrationPicker, fieldPicker, previewCatalogProblem, discoveryError, SERVICE_UPDATE };
})(window);
