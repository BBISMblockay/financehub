/* /v2/shopify-install.html -- attach a just-installed Shopify store to a SILO
 * workspace. The install callback (shopify-app-install) sends the browser here
 * with #claim=<token> or #error=<code>.
 *
 * The claim token is moved out of the address bar into this tab's
 * sessionStorage at once, so it survives the sign-in round trip (login.html
 * returns to ?next=) without ever being sent to a server in a URL.
 *
 * Pure helpers are exported on window.SiloShopifyInstall for
 * scripts/tests/shopify-install.test.mjs. */
(function () {
  'use strict';
  const STORE_KEY = 'silo:shopify:claim';
  const PAGE = '/v2/shopify-install.html';

  const ERROR_TEXT = {
    not_configured: 'SILO’s Shopify app is not switched on yet. Contact support@get-silo.com.',
    invalid_request: 'That link was incomplete. Open SILO again from your Shopify admin.',
    invalid_signature: 'Shopify’s signature on that link did not check out. Open SILO again from your Shopify admin.',
    stale_launch: 'That link had expired. Open SILO again from your Shopify admin.',
    invalid_or_expired_state: 'The install took too long. Open SILO again from your Shopify admin.',
    shop_mismatch: 'Shopify returned a different store than the one being installed. Open SILO again from your Shopify admin.',
    token_exchange_failed: 'Shopify did not complete the connection. Open SILO again from your Shopify admin.',
    save_failed: 'SILO could not save the install. Open SILO again from your Shopify admin.',
  };

  const PLAN_NOTE = {
    connect: 'Connects this store. Sync stays off until you turn it on in Integrations.',
    refresh: 'Already connected through this app — refreshes its access.',
    refuse: 'Already connected another way. Remove that connection in Integrations first.',
  };

  /** Read #claim= / #error= from a hash string. */
  function parseFragment(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const claim = p.get('claim');
    return {
      claim: claim && /^[A-Za-z0-9_-]{43}$/.test(claim) ? claim : null,
      error: p.get('error') || null,
    };
  }

  function errorText(code) { return ERROR_TEXT[code] || ERROR_TEXT.invalid_request; }

  function loginUrl() { return '/pages/login.html?next=' + encodeURIComponent(PAGE); }

  window.SiloShopifyInstall = { parseFragment, errorText, loginUrl, PLAN_NOTE, STORE_KEY };
  if (typeof document === 'undefined' || !document.getElementById('siSub')) return;

  const $ = (id) => document.getElementById(id);
  function setStatus(msg, type = 'info') {
    const el = $('status');
    el.className = `bcn-status bcn-status--${type}`;
    el.textContent = msg;
    el.hidden = false;
  }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const storage = {
    get() { try { return sessionStorage.getItem(STORE_KEY); } catch (_) { return null; } },
    set(v) { try { sessionStorage.setItem(STORE_KEY, v); } catch (_) { /* private mode */ } },
    clear() { try { sessionStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ } },
  };

  (async function main() {
    const frag = parseFragment(location.hash);
    if (location.hash) history.replaceState(null, '', PAGE);
    if (frag.error) {
      storage.clear();
      $('siSub').textContent = errorText(frag.error);
      return;
    }
    if (frag.claim) storage.set(frag.claim);
    const claim = frag.claim || storage.get();
    if (!claim) {
      $('siSub').textContent = 'Nothing to connect. Install or open SILO from your Shopify admin to connect a store.';
      return;
    }

    const cfg = window.__SILO_CONFIG__ || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
      setStatus('Missing Supabase config', 'neg');
      return;
    }
    const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data: sess } = await db.auth.getSession();
    if (!sess?.session) { location.href = loginUrl(); return; }

    const call = async (body) => {
      const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/shopify-install-claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${sess.session.access_token}`,
        },
        body: JSON.stringify({ claim, ...body }),
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* empty */ }
      return { status: res.status, data };
    };

    const peek = await call({ action: 'peek' });
    if (peek.status === 410) {
      storage.clear();
      $('siSub').textContent = 'This install link has expired or was already used. Open SILO again from your Shopify admin.';
      return;
    }
    if (peek.status !== 200) { setStatus(peek.data.error || 'Could not read the install.', 'neg'); return; }

    const { shop_domain: shop, shop_name: shopName, workspaces = [] } = peek.data;
    $('siTitle').textContent = `Connect ${shopName || shop}`;
    $('siSub').innerHTML = `<span class="si-store">${esc(shop)}</span> &mdash; choose the SILO workspace this store belongs to.`;
    if (!workspaces.length) {
      $('siSub').innerHTML = `<span class="si-store">${esc(shop)}</span> is installed, but you are not an admin of a SILO workspace. `
        + 'Ask your SILO admin to sign in and open SILO from Shopify, or contact '
        + '<a href="mailto:support@get-silo.com">support@get-silo.com</a>.';
      return;
    }

    const list = $('siList');
    list.innerHTML = workspaces.map((w, i) => `
      <label class="si-option" ${w.plan === 'refuse' ? 'aria-disabled="true"' : ''}>
        <input type="radio" name="siWorkspace" value="${esc(w.company_entity_id)}" ${w.plan === 'refuse' ? 'disabled' : ''}
          ${w.plan !== 'refuse' && workspaces.filter((x) => x.plan !== 'refuse').length === 1 ? 'checked' : ''} data-i="${i}" />
        <span><span class="si-option-name">${esc(w.title)}</span>
          <span class="si-option-note" style="display:block">${esc(PLAN_NOTE[w.plan] || '')}</span></span>
      </label>`).join('');
    list.hidden = false;
    $('siActions').hidden = false;
    const btn = $('siConnect');
    const chosen = () => list.querySelector('input[name="siWorkspace"]:checked');
    btn.disabled = !chosen();
    list.addEventListener('change', () => { btn.disabled = !chosen(); });

    btn.addEventListener('click', async () => {
      const pick = chosen();
      if (!pick) return;
      btn.disabled = true;
      setStatus('Connecting…');
      const out = await call({ action: 'claim', company_entity_id: pick.value });
      if (out.status === 200) {
        storage.clear();
        // Open the workspace the store now belongs to; the RPC re-checks membership.
        await db.rpc('set_active_company', { p_entity_id: pick.value });
        try { localStorage.setItem('silo:company:switched', String(Date.now())); } catch (_) { /* ignore */ }
        const verb = out.data.outcome === 'refreshed' ? 'reconnected' : 'connected';
        list.hidden = true; $('siActions').hidden = true;
        $('siSub').innerHTML = `<span class="si-store">${esc(shop)}</span> is ${verb}. `
          + '<a href="/v2/integrations.html">Open Integrations</a> to turn on sync.';
        setStatus(`✓ Store ${verb}.`, 'pos');
        return;
      }
      if (out.status === 410) {
        storage.clear();
        setStatus('This install link has expired or was already used. Open SILO again from your Shopify admin.', 'neg');
        return;
      }
      if (out.status === 409) {
        setStatus('That workspace already connects this store another way. Remove that connection in Integrations first, or choose another workspace.', 'neg');
        btn.disabled = false;
        return;
      }
      setStatus(out.data.error || 'Could not connect the store.', 'neg');
      btn.disabled = false;
    });
  })().catch((e) => setStatus('Something went wrong: ' + e.message, 'neg'));
})();
