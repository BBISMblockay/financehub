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
  root.WindsorPicker = { integrationPicker, fieldPicker };
})(window);
